// SPDX-License-Identifier: Apache-2.0
// What the control daemon keeps on disk:
//   config/control.json   the receivers this machine is paired with: machine id,
//                         the machine's own token, the enrolled keys, folders, mode (0600)
//   state/control/nonces.jsonl  every verified nonce for 25 h, fsync'd before a
//                               command runs (a failed write refuses it)
//   state/control/acks.jsonl    acks not yet accepted by their receiver
//   state/control/state.json    forks: which copy a message to a session goes to, and
//                               the options each session the daemon started runs with
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { configFile, stateDir } from "@sessionpipe/core";
import { levelRank, MODEL_RE, NONCE_TTL_MS, type RunLevel, type TrustedKey } from "@sessionpipe/core/control";
import {
  controlAccount,
  defaultRunner,
  type Runner,
  type SecretStore,
  type StoreName,
  secretDel,
  secretGet,
  secretSet,
} from "../secrets.js";

export interface PairedReceiver {
  /** The receiver's origin, as the person typed it. */
  url: string;
  /** Absolute control endpoint (from the well-known file). */
  control: string;
  rpId: string;
  machine: string;
  /** The machine's own bearer (polls, acks, hello, off): opens nothing else. Empty
   *  when it lives in a store this process can't read right now. */
  token: string;
  /** The token lives in this store, not in control.json (secrets.ts). */
  token_in?: SecretStore;
  keys: (TrustedKey & { name?: string; added_at: string })[];
  paired_at: string;
}

/** How sessions run when a message arrives (CONTROL.md §2): the person's choice at
 *  this machine, never a receiver's. */
export const MODES = ["safe", "auto", "inherit"] as const;
export type ControlMode = (typeof MODES)[number];
export const parseMode = (m: unknown): ControlMode | null =>
  (MODES as readonly unknown[]).includes(m) ? (m as ControlMode) : null;

export interface ControlConfig {
  name: string;
  /** Folders sessions may run in; compared on whole path segments, real paths. */
  folders: string[];
  mode: ControlMode;
  receivers: PairedReceiver[];
  /** Caps this machine keeps whatever a receiver sends (defaults in daemon.ts,
   *  LIMITS): new sessions running at once and per hour, headless Claude Code runs
   *  at once. */
  limits?: { start_concurrent?: number; start_per_hour?: number; headless?: number };
}

export const controlFile = (env: NodeJS.ProcessEnv = process.env) =>
  path.join(path.dirname(configFile(env)), "control.json");
export const controlState = (env: NodeJS.ProcessEnv = process.env) => path.join(stateDir(env), "control");

export function writePrivate(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {}
}

export function readControl(env: NodeJS.ProcessEnv = process.env, run: Runner = defaultRunner): ControlConfig | null {
  try {
    const j = JSON.parse(readFileSync(controlFile(env), "utf8")) as ControlConfig;
    if (!j || !Array.isArray(j.receivers)) return null;
    return {
      name: j.name || "machine",
      folders: j.folders ?? [],
      mode: parseMode(j.mode) ?? "safe",
      receivers: j.receivers.map((r) =>
        r.token_in ? { ...r, token: secretGet(r.token_in, controlAccount(r.machine), run) ?? "" } : r,
      ),
      ...(j.limits ? { limits: j.limits } : {}),
    };
  } catch {
    return null;
  }
}

/** How many receivers this machine is paired with, from control.json alone (no
 *  keychain read: `status` shouldn't ask one). */
export function pairedCount(env: NodeJS.ProcessEnv = process.env): number {
  try {
    const j = JSON.parse(readFileSync(controlFile(env), "utf8")) as { receivers?: unknown };
    return Array.isArray(j.receivers) ? j.receivers.length : 0;
  } catch {
    return 0;
  }
}

/** A token kept in a store is never written back into the file. */
export const writeControl = (c: ControlConfig, env: NodeJS.ProcessEnv = process.env) =>
  writePrivate(controlFile(env), {
    ...c,
    receivers: c.receivers.map((r) => {
      if (!r.token_in) return r;
      const { token: _t, ...rest } = r;
      return rest;
    }),
  });

/** Move every paired receiver's token into `to` (or back into control.json). A token
 *  this process can't read is left where it is. */
export function moveControlSecrets(
  to: StoreName,
  o: { env?: NodeJS.ProcessEnv; run?: Runner } = {},
): { moved: string[]; kept: string[] } {
  const run = o.run ?? defaultRunner;
  const cfg = readControl(o.env, run);
  const moved: string[] = [];
  const kept: string[] = [];
  if (!cfg) return { moved, kept };
  const drop: { store: SecretStore; machine: string }[] = [];
  for (const r of cfg.receivers) {
    if ((r.token_in ?? "file") === to) continue;
    if (!r.token) {
      kept.push(r.url);
      continue;
    }
    if (to !== "file" && !secretSet(to, controlAccount(r.machine), r.token, run)) {
      secretDel(to, controlAccount(r.machine), run);
      kept.push(r.url);
      continue;
    }
    if (r.token_in) drop.push({ store: r.token_in, machine: r.machine });
    if (to === "file") delete r.token_in;
    else r.token_in = to;
    moved.push(r.url);
  }
  writeControl(cfg, o.env);
  for (const d of drop) secretDel(d.store, controlAccount(d.machine), run);
  return { moved, kept };
}

