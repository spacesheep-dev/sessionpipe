// SPDX-License-Identifier: Apache-2.0
// What the pool keeps on disk, beside the control daemon's files:
//   config/pool.json          on/off, the listener's port, the accounts in order
//                             (id, label, email, account uuid, enabled, added) (0600)
//   config/pool.secrets.json  the bearer and each account's credential, only when no
//                             keychain holds them (0600; `secrets_in` in pool.json says)
//   state/pool/state.json     pins, holds, the freshest numbers per account, the one
//                             pending login
// Written like control.json: whole, to a temp file, then renamed. pool.json never
// carries a secret: the pool's bearer is `pool:token` in the secrets store and an
// account's credential `pool:<id>`, as JSON.
import { readFileSync } from "node:fs";
import path from "node:path";
import { configFile, stateDir } from "@sessionpipe/core";
import { writePrivate } from "../control/store.js";
import {
  defaultRunner,
  type Runner,
  type SecretStore,
  type StoreName,
  secretDel,
  secretGet,
  secretSet,
} from "../secrets.js";
import type { AccountState, Pin } from "./policy.js";
import type { PendingLogin, PoolCredential, PoolLimits } from "./types.js";

export interface PoolAccount {
  /** The pool's short id for the account (eight hex digits of its uuid, short-id.ts). */
  id: string;
  label?: string;
  email: string;
  /** Claude Code's account uuid: what events and the hello name (DESIGN §2.3). */
  account_uuid: string;
  enabled: boolean;
  added_at: string;
}

export interface PoolConfig {
  on: boolean;
  /** 0 until the listener first picks one. */
  port: number;
  /** The port before the last move: a settings.json still naming it is still ours. */
  last_port?: number;
  /** Where the secrets live; absent: pool.secrets.json. */
  secrets_in?: SecretStore;
  accounts: PoolAccount[];
  /** settings.json files `pool on` created, so `pool off` can delete them again. */
  created?: string[];
}

export interface PoolStateAccount {
  hold_until?: number;
  error?: string;
  limits?: PoolLimits;
  limits_at?: number;
}

export interface PoolState {
  pins: Record<string, Pin>;
  accounts: Record<string, PoolStateAccount>;
  pending?: PendingLogin & { id: string; expires_at: number };
}

export const poolFile = (env: NodeJS.ProcessEnv = process.env) => path.join(path.dirname(configFile(env)), "pool.json");
export const poolSecretsFile = (env: NodeJS.ProcessEnv = process.env) =>
  path.join(path.dirname(configFile(env)), "pool.secrets.json");
export const poolStateFile = (env: NodeJS.ProcessEnv = process.env) => path.join(stateDir(env), "pool", "state.json");

const EMPTY: PoolConfig = { on: false, port: 0, accounts: [] };
const UUID_RE = /^[0-9a-f-]{8,64}$/i;

