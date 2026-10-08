// SPDX-License-Identifier: Apache-2.0
// The read-only SQLite reader with each of its three ways in faked, so every branch runs
// on every Node: a `node:sqlite` that is missing, that has no DatabaseSync, that throws
// on open, on exec, on the query or on close; a child or a CLI that prints nothing, or
// something that is not an array; a file that cannot even be stat'ed. The real engines
// are run against a real store in devin.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";

type Mod = typeof import("../src/readers/sqlite.js");
type Plan = {
  ctor?: Error;
  exec?: Error;
  all?: Error;
  close?: Error;
  rows?: unknown;
};
const opened: { file: string; options: Record<string, unknown> }[] = [];
let plan: Plan = {};
class FakeDb {
  constructor(file: string, options: Record<string, unknown>) {
    opened.push({ file, options });
    if (plan.ctor) throw plan.ctor;
  }
  exec(_sql: string): void {
    if (plan.exec) throw plan.exec;
  }
  prepare(_sql: string): { all(...p: unknown[]): unknown } {
    return {
      all: () => {
        if (plan.all) throw plan.all;
        return plan.rows;
      },
    };
  }
  close(): void {
    if (plan.close) throw plan.close;
  }
}

const calls: { file: string; args: string[] }[] = [];
/** The reader with its builtins replaced: `sqlite` is what `require("node:sqlite")`
 *  gives (or throws), `exec` what execFileSync prints, `exists` what existsSync says. */
async function load(o: {
  sqlite?: () => unknown;
  exec?: (file: string, args: string[]) => string;
  exists?: (file: string) => boolean;
}): Promise<Mod> {
  vi.resetModules();
  vi.doMock("node:module", async (original) => {
    const m = await original<typeof import("node:module")>();
    const sqlite = o.sqlite ?? (() => m.createRequire(import.meta.url)("node:sqlite"));
    return {
      ...m,
      createRequire: () => (id: string) => (id === "node:sqlite" ? sqlite() : m.createRequire(import.meta.url)(id)),
    };
  });
  vi.doMock("node:child_process", async (original) => {
    const m = await original<typeof import("node:child_process")>();
    return {
      ...m,
      execFileSync: (file: string, args: string[]) => {
        calls.push({ file, args });
        if (!o.exec) throw new Error("no child here");
        return o.exec(file, args);
      },
    };
  });
  vi.doMock("node:fs", async (original) => {
    const m = await original<typeof import("node:fs")>();
    return { ...m, existsSync: o.exists ?? (() => true) };
  });
  return import("../src/readers/sqlite.js");
}
afterEach(() => {
  vi.doUnmock("node:module");
  vi.doUnmock("node:child_process");
  vi.doUnmock("node:fs");
  vi.restoreAllMocks();
  opened.length = 0;
  calls.length = 0;
  plan = {};
});

const DB = "/some/sessions.db";
const sq = (m: Mod, engine: "node" | "child" | "cli" | "auto", sql = "SELECT 1", params: (string | number)[] = []) =>
  m.querySqlite(DB, sql, params, { engine });

describe("sqlite: the warning the reader keeps off the terminal", () => {
  it("swallows Node's experimental-SQLite warning in either spelling, passes every other on, and puts the emitter back", async () => {
    const { quiet } = await import("../src/readers/sqlite.js");
    const original = process.emitWarning;
    const passed = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const r = quiet(() => {
      process.emitWarning("SQLite is an experimental feature", "ExperimentalWarning");
      process.emitWarning("SQLite is an experimental feature", { type: "ExperimentalWarning" });
      process.emitWarning("something else", "DeprecationWarning");
      process.emitWarning("no type at all");
      return 42;
    });
    expect(r).toBe(42);
    expect(passed.mock.calls.map((c) => c[0])).toEqual(["something else", "no type at all"]);
    expect(process.emitWarning).toBe(passed);
    passed.mockRestore();
    expect(process.emitWarning).toBe(original);
  });
});

