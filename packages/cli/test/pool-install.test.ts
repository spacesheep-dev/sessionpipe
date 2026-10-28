// SPDX-License-Identifier: Apache-2.0
// The `env` block in Claude Code's settings.json: written in the file's own shape,
// removed byte-identically, never over someone else's base URL, never into a file that
// isn't plain JSON.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanEnv,
  installedPoolEnv,
  installPoolEnv,
  POOL_ENV_KEYS,
  poolEnv,
  uninstallPoolEnv,
} from "../src/pool/install.js";

let tmp: string;
const dir = (name: string) => path.join(tmp, name);
const file = (name: string) => path.join(tmp, name, "settings.json");
const put = (name: string, text: string) => {
  mkdirSync(dir(name), { recursive: true });
  writeFileSync(file(name), text);
};
const o = { port: 4555, token: "tok_abc" };

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "sp-pool-install-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("installPoolEnv", () => {
  it("creates a missing file, keeps a file's own indent, EOL and final newline, and is idempotent", () => {
    put("tabs", '{\n\t"model": "opus",\n\t"env": {\n\t\t"FOO": "1"\n\t}\n}');
    put("crlf", '{\r\n    "a": 1\r\n}\r\n');
    const r = installPoolEnv([dir("new"), dir("tabs"), dir("crlf")], o);
    expect(r).toEqual([
      { file: file("new"), changed: true, created: true },
      { file: file("tabs"), changed: true, created: false },
      { file: file("crlf"), changed: true, created: false },
    ]);
    expect(JSON.parse(readFileSync(file("new"), "utf8"))).toEqual({ env: poolEnv(4555, "tok_abc") });
    expect(readFileSync(file("tabs"), "utf8")).toBe(
      `{\n\t"model": "opus",\n\t"env": {\n\t\t"FOO": "1",\n\t\t"ANTHROPIC_BASE_URL": "http://127.0.0.1:4555",\n\t\t"ANTHROPIC_AUTH_TOKEN": "tok_abc",\n\t\t"_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL": "1"\n\t}\n}`,
    );
    expect(readFileSync(file("crlf"), "utf8")).toMatch(
      /^\{\r\n {4}"a": 1,\r\n {4}"env": \{\r\n {8}"ANTHROPIC_BASE_URL"/,
    );
    expect(readFileSync(file("crlf"), "utf8").endsWith("}\r\n")).toBe(true);
    expect(installPoolEnv([dir("new"), dir("tabs")], o)).toEqual([
      { file: file("new"), changed: false },
      { file: file("tabs"), changed: false },
    ]);
    expect(installedPoolEnv([dir("new"), dir("tabs")], o).map((x) => x.state)).toEqual(["current", "current"]);
  });
  it("rewrites our own block for a new port or token", () => {
    installPoolEnv([dir("a")], o);
    expect(installedPoolEnv([dir("a")], { port: 4556, token: "tok_abc" })[0]?.state).toBe("stale");
    expect(installPoolEnv([dir("a")], { port: 4556, token: "other" })[0]).toEqual({
      file: file("a"),
      changed: true,
      created: false,
    });
    expect(JSON.parse(readFileSync(file("a"), "utf8")).env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4556");
  });
  it("never touches a base URL someone else set, a non-object env, or a file that isn't plain JSON", () => {
    put(
      "bb",
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:3456/v1/bb", ANTHROPIC_AUTH_TOKEN: "bb" } }),
    );
    put("gw", JSON.stringify({ env: { ANTHROPIC_BASE_URL: ["x"] } }));
    put("arr", JSON.stringify({ env: [] }));
    put("comments", '{\n  // hello\n  "a": 1\n}\n');
    put("broken", "{nope");
    put("list", "[1]");
    const before = Object.fromEntries(
      ["bb", "gw", "arr", "comments", "broken", "list"].map((n) => [n, readFileSync(file(n), "utf8")]),
    );
    expect(installPoolEnv(["bb", "gw", "arr", "comments", "broken", "list"].map(dir), o)).toEqual([
      {
        file: file("bb"),
        changed: false,
        skipped: true,
        note: "skipped: ANTHROPIC_BASE_URL already set (http://127.0.0.1:3456/v1/bb)",
      },
      { file: file("gw"), changed: false, skipped: true, note: "skipped: ANTHROPIC_BASE_URL already set" },
      { file: file("arr"), changed: false, skipped: true, note: "env is not an object; not touched" },
      { file: file("comments"), changed: false, skipped: true, note: "not plain JSON (it has comments); not touched" },
      { file: file("broken"), changed: false, skipped: true, note: "not plain JSON; not touched" },
      { file: file("list"), changed: false, skipped: true, note: "not a JSON object; not touched" },
    ]);
    for (const [n, text] of Object.entries(before)) expect(readFileSync(file(n), "utf8")).toBe(text);
    expect(installedPoolEnv(["bb", "gw", "arr", "comments", "none"].map(dir), o)).toEqual([
      { file: file("bb"), state: "other", note: "ANTHROPIC_BASE_URL is http://127.0.0.1:3456/v1/bb" },
      { file: file("gw"), state: "other", note: "ANTHROPIC_BASE_URL is x" },
      { file: file("arr"), state: "missing" },
      { file: file("comments"), state: "unreadable", note: "not plain JSON (it has comments)" },
      { file: file("none"), state: "missing" },
    ]);
    expect(uninstallPoolEnv(["bb", "gw", "arr", "comments", "none"].map(dir))).toEqual([
      { file: file("bb"), changed: false },
      { file: file("gw"), changed: false },
      { file: file("arr"), changed: false },
      { file: file("comments"), changed: false, skipped: true, note: "not plain JSON (it has comments); not touched" },
      { file: file("none"), changed: false },
    ]);
    for (const [n, text] of Object.entries(before)) expect(readFileSync(file(n), "utf8")).toBe(text);
  });
});

describe("uninstallPoolEnv", () => {
  it("leaves a file we didn't create byte-identical, and deletes one we did once empty", () => {
    const original = '{\n\t"model": "opus",\n\t"env": {\n\t\t"FOO": "1"\n\t}\n}';
    put("tabs", original);
    put("only", '{"env":{}}\n');
    put("mine", '{"env":{"KEEP":"1"}}\n');
    installPoolEnv([dir("tabs"), dir("new"), dir("only"), dir("mine")], o);
    expect(
      uninstallPoolEnv([dir("tabs"), dir("new"), dir("only"), dir("mine")], { created: [file("new"), file("only")] }),
    ).toEqual([
      { file: file("tabs"), changed: true },
      { file: file("new"), changed: true, note: "removed (sessionpipe created it)" },
      { file: file("only"), changed: true, note: "removed (sessionpipe created it)" },
      { file: file("mine"), changed: true },
    ]);
    expect(readFileSync(file("tabs"), "utf8")).toBe(original);
    expect(existsSync(file("new"))).toBe(false);
    expect(JSON.parse(readFileSync(file("mine"), "utf8"))).toEqual({ env: { KEEP: "1" } });
    installPoolEnv([dir("empty")], o);
    expect(uninstallPoolEnv([dir("empty")])[0]).toEqual({ file: file("empty"), changed: true });
    expect(readFileSync(file("empty"), "utf8")).toBe("{}\n");
  });
});

describe("cleanEnv", () => {
  it("strips the pool's variables and nothing else, without touching the given env", () => {
    const env = { PATH: "/bin", ...poolEnv(1, "t"), OTHER: "x" };
    expect(cleanEnv(env)).toEqual({ PATH: "/bin", OTHER: "x" });
    for (const k of POOL_ENV_KEYS) expect(env[k]).toBeDefined();
    expect(cleanEnv()).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
  });
});
