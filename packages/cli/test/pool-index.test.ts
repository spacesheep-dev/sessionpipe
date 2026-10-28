// SPDX-License-Identifier: Apache-2.0
// The façade the daemon and the CLI call: open, add by login and by import, manage,
// turn on and off (settings.json), start the listener and serve a request end to end,
// the idle usage poll, the hello summary, and everything written down so a reopen
// finds it.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accountId, openPool, type Pool, type PoolDeps, PoolError, vendorOrigins } from "../src/pool/index.js";
import { poolFile, poolSecretsFile, poolStateFile, readPool, readPoolState } from "../src/pool/store.js";
import type { PoolLimits } from "../src/pool/types.js";
import type { Runner } from "../src/secrets.js";
import { body, credential, type FakeAdapter, FakeAuthError, fakeAdapter, uuidOf } from "./helpers/pool-fake.js";

const T0 = Date.parse("2026-10-29T10:00:00Z");
let tmp: string;
let env: NodeJS.ProcessEnv;
let adapter: FakeAdapter;
let now: number;
let logs: string[];
let changes: number;
let limits: { uuid: string; session: string | null; limits: PoolLimits }[];
let pools: Pool[];
const dirs = () => [path.join(tmp, ".claude"), path.join(tmp, ".claude-work")];
const settings = (i: number) => path.join(dirs()[i]!, "settings.json");

function open(over: Partial<PoolDeps> = {}): Pool {
  const p = openPool({
    adapter,
    now: () => now,
    log: (l) => logs.push(l),
    env,
    claudeDirs: dirs,
    random: () => Buffer.from("st4te"),
    onChange: () => changes++,
    onLimits: (uuid, session, l) => limits.push({ uuid, session, limits: l }),
    pollMs: 60_000,
    ...over,
  });
  pools.push(p);
  return p;
}
const usage = (used: number): PoolLimits => ({
  windows: [{ id: "five_hour", used_percent: used, resets_at: new Date(T0 + 3_600_000).toISOString() }],
});

async function signIn(pool: Pool, name: string, email = `${name}@x.y`) {
  const { id } = pool.beginLogin();
  adapter.logins.set(name, {
    credential: credential(name, 3_600_000, T0),
    profile: { account_uuid: uuidOf(name), email },
  });
  return pool.completeLogin(`${name}#st4te`, id);
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "sp-pool-"));
  env = {
    SESSIONPIPE_CONFIG: path.join(tmp, "config", "config.json"),
    SESSIONPIPE_STATE: path.join(tmp, "state"),
    SESSIONPIPE_SECRETS: "file",
  };
  adapter = fakeAdapter();
  now = T0;
  logs = [];
  changes = 0;
  limits = [];
  pools = [];
});
afterEach(async () => {
  for (const p of pools) await p.stop();
  rmSync(tmp, { recursive: true, force: true });
});

describe("an empty pool", () => {
  it("is off, has no accounts, and says so in the hello and the status", () => {
    const pool = open();
    expect(pool.config).toEqual({ on: false, port: 0, accounts: [] });
    expect(pool.helloPool()).toEqual({ on: false, harness: "claude-code", accounts: [] });
    expect(pool.status()).toEqual({
      on: false,
      port: 0,
      listening: false,
      in_flight: 0,
      settings: [],
      accounts: [],
    });
    expect(pool.accounts()).toEqual([]);
    expect(pool.find("nobody")).toBeNull();
    expect(existsSync(poolFile(env))).toBe(false);
  });
});

