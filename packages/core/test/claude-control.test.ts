// SPDX-License-Identifier: Apache-2.0
// Claude Code as the control daemon drives it: which `claude` runs, what its --help
// says it can do and the permission flags each mode gets (never bypassPermissions),
// its env, its sign-in status, a session's transcript and folder, whether a live
// process holds it, and its result line. Binaries are shell scripts in a temp dir.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  claudeEnv,
  claudeLogin,
  cmpVersion,
  detectCaps,
  findClaude,
  findTranscript,
  isUuid,
  liveProcess,
  loginCommand,
  loginHint,
  modeFlags,
  parseAuthStatus,
  parseCaps,
  parseResult,
  recentlyWritten,
  runClaude,
  sessionFolder,
} from "../src/adapters/claude-code-control.js";

// Several cases spawn a shell; under a full parallel run that can take seconds.
vi.setConfig({ testTimeout: 30_000 });
const tmp = mkdtempSync(path.join(os.tmpdir(), "sp-claude-control-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const SESSION = "ed6c7665-589f-40c7-b7b4-e38ee662b7bc";
const script = (p: string, body: string) => {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
};
const HELP = `Usage: claude [options]

Options:
  -p, --print                    Print response and exit
  --permission-mode <mode>       Permission mode to use for the session (choices: "acceptEdits",
                                 "bypassPermissions", "default", "dontAsk", "plan", "auto")
  --permission-prompts <mode>    How to handle permission prompts (choices: "stdio", "none")
  --fork-session                 Fork to a new session ID
  --include-partial-messages     Include partial message chunks
  -h, --help                     display help
`;

describe("finding claude", () => {
  it("orders the app's versions by number, a missing part as 0", () => {
    expect(cmpVersion("1.9.0", "1.10.0")).toBeLessThan(0);
    expect(cmpVersion("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(cmpVersion("1.10", "1.10.0")).toBe(0);
    expect(cmpVersion("1.9", "1.9.5")).toBeLessThan(0);
    expect(cmpVersion("1.9.5", "1.9")).toBeGreaterThan(0);
  });
  it.runIf(process.platform !== "win32")(
    "the override, then PATH (absolute entries only), then the installers' folders, then the app's newest copy",
    () => {
      const home = path.join(tmp, "home");
      const empty = path.join(tmp, "empty");
      mkdirSync(empty, { recursive: true });
      expect(findClaude({ PATH: `relative:${empty}` }, home)).toBeNull();
      const app = path.join(home, "Library", "Application Support", "Claude", "claude-code");
      const v9 = script(path.join(app, "1.9.0", "claude.app", "Contents", "MacOS", "claude"), "");
      script(path.join(app, "1.10.0", "claude.app", "Contents", "MacOS", "nope"), "");
      mkdirSync(path.join(app, "notes"), { recursive: true });
      expect(findClaude({ PATH: empty }, home)).toBe(v9);
      const v10 = script(path.join(app, "1.10.0", "claude.app", "Contents", "MacOS", "claude"), "");
      expect(findClaude({ PATH: empty }, home)).toBe(v10);
      const local = script(path.join(home, ".claude", "local", "claude"), "");
      expect(findClaude({ PATH: empty }, home)).toBe(local);
      const bin = script(path.join(tmp, "bin", "claude"), "");
      expect(findClaude({ PATH: `${empty}:${path.join(tmp, "bin")}` }, home)).toBe(bin);
      const mine = script(path.join(tmp, "my-claude"), "");
      expect(findClaude({ PATH: path.join(tmp, "bin"), SESSIONPIPE_CLAUDE: mine }, home)).toBe(mine);
      expect(findClaude({ PATH: path.join(tmp, "bin"), SESSIONPIPE_CLAUDE: path.join(tmp, "missing") }, home)).toBe(
        bin,
      );
    },
  );
});

describe("capabilities and mode flags", () => {
  it("reads the option blocks of --help, continuation lines included", () => {
    expect(parseCaps(HELP)).toEqual({
      hasMode: true,
      modes: ["acceptEdits", "bypassPermissions", "default", "dontAsk", "plan", "auto"],
      promptsNone: true,
      fork: true,
      stream: true,
    });
    expect(parseCaps("")).toEqual({ hasMode: false, modes: [], promptsNone: false, fork: false, stream: false });
    expect(parseCaps('  --permission-prompts <m>  (choices: "stdio")\n').promptsNone).toBe(false);
  });
  it("safe never asks or bypasses; auto needs the harness's own auto mode", () => {
    const caps = parseCaps(HELP);
    expect(modeFlags("safe", caps)).toEqual({ args: ["--permission-mode", "dontAsk"] });
    expect(modeFlags("auto", caps)).toEqual({ args: ["--permission-mode", "auto"] });
    const old = { hasMode: true, modes: ["default", "plan"], promptsNone: true, fork: false };
    expect(modeFlags("auto", old)).toEqual({ error: expect.stringContaining("no auto permission mode") });
    expect(modeFlags("safe", old)).toEqual({ args: ["--permission-mode", "default", "--permission-prompts", "none"] });
    expect(modeFlags("safe", { hasMode: true, modes: ["manual"], promptsNone: false, fork: false })).toEqual({
      args: ["--permission-mode", "manual"],
    });
    expect(modeFlags("safe", { hasMode: false, modes: [], promptsNone: false, fork: false })).toEqual({ args: [] });
    for (const m of ["safe", "auto"] as const) expect(JSON.stringify(modeFlags(m, caps))).not.toContain("bypass");
  });
  it.runIf(process.platform !== "win32")(
    "detectCaps runs --help, and reads what a failing claude still printed",
    () => {
      const ok = script(path.join(tmp, "caps-ok"), `printf '%s' '${HELP.replace(/'/g, "")}'`);
      expect(detectCaps(ok).fork).toBe(true);
      const bad = script(path.join(tmp, "caps-bad"), "echo '  --fork-session  x'\nexit 1");
      expect(detectCaps(bad)).toMatchObject({ fork: true, hasMode: false });
      expect(detectCaps(path.join(tmp, "caps-none")).fork).toBe(false);
    },
  );
});

describe("env, login and hints", () => {
  it("claudeEnv drops the in-session markers and names the account's config dir", () => {
    const base = { PATH: "/bin", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "s", CLAUDE_CONFIG_DIR: "/acct" };
    expect(claudeEnv(undefined, base)).toEqual({
      PATH: "/bin",
      CLAUDE_CONFIG_DIR: "/acct",
      SESSIONPIPE_CONTROL_JOB: "1",
    });
    expect(claudeEnv("/work", base).CLAUDE_CONFIG_DIR).toBe("/work");
    expect(claudeEnv(path.join(os.homedir(), ".claude"), base)).not.toHaveProperty("CLAUDE_CONFIG_DIR");
    expect(claudeEnv().SESSIONPIPE_CONTROL_JOB).toBe("1");
  });
  it("parseAuthStatus reads the JSON after any prefix, and says null when it can't", () => {
    expect(parseAuthStatus("")).toEqual({ loggedIn: null });
    expect(parseAuthStatus('warning\n{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}')).toEqual({
      loggedIn: true,
      method: "claude.ai",
      subscription: "max",
    });
    expect(parseAuthStatus('{"loggedIn":false}')).toEqual({ loggedIn: false });
    expect(parseAuthStatus('{"loggedIn":"yes"}')).toEqual({ loggedIn: null });
    expect(parseAuthStatus("{ broken")).toEqual({ loggedIn: null });
  });
  it.runIf(process.platform !== "win32")("claudeLogin asks `auth status --json`", async () => {
    const bin = script(
      path.join(tmp, "auth"),
      '[ "$1 $2 $3" = "auth status --json" ] || exit 9\necho \'{"loggedIn":false}\'\nexit 1',
    );
    expect(await claudeLogin(bin, undefined, { PATH: process.env.PATH })).toEqual({ loggedIn: false });
    expect(await claudeLogin(path.join(tmp, "nope"), "/acct", {})).toEqual({ loggedIn: null });
  });
  it("loginCommand and loginHint name the account dir, and the keychain on a Mac", () => {
    const home = os.homedir();
    expect(loginCommand(undefined)).toBe("`claude auth login`");
    expect(loginCommand(path.join(home, ".claude"))).toBe("`claude auth login`");
    // The dir is shown with the home as `~` and the host's separator after it.
    const work = path.join("~", ".claude-work");
    expect(loginCommand(path.join(home, ".claude-work"))).toBe(`\`CLAUDE_CONFIG_DIR=${work} claude auth login\``);
    expect(loginHint(undefined, "darwin")).toContain("login keychain");
    expect(loginHint(path.join(home, ".claude-work"), "linux")).toBe(
      `Claude Code (${work}) isn't signed in on this machine: run \`CLAUDE_CONFIG_DIR=${work} claude auth login\` there.`,
    );
    expect(loginHint(undefined)).toContain("~/.claude");
  });
});

describe("a session's transcript, folder and process", () => {
  const dir = path.join(tmp, "config");
  const project = "-Users-dev-app";
  const file = path.join(dir, "projects", project, `${SESSION}.jsonl`);
  it("findTranscript looks under projects/ in every config dir, for a UUID only", () => {
    mkdirSync(path.join(dir, "projects", project), { recursive: true });
    mkdirSync(path.join(dir, "projects", "empty"), { recursive: true });
    writeFileSync(path.join(dir, "projects", "stray.txt"), "");
    writeFileSync(file, "");
    expect(findTranscript("short", [dir])).toBeNull();
    expect(findTranscript(SESSION, [path.join(tmp, "no-such"), dir])).toEqual({ file, configDir: dir, project });
    expect(findTranscript("11111111-1111-4111-8111-111111111111", [dir])).toBeNull();
    expect(isUuid(SESSION)).toBe(true);
    expect(isUuid("x")).toBe(false);
  });
  it("sessionFolder: the cwd whose project name is the folder it is filed under, else the first; long lines skipped", () => {
    const t = { file, configDir: dir, project };
    const line = (o: unknown) => `${JSON.stringify(o)}\n`;
    writeFileSync(
      file,
      `${line({ type: "x" })}not json "cwd"\n${line({ cwd: "relative" })}${line({ cwd: "/elsewhere" })}${line({ cwd: "/Users/dev/app" })}`,
    );
    expect(sessionFolder(t)).toBe("/Users/dev/app");
    writeFileSync(file, `${line({ cwd: "/first" })}${line({ cwd: "/second" })}`);
    expect(sessionFolder(t)).toBe("/first");
    // The last line may have no newline; a line over 2 MB is skipped whole.
    writeFileSync(
      file,
      `${line({ pad: "x".repeat(3 * 1024 * 1024), cwd: "/Users/dev/app" })}${JSON.stringify({ cwd: "/tail" })}`,
    );
    expect(sessionFolder(t)).toBe("/tail");
    writeFileSync(file, JSON.stringify({ cwd: "/Users/dev/app" }));
    expect(sessionFolder(t)).toBe("/Users/dev/app");
    writeFileSync(
      file,
      Array(60)
        .fill(line({ cwd: "/other" }))
        .join(""),
    );
    expect(sessionFolder(t)).toBe("/other");
    expect(sessionFolder({ ...t, file: path.join(tmp, "none") })).toBeNull();
    expect(sessionFolder(t, 1)).toBe("/other");
  });
  it("liveProcess: the registry names the session and its pid is alive", () => {
    expect(liveProcess(SESSION, path.join(tmp, "no-such"))).toBe(false);
    const sessions = path.join(dir, "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(path.join(sessions, "notes.json"), "{}");
    writeFileSync(path.join(sessions, "1.json"), "{ broken");
    writeFileSync(path.join(sessions, "2.json"), JSON.stringify({ sessionId: "other", pid: process.pid }));
    writeFileSync(path.join(sessions, "2147483000.json"), JSON.stringify({ sessionId: SESSION }));
    expect(liveProcess(SESSION, dir)).toBe(false);
    writeFileSync(path.join(sessions, "3.json"), JSON.stringify({ sessionId: SESSION, pid: process.pid }));
    expect(liveProcess(SESSION, dir)).toBe(true);
    writeFileSync(path.join(sessions, "3.json"), JSON.stringify({ sessionId: SESSION, pid: 1 }));
    expect(liveProcess(SESSION, dir)).toBe(false);
    writeFileSync(path.join(sessions, `${process.pid}.json`), JSON.stringify({ sessionId: SESSION }));
    expect(liveProcess(SESSION, dir)).toBe(true);
  });
  it("recentlyWritten: within 90 s, and not by a job of ours", () => {
    const f = path.join(tmp, "recent.jsonl");
    writeFileSync(f, "");
    const now = Date.now();
    expect(recentlyWritten(path.join(tmp, "none"), undefined, now)).toBe(false);
    expect(recentlyWritten(f, undefined, now)).toBe(true);
    expect(recentlyWritten(f, now, now)).toBe(false);
    expect(recentlyWritten(f, now - 10_000, now)).toBe(true);
    utimesSync(f, new Date(now - 200_000), new Date(now - 200_000));
    expect(recentlyWritten(f, undefined, now)).toBe(false);
  });
});

describe("the result line", () => {
  it("parseResult: one object, an array's last result, ndjson's last result line, or nothing", () => {
    expect(parseResult("")).toBeNull();
    expect(parseResult('{"type":"result","result":"hi"}')).toEqual({ type: "result", result: "hi" });
    expect(
      parseResult('[{"type":"system"},{"type":"result","result":"a"},{"type":"result","result":"b"},{"type":"x"}]'),
    ).toEqual({ type: "result", result: "b" });
    expect(parseResult('[{"type":"system"}]')).toBeNull();
    expect(parseResult('{"type":"system"}\n{"type":"result","result":"r"}\n{"type":"assistant"}')).toEqual({
      type: "result",
      result: "r",
    });
    expect(parseResult('{"type":"system"}\n{"result":"bare"}')).toEqual({ result: "bare" });
    expect(parseResult("garbage\nmore")).toBeNull();
    expect(parseResult("42")).toBeNull();
  });
  it.runIf(process.platform !== "win32")("runClaude keeps the result line by default", async () => {
    const bin = script(path.join(tmp, "stream"), `printf '{"type":"system"}\\n{"type":"result","result":"ok"}\\n'`);
    const lines: string[] = [];
    const r = await runClaude(bin, [], { cwd: tmp, env: process.env, onLine: (l) => lines.push(l) });
    expect(lines).toHaveLength(2);
    expect(r.stdout).toBe('{"type":"result","result":"ok"}');
    const all = await runClaude(bin, [], { cwd: tmp, env: process.env, onLine: () => {}, keep: () => true });
    expect(all.stdout).toBe('{"type":"result","result":"ok"}');
  });
});