/** Forget a receiver's token wherever it is (control off). */
export function dropControlSecret(r: PairedReceiver, run: Runner = defaultRunner): void {
  if (r.token_in) secretDel(r.token_in, controlAccount(r.machine), run);
}

/** Nonces the machine has run, for NONCE_TTL_MS. `seen()` records a new nonce
 *  durably BEFORE it answers false; a write that fails throws, and the verifier
 *  refuses the command (`nonce_store`). */
export class NonceStore {
  private readonly seenAt = new Map<string, number>();
  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {
    let raw = "";
    try {
      raw = readFileSync(file, "utf8");
    } catch {}
    const cut = this.now() - NONCE_TTL_MS;
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        const { n, t } = JSON.parse(line) as { n: string; t: number };
        if (typeof n === "string" && t > cut) this.seenAt.set(n, t);
      } catch {}
    }
    this.compact();
  }

  seen = (nonce: string): boolean => {
    const t = this.seenAt.get(nonce);
    if (t !== undefined && t > this.now() - NONCE_TTL_MS) return true;
    const at = this.now();
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const fd = openSync(this.file, "a", 0o600);
    try {
      appendFileSync(fd, `${JSON.stringify({ n: nonce, t: at })}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.seenAt.set(nonce, at);
    return false;
  };

  /** Rewrite the file with only the live window (on start, and daily). */
  compact(): void {
    const cut = this.now() - NONCE_TTL_MS;
    for (const [n, t] of this.seenAt) if (t <= cut) this.seenAt.delete(n);
    if (!existsSync(this.file) && !this.seenAt.size) return;
    const body = [...this.seenAt].map(([n, t]) => JSON.stringify({ n, t })).join("\n");
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileSync(`${this.file}.tmp`, body ? `${body}\n` : "", { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
  }

  get size(): number {
    return this.seenAt.size;
  }
}

export interface Ack {
  receiver: string;
  id: string;
  outcome: "taken" | "delivered" | "expired" | "unsupported" | "failed" | "refused";
  at: string;
  mode?: string;
  session?: string;
  code?: string;
  detail?: string;
  reply?: string;
  /** A start's taken and delivered: what it ran with (CONTROL.md §6, Options). */
  applied?: StartOptions;
}

/** What a session the daemon started runs with: its level and, when one was asked for,
 *  its model. Recorded at the start; every later run of the session reads it. */
export interface StartOptions {
  /** A level, or `inherit`: started on an inherit machine with none named. */
  permission: RunLevel;
  model?: string;
}

/** A recorded entry as read back from disk, or null when it isn't one. */
export function startOptionsOf(v: unknown): StartOptions | null {
  const o = v as { permission?: unknown; model?: unknown } | null;
  if (!o || typeof o !== "object" || (levelRank(o.permission) < 0 && o.permission !== "inherit")) return null;
  return {
    permission: o.permission as RunLevel,
    ...(typeof o.model === "string" && MODEL_RE.test(o.model) ? { model: o.model } : {}),
  };
}

/** Acks not yet accepted: appended before they are sent, rewritten when sent, so a
 *  daemon restart re-sends rather than forgets (every message is acked exactly once
 *  with a final outcome; a duplicate is tolerated by the receiver). */
export class AckOutbox {
  constructor(private readonly file: string) {}
  all(): Ack[] {
    try {
      return readFileSync(this.file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Ack);
    } catch {
      return [];
    }
  }
  add(a: Ack): void {
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    appendFileSync(this.file, `${JSON.stringify(a)}\n`, { mode: 0o600 });
  }
  keep(left: Ack[]): void {
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileSync(`${this.file}.tmp`, left.map((a) => JSON.stringify(a)).join("\n") + (left.length ? "\n" : ""), {
      mode: 0o600,
    });
    renameSync(`${this.file}.tmp`, this.file);
  }
}

export interface DaemonState {
  /** Original session → the fork its messages go to. */
  copies: Record<string, string>;
  /** Claude Code sessions the daemon started → what they run with (Codex and
   *  Antigravity keep theirs in the alias entry, aliases.ts). */
  started: Record<string, StartOptions>;
}

export function readState(file: string): DaemonState {
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as { copies?: unknown; started?: unknown };
    const started: Record<string, StartOptions> = {};
    if (j.started && typeof j.started === "object")
      for (const [k, v] of Object.entries(j.started)) {
        const o = startOptionsOf(v);
        if (o) started[k] = o;
      }
    return { copies: j.copies && typeof j.copies === "object" ? (j.copies as Record<string, string>) : {}, started };
  } catch {
    return { copies: {}, started: {} };
  }
}
export const writeState = (file: string, s: DaemonState) => writePrivate(file, s);
