// SPDX-License-Identifier: Apache-2.0
// Install writes only our entries; uninstall leaves every config file byte-identical
// to before — with someone else's hooks in place, on every harness's file shape.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AG_STALE_PRETOOL,
  antigravity,
  antigravityAnswer,
  claudeCode,
  codex,
  geminiCli,
} from "../src/adapters/index.js";
import type { HookCommand } from "../src/adapters/types.js";

let home: string;
let env: NodeJS.ProcessEnv;
const cmd: HookCommand = (a) => ({
  argv: ["/usr/local/bin/node", "/opt/sessionpipe/dist/hook.js", ...a],
  command: `"/usr/local/bin/node" "/opt/sessionpipe/dist/hook.js" ${a.join(" ")}`,
});
const cmd2: HookCommand = (a) => ({
  argv: ["/new/node", "/new/sessionpipe/dist/hook.js", ...a],
  command: `"/new/node" "/new/sessionpipe/dist/hook.js" ${a.join(" ")}`,
});

// The real Claude Code settings, before and after the whole file: a run must leave them alone.
const realSettings = path.join(os.homedir(), ".claude", "settings.json");
const realBefore = existsSync(realSettings) ? readFileSync(realSettings, "utf8") : null;
afterAll(() => {
  expect(existsSync(realSettings) ? readFileSync(realSettings, "utf8") : null).toBe(realBefore);
});

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "sp-install-"));
  env = {
    // Its own HOME: nothing here may touch the real ~/.claude (this test once rewrote
    // the real settings.json with the fake hook paths below on every run).
    HOME: home,
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    CODEX_HOME: path.join(home, ".codex"),
    GEMINI_CLI_HOME: path.join(home, ".gemini"),
  };
  mkdirSync(path.join(home, ".claude"), { recursive: true });
  mkdirSync(path.join(home, ".codex"), { recursive: true });
  mkdirSync(path.join(home, ".gemini", "config"), { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("install / uninstall", () => {
  it("claude-code: adds one entry per event beside a foreign hook, re-install is a no-op, uninstall restores bytes", () => {
    const file = path.join(home, ".claude", "settings.json");
    const before = `${JSON.stringify({ model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "/other/tool stop", timeout: 10 }] }] } }, null, 2)}\n`;
    writeFileSync(file, before);
    // claudeDirs() reads ~/.claude from the real home too; restrict to the env dir by checking the reports for our file.
    const r1 = claudeCode.install(cmd, env).filter((r) => r.file === file);
    expect(r1[0]?.changed).toBe(true);
    const after = JSON.parse(readFileSync(file, "utf8"));
    expect(after.model).toBe("opus");
    expect(after.hooks.Stop).toHaveLength(2);
    expect(after.hooks.Stop[0].hooks[0].command).toBe("/other/tool stop");
    expect(after.hooks.PreToolUse[0].matcher).toBe("");
    expect(after.hooks.SessionStart[0].matcher).toBeUndefined();
    expect(claudeCode.install(cmd, env).filter((r) => r.file === file)[0]?.changed).toBe(false);
    expect(claudeCode.installed(cmd, env).find((r) => r.file === file)?.state).toBe("current");
    // A moved node path is "stale" and a re-install replaces ours only.
    expect(claudeCode.installed(cmd2, env).find((r) => r.file === file)?.state).toBe("stale");
    claudeCode.install(cmd2, env);
    expect(JSON.parse(readFileSync(file, "utf8")).hooks.Stop).toHaveLength(2);
    claudeCode.uninstall(env);
    expect(readFileSync(file, "utf8")).toBe(before);
  });
  it("codex: hooks.json plus a top-level notify before the first [table]; uninstall restores both", () => {
    const toml = path.join(home, ".codex", "config.toml");
    const before = 'model = "gpt-6"\n\n[projects."/x"]\ntrust_level = "trusted"\n';
    writeFileSync(toml, before);
    codex.install(cmd, env);
    const text = readFileSync(toml, "utf8");
    expect(text.indexOf("notify = ")).toBeLessThan(text.indexOf("[projects"));
    expect(text).toContain('"codex","notify"]');
    expect(codex.installed(cmd, env).map((r) => r.state)).toEqual(["current", "current"]);
    // A misplaced line (inside the table) is detected and moved.
    writeFileSync(toml, `${before}notify = ${JSON.stringify(cmd(["codex", "notify"]).argv)}\n`);
    expect(codex.installed(cmd, env)[1]?.state).toBe("misplaced");
    codex.install(cmd, env);
    expect(codex.installed(cmd, env)[1]?.state).toBe("current");
    codex.uninstall(env);
    expect(readFileSync(toml, "utf8")).toBe(before);
    expect(JSON.parse(readFileSync(path.join(home, ".codex", "hooks.json"), "utf8"))).toEqual({});
  });
  it("codex: another tool's notify is chained through --previous-notify only for Computer Use, else left alone", () => {
    const toml = path.join(home, ".codex", "config.toml");
    writeFileSync(toml, 'notify = ["/Applications/X/SkyComputerUseClient", "turn-ended"]\n');
    const r = codex.install(cmd, env)[1];
    expect(r?.note).toContain("chained");
    expect(readFileSync(toml, "utf8")).toContain("--previous-notify");
    codex.uninstall(env);
    expect(readFileSync(toml, "utf8")).toBe('notify = ["/Applications/X/SkyComputerUseClient", "turn-ended"]\n');
    writeFileSync(toml, 'notify = ["/usr/bin/say", "done"]\n');
    expect(codex.install(cmd, env)[1]?.note).toContain("left alone");
    expect(readFileSync(toml, "utf8")).toBe('notify = ["/usr/bin/say", "done"]\n');
  });
  it("gemini-cli: settings.json hooks with millisecond timeouts", () => {
    const file = path.join(home, ".gemini", "settings.json");
    writeFileSync(file, '{\n  "theme": "dark"\n}\n');
    geminiCli.install(cmd, env);
    const s = JSON.parse(readFileSync(file, "utf8"));
    expect(s.theme).toBe("dark");
    expect(s.hooks.BeforeTool[0].hooks[0].timeout).toBe(5000);
    expect(s.hooks.BeforeTool[0].matcher).toBe(".*");
    geminiCli.uninstall(env);
    expect(readFileSync(file, "utf8")).toBe('{\n  "theme": "dark"\n}\n');
  });
  it("antigravity: one named group, {} on stdout, uninstall removes only it", () => {
    const file = path.join(home, ".gemini", "config", "hooks.json");
    const before = `${JSON.stringify({ "other-hook": { enabled: true, Stop: [{ type: "command", command: "x", timeout: 5 }] } }, null, 2)}\n`;
    writeFileSync(file, before);
    antigravity.install(cmd, env);
    const j = JSON.parse(readFileSync(file, "utf8"));
    expect(j["other-hook"]).toBeDefined();
    expect(j.sessionpipe.PostToolUse[0].matcher).toBe("*");
    expect(j.sessionpipe.Stop[0].timeout).toBe(5);
    expect(antigravity.fromHook({ argv: ["antigravity", "Stop"], stdin: "not json", env: {}, cwd: "/" })?.stdout).toBe(
      "{}\n",
    );
    antigravity.uninstall(env);
    expect(readFileSync(file, "utf8")).toBe(before);
  });
  it("antigravity: never hooks PreToolUse, whose `{}` is a deny; an older install's entry is stale and replaced", () => {
    const file = path.join(home, ".gemini", "config", "hooks.json");
    antigravity.install(cmd, env);
    expect(JSON.parse(readFileSync(file, "utf8")).sessionpipe.PreToolUse).toBeUndefined();
    antigravity.install(cmd, env, { lean: false });
    expect(JSON.parse(readFileSync(file, "utf8")).sessionpipe.PreToolUse).toBeUndefined();
    // What 0.1–0.6.0 wrote: the same group plus a PreToolUse one.
    const old = JSON.parse(readFileSync(file, "utf8"));
    old.sessionpipe = {
      enabled: true,
      PreInvocation: old.sessionpipe.PreInvocation,
      PostInvocation: old.sessionpipe.PostInvocation,
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "hook antigravity PreToolUse", timeout: 5 }] }],
      PostToolUse: old.sessionpipe.PostToolUse,
      Stop: old.sessionpipe.Stop,
    };
    writeFileSync(file, `${JSON.stringify(old, null, 2)}\n`);
    expect(antigravity.installed(cmd, env)[0]?.state).toBe("stale");
    expect(antigravity.install(cmd, env)[0]?.changed).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).sessionpipe.PreToolUse).toBeUndefined();
    expect(antigravity.installed(cmd, env)[0]?.state).toBe("current");
  });
  it("antigravity: a leftover PreToolUse entry asks the person, with why, instead of a silent deny", () => {
    const pre = { toolCall: { name: "run_command", args: { CommandLine: "ls" } }, stepIdx: 3, conversationId: "c1" };
    for (const stdin of [JSON.stringify(pre), "not json"]) {
      const out = antigravity.fromHook({ argv: ["antigravity", "PreToolUse"], stdin, env: {}, cwd: "/" })?.stdout ?? "";
      const a = JSON.parse(out);
      expect(a.decision).toBe("ask");
      expect(a.reason).toMatch(/sessionpipe/);
      expect(out).toBe(AG_STALE_PRETOOL);
    }
    expect(antigravityAnswer("PostToolUse")).toBe("{}\n");
  });
  it("antigravity: PostToolUse names no tool, so it is a beat; a named one still ends the tool", () => {
    const base = { conversationId: "c1", stepIdx: 4 };
    const beat = antigravity.fromHook({
      argv: ["antigravity", "PostToolUse"],
      stdin: JSON.stringify(base),
      env: {},
      cwd: "/",
    });
    expect(beat?.events.map((e) => e.type)).toEqual(["session.heartbeat"]);
    expect(beat?.stdout).toBe("{}\n");
    const named = antigravity.fromHook({
      argv: ["antigravity", "PostToolUse"],
      stdin: JSON.stringify({ ...base, toolCall: { name: "view_file" }, error: "nope" }),
      env: {},
      cwd: "/",
    });
    expect(named?.events[0]).toMatchObject({ type: "tool.ended", data: { tool: "view_file", ok: false } });
  });
});