describe("adding accounts", () => {
  it("a login: begin, complete, and the account is on disk with its credential in the secrets file, usage read once", async () => {
    const pool = open();
    const b = pool.beginLogin();
    expect(b).toEqual({
      id: expect.any(String),
      url: "https://claude.ai/oauth/authorize?state=st4te",
      expires_at: new Date(T0 + 600_000).toISOString(),
    });
    expect(readPoolState(env).pending).toMatchObject({ id: b.id, verifier: "v-st4te" });
    expect(pool.status().pending).toEqual(b);
    adapter.usage = async () => usage(12);
    adapter.logins.set("one", {
      credential: credential("one", 3_600_000, T0),
      profile: { account_uuid: uuidOf("one"), email: "one@x.y" },
    });
    const a = await pool.completeLogin("one#st4te");
    expect(a).toEqual({
      id: accountId(uuidOf("one")),
      email: "one@x.y",
      account_uuid: uuidOf("one"),
      enabled: true,
      added_at: new Date(T0).toISOString(),
    });
    expect(readPool(env).accounts).toEqual([a]);
    expect(readFileSync(poolFile(env), "utf8")).not.toMatch(/access-|refresh-/);
    expect(JSON.parse(readFileSync(poolSecretsFile(env), "utf8"))).toEqual({
      [`pool:${a.id}`]: Buffer.from(JSON.stringify(credential("one", 3_600_000, T0))).toString("base64url"),
    });
    expect(adapter.calls.usage).toBe(1);
    expect(limits).toEqual([{ uuid: uuidOf("one"), session: null, limits: usage(12) }]);
    expect(readPoolState(env).pending).toBeUndefined();
    expect(readPoolState(env).accounts).toEqual({ [a.id]: { limits: usage(12), limits_at: T0 } });
    expect(changes).toBe(1);
    expect(pool.status().accounts[0]).toMatchObject({
      ...a,
      status: "ready",
      current: true,
      used_percent: 12,
      limits: usage(12),
    });
    expect(pool.helloPool()).toEqual({
      on: false,
      harness: "claude-code",
      accounts: [
        {
          id: uuidOf("one"),
          email: "one@x.y",
          enabled: true,
          status: "ready",
          current: true,
          windows: usage(12).windows,
        },
      ],
    });
    // The same account again: no twin, the credential replaced.
    await pool.beginLogin();
    adapter.logins.set("one", {
      credential: credential("one-b", 3_600_000, T0),
      profile: { account_uuid: uuidOf("one"), email: "one@x.y" },
    });
    expect(await pool.completeLogin("one#st4te")).toEqual(a);
    expect(readPool(env).accounts.length).toBe(1);
    expect(JSON.parse(readFileSync(poolSecretsFile(env), "utf8"))[`pool:${a.id}`]).toBe(
      Buffer.from(JSON.stringify(credential("one-b", 3_600_000, T0))).toString("base64url"),
    );
  });
  it("a login that isn't pending, is another, or ran out is refused with its code", async () => {
    const pool = open();
    await expect(pool.completeLogin("x#st4te")).rejects.toMatchObject({ code: "pool_account" });
    const b = pool.beginLogin();
    await expect(pool.completeLogin("x#st4te", "other")).rejects.toMatchObject({
      code: "pool_account",
      message: "that isn't the pending sign-in",
    });
    now = T0 + 600_000;
    await expect(pool.completeLogin("x#st4te", b.id)).rejects.toMatchObject({ code: "login", message: /10 minutes/ });
    expect(readPoolState(env).pending).toBeUndefined();
    expect(pool.status().pending).toBeUndefined();
    await expect(pool.completeLogin("x#st4te")).rejects.toMatchObject({
      code: "pool_account",
      message: "no sign-in is pending; begin one first",
    });
    pool.beginLogin();
    await expect(pool.completeLogin("nope#st4te")).rejects.toMatchObject({ code: "login", message: "bad code" });
    expect(await pool.completeLogin("nope#st4te").catch((e) => e)).toBeInstanceOf(PoolError);
    expect(readPoolState(env).pending).toBeDefined();
  });
  it("an import adds every login not pooled yet and reads each one's usage", async () => {
    const pool = open();
    adapter.importable = [
      {
        dir: "/h/.claude",
        account_uuid: uuidOf("one"),
        email: "one@x.y",
        credential: credential("one", 3_600_000, T0),
        source: "keychain",
      },
      // No .claude.json login and a copy with no live token: refreshed, then asked whose it is.
      { dir: "/h/.claude-w", credential: credential("two", 0), source: "file" },
      // An expired copy with a known uuid: refreshed, not asked.
      { dir: "/h/.claude-3", account_uuid: uuidOf("three"), credential: credential("three", 0), source: "file" },
      // A dead refresh token: skipped, with why.
      { dir: "/h/.claude-4", email: "four@x.y", credential: credential("dead", 0), source: "file" },
      { dir: "/h/.claude-5", credential: credential("dead", 0), source: "file" },
    ];
    adapter.refresh = async (c, t) => {
      if (c.refresh === "refresh-dead") throw new FakeAuthError("invalid_grant");
      return { ...c, access: `${c.access}+`, expires_at: t + 3_600_000 };
    };
    adapter.profile = async (access) => ({
      account_uuid: uuidOf(access === "access-two+" ? "two" : "?"),
      email: "two@x.y",
    });
    adapter.usage = async (access) => usage(access === "access-one" ? 99 : 5);
    const r = await pool.addImport();
    expect(r.added.map((x) => [x.account.email, x.credential.access])).toEqual([
      ["one@x.y", "access-one"],
      ["two@x.y", "access-two+"],
      ["", "access-three+"],
    ]);
    expect(r.skipped).toEqual([
      { dir: "/h/.claude-4", email: "four@x.y", why: "its token could not be read or refreshed" },
      { dir: "/h/.claude-5", why: "its token could not be read or refreshed" },
    ]);
    expect(logs).toContain("import from /h/.claude-4: invalid_grant");
    expect(pool.status().accounts.map((a) => [a.email, a.status, a.current])).toEqual([
      ["one@x.y", "limited", false],
      ["two@x.y", "ready", true],
      ["", "ready", false],
    ]);
    expect(pool.helloPool().accounts[2]).not.toHaveProperty("email");
    adapter.importable.pop();
    adapter.importable.pop();
    expect((await pool.addImport()).skipped.map((s) => s.why)).toEqual([
      "already in the pool",
      "already in the pool",
      "already in the pool",
    ]);
    expect(adapter.calls.usage).toBe(3);
    // The default exec runs the secrets runner and fails loudly; the adapter swallows that.
    const p2 = open({
      run: (cmd) => (cmd === "security" ? { status: 1, stdout: "" } : { status: 0, stdout: "out\n" }),
    });
    adapter.importableLogins = (_env, exec) => {
      expect(() => exec("security", ["x"])).toThrow("security exited 1");
      expect(exec("cat", ["x"])).toBe("out\n");
      return [];
    };
    expect(await p2.addImport()).toEqual({ added: [], skipped: [] });
  });
  it("a secrets store that refuses is a PoolError, and nothing is half-added", async () => {
    mkdirSync(path.dirname(poolFile(env)), { recursive: true });
    writeFileSync(poolFile(env), JSON.stringify({ on: false, port: 0, secrets_in: "keychain", accounts: [] }));
    const run: Runner = (_c, args) =>
      args[0] === "find-generic-password" ? { status: 44, stdout: "" } : { status: 0, stdout: "" };
    const pool = open({ run });
    pool.beginLogin();
    adapter.logins.set("one", {
      credential: credential("one"),
      profile: { account_uuid: uuidOf("one"), email: "one@x.y" },
    });
    await expect(pool.completeLogin("one#st4te")).rejects.toMatchObject({ code: "pool" });
    expect(pool.accounts()).toEqual([]);
    await expect(pool.setOn(true)).rejects.toMatchObject({ code: "pool" });
  });
  it("the pool_off refusal is the daemon's to ask for", async () => {
    const pool = open();
    expect(() => pool.requireOn()).toThrow(PoolError);
    expect(() => pool.requireOn()).toThrow(/off/);
    // Off when never on: nothing to remove, nothing created.
    expect((await pool.setOn(false)).every((r) => !r.changed)).toBe(true);
    await pool.setOn(true);
    expect(() => pool.requireOn()).not.toThrow();
    // A token the store can't give back right now: once the listener's copy has aged
    // out, the settings read as stale, not current.
    rmSync(poolSecretsFile(env));
    expect(pool.status().settings.map((s) => s.state)).toEqual(["current", "current"]);
    now += 6_000;
    expect(pool.status().settings.map((s) => s.state)).toEqual(["stale", "stale"]);
  });
  it("runs with the defaults: core's adapter, this process's env and clock, no log", async () => {
    const pool = openPool({});
    pools.push(pool);
    expect(pool.helloPool()).toEqual({ on: false, harness: "claude-code", accounts: [] });
    expect(pool.beginLogin().url).toMatch(/^https:\/\/claude\.com\//);
    await pool.setOn(true);
    const { port } = await pool.start();
    const file = path.join(process.env.CLAUDE_CONFIG_DIR as string, "settings.json");
    expect(JSON.parse(readFileSync(file, "utf8")).env.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:${port}`);
    await pool.setOn(false);
    expect(existsSync(file)).toBe(false);
    await pool.stop();
  });
  it("secrets go to the keychain when this machine has one, and pool.json says so", async () => {
    env.SESSIONPIPE_SECRETS = "keychain";
    const items = new Map<string, string>();
    const run: Runner = (_c, args, input) => {
      if (args[0] === "find-generic-password")
        return items.has(args[4]!) ? { status: 0, stdout: items.get(args[4]!)! } : { status: 44, stdout: "" };
      if (args[0] === "delete-generic-password") items.delete(args[4]!);
      if (args[0] === "-i") {
        const m = /-a "([^"]+)".* -w "([^"]+)"/.exec(input!)!;
        items.set(m[1]!, m[2]!);
      }
      return { status: 0, stdout: "" };
    };
    const pool = open({ run });
    const a = await signIn(pool, "one");
    expect(readPool(env).secrets_in).toBe("keychain");
    expect(existsSync(poolSecretsFile(env))).toBe(false);
    expect(items.has(`pool:${a.id}`)).toBe(true);
    pool.remove(a.id);
    expect(items.has(`pool:${a.id}`)).toBe(false);
  });
});

describe("managing accounts", () => {
  it("find by id, uuid, email or label; enable, disable, order, remove; unknown refs refused", async () => {
    const pool = open();
    const one = await signIn(pool, "one");
    const two = await signIn(pool, "two");
    const three = await signIn(pool, "three");
    writeFileSync(
      poolFile(env),
      readFileSync(poolFile(env), "utf8").replace('"email": "two@x.y"', '"label": "Work",\n      "email": "two@x.y"'),
    );
    const p2 = open();
    expect(p2.find(two.id)?.label).toBe("Work");
    expect(p2.find("Work")?.id).toBe(two.id);
    expect(p2.find(uuidOf("three"))?.id).toBe(three.id);
    expect(p2.find("one@x.y")?.id).toBe(one.id);
    expect(() => p2.disable("nobody")).toThrow(PoolError);
    expect(p2.disable("one@x.y").enabled).toBe(false);
    expect(readPool(env).accounts[0]?.enabled).toBe(false);
    expect(p2.helloPool().accounts.map((a) => [a.status, a.current, a.label])).toEqual([
      ["disabled", false, undefined],
      ["ready", true, "Work"],
      ["ready", false, undefined],
    ]);
    const before = adapter.calls.usage;
    expect(p2.enable(one.id).enabled).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    expect(adapter.calls.usage).toBe(before + 1);
    expect(p2.order([three.id, "Work", "one@x.y"]).map((a) => a.id)).toEqual([three.id, two.id, one.id]);
    expect(readPool(env).accounts.map((a) => a.id)).toEqual([three.id, two.id, one.id]);
    expect(() => p2.order([three.id, two.id])).toThrow(/every pooled account once/);
    expect(() => p2.order([three.id, two.id, two.id])).toThrow(PoolError);
    expect(() => p2.order([three.id, two.id, "ghost"])).toThrow(/ghost/);
    expect(p2.remove("Work")).toEqual({ ...two, label: "Work" });
    expect(p2.accounts().map((a) => a.id)).toEqual([three.id, one.id]);
    expect(JSON.parse(readFileSync(poolSecretsFile(env), "utf8"))[`pool:${two.id}`]).toBeUndefined();
    expect(() => p2.remove(two.id)).toThrow(`no pooled account is ${two.id}`);
  });
  it("refresh reads usage now, for one account or every enabled one; a failed poll is logged", async () => {
    const pool = open();
    const one = await signIn(pool, "one");
    const two = await signIn(pool, "two");
    pool.disable(two.id);
    adapter.usage = async () => usage(3);
    const n = adapter.calls.usage;
    await pool.refresh();
    expect(adapter.calls.usage).toBe(n + 1);
    await pool.refresh(two.id);
    expect(adapter.calls.usage).toBe(n + 2);
    await expect(pool.refresh("nobody")).rejects.toMatchObject({ code: "pool_account" });
    adapter.usage = async () => {
      throw new Error("usage 500");
    };
    await pool.refresh(one.id);
    expect(logs).toContain(`${one.id}: usage poll failed — usage 500`);
    adapter.usage = async () => {
      throw "usage string";
    };
    await pool.refresh(one.id);
    expect(logs).toContain(`${one.id}: usage poll failed — usage string`);
    adapter.usage = async () => null;
    await pool.refresh(one.id);
    expect(pool.status().accounts[0]?.used_percent).toBe(3);
  });
  it("a credential the vendor no longer accepts puts the account in error, once, with a hello", async () => {
    const pool = open();
    const one = await signIn(pool, "one");
    adapter.refresh = async () => {
      throw new FakeAuthError("revoked");
    };
    now = T0 + 3_600_000;
    const c = changes;
    await pool.refresh(one.id);
    expect(pool.status().accounts[0]).toMatchObject({ status: "error", limited_by: "error" });
    expect(changes).toBe(c + 1);
    await pool.refresh(one.id);
    expect(changes).toBe(c + 1);
    // An unreadable credential changes nothing.
    rmSync(poolSecretsFile(env));
    adapter.refresh = async (c, t) => ({ ...c, expires_at: t + 3_600_000 });
    const two = await signIn(pool, "two");
    const p2 = open();
    rmSync(poolSecretsFile(env));
    await p2.refresh(two.id);
    expect(p2.status().accounts[1]?.status).toBe("ready");
  });
});

describe("on and off", () => {
  it("on reserves a port, writes the env block in every Claude Code settings.json and remembers what it created; off removes it", async () => {
    mkdirSync(dirs()[1]!, { recursive: true });
    writeFileSync(settings(1), '{\n\t"model": "opus"\n}\n');
    const pool = open();
    const reports = await pool.setOn(true);
    const port = readPool(env).port;
    expect(port).toBeGreaterThan(0);
    expect(reports).toEqual([
      { file: settings(0), changed: true, created: true },
      { file: settings(1), changed: true, created: false },
    ]);
    const token = JSON.parse(readFileSync(poolSecretsFile(env), "utf8"))["pool:token"];
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.parse(readFileSync(settings(0), "utf8")).env).toEqual({
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      ANTHROPIC_AUTH_TOKEN: token,
      _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1",
    });
    expect(readPool(env)).toMatchObject({ on: true, port, created: [settings(0)] });
    expect(pool.status().settings.map((s) => s.state)).toEqual(["current", "current"]);
    expect(pool.helloPool().on).toBe(true);
    // On again: the same port, a fresh bearer (SECURITY H1), nothing created twice.
    expect((await pool.setOn(true)).every((r) => r.changed)).toBe(true);
    const token2 = JSON.parse(readFileSync(poolSecretsFile(env), "utf8"))["pool:token"];
    expect(token2).not.toBe(token);
    expect(JSON.parse(readFileSync(settings(1), "utf8")).env.ANTHROPIC_AUTH_TOKEN).toBe(token2);
    expect(readPool(env)).toMatchObject({ port, created: [settings(0)] });
    expect(await pool.setOn(false)).toEqual([
      { file: settings(0), changed: true, note: "removed (sessionpipe created it)" },
      { file: settings(1), changed: true },
    ]);
    expect(existsSync(settings(0))).toBe(false);
    expect(readFileSync(settings(1), "utf8")).toBe('{\n\t"model": "opus"\n}\n');
    expect(readPool(env)).toEqual({ on: false, port, accounts: [] });
    expect(pool.status().settings.map((s) => s.state)).toEqual(["missing", "missing"]);
    expect(changes).toBe(3);
  });
});

describe("the listener", () => {
  function upstream(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
    const s = http.createServer(handler);
    return new Promise((r) =>
      s.listen(0, "127.0.0.1", () =>
        r({
          url: `http://127.0.0.1:${(s.address() as net.AddressInfo).port}`,
          close: () => new Promise((d) => s.close(() => d())),
        }),
      ),
    );
  }
  it("starts on a free port the first time, remembers it, rewrites settings when it moves, and serves a request end to end", {
    timeout: 15_000,
  }, async () => {
    const seen: string[] = [];
    const up = await upstream((req, res) => {
      seen.push(req.headers.authorization!);
      res.writeHead(200, {
        "anthropic-ratelimit-unified-5h-utilization": "0.25",
        "anthropic-ratelimit-unified-status": "allowed",
      });
      res.end('{"id":"msg"}');
    });
    try {
      const pool = open({ upstream: up.url });
      const one = await signIn(pool, "one");
      await pool.setOn(true);
      const port = readPool(env).port;
      const first = await pool.start();
      expect(first).toEqual({ port, moved: false });
      expect(await pool.start()).toEqual({ port, moved: false });
      expect(pool.status().listening).toBe(true);
      const token = JSON.parse(readFileSync(poolSecretsFile(env), "utf8"))["pool:token"];
      const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body("aaaaaaaa-0000-4000-8000-000000000001"),
      });
      expect(r.status).toBe(200);
      // A second request inside the same second rides on the pending write.
      expect(
        (
          await fetch(`http://127.0.0.1:${port}/v1/messages`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: body("aaaaaaaa-0000-4000-8000-000000000002"),
          })
        ).status,
      ).toBe(200);
      expect(seen).toEqual(["Bearer access-one", "Bearer access-one"]);
      expect(limits.at(-1)).toEqual({
        uuid: uuidOf("one"),
        session: "aaaaaaaa-0000-4000-8000-000000000001",
        limits: { status: "allowed", windows: [{ id: "five_hour", used_percent: 25 }], observed_at: T0 },
      });
      // state.json lags the pin by a second at most, and never past stop() (SECURITY M4).
      expect(readPoolState(env).pins).toEqual({});
      await new Promise((r) => setTimeout(r, 1_100));
      expect(Object.keys(readPoolState(env).pins).length).toBe(2);
      // A third one, then stop() before the second has passed: flushed, not lost.
      await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body("aaaaaaaa-0000-4000-8000-000000000003"),
      });
      const health = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as { accounts_with_room: number };
      expect(health.accounts_with_room).toBe(1);
      await pool.stop();
      expect(Object.keys(readPoolState(env).pins).length).toBe(3);
      expect(pool.status().listening).toBe(false);
      // The port is taken when the next daemon starts: it moves and settings follow.
      // A squatter that reads (a paused socket never sees the probe hang up).
      const squatter = net.createServer((sock) => sock.resume());
      await new Promise<void>((r) => squatter.listen(readPool(env).port, "127.0.0.1", () => r()));
      try {
        const p2 = open({ upstream: up.url });
        const second = await p2.start();
        expect(second.moved).toBe(true);
        expect(second.port).not.toBe(port);
        expect(readPool(env)).toMatchObject({ port: second.port, last_port: port });
        expect(JSON.parse(readFileSync(settings(0), "utf8")).env.ANTHROPIC_BASE_URL).toBe(
          `http://127.0.0.1:${second.port}`,
        );
        expect(logs).toContain(`the listener moved to port ${second.port}; settings.json rewritten`);
        expect(readPoolState(env).pins[`aaaaaaaa-0000-4000-8000-000000000001`]?.account).toBe(one.id);
      } finally {
        await new Promise<void>((r) => squatter.close(() => r()));
      }
    } finally {
      await up.close();
    }
  });
  it("F1: a second daemon on the same pool.json stands down when a pool already answers on the port", async () => {
    const pool = open();
    await signIn(pool, "one");
    await pool.setOn(true);
    const { port } = await pool.start();
    const settingsBefore = readFileSync(settings(0), "utf8");
    const second = open();
    expect(await second.start()).toEqual({ port, moved: false, other: true });
    expect(second.status()).toMatchObject({ listening: false, another_daemon: true, port });
    expect(readPool(env).port).toBe(port);
    expect(readFileSync(settings(0), "utf8")).toBe(settingsBefore);
    expect(logs).toContain(`another daemon already serves the pool on 127.0.0.1:${port}; this one won't listen`);
    await second.stop();
    await pool.stop();
    // The first gone: the next one takes the port as usual.
    const third = open();
    expect(await third.start()).toEqual({ port, moved: false });
    expect(third.status().another_daemon).toBeUndefined();
    await third.stop();
    // Something on the port that is not a pool (a 404, then one that never answers): the
    // probe says no and the listener goes on as before; the hang gives up after half a second.
    const squatter = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end("not a pool");
    });
    await new Promise<void>((r) => squatter.listen(readPool(env).port, "127.0.0.1", () => r()));
    try {
      const fourth = open();
      expect((await fourth.start()).other).toBeUndefined();
      await fourth.stop();
    } finally {
      squatter.closeAllConnections();
      await new Promise<void>((r) => squatter.close(() => r()));
    }
    const hanger = http.createServer(() => {});
    await new Promise<void>((r) => hanger.listen(readPool(env).port, "127.0.0.1", () => r()));
    try {
      const fifth = open();
      const t = Date.now();
      expect((await fifth.start()).other).toBeUndefined();
      expect(Date.now() - t).toBeLessThan(3_000);
      await fifth.stop();
    } finally {
      hanger.closeAllConnections();
      await new Promise<void>((r) => hanger.close(() => r()));
    }
    const liar = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end("ok but not json");
    });
    await new Promise<void>((r) => liar.listen(readPool(env).port, "127.0.0.1", () => r()));
    try {
      const sixth = open();
      expect((await sixth.start()).other).toBeUndefined();
      await sixth.stop();
    } finally {
      liar.closeAllConnections();
      await new Promise<void>((r) => liar.close(() => r()));
    }
  });
  it("F10: while the secrets file can't be read the listener says so with a 503, and status reads unreadable, not stale", async () => {
    if (process.platform === "win32") return;
    const pool = open();
    await signIn(pool, "one");
    await pool.setOn(true);
    const { port } = await pool.start();
    const token = JSON.parse(readFileSync(poolSecretsFile(env), "utf8"))["pool:token"];
    chmodSync(poolSecretsFile(env), 0o000);
    now += 6_000;
    const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body("aaaaaaaa-0000-4000-8000-000000000001"),
    });
    expect(r.status).toBe(503);
    expect(((await r.json()) as { error: { message: string } }).error.message).toMatch(/secrets can't be read/);
    expect(pool.status().settings.map((s) => s.state)).toEqual(["stale", "stale"]);
    chmodSync(poolSecretsFile(env), 0o600);
    now += 6_000;
    expect(pool.status().settings.map((s) => s.state)).toEqual(["current", "current"]);
    await pool.stop();
  });
  it("N1: with a test upstream every vendor call goes there, the OAuth endpoints included", async () => {
    const asked: string[] = [];
    const up = await upstream((req, res) => {
      asked.push(req.url as string);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ five_hour: { utilization: 7 } }));
    });
    try {
      const seen: string[] = [];
      const spy: typeof fetch = (input, init) => {
        seen.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        return globalThis.fetch(input, init);
      };
      adapter.POOL_ENDPOINTS = {
        api: "https://api.anthropic.com",
        token: "https://platform.claude.com/v1/oauth/token",
        profile: "https://api.anthropic.com/api/oauth/profile",
        usage: "https://api.anthropic.com/api/oauth/usage",
      };
      adapter.usage = async (_a, _n, f) => {
        await f("https://api.anthropic.com/api/oauth/usage?x=1");
        await f(new URL("https://platform.claude.com/v1/oauth/token"));
        await f(new Request("https://api.anthropic.com/api/oauth/profile", { method: "POST" }));
        await f(`${up.url}/elsewhere`);
        return usage(7);
      };
      const pool = open({ upstream: up.url, fetch: spy });
      await signIn(pool, "one");
      expect(asked).toEqual(["/api/oauth/usage?x=1", "/v1/oauth/token", "/api/oauth/profile", "/elsewhere"]);
      expect(seen).toEqual([
        `${up.url}/api/oauth/usage?x=1`,
        `${up.url}/v1/oauth/token`,
        `${up.url}/api/oauth/profile`,
        `${up.url}/elsewhere`,
      ]);
      expect(vendorOrigins(adapter)).toEqual(["https://api.anthropic.com", "https://platform.claude.com"]);
      expect(vendorOrigins({ POOL_ENDPOINTS: { api: "http://upstream.invalid" } })).toEqual([
        "http://upstream.invalid",
      ]);
      // Without a test upstream the fetch is handed over as it is.
      const direct = open({ fetch: spy });
      seen.length = 0;
      adapter.usage = async (_a, _n, f) => {
        await f(`${up.url}/direct`);
        return null;
      };
      await direct.refresh(); // "one" is in this dir already
      expect(seen).toEqual([`${up.url}/direct`]);
      await signIn(direct, "two");
      expect(seen).toEqual([`${up.url}/direct`, `${up.url}/direct`]);
    } finally {
      await up.close();
    }
  });
  it("with the pool off a moved port rewrites nothing, and nothing is polled (SECURITY M2)", async () => {
    const pool = open({ pollMs: 20 });
    await signIn(pool, "one");
    const n = adapter.calls.usage;
    const { moved } = await pool.start();
    expect(moved).toBe(true);
    expect(existsSync(settings(0))).toBe(false);
    expect(logs.some((l) => /settings\.json rewritten/.test(l))).toBe(false);
    await new Promise((r) => setTimeout(r, 60));
    expect(adapter.calls.usage).toBe(n);
    await pool.setOn(true);
    expect(readPool(env).port).toBe((await pool.start()).port);
    now = T0 + 60_000;
    await new Promise((r) => setTimeout(r, 60));
    expect(adapter.calls.usage).toBeGreaterThan(n);
  });
  it("polls idle accounts on the interval, not the ones with fresh numbers, and drops stale pins", async () => {
    const pool = open({ pollMs: 25 });
    const one = await signIn(pool, "one");
    const two = await signIn(pool, "two");
    pool.disable(two.id);
    await pool.setOn(true);
    const n = adapter.calls.usage;
    adapter.usage = async () => usage(50);
    await pool.stop();
    writeFileSync(
      poolStateFile(env),
      JSON.stringify({ ...readPoolState(env), pins: { s1: { account: one.id, used: T0 - 29 * 60_000 } } }),
    );
    const p2 = open({ pollMs: 25 });
    await p2.setOn(true);
    await p2.start();
    await new Promise((r) => setTimeout(r, 40));
    expect(adapter.calls.usage).toBe(n + 1);
    expect(readPoolState(env).pins).toEqual({ s1: { account: one.id, used: T0 - 29 * 60_000 } });
    now = T0 + 2 * 60_000;
    await new Promise((r) => setTimeout(r, 40));
    expect(adapter.calls.usage).toBe(n + 2);
    expect(readPoolState(env).pins).toEqual({});
    await p2.stop();
  });
});
