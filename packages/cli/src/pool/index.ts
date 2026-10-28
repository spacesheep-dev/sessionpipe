// SPDX-License-Identifier: Apache-2.0
// The pool engine (DESIGN §1, §2.1): several Claude accounts behind one loopback
// listener the control daemon runs, so a Claude Code session keeps going when one
// account's limit is reached. This file is the façade the daemon and the CLI use;
// nothing outside pool/ imports the parts.
//
//   openPool(deps) → Pool                 reads pool.json and state.json; nothing listens yet
//
//   pool.start() → {port, moved}          the listener on 127.0.0.1 (pool.json's port, else a
//                                         free one, persisted); starts the idle usage poll
//                                         (every 5 min). `moved` and `on`: settings were
//                                         rewritten for the new port. Idempotent.
//   pool.stop()                           closes the listener and the poll; state is on disk.
//   pool.setOn(true | false)              writes / removes the `env` block in every Claude Code
//                                         settings.json (install.ts) and remembers `on`. Works
//                                         without the listener (the CLI): a port is reserved
//                                         and persisted first. Returns the per-file reports.
//   pool.beginLogin() → {id, url}         a PKCE login; pool.completeLogin(code, id?) → account
//   pool.addImport() → {added, skipped}   every Claude Code login on this machine not pooled yet
//   pool.remove / enable / disable(ref)   ref: the pool id, the account uuid, the email or label
//   pool.order(refs)                      the complete order (every account once; PoolError else)
//   pool.refresh(ref?) → Promise          read usage now, one account or all
//   pool.status() → PoolStatus            everything `sessionpipe pool` prints
//   pool.helloPool() → HelloPool          the hello's `pool` object (DESIGN §2.3), always (off and
//                                         empty: {on:false, accounts:[]}, so a receiver can tell
//                                         "no pool" from "an old daemon"). `id` is the account uuid;
//                                         each entry carries `windows?` and `limited_by?`.
//   pool.accounts() → PoolAccount[]       the records, in order
//
//   deps.onLimits(accountUuid, session | null, limits)   an account's windows changed on a request:
//                                         the daemon appends `limits.observed` with `account_id`
//                                         on that session (null session: from an idle poll; keep
//                                         it for the hello, don't invent a session).
//   deps.onChange()                       anything the hello carries changed: send one now.
//
//   pool.requireOn()                     throws PoolError `pool_off` when the pool is off: what the
//                                         daemon calls before refresh / login.begin / login.complete
//                                         (CONTROL.md §6); the CLI doesn't, `pool add` works off.
//
// Every mutation is written to disk before it returns (pool.json and state.json whole,
// temp file + rename; secrets in the secrets store). A PoolError carries the ack's
// `code` (CONTROL.md §6): refused `pool_account` (no such account, or no such pending
// login), `pool_order` (not every account once), `pool_off`; failed `login` (the vendor
// refused the code, the sign-in ran out) and `pool` (the secrets store refused).
import { randomBytes } from "node:crypto";
import net from "node:net";
import { claudePool, claudeDirs as coreClaudeDirs, type InstallReport } from "@sessionpipe/core";
import { bestStore, defaultRunner, type Runner } from "../secrets.js";
import { Credentials } from "./credentials.js";
import { type Imported, importLogins, type ResolvedLogin } from "./import.js";
import { installedPoolEnv, installPoolEnv, type PoolEnvState, uninstallPoolEnv } from "./install.js";
import { beginLogin, completeLogin, pendingLogin } from "./login.js";
import { type AccountSummary, expirePins, observe, type PolicyState, summary } from "./policy.js";
import { type PoolServer, startPoolServer } from "./server.js";
import {
  keepStanding,
  type PoolAccount,
  type PoolConfig,
  PoolSecrets,
  type PoolState,
  policyAccounts,
  readPool,
  readPoolState,
  TOKEN_NAME,
  writePool,
  writePoolState,
} from "./store.js";
import type { Exec, ImportableLogin, LimitWindow, PoolAdapter, PoolLimits, PoolProfile } from "./types.js";

export type { Credentials } from "./credentials.js";
export { cleanEnv, installedPoolEnv, installPoolEnv, poolEnv, uninstallPoolEnv } from "./install.js";
export { accountId } from "./login.js";
export {
  type AccountStatus,
  type AccountSummary,
  choose,
  expirePins,
  HOLD_MS,
  observe,
  PIN_IDLE_MS,
  type PolicyState,
  SWITCH_PERCENT,
  summary,
} from "./policy.js";
export { type PoolServer, type PoolStats, startPoolServer } from "./server.js";
export { type PoolAccount, type PoolConfig, poolFile, poolStateFile, readPool } from "./store.js";
export type * from "./types.js";

