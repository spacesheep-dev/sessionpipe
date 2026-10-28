// SPDX-License-Identifier: Apache-2.0
// What the pool keeps on disk, at its edges: pool.json read defensively, state.json
// round-tripped, secrets in the file fallback or a store, never in pool.json.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  keepStanding,
  type PoolConfig,
  PoolSecrets,
  policyAccounts,
  poolFile,
  poolSecretsFile,
  poolStateFile,
  readPool,
  readPoolState,
  writePool,
  writePoolState,
} from "../src/pool/store.js";
import type { Runner } from "../src/secrets.js";

let tmp: string;
let env: NodeJS.ProcessEnv;
const UUID = "11111111-2222-4333-8444-555555555555";
const cfg = (over: Partial<PoolConfig> = {}): PoolConfig => ({
  on: true,
  port: 4555,
  accounts: [
    { id: "abcd1234", email: "a@b.c", account_uuid: UUID, enabled: true, added_at: "2026-10-29T00:00:00.000Z" },
  ],
  ...over,
});

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "sp-pool-store-"));
  env = { SESSIONPIPE_CONFIG: path.join(tmp, "config", "config.json"), SESSIONPIPE_STATE: path.join(tmp, "state") };
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("pool.json", () => {
  it("lives beside control.json, is 0600, and round-trips", () => {
    expect(poolFile(env)).toBe(path.join(tmp, "config", "pool.json"));
    expect(poolStateFile(env)).toBe(path.join(tmp, "state", "pool", "state.json"));
    const c = cfg({ secrets_in: "keychain", created: [path.join(tmp, "s.json")] });
    c.accounts[0]!.label = "Work";
    writePool(c, env);
    if (process.platform !== "win32") expect(statSync(poolFile(env)).mode & 0o777).toBe(0o600);
    expect(readPool(env)).toEqual(c);
    expect(readFileSync(poolFile(env), "utf8")).not.toMatch(/access|refresh|token/);
  });
  it("absent or broken reads as off and empty", () => {
    expect(readPool(env)).toEqual({ on: false, port: 0, accounts: [] });
    mkdirSync(path.dirname(poolFile(env)), { recursive: true });
    writeFileSync(poolFile(env), "{nope");
    expect(readPool(env)).toEqual({ on: false, port: 0, accounts: [] });
    writeFileSync(poolFile(env), "[]");
    expect(readPool(env)).toEqual({ on: false, port: 0, accounts: [] });
  });
  it("drops what is off the shape and fills what is missing", () => {
    mkdirSync(path.dirname(poolFile(env)), { recursive: true });
    writeFileSync(
      poolFile(env),
      JSON.stringify({
        on: "yes",
        port: 70000,
        secrets_in: "vault",
        created: ["ok", 3],
        accounts: [
          null,
          { id: 5 },
          { id: "x", account_uuid: "not a uuid!" },
          { id: "dup", account_uuid: UUID, email: "d@d.d" },
          { id: "dup", account_uuid: UUID },
          { id: "bare", account_uuid: UUID, label: "", enabled: false },
          { id: "long", account_uuid: UUID, label: "L".repeat(80), email: 7 },
        ],
      }),
    );
    expect(readPool(env)).toEqual({
      on: false,
      port: 0,
      created: ["ok"],
      accounts: [
        { id: "dup", email: "d@d.d", account_uuid: UUID, enabled: true, added_at: "1970-01-01T00:00:00.000Z" },
        { id: "bare", email: "", account_uuid: UUID, enabled: false, added_at: "1970-01-01T00:00:00.000Z" },
        {
          id: "long",
          label: "L".repeat(64),
          email: "",
          account_uuid: UUID,
          enabled: true,
          added_at: "1970-01-01T00:00:00.000Z",
        },
      ],
    });
    writeFileSync(poolFile(env), JSON.stringify({ accounts: "none", port: 80 }));
    expect(readPool(env)).toEqual({ on: false, port: 80, accounts: [] });
  });
});

