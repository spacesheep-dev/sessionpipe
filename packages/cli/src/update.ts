// SPDX-License-Identifier: Apache-2.0
// Updating this copy of sessionpipe from npm: what the latest release is, whether this
// copy is one npm can update in place, and the install itself. `sessionpipe update`
// runs it by hand; the control daemon runs it once a day (control/autoupdate.ts).
//
// Only a global npm install updates itself. A copy in the npx cache, a git checkout or
// a dev build is somebody's deliberate choice of code, and npm installing over it
// would be wrong or impossible: for those `globalPrefix` is null and nothing happens.
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { viaNpx } from "./runtime.js";

export const REGISTRY_LATEST = "https://registry.npmjs.org/sessionpipe/latest";

// How versions order lives in core, beside the restart they lead to.
import { isNewer, parseVersion } from "@sessionpipe/core/version";

export { compareVersions, isNewer } from "@sessionpipe/core/version";

/** Where `latest` is read: the registry npm itself is told to use (`npm_config_registry`,
 *  a company's mirror), since that is where the install will come from; else npm's own. */
export function registryLatest(env: NodeJS.ProcessEnv = process.env): string {
  const own = env.npm_config_registry || env.NPM_CONFIG_REGISTRY;
  return own && /^https?:\/\//.test(own) ? `${own.replace(/\/+$/, "")}/sessionpipe/latest` : REGISTRY_LATEST;
}

