// SPDX-License-Identifier: Apache-2.0
// ~/.config/sessionpipe/config.json, mode 0600: the machine's name, the sinks with
// their tier and token, per-harness switches, the update check, remote titles.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { configFile, tilde } from "./paths.js";
import type { Tier } from "./types.js";

export interface SinkConfig {
  name: string;
  /** https://…, file:PATH, stdout, otlp:URL */
  url: string;
  tier: Tier;
  pii?: boolean;
  /** @deprecated Never set: control is per machine (spec/CONTROL.md §2). Kept so an
   *  older config still reads. */
  control?: boolean;
  token?: string;
  /** whsec_… for Standard Webhooks signatures. */
  secret?: string;
  /** The token (and secret) live in this store instead of in this file; the client
   *  reads them from it when it sends. */
  token_in?: "keychain" | "secret-service";
  /** Learned from the receiver's well-known file; re-read daily. */
  max_tier?: Tier;
  well_known_at?: string;
  paused?: string;
}

export interface Config {
  machine?: string;
  sinks: SinkConfig[];
  /** `status_line`: Claude Code's status line is ours (install --status-line). */
  harnesses: Record<string, { enabled?: boolean; created?: string[]; status_line?: boolean }>;
  update_check?: boolean;
  keep_days?: number;
  /** Ask a harness's own service for a session's name (an adapter's `remoteFacts`):
   *  claude.ai's, for Claude Code. Off unless the person turns it on (`sessionpipe
   *  titles on`): it means reading the harness's sign-in token on this machine. */
  remote_titles?: boolean;
}

export const DEFAULT_CONFIG: Config = { sinks: [], harnesses: {}, update_check: true, keep_days: 30 };

export function readConfig(file: string = configFile()): Config {
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as Partial<Config>;
    return {
      ...DEFAULT_CONFIG,
      ...j,
      sinks: Array.isArray(j.sinks) ? j.sinks : [],
      harnesses: j.harnesses && typeof j.harnesses === "object" ? j.harnesses : {},
    };
  } catch {
    return { ...DEFAULT_CONFIG, sinks: [], harnesses: {} };
  }
}

/** Why `file` cannot be read as a config, or undefined when it can: missing, blank, or a
 *  JSON object. readConfig reads such a file as the defaults, so hooks go on. */
function configProblem(file: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? undefined : `could not be read (${code ?? "unknown error"})`;
  }
  if (!text.trim()) return undefined;
  if (text.charCodeAt(0) === 0xfeff) return "starts with a byte-order mark (save it as UTF-8 without one)";
  try {
    const j: unknown = JSON.parse(text);
    return j && typeof j === "object" && !Array.isArray(j) ? undefined : "is not a JSON object";
  } catch (e) {
    // Where, never V8's excerpt of the text: that can be part of a sink's token.
    const m = (e as Error).message;
    const at = (/line \d+ column \d+/.exec(m) ?? /position \d+/.exec(m))?.[0];
    return `is not valid JSON${at ? ` at ${at}` : ""}`;
  }
}

/** Throw if `file` holds something readConfig could not read: writing the defaults over a
 *  hand edit's typo would lose the machine's name and every sink with its token. A
 *  command with an effect before its save calls this first, so it stops before any. */
export function assertConfigWritable(file: string = configFile()): void {
  const problem = configProblem(file);
  if (problem)
    throw new Error(
      `${tilde(file)} ${problem}, so it was not written over: that would lose its machine name and sinks. Fix it, or move it aside to start again, then run this again.`,
    );
}

export function writeConfig(c: Config, file: string = configFile()): void {
  assertConfigWritable(file);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== "win32" && existsSync(file)) {
    try {
      chmodSync(file, 0o600);
    } catch {}
  }
}

/** The machine's name: what the person configured, else the hostname without a
 *  local suffix. Never guessed from anything else (a hand-typed name once linked 64
 *  versions to nothing). */
export function machineName(c: Config, hostname: string): string {
  if (c.machine) return String(c.machine).slice(0, 80);
  return hostname.replace(/\.(local|lan|home)$/i, "");
}
