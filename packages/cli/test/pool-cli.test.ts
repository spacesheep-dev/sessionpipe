// SPDX-License-Identifier: Apache-2.0
// `sessionpipe pool …` at the terminal, and the request mapper the daemon shares with
// it (control/pool.ts): every action against the real façade with a fake vendor
// adapter when no daemon answers, and against a scripted daemon answer when one does;
// what each prints, what a refusal says, and how the pasted code is read.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalReply, LocalRequest } from "../src/control/local.js";
import { poolRequestOf, runPoolRequest } from "../src/control/pool.js";
import {
  cliPath,
  type PoolCliDeps,
  poolMain,
  poolOffForUninstall,
  readSecret,
  type SecretInput,
} from "../src/pool/cli.js";
import { openPool, type Pool, type PoolStatus, summaryLine } from "../src/pool/index.js";
import { readPool } from "../src/pool/store.js";
import type { PoolLimits } from "../src/pool/types.js";
import { credential, type FakeAdapter, fakeAdapter, uuidOf } from "./helpers/pool-fake.js";

const T0 = Date.parse("2026-10-29T10:00:00Z");
let tmp: string;
let env: NodeJS.ProcessEnv;
let adapter: FakeAdapter;
let now: number;
let pools: Pool[];
let lines: string[];
let asked: LocalRequest[];
let answer: LocalReply | null;
let installed: number;
let secret: string;
const out = (s = "") => void lines.push(s);
const dirs = () => [path.join(tmp, ".claude")];
const settings = () => path.join(tmp, ".claude", "settings.json");

function open(over: Partial<Parameters<typeof openPool>[0]> = {}): Pool {
  const p = openPool({ adapter, now: () => now, env, claudeDirs: dirs, random: () => Buffer.from("st4te"), ...over });
  pools.push(p);
  return p;
}
const deps = (over: Partial<PoolCliDeps> = {}): Partial<PoolCliDeps> => ({
  ask: async (req) => {
    asked.push(req);
    return answer;
  },
  open: () => open(),
  installService: () => {
    installed++;
    return "launchd agent org.sessionpipe.control (log: /x/daemon.log)";
  },
  readSecret: async () => secret,
  now: () => now,
  ...over,
});
const run = (argv: string[], over: Partial<PoolCliDeps> = {}) => poolMain(["pool", ...argv], out, "/dist", deps(over));
const usage = (five: number, seven = 40): PoolLimits => ({
  windows: [
    { id: "five_hour", used_percent: five, resets_at: new Date(T0 + 3_600_000).toISOString(), window_minutes: 300 },
    { id: "seven_day", used_percent: seven, resets_at: new Date(T0 + 4 * 86_400_000).toISOString() },
  ],
});

/** Three accounts in the pool, by sign-in, with usage: Fiction has room, Misha is limited. */
async function three(pool: Pool, used: Record<string, number> = { fiction: 12, misha: 99, sheep: 50 }) {
  for (const [name, email, label] of [
    ["fiction", "a@fiction.tribe", "Fiction"],
    ["misha", "m@x.y", "Misha"],
    ["sheep", "s@spacesheep.dev", "Sheep"],
  ] as const) {
    adapter.usage = async () => usage(used[name] as number);
    adapter.logins.set(name, {
      credential: credential(name, 3_600_000, T0),
      profile: { account_uuid: uuidOf(name), email },
    });
    const { id } = pool.beginLogin();
    const a = await pool.completeLogin(`${name}#st4te`, id);
    a.label = label;
  }
  pool.order(pool.accounts().map((a) => a.id));
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sp-pool-cli-")));
  mkdirSync(path.join(tmp, ".claude"));
  writeFileSync(settings(), "{}\n");
  env = {
    SESSIONPIPE_CONFIG: path.join(tmp, "config", "config.json"),
    SESSIONPIPE_STATE: path.join(tmp, "state"),
    SESSIONPIPE_SECRETS: "file",
  };
  adapter = fakeAdapter();
  now = T0;
  pools = [];
  lines = [];
  asked = [];
  answer = null;
  installed = 0;
  secret = "";
});
afterEach(async () => {
  for (const p of pools) await p.stop();
  rmSync(tmp, { recursive: true, force: true });
});

