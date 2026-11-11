// SPDX-License-Identifier: Apache-2.0
// The Grok Build adapter: where its hooks go, how a payload maps, the transcript it
// reads for tier 2, and the summary it reads for facts. Payloads are the ones recorded
// from Grok Build 1.0.77 (conformance/harness/grok-build), cut to what a test reads.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeCode, notClaudeCode } from "../src/adapters/claude-code.js";
import { GROK_EVENTS, grokBuild, grokHome, grokVersion, isGrokPayload } from "../src/adapters/grok-build.js";
import type { HookCommand } from "../src/adapters/types.js";
import { readGrok } from "../src/readers/transcripts.js";

const cmd: HookCommand = (a) => ({
  argv: ["/usr/local/bin/node", "/opt/sessionpipe/dist/hook.js", ...a],
  command: `"/usr/local/bin/node" "/opt/sessionpipe/dist/hook.js" ${a.join(" ")}`,
});
const cmd2: HookCommand = (a) => ({
  argv: ["/new/node", "/new/sessionpipe/dist/hook.js", ...a],
  command: `"/new/node" "/new/sessionpipe/dist/hook.js" ${a.join(" ")}`,
});

const ID = "01a1cc23-be41-73d0-be8a-6d4594c93ae2";
let home: string;
let env: NodeJS.ProcessEnv;
let hooksFile: string;

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "sp-grok-"));
  // Its own HOME: nothing here may reach the real ~/.grok.
  env = { HOME: home };
  hooksFile = grokBuild.configFiles(env)[0] as string;
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** What Grok puts in every payload, with its own keys and Claude Code's. */
const common = (event: string, snake: string, more: Record<string, unknown> = {}) => ({
  hookEventName: snake,
  hook_event_name: event,
  sessionId: ID,
  session_id: ID,
  cwd: "/tmp/rec/grok-proj",
  workspaceRoot: "/tmp/rec/grok-proj",
  timestamp: "2026-11-11T19:44:17.121309+00:00",
  permissionMode: "default",
  permission_mode: "default",
  ...more,
});
const hook = (event: string, payload: unknown, e: Record<string, string | undefined> = {}, cwd = "/elsewhere") =>
  grokBuild.fromHook({
    argv: ["grok-build", event],
    stdin: typeof payload === "string" ? payload : JSON.stringify(payload),
    env: e,
    cwd,
  });

describe("grok-build: where it lives", () => {
  it("is ~/.grok, or GROK_HOME, and is here once that folder is", () => {
    expect(grokHome(env)).toBe(path.join(home, ".grok"));
    expect(grokHome({ GROK_HOME: "/opt/grok" })).toBe("/opt/grok");
    expect(grokHome({})).toBe(path.join(os.homedir(), ".grok"));
    expect(typeof grokHome()).toBe("string");
    expect(grokBuild.detect(env)).toBe(false);
    mkdirSync(path.join(home, ".grok"));
    expect(grokBuild.detect(env)).toBe(true);
    expect(typeof grokBuild.detect()).toBe("boolean");
    expect(grokBuild.configFiles()).toHaveLength(1);
    expect(hooksFile).toBe(path.join(home, ".grok", "hooks", "sessionpipe.json"));
    expect(grokBuild.events).toBe(GROK_EVENTS);
  });
});