/** The registry's `latest` for sessionpipe: one GET, nothing sent but the request. */
export async function latestVersion(
  f: typeof fetch = fetch,
  timeoutMs = 8000,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const r = await f(registryLatest(env), {
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

/** The dist folder of the `sessionpipe` a shell with this PATH would run, when that is a
 *  global npm install: what a person types, as far as a process that isn't their shell
 *  can tell. Null when PATH has none, or the first one is no global install of
 *  sessionpipe: npm writes into whatever prefix it is given, so a script that only has
 *  the name (a wrapper called `sessionpipe.cmd`, a link in a project's `.bin`) must never
 *  make its folder one. An install has its `dist/cli.js` and a package.json that says
 *  it is sessionpipe. */
export function copyOnPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const bin = platform === "win32" ? "sessionpipe.cmd" : "sessionpipe";
  for (const dir of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const file = path.join(dir, bin);
    // npm's bin is a link to dist/cli.js; on Windows it is a shim in the prefix itself.
    let dist: string;
    if (platform === "win32") {
      if (!existsSync(file)) continue;
      dist = path.join(dir, "node_modules", "sessionpipe", "dist");
    } else
      try {
        dist = path.dirname(realpathSync(file));
      } catch {
        // Not in this folder, or a link to nowhere: a shell would look further too.
        continue;
      }
    return globalPrefix(dist, platform) && existsSync(path.join(dist, "cli.js")) && versionAt(dist) ? dist : null;
  }
  return null;
}

/** The version of the copy in a dist folder, from its package.json; null when that can't
 *  be read as sessionpipe's own (none there, another package's, no version in it). */
export function versionAt(distDir: string): string | null {
  try {
    const j = JSON.parse(readFileSync(path.join(distDir, "..", "package.json"), "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    return j.name === "sessionpipe" && typeof j.version === "string" && parseVersion(j.version) ? j.version : null;
  } catch {
    return null;
  }
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
  | {
      ok: true;
      ms: number;
      hooks: string;
      rearmed: boolean;
      /** Other copies brought to the same version, and those that couldn't be. */
      along?: string[];
      others?: { dir: string; error: string }[];
    }
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

/** `npm install -g sessionpipe@<version>` into the prefix the copy in `distDir` came
 *  from, then check the copy on disk says that version. Lifecycle scripts are off:
 *  sessionpipe has none, and an unattended install runs nothing it fetched. */
async function npmInstall(
  version: string,
  o: InstallOptions,
): Promise<{ ok: true } | { ok: false; error: string; stage: "prefix" | "npm" | "verify" }> {
  const platform = o.platform ?? process.platform;
  const exec = o.exec ?? execCapture;
  const env = withNode(o);
  const prefix = globalPrefix(o.distDir, platform);
  if (!prefix) return { ok: false, stage: "prefix", error: "this copy isn't a global npm install" };
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
  if (r.code !== 0) return { ok: false, stage: "npm", error: `npm install: ${lastLine(r)}` };
  const now = await installedVersion({ node: o.node, distDir: o.distDir, env, exec });
  if (now !== version)
    return {
      ok: false,
      stage: "verify",
      error: `npm finished, but the copy in ${prefix} says ${now ?? "nothing"}, not ${version}`,
    };
  return { ok: true };
}

/** Install `version` into the running copy's prefix, check it, then write the hooks
 *  again from it (the hooks run copies in ~/.local/share/sessionpipe, which npm never
 *  touches) for the harnesses already set up here. */
export const installVersion = (version: string, o: InstallOptions): Promise<InstallResult> =>
  installEverywhere(version, { ...o, others: [] });

/** The same, for every copy of sessionpipe that matters on this computer: the running
 *  one first, then each of `others` (the dist folder of another global install: the copy
 *  a person types when the background service runs a different one, or the service's
 *  when it can't be moved onto this one yet) that is older than `version`. This is the
 *  one way a copy is updated, for `sessionpipe update` and for the service's own daily
 *  update. The running copy failing fails it; another copy failing is said (`others`)
 *  and the rest goes on, so a copy this user can't write never holds the others back. */
export async function installEverywhere(
  version: string,
  o: InstallOptions & { others: readonly string[] },
): Promise<InstallResult> {
  const t0 = Date.now();
  const own = await npmInstall(version, o);
  if (!own.ok) return { ...own, ms: Date.now() - t0 };
  const failed: { dir: string; error: string }[] = [];
  const along: string[] = [];
  for (const dir of new Set(o.others)) {
    if (samePath(dir, o.distDir)) continue;
    // npm installs into whatever prefix it is given: only a folder that says it holds
    // sessionpipe is one, and only an older copy is written to.
    const has = versionAt(dir);
    if (!has) {
      failed.push({ dir, error: "no package.json there says it is sessionpipe, so npm was not run on it" });
      continue;
    }
    if (!isNewer(version, has, true)) continue;
    const r = await npmInstall(version, { ...o, distDir: dir });
    if (r.ok) along.push(dir);
    else failed.push({ dir, error: r.error });
  }
  const hooks = await rearmHooks(o);
  return {
    ok: true,
    ms: Date.now() - t0,
    hooks: hooks.said,
    rearmed: hooks.ok,
    ...(along.length ? { along } : {}),
    ...(failed.length ? { others: failed } : {}),
  };
}

/** Two paths to one place. */
export function samePath(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(a) === real(b);
}

/** The environment for npm and anything it starts: this node is found first. */
function withNode(o: Pick<InstallOptions, "node" | "env">): NodeJS.ProcessEnv {
  const base = o.env ?? process.env;
  return { ...base, PATH: [path.dirname(o.node), base.PATH].filter(Boolean).join(path.delimiter) };
}

/** Write the hooks again from the copy on disk in `distDir` (its own `install`, so the
 *  newest code writes them), for the harnesses already set up here: the hooks run copies
 *  in ~/.local/share/sessionpipe, which npm never touches. */
export async function rearmHooks(o: InstallOptions): Promise<{ ok: boolean; said: string }> {
  if (!o.harnesses.length) return { ok: true, said: "no harness set up here; nothing to re-arm" };
  const h = await (o.exec ?? execCapture)(
    [o.node, path.join(o.distDir, "cli.js"), "install", "--backfill", "0", ...o.harnesses.map((n) => `--${n}`)],
    { env: withNode(o), timeoutMs: 2 * 60_000 },
  );
  return h.code === 0
    ? { ok: true, said: `hooks re-armed for ${o.harnesses.join(", ")}` }
    : { ok: false, said: `re-arming the hooks failed (${lastLine(h)}); \`sessionpipe install\` does it` };
}
