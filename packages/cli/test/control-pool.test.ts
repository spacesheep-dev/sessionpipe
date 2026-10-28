// SPDX-License-Identifier: Apache-2.0
// The daemon as the pool's host (DESIGN §1, CONTROL.md §2 `pool`, §6 `pool`): a fake
// pool stands in for the engine. Every hello carries `pool` and validates against the
// strict schema; each signed `pool` action is acked the way §6 says, a change needs a
// fresh confirm; the local socket's `pool` op answers the terminal; the listener runs
// exactly while the pool is on; a request mid-stream keeps the daemon busy; the
// listener is the last thing stopped; and a daemon without a pool is an older one.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ControlHello, ControlHelloPool } from "@sessionpipe/core/schema";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ControlDaemon, type DaemonDeps } from "../src/control/daemon.js";
import { ask } from "../src/control/local.js";
import type { ControlConfig } from "../src/control/store.js";
import { type HelloPool, type Pool, type PoolAccount, PoolError, type PoolStatus } from "../src/pool/index.js";
import { FakeReceiver } from "./helpers/receiver.js";

const POOL = "sessionpipe:pool";
let tmp: string;
let rx: FakeReceiver;
let d: ControlDaemon | null = null;
let env: NodeJS.ProcessEnv;
let sock: string;
let log: string[];

type FakeAccount = PoolAccount & { status: "ready" | "limited" | "error" | "disabled"; current: boolean };

/** The engine as the daemon sees it: records calls, answers from `state`. */
class FakePool implements Pool {
  on = false;
  listening = false;
  in_flight = 0;
  started = 0;
  stopped = 0;
  calls: string[] = [];
  accountsList: FakeAccount[] = [];
  pending: { id: string; url: string; expires_at: string } | null = null;
  startFails: Error | null = null;
  /** Another daemon answers on the port: start() stands down (the engine's F1). */
  other = false;
  get config() {
    return { on: this.on, port: 51234, accounts: this.accountsList.map((a) => ({ ...a })) };
  }
  async start() {
    this.calls.push("start");
    if (this.startFails) throw this.startFails;
    if (this.other) return { port: 51234, moved: false, other: true as const };
    this.started++;
    this.listening = true;
    return { port: 51234, moved: false };
  }
  async stop() {
    this.calls.push("stop");
    this.stopped++;
    this.listening = false;
  }
  async setOn(on: boolean) {
    this.calls.push(`setOn:${on}`);
    this.on = on;
    return [];
  }
  beginLogin() {
    this.calls.push("beginLogin");
    this.pending = {
      id: "login_abc",
      url: "https://claude.ai/oauth/authorize?x=1",
      expires_at: "2026-10-29T10:10:00.000Z",
    };
    return this.pending;
  }
  async completeLogin(code: string, pendingId?: string) {
    this.calls.push(`completeLogin:${pendingId}`);
    if (pendingId !== "login_abc") throw new PoolError("pool_account", "that isn't the pending sign-in");
    if (code !== "good#state") throw new PoolError("login", "the vendor would not take the code");
    const a = this.add("new", "new@x.y", "New");
    return a;
  }
  requireOn() {
    if (!this.on) throw new PoolError("pool_off", "the pool is off on this machine");
  }
  async addImport() {
    this.calls.push("addImport");
    return { added: [], skipped: [] };
  }
  remove(ref: string) {
    const a = this.must(ref);
    this.accountsList = this.accountsList.filter((x) => x !== a);
    return a;
  }
  enable(ref: string) {
    const a = this.must(ref);
    a.enabled = true;
    a.status = "ready";
    return a;
  }
  disable(ref: string) {
    const a = this.must(ref);
    a.enabled = false;
    a.status = "disabled";
    return a;
  }
  order(refs: readonly string[]) {
    const list = refs.map((r) => this.must(r));
    if (list.length !== this.accountsList.length)
      throw new PoolError("pool_order", "the order must name every pooled account once");
    this.accountsList = list;
    return this.accounts();
  }
  async refresh(ref?: string) {
    this.calls.push(`refresh:${ref ?? "all"}`);
    if (ref) this.must(ref);
  }
  find(ref: string) {
    return this.accountsList.find((a) => a.id === ref || a.email === ref || a.label === ref) ?? null;
  }
  accounts() {
    return this.accountsList.map((a) => ({ ...a }));
  }
  status(): PoolStatus {
    return {
      on: this.on,
      port: 51234,
      listening: this.listening,
      in_flight: this.in_flight,
      settings: [],
      accounts: this.accountsList.map((a, i) => ({ ...a, current: this.on && i === 0 && a.status === "ready" })),
      ...(this.pending ? { pending: this.pending } : {}),
      ...(this.other ? { another_daemon: true as const } : {}),
    };
  }
  helloPool(): HelloPool {
    return {
      on: this.on,
      harness: "claude-code",
      accounts: this.accountsList.map((a, i) => ({
        id: a.account_uuid,
        email: a.email,
        ...(a.label ? { label: a.label } : {}),
        enabled: a.enabled,
        status: a.status,
        current: i === 0,
        ...(a.status === "limited" ? { until: "2026-10-29T12:00:00.000Z", limited_by: "five_hour" } : {}),
        windows: [
          { id: "five_hour", used_percent: 12 + i, resets_at: "2026-10-29T12:00:00.000Z", window_minutes: 300 },
          { id: "seven_day", used_percent: 40, resets_at: "2026-11-02T12:00:00.000Z" },
        ],
      })),
    };
  }
  add(id: string, email: string, label?: string): FakeAccount {
    const a: FakeAccount = {
      id,
      email,
      ...(label ? { label } : {}),
      account_uuid: `${id.padEnd(8, "0")}-0000-4000-8000-000000000000`,
      enabled: true,
      added_at: "2026-10-29T10:00:00.000Z",
      status: "ready" as const,
      current: false,
    };
    this.accountsList.push(a);
    return a;
  }
  private must(ref: string) {
    const a = this.find(ref);
    if (!a) throw new PoolError("pool_account", `no pooled account is ${ref}`);
    return a;
  }
}

