// SPDX-License-Identifier: Apache-2.0
// The machine's keys in a keychain: stored through stdin (never argv), trusted only on a
// read-back, read when a sink sends, never written back into a file, moved both ways —
// and a keychain this process can't read leaves events waiting, never sent unsigned.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readConfig } from "@sessionpipe/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { moveControlSecrets, readControl, writeControl } from "../src/control/store.js";
import {
  bestStore,
  defaultRunner,
  dropSinkSecrets,
  moveSinkSecrets,
  probe,
  type Runner,
  secretDel,
  secretGet,
  secretSet,
  sinkAccount,
  sinkWithSecrets,
} from "../src/secrets.js";

/** A stand-in for macOS `security`: an item map, or a keychain that is locked. */
function keychain(o: { locked?: boolean } = {}) {
  const items = new Map<string, string>();
  const calls: { args: string[]; input?: string }[] = [];
  const run: Runner = (cmd, args, input) => {
    calls.push({ args, ...(input !== undefined ? { input } : {}) });
    if (cmd !== "security") return { status: 127, stdout: "" };
    if (o.locked) return { status: 36, stdout: "" };
    if (args[0] === "-i") {
      const m = /-s sessionpipe -a "([^"]*)" -l "[^"]*" -w "([^"]*)"/.exec(input ?? "");
      if (m) items.set(m[1] as string, m[2] as string);
      return { status: 0, stdout: "" };
    }
    const a = args[args.indexOf("-a") + 1] as string;
    if (args[0] === "find-generic-password")
      return items.has(a) ? { status: 0, stdout: `${items.get(a)}\n` } : { status: 44, stdout: "" };
    if (args[0] === "delete-generic-password") return { status: items.delete(a) ? 0 : 44, stdout: "" };
    return { status: 1, stdout: "" };
  };
  return { items, calls, run };
}

let tmp: string;
let file: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "sp-secrets-"));
  file = path.join(tmp, "config.json");
  env = { ...process.env, SESSIONPIPE_CONFIG: file };
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("the keychain store", () => {
  it("stores through stdin, never argv, and trusts only a read-back", () => {
    const k = keychain();
    expect(secretSet("keychain", "sink:a:token", "ss_abc123", k.run)).toBe(true);
    expect(k.calls.some((c) => c.args.includes("ss_abc123"))).toBe(false);
    expect(k.calls[0]?.input).toContain("ss_abc123");
    expect(secretGet("keychain", "sink:a:token", k.run)).toBe("ss_abc123");
    secretDel("keychain", "sink:a:token", k.run);
    expect(secretGet("keychain", "sink:a:token", k.run)).toBeNull();
  });

  it("refuses a value its stdin parser would split (a quote, a space, a backslash)", () => {
    const k = keychain();
    for (const v of ['a"b', "a b", "a\\b", ""]) expect(secretSet("keychain", "x", v, k.run)).toBe(false);
    expect(k.items.size).toBe(0);
  });

  it("a locked keychain: the probe fails, so the best store is the file", () => {
    const k = keychain({ locked: true });
    expect(probe("keychain", k.run)).toBe(false);
    expect(bestStore({}, "darwin", k.run)).toBe("file");
    expect(bestStore({}, "darwin", keychain().run)).toBe("keychain");
  });

  it("the Secret Service only in a desktop session, and SESSIONPIPE_SECRETS=file always wins", () => {
    const k = keychain();
    expect(bestStore({ DBUS_SESSION_BUS_ADDRESS: "unix:x" }, "linux", k.run)).toBe("file");
    expect(bestStore({ SESSIONPIPE_SECRETS: "file" }, "darwin", k.run)).toBe("file");
    expect(bestStore({}, "win32", k.run)).toBe("file");
  });
});

describe("sinks", () => {
  const write = (sinks: unknown[]) => writeFileSync(file, JSON.stringify({ sinks, harnesses: {} }));

  it("move to the keychain leaves token_in and no token in the file; back to the file restores it", () => {
    const k = keychain();
    write([{ name: "rx.dev", url: "https://rx.dev", tier: 2, token: "ss_key1", secret: "whsec_c2VjcmV0" }]);
    expect(moveSinkSecrets("keychain", { run: k.run, file })).toEqual({ moved: ["rx.dev"], kept: [] });
    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain("ss_key1");
    expect(raw).not.toContain("whsec_");
    const s = readConfig(file).sinks[0];
    expect(s?.token_in).toBe("keychain");
    expect(sinkWithSecrets(s as never, k.run)).toMatchObject({ token: "ss_key1", secret: "whsec_c2VjcmV0" });

    expect(moveSinkSecrets("file", { run: k.run, file }).moved).toEqual(["rx.dev"]);
    const back = readConfig(file).sinks[0];
    expect(back).toMatchObject({ token: "ss_key1", secret: "whsec_c2VjcmV0" });
    expect(back?.token_in).toBeUndefined();
    expect(k.items.size).toBe(0);
  });

  it("a token the keychain can't hand over (locked): no sink is built, so nothing is sent unsigned", () => {
    const s = { name: "rx.dev", url: "https://rx.dev", tier: 2 as const, token_in: "keychain" as const };
    expect(sinkWithSecrets(s, keychain({ locked: true }).run)).toBeNull();
  });

  it("a token the keychain refuses stays in the file", () => {
    write([{ name: "rx.dev", url: "https://rx.dev", tier: 2, token: "has space" }]);
    expect(moveSinkSecrets("keychain", { run: keychain().run, file })).toEqual({ moved: [], kept: ["rx.dev"] });
    expect(readConfig(file).sinks[0]?.token).toBe("has space");
  });
});