describe("state.json", () => {
  it("round-trips pins, standing and the pending login; drops anything else", () => {
    expect(readPoolState(env)).toEqual({ pins: {}, accounts: {} });
    const st = {
      pins: { s1: { account: "a", used: 5 } },
      accounts: {
        a: {
          hold_until: 9,
          error: "sign in again",
          limits: { windows: [{ id: "five_hour", used_percent: 1 }], status: "allowed" },
          limits_at: 4,
        },
        b: {},
        c: { limits: { windows: [{ id: "seven_day", used_percent: 2 }] } },
      },
      pending: { id: "p1", url: "https://x", verifier: "v", state: "s", expires_at: 99 },
    };
    writePoolState(st, env);
    expect(readPoolState(env)).toEqual({
      ...st,
      accounts: { ...st.accounts, c: { limits: { windows: [{ id: "seven_day", used_percent: 2 }] } } },
    });
    writeFileSync(
      poolStateFile(env),
      JSON.stringify({
        pins: { ok: { account: "a", used: 1 }, bad: { account: 1 }, worse: null },
        accounts: { a: null, b: "x", c: { hold_until: "soon", limits: { windows: "no" } } },
        pending: { id: "p", url: "u" },
      }),
    );
    expect(readPoolState(env)).toEqual({ pins: { ok: { account: "a", used: 1 } }, accounts: { c: {} } });
    writeFileSync(poolStateFile(env), JSON.stringify({ pins: 1, accounts: 2, pending: 3 }));
    expect(readPoolState(env)).toEqual({ pins: {}, accounts: {} });
  });
  it("the policy's accounts come from the config's order plus the remembered standing", () => {
    const c = cfg({
      accounts: [...cfg().accounts, { id: "b", email: "", account_uuid: UUID, enabled: false, added_at: "x" }],
    });
    const st = { pins: {}, accounts: { abcd1234: { hold_until: 3 } } };
    const rows = policyAccounts(c, st);
    expect(rows).toEqual([
      { id: "abcd1234", enabled: true, hold_until: 3 },
      { id: "b", enabled: false },
    ]);
    rows[1]!.error = "e";
    keepStanding(st, rows);
    expect(st.accounts).toEqual({ abcd1234: { hold_until: 3 }, b: { error: "e" } });
  });
});

describe("secrets", () => {
  it("the file fallback: pool.secrets.json at 0600, beside pool.json, never pool.json itself", () => {
    const s = new PoolSecrets(env);
    const c = cfg();
    expect(s.store(c)).toBe("file");
    expect(s.get(c, "pool:token")).toBeNull();
    expect(s.set(c, "pool:token", "tok")).toBe(true);
    expect(s.get(c, "pool:token")).toBe("tok");
    if (process.platform !== "win32") expect(statSync(poolSecretsFile(env)).mode & 0o777).toBe(0o600);
    expect(existsSync(poolFile(env))).toBe(false);
    expect(s.credential(c, "abcd1234")).toBeNull();
    expect(s.setCredential(c, "abcd1234", { access: "A", refresh: "R", expires_at: 5 })).toBe(true);
    expect(s.credential(c, "abcd1234")).toEqual({ access: "A", refresh: "R", expires_at: 5 });
    s.del(c, "nothing");
    s.del(c, "pool:abcd1234");
    expect(s.credential(c, "abcd1234")).toBeNull();
    expect(s.get(c, "pool:token")).toBe("tok");
    rmSync(poolSecretsFile(env));
    s.del(c, "pool:token");
    expect(s.get(c, "pool:token")).toBeNull();
  });
  it("a credential that isn't one reads as none", () => {
    const s = new PoolSecrets(env);
    const c = cfg();
    s.set(c, "pool:abcd1234", "not json");
    expect(s.credential(c, "abcd1234")).toBeNull();
    s.set(c, "pool:abcd1234", Buffer.from(JSON.stringify({ access: "A", refresh: "R" })).toString("base64url"));
    expect(s.credential(c, "abcd1234")).toBeNull();
    writeFileSync(poolSecretsFile(env), JSON.stringify({ "pool:abcd1234": 7 }));
    expect(s.get(c, "pool:abcd1234")).toBeNull();
  });
  it("a keychain: through the secrets store's runner", () => {
    const items = new Map<string, string>();
    const run: Runner = (cmd, args, input) => {
      if (cmd !== "security") return { status: 1, stdout: "" };
      if (args[0] === "find-generic-password")
        return items.has(args[4]!) ? { status: 0, stdout: `${items.get(args[4]!)}\n` } : { status: 44, stdout: "" };
      if (args[0] === "delete-generic-password") items.delete(args[4]!);
      if (args[0] === "-i") {
        const m = /-a "([^"]+)".* -w "([^"]+)"/.exec(input ?? "");
        items.set(m![1]!, m![2]!);
      }
      return { status: 0, stdout: "" };
    };
    const s = new PoolSecrets(env, run);
    const c = cfg({ secrets_in: "keychain" });
    expect(s.set(c, "pool:token", "tok")).toBe(true);
    expect(s.get(c, "pool:token")).toBe("tok");
    expect(existsSync(poolSecretsFile(env))).toBe(false);
    s.del(c, "pool:token");
    expect(s.get(c, "pool:token")).toBeNull();
  });
});
