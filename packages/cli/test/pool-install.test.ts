// SPDX-License-Identifier: Apache-2.0
// The `env` block in Claude Code's settings.json: written in the file's own shape,
// removed byte-identically, never over someone else's values (a loopback router is not
// ours: SECURITY M1), never into a file that isn't plain JSON, made 0600 once it carries
// our bearer, followed through a symlink, and kept out of a dir anyone can write to
// (SECURITY H1).
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
const posix = process.platform !== "win32";

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
  it("rewrites our own block for a new port or token, and still knows the port it moved from and the token before", () => {
    installPoolEnv([dir("a")], o);
    expect(installedPoolEnv([dir("a")], { port: 4556, token: "tok_abc" })[0]?.state).toBe("stale");
    expect(installPoolEnv([dir("a")], { port: 4556, token: "other", lastToken: "tok_abc" })[0]).toEqual({
      file: file("a"),
      changed: true,
      created: false,
    });
    expect(JSON.parse(readFileSync(file("a"), "utf8")).env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4556");
    // Neither port nor token known any more: not ours. With last_port or the old token: ours.
    expect(installedPoolEnv([dir("a")], { port: 1, token: "x" })[0]?.state).toBe("other");
    expect(installedPoolEnv([dir("a")], { port: 1, token: "x", lastPort: 4556 })[0]?.state).toBe("stale");
    expect(installedPoolEnv([dir("a")], { port: 1, token: "x", lastToken: "other" })[0]?.state).toBe("stale");
    expect(installPoolEnv([dir("a")], { port: 1, token: "x", lastPort: 4556 })[0]?.changed).toBe(true);
  });
  it("H1: the file is 0600 once it carries the bearer, a symlink is followed and named, a loose dir is skipped", () => {
    if (!posix) return;
    put("plain", "{}\n");
    chmodSync(file("plain"), 0o644);
    mkdirSync(dir("dotfiles"));
    writeFileSync(path.join(dir("dotfiles"), "claude-settings.json"), '{"a":1}\n');
    mkdirSync(dir("linked"));
    symlinkSync(path.join(dir("dotfiles"), "claude-settings.json"), file("linked"));
    const real = realpathSync(path.join(dir("dotfiles"), "claude-settings.json"));
    mkdirSync(dir("loose"), { mode: 0o777 });
    chmodSync(dir("loose"), 0o777);
    const r = installPoolEnv([dir("plain"), dir("linked"), dir("loose"), dir("fresh")], o);
    expect(r).toEqual([
      { file: file("plain"), changed: true, created: false },
      {
        file: real,
        changed: true,
        created: false,
        note: `a symlink; the token is in ${real}`,
      },
      { file: file("loose"), changed: false, skipped: true, note: "skipped: the config dir is group/world-writable" },
      { file: file("fresh"), changed: true, created: true },
    ]);
    expect(statSync(file("plain")).mode & 0o777).toBe(0o600);
    expect(statSync(file("fresh")).mode & 0o777).toBe(0o600);
    expect(statSync(dir("fresh")).mode & 0o777).toBe(0o700);
    expect(lstatSync(file("linked")).isSymbolicLink()).toBe(true);
    expect(statSync(real).mode & 0o777).toBe(0o600);
    expect(existsSync(file("loose"))).toBe(false);
    expect(installedPoolEnv([dir("loose"), dir("linked")], o)).toEqual([
      { file: file("loose"), state: "unsafe", note: "the config dir is group/world-writable" },
      { file: real, state: "current" },
    ]);
    expect(installPoolEnv([dir("linked")], o)[0]).toEqual({
      file: real,
      changed: false,
      note: `a symlink; the token is in ${real}`,
    });
    expect(uninstallPoolEnv([dir("linked")], o)[0]).toEqual({
      file: real,
      changed: true,
    });
    expect(readFileSync(real, "utf8")).toBe('{\n  "a": 1\n}\n');
  });
  it("M1: never touches values someone else set, loopback or not, a non-object env, or a file that isn't plain JSON", () => {
    put(
      "router",
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "http://127.0.0.1:3456",
          ANTHROPIC_AUTH_TOKEN: "ccr-secret",
          _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "0",
        },
      }),
    );
    put(
      "bb",
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:3456/v1/bb", ANTHROPIC_AUTH_TOKEN: "bb" } }),
    );
    put("token-only", JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "sk-ant-personal" } }));
    put("flag-only", JSON.stringify({ env: { _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1" } }));
    put("gw", JSON.stringify({ env: { ANTHROPIC_BASE_URL: ["x"] } }));
    put("arr", JSON.stringify({ env: [] }));
    put("comments", '{\n  // hello\n  "a": 1\n}\n');
    put("broken", "{nope");
    put("list", "[1]");
    const names = ["router", "bb", "token-only", "flag-only", "gw", "arr", "comments", "broken", "list"];
    const before = Object.fromEntries(names.map((n) => [n, readFileSync(file(n), "utf8")]));
    expect(installPoolEnv(names.map(dir), o)).toEqual([
      {
        file: file("router"),
        changed: false,
        skipped: true,
        note: "skipped: already set by someone else (ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL)",
      },
      {
        file: file("bb"),
        changed: false,
        skipped: true,
        note: "skipped: already set by someone else (ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN)",
      },
      {
        file: file("token-only"),
        changed: false,
        skipped: true,
        note: "skipped: already set by someone else (ANTHROPIC_AUTH_TOKEN)",
      },
      {
        file: file("flag-only"),
        changed: false,
        skipped: true,
        note: "skipped: already set by someone else (_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL)",
      },
      {
        file: file("gw"),
        changed: false,
        skipped: true,
        note: "skipped: already set by someone else (ANTHROPIC_BASE_URL)",
      },
      { file: file("arr"), changed: false, skipped: true, note: "env is not an object; not touched" },
      { file: file("comments"), changed: false, skipped: true, note: "not plain JSON (it has comments); not touched" },
      { file: file("broken"), changed: false, skipped: true, note: "not plain JSON; not touched" },
      { file: file("list"), changed: false, skipped: true, note: "not a JSON object; not touched" },
    ]);
    for (const [n, text] of Object.entries(before)) expect(readFileSync(file(n), "utf8")).toBe(text);
    expect(installedPoolEnv(["router", "token-only", "gw", "arr", "comments", "none"].map(dir), o)).toEqual([
      { file: file("router"), state: "other", note: "ANTHROPIC_BASE_URL is http://127.0.0.1:3456" },
      { file: file("token-only"), state: "other", note: "ANTHROPIC_BASE_URL is unset" },
      { file: file("gw"), state: "other", note: "ANTHROPIC_BASE_URL is x" },
      { file: file("arr"), state: "missing" },
      { file: file("comments"), state: "unreadable", note: "not plain JSON (it has comments)" },
      { file: file("none"), state: "missing" },
    ]);
    expect(uninstallPoolEnv(["router", "token-only", "arr", "comments", "none"].map(dir), o)).toEqual([
      { file: file("router"), changed: false, skipped: true, note: "left alone: set by someone else" },
      { file: file("token-only"), changed: false, skipped: true, note: "left alone: set by someone else" },
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
      uninstallPoolEnv([dir("tabs"), dir("new"), dir("only"), dir("mine")], {
        ...o,
        created: [file("new"), file("only")],
      }),
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
    // Off with only the previous token known (a rotation under way) still finds it.
    expect(uninstallPoolEnv([dir("empty")], { port: 1, token: "new", lastToken: "tok_abc" })[0]).toEqual({
      file: file("empty"),
      changed: true,
    });
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

describe("what the soak found", () => {
  it("F6: with a keep dir, off gives back the file's own bytes, inline arrays included; edits made meanwhile win", () => {
    if (!posix) return;
    const keep = path.join(tmp, "keep");
    const original = '{\n  "permissions": { "allow": ["Bash", "Read"] },\n  "model": "opus"\n}\n';
    put("inline", original);
    put("edited", original);
    put("fresh", "{}\n");
    installPoolEnv([dir("inline"), dir("edited"), dir("fresh")], { ...o, keep });
    expect(readFileSync(file("inline"), "utf8")).not.toBe(original);
    expect(statSync(keep).mode & 0o777).toBe(0o700);
    expect(readdirSync(keep).length).toBe(3);
    for (const f of readdirSync(keep)) expect(statSync(path.join(keep, f)).mode & 0o777).toBe(0o600);
    // On again (a rotation) keeps the first copy, not the reformatted one.
    installPoolEnv([dir("inline")], { ...o, token: "tok_2", lastToken: o.token, keep });
    writeFileSync(file("edited"), readFileSync(file("edited"), "utf8").replace('"opus"', '"sonnet"'));
    const r = uninstallPoolEnv([dir("inline"), dir("edited"), dir("fresh"), dir("none")], {
      ...o,
      token: "tok_2",
      keep,
    });
    expect(r.map((x) => x.changed)).toEqual([true, true, true, false]);
    expect(readFileSync(file("inline"), "utf8")).toBe(original);
    expect(JSON.parse(readFileSync(file("edited"), "utf8"))).toEqual({
      permissions: { allow: ["Bash", "Read"] },
      model: "sonnet",
    });
    expect(readFileSync(file("edited"), "utf8")).not.toBe(original);
    expect(readFileSync(file("fresh"), "utf8")).toBe("{}\n");
    expect(readdirSync(keep)).toEqual([]);
    // A kept copy that is not JSON any more (someone wrote in the keep dir): the formatted file.
    installPoolEnv([dir("inline")], { ...o, keep });
    writeFileSync(path.join(keep, readdirSync(keep)[0]!), "{broken");
    uninstallPoolEnv([dir("inline")], { ...o, keep });
    expect(JSON.parse(readFileSync(file("inline"), "utf8"))).toEqual({
      permissions: { allow: ["Bash", "Read"] },
      model: "opus",
    });
    // Without a keep dir, as before: valid, same meaning, JSON.stringify's layout.
    installPoolEnv([dir("inline")], o);
    uninstallPoolEnv([dir("inline")], o);
    expect(JSON.parse(readFileSync(file("inline"), "utf8"))).toEqual({
      permissions: { allow: ["Bash", "Read"] },
      model: "opus",
    });
  });
  it("F7: a file created in a config dir reached through a symlink is removed again by off", () => {
    if (!posix) return;
    const real = dir("linked-real");
    mkdirSync(real);
    const link = path.join(tmp, "linked-dir");
    symlinkSync(real, link);
    const on = installPoolEnv([link], o);
    const created = on.filter((r) => r.created).map((r) => r.file);
    expect(created).toEqual([path.join(link, "settings.json")]);
    const off = uninstallPoolEnv([real], { ...o, created });
    expect(off[0]).toMatchObject({ changed: true, note: "removed (sessionpipe created it)" });
    expect(existsSync(path.join(real, "settings.json"))).toBe(false);
    // A created path that no longer resolves is compared as written.
    installPoolEnv([link], o);
    expect(uninstallPoolEnv([link], { ...o, created: [path.join(tmp, "gone", "settings.json")] })[0]).toEqual({
      file: path.join(link, "settings.json"),
      changed: true,
    });
  });
});