describe("issue #8: files that are not plain JSON, and byte-identical round trips", () => {
  it("leaves a settings.json with a comment untouched and says why", () => {
    const file = path.join(home, ".gemini", "settings.json");
    const before =
      '{\n  // Gemini CLI accepts comments in this file\n  "security": { "auth": { "selectedType": "oauth-personal" } }\n}\n';
    writeFileSync(file, before);
    const r = geminiCli.install(cmd, env)[0]!;
    expect(r.skipped).toBe(true);
    expect(r.note).toContain("comments");
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(geminiCli.uninstall(env)[0]?.skipped).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(before);
  });
  it("reads a settings.json with a byte-order mark, hooks it, and writes the mark back", () => {
    const file = path.join(home, ".gemini", "settings.json");
    const before = '\uFEFF{\r\n  "theme": "dark"\r\n}\r\n';
    writeFileSync(file, before);
    expect(geminiCli.install(cmd, env)[0]?.changed).toBe(true);
    const after = readFileSync(file, "utf8");
    expect(after.startsWith('\uFEFF{\r\n  "theme": "dark",\r\n  "hooks"')).toBe(true);
    geminiCli.uninstall(env);
    expect(readFileSync(file, "utf8")).toBe(before);
  });
  it("keeps a file's indent and missing final newline", () => {
    const file = path.join(home, ".gemini", "settings.json");
    const before = '{\n    "theme": "dark"\n}';
    writeFileSync(file, before);
    geminiCli.install(cmd, env);
    const after = readFileSync(file, "utf8");
    expect(after.startsWith('{\n    "theme": "dark",\n    "hooks"')).toBe(true);
    expect(after.endsWith("\n")).toBe(false);
    geminiCli.uninstall(env);
    expect(readFileSync(file, "utf8")).toBe(before);
  });
  it("keeps a CRLF config.toml byte-identical through a codex install and uninstall", () => {
    mkdirSync(path.join(home, ".codex"), { recursive: true });
    const file = path.join(home, ".codex", "config.toml");
    const before = 'model = "gpt-5"\r\napproval_policy = "on-request"\r\n';
    writeFileSync(file, before);
    codex.install(cmd, env);
    expect(readFileSync(file, "utf8")).toMatch(
      /^model = "gpt-5"\r\napproval_policy = "on-request"\r\nnotify = \[.*\]\r\n$/,
    );
    codex.uninstall(env, { created: [path.join(home, ".codex", "hooks.json")] });
    expect(readFileSync(file, "utf8")).toBe(before);
  });
  it("deletes a file sessionpipe created once uninstall empties it", () => {
    const file = path.join(home, ".codex", "hooks.json");
    const r = codex.install(cmd, env)[0]!;
    expect(r.created).toBe(true);
    codex.uninstall(env, { created: [file] });
    expect(existsSync(file)).toBe(false);
  });
});