describe("grok-build: install / uninstall / installed", () => {
  it("writes a hooks file of its own, one entry per event, and removes it again", () => {
    expect(grokBuild.installed(cmd, env)[0]?.state).toBe("missing");
    const r = grokBuild.install(cmd, env);
    expect(r[0]).toMatchObject({ file: hooksFile, changed: true, created: true });
    const file = JSON.parse(readFileSync(hooksFile, "utf8"));
    expect(Object.keys(file)).toEqual(["hooks"]);
    expect(Object.keys(file.hooks).sort()).toEqual([...GROK_EVENTS].sort());
    // An omitted matcher matches everything; only a prompt waiting on the person is attention.
    expect(file.hooks.PreToolUse[0].matcher).toBeUndefined();
    expect(file.hooks.Notification[0].matcher).toBe("permission_prompt");
    // Timeouts are SECONDS.
    expect(file.hooks.Stop[0].hooks[0]).toEqual({
      type: "command",
      command: `"/usr/local/bin/node" "/opt/sessionpipe/dist/hook.js" grok-build Stop`,
      timeout: 5,
    });
    expect(grokBuild.install(cmd, env)[0]?.changed).toBe(false);
    expect(grokBuild.installed(cmd, env)[0]).toEqual({ file: hooksFile, state: "current" });
    expect(grokBuild.installed(cmd2, env)[0]?.state).toBe("stale");
    expect(grokBuild.uninstall(env, { created: [hooksFile] })[0]?.changed).toBe(true);
    expect(existsSync(hooksFile)).toBe(false);
  });

  it("a lean install hooks no PreToolUse, and an uninstall with nothing remembered leaves the emptied file", () => {
    grokBuild.install(cmd, env, { lean: true });
    const file = JSON.parse(readFileSync(hooksFile, "utf8"));
    expect(file.hooks.PreToolUse).toBeUndefined();
    expect(file.hooks.PostToolUse).toHaveLength(1);
    expect(grokBuild.installed(cmd, env, { lean: true })[0]?.state).toBe("current");
    expect(grokBuild.installed(cmd, env)[0]?.state).toBe("stale");
    grokBuild.uninstall(env);
    expect(JSON.parse(readFileSync(hooksFile, "utf8"))).toEqual({});
    // With the process's own environment the call still names one file and touches nothing of ours.
    expect(grokBuild.uninstall()[0]?.file).toMatch(/sessionpipe\.json$/);
    expect(grokBuild.installed(cmd)[0]?.file).toMatch(/sessionpipe\.json$/);
  });

  it("installs with the process's own environment when none is given", () => {
    const was = process.env.GROK_HOME;
    process.env.GROK_HOME = path.join(home, "own");
    try {
      expect(grokBuild.install(cmd)[0]?.created).toBe(true);
      expect(existsSync(path.join(home, "own", "hooks", "sessionpipe.json"))).toBe(true);
    } finally {
      if (was === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = was;
    }
  });
});

describe("grok-build: a payload becomes events", () => {
  it("a session starts new or is loaded again, and ends", () => {
    expect(hook("SessionStart", common("SessionStart", "session_start", { source: "new" }))).toMatchObject({
      session: { id: ID, cwd: "/tmp/rec/grok-proj" },
      events: [{ type: "session.started", data: { source: "startup" }, harnessEvent: "SessionStart" }],
    });
    expect(hook("SessionStart", common("SessionStart", "session_start", { source: "load" }))?.events[0]?.data).toEqual({
      source: "resume",
    });
    expect(hook("SessionStart", common("SessionStart", "session_start"))?.events[0]?.data).toEqual({
      source: "unknown",
    });
    const end = (reason: unknown) =>
      hook("SessionEnd", common("SessionEnd", "session_end", { reason }))?.events[0]?.data;
    expect(end("shutdown")).toEqual({ reason: "exit" });
    expect(end("clear")).toEqual({ reason: "clear" });
    expect(end("logout")).toEqual({ reason: "logout" });
    expect(end("exit")).toEqual({ reason: "exit" });
    expect(end("something new")).toEqual({ reason: "other" });
  });

  it("a prompt starts a turn, named by promptId, and its words ride as a hint only", () => {
    const r = hook(
      "UserPromptSubmit",
      common("UserPromptSubmit", "user_prompt_submit", { promptId: "p-1", prompt: "héllo 👋" }),
    );
    expect(r?.events).toEqual([
      { type: "turn.started", data: { turn_id: "p-1", prompt_chars: 7 }, harnessEvent: "UserPromptSubmit" },
    ]);
    expect(r?.hints).toEqual({ prompt: "héllo 👋" });
    // No prompt and no id at all: still a turn, with nothing guessed.
    const bare = hook("UserPromptSubmit", common("UserPromptSubmit", "user_prompt_submit", { prompt_id: "p-2" }));
    expect(bare?.events[0]?.data).toEqual({ turn_id: "p-2" });
    expect(bare?.hints).toEqual({});
  });

  it("a tool starts and ends, with Claude Code's keys or Grok's own", () => {
    const transcript = `/home/rec/.grok/sessions/x/${ID}/updates.jsonl`;
    const pre = hook(
      "PreToolUse",
      common("PreToolUse", "pre_tool_use", {
        tool_name: "read_file",
        tool_use_id: "call-1",
        tool_input: { target_file: "/tmp/a" },
        transcript_path: transcript,
      }),
    );
    expect(pre?.events).toEqual([
      {
        type: "tool.started",
        data: { tool: "read_file", call_id: "call-1", input: { target_file: "/tmp/a" } },
        harnessEvent: "PreToolUse",
      },
    ]);
    expect(pre?.transcript).toBe(transcript);
    // Grok's own keys alone (a payload without the Claude twins).
    const post = hook("PostToolUse", {
      hookEventName: "post_tool_use",
      sessionId: ID,
      workspaceRoot: "/w",
      toolName: "run_terminal_command",
      toolUseId: "call-2",
      toolInput: { command: "ls" },
      toolResult: { type: "Bash" },
      durationMs: 127.4,
      transcriptPath: transcript,
    });
    expect(post?.session).toEqual({ id: ID, cwd: "/elsewhere" });
    expect(post?.events[0]?.data).toEqual({
      tool: "run_terminal_command",
      call_id: "call-2",
      ms: 127,
      ok: true,
      input: { command: "ls" },
      output: { type: "Bash" },
    });
    expect(post?.transcript).toBe(transcript);
    // A tool name that is not a tool name reports nothing, on each tool event.
    for (const [event, snake] of [
      ["PreToolUse", "pre_tool_use"],
      ["PostToolUse", "post_tool_use"],
      ["PostToolUseFailure", "post_tool_use_failure"],
    ] as const)
      expect(hook(event, common(event, snake, { tool_name: "not a tool!" }))?.events).toEqual([]);
  });

  it("a tool that failed says so, in the words it was given", () => {
    const fail = (more: Record<string, unknown>) =>
      hook("PostToolUseFailure", common("PostToolUseFailure", "post_tool_use_failure", { tool_name: "t", ...more }))
        ?.events[0]?.data;
    expect(fail({ error: "no such server", duration_ms: 3 })).toEqual({
      tool: "t",
      ms: 3,
      ok: false,
      error: "no such server",
    });
    expect(fail({ tool_response: { message: "refused" } })).toEqual({
      tool: "t",
      ok: false,
      error: "refused",
      output: { message: "refused" },
    });
    expect(fail({ tool_response: { error: "timeout" } })?.error).toBe("timeout");
    expect(fail({ tool_response: { code: 7 } })?.error).toBeUndefined();
    expect(fail({})).toEqual({ tool: "t", ok: false });
  });

  it("a prompt waiting on the person is attention", () => {
    const r = hook(
      "Notification",
      common("Notification", "notification", {
        notification_type: "permission_prompt",
        message: `Tool permission requested${"!".repeat(300)}`,
      }),
    );
    expect(r?.events[0]).toMatchObject({ type: "attention.needed", data: { kind: "permission" } });
    expect(String(r?.events[0]?.data.attention_id)).toMatch(/^notif-\d+$/);
    expect(String(r?.events[0]?.data.message)).toHaveLength(200);
    // With the call it is about, the call's id names it and the tool is said.
    const named = hook(
      "Notification",
      common("Notification", "notification", { tool_use_id: "call-9", tool_name: "write" }),
    );
    expect(named?.events[0]?.data).toEqual({ attention_id: "call-9", kind: "permission", tool: "write" });
  });

  it("a turn ends: finished, failed, or cut short; the Stop at shutdown ends none", () => {
    const stop = hook(
      "Stop",
      common("Stop", "stop", { promptId: "p-1", reason: "end_turn", last_assistant_message: "done" }),
    );
    expect(stop?.events).toEqual([
      { type: "turn.ended", data: { turn_id: "p-1", reason: "stop" }, harnessEvent: "Stop" },
    ]);
    expect(stop?.hints).toEqual({ final: "done" });
    // Grok's own key for the last words, and blank words are no words.
    expect(hook("Stop", common("Stop", "stop", { lastAssistantMessage: "ok" }))?.hints).toEqual({ final: "ok" });
    expect(hook("Stop", common("Stop", "stop", { last_assistant_message: "  " }))?.hints).toEqual({});
    expect(hook("Stop", common("Stop", "stop", { reason: "shutdown" }))).toBeNull();
    const failed = (more: Record<string, unknown>) =>
      hook("StopFailure", common("StopFailure", "stop_failure", { promptId: "p-1", ...more }))?.events[0]?.data;
    expect(failed({ error: "rate_limit" })).toEqual({ turn_id: "p-1", reason: "error", error: "rate_limit" });
    expect(failed({ errorType: "server_error" })?.error).toBe("server_error");
    expect(failed({ error_type: "unknown" })?.error).toBe("unknown");
    expect(failed({})).toEqual({ turn_id: "p-1", reason: "error" });
    expect(
      hook("StopCancelled", common("StopCancelled", "stop_cancelled", { promptId: "p-1", reason: "max_turns" }))
        ?.events,
    ).toEqual([{ type: "turn.ended", data: { turn_id: "p-1", reason: "interrupt" }, harnessEvent: "StopCancelled" }]);
  });

  it("a compaction says what set it off", () => {
    const c = (trigger: unknown) => hook("PreCompact", common("PreCompact", "pre_compact", { trigger }))?.events[0];
    expect(c("manual")).toMatchObject({ type: "context.compacted", data: { trigger: "manual" } });
    expect(c("auto")?.data).toEqual({ trigger: "auto" });
  });

  it("reports nothing for what is not a payload, not a session, or not an event of ours", () => {
    expect(hook("Stop", "")).toBeNull();
    expect(hook("Stop", "{not json")).toBeNull();
    expect(hook("Stop", "null")).toBeNull();
    expect(hook("Stop", "[1]")).toBeNull();
    expect(hook("Stop", { cwd: "/x" })).toBeNull();
    expect(hook("Stop", { session_id: "has a space" })).toBeNull();
    expect(hook("SubagentStart", common("SubagentStart", "subagent_start"))).toBeNull();
    expect(
      grokBuild.fromHook({ argv: ["grok-build"], stdin: JSON.stringify(common("x", "x")), env: {}, cwd: "/" }),
    ).toBeNull();
  });

  it("the folder comes from the payload, then from Grok's own variable, then from the hook's", () => {
    const bare = { hookEventName: "session_start", sessionId: ID, workspaceRoot: "/w" };
    expect(hook("SessionStart", bare, { GROK_WORKSPACE_ROOT: "/from/env" })?.session.cwd).toBe("/from/env");
    expect(hook("SessionStart", bare)?.session.cwd).toBe("/elsewhere");
  });
});

describe("grok-build: Claude Code's entry stays out of a Grok session", () => {
  // Grok imports ~/.claude/settings.json hooks and hands them a payload with Claude
  // Code's keys, a UUID session and a transcript path: everything notClaudeCode looked for.
  it("tells a Grok payload by Grok's own two keys", () => {
    const grok = common("Stop", "stop", { transcript_path: `/home/rec/.grok/sessions/x/${ID}/updates.jsonl` });
    expect(isGrokPayload(grok)).toBe(true);
    expect(notClaudeCode(ID, grok)).toBe(true);
    expect(
      claudeCode.fromHook({ argv: ["claude-code", "Stop"], stdin: JSON.stringify(grok), env: {}, cwd: "/" }),
    ).toBeNull();
    const claude = { hook_event_name: "Stop", session_id: ID, transcript_path: "/home/rec/.claude/projects/p/x.jsonl" };
    expect(isGrokPayload(claude)).toBe(false);
    expect(isGrokPayload({ hookEventName: "stop" })).toBe(false);
    expect(notClaudeCode(ID, claude)).toBe(false);
  });
});

const line = (update: Record<string, unknown>, timestamp: unknown = 1794426257, method = "session/update") =>
  JSON.stringify({ timestamp, method, params: { sessionId: ID, update } });
const said = (who: "user" | "agent", text: unknown, timestamp?: unknown) =>
  line({ sessionUpdate: `${who}_message_chunk`, content: { type: "text", text } }, timestamp);
const done = (prompt_id: unknown) =>
  line({ sessionUpdate: "turn_completed", prompt_id, stop_reason: "end_turn" }, 1794426272, "_x.ai/session/update");

describe("grok-build: the transcript", () => {
  it("pairs a prompt with what the agent said, names the turn, and skips what is not words", () => {
    const lines = [
      line({ sessionUpdate: "hook_execution", event_name: "session_start" }, 1794426257, "_x.ai/session/update"),
      said("user", "Read note.txt"),
      line({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } }),
      said("agent", "I'll read it."),
      line({ sessionUpdate: "tool_call", toolCallId: "c1", title: "read_file" }),
      said("agent", "It says hello.", 1794426270),
      done("p-1"),
      said("user", "And again?", 1794426300),
      said("agent", "hello"),
      done("p-2"),
      "",
    ];
    const r = readGrok(lines, 0);
    expect(r.turns).toEqual([
      { user: "Read note.txt", assistant: "I'll read it.\n\nIt says hello.", at: 1794426257000, endLine: 5, id: "p-1" },
      { user: "And again?", assistant: "hello", at: 1794426300000, endLine: 8, id: "p-2" },
    ]);
    expect(r.line).toBe(10);
    expect(r.tail).toEqual({ start: 7, said: "hello" });
    // From the second turn on: only that one.
    expect(readGrok(lines, 7).turns).toHaveLength(1);
  });

  it("joins chunks that follow one another, and leaves a prompt with no reply open", () => {
    const lines = [
      said("user", "one "),
      said("user", "prompt"),
      said("agent", "Hel"),
      said("agent", "lo"),
      "{not json",
      said("agent", ""),
      said("agent", " again"),
      done(42),
      done("late"),
      said("user", "still waiting", "soon"),
    ];
    const r = readGrok(lines, 0);
    // The line that does not parse breaks nothing; the empty chunk ends the run before it.
    expect(r.turns).toEqual([expect.objectContaining({ user: "one prompt", assistant: "Hello\n\nagain", id: "late" })]);
    expect(r.open?.user).toBe("still waiting");
    expect(r.open?.at).toBeGreaterThan(1794426257000);
    expect(r.line).toBe(9);
  });

  it("keeps who asked when sessionpipe handed the task over, and drops words that are only space", () => {
    const framed =
      "Reply with exactly: ready\n\n(Asked by claude-code:abc on this machine with sessionpipe ask. Answer here in full: your reply is returned to that session automatically. Don't run a command or call a tool just to send it.)";
    const r = readGrok(
      [
        said("user", framed),
        said("agent", "ready"),
        line({ sessionUpdate: "agent_message_chunk", content: { type: "image" } }),
        line({ sessionUpdate: "agent_message_chunk" }),
        said("user", "   "),
        JSON.stringify({ timestamp: 1, method: "x" }),
        JSON.stringify({ timestamp: 1, method: "x", params: {} }),
      ],
      0,
    );
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0]?.user).toContain("Reply with exactly: ready");
    expect(r.turns[0]?.user).toContain("(Asked by claude-code:abc");
    expect(r.turns[0]?.assistant).toBe("ready");
  });

  it("reads the file the hook named, and nothing from one that is not there", () => {
    const file = path.join(home, "updates.jsonl");
    writeFileSync(file, `${[said("user", "hi"), said("agent", "hello"), done("p-1")].join("\n")}\n`);
    expect(grokBuild.readTranscript(file, 0).turns).toEqual([
      { user: "hi", assistant: "hello", at: 1794426257000, endLine: 1, id: "p-1" },
    ]);
    expect(grokBuild.readTranscript(path.join(home, "absent.jsonl"), 4)).toEqual({ turns: [], line: 4 });
  });
});

