// SPDX-License-Identifier: Apache-2.0
// ~/.config/sessionpipe/config.json, mode 0600: the machine's name, the sinks with
// their tier and token, per-harness switches, the update check, remote titles.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { configFile } from "./paths.js";
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

export function writeConfig(c: Config, file: string = configFile()): void {
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
