// SPDX-License-Identifier: Apache-2.0
// What the control daemon keeps on disk, at its edges: a control.json it can't use, a
// token store that refuses, nonces past their 25 hours (CONTROL.md §5 step 5), acks
// kept until accepted, the fork map and the alias map read defensively.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NONCE_TTL_MS } from "@sessionpipe/core/control";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAliases, receiverIdOf, writeAliases } from "../src/control/aliases.js";
import {
  AckOutbox,
  dropControlSecret,
  moveControlSecrets,
  NonceStore,
  type PairedReceiver,
  pairedCount,
  parseMode,
  readControl,
  readState,
  writeControl,
  writeState,
} from "../src/control/store.js";
import type { Runner } from "../src/secrets.js";

let tmp: string;
let env: NodeJS.ProcessEnv;
const file = () => path.join(tmp, "config", "control.json");
const receiver = (over: Partial<PairedReceiver> = {}): PairedReceiver => ({
  url: "https://rx.dev",
  control: "https://rx.dev/api/sessionpipe/v1/control",
  rpId: "rx.dev",
  machine: "m_0123456789abcdef",
  token: "tok",
  keys: [],
  paired_at: "2026-10-01T00:00:00Z",
  ...over,
});

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "sp-store-"));
  env = { SESSIONPIPE_CONFIG: path.join(tmp, "config", "config.json"), SESSIONPIPE_STATE: path.join(tmp, "state") };
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("control.json", () => {
  it("the mode is safe, auto or inherit by name; anything else reads as safe", () => {
    mkdirSync(path.dirname(file()), { recursive: true });
    for (const [mode, read] of [
      ["inherit", "inherit"],
      ["auto", "auto"],
      ["safe", "safe"],
      ["bypass", "safe"],
      ["bypassPermissions", "safe"],
      [undefined, "safe"],
    ] as const) {
      writeFileSync(file(), JSON.stringify({ mode, receivers: [] }));
      expect(readControl(env)?.mode).toBe(read);
    }
    expect(parseMode("inherit")).toBe("inherit");
    expect(parseMode("INHERIT")).toBeNull();
    expect(parseMode(1)).toBeNull();
  });

  it("a file without receivers is no config; a bare one gets a name, folders and safe mode", () => {
    mkdirSync(path.dirname(file()), { recursive: true });
    writeFileSync(file(), "{}");
    expect(readControl(env)).toBeNull();
    expect(pairedCount(env)).toBe(0);
    writeFileSync(file(), JSON.stringify({ receivers: [receiver()] }));
    expect(readControl(env)).toEqual({ name: "machine", folders: [], mode: "safe", receivers: [receiver()] });
    expect(pairedCount(env)).toBe(1);
    expect(pairedCount({ ...env, SESSIONPIPE_CONFIG: path.join(tmp, "nowhere", "c.json") })).toBe(0);
  });

  it("the daemon's own shell env is the default", () => {
    vi.stubEnv("SESSIONPIPE_CONFIG", env.SESSIONPIPE_CONFIG as string);
    try {
      writeControl({ name: "box", folders: [], mode: "auto", receivers: [] });
      expect(pairedCount()).toBe(0);
      expect(readControl()).toMatchObject({ name: "box", mode: "auto" });
      if (process.platform !== "win32") expect(statSync(file()).mode & 0o777).toBe(0o600);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("the machine token's store", () => {
  /** A stand-in `security` / `secret-tool`: remembers what it was given, or refuses. */
  function fakeStore(o: { refuse?: boolean } = {}) {
    const kept = new Map<string, string>();
    const calls: string[] = [];
    const run: Runner = (cmd, args, input) => {
      calls.push(`${cmd} ${args[0]}`);
      const account = args[args.indexOf("-a") + 1] ?? args[args.indexOf("account") + 1] ?? "";
      if (args[0] === "find-generic-password" || args[0] === "lookup") {
        const v = kept.get(account);
        return v === undefined ? { status: 1, stdout: "" } : { status: 0, stdout: `${v}\n` };
      }
      if (args[0] === "-i") {
        if (!o.refuse)
          kept.set(/-a "([^"]+)"/.exec(input ?? "")?.[1] ?? "", /-w "([^"]+)"/.exec(input ?? "")?.[1] ?? "");
        return { status: 0, stdout: "" };
      }
      kept.delete(account);
      return { status: 0, stdout: "" };
    };
    return { run, kept, calls };
  }

  it("moves every readable token, keeps one it can't read, and one the store refuses", () => {
    const { run, kept } = fakeStore();
    writeControl(
      {
        name: "box",
        folders: [],
        mode: "safe",
        receivers: [
          receiver(),
          receiver({ url: "https://two.dev", machine: "m_two000000000000000", token: "" }),
          receiver({ url: "https://three.dev", machine: "m_three0000000000000", token_in: "keychain" }),
        ],
      },
      env,
    );
    // Already in the keychain: left alone. Unreadable: kept where it is. Readable: moved.
    expect(moveControlSecrets("keychain", { env, run })).toEqual({
      moved: ["https://rx.dev"],
      kept: ["https://two.dev"],
    });
    expect(kept.size).toBe(1);
    const back = JSON.parse(readFileSync(file(), "utf8")) as { receivers: PairedReceiver[] };
    expect(back.receivers[0]).not.toHaveProperty("token");
    expect(back.receivers[0]?.token_in).toBe("keychain");
    // Read back through the store; then home again, and the keychain copy is dropped.
    expect(readControl(env, run)?.receivers[0]?.token).toBe("tok");
    expect(moveControlSecrets("file", { env, run }).moved).toEqual(["https://rx.dev"]);
    expect(kept.size).toBe(0);
    expect(readControl(env, run)?.receivers[0]).toMatchObject({ token: "tok" });
    expect(readControl(env, run)?.receivers[0]).not.toHaveProperty("token_in");
  });

  it("a store that takes the token but can't hand it back: nothing moves, nothing is left behind", () => {
    const { run, calls } = fakeStore({ refuse: true });
    writeControl({ name: "box", folders: [], mode: "safe", receivers: [receiver()] }, env);
    expect(moveControlSecrets("keychain", { env, run })).toEqual({ moved: [], kept: ["https://rx.dev"] });
    expect(calls).toContain("security delete-generic-password");
    expect(readControl(env, run)?.receivers[0]?.token).toBe("tok");
  });

  it("no control.json: nothing to move; `control off` forgets a stored token and leaves a plain one", () => {
    const { run, kept } = fakeStore();
    expect(moveControlSecrets("keychain", { env, run })).toEqual({ moved: [], kept: [] });
    // A token already in the file, moved "to the file": nothing to do, and no store is asked.
    writeControl({ name: "box", folders: [], mode: "safe", receivers: [receiver()] }, env);
    expect(moveControlSecrets("file", { env })).toEqual({ moved: [], kept: [] });
    kept.set("control:m_0123456789abcdef", "tok");
    dropControlSecret(receiver({ token_in: "keychain" }), run);
    expect(kept.size).toBe(0);
    dropControlSecret(receiver(), () => {
      throw new Error("never asked");
    });
  });
});

describe("nonces (CONTROL.md §5 step 5)", () => {
  it("forgets a nonce after 25 hours, skips lines it can't read, and compacts to the live window", () => {
    let now = Date.parse("2026-10-19T12:00:00Z");
    const f = path.join(tmp, "state", "control", "nonces.jsonl");
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(
      f,
      [
        JSON.stringify({ n: "old0000000000000000000000", t: now - NONCE_TTL_MS - 1 }),
        JSON.stringify({ n: "live000000000000000000000", t: now - 1000 }),
        JSON.stringify({ n: 5, t: now }),
        "not json",
        "",
      ].join("\n"),
    );
    const s = new NonceStore(f, () => now);
    expect(s.size).toBe(1);
    expect(s.seen("live000000000000000000000")).toBe(true);
    expect(s.seen("old0000000000000000000000")).toBe(false);
    expect(readFileSync(f, "utf8").split("\n").filter(Boolean)).toHaveLength(2);
    // A day and an hour later the window has moved past both: compacting leaves an empty file.
    now += NONCE_TTL_MS + 1;
    expect(s.seen("live000000000000000000000")).toBe(false);
    now += NONCE_TTL_MS + 1;
    s.compact();
    expect(s.size).toBe(0);
    expect(readFileSync(f, "utf8")).toBe("");
  });
  it("no file and nothing seen: compacting writes nothing", () => {
    const f = path.join(tmp, "state", "control", "nonces.jsonl");
    new NonceStore(f, Date.now).compact();
    expect(existsSync(f)).toBe(false);
  });
});

describe("acks not yet accepted", () => {
  it("appends, reads back, keeps what is left, and an unreadable file is empty", () => {
    const f = path.join(tmp, "state", "control", "acks.jsonl");
    const o = new AckOutbox(f);
    expect(o.all()).toEqual([]);
    const a = { receiver: "r", id: "1", outcome: "taken" as const, at: "t" };
    o.add(a);
    o.add({ ...a, id: "2" });
    expect(o.all().map((x) => x.id)).toEqual(["1", "2"]);
    o.keep([{ ...a, id: "2" }]);
    expect(o.all().map((x) => x.id)).toEqual(["2"]);
    o.keep([]);
    expect(readFileSync(f, "utf8")).toBe("");
  });
});

describe("forks and aliases on disk", () => {
  it("state.json: the fork map, or nothing when it is missing or not a map", () => {
    const f = path.join(tmp, "state", "control", "state.json");
    expect(readState(f)).toEqual({ started: {}, copies: {} });
    writeState(f, { copies: { a: "b" }, started: {} });
    expect(readState(f)).toEqual({ started: {}, copies: { a: "b" } });
    writeFileSync(f, JSON.stringify({ copies: "b" }));
    expect(readState(f)).toEqual({ started: {}, copies: {} });
    writeFileSync(f, JSON.stringify({}));
    expect(readState(f)).toEqual({ started: {}, copies: {} });
    // What each started session runs with: a known level, and a model only when well-formed.
    writeFileSync(
      f,
      JSON.stringify({
        copies: {},
        started: {
          a: { permission: "read", model: "sonnet" },
          b: { permission: "edits", model: "-bad" },
          c: { permission: "bypassPermissions" },
          d: null,
        },
      }),
    );
    expect(readState(f).started).toEqual({ a: { permission: "read", model: "sonnet" }, b: { permission: "edits" } });
  });
  it("aliases.json: only entries with an id and a folder; `at` is optional; anything else is no map", () => {
    const f = path.join(tmp, "state", "control", "aliases.json");
    expect(readAliases(f)).toEqual({});
    mkdirSync(path.dirname(f), { recursive: true });
    for (const bad of ["null", "[]", "3", '"x"']) {
      writeFileSync(f, bad);
      expect(readAliases(f)).toEqual({});
    }
    writeAliases(f, {
      "codex:a": { id: "t1", cwd: "/p", at: "2026-10-04T00:00:00Z" },
      "codex:b": { id: "", cwd: "/p", at: "" },
      "codex:c": { id: 7 as never, cwd: "/p", at: "" },
      "codex:d": { id: "t4", cwd: 5 as never, at: "" },
      "codex:e": null as never,
      "codex:f": { id: "t6", cwd: "/q", at: 9 as never },
      "codex:g": { id: "t7", cwd: "/q", at: "", permission: "read", model: "gpt-5.6-sol" },
      "codex:h": { id: "t8", cwd: "/q", at: "", permission: "full" as never },
    });
    expect(readAliases(f)).toEqual({
      "codex:a": { id: "t1", cwd: "/p", at: "2026-10-04T00:00:00Z" },
      "codex:f": { id: "t6", cwd: "/q", at: "" },
      // What a start ran with, kept; a level that isn't one is no record at all.
      "codex:g": { id: "t7", cwd: "/q", at: "", permission: "read", model: "gpt-5.6-sol" },
      "codex:h": { id: "t8", cwd: "/q", at: "" },
    });
    expect(receiverIdOf(readAliases(f), "codex", "t6")).toBe("f");
    expect(receiverIdOf(readAliases(f), "antigravity", "t6")).toBeNull();
  });
});
