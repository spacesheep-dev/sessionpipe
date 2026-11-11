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
  CLAUDE_MODES,
  claudeEnv,
  claudeLogin,
  cmpVersion,
  detectCaps,
  findClaude,
  findTranscript,
  findTranscripts,
  helpFailure,
  homeSettings,
  hookMode,
  initSession,
  isUuid,
  liveProcess,
  loginCommand,
  loginHint,
  modeFlags,
  modeRank,
  NO_HOME_SETTINGS,
  offeredLevels,
  parseAuthStatus,
  parseCaps,
  parseResult,
  peerClass,
  recentlyWritten,
  recentWrite,
  resolveHome,
  runClaude,
  sessionFolder,
  versionManagerBins,
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
  it.runIf(process.platform !== "win32")(
    "a node version manager's folders come after the installers' and before the app: nvm's newest node, fnm, volta, asdf",
    () => {
      const home = path.join(tmp, "vm-home");
      const empty = path.join(tmp, "vm-empty");
      mkdirSync(empty, { recursive: true });
      const env = { PATH: empty };
      expect(versionManagerBins(env, home)).toEqual([path.join(home, ".volta", "bin")]);
      const app = script(
        path.join(
          home,
          "Library",
          "Application Support",
          "Claude",
          "claude-code",
          "2.0.0",
          "claude.app",
          "Contents",
          "MacOS",
          "claude",
        ),
        "",
      );
      expect(findClaude(env, home)).toBe(app);
      const asdf = script(path.join(home, ".asdf", "installs", "nodejs", "22.1.0", "bin", "claude"), "");
      expect(findClaude(env, home)).toBe(asdf);
      const volta = script(path.join(home, ".volta", "bin", "claude"), "");
      expect(findClaude(env, home)).toBe(volta);
      const fnm = script(
        path.join(home, ".local", "share", "fnm", "node-versions", "v20.0.0", "installation", "bin", "claude"),
        "",
      );
      expect(findClaude(env, home)).toBe(fnm);
      const old = script(path.join(home, ".nvm", "versions", "node", "v9.11.2", "bin", "claude"), "");
      expect(findClaude(env, home)).toBe(old);
      const nvm = script(path.join(home, ".nvm", "versions", "node", "v22.1.0", "bin", "claude"), "");
      mkdirSync(path.join(home, ".nvm", "versions", "node", "notes"), { recursive: true });
      expect(findClaude(env, home)).toBe(nvm);
      // The variables the managers set name their folders instead.
      const nvmDir = script(path.join(tmp, "nvm-elsewhere", "versions", "node", "v24.0.0", "bin", "claude"), "");
      expect(findClaude({ ...env, NVM_DIR: path.join(tmp, "nvm-elsewhere") }, home)).toBe(nvmDir);
      expect(findClaude({ ...env, NVM_DIR: path.join(tmp, "nowhere") }, home)).toBe(fnm);
      expect(
        versionManagerBins(
          { ...env, FNM_DIR: path.join(tmp, "f"), VOLTA_HOME: path.join(tmp, "v"), ASDF_DATA_DIR: path.join(tmp, "a") },
          home,
        ).slice(-1),
      ).toEqual([path.join(tmp, "v", "bin")]);
      const local = script(path.join(home, ".local", "bin", "claude"), "");
      expect(findClaude(env, home)).toBe(local);
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
    // Claude Code 2.1.310 wraps the choices over three lines, and has `manual` for `default`.
    const v310 = `  --permission-mode <mode>              Permission mode to use for the session
                                        (choices: "acceptEdits", "auto",
                                        "bypassPermissions", "manual",
                                        "dontAsk", "plan")
`;
    expect(parseCaps(v310).modes).toEqual(["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"]);
  });
  it("safe never asks or bypasses; auto needs the harness's own auto mode; inherit passes nothing", () => {
    const caps = parseCaps(HELP);
    expect(modeFlags("safe", caps)).toEqual({ args: ["--permission-mode", "dontAsk"] });
    expect(modeFlags("auto", caps)).toEqual({ args: ["--permission-mode", "auto"] });
    // Inherit: no flag at all, so Claude Code starts in its settings' defaultMode.
    expect(modeFlags("inherit", caps)).toEqual({ args: [] });
    const old = { hasMode: true, modes: ["default", "plan"], promptsNone: true, fork: false };
    expect(modeFlags("auto", old)).toEqual({ error: expect.stringContaining("no auto permission mode") });
    // A Claude Code too old for --permission-mode, or for one mode in particular, still
    // runs an inherit turn: there is nothing for it to refuse.
    expect(modeFlags("inherit", old)).toEqual({ args: [] });
    expect(modeFlags("inherit", { hasMode: false, modes: [], promptsNone: false, fork: false })).toEqual({ args: [] });
    expect(modeFlags("safe", old)).toEqual({ args: ["--permission-mode", "default", "--permission-prompts", "none"] });
    expect(modeFlags("safe", { hasMode: true, modes: ["manual"], promptsNone: false, fork: false })).toEqual({
      args: ["--permission-mode", "manual"],
    });
    expect(modeFlags("safe", { hasMode: false, modes: [], promptsNone: false, fork: false })).toEqual({ args: [] });
    for (const m of ["safe", "auto", "inherit"] as const)
      expect(JSON.stringify(modeFlags(m, caps))).not.toContain("bypass");
  });
  it.runIf(process.platform !== "win32")(
    "detectCaps runs --help, and reads what a failing claude still printed",
    () => {
      const ok = script(path.join(tmp, "caps-ok"), `printf '%s' '${HELP.replace(/'/g, "")}'`);
      expect(detectCaps(ok).fork).toBe(true);
      expect(detectCaps(ok)).not.toHaveProperty("unread");
      const bad = script(path.join(tmp, "caps-bad"), "echo '  --fork-session  x'\nexit 1");
      expect(detectCaps(bad)).toMatchObject({ fork: true, hasMode: false });
      expect(detectCaps(path.join(tmp, "caps-none")).fork).toBe(false);
      // A failing run that still printed its modes is a read.
      const printed = script(path.join(tmp, "caps-printed"), `printf '%s' '${HELP.replace(/'/g, "")}'\nexit 1`);
      expect(detectCaps(printed)).toMatchObject({ hasMode: true, modes: expect.arrayContaining(["auto", "dontAsk"]) });
      expect(detectCaps(printed)).not.toHaveProperty("unread");
    },
  );
  it.runIf(process.platform !== "win32")(
    "a --help that times out, or fails before it lists its modes, is unread, never a claude with no modes (#152)",
    () => {
      // The Intel's daemon started 82 s after a reboot, beside 28 other Claude Code
      // processes: its --help took longer than the timeout, and nothing was printed.
      const slow = script(path.join(tmp, "caps-slow"), "exec sleep 5");
      expect(detectCaps(slow, 200)).toEqual({
        hasMode: false,
        modes: [],
        promptsNone: false,
        fork: false,
        stream: false,
        unread: "`caps-slow --help` timed out after 0.2 s",
      });
      const failed = script(path.join(tmp, "caps-failed"), "echo '  --fork-session  x'\nexit 1");
      expect(detectCaps(failed)).toMatchObject({ fork: true, unread: "`caps-failed --help` failed with exit code 1" });
      expect(detectCaps(path.join(tmp, "caps-missing")).unread).toBe("`caps-missing --help` failed: no such file");
    },
  );
  it.runIf(process.platform !== "win32")("a --help that fails says why, in the run's own first line of stderr", () => {
    // My Solid, 2026-11-09: the pinned claude was an npm script and the service's PATH
    // had no node. The refusal said "failed"; the person had nothing to act on.
    const nonode = script(
      path.join(tmp, "caps-nonode"),
      "echo 'env: node: No such file or directory' >&2\necho 'second line' >&2\nexit 127",
    );
    expect(detectCaps(nonode).unread).toBe("`caps-nonode --help` failed: env: node: No such file or directory");
    expect(modeFlags("auto", detectCaps(nonode))).toEqual({
      error:
        "this machine couldn't read its Claude Code's options (`caps-nonode --help` failed: env: node: No such file or directory); try again in a minute",
    });
    const noexec = path.join(tmp, "caps-noexec");
    writeFileSync(noexec, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    expect(detectCaps(noexec).unread).toBe("`caps-noexec --help` failed: the file can't be run (permission denied)");
  });
  it("helpFailure is one clean line: no escape codes, no home folder, no secret, no more than 200 characters", () => {
    expect(
      helpFailure(
        {
          status: 1,
          stderr: "\n\u001b[31mError:\u001b[0m   Cannot find module '/Users/ada/.npm/claude/cli.js'\n  at x\n",
        },
        "/Users/ada",
      ),
    ).toBe("failed: Error: Cannot find module '~/.npm/claude/cli.js'");
    const secret = `sk-ant-api03-${"a".repeat(86)}-AA`;
    const leaked = helpFailure({ status: 1, stderr: `bad key ${secret} for ada@example.com` }, "/Users/ada");
    expect(leaked).not.toContain(secret);
    expect(leaked).not.toContain("ada@example.com");
    expect(leaked.startsWith("failed: bad key ")).toBe(true);
    const long = helpFailure({ status: 1, stderr: "x".repeat(900) });
    expect(long.length).toBe("failed: ".length + 200);
    expect(long.endsWith("…")).toBe(true);
    expect(helpFailure({ status: 1, stderr: Buffer.from("boom\r\n") })).toBe("failed: boom");
    expect(helpFailure({ status: 3, stderr: "  \n\t\n" })).toBe("failed with exit code 3");
    expect(helpFailure({ status: null, signal: "SIGKILL", stderr: "" })).toBe("failed: killed by SIGKILL");
    expect(helpFailure({ code: "ENOENT" })).toBe("failed: no such file");
    expect(helpFailure({ code: "EACCES", stderr: "ignored" })).toBe(
      "failed: the file can't be run (permission denied)",
    );
    expect(helpFailure(null)).toBe("failed");
    expect(helpFailure({})).toBe("failed");
  });
  it("caps whose --help couldn't be read refuse every level but inherit, and say why", () => {
    const unread = {
      hasMode: false,
      modes: [],
      promptsNone: false,
      fork: false,
      unread: "`claude --help` timed out after 30 s",
    };
    // Auto was refused as a mode this Claude Code lacks, and safe ran with no flag at all,
    // so the settings' defaultMode decided.
    for (const level of ["read", "safe", "edits", "auto"] as const)
      expect(modeFlags(level, unread)).toEqual({
        error:
          "this machine couldn't read its Claude Code's options (`claude --help` timed out after 30 s); try again in a minute",
      });
    expect(modeFlags("inherit", unread)).toEqual({ args: [] });
    // And no start is offered: an offered safe would be taken and run with no flag.
    for (const mode of ["safe", "auto", "inherit"] as const) expect(offeredLevels(mode, unread)).toEqual([]);
  });
});

