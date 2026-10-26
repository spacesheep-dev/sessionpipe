// SPDX-License-Identifier: Apache-2.0
// Where sessionpipe keeps its files (spec: the client's Files section).
//   config  ~/.config/sessionpipe/config.json        SESSIONPIPE_CONFIG
//   state   ~/.local/state/sessionpipe/               SESSIONPIPE_STATE
//   Windows %APPDATA%\sessionpipe\ and %LOCALAPPDATA%\sessionpipe\
import os from "node:os";
import path from "node:path";

/** The home directory, read when asked: a test that sets HOME after importing core
 *  (or a process whose HOME changes) gets the new one, never one cached at load. */
export const homeDir = (): string => os.homedir();

export function configFile(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SESSIONPIPE_CONFIG) return path.resolve(env.SESSIONPIPE_CONFIG);
  if (process.platform === "win32")
    return path.join(env.APPDATA || path.join(homeDir(), "AppData", "Roaming"), "sessionpipe", "config.json");
  return path.join(env.XDG_CONFIG_HOME || path.join(homeDir(), ".config"), "sessionpipe", "config.json");
}

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SESSIONPIPE_STATE) return path.resolve(env.SESSIONPIPE_STATE);
  if (process.platform === "win32")
    return path.join(env.LOCALAPPDATA || path.join(homeDir(), "AppData", "Local"), "sessionpipe");
  return path.join(env.XDG_STATE_HOME || path.join(homeDir(), ".local", "state"), "sessionpipe");
}

/** `~` for the home directory, as the session block writes paths. */
export function tilde(p: string, home: string = homeDir()): string {
  if (!p) return p;
  if (p === home) return "~";
  return p.startsWith(home + path.sep) || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

/** The other way: `~`, `~/…` (or `~\…`) under the home directory, as a control `start`'s
 *  `cwd` may name a folder an event reported (CONTROL.md §3.1). Anything else, `~user`
 *  included, is returned as it is. */
export function untilde(p: string, home: string = homeDir()): string {
  if (p === "~") return home;
  return /^~[\\/]/.test(p) ? path.join(home, p.slice(2)) : p;
}

/** A file-name-safe id. */
export const safeId = (s: string): string =>
  String(s)
    .replace(/[^A-Za-z0-9_.-]/g, "_")
    .slice(0, 160);