describe("control.json", () => {
  const receiver = {
    url: "https://rx.dev",
    control: "https://rx.dev/api/sessionpipe/v1/control",
    rpId: "rx.dev",
    machine: "m_abcdefghijklmnop",
    token: "mt_machine_token",
    keys: [],
    paired_at: "2026-10-02T00:00:00.000Z",
  };
  const base = { name: "box", folders: [], mode: "safe" as const, receivers: [receiver] };

  it("a token in the keychain is read on load and never written back", () => {
    const k = keychain();
    writeControl(base, env);
    expect(moveControlSecrets("keychain", { env, run: k.run }).moved).toEqual(["https://rx.dev"]);
    const ctl = path.join(tmp, "control.json");
    expect(readFileSync(ctl, "utf8")).not.toContain("mt_machine_token");
    const loaded = readControl(env, k.run);
    expect(loaded?.receivers[0]?.token).toBe("mt_machine_token");
    // A write of what was loaded (the daemon adding a key) keeps it out of the file.
    writeControl(loaded as never, env);
    expect(readFileSync(ctl, "utf8")).not.toContain("mt_machine_token");
    // Locked: the token reads as empty, the file is unchanged.
    expect(readControl(env, keychain({ locked: true }).run)?.receivers[0]?.token).toBe("");
  });

  it("keeps the machine's own caps across a write", () => {
    writeControl({ ...base, limits: { headless: 1 } }, env);
    expect(readControl(env, keychain().run)?.limits).toEqual({ headless: 1 });
  });
});

/** A stand-in for `secret-tool`: the Secret Service as a Linux desktop session sees it. */
function secretService() {
  const items = new Map<string, string>();
  const run: Runner = (cmd, args, input) => {
    if (cmd !== "secret-tool") return { status: 127, stdout: "" };
    const account = args[args.indexOf("account") + 1] as string;
    if (args[0] === "store") {
      items.set(account, input ?? "");
      return { status: 0, stdout: "" };
    }
    if (args[0] === "lookup")
      return items.has(account) ? { status: 0, stdout: items.get(account) as string } : { status: 1, stdout: "" };
    if (args[0] === "clear") return { status: items.delete(account) ? 0 : 1, stdout: "" };
    return { status: 1, stdout: "" };
  };
  return { items, run };
}

describe("the Secret Service store", () => {
  it("stores through stdin, reads back without a trailing newline, and clears", () => {
    const s = secretService();
    expect(secretSet("secret-service", "sink:a:token", "ss_abc", s.run)).toBe(true);
    expect(s.items.get("sink:a:token")).toBe("ss_abc");
    expect(secretGet("secret-service", "sink:a:token", s.run)).toBe("ss_abc");
    secretDel("secret-service", "sink:a:token", s.run);
    expect(secretGet("secret-service", "sink:a:token", s.run)).toBeNull();
    expect(probe("secret-service", s.run)).toBe(true);
    // An item that reads back empty is no item.
    s.items.set("sink:e:token", "");
    expect(secretGet("secret-service", "sink:e:token", s.run)).toBeNull();
  });

  it("is the store of a Linux desktop session (D-Bus and a display), or whatever SESSIONPIPE_SECRETS names", () => {
    const s = secretService();
    const bus = { DBUS_SESSION_BUS_ADDRESS: "unix:x" };
    expect(bestStore({ ...bus, DISPLAY: ":0" }, "linux", s.run)).toBe("secret-service");
    expect(bestStore({ ...bus, WAYLAND_DISPLAY: "wayland-0" }, "linux", s.run)).toBe("secret-service");
    expect(bestStore({ DISPLAY: ":0" }, "linux", s.run)).toBe("file");
    expect(bestStore({ SESSIONPIPE_SECRETS: "secret-service" }, "darwin", s.run)).toBe("secret-service");
    expect(bestStore({ SESSIONPIPE_SECRETS: "keychain" }, "linux", s.run)).toBe("file");
    expect(bestStore({ SESSIONPIPE_SECRETS: "keychain" }, "linux", keychain().run)).toBe("keychain");
  });
});