describe("summaryLine", () => {
  it("off and empty, then on with accounts, room and the one serving", async () => {
    const pool = open();
    expect(summaryLine(pool.status())).toBe("off · 0 accounts");
    await three(pool);
    expect(summaryLine(pool.status())).toBe("off · 3 accounts · 2 with room · serving Fiction");
    await pool.setOn(true);
    pool.disable("Fiction");
    expect(summaryLine(pool.status())).toBe("on · 3 accounts · 1 with room · serving Sheep");
    pool.remove("Fiction");
    pool.remove("Sheep");
    expect(summaryLine(pool.status())).toBe("on · 1 account · 0 with room");
  });
});

describe("runPoolRequest: the mapping the daemon and the CLI share", () => {
  it("no pool: unsupported; an unknown action: refused bad_fields", async () => {
    expect(await runPoolRequest(undefined, { action: "on" })).toEqual({
      outcome: "unsupported",
      detail: "this machine can't pool: its daemon runs without the pool",
    });
    const pool = open();
    expect(await runPoolRequest(pool, { action: "dance" as "on" })).toMatchObject({
      outcome: "refused",
      code: "bad_fields",
    });
  });

  it("every action delivered, with the summary line as detail", async () => {
    const pool = open();
    await three(pool);
    const ids = pool.accounts().map((a) => a.id);
    const on = await runPoolRequest(pool, { action: "on" });
    expect(on).toMatchObject({ outcome: "delivered", detail: "on · 3 accounts · 2 with room · serving Fiction" });
    expect(await runPoolRequest(pool, { action: "disable", account: ids[0]! })).toMatchObject({
      detail: "on · 3 accounts · 1 with room · serving Sheep",
    });
    expect(await runPoolRequest(pool, { action: "enable", account: ids[0]! })).toMatchObject({
      detail: "on · 3 accounts · 2 with room · serving Fiction",
    });
    expect(await runPoolRequest(pool, { action: "order", order: [ids[2]!, ids[0]!, ids[1]!] })).toMatchObject({
      detail: "on · 3 accounts · 2 with room · serving Sheep",
    });
    adapter.usage = async () => usage(5, 5);
    expect(await runPoolRequest(pool, { action: "refresh", account: "m@x.y" })).toMatchObject({
      detail: "on · 3 accounts · 3 with room · serving Sheep",
    });
    expect(await runPoolRequest(pool, { action: "refresh" })).toMatchObject({ outcome: "delivered" });
    expect(await runPoolRequest(pool, { action: "remove", account: "Misha" })).toMatchObject({
      detail: "on · 2 accounts · 2 with room · serving Sheep",
    });
    expect(await runPoolRequest(pool, { action: "status" })).toMatchObject({
      outcome: "delivered",
      status: { on: true },
    });
    expect(await runPoolRequest(pool, { action: "off" })).toMatchObject({
      detail: "off · 2 accounts · 2 with room · serving Sheep",
    });
  });

  it("login.begin answers the pending id and the URL; login.complete adds the account at the end", async () => {
    const pool = open();
    await pool.setOn(true);
    const b = await runPoolRequest(pool, { action: "login.begin" });
    expect(b).toMatchObject({
      outcome: "delivered",
      detail: expect.stringMatching(/^[A-Za-z0-9_-]+ https:\/\/claude\.ai\/oauth\/authorize\?state=st4te$/),
    });
    const id = (b as { detail: string }).detail.split(" ")[0]!;
    adapter.logins.set("new", {
      credential: credential("new"),
      profile: { account_uuid: uuidOf("new"), email: "n@x.y" },
    });
    expect(await runPoolRequest(pool, { action: "login.complete", account: id, code: "new#st4te" })).toMatchObject({
      detail: "on · 1 account · 1 with room · serving n@x.y",
    });
  });

  it("refused: an unknown account, an incomplete order, and the vendor calls while off (for a receiver, not the terminal)", async () => {
    const pool = open();
    await three(pool);
    expect(await runPoolRequest(pool, { action: "enable", account: "nobody" })).toMatchObject({
      outcome: "refused",
      code: "pool_account",
      detail: "no pooled account is nobody",
      status: { on: false },
    });
    expect(await runPoolRequest(pool, { action: "order", order: [pool.accounts()[0]!.id] })).toMatchObject({
      outcome: "refused",
      code: "pool_order",
    });
    expect(await runPoolRequest(pool, { action: "order" })).toMatchObject({ outcome: "refused", code: "pool_order" });
    for (const action of ["refresh", "login.begin", "login.complete"] as const)
      expect(await runPoolRequest(pool, { action, account: "x", code: "c#s" })).toMatchObject({
        outcome: "refused",
        code: "pool_off",
      });
    expect(await runPoolRequest(pool, { action: "login.begin" }, { terminal: true })).toMatchObject({
      outcome: "delivered",
    });
    expect(await runPoolRequest(pool, { action: "import" })).toMatchObject({ outcome: "refused", code: "bad_fields" });
  });

  it("failed: the vendor refuses the code (login), the sign-in ran out (login), anything else (pool)", async () => {
    const pool = open();
    await pool.setOn(true);
    const { id } = pool.beginLogin();
    expect(await runPoolRequest(pool, { action: "login.complete", account: id, code: "bogus#st4te" })).toMatchObject({
      outcome: "failed",
      code: "login",
      detail: "bad code",
    });
    expect(await runPoolRequest(pool, { action: "login.complete", account: "other", code: "x#st4te" })).toMatchObject({
      outcome: "refused",
      code: "pool_account",
    });
    now += 11 * 60_000;
    expect(await runPoolRequest(pool, { action: "login.complete", account: id, code: "x#st4te" })).toMatchObject({
      outcome: "failed",
      code: "login",
      detail: "the sign-in took longer than 10 minutes; begin again",
    });
    const broken = { ...pool, refresh: async () => Promise.reject(new Error("disk full")) } as Pool;
    expect(await runPoolRequest(broken, { action: "refresh" })).toMatchObject({
      outcome: "failed",
      code: "pool",
      detail: "disk full",
    });
    const odd = { ...pool, refresh: async () => Promise.reject("no words") } as Pool;
    expect(await runPoolRequest(odd, { action: "refresh" })).toMatchObject({ outcome: "failed", detail: "no words" });
  });

  it("import: what was added and skipped, without the credentials", async () => {
    const pool = open();
    adapter.importable = [
      { dir: "/h/.claude", credential: credential("imp"), account_uuid: uuidOf("imp"), email: "i@x.y", source: "file" },
    ];
    const r = await runPoolRequest(pool, { action: "import" }, { terminal: true });
    expect(r).toMatchObject({
      outcome: "delivered",
      imported: { added: [{ account: { email: "i@x.y" }, dir: "/h/.claude" }], skipped: [] },
    });
    expect(JSON.stringify(r)).not.toMatch(/access-|refresh-/);
  });

  it("poolRequestOf takes a command's pool fields and nothing else", () => {
    expect(
      poolRequestOf({
        kind: "pool",
        session: "sessionpipe:pool",
        pool_action: "order",
        pool_order: ["a", "b"],
        nonce: "n",
        iat: 1,
        machine: "m",
      } as never),
    ).toEqual({ action: "order", order: ["a", "b"] });
    expect(poolRequestOf({ pool_action: "login.complete", pool_account: "p", pool_code: "c#s" } as never)).toEqual({
      action: "login.complete",
      account: "p",
      code: "c#s",
    });
    expect(poolRequestOf({ pool_action: "on" } as never)).toEqual({ action: "on" });
  });
});