function cfg(): ControlConfig {
  return {
    name: "testbox",
    folders: [path.join(tmp, "project")],
    mode: "safe",
    receivers: [
      {
        url: rx.url,
        control: `${rx.url}/api/sessionpipe/v1/control`,
        rpId: "localhost",
        machine: rx.machine,
        token: rx.token,
        keys: [{ ...rx.passkey.key, added_at: new Date().toISOString() }],
        paired_at: new Date().toISOString(),
      },
    ],
  };
}

async function startDaemon(pool: FakePool | null, extra: Partial<DaemonDeps> = {}) {
  d = new ControlDaemon(cfg(), path.join(tmp, "state", "control"), sock, {
    now: Date.now,
    fetch,
    log: (s) => log.push(s),
    claudeDirs: () => [path.join(tmp, "claude-config")],
    claude: () => null,
    run: async () => ({ code: 0, signal: null, stdout: "", stderr: "", tooBig: false, timedOut: false }),
    sdk: null,
    env,
    ...(pool ? { pool } : {}),
    ...extra,
  });
  await d.start();
}

/** Three accounts: Fiction serving, Misha limited, Sheep off. */
function three(pool: FakePool) {
  pool.add("fiction", "a@fiction.tribe", "Fiction");
  const m = pool.add("misha", "m@x.y", "Misha");
  m.status = "limited";
  const s = pool.add("sheep", "s@spacesheep.dev", "Sheep");
  s.enabled = false;
  s.status = "disabled";
}

const lastHello = async (pred: (h: Record<string, unknown>) => boolean) => {
  for (let i = 0; i < 100 && !rx.hellos.some(pred); i++) await new Promise((r) => setTimeout(r, 20));
  return rx.hellos.filter(pred).at(-1)!;
};
const send = (fields: Record<string, unknown>, confirm = true) =>
  rx.send({ kind: "pool", session: POOL, text: undefined, ...fields }, { confirm });