describe("the keychain's own tool", () => {
  it("runs it with the value on stdin and hands back its status and output; a tool that isn't there is no status", () => {
    expect(defaultRunner("sh", ["-c", "cat; echo more"], "in")).toEqual({ status: 0, stdout: "inmore\n" });
    expect(defaultRunner("sh", ["-c", "exit 3"])).toEqual({ status: 3, stdout: "" });
    expect(defaultRunner(path.join(tmp, "no-such-tool"), [])).toEqual({ status: null, stdout: "" });
  });

  it("refuses an account its stdin parser would split", () => {
    const k = keychain();
    expect(secretSet("keychain", 'sink:a"b:token', "value", k.run)).toBe(false);
    expect(k.items.size).toBe(0);
  });
});

describe("moving sinks' keys", () => {
  const write = (sinks: unknown[]) => writeFileSync(file, JSON.stringify({ sinks, harnesses: {} }));

  it("leaves a sink already in the store, a sink with no key, and names scoped by SESSIONPIPE_CONFIG", () => {
    vi.stubEnv("SESSIONPIPE_CONFIG", file);
    try {
      const k = keychain();
      write([
        { name: "kc", url: "https://kc.dev", tier: 1, token_in: "keychain" },
        { name: "none", url: "stdout", tier: 0 },
        { name: "rx", url: "https://rx.dev", tier: 1, token: "ss_key" },
      ]);
      k.items.set(sinkAccount("kc"), "already");
      expect(sinkAccount("kc")).toMatch(/^sink:kc:token@[0-9a-f]{8}$/);
      // No SESSIONPIPE_CONFIG: the machine has one config, so the name alone.
      vi.stubEnv("SESSIONPIPE_CONFIG", undefined as never);
      expect(sinkAccount("kc")).toBe("sink:kc:token");
      vi.stubEnv("SESSIONPIPE_CONFIG", file);
      expect(moveSinkSecrets("keychain", { run: k.run })).toEqual({ moved: ["rx"], kept: [] });
      expect(readConfig(file).sinks.map((s) => s.token_in)).toEqual(["keychain", undefined, "keychain"]);
      expect(k.items.get(sinkAccount("rx"))).toBe("ss_key");
      // Back into the file, the token only: nothing is written for a secret it never had.
      expect(moveSinkSecrets("file", { run: k.run })).toEqual({ moved: ["kc", "rx"], kept: [] });
      expect(readConfig(file).sinks[2]).toEqual({ name: "rx", url: "https://rx.dev", tier: 1, token: "ss_key" });
      expect(k.items.size).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("from one store to another: written there first, then the file, then the old item dropped", () => {
    const k = keychain();
    const s = secretService();
    const run: Runner = (cmd, args, input) => (cmd === "security" ? k.run(cmd, args, input) : s.run(cmd, args, input));
    write([{ name: "rx", url: "https://rx.dev", tier: 1, token: "ss_key", secret: "whsec_s" }]);
    expect(moveSinkSecrets("keychain", { run, file })).toEqual({ moved: ["rx"], kept: [] });
    expect(moveSinkSecrets("secret-service", { run, file })).toEqual({ moved: ["rx"], kept: [] });
    expect(readConfig(file).sinks[0]?.token_in).toBe("secret-service");
    expect(k.items.size).toBe(0);
    expect([...s.items.values()]).toEqual(["ss_key", "whsec_s"]);
    expect(sinkWithSecrets(readConfig(file).sinks[0] as never, run)).toMatchObject({
      token: "ss_key",
      secret: "whsec_s",
    });
    dropSinkSecrets(readConfig(file).sinks[0] as never, run);
    expect(s.items.size).toBe(0);
    dropSinkSecrets({ name: "plain", url: "stdout", tier: 0 }, run);
  });

  it("a key in a store this session can't read stays there, and is named", () => {
    write([{ name: "kc", url: "https://kc.dev", tier: 1, token_in: "keychain" }]);
    expect(moveSinkSecrets("file", { run: keychain({ locked: true }).run, file })).toEqual({ moved: [], kept: ["kc"] });
    expect(readConfig(file).sinks[0]?.token_in).toBe("keychain");
  });

  it("a secret the store refuses keeps the pair together, in the file", () => {
    const k = keychain();
    write([{ name: "rx", url: "https://rx.dev", tier: 1, token: "ss_key", secret: "has space" }]);
    expect(moveSinkSecrets("keychain", { run: k.run, file })).toEqual({ moved: [], kept: ["rx"] });
    expect(k.items.size).toBe(0);
    expect(readConfig(file).sinks[0]).toMatchObject({ token: "ss_key", secret: "has space" });
  });
});

// The real macOS Keychain, opt-in (it writes and deletes one throwaway item).
describe.runIf(process.platform === "darwin" && process.env.SP_KEYCHAIN_TEST === "1")("the real Keychain", () => {
  it("round-trips through `security`", () => {
    const acct = `test:${Date.now()}`;
    expect(secretSet("keychain", acct, "ss_real_test_value", defaultRunner)).toBe(true);
    expect(secretGet("keychain", acct, defaultRunner)).toBe("ss_real_test_value");
    secretDel("keychain", acct, defaultRunner);
    expect(secretGet("keychain", acct, defaultRunner)).toBeNull();
  });
});
