// SPDX-License-Identifier: Apache-2.0
// Updating this copy of sessionpipe from npm: what the latest release is, whether this
// copy is one npm can update in place, and the install itself. `sessionpipe update`
// runs it by hand; the control daemon runs it once a day (control/autoupdate.ts).
//
// Only a global npm install updates itself. A copy in the npx cache, a git checkout or
// a dev build is somebody's deliberate choice of code, and npm installing over it
// would be wrong or impossible: for those `globalPrefix` is null and nothing happens.
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { viaNpx } from "./runtime.js";

export const REGISTRY_LATEST = "https://registry.npmjs.org/sessionpipe/latest";

// How versions order lives in core, beside the restart they lead to.
import { parseVersion } from "@sessionpipe/core/version";

export { compareVersions, isNewer } from "@sessionpipe/core/version";

/** The registry's `latest` for sessionpipe: one GET, nothing sent but the request. */
export async function latestVersion(f: typeof fetch = fetch, timeoutMs = 8000): Promise<string> {
  const r = await f(REGISTRY_LATEST, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/json" },
  });
  if (!r.ok) throw new Error(`the npm registry answered HTTP ${r.status}`);
  const j = (await r.json()) as { version?: unknown };
  if (typeof j.version !== "string" || !parseVersion(j.version)) throw new Error("the npm registry named no version");
  return j.version;
}

/** The prefix a global npm install of sessionpipe lives under, from the running copy's
 *  dist folder (`<prefix>/lib/node_modules/sessionpipe/dist`, on Windows
 *  `<prefix>\node_modules\sessionpipe\dist`). */
export function prefixOf(distDir: string, platform: NodeJS.Platform = process.platform): string | null {
  const re =
    platform === "win32" ? /^(.*?)[\\/]node_modules[\\/]sessionpipe[\\/]/ : /^(.*)\/lib\/node_modules\/sessionpipe\//;
  return re.exec(`${distDir}/`)?.[1] ?? null;
}

/** The npm prefix this copy was installed into with `npm install -g`, or null when it
 *  isn't a global npm install (the npx cache, a git checkout, a project's
 *  node_modules, a dev build). A global install always has its bin link in the prefix. */
export function globalPrefix(distDir: string, platform: NodeJS.Platform = process.platform): string | null {
  if (viaNpx(distDir)) return null;
  const prefix = prefixOf(distDir, platform);
  if (!prefix) return null;
  const bin = platform === "win32" ? path.join(prefix, "sessionpipe.cmd") : path.join(prefix, "bin", "sessionpipe");
  return existsSync(bin) ? prefix : null;
}

/** Why npm can't write this prefix (installed with sudo, a read-only image), or null. */
export function unwritable(prefix: string, platform: NodeJS.Platform = process.platform): string | null {
  const dir = platform === "win32" ? path.join(prefix, "node_modules") : path.join(prefix, "lib", "node_modules");
  try {
    accessSync(dir, constants.W_OK);
    return null;
  } catch {
    return `${dir} isn't writable by this user (installed with sudo?)`;
  }
}

/** npm, run by this very node: under launchd PATH is /usr/bin:/bin, so neither `npm`
 *  nor the `node` its shebang asks for is on it. Its npm-cli.js sits beside the node
 *  binary (nvm, Homebrew, the official builds, the node Docker images). */