/** Idle accounts are asked for their usage this often (and at once on add/enable/refresh). */
export const POLL_MS = 5 * 60_000;
/** The hello lists at most this many (core's hello schema). */
export const ACCOUNTS_MAX = 20;
/** How long the listener trusts its copy of the bearer before asking the store again. */
export const BEARER_CACHE_MS = 5_000;
/** How long state.json may lag the pins and holds in memory. */
export const PERSIST_MS = 1_000;

export interface PoolDeps {
  /** core's `claudePool` unless a test says otherwise (types.ts says what of it is used). */
  adapter?: PoolAdapter;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  /** Runs `security` / `secret-tool` for the secrets store. */
  run?: Runner;
  /** Runs the keychain reader for `addImport`; by default `run`, failing loudly. */
  exec?: Exec;
  claudeDirs?: () => string[];
  /** PKCE randomness (tests). */
  random?: (n: number) => Buffer;
  onLimits?: (accountUuid: string, session: string | null, limits: PoolLimits) => void;
  onChange?: () => void;
  /** Where requests go (tests: the fake upstream). */
  upstream?: string;
  pollMs?: number;
}

export type PoolErrorCode = "pool_account" | "pool_order" | "pool_off" | "login" | "pool";
export class PoolError extends Error {
  constructor(
    readonly code: PoolErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface HelloPoolAccount {
  /** The account uuid: joins with `limits.observed.account_id` and `session.account_id`. */
  id: string;
  email?: string;
  label?: string;
  enabled: boolean;
  status: AccountSummary["status"];
  current: boolean;
  until?: string;
  windows?: LimitWindow[];
  limited_by?: string;
}
export interface HelloPool {
  on: boolean;
  harness: "claude-code";
  accounts: HelloPoolAccount[];
}

export interface PoolStatus {
  on: boolean;
  port: number;
  /** The listener is up in this process. */
  listening: boolean;
  /** Requests it is answering right now (0 when it isn't up). */
  in_flight: number;
  settings: { file: string; state: PoolEnvState; note?: string }[];
  accounts: (PoolAccount & AccountSummary & { limits?: PoolLimits })[];
  pending?: { id: string; url: string; expires_at: string };
}

export interface Pool {
  start(): Promise<{ port: number; moved: boolean }>;
  stop(): Promise<void>;
  setOn(on: boolean): Promise<InstallReport[]>;
  beginLogin(): { id: string; url: string; expires_at: string };
  completeLogin(code: string, pendingId?: string): Promise<PoolAccount>;
  requireOn(): void;
  addImport(): Promise<Imported>;
  remove(ref: string): PoolAccount;
  enable(ref: string): PoolAccount;
  disable(ref: string): PoolAccount;
  order(refs: readonly string[]): PoolAccount[];
  refresh(ref?: string): Promise<void>;
  find(ref: string): PoolAccount | null;
  accounts(): PoolAccount[];
  status(): PoolStatus;
  helloPool(): HelloPool;
  readonly config: PoolConfig;
}

/** The pool in one line, for an ack's `detail` and the first line of `sessionpipe pool`
 *  (CONTROL.md §6): `on · 3 accounts · 2 with room · serving Fiction`. */
export function summaryLine(s: Pick<PoolStatus, "on" | "accounts">): string {
  const n = s.accounts.length;
  const room = s.accounts.filter((a) => a.status === "ready").length;
  const current = s.accounts.find((a) => a.current);
  const parts = [s.on ? "on" : "off", `${n} account${n === 1 ? "" : "s"}`];
  if (n) parts.push(`${room} with room`);
  if (current) parts.push(`serving ${current.label || current.email}`);
  return parts.join(" · ");
}

export function openPool(deps: PoolDeps): Pool {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const run = deps.run ?? defaultRunner;
  const dirs = deps.claudeDirs ?? (() => coreClaudeDirs(env));
  const adapter: PoolAdapter = deps.adapter ?? claudePool;
  const exec: Exec =
    deps.exec ??
    ((cmd, args) => {
      const r = run(cmd, args);
      if (r.status !== 0) throw new Error(`${cmd} exited ${r.status}`);
      return r.stdout;
    });
  const secrets = new PoolSecrets(env, run);

  const cfg: PoolConfig = readPool(env);
  const disk: PoolState = readPoolState(env);
  const policy: PolicyState = { accounts: policyAccounts(cfg, disk), pins: disk.pins };
  expirePins(policy, now());

  const saveConfig = () => writePool(cfg, env);
  const saveState = () => {
    keepStanding(disk, policy.accounts);
    disk.pins = policy.pins;
    writePoolState(disk, env);
  };
  const changed = () => deps.onChange?.();
  /** Every id the policy or the listener names is a config record's (resync keeps it so). */
  const uuidOf = (id: string) => (cfg.accounts.find((a) => a.id === id) as PoolAccount).account_uuid;
  const why = (e: unknown): string => (e instanceof Error ? e.message : String(e));

  const credentials = new Credentials({
    now,
    load: (id) => secrets.credential(cfg, id),
    save: (id, c) => secrets.setCredential(cfg, id, c),
    refresh: (c) => adapter.refreshCredential(c, fetchFn, now),
    isAuthError: (e) => e instanceof adapter.PoolAuthError,
    log,
  });

  /** The secrets store is chosen when the first secret is written, and kept. */
  const placeSecrets = () => {
    if (cfg.secrets_in !== undefined || cfg.accounts.length) return;
    const s = bestStore(env, process.platform, run);
    if (s !== "file") cfg.secrets_in = s;
  };

  /** The bearer Claude Code presents. `pool on` mints a new one every time (an old copy
   *  in a backup dies with it); the listener reads it through `bearer()`, which asks the
   *  store again at most every few seconds, so a rotation by the CLI reaches a running
   *  daemon without a restart. */
  const mint = (): string => {
    placeSecrets();
    const t = randomBytes(32).toString("base64url");
    if (!secrets.set(cfg, TOKEN_NAME, t)) throw new PoolError("pool", "the secrets store refused the pool's token");
    saveConfig();
    cached = { token: t, at: now() };
    return t;
  };
  let cached: { token: string; at: number } | null = null;
  const bearer = (): string => {
    if (cached && now() - cached.at < BEARER_CACHE_MS) return cached.token;
    const t = secrets.get(cfg, TOKEN_NAME) ?? "";
    cached = { token: t, at: now() };
    return t;
  };
  const ours = (token: string, lastToken?: string) => ({
    port: cfg.port,
    token,
    lastPort: cfg.last_port,
    lastToken,
  });

  /** The policy's row for a config record, kept across re-syncs. */
  const resync = () => {
    const by = new Map(policy.accounts.map((a) => [a.id, a]));
    policy.accounts = cfg.accounts.map((a) => ({ ...(by.get(a.id) ?? { id: a.id }), id: a.id, enabled: a.enabled }));
    expirePins(policy, now());
  };

  const find = (ref: string): PoolAccount | null =>
    cfg.accounts.find(
      (a) => a.id === ref || a.account_uuid === ref || a.email === ref || (!!a.label && a.label === ref),
    ) ?? null;
  const must = (ref: string): PoolAccount => {
    const a = find(ref);
    if (!a) throw new PoolError("pool_account", `no pooled account is ${ref}`);
    return a;
  };

  let server: PoolServer | null = null;
  let poll: NodeJS.Timeout | null = null;

  /** Ask the usage endpoint for one account; the numbers go to the policy (no session). */
  const pollOne = async (id: string): Promise<void> => {
    const cred = await credentials.get(id);
    if (!cred.ok) {
      if (cred.why === "sign-in" && observeStanding(id, { error: "sign in again" })) changed();
      return;
    }
    try {
      const limits = await adapter.fetchUsage(cred.access, fetchFn, now);
      if (!limits) return;
      const before = summary(policy, now()).find((s) => s.id === id)?.status;
      if (observe(policy, id, limits, now())) {
        saveState();
        deps.onLimits?.(uuidOf(id), null, limits);
        if (summary(policy, now()).find((s) => s.id === id)?.status !== before) changed();
      }
    } catch (e) {
      log(`${id}: usage poll failed — ${why(e)}`);
    }
  };
  const observeStanding = (id: string, what: { error: string | null }): boolean => {
    const a = policy.accounts.find((x) => x.id === id);
    if (!a || (a.error ?? null) === what.error) return false;
    observe(policy, id, what, now());
    saveState();
    return true;
  };
  const pollIdle = async () => {
    // Off means off: no credential is used until the person turns the pool on again.
    if (!cfg.on) return;
    const t = now();
    const every = deps.pollMs ?? POLL_MS;
    for (const a of policy.accounts)
      if (a.enabled && !a.error && (a.limits_at === undefined || t - a.limits_at >= every)) await pollOne(a.id);
    if (expirePins(policy, now())) saveState();
  };

  const freePort = (): Promise<number> =>
    new Promise((resolve, reject) => {
      const s = net.createServer();
      s.once("error", reject);
      s.listen(0, "127.0.0.1", () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(p));
      });
    });