describe("sessionpipe pool, with no daemon running", () => {
  it("status: empty, off", async () => {
    await run([]);
    expect(lines).toEqual([
      "  pool:     off · 0 accounts",
      "  daemon:   not running (nothing needs it while the pool is off)",
      "  no accounts: `sessionpipe pool add --import` or `sessionpipe pool add --login`",
    ]);
  });

  it("status: three accounts in order, each with its windows, resets and standing; the settings files", async () => {
    const pool = open();
    await three(pool);
    pool.disable("Sheep");
    await pool.setOn(true);
    await run(["status"], { open: () => pool });
    expect(lines).toEqual([
      "  pool:     on · 3 accounts · 1 with room · serving Fiction",
      "  ! the daemon isn't running, so Claude Code can't reach Claude while the pool is on: `sessionpipe control run` (or `sessionpipe pool on` again to install the service)",
      `  ${pool.accounts()[0]!.id}  Fiction <a@fiction.tribe>            enabled   5h  12% (resets ${clock(T0 + 3_600_000)})   7d  40% (resets ${day(T0 + 4 * 86_400_000)})   serving now`,
      `  ${pool.accounts()[1]!.id}  Misha <m@x.y>                        enabled   5h  99% (resets ${clock(T0 + 3_600_000)})   7d  40% (resets ${day(T0 + 4 * 86_400_000)})   none left until ${clock(T0 + 3_600_000)}`,
      `  ${pool.accounts()[2]!.id}  Sheep <s@spacesheep.dev>             disabled  5h  50% (resets ${clock(T0 + 3_600_000)})   7d  40% (resets ${day(T0 + 4 * 86_400_000)})   off`,
      `  settings  ${settings().replace(os.homedir(), "~").padEnd(44)} current`,
    ]);
    lines = [];
    await run(["--json"], { open: () => pool });
    const j = JSON.parse(lines.join("\n")) as PoolStatus & { daemon: boolean };
    expect(j).toMatchObject({ on: true, daemon: false });
    expect(j.accounts[0]).toMatchObject({ label: "Fiction", status: "ready", current: true });
    expect(JSON.stringify(j)).not.toMatch(/access-|refresh-/);
  });

  it("status words: an account in error, one with no numbers yet, and a pending sign-in", async () => {
    const pool = open();
    adapter.logins.set("one", {
      credential: credential("one"),
      profile: { account_uuid: uuidOf("one"), email: "o@x.y" },
    });
    await pool.completeLogin("one#st4te", pool.beginLogin().id);
    adapter.refresh = async () => {
      throw new adapter.PoolAuthError("expired");
    };
    now += 3_600_000;
    await pool.refresh();
    pool.beginLogin();
    await run(["status"], { open: () => pool });
    expect(lines[2]).toMatch(/o@x\.y\s+enabled\s+5h —\s+7d —\s+sign in again$/);
    expect(lines.at(-1)).toBe(
      `  sign-in pending until ${clock(now + 600_000)}: paste the code to \`sessionpipe pool add --login --code -\``,
    );
  });

  it("on: writes the env block, says what Claude Code does, installs the service, and warns when there is no account", async () => {
    await run(["on"]);
    expect(lines).toEqual([
      `  ✓ ${settings().replace(os.homedir(), "~")}: env block written (ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN and the flag that keeps its first-party features on)`,
      "  New Claude Code sessions use the pool with the new token; running ones keep working for 10 minutes.",
      "  No accounts yet: `sessionpipe pool add --import` copies this machine's Claude Code logins.",
      "  Daemon: launchd agent org.sessionpipe.control (log: /x/daemon.log)",
      "  pool:     on · 0 accounts",
    ]);
    expect(installed).toBe(1);
    expect(readPool(env).on).toBe(true);
    const j = JSON.parse(readFileSync(settings(), "utf8")) as { env: Record<string, string> };
    expect(j.env.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:${readPool(env).port}`);
  });

  it("on, with three accounts: the first line of the settings and the summary", async () => {
    const pool = open();
    await three(pool);
    await run(["on"], { open: () => pool });
    expect(lines.at(-1)).toBe("  pool:     on · 3 accounts · 2 with room · serving Fiction");
    expect(lines).not.toContain(
      "  No accounts yet: `sessionpipe pool add --import` copies this machine's Claude Code logins.",
    );
  });

  it("off: removes the block and says Claude Code talks to Claude directly again", async () => {
    const pool = open();
    await pool.setOn(true);
    await run(["off"], { open: () => pool });
    expect(lines).toEqual([
      `  ✓ ${settings().replace(os.homedir(), "~")}: the pool's env block is gone`,
      "  Claude Code talks to Claude directly from its next start; the accounts stay pooled.",
      "  pool:     off · 0 accounts",
    ]);
    expect(installed).toBe(0);
    expect(JSON.parse(readFileSync(settings(), "utf8"))).toEqual({});
  });

  it("off: a settings file someone else points elsewhere is left alone and said so", async () => {
    const pool = open();
    await pool.setOn(true);
    writeFileSync(settings(), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://proxy.example" } }));
    await run(["off"], { open: () => pool });
    expect(lines[0]).toBe(
      `  ! ${settings().replace(os.homedir(), "~")}: left alone — ANTHROPIC_BASE_URL is https://proxy.example`,
    );
  });

  it("add --import: each login added or skipped, then the summary and the daemon line", async () => {
    adapter.importable = [
      {
        dir: path.join(tmp, ".claude"),
        credential: credential("imp"),
        account_uuid: uuidOf("imp"),
        email: "i@x.y",
        source: "file",
      },
      {
        dir: path.join(tmp, ".claude-work"),
        credential: credential("imp"),
        account_uuid: uuidOf("imp"),
        email: "i@x.y",
        source: "file",
      },
    ];
    await run(["add", "--import"]);
    expect(lines).toEqual([
      `  ✓ added i@x.y (${readPool(env).accounts[0]!.id}) from ${path.join(tmp, ".claude").replace(os.homedir(), "~")}`,
      `  · ${path.join(tmp, ".claude-work").replace(os.homedir(), "~")} (i@x.y): same account as another dir`,
      "  pool:     off · 1 account · 1 with room · serving i@x.y",
      "  daemon:   not running (nothing needs it while the pool is off)",
    ]);
    lines = [];
    adapter.importable = [];
    await run(["add", "--import"]);
    expect(lines[0]).toBe("  no Claude Code login found on this machine");
  });

  it("add --login: the URL and what to do next; --code - reads the code from stdin and finishes", async () => {
    const pool = open();
    await run(["add", "--login"], { open: () => pool });
    expect(lines).toEqual([
      "  Open this in a browser, sign in to the account to add, and copy the code it shows:",
      "  https://claude.ai/oauth/authorize?state=st4te",
      "  Then, within 10 minutes, paste it to:  sessionpipe pool add --login --code -",
    ]);
    lines = [];
    adapter.logins.set("new", {
      credential: credential("new"),
      profile: { account_uuid: uuidOf("new"), email: "n@x.y" },
    });
    secret = "new#st4te\n";
    await run(["add", "--login", "--code", "-"], { open: () => pool });
    expect(lines).toEqual([
      `  ✓ signed in n@x.y (${pool.accounts()[0]!.id})`,
      "  pool:     off · 1 account · 1 with room · serving n@x.y",
      "  daemon:   not running (nothing needs it while the pool is off)",
    ]);
  });

  it("add --login --code -: no pending sign-in, an empty paste, and a code the vendor refuses", async () => {
    const pool = open();
    await expect(run(["add", "--login", "--code", "-"], { open: () => pool })).rejects.toThrow(
      "no sign-in is pending; run `sessionpipe pool add --login` first",
    );
    pool.beginLogin();
    secret = " \n";
    await expect(run(["add", "--login", "--code", "-"], { open: () => pool })).rejects.toThrow("no code was pasted");
    secret = "nope#st4te";
    await expect(run(["add", "--login", "--code", "-"], { open: () => pool })).rejects.toThrow("bad code");
    await expect(run(["add"], { open: () => pool })).rejects.toThrow("pool add takes --import");
  });

  it("remove, enable, disable, order and refresh, by id, email or label; refusals are the command's error", async () => {
    const pool = open();
    await three(pool);
    const ids = pool.accounts().map((a) => a.id);
    await run(["disable", "Fiction"], { open: () => pool });
    expect(lines).toEqual(["  ✓ disabled Fiction", "  pool:     off · 3 accounts · 1 with room · serving Sheep"]);
    lines = [];
    await run(["enable", "a@fiction.tribe"], { open: () => pool });
    expect(lines).toEqual([
      "  ✓ enabled a@fiction.tribe",
      "  pool:     off · 3 accounts · 2 with room · serving Fiction",
    ]);
    lines = [];
    await run(["order", ids[2]!, ids[1]!, ids[0]!], { open: () => pool });
    expect(lines).toEqual([
      `  1. Sheep <s@spacesheep.dev> (${ids[2]})`,
      `  2. Misha <m@x.y> (${ids[1]})`,
      `  3. Fiction <a@fiction.tribe> (${ids[0]})`,
      "  pool:     off · 3 accounts · 2 with room · serving Sheep",
    ]);
    lines = [];
    adapter.usage = async () => usage(1, 1);
    await run(["refresh", "Misha"], { open: () => pool });
    expect(lines[0]).toBe("  pool:     off · 3 accounts · 3 with room · serving Sheep");
    lines = [];
    await run(["remove", ids[1]!], { open: () => pool });
    expect(lines).toEqual([`  ✓ removed ${ids[1]}`, "  pool:     off · 2 accounts · 2 with room · serving Sheep"]);
    await expect(run(["remove", "nobody"], { open: () => pool })).rejects.toThrow("no pooled account is nobody");
    await expect(run(["remove"], { open: () => pool })).rejects.toThrow("pool remove takes an account id or email");
    await expect(run(["order"], { open: () => pool })).rejects.toThrow("pool order takes every account");
    await expect(run(["order", ids[2]!], { open: () => pool })).rejects.toThrow(
      "the order must name every pooled account once",
    );
  });

  it("anything else prints the family's help", async () => {
    await run(["bogus"]);
    expect(lines[0]).toContain("sessionpipe pool [--json]");
    lines = [];
    await poolMain(["pool", "bogus"], out, "/dist");
    expect(lines[0]).toContain("sessionpipe pool [--json]");
  });
});