beforeAll(async () => {
  rx = new FakeReceiver();
  await rx.start();
});
afterAll(async () => {
  await rx.stop();
});
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "sp-control-pool-"));
  mkdirSync(path.join(tmp, "project"), { recursive: true });
  mkdirSync(path.join(tmp, "claude-config"), { recursive: true });
  sock = path.join(tmp, "control.sock");
  env = { ...process.env, SESSIONPIPE_STATE: path.join(tmp, "state"), SESSIONPIPE_SOCKET: sock };
  log = [];
  rx.queue.clear();
  rx.acks.length = 0;
  rx.hellos.length = 0;
});
afterEach(async () => {
  await d?.stop();
  d = null;
  rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("hello (CONTROL.md §2 `pool`)", () => {
  it("carries the pool in every hello, and a hello with three accounts validates against the strict schema", async () => {
    const pool = new FakePool();
    pool.on = true;
    three(pool);
    await startDaemon(pool);
    const h = await lastHello((x) => "pool" in x);
    expect(ControlHello.safeParse(h)).toMatchObject({ success: true });
    expect(ControlHelloPool.parse(h.pool)).toMatchObject({
      on: true,
      harness: "claude-code",
      accounts: [
        { id: "fiction0-0000-4000-8000-000000000000", label: "Fiction", status: "ready", current: true },
        { id: "misha000-0000-4000-8000-000000000000", status: "limited", until: "2026-10-29T12:00:00.000Z" },
        { id: "sheep000-0000-4000-8000-000000000000", status: "disabled", enabled: false },
      ],
    });
  });

  it("an empty pool is still said ({on:false, accounts:[]}); a daemon without one says nothing", async () => {
    await startDaemon(new FakePool());
    expect((await lastHello((x) => "pool" in x)).pool).toEqual({ on: false, harness: "claude-code", accounts: [] });
    await d!.stop();
    rx.hellos.length = 0;
    await startDaemon(null);
    const h = await lastHello((x) => x.name === "testbox");
    expect(h).not.toHaveProperty("pool");
    expect(ControlHello.safeParse(h)).toMatchObject({ success: true });
  });

  it("a change in the pool sends a hello at once", async () => {
    const pool = new FakePool();
    await startDaemon(pool);
    await lastHello((x) => "pool" in x);
    const before = rx.hellos.length;
    pool.add("fiction", "a@fiction.tribe", "Fiction");
    d!.poolChanged();
    const h = await lastHello((x) => ((x.pool as HelloPool)?.accounts.length ?? 0) === 1);
    expect(rx.hellos.length).toBeGreaterThan(before);
    expect((h.pool as HelloPool).accounts[0]).toMatchObject({ label: "Fiction" });
  });
});

describe.skipIf(process.platform === "win32")("the listener's life, busy() and status()", () => {
  it("starts with the daemon only while the pool is on; accounts alone don't start it", async () => {
    const off = new FakePool();
    three(off);
    await startDaemon(off);
    expect(off.started).toBe(0);
    expect(d!.status().pool).toEqual({
      on: false,
      port: 51234,
      listening: false,
      accounts: 3,
      with_room: 1,
      in_flight: 0,
    });
    await d!.stop();
    const on = new FakePool();
    on.on = true;
    await startDaemon(on);
    expect(on.started).toBe(1);
    expect(d!.status().pool).toMatchObject({ on: true, listening: true });
  });

  it("another daemon already serves the pool: said in the log, not listened for, shown in the status", async () => {
    const pool = new FakePool();
    pool.on = true;
    pool.other = true;
    await startDaemon(pool);
    expect(log).toContain("another daemon already serves the pool on 127.0.0.1:51234; this one leaves it to that one");
    expect(pool.started).toBe(0);
    expect(d!.status().pool).toMatchObject({ on: true, listening: false, another_daemon: true });
    expect(await ask(sock, { op: "pool", action: "status" }, 2000)).toMatchObject({ status: { another_daemon: true } });
  });

  it("a listener that won't start is logged, not fatal; a rejection with no message is logged as it came", async () => {
    const pool = new FakePool();
    pool.on = true;
    pool.startFails = new Error("EADDRINUSE");
    await startDaemon(pool);
    expect(log).toContain("the pool's listener did not start: EADDRINUSE");
    expect(d!.status().pool).toMatchObject({ listening: false });
    await d!.stop();
    log = [];
    pool.startFails = "no words" as unknown as Error;
    await startDaemon(pool);
    expect(log).toContain("the pool's listener did not start: no words");
  });

  it("poolChanged() on a daemon that isn't running sends nothing", async () => {
    const pool = new FakePool();
    d = new ControlDaemon(cfg(), path.join(tmp, "state", "control"), sock, {
      now: Date.now,
      fetch,
      log: (s) => log.push(s),
      claudeDirs: () => [],
      claude: () => null,
      run: async () => ({ code: 0, signal: null, stdout: "", stderr: "", tooBig: false, timedOut: false }),
      sdk: null,
      env,
      pool,
    });
    // The receiver is shared across the file: count, don't expect an empty list.
    const before = rx.hellos.length;
    d.poolChanged();
    await new Promise((r) => setTimeout(r, 100));
    expect(rx.hellos.length).toBe(before);
  });

  it("a pooled request being answered keeps the daemon busy; stop() closes the listener last", async () => {
    const pool = new FakePool();
    pool.on = true;
    await startDaemon(pool);
    expect(d!.busy()).toBeNull();
    pool.in_flight = 2;
    expect(d!.busy()).toBe("2 pooled request(s) being answered");
    pool.in_flight = 0;
    const r = await ask(sock, { op: "status" }, 2000);
    expect((r as { status: { pool: unknown } }).status.pool).toMatchObject({ on: true, listening: true, accounts: 0 });
    await d!.stop();
    expect(pool.calls.at(-1)).toBe("stop");
    expect(await ask(sock, { op: "status" }, 300)).toBeNull();
    d = null;
  });

  it("a daemon without a pool has no pool in its status", async () => {
    await startDaemon(null);
    expect(d!.status()).not.toHaveProperty("pool");
  });
});

describe.skipIf(process.platform === "win32")("the `pool` command (CONTROL.md §6)", () => {
  it("on: delivered with the summary line, the listener comes up; off: the listener goes down", async () => {
    const pool = new FakePool();
    three(pool);
    await startDaemon(pool);
    const on = await send({ pool_action: "on" });
    expect(await rx.waitAck(on.id)).toMatchObject({
      outcome: "delivered",
      detail: "on · 3 accounts · 1 with room · serving Fiction",
    });
    expect(pool.calls).toEqual(["setOn:true", "start"]);
    expect(await rx.waitAck(on.id)).not.toHaveProperty("mode");
    const off = await send({ pool_action: "off" });
    expect(await rx.waitAck(off.id)).toMatchObject({ outcome: "delivered", detail: "off · 3 accounts · 1 with room" });
    expect(pool.calls.slice(2)).toEqual(["setOn:false", "stop"]);
    expect(pool.listening).toBe(false);
  });

  // Several commands in one test: after each ack the daemon's next poll sees the same
  // message until the receiver has taken the ack in, and pauses two seconds for it, so
  // a round trip can cost ~2 s (as the daemon suite's multi-command tests allow for).
  it("enable, disable, remove, order and refresh, each acked with the pool as it now stands", {
    timeout: 30_000,
  }, async () => {
    const pool = new FakePool();
    pool.on = true;
    three(pool);
    await startDaemon(pool);
    const acks = async (fields: Record<string, unknown>, confirm = true) =>
      rx.waitAck((await send(fields, confirm)).id);
    expect(await acks({ pool_action: "enable", pool_account: "sheep" }, false)).toMatchObject({
      outcome: "delivered",
      detail: "on · 3 accounts · 2 with room · serving Fiction",
    });
    expect(await acks({ pool_action: "disable", pool_account: "fiction" })).toMatchObject({
      outcome: "delivered",
      detail: "on · 3 accounts · 1 with room",
    });
    expect(await acks({ pool_action: "order", pool_order: ["sheep", "misha", "fiction"] })).toMatchObject({
      outcome: "delivered",
      detail: "on · 3 accounts · 1 with room · serving Sheep",
    });
    expect(await acks({ pool_action: "refresh", pool_account: "sheep" }, false)).toMatchObject({
      outcome: "delivered",
    });
    expect(await acks({ pool_action: "refresh" }, false)).toMatchObject({ outcome: "delivered" });
    expect(pool.calls.filter((c) => c.startsWith("refresh"))).toEqual(["refresh:sheep", "refresh:all"]);
    expect(await acks({ pool_action: "remove", pool_account: "misha" })).toMatchObject({
      outcome: "delivered",
      detail: "on · 2 accounts · 1 with room · serving Sheep",
    });
    expect(pool.accounts().map((a) => a.id)).toEqual(["sheep", "fiction"]);
  });

  it("login.begin: the pending id and the URL; login.complete adds the account", async () => {
    const pool = new FakePool();
    pool.on = true;
    await startDaemon(pool);
    const b = await send({ pool_action: "login.begin" }, false);
    expect(await rx.waitAck(b.id)).toMatchObject({
      outcome: "delivered",
      detail: "login_abc https://claude.ai/oauth/authorize?x=1",
    });
    const c = await send({ pool_action: "login.complete", pool_account: "login_abc", pool_code: "good#state" });
    expect(await rx.waitAck(c.id)).toMatchObject({
      outcome: "delivered",
      detail: "on · 1 account · 1 with room · serving New",
    });
  });

  it("refused: pool_account, pool_order, pool_off; failed: login; and the detail never carries the code", {
    timeout: 30_000,
  }, async () => {
    const pool = new FakePool();
    three(pool);
    await startDaemon(pool);
    const ack = async (fields: Record<string, unknown>, confirm = true) => rx.waitAck((await send(fields, confirm)).id);
    expect(await ack({ pool_action: "enable", pool_account: "nobody" }, false)).toMatchObject({
      outcome: "refused",
      code: "pool_account",
      detail: "no pooled account is nobody",
    });
    expect(await ack({ pool_action: "order", pool_order: ["fiction"] })).toMatchObject({
      outcome: "refused",
      code: "pool_order",
    });
    expect(await ack({ pool_action: "refresh" }, false)).toMatchObject({ outcome: "refused", code: "pool_off" });
    expect(await ack({ pool_action: "login.begin" }, false)).toMatchObject({ outcome: "refused", code: "pool_off" });
    pool.on = true;
    pool.beginLogin();
    const failed = await ack({ pool_action: "login.complete", pool_account: "login_abc", pool_code: "bad#state" });
    expect(failed).toMatchObject({ outcome: "failed", code: "login", detail: "the vendor would not take the code" });
    expect(JSON.stringify(failed)).not.toContain("bad#state");
    expect(log.join("\n")).not.toContain("bad#state");
    expect(
      await ack({ pool_action: "login.complete", pool_account: "login_zzz", pool_code: "good#state" }),
    ).toMatchObject({
      outcome: "refused",
      code: "pool_account",
    });
  });

  it("on, off, remove, order, disable and login.complete need a fresh confirm: a day grant is refused confirm_required", {
    timeout: 30_000,
  }, async () => {
    const pool = new FakePool();
    pool.on = true;
    three(pool);
    await startDaemon(pool);
    for (const fields of [
      { pool_action: "on" },
      { pool_action: "off" },
      { pool_action: "remove", pool_account: "fiction" },
      { pool_action: "order", pool_order: ["fiction", "misha", "sheep"] },
      { pool_action: "disable", pool_account: "fiction" },
      { pool_action: "login.complete", pool_account: "login_abc", pool_code: "good#state" },
    ]) {
      const q = await send(fields, false);
      expect(await rx.waitAck(q.id)).toMatchObject({
        outcome: "refused",
        code: "confirm_required",
        detail: `pool ${fields.pool_action} needs a fresh confirm, not a day grant`,
      });
    }
    expect(pool.calls.filter((c) => c !== "start")).toEqual([]);
    expect(pool.accounts()).toHaveLength(3);
  });

  it("a daemon without a pool answers unsupported", async () => {
    await startDaemon(null);
    const q = await send({ pool_action: "on" });
    expect(await rx.waitAck(q.id)).toMatchObject({
      outcome: "unsupported",
      detail: "this machine can't pool: its daemon runs without the pool",
    });
  });
});

describe.skipIf(process.platform === "win32")("the local socket's `pool` op (sessionpipe pool …)", () => {
  it("answers with the outcome and the pool's status; the terminal needs no confirm and may call the vendor while off", async () => {
    const pool = new FakePool();
    three(pool);
    await startDaemon(pool);
    expect(await ask(sock, { op: "pool", action: "status" }, 2000)).toMatchObject({
      op: "pool",
      outcome: "delivered",
      detail: "off · 3 accounts · 1 with room",
      status: { on: false, accounts: [{ id: "fiction" }, { id: "misha" }, { id: "sheep" }] },
    });
    expect(await ask(sock, { op: "pool", action: "refresh", account: "fiction" }, 2000)).toMatchObject({
      outcome: "delivered",
    });
    expect(await ask(sock, { op: "pool", action: "login.begin" }, 2000)).toMatchObject({
      outcome: "delivered",
      detail: "login_abc https://claude.ai/oauth/authorize?x=1",
    });
    expect(await ask(sock, { op: "pool", action: "import" }, 2000)).toMatchObject({
      outcome: "delivered",
      imported: { added: [], skipped: [] },
    });
    expect(await ask(sock, { op: "pool", action: "on" }, 2000)).toMatchObject({
      outcome: "delivered",
      status: { on: true },
    });
    expect(pool.listening).toBe(true);
    expect(await ask(sock, { op: "pool", action: "remove", account: "nobody" }, 2000)).toMatchObject({
      op: "pool",
      outcome: "refused",
      code: "pool_account",
      detail: "no pooled account is nobody",
    });
    expect(await ask(sock, { op: "pool", action: "off" }, 2000)).toMatchObject({ outcome: "delivered" });
    expect(pool.listening).toBe(false);
  });

  it("without a pool: unsupported, and no status", async () => {
    await startDaemon(null);
    expect(await ask(sock, { op: "pool", action: "on" }, 2000)).toEqual({
      op: "pool",
      outcome: "unsupported",
      detail: "this machine can't pool: its daemon runs without the pool",
    });
  });
});
