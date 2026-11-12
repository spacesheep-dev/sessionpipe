// SPDX-License-Identifier: Apache-2.0
// The hook's own home, outside every npm prefix: a copy of hook.js and worker.js and a
// small sh launcher, which is what the harnesses run. A hook entry that named node and
// hook.js by their install paths died with them — `nvm uninstall`, a Volta or asdf
// switch, a moved npm prefix — and the harness said nothing; the machine just stopped
// reporting. The launcher runs the node sessionpipe was installed with and, once that
// one is gone, any node on PATH. Windows keeps the direct entry (it has no sh).
//   ~/.local/share/sessionpipe/    SESSIONPIPE_DATA, else $XDG_DATA_HOME/sessionpipe
import { accessSync, chmodSync, constants, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AG_STALE_PRETOOL } from "@sessionpipe/core";

export const LAUNCHER = "sessionpipe-hook";
const COPIED = ["worker.js", "hook.js"] as const;

export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SESSIONPIPE_DATA) return path.resolve(env.SESSIONPIPE_DATA);
  return path.join(env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "sessionpipe");
}
export const launcherPath = (env: NodeJS.ProcessEnv = process.env): string => path.join(dataDir(env), LAUNCHER);
export const usesLauncher = (platform: NodeJS.Platform = process.platform): boolean => platform !== "win32";

const sq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** The launcher, in sh. No node at all prints what Antigravity needs and exits 0: the
 *  hook must stay invisible to the harness whatever is missing (and a PreToolUse entry
 *  an older install left must not turn into a silent deny). */
export function launcherScript(node: string, hook: string, version: string): string {
  return `#!/bin/sh
# sessionpipe ${version} hook launcher, written by \`sessionpipe install\`. Harnesses run
# this; it runs hook.js beside it with the node sessionpipe was installed with, or with
# any node on PATH once that one is gone (an nvm uninstall, a Homebrew upgrade).
n=${sq(node)}
[ -x "$n" ] || n=$(command -v node) || { [ "$1" = antigravity ] && if [ "$2" = PreToolUse ]; then echo ${sq(AG_STALE_PRETOOL.trim())}; else echo '{}'; fi; exit 0; }
exec "$n" ${sq(hook)} "$@"
`;
}

function writeIfChanged(file: string, body: Buffer | string, mode: number): boolean {
  try {
    const cur = readFileSync(file);
    if (cur.equals(Buffer.isBuffer(body) ? body : Buffer.from(body))) {
      chmodSync(file, mode);
      return false;
    }
  } catch {}
  // A hook may start while this runs: write beside it and rename, never half a file.
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, body, { mode });
  renameSync(tmp, file);
  chmodSync(file, mode);
  return true;
}

/** Copy the hook and worker out of the npm install and (re)write the launcher. The
 *  worker goes first, so a hook that starts mid-copy never spawns a missing one. */
export function installLauncher(o: { distDir: string; node: string; version: string; env?: NodeJS.ProcessEnv }): {
  launcher: string;
  changed: boolean;
} {
  const dir = dataDir(o.env);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  let changed = false;
  for (const f of COPIED)
    changed = writeIfChanged(path.join(dir, f), readFileSync(path.join(o.distDir, f)), 0o644) || changed;
  const launcher = path.join(dir, LAUNCHER);
  changed = writeIfChanged(launcher, launcherScript(o.node, path.join(dir, "hook.js"), o.version), 0o755) || changed;
  return { launcher, changed };
}

export function removeLauncher(env: NodeJS.ProcessEnv = process.env): void {
  for (const f of [LAUNCHER, ...COPIED]) rmSync(path.join(dataDir(env), f), { force: true });
}

export interface LauncherState {
  file: string;
  present: boolean;
  /** The node the launcher names, and whether it can still run. */
  node: string | null;
  nodeOk: boolean;
  version: string | null;
  problems: string[];
}

/** What `doctor` says about the launcher. */
export function launcherState(version: string, env: NodeJS.ProcessEnv = process.env): LauncherState {
  const file = launcherPath(env);
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return {
      file,
      present: false,
      node: null,
      nodeOk: false,
      version: null,
      problems: ["the hook launcher is missing; run `sessionpipe install` again"],
    };
  }
  const node = /^n='((?:[^']|'\\'')*)'$/m.exec(text)?.[1]?.replace(/'\\''/g, "'") ?? null;
  const v = /^# sessionpipe (\S+) hook launcher/m.exec(text)?.[1] ?? null;
  let nodeOk = false;
  try {
    if (node) {
      accessSync(node, constants.X_OK);
      nodeOk = true;
    }
  } catch {}
  const problems: string[] = [];
  if (!nodeOk)
    problems.push(
      `the node the hook launcher names (${node ?? "?"}) is gone; it falls back to the node on PATH. \`sessionpipe install\` points it at this one.`,
    );
  for (const f of COPIED)
    try {
      accessSync(path.join(path.dirname(file), f), constants.R_OK);
    } catch {
      problems.push(`${f} is missing beside the hook launcher; run \`sessionpipe install\` again`);
    }
  if (v && v !== version)
    problems.push(
      `the hooks run sessionpipe ${v}, this is ${version}; run \`sessionpipe update\` to bring both up to date`,
    );
  return { file, present: true, node, nodeOk, version: v, problems };
}