describe("env, login and hints", () => {
  it("claudeEnv drops the in-session markers and any lineage, and names the account's config dir", () => {
    const base = {
      PATH: "/bin",
      CLAUDECODE: "1",
      CLAUDE_CODE_SESSION_ID: "s",
      CLAUDE_CONFIG_DIR: "/acct",
      // A daemon started from inside an asked session: none of this is the child's.
      SESSIONPIPE_ASKED_BY: "codex:a1",
      SESSIONPIPE_ASK_CHAIN: "codex:a1",
      SESSIONPIPE_LAUNCHED_BY: "codex:a1",
    };
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
  it("a session is the one filed under exactly that id: a disk that ignores case does not make another spelling the same session", () => {
    mkdirSync(path.join(dir, "projects", project), { recursive: true });
    writeFileSync(file, "");
    const shouted = SESSION.toUpperCase();
    expect(shouted).not.toBe(SESSION);
    // On macOS and Windows the file opens under either spelling. Nothing else on the
    // machine knows the session by the other one: not its registry row, not its hooks.
    expect(findTranscript(shouted, [dir])).toBeNull();
    expect(findTranscripts(shouted, [dir])).toEqual([]);
    expect(resolveHome(shouted, [dir])).toBeNull();
    expect(findTranscript(SESSION, [dir])).toEqual({ file, configDir: dir, project });
    // Whether an id is free for a new session is the other question: one that differs
    // from a session's only by case would be written into that session's file there.
    expect(findTranscript(shouted, [dir], { anySpelling: true })).toEqual({ file, configDir: dir, project });
    expect(findTranscript(SESSION, [dir], { anySpelling: true })).toEqual({ file, configDir: dir, project });
    expect(findTranscript("11111111-1111-4111-8111-111111111111", [dir], { anySpelling: true })).toBeNull();
    // A folder of that name is no transcript, under either rule.
    const other = "22222222-2222-4222-8222-222222222222";
    mkdirSync(path.join(dir, "projects", project, `${other}.jsonl`));
    expect(findTranscript(other, [dir])).toBeNull();
    expect(findTranscript(other, [dir], { anySpelling: true })).toBeNull();
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
  it("recentlyWritten: within 90 s, and not before an end the caller knows of (a job of its own, the session's own)", () => {
    const f = path.join(tmp, "recent.jsonl");
    writeFileSync(f, "");
    const now = Date.now();
    expect(recentlyWritten(path.join(tmp, "none"), undefined, now)).toBe(false);
    expect(recentlyWritten(f, undefined, now)).toBe(true);
    expect(recentlyWritten(f, now, now)).toBe(false);
    expect(recentlyWritten(f, now - 10_000, now)).toBe(true);
    utimesSync(f, new Date(now - 200_000), new Date(now - 200_000));
    expect(recentlyWritten(f, undefined, now)).toBe(false);
    // The rule on its own: the last 90 s, unless a run known to have ended accounts for it.
    expect(recentWrite(now - 5000, undefined, now)).toBe(true);
    expect(recentWrite(now - 91_000, undefined, now)).toBe(false);
    expect(recentWrite(now - 7000, now - 6900, now)).toBe(false);
    expect(recentWrite(now - 3000, now - 4500, now)).toBe(false);
    expect(recentWrite(now - 1000, now - 5000, now)).toBe(true);
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
  it("initSession: the session a streamed run says it is, from its init line and no other", () => {
    const sid = "0b6f2c7e-3d4a-4f1b-9c8e-2a1d5e6f7a8b";
    expect(initSession(JSON.stringify({ type: "system", subtype: "init", session_id: sid, tools: [] }))).toBe(sid);
    // A result line, another system line, an id that isn't one, a line that isn't JSON,
    // and a line that only quotes the word.
    expect(initSession(JSON.stringify({ type: "result", result: "ok", session_id: sid }))).toBeNull();
    expect(initSession(JSON.stringify({ type: "system", subtype: "status", session_id: sid }))).toBeNull();
    expect(initSession(JSON.stringify({ type: "assistant", subtype: "init", session_id: sid }))).toBeNull();
    expect(initSession(JSON.stringify({ type: "system", subtype: "init", session_id: "x" }))).toBeNull();
    expect(initSession('{"type":"system","subtype":"init"')).toBeNull();
    expect(initSession('"init"')).toBeNull();
    expect(initSession('null "init"')).toBeNull();
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

describe("an npm claude.cmd shim (#165)", () => {
  // What `npm install -g @anthropic-ai/claude-code` leaves on Windows: a .cmd that node
  // refuses to spawn without a shell. Its script is run under this node instead.
  const dir = path.join(tmp, "npm-shim");
  const cli = path.join(dir, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
  mkdirSync(path.dirname(cli), { recursive: true });
  writeFileSync(
    cli,
    `const a = process.argv.slice(2).join(" ");
if (a === "--help") process.stdout.write(${JSON.stringify(HELP)});
else if (a === "auth status --json") process.stdout.write('{"loggedIn":true,"authMethod":"claude.ai"}');
else process.exit(9);
`,
  );
  const shim = path.join(dir, "claude.cmd");
  writeFileSync(
    shim,
    `@ECHO off\r\nSETLOCAL\r\nSET dp0=%~dp0\r\n"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n`,
  );
  it("detectCaps reads its --help, and claudeLogin its auth status, with no shell", async () => {
    expect(detectCaps(shim)).toMatchObject({ hasMode: true, fork: true, modes: expect.arrayContaining(["auto"]) });
    expect(await claudeLogin(shim, undefined, { PATH: process.env.PATH })).toEqual({
      loggedIn: true,
      method: "claude.ai",
    });
  });
  it("a .cmd that names no script is asked through a shell, and a failed answer is no login", async () => {
    const bare = path.join(dir, "bare.cmd");
    writeFileSync(bare, "exit 1\r\n");
    expect(detectCaps(bare)).toMatchObject({ hasMode: false });
    expect(await claudeLogin(bare, undefined, { PATH: process.env.PATH })).toEqual({ loggedIn: null });
  });
});

describe("the mode a session's own hooks report", () => {
  it("hookMode takes either spelling of a known mode, from the payload's own field", () => {
    expect(hookMode({ permission_mode: "bypassPermissions" })).toBe("bypassPermissions");
    expect(hookMode({ permissionMode: "acceptEdits" })).toBe("acceptEdits");
    // Both spellings: Claude Code's hook field wins over its transcript's.
    expect(hookMode({ permission_mode: "plan", permissionMode: "auto" })).toBe("plan");
    expect(hookMode({ permission_mode: "sudo" })).toBeNull();
    expect(hookMode({ permission_mode: 7 })).toBeNull();
    expect(hookMode({ tool_input: { text: "permission_mode: bypassPermissions" } })).toBeNull();
    expect(hookMode({})).toBeNull();
    expect(hookMode(null)).toBeNull();
    expect(hookMode("default")).toBeNull();
  });
  it("peerClass: bypass, prompting, or no class at all", () => {
    expect(peerClass("bypassPermissions")).toBe("bypass");
    for (const m of ["default", "manual", "dontAsk", "acceptEdits"]) expect(peerClass(m)).toBe("prompting");
    // `plan`'s class depends on a capability and a TTY this code can't see; `auto` is
    // neither; nothing recorded is neither.
    for (const m of ["plan", "auto", "nonsense", null, undefined]) expect(peerClass(m)).toBeNull();
  });
  it("homeSettings reads the three keys something acts on, under permissions or at the top level", () => {
    const dir = path.join(tmp, "home-settings");
    mkdirSync(dir, { recursive: true });
    const write = (j: unknown) => writeFileSync(path.join(dir, "settings.json"), JSON.stringify(j));
    // No file, a file that isn't JSON, a file that isn't an object.
    expect(homeSettings(path.join(tmp, "no-such-home"))).toEqual(NO_HOME_SETTINGS);
    writeFileSync(path.join(dir, "settings.json"), "{ broken");
    expect(homeSettings(dir)).toEqual(NO_HOME_SETTINGS);
    write([1, 2]);
    expect(homeSettings(dir)).toEqual(NO_HOME_SETTINGS);
    write(null);
    expect(homeSettings(dir)).toEqual(NO_HOME_SETTINGS);
    write({});
    expect(homeSettings(dir)).toEqual(NO_HOME_SETTINGS);
    write({ permissions: "nope" });
    expect(homeSettings(dir)).toEqual(NO_HOME_SETTINGS);
    write({ permissions: { defaultMode: "nonsense" } });
    expect(homeSettings(dir).defaultMode).toBeNull();
    write({ permissions: { defaultMode: 7 } });
    expect(homeSettings(dir).defaultMode).toBeNull();
    write({ permissions: { defaultMode: "bypassPermissions" } });
    expect(homeSettings(dir)).toEqual({
      defaultMode: "bypassPermissions",
      disableAutoMode: false,
      disableBypass: false,
    });
    write({ permissions: { disableAutoMode: "disable", disableBypassPermissionsMode: "disable" } });
    expect(homeSettings(dir)).toMatchObject({ disableAutoMode: true, disableBypass: true });
    // Written by hand at the top level, which is where Claude Code's older docs put them.
    write({ disableAutoMode: "disable", disableBypassPermissionsMode: "disable" });
    expect(homeSettings(dir)).toMatchObject({ disableAutoMode: true, disableBypass: true });
    write({ permissions: { disableAutoMode: true } });
    expect(homeSettings(dir).disableAutoMode).toBe(false);
    // No config dir named: this account's own home.
    const home = path.join(tmp, "as-home");
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    writeFileSync(
      path.join(home, ".claude", "settings.json"),
      JSON.stringify({ permissions: { defaultMode: "plan" } }),
    );
    expect(homeSettings(undefined, home).defaultMode).toBe("plan");
  });
  it("modeRank is what a turn may do without being asked, and an unknown mode is nowhere", () => {
    expect(modeRank("plan")).toBeLessThan(modeRank("acceptEdits"));
    expect(modeRank("acceptEdits")).toBeLessThan(modeRank("auto"));
    expect(modeRank("auto")).toBeLessThan(modeRank("bypassPermissions"));
    // Manual, default and dontAsk share a step: none of them lets anything through that
    // needs approval, so none is wider than the others.
    expect(modeRank("dontAsk")).toBe(modeRank("default"));
    expect(modeRank("manual")).toBe(modeRank("default"));
    expect(modeRank("nonsense")).toBe(-1);
    expect(modeRank(null)).toBe(-1);
    expect(modeRank(undefined)).toBe(-1);
    expect(CLAUDE_MODES).toContain("dontAsk");
  });
});