function readJson(file: string): Record<string, unknown> | null {
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** pool.json as read: defensive, every account checked, anything off the shape dropped. */
export function readPool(env: NodeJS.ProcessEnv = process.env): PoolConfig {
  const j = readJson(poolFile(env));
  if (!j) return { ...EMPTY, accounts: [] };
  const accounts: PoolAccount[] = [];
  for (const a of Array.isArray(j.accounts) ? (j.accounts as Record<string, unknown>[]) : []) {
    if (
      !a ||
      typeof a.id !== "string" ||
      typeof a.account_uuid !== "string" ||
      !UUID_RE.test(a.account_uuid) ||
      accounts.some((x) => x.id === a.id)
    )
      continue;
    accounts.push({
      id: a.id,
      ...(typeof a.label === "string" && a.label ? { label: a.label.slice(0, 64) } : {}),
      email: typeof a.email === "string" ? a.email : "",
      account_uuid: a.account_uuid,
      enabled: a.enabled !== false,
      added_at: typeof a.added_at === "string" ? a.added_at : new Date(0).toISOString(),
    });
  }
  const portOf = (v: unknown): number =>
    Number.isInteger(v) && (v as number) > 0 && (v as number) < 65536 ? (v as number) : 0;
  const port = portOf(j.port);
  const last = portOf(j.last_port);
  return {
    on: j.on === true,
    port,
    ...(last ? { last_port: last } : {}),
    ...(j.secrets_in === "keychain" || j.secrets_in === "secret-service" ? { secrets_in: j.secrets_in } : {}),
    accounts,
    ...(Array.isArray(j.created) ? { created: j.created.filter((f): f is string => typeof f === "string") } : {}),
  };
}

export const writePool = (c: PoolConfig, env: NodeJS.ProcessEnv = process.env): void => writePrivate(poolFile(env), c);

export function readPoolState(env: NodeJS.ProcessEnv = process.env): PoolState {
  const j = readJson(poolStateFile(env));
  const st: PoolState = { pins: {}, accounts: {} };
  if (!j) return st;
  if (j.pins && typeof j.pins === "object")
    for (const [s, p] of Object.entries(j.pins as Record<string, { account?: unknown; used?: unknown }>))
      if (p && typeof p.account === "string" && typeof p.used === "number")
        st.pins[s] = { account: p.account, used: p.used };
  if (j.accounts && typeof j.accounts === "object")
    for (const [id, a] of Object.entries(j.accounts as Record<string, PoolStateAccount | null>)) {
      if (!a || typeof a !== "object") continue;
      const o: PoolStateAccount = {};
      if (typeof a.hold_until === "number") o.hold_until = a.hold_until;
      if (typeof a.error === "string") o.error = a.error;
      if (a.limits && Array.isArray(a.limits.windows)) {
        o.limits = { windows: a.limits.windows, ...(a.limits.status !== undefined ? { status: a.limits.status } : {}) };
        if (typeof a.limits_at === "number") o.limits_at = a.limits_at;
      }
      st.accounts[id] = o;
    }
  const p = j.pending as PoolState["pending"] | undefined;
  if (
    p &&
    typeof p.id === "string" &&
    typeof p.url === "string" &&
    typeof p.verifier === "string" &&
    typeof p.state === "string" &&
    typeof p.expires_at === "number"
  )
    st.pending = { id: p.id, url: p.url, verifier: p.verifier, state: p.state, expires_at: p.expires_at };
  return st;
}

export const writePoolState = (s: PoolState, env: NodeJS.ProcessEnv = process.env): void =>
  writePrivate(poolStateFile(env), s);

/** The policy's view: the config's accounts in order, each with its remembered standing. */
export function policyAccounts(cfg: PoolConfig, st: PoolState): AccountState[] {
  return cfg.accounts.map((a) => ({ id: a.id, enabled: a.enabled, ...(st.accounts[a.id] ?? {}) }));
}

/** Write the policy's accounts back into the state (the config keeps `enabled`). */
export function keepStanding(st: PoolState, accounts: AccountState[]): void {
  st.accounts = {};
  for (const { id, enabled: _e, ...rest } of accounts) st.accounts[id] = rest;
}

export const TOKEN_NAME = "pool:token";
export const credentialName = (id: string): string => `pool:${id}`;

/** The pool's secrets, wherever they live. `secrets_in` picks the keychain or the
 *  Secret Service; otherwise pool.secrets.json, which is what a headless machine has. A
 *  store that can't be read right now (a keychain locked with nobody at the screen)
 *  answers null; the caller keeps what it has in memory and asks again later. */
export class PoolSecrets {
  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly run: Runner = defaultRunner,
  ) {}

  /** Where secrets go: `secrets_in` from pool.json, else the file. */
  store(cfg: PoolConfig): StoreName {
    return cfg.secrets_in ?? "file";
  }

  get(cfg: PoolConfig, name: string): string | null {
    const where = this.store(cfg);
    if (where === "file") {
      const v = readJson(poolSecretsFile(this.env))?.[name];
      return typeof v === "string" && v ? v : null;
    }
    return secretGet(where, name, this.run);
  }

  /** False when the store refused (then nothing was written anywhere). */
  set(cfg: PoolConfig, name: string, value: string): boolean {
    const where = this.store(cfg);
    if (where === "file") {
      const all = readJson(poolSecretsFile(this.env)) ?? {};
      all[name] = value;
      writePrivate(poolSecretsFile(this.env), all);
      return true;
    }
    return secretSet(where, name, value, this.run);
  }

  del(cfg: PoolConfig, name: string): void {
    const where = this.store(cfg);
    if (where === "file") {
      const all = readJson(poolSecretsFile(this.env));
      if (!all || !(name in all)) return;
      delete all[name];
      writePrivate(poolSecretsFile(this.env), all);
      return;
    }
    secretDel(where, name, this.run);
  }

  /** A credential is JSON, base64url: `security -i` takes a double-quoted word, so
   *  the quotes and spaces of JSON could never go into the keychain as they are. */
  credential(cfg: PoolConfig, id: string): PoolCredential | null {
    const raw = this.get(cfg, credentialName(id));
    if (!raw) return null;
    try {
      const c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as PoolCredential;
      return typeof c.access === "string" && typeof c.refresh === "string" && typeof c.expires_at === "number"
        ? { access: c.access, refresh: c.refresh, expires_at: c.expires_at }
        : null;
    } catch {
      return null;
    }
  }

  setCredential(cfg: PoolConfig, id: string, c: PoolCredential): boolean {
    const json = JSON.stringify({ access: c.access, refresh: c.refresh, expires_at: c.expires_at });
    return this.set(cfg, credentialName(id), Buffer.from(json).toString("base64url"));
  }
}