  const install = (lastToken?: string): InstallReport[] => installPoolEnv(dirs(), ours(bearer(), lastToken));

  /** state.json is written at most once a second while requests flow, and on stop. */
  let dirty: NodeJS.Timeout | null = null;
  const persistSoon = () => {
    if (dirty) return;
    dirty = setTimeout(() => {
      dirty = null;
      saveState();
    }, PERSIST_MS);
    dirty.unref();
  };
  const flush = () => {
    if (dirty) clearTimeout(dirty);
    dirty = null;
    saveState();
  };

  /** A login's account uuid and email, from its .claude.json or else the profile endpoint
   *  (refreshing first when the copy has no live access token). Null: unreadable. */
  const resolveLogin = async (l: ImportableLogin): Promise<ResolvedLogin | null> => {
    let credential = l.credential;
    let profile: PoolProfile | null = null;
    try {
      if (!l.account_uuid || credential.expires_at <= now())
        credential = await adapter.refreshCredential(credential, fetchFn, now);
      if (!l.account_uuid) profile = await adapter.fetchProfile(credential.access, fetchFn);
    } catch (e) {
      log(`import from ${l.dir}: ${why(e)}`);
      return null;
    }
    const account_uuid = profile?.account_uuid ?? (l.account_uuid as string);
    return { dir: l.dir, account_uuid, email: profile?.email ?? l.email ?? "", credential };
  };

