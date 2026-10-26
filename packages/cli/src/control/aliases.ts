// SPDX-License-Identifier: Apache-2.0
// Sessions the daemon started under the command's name (spec/CONTROL.md §6 `start`).
// Codex and Antigravity pick a new session's id themselves, but a `start` names the
// session (`codex:<id>`), and that name is what the person's receiver knows it by. So
// the moment a run reveals the harness's own id, the daemon records it here:
//
//   state/control/aliases.json   {"codex:<command's id>": {"id": "<harness's id>",
//                                  "cwd": "<folder>", "at": "<iso>",
//                                  "permission": "<level>", "model": "<id>"}, …}   (0600)
//
// and everything the machine reports uses the command's id: the daemon's acks, a later
// prompt (resumed under the harness's id), and the hook events, which the worker renames
// before it builds them (run.ts). Small, so it is read whole wherever it is needed.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type StartOptions, startOptionsOf } from "./store.js";

export interface Alias {
  /** The harness's own session id. */
  id: string;
  /** The folder the session runs in (the start's). */
  cwd: string;
  at: string;
  /** What the start ran with (CONTROL.md §6, Options); absent for an alias recorded
   *  before 0.10.0, whose later runs keep the machine's mode. */
  permission?: StartOptions["permission"];
  model?: string;
}
export type Aliases = Record<string, Alias>;

export const aliasFile = (controlDir: string): string => path.join(controlDir, "aliases.json");

export function readAliases(file: string): Aliases {
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!j || typeof j !== "object" || Array.isArray(j)) return {};
    const out: Aliases = {};
    for (const [k, v] of Object.entries(j as Record<string, unknown>)) {
      const a = v as Partial<Alias> | null;
      if (a && typeof a.id === "string" && a.id && typeof a.cwd === "string")
        out[k] = { id: a.id, cwd: a.cwd, at: typeof a.at === "string" ? a.at : "", ...startOptionsOf(a) };
    }
    return out;
  } catch {
    return {};
  }
}

/** Written whole and renamed into place, 0600 in a 0700 folder. */
export function writeAliases(file: string, all: Aliases): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {}
}

/** The command's id a harness's own session goes by, or null when it was never renamed. */
export function receiverIdOf(all: Aliases, harness: string, id: string): string | null {
  const prefix = `${harness}:`;
  for (const [k, a] of Object.entries(all)) if (a.id === id && k.startsWith(prefix)) return k.slice(prefix.length);
  return null;
}
