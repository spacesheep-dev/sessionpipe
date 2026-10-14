// SPDX-License-Identifier: Apache-2.0
// Persistent paths shared by hook installation and control pairing.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { launcherState } from "./launcher.js";
import { VERSION } from "./run.js";
import { isNewer } from "./update.js";

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

/** Homebrew's default prefix disappears on a node upgrade; use the persistent one. */
function installLocation(): { prefix: string; target: string } {
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

/** Refuse before npm, config or hook writes, including hooks left by another prefix. */
export function assertSetupVersion(allowDowngrade: boolean, target?: string): void {
  if (allowDowngrade) return;
  const check = (installed: string | null, where: string): void => {
    if (installed && isNewer(installed, VERSION, true))
      throw new Error(
        `refusing to downgrade sessionpipe: ${installed} is installed at ${where}; this command would install ${VERSION}. Use the installed newer CLI, or pass --allow-downgrade to force ${VERSION}.`,
      );
  };
  const hooks = launcherState(VERSION);
  check(hooks.version, hooks.file);
  const prefix = target ?? installLocation().target;
  if (!prefix) return;
  const pkg = path.join(
    prefix,
    ...(process.platform === "win32" ? [] : ["lib"]),
    "node_modules",
    "sessionpipe",
    "package.json",
  );
  let installed: unknown;
  try {
    installed = (JSON.parse(readFileSync(pkg, "utf8")) as { version?: unknown }).version;
  } catch {}
  if (typeof installed === "string") check(installed, pkg);
}

/** Install the running version persistently and hand off the original command before side effects. */
export function rerunGlobally(argv: string[], out: (s: string) => void, setup?: { allowDowngrade: boolean }): void {
  const { prefix, target } = installLocation();
  if (setup) assertSetupVersion(setup.allowDowngrade, target);
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