const summary = (more: Record<string, unknown> = {}) => ({
  info: { id: ID, cwd: "/tmp/rec/grok-proj" },
  created_at: "2026-11-11T19:44:16.973091Z",
  updated_at: "2026-11-11T19:44:30.000000Z",
  last_active_at: "2026-11-11T19:44:32.789824Z",
  current_model_id: "grok-4.7",
  generated_title: "Read note.txt, write out.txt, run ls",
  head_branch: "main",
  ...more,
});
function session(id: string, sum: unknown, transcript = true): string {
  const dir = path.join(home, ".grok", "sessions", "%2Ftmp%2Frec%2Fgrok-proj", id);
  mkdirSync(dir, { recursive: true });
  if (sum !== undefined)
    writeFileSync(path.join(dir, "summary.json"), typeof sum === "string" ? sum : JSON.stringify(sum));
  if (transcript) writeFileSync(path.join(dir, "updates.jsonl"), "");
  return dir;
}
const state = { get: () => ({}), save: () => {} };

describe("grok-build: facts", () => {
  it("reads the session's summary beside its transcript, and the installed version", () => {
    const dir = session(ID, summary());
    writeFileSync(path.join(home, ".grok", "version.json"), JSON.stringify({ version: "1.0.77" }));
    expect(grokVersion(env)).toBe("1.0.77");
    expect(grokBuild.facts({ id: ID }, path.join(dir, "updates.jsonl"), {}, state, env)).toEqual({
      harness_version: "1.0.77",
      cwd: "/tmp/rec/grok-proj",
      model: "grok-4.7",
      started_at: Date.parse("2026-11-11T19:44:16.973091Z"),
      last_at: Date.parse("2026-11-11T19:44:32.789824Z"),
      title: "Read note.txt, write out.txt, run ls",
      title_source: "harness",
      branch: "main",
    });
    // With no transcript named, the session is found by its id.
    expect(grokBuild.facts({ id: ID }, undefined, {}, state, env).model).toBe("grok-4.7");
  });

  it("says only what the files say", () => {
    writeFileSync(path.join(mkdirSync(path.join(home, ".grok"), { recursive: true }) as string, "version.json"), "{}");
    expect(grokVersion(env)).toBeUndefined();
    expect(typeof grokVersion()).not.toBe("number");
    // No session anywhere, an id that could not be a folder, and no sessions folder at all.
    expect(grokBuild.facts({ id: ID }, undefined, {}, state, env)).toEqual({});
    expect(grokBuild.facts({ id: "../x" }, undefined, {}, state, env)).toEqual({});
    expect(grokBuild.facts({ id: ID }, undefined, {}, state)).toBeTypeOf("object");
    const long = `${"word ".repeat(30)}end`;
    const dir = session(
      ID,
      summary({
        info: { cwd: "relative/path" },
        current_model_id: "",
        created_at: "never",
        last_active_at: undefined,
        generated_title: `\n  ${long}\nsecond line`,
        head_branch: "",
      }),
    );
    const f = grokBuild.facts({ id: ID }, path.join(dir, "updates.jsonl"), {}, state, env);
    expect(f.cwd).toBeUndefined();
    expect(f.model).toBeUndefined();
    expect(f.started_at).toBeUndefined();
    expect(f.last_at).toBe(Date.parse("2026-11-11T19:44:30.000000Z"));
    expect(f.title?.endsWith("…")).toBe(true);
    expect(f.title?.length).toBeLessThanOrEqual(81);
    expect(f.branch).toBeUndefined();
    const none = session(
      "other",
      summary({ info: undefined, generated_title: "  ", updated_at: undefined, last_active_at: undefined }),
    );
    const g = grokBuild.facts({ id: "other" }, path.join(none, "updates.jsonl"), {}, state, env);
    expect(g.title).toBeUndefined();
    expect(g.last_at).toBeUndefined();
    const untitled = session("third", summary({ generated_title: 7 }));
    expect(
      grokBuild.facts({ id: "third" }, path.join(untitled, "updates.jsonl"), {}, state, env).title,
    ).toBeUndefined();
  });
});