describe("sessionpipe pool, with the daemon running", () => {
  const status = (over: Partial<PoolStatus> = {}): PoolStatus => ({
    on: true,
    port: 51234,
    listening: true,
    in_flight: 0,
    settings: [{ file: path.join(tmp, ".claude", "settings.json"), state: "current" }],
    accounts: [],
    ...over,
  });

  it("every request goes over the socket, never to the engine in this process", async () => {
    answer = { op: "pool", outcome: "delivered", detail: "on · 0 accounts", status: status() };
    let opened = 0;
    const o = {
      open: () => {
        opened++;
        return open();
      },
    };
    await run(["status"], o);
    await run(["on"], o);
    await run(["off"], o);
    await run(["enable", "x"], o);
    await run(["order", "a", "b"], o);
    await run(["refresh"], o);
    expect(asked.map((r) => (r as { action: string }).action)).toEqual([
      "status",
      "on",
      "off",
      "enable",
      "order",
      "refresh",
    ]);
    expect(asked[4]).toMatchObject({ order: ["a", "b"] });
    expect(opened).toBe(0);
    expect(installed).toBe(0);
    expect(lines).toContain("  daemon:   running · listening on 127.0.0.1:51234");
    expect(lines).toContain("  Daemon: running · listening on 127.0.0.1:51234");
  });

  it("what the daemon reports about each settings file, and each window and standing, is worded", async () => {
    const acc = (over: Record<string, unknown>) => ({
      id: "acc1",
      email: "a@x.y",
      account_uuid: "u",
      enabled: true,
      added_at: "x",
      status: "ready",
      current: false,
      ...over,
    });
    answer = {
      op: "pool",
      outcome: "delivered",
      detail: "on",
      status: status({
        listening: false,
        settings: [
          { file: "/h/.claude/settings.json", state: "stale" },
          { file: "/h/.claude-a/settings.json", state: "missing" },
          { file: "/h/.claude-b/settings.json", state: "other", note: "ANTHROPIC_BASE_URL is https://p" },
          { file: "/h/.claude-c/settings.json", state: "unreadable", note: "not JSON" },
        ],
        accounts: [
          acc({ status: "limited", windows: [{ id: "five_hour", used_percent: 100 }] }),
          acc({ id: "acc2", windows: [{ id: "seven_day", used_percent: 3, resets_at: "not a date" }] }),
        ] as PoolStatus["accounts"],
      }),
    };
    await run(["on"]);
    expect(lines.slice(0, 5)).toEqual([
      "  ! /h/.claude/settings.json: an older block of ours; `pool on` rewrites it",
      "  ! /h/.claude-a/settings.json: no env block",
      "  ! /h/.claude-b/settings.json: left alone — ANTHROPIC_BASE_URL is https://p",
      "  ! /h/.claude-c/settings.json: not touched — not JSON",
      "  New Claude Code sessions use the pool with the new token; running ones keep working for 10 minutes.",
    ]);
    expect(lines).toContain("  Daemon: running");
    lines = [];
    await run(["status"]);
    const col = (...c: [string, number][]) => c.map(([t, w]) => t.padEnd(w)).join(" ");
    expect(lines[2]).toBe(
      `  ${col(["acc1", 9], ["a@x.y", 36], ["enabled", 9], ["5h 100%", 24], ["7d —", 30])} none left`,
    );
    expect(lines[3]).toBe(
      `  ${col(["acc2", 9], ["a@x.y", 36], ["enabled", 9], ["5h —", 24], ["7d   3%", 30])} has room`,
    );
    expect(lines.slice(4)).toEqual([
      "  settings  /h/.claude/settings.json                     stale",
      "  settings  /h/.claude-a/settings.json                   missing",
      "  settings  /h/.claude-b/settings.json                   other — ANTHROPIC_BASE_URL is https://p",
      "  settings  /h/.claude-c/settings.json                   unreadable — not JSON",
    ]);
    lines = [];
    await run(["add", "--import"], {
      ask: async () => ({ ...answer, imported: { added: [], skipped: [] } }) as LocalReply,
    });
    expect(lines.at(-1)).toBe("  daemon:   running · the pool's listener isn't up");
  });

  it("the pool is on but no daemon answers: every command ends with the warning", async () => {
    const pool = open();
    await pool.setOn(true);
    adapter.importable = [];
    await run(["add", "--import"], { open: () => pool });
    expect(lines.at(-1)).toMatch(
      /^ {2}! the daemon isn't running, so Claude Code can't reach Claude while the pool is on/,
    );
  });

  it("a listener that isn't up is said; a refusal from the daemon is the command's error", async () => {
    answer = { op: "pool", outcome: "delivered", detail: "on · 0 accounts", status: status({ listening: false }) };
    await run(["status"]);
    expect(lines[1]).toBe("  daemon:   running · the pool's listener isn't up");
    // Another daemon holds the pool's port: the one that answered says so instead.
    answer = {
      op: "pool",
      outcome: "delivered",
      detail: "on · 0 accounts",
      status: status({ listening: false, another_daemon: true }),
    };
    lines = [];
    await run(["status"]);
    expect(lines[1]).toBe("  daemon:   running · another daemon serves the pool on 127.0.0.1:51234");
    lines = [];
    await run(["on"]);
    expect(lines).toContain("  Daemon: running · another daemon serves the pool on 127.0.0.1:51234");
    answer = { op: "pool", outcome: "refused", code: "pool_account", detail: "no pooled account is x" };
    await expect(run(["remove", "x"])).rejects.toThrow("no pooled account is x");
  });

  it("add --import and --login --code - through the daemon", async () => {
    answer = {
      op: "pool",
      outcome: "delivered",
      detail: "on · 1 account",
      status: status(),
      imported: { added: [], skipped: [{ dir: "/h/.claude", why: "its token could not be read or refreshed" }] },
    };
    await run(["add", "--import"]);
    expect(lines[0]).toBe("  · /h/.claude: its token could not be read or refreshed");
    expect(asked[0]).toEqual({ op: "pool", action: "import" });
    lines = [];
    answer = {
      op: "pool",
      outcome: "delivered",
      detail: "on · 0 accounts",
      status: status({ pending: { id: "p1", url: "u", expires_at: "x" } }),
    };
    secret = "c#s";
    const seen: LocalRequest[] = [];
    await run(["add", "--login", "--code", "-"], {
      ask: async (req) => {
        seen.push(req);
        if ((req as { action: string }).action === "login.complete")
          return { op: "pool", outcome: "delivered", detail: "on · 1 account", status: status() };
        return answer;
      },
    });
    expect(seen[1]).toEqual({ op: "pool", action: "login.complete", account: "p1", code: "c#s" });
    expect(lines[0]).toBe("  ✓ signed in an account");
  });
});