  /** A new account record with its credential; usage is read once right away. */
  const adopt = async (account: PoolAccount, credential: Parameters<Credentials["set"]>[1]): Promise<void> => {
    placeSecrets();
    if (!credentials.set(account.id, credential))
      throw new PoolError("pool", "the secrets store refused the account's credential");
    const i = cfg.accounts.findIndex((a) => a.id === account.id);
    if (i >= 0) cfg.accounts[i] = account;
    else cfg.accounts.push(account);
    resync();
    observeStanding(account.id, { error: null });
    saveConfig();
    saveState();
    changed();
    await pollOne(account.id);
  };

  const pool: Pool = {
    get config() {
      return cfg;
    },
    accounts: () => cfg.accounts.map((a) => ({ ...a })),
    find,

    async start() {
      if (server) return { port: server.port, moved: false };
      server = await startPoolServer({
        adapter,
        fetch: fetchFn,
        now,
        log,
        port: cfg.port,
        token: bearer,
        on: () => cfg.on,
        state: policy,
        accountUuid: uuidOf,
        credentials,
        persist: persistSoon,
        onLimits: (id, session, limits) => deps.onLimits?.(uuidOf(id), session, limits),
        onStanding: changed,
        ...(deps.upstream ? { upstream: deps.upstream } : {}),
      });
      const moved = server.port !== cfg.port;
      if (moved) {
        if (cfg.port) cfg.last_port = cfg.port;
        cfg.port = server.port;
        saveConfig();
        if (cfg.on) {
          log(`the listener moved to port ${cfg.port}; settings.json rewritten`);
          install();
        }
      }
      poll = setInterval(() => void pollIdle(), deps.pollMs ?? POLL_MS);
      poll.unref();
      void pollIdle();
      log(`pool listening on 127.0.0.1:${server.port} (${cfg.on ? "on" : "off"}, ${cfg.accounts.length} accounts)`);
      return { port: server.port, moved };
    },

    async stop() {
      if (poll) clearInterval(poll);
      poll = null;
      const s = server;
      server = null;
      if (s) await s.close();
      flush();
    },

    async setOn(on) {
      if (on) {
        if (!cfg.port) {
          cfg.port = server?.port ?? (await freePort());
          saveConfig();
        }
        // A fresh bearer every time: the old one, wherever it was copied, stops working.
        const before = bearer();
        mint();
        const reports = install(before || undefined);
        const created = new Set(cfg.created ?? []);
        for (const r of reports) if (r.created) created.add(r.file);
        cfg.on = true;
        cfg.created = [...created];
        saveConfig();
        changed();
        return reports;
      }
      const reports = uninstallPoolEnv(dirs(), { ...ours(bearer()), created: cfg.created ?? [] });
      cfg.on = false;
      delete cfg.created;
      saveConfig();
      changed();
      return reports;
    },

    requireOn() {
      if (!cfg.on) throw new PoolError("pool_off", "the pool is off on this machine");
    },

    beginLogin() {
      const p = beginLogin(adapter, now(), deps.random);
      disk.pending = p;
      saveState();
      return { id: p.id, url: p.url, expires_at: new Date(p.expires_at).toISOString() };
    },

    async completeLogin(code, pendingId) {
      const got = pendingLogin(disk.pending, pendingId, now());
      if ("why" in got) {
        if (got.why === "login_expired") {
          delete disk.pending;
          saveState();
        }
        // A pending login the machine doesn't hold is refused by its id (`pool_account`);
        // one that ran out while the person was away failed (`login`).
        throw new PoolError(
          got.why === "login_expired" ? "login" : "pool_account",
          got.why === "no_pending"
            ? "no sign-in is pending; begin one first"
            : got.why === "login_expired"
              ? "the sign-in took longer than 10 minutes; begin again"
              : "that isn't the pending sign-in",
        );
      }
      let r: Awaited<ReturnType<typeof completeLogin>>;
      try {
        r = await completeLogin(adapter, fetchFn, got.pending, code, cfg.accounts, now());
      } catch (e) {
        throw new PoolError("login", why(e));
      }
      delete disk.pending;
      await adopt(r.account, r.credential);
      return r.account;
    },

    async addImport() {
      const logins: ResolvedLogin[] = [];
      const unreadable: Imported["skipped"] = [];
      for (const l of adapter.importableLogins(env, exec)) {
        const r = await resolveLogin(l);
        if (r) logins.push(r);
        else
          unreadable.push({
            dir: l.dir,
            ...(l.email ? { email: l.email } : {}),
            why: "its token could not be read or refreshed",
          });
      }
      const r = importLogins(logins, cfg.accounts, now());
      r.skipped.push(...unreadable);
      for (const a of r.added) await adopt(a.account, a.credential);
      return r;
    },

    remove(ref) {
      const a = must(ref);
      cfg.accounts = cfg.accounts.filter((x) => x.id !== a.id);
      credentials.forget(a.id);
      secrets.del(cfg, `pool:${a.id}`);
      resync();
      saveConfig();
      saveState();
      changed();
      return a;
    },

    enable(ref) {
      const a = must(ref);
      a.enabled = true;
      resync();
      saveConfig();
      saveState();
      changed();
      void pollOne(a.id);
      return a;
    },

    disable(ref) {
      const a = must(ref);
      a.enabled = false;
      resync();
      saveConfig();
      saveState();
      changed();
      return a;
    },

    order(refs) {
      const ids = refs.map((r) => find(r)?.id ?? null);
      const missing = refs.filter((_r, i) => ids[i] === null);
      if (missing.length) throw new PoolError("pool_account", `no pooled account is ${missing.join(", ")}`);
      if (new Set(ids).size !== cfg.accounts.length || ids.length !== cfg.accounts.length)
        throw new PoolError("pool_order", "the order must name every pooled account once");
      cfg.accounts = ids.map((id) => cfg.accounts.find((a) => a.id === id) as PoolAccount);
      resync();
      saveConfig();
      saveState();
      changed();
      return pool.accounts();
    },

    async refresh(ref) {
      if (ref !== undefined) {
        await pollOne(must(ref).id);
        return;
      }
      for (const a of cfg.accounts) if (a.enabled) await pollOne(a.id);
    },

    status() {
      const t = now();
      const sums = summary(policy, t);
      return {
        on: cfg.on,
        port: cfg.port,
        listening: server !== null,
        in_flight: server?.stats.in_flight ?? 0,
        settings: cfg.port ? installedPoolEnv(dirs(), ours(bearer())) : [],
        accounts: cfg.accounts.map((a, i) => {
          const limits = policy.accounts[i]?.limits;
          return { ...a, ...(sums[i] as AccountSummary), ...(limits ? { limits } : {}) };
        }),
        ...(disk.pending && disk.pending.expires_at > t
          ? {
              pending: {
                id: disk.pending.id,
                url: disk.pending.url,
                expires_at: new Date(disk.pending.expires_at).toISOString(),
              },
            }
          : {}),
      };
    },

    helloPool() {
      const sums = summary(policy, now());
      return {
        on: cfg.on,
        harness: "claude-code",
        accounts: cfg.accounts.slice(0, ACCOUNTS_MAX).map((a, i) => {
          const s = sums[i] as AccountSummary;
          return {
            id: a.account_uuid,
            ...(a.email ? { email: a.email } : {}),
            ...(a.label ? { label: a.label } : {}),
            enabled: a.enabled,
            status: s.status,
            current: s.current,
            ...(s.until ? { until: s.until } : {}),
            ...(s.windows ? { windows: s.windows } : {}),
            ...(s.limited_by ? { limited_by: s.limited_by } : {}),
          };
        }),
      };
    },
  };
  return pool;
}