export function npmArgv(node: string, platform: NodeJS.Platform = process.platform): string[] {
  const dir = path.dirname(node);
  const candidates =
    platform === "win32"
      ? [path.join(dir, "node_modules", "npm", "bin", "npm-cli.js")]
      : [path.join(dir, "npm"), path.join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")];
  for (const c of candidates) {
    try {
      const real = realpathSync(c);
      if (real.endsWith(".js")) return [node, real];
    } catch {}
  }
  return [platform === "win32" ? "npm.cmd" : "npm"];
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}
export type Exec = (argv: string[], o: { env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<ExecResult>;

/** Run a command to the end, keeping the tail of its output. */
export const execCapture: Exec = (argv, o) =>
  new Promise((resolve) => {
    const [cmd, ...rest] = argv as [string, ...string[]];
    let stdout = "";
    let stderr = "";
    const keep = (s: string, b: Buffer) => (s + b.toString("utf8")).slice(-16_000);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, rest, {
        env: o.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: process.platform === "win32" && cmd.endsWith(".cmd"),
      });
    } catch (e) {
      resolve({ code: null, stdout, stderr, error: (e as Error).message });
      return;
    }
    const t = setTimeout(() => child.kill("SIGTERM"), o.timeoutMs);
    child.stdout?.on("data", (b: Buffer) => {
      stdout = keep(stdout, b);
    });
    child.stderr?.on("data", (b: Buffer) => {
      stderr = keep(stderr, b);
    });
    child.on("error", (e) => {
      clearTimeout(t);
      resolve({ code: null, stdout, stderr, error: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(t);
      resolve({ code, stdout, stderr });
    });
  });

export interface InstallOptions {
  /** The node running this copy (process.execPath). */
  node: string;
  /** The running copy's dist folder: where the new one lands, under the same prefix. */
  distDir: string;
  /** Harnesses whose hooks to re-arm afterwards (config.harnesses that are enabled). */
  harnesses: string[];
  env?: NodeJS.ProcessEnv;
  exec?: Exec;
  platform?: NodeJS.Platform;
}

export type InstallResult =
  | { ok: true; ms: number; hooks: string }
  | { ok: false; ms: number; error: string; stage: "prefix" | "npm" | "verify" };

const lastLine = (r: ExecResult): string =>
  (r.error || r.stderr.trim().split("\n").filter(Boolean).slice(-2).join(" ") || `exit ${r.code}`).slice(0, 300);

/** The version of the copy on disk (which may not be the one running). */
export async function installedVersion(o: {
  node: string;
  distDir: string;
  env?: NodeJS.ProcessEnv;
  exec?: Exec;
}): Promise<string | null> {
  const r = await (o.exec ?? execCapture)([o.node, path.join(o.distDir, "cli.js"), "--version"], {
    env: o.env ?? process.env,
    timeoutMs: 30_000,
  });
  const v = r.stdout.trim();
  return r.code === 0 && parseVersion(v) ? v : null;
}

/** `npm install -g sessionpipe@<version>` into the prefix the running copy came from,
 *  check the copy on disk says that version, then re-copy the hook launcher's files
 *  (the hooks run copies in ~/.local/share/sessionpipe, which npm never touches) for
 *  the harnesses already set up here. Lifecycle scripts are off: sessionpipe has none,
 *  and an unattended install runs nothing it fetched. */
export async function installVersion(version: string, o: InstallOptions): Promise<InstallResult> {
  const t0 = Date.now();
  const platform = o.platform ?? process.platform;
  const exec = o.exec ?? execCapture;
  const base = o.env ?? process.env;
  // npm and anything it starts find this node first.
  const env = { ...base, PATH: [path.dirname(o.node), base.PATH].filter(Boolean).join(path.delimiter) };
  const prefix = globalPrefix(o.distDir, platform);
  if (!prefix)
    return { ok: false, ms: Date.now() - t0, stage: "prefix", error: "this copy isn't a global npm install" };
  const npm = npmArgv(o.node, platform);
  const r = await exec(
    [
      ...npm,
      "install",
      "--global",
      "--prefix",
      prefix,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      `sessionpipe@${version}`,
    ],
    { env, timeoutMs: 5 * 60_000 },
  );
  if (r.code !== 0) return { ok: false, ms: Date.now() - t0, stage: "npm", error: `npm install: ${lastLine(r)}` };
  const now = await installedVersion({ node: o.node, distDir: o.distDir, env, exec });
  if (now !== version)
    return {
      ok: false,
      ms: Date.now() - t0,
      stage: "verify",
      error: `npm finished, but the copy in ${prefix} says ${now ?? "nothing"}, not ${version}`,
    };
  let hooks = "no harness set up here; nothing to re-arm";
  if (o.harnesses.length) {
    const h = await exec(
      [o.node, path.join(o.distDir, "cli.js"), "install", "--backfill", "0", ...o.harnesses.map((n) => `--${n}`)],
      { env, timeoutMs: 2 * 60_000 },
    );
    hooks =
      h.code === 0
        ? `hooks re-armed for ${o.harnesses.join(", ")}`
        : `re-arming the hooks failed (${lastLine(h)}); \`sessionpipe install\` does it`;
  }
  return { ok: true, ms: Date.now() - t0, hooks };
}