describe("poolOffForUninstall", () => {
  it("nothing when the pool was never on; `pool off` when it was", async () => {
    await poolOffForUninstall(out, deps());
    expect(lines).toEqual([]);
    const pool = open();
    await pool.setOn(true);
    await poolOffForUninstall(out, deps({ open: () => pool }));
    expect(lines[1]).toBe("  Claude Code talks to Claude directly from its next start; the accounts stay pooled.");
    expect(readPool(env).on).toBe(false);
  });
});

describe("readSecret", () => {
  function fakeTty(chunks: string[], tty = true) {
    const handlers: Record<string, ((d: string) => void)[]> = { data: [], end: [] };
    const calls: string[] = [];
    const s: SecretInput = {
      isTTY: tty,
      setEncoding: () => calls.push("enc"),
      on: (e, cb) => {
        handlers[e]!.push(cb);
        if (e === "data" || e === "end")
          queueMicrotask(() => {
            for (const c of chunks) for (const h of handlers.data!) h(c);
            for (const h of handlers.end!) h("");
          });
      },
      off: (e, cb) => {
        handlers[e] = handlers[e]!.filter((h) => h !== cb);
      },
      setRawMode: (on) => calls.push(`raw:${on}`),
      resume: () => calls.push("resume"),
      pause: () => calls.push("pause"),
    };
    return { s, calls };
  }

  it("a pipe: everything until the end", async () => {
    const { s, calls } = fakeTty(["co", "de#st\n"], false);
    expect(await readSecret(s)).toBe("code#st\n");
    expect(calls).toEqual(["enc"]);
  });

  it("a terminal: raw mode, no echo, backspace edits, Enter ends", async () => {
    const { s, calls } = fakeTty(["ab\u007fc", "d\r", "ignored"]);
    const err = vi.fn();
    expect(await readSecret(s, err)).toBe("acd");
    expect(err.mock.calls.flat()).toEqual(["Code: ", "\n"]);
    expect(calls).toEqual(["raw:true", "resume", "enc", "raw:false", "pause"]);
  });

  it("a terminal: Ctrl-C leaves with 130", async () => {
    const { s } = fakeTty(["\u0003", "\n"]);
    const exit = vi.fn();
    await readSecret(s, () => {}, exit);
    expect(exit).toHaveBeenCalledWith(130);
  });

  it("by default the prompt goes to stderr and Ctrl-C to process.exit", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    expect(await readSecret(fakeTty(["ok\n"]).s)).toBe("ok");
    expect(write).toHaveBeenCalledWith("Code: ");
    await readSecret(fakeTty(["\u0003", "\n"]).s);
    expect(exit).toHaveBeenCalledWith(130);
    write.mockRestore();
    exit.mockRestore();
  });

  it("cliPath: the real path of dist/cli.js, or the plain one when it isn't there", () => {
    writeFileSync(path.join(tmp, "cli.js"), "");
    expect(cliPath(tmp)).toBe(path.join(tmp, "cli.js"));
    expect(cliPath(path.join(tmp, "nowhere"))).toBe(path.join(tmp, "nowhere", "cli.js"));
  });
});

const clock = (t: number) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const day = (t: number) =>
  `${new Date(t).toLocaleString("en-US", { month: "short" })} ${new Date(t).getDate()} ${clock(t)}`;