describe("grok-build: backfill", () => {
  it("lists the sessions active since, newest first, with the transcript each has", () => {
    session(ID, summary());
    session("older", summary({ last_active_at: "2026-11-01T00:00:00Z", created_at: "2026-11-01T00:00:00Z" }));
    session("newer", summary({ last_active_at: "2026-11-12T00:00:00Z" }), false);
    session("no-times", { info: { cwd: "/x" } });
    session("not json", "{oops");
    session("bad id!", summary());
    writeFileSync(path.join(home, ".grok", "sessions", "session_search.sqlite"), "");
    const rows = grokBuild.backfill(Date.parse("2026-11-10T00:00:00Z"), env);
    expect(rows.map((r) => r.session.id)).toEqual(["newer", ID]);
    expect(rows[0]?.transcript).toBeUndefined();
    expect(rows[1]).toMatchObject({
      session: { id: ID, cwd: "/tmp/rec/grok-proj", model: "grok-4.7", title_source: "harness" },
      started_at: Date.parse("2026-11-11T19:44:16.973091Z"),
      last_at: Date.parse("2026-11-11T19:44:32.789824Z"),
      transcript: path.join(home, ".grok", "sessions", "%2Ftmp%2Frec%2Fgrok-proj", ID, "updates.jsonl"),
    });
    expect(grokBuild.backfill(0, { HOME: path.join(home, "nobody") })).toEqual([]);
    expect(Array.isArray(grokBuild.backfill(Date.now() + 1e9))).toBe(true);
  });
});
