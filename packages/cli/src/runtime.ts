// SPDX-License-Identifier: Apache-2.0
// Persistent paths shared by hook installation and control pairing.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { launcherState } from "./launcher.js";
import { VERSION } from "./run.js";
import { compareVersions } from "./update.js";

/** Homebrew's versioned Cellar path dies on `brew upgrade node`; its stable links survive. */
export function stableNode(exe: string): string {
  const m = /^(.*)\/Cellar\/(node(?:@\d+)?)\/[^/]+\/bin\/node$/.exec(exe);
  if (!m) return exe;
  let real: string;
  try {
    real = realpathSync(exe);
  } catch {
    return exe;
  }
  for (const c of [`${m[1]}/opt/${m[2]}/bin/node`, `${m[1]}/bin/node`]) {
    try {
      if (realpathSync(c) === real) return c;
    } catch {}
  }
  return exe;
}

export function viaNpx(distDir: string): boolean {
  return /[\\/]_npx[\\/]/.test(distDir) || /[\\/]\.npm[\\/]/.test(distDir);
}

/** Homebrew's versioned prefix disappears on a Node upgrade (issue #13). */
function installTarget(): { prefix: string; target: string } {
  let prefix = "";
  try {
    prefix = execFileSync("npm", ["prefix", "-g"], {
      encoding: "utf8",
      timeout: 15000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {}
  return {
    prefix,
    target: /\/Cellar\/node(?:@\d+)?\/[^/]+/.test(prefix) ? path.join(os.homedir(), ".local") : prefix,
  };
}

/** Refuse before npm or hook copies can replace a newer install. Use the same
 *  ordering as auto-update's isNewer, but include prereleases here: a newer
 *  development build must also survive an older release's setup command. */
export function checkInstallVersion(
  version: string,
  o: { target?: string; allowDowngrade?: boolean; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): void {
  if (o.allowDowngrade) return;
  const target = o.target ?? installTarget().target;
  const platform = o.platform ?? process.platform;
  const copies: { version: string; location: string }[] = [];
  if (target) {
    const pkg = path.join(
      target,
      ...(platform === "win32" ? [] : ["lib"]),
      "node_modules",
      "sessionpipe",
      "package.json",
    );
    try {
      const installed = JSON.parse(readFileSync(pkg, "utf8")) as { version?: string };
      if (installed.version) copies.push({ version: installed.version, location: pkg });
    } catch {}
  }
  const launcher = launcherState(version, o.env);
  if (launcher.version) copies.push({ version: launcher.version, location: launcher.file });
  for (const installed of copies)
    if ((compareVersions(installed.version, version) ?? 0) > 0)
      throw new Error(
        `refusing to downgrade: found sessionpipe ${installed.version} at ${installed.location}; this command would install ${version}. Run the installed version, or pass --allow-downgrade to replace it explicitly.`,
      );
}

/** Install the running version persistently and hand off the original command before side effects. */
export function rerunGlobally(argv: string[], out: (s: string) => void): void {
  const { prefix, target } = installTarget();
  if (argv[0] === "install" || argv[0] === "connect")
    checkInstallVersion(VERSION, { target, allowDowngrade: argv.includes("--allow-downgrade") });
  out(`  Installing sessionpipe@${VERSION} globally, so hooks and services use a persistent copy…`);
  let bin: string;
  try {
    execFileSync("npm", ["install", "-g", `sessionpipe@${VERSION}`, ...(target ? ["--prefix", target] : [])], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    bin =
      process.platform === "win32"
        ? path.join(target, "sessionpipe.cmd")
        : target
          ? path.join(target, "bin", "sessionpipe")
          : "sessionpipe";
    if (target && target !== prefix)
      out(`  Installed into ${target}; make sure ${path.join(target, "bin")} is on your PATH.`);
  } catch {
    out(
      "  ! couldn't install globally (`npm install -g sessionpipe` failed). Run it yourself, then retry this command.",
    );
    process.exit(1);
  }
  // The command's own failure (a pairing that expired) is its own to report, not an
  // install that failed: it has said why; pass its exit status on.
  try {
    execFileSync(bin, argv, { stdio: "inherit", shell: process.platform === "win32" });
  } catch (e) {
    process.exit(typeof (e as { status?: unknown }).status === "number" ? (e as { status: number }).status : 1);
  }
}