describe("sqlite: the in-process way in", () => {
  it("a Node without node:sqlite, or with one that has no DatabaseSync, has no in-process engine", async () => {
    const gone = await load({
      sqlite: () => {
        throw new Error("Cannot find module 'node:sqlite'");
      },
    });
    expect(gone.sqliteInProcess()).toBe(false);
    expect(sq(gone, "node")).toBeNull();
    const bare = await load({ sqlite: () => ({}) });
    expect(bare.sqliteInProcess()).toBe(false);
    expect(sq(bare, "node")).toBeNull();
  });

  it("opens the file read-only with the busy timeout, and turns BigInt and blobs into JSON", async () => {
    const m = await load({ sqlite: () => ({ DatabaseSync: FakeDb }) });
    expect(m.sqliteInProcess()).toBe(true);
    plan = { rows: [{ n: 12n, blob: new Uint8Array([1, 2]), s: "x", z: null }, 7, null, "row"] };
    expect(sq(m, "node", "SELECT ?", ["a"])).toEqual([{ n: 12, blob: null, s: "x", z: null }]);
    expect(opened).toEqual([{ file: DB, options: { readOnly: true, timeout: 2000 } }]);
  });

  it("a store that will not open, a PRAGMA that fails, a query that throws, a close that throws: rows or null, never an exception", async () => {
    const m = await load({ sqlite: () => ({ DatabaseSync: FakeDb }) });
    plan = { ctor: new Error("SQLITE_CANTOPEN") };
    expect(sq(m, "node")).toBeNull();
    // The PRAGMA is best effort; the close is too.
    plan = { exec: new Error("readonly"), close: new Error("already closed"), rows: [{ a: 1 }] };
    expect(sq(m, "node")).toEqual([{ a: 1 }]);
    plan = { all: new Error("SQLITE_BUSY") };
    expect(sq(m, "node")).toBeNull();
    // What is not an array is not a result.
    plan = { rows: { a: 1 } };
    expect(sq(m, "node")).toBeNull();
  });
});

describe("sqlite: the child and the CLI", () => {
  it("the child runs this node with --experimental-sqlite, read-only, and prints JSON; silence is no result", async () => {
    const m = await load({ sqlite: () => ({}), exec: () => "" });
    expect(sq(m, "child")).toBeNull();
    const [c] = calls;
    expect(c?.file).toBe(process.execPath);
    expect(c?.args.slice(0, 3)).toEqual(["--experimental-sqlite", "--no-warnings", "-e"]);
    expect(c?.args[3]).toContain("readOnly: true");
    expect(c?.args.slice(4)).toEqual([DB, "SELECT 1", "[]", "2000"]);
    const rows = await load({ sqlite: () => ({}), exec: () => '[{"x":1},5]' });
    expect(sq(rows, "child")).toEqual([{ x: 1 }]);
  });

  it("the CLI is asked read-only, gets no parameter it cannot write as a literal, and an empty print is an empty result", async () => {
    const m = await load({ sqlite: () => ({}), exec: () => "" });
    expect(sq(m, "cli", "SELECT ?", ["it's"])).toBeNull();
    expect(calls).toEqual([]);
    expect(sq(m, "cli", "SELECT ?", ["plain"])).toEqual([]);
    expect(calls[0]?.file).toBe("sqlite3");
    expect(calls[0]?.args).toEqual(["-readonly", "-json", DB, "SELECT 'plain'"]);
    const notRows = await load({ sqlite: () => ({}), exec: () => '{"x":1}' });
    expect(sq(notRows, "cli")).toBeNull();
  });

  it("a child or a CLI that cannot be run is no result either", async () => {
    const dead = await load({ sqlite: () => ({}) });
    expect(sq(dead, "child")).toBeNull();
    expect(sq(dead, "cli")).toBeNull();
    expect(calls.map((c) => c.file)).toEqual([process.execPath, "sqlite3"]);
    expect(dead.inlineParams("SELECT ?, ?", [1.5, "a b"])).toBe("SELECT 1.5, 'a b'");
  });

  it("auto tries each way in turn, and a file it cannot name or stat is read by none", async () => {
    const m = await load({ sqlite: () => ({}), exec: (file) => (file === "sqlite3" ? '[{"from":"cli"}]' : "") });
    expect(sq(m, "auto")).toEqual([{ from: "cli" }]);
    expect(calls.map((c) => c.file)).toEqual([process.execPath, "sqlite3"]);
    expect(m.querySqlite("", "SELECT 1")).toBeNull();
    const unstat = await load({
      exists: () => {
        throw new Error("EACCES");
      },
    });
    expect(sq(unstat, "auto")).toBeNull();
  });
});