describe("issue #12: a lean install hooks one tool event", () => {
  it("claude-code: no PreToolUse or PostToolUseFailure without a tier-1 sink; a later full install adds them", () => {
    const file = path.join(home, ".claude", "settings.json");
    claudeCode.install(cmd, env, { lean: true });
    const lean = JSON.parse(readFileSync(file, "utf8")).hooks;
    expect(lean.PostToolUse).toBeDefined();
    expect(lean.PreToolUse).toBeUndefined();
    expect(lean.PostToolUseFailure).toBeUndefined();
    expect(lean.StopFailure).toBeDefined();
    expect(claudeCode.installed(cmd, env, { lean: true }).find((r) => r.file === file)?.state).toBe("current");
    expect(claudeCode.installed(cmd, env, { lean: false }).find((r) => r.file === file)?.state).toBe("stale");
    claudeCode.install(cmd, env, { lean: false });
    expect(JSON.parse(readFileSync(file, "utf8")).hooks.PreToolUse).toBeDefined();
    expect(claudeCode.installed(cmd, env, { lean: true }).find((r) => r.file === file)?.state).toBe("stale");
  });
});

describe("--status-line: Claude Code's limits come only through a status line", () => {
  const file = () => path.join(home, ".claude", "settings.json");
  const mine = (r: { file: string }) => r.file === file();
  const line = () => JSON.parse(readFileSync(file(), "utf8")).statusLine;

  it("writes ours where there is none, keeps it while current, and uninstall restores the bytes", () => {
    const before = `${JSON.stringify({ model: "opus" }, null, 2)}\n`;
    writeFileSync(file(), before);
    const r1 = claudeCode.install(cmd, env, { statusLine: true }).filter(mine);
    expect(r1.map((r) => r.note)).toEqual([undefined, "status line written (account limits)"]);
    expect(line()).toEqual({ type: "command", command: cmd(["claude-code", "StatusLine"]).command });
    expect(claudeCode.install(cmd, env, { statusLine: true }).filter(mine)).toHaveLength(1);
    // Left alone when the person said nothing either way; a moved node path is rewritten.
    claudeCode.install(cmd2, env);
    expect(line().command).toBe(cmd(["claude-code", "StatusLine"]).command);
    claudeCode.install(cmd2, env, { statusLine: true });
    expect(line().command).toBe(cmd2(["claude-code", "StatusLine"]).command);
    claudeCode.uninstall(env);
    expect(readFileSync(file(), "utf8")).toBe(before);
  });
  it("never replaces a status line of the person's own, and says so", () => {
    writeFileSync(file(), JSON.stringify({ statusLine: { type: "command", command: "~/bin/my-line" } }));
    const r = claudeCode.install(cmd, env, { statusLine: true }).filter(mine);
    expect(r[1]).toMatchObject({
      changed: false,
      skipped: true,
      note: "a status line of your own is set; limits are not read",
    });
    expect(line().command).toBe("~/bin/my-line");
    claudeCode.uninstall(env);
    expect(line().command).toBe("~/bin/my-line");
  });
  it("--no-status-line takes ours away, and is nothing to do when there is none", () => {
    claudeCode.install(cmd, env, { statusLine: true });
    expect(claudeCode.install(cmd, env, { statusLine: false }).filter(mine)[1]?.note).toBe("status line removed");
    expect(line()).toBeUndefined();
    expect(claudeCode.install(cmd, env, { statusLine: false }).filter(mine)).toHaveLength(1);
  });
  it("uninstall reports the status line when it was all of ours left, and deletes a file it created", () => {
    claudeCode.install(cmd, env, { statusLine: true });
    const hooksOnly = JSON.parse(readFileSync(file(), "utf8"));
    delete hooksOnly.hooks;
    writeFileSync(file(), JSON.stringify(hooksOnly));
    expect(claudeCode.uninstall(env).find(mine)).toMatchObject({ changed: true, note: "status line removed" });
    rmSync(file());
    const created = claudeCode.install(cmd, env, { statusLine: true }).filter(mine);
    expect(created[0]?.created).toBe(true);
    claudeCode.uninstall(env, { created: [file()] });
    expect(existsSync(file())).toBe(false);
  });
  it("a file that is not plain JSON gets one report, the hooks' refusal", () => {
    writeFileSync(file(), "{ // mine\n}");
    const r = claudeCode.install(cmd, env, { statusLine: true }).filter(mine);
    expect(r).toHaveLength(1);
    expect(r[0]?.skipped).toBe(true);
  });
});
