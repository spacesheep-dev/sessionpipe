// SPDX-License-Identifier: Apache-2.0
// Claude Code's adapter beyond the fixtures: the hook's edge cases (the events no
// payload was recorded for, the minted permission id, the hints), every config dir on
// a machine, the facts pass over a transcript (title precedence, the bridge link, the
// account, a file too big to read whole), the per-pid registry and backfill. All of it
// in a temp home; the real ~/.claude is never read for a fact or written at all.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetClaudeCaches,
  appTitle,
  claudeCode,
  claudeDirs,
  claudeFacts,
  claudePid,
} from "../src/adapters/claude-code.js";
import type { FactsState } from "../src/adapters/types.js";

// Every hook that is not a tool event walks the process tree through `ps` for the
// registry file: ~100 ms a call. Stubbed here, except in the test about that walk.
let realPs = false;
vi.mock("node:child_process", async (original) => {
  const m = await original<typeof import("node:child_process")>();
  return {
    ...m,
    execFileSync: ((file: string, ...rest: unknown[]) =>
      file === "ps" && !realPs
        ? ""
        : (m.execFileSync as (...a: unknown[]) => unknown)(file, ...rest)) as typeof m.execFileSync,
  };
});

const SID = "ed6c7665-589f-40c7-b7b4-e38ee662b7bc";
const hook = (event: string, payload: unknown, env: Record<string, string> = {}, cwd = "/") =>
  claudeCode.fromHook({
    argv: ["claude-code", event],
    stdin: typeof payload === "string" ? payload : JSON.stringify({ session_id: SID, ...(payload as object) }),
    env,
    cwd,
  });
const rec = (o: Record<string, unknown>) => JSON.stringify(o);
const user = (text: unknown, extra: Record<string, unknown> = {}) =>
  rec({
    type: "user",
    timestamp: "2026-10-05T10:00:00.000Z",
    cwd: "/w/app",
    gitBranch: "main",
    version: "2.1.258",
    message: { content: text },
    ...extra,
  });
const assistant = (text: string, model = "claude-opus-5") =>
  rec({
    type: "assistant",
    timestamp: "2026-10-05T10:00:05.000Z",
    message: { model, content: [{ type: "text", text }] },
  });
const PAD = rec({ type: "progress", pad: "x".repeat(1000) });

/** A FactsState in memory, so a test can see what the pass remembered. */
function memState(): FactsState & { mem: Record<string, unknown> } {
  const mem: Record<string, unknown> = {};
  return { mem, get: () => mem, save: (_h, _s, patch) => Object.assign(mem, patch) };
}

let home: string;
let dir: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  _resetClaudeCaches();
  home = mkdtempSync(path.join(os.tmpdir(), "sp-claude-"));
  dir = path.join(home, ".claude");
  mkdirSync(dir, { recursive: true });
  env = { HOME: home, CLAUDE_CONFIG_DIR: dir };
});
afterEach(() => rmSync(home, { recursive: true, force: true }));
/** A transcript filed where Claude Code files it: <dir>/projects/<slug>/<id>.jsonl. */
function transcript(lines: string[], id = SID, config = dir): string {
  const p = path.join(config, "projects", "-w-app");
  mkdirSync(p, { recursive: true });
  const f = path.join(p, `${id}.jsonl`);
  writeFileSync(f, `${lines.join("\n")}\n`);
  return f;
}
const registry = (pid: number | string, entry: Record<string, unknown> | string, config = dir) => {
  mkdirSync(path.join(config, "sessions"), { recursive: true });
  writeFileSync(
    path.join(config, "sessions", `${pid}.json`),
    typeof entry === "string" ? entry : JSON.stringify(entry),
  );
};

describe("claude-code fromHook", () => {
  it("needs a session id and a known event", () => {
    expect(hook("Stop", "{}")).toBeNull();
    expect(hook("Stop", "null")).toBeNull();
    expect(hook("SomethingNew", {})).toBeNull();
    const alt = "3f2a1b0c-9d8e-4f7a-b6c5-d4e3f2a1b0c9";
    expect(hook("Stop", `{"sessionId":"${alt}"}`)?.session.id).toBe(alt);
  });
  it("session: cwd from the payload or argv, the model, a subagent's call marks the parent unknown", () => {
    const r = hook("PreToolUse", { cwd: "/w", model: "m", agent_id: "a1", tool_name: "Bash", transcript_path: "/t" });
    expect(r?.session).toEqual({ id: SID, cwd: "/w", model: "m", parent_id: null });
    expect(r?.transcript).toBe("/t");
    expect(r?.hints).toEqual({});
    expect(hook("SubagentStart", { agent_id: "a1" })?.session.parent_id).toBeUndefined();
    expect(hook("Stop", { cwd: 1 }, {}, "/argv")?.session.cwd).toBe("/argv");
  });
  it("PostToolUseFailure: the error text from a string, an {error} or a {message}, nothing from the rest", () => {
    const fail = (error: unknown, tool_response?: unknown) =>
      hook("PostToolUseFailure", { tool_name: "Bash", tool_use_id: "toolu_1", duration_ms: 12.6, error, tool_response })
        ?.events[0]?.data;
    expect(fail("boom")).toEqual({ tool: "Bash", call_id: "toolu_1", ms: 13, ok: false, error: "boom" });
    expect(fail({ error: "e" })?.error).toBe("e");
    expect(fail({ message: "m" })?.error).toBe("m");
    expect(fail({ other: 1 })?.error).toBeUndefined();
    expect(fail(0)?.error).toBeUndefined();
    expect(fail(undefined, "from the response")?.error).toBe("from the response");
    expect(fail("x".repeat(3000))!.error).toHaveLength(2000);
    expect(hook("PostToolUseFailure", {})?.events).toEqual([]);
    expect(hook("PostToolUse", { tool_name: 7 })?.events).toEqual([]);
    expect(hook("PreToolUse", { tool_name: "has space" })?.events).toEqual([]);
  });
  it("PermissionRequest: the tool-use id when there is one, else a stable hash of prompt, tool and input", () => {
    const a = hook("PermissionRequest", { prompt_id: "p1", tool_name: "Bash", tool_input: { command: "ls -la" } });
    const b = hook("PermissionRequest", { prompt_id: "p1", tool_name: "Bash", tool_input: { command: "ls -la" } });
    const c = hook("PermissionRequest", { prompt_id: "p1", tool_name: "Bash", tool_input: { command: "rm" } });
    expect(a?.events[0]?.data).toEqual({
      attention_id: a?.events[0]?.data.attention_id,
      kind: "permission",
      tool: "Bash",
      message: "Bash ls -la",
    });
    expect(a?.events[0]?.data.attention_id).toMatch(/^perm-[0-9a-f]{16}$/);
    expect(a?.events[0]?.data.attention_id).toBe(b?.events[0]?.data.attention_id);
    expect(a?.events[0]?.data.attention_id).not.toBe(c?.events[0]?.data.attention_id);
    expect(hook("PermissionRequest", { tool_use_id: "toolu_9", tool_name: "Read" })?.events[0]?.data.attention_id).toBe(
      "toolu_9",
    );
    expect(hook("PermissionRequest", {})?.events[0]?.data).toEqual({
      attention_id: expect.stringMatching(/^perm-/),
      kind: "permission",
    });
    const msg = (tool_input: unknown) =>
      hook("PermissionRequest", { tool_name: "T", tool_input })?.events[0]?.data.message;
    expect(msg({ file_path: "/f" })).toBe("T /f");
    expect(msg({ path: "/p" })).toBe("T /p");
    expect(msg({ url: "https://x.test" })).toBe("T https://x.test");
    expect(msg({ pattern: "*.ts" })).toBe("T *.ts");
    expect(msg({ command: 42 })).toBe("T");
    expect(msg("not an object")).toBe("T");
    expect(msg({ command: "c".repeat(200) })).toHaveLength(2 + 120);
  });
  it("Notification: the kind from notification_type, the message cut to 200", () => {
    const kind = (notification_type: unknown) =>
      hook("Notification", { notification_type, message: "m".repeat(300) })?.events[0]?.data;
    expect(kind("permission_prompt")).toMatchObject({
      kind: "permission",
      attention_id: expect.stringMatching(/^notif-\d+$/),
    });
    expect(kind("permission_prompt")!.message).toHaveLength(200);
    expect(kind("idle_prompt")?.kind).toBe("idle");
    expect(kind("elicitation_dialog")?.kind).toBe("elicitation");
    expect(kind("something_else")?.kind).toBe("question");
    expect(hook("Notification", {})?.events[0]?.data).not.toHaveProperty("message");
  });
  it("StopFailure keeps the error class cut to 200, Stop the turn; subagents and compaction", () => {
    expect(hook("StopFailure", { prompt_id: "p", error: "x".repeat(300) })?.events[0]?.data).toEqual({
      turn_id: "p",
      reason: "error",
      error: "x".repeat(200),
    });
    expect(hook("StopFailure", { error: { code: 1 } })?.events[0]?.data).toEqual({ reason: "error" });
    expect(hook("Stop", {})?.events[0]?.data).toEqual({ reason: "stop" });
    expect(hook("SubagentStart", { agent_id: "a", agent_type: "Explore" })?.events[0]?.data).toEqual({
      agent_id: "a",
      agent_type: "Explore",
    });
    expect(hook("SubagentStop", {})?.events[0]?.data).toEqual({ agent_id: "" });
    expect(hook("PreCompact", { trigger: "manual" })?.events[0]?.data).toEqual({ trigger: "manual" });
    expect(hook("PreCompact", {})?.events[0]?.data).toEqual({ trigger: "auto" });
    expect(hook("PostCompact", {})?.events).toEqual([]);
  });
  it("SessionStart's source, SessionEnd's reason", () => {
    for (const s of ["startup", "resume", "clear", "compact", "fork"])
      expect(hook("SessionStart", { source: s })?.events[0]?.data).toEqual({ source: s });
    expect(hook("SessionStart", { trigger: "resume" })?.events[0]?.data).toEqual({ source: "resume" });
    expect(hook("SessionStart", { source: "odd" })?.events[0]?.data).toEqual({ source: "unknown" });
    for (const [r, want] of [
      ["clear", "clear"],
      ["logout", "logout"],
      ["exit", "exit"],
      ["prompt_input_exit", "exit"],
      ["bye", "other"],
    ])
      expect(hook("SessionEnd", { reason: r })?.events[0]?.data).toEqual({ reason: want });
  });
  it("hints: the prompt on a submit, a valid desktop id, the pid on everything but tool events", () => {
    const r = hook(
      "UserPromptSubmit",
      { prompt: "héllo", prompt_id: "p1" },
      { CLAUDE_CODE_HOST_SESSION_ID: "local_abc-123", HOME: home },
    );
    expect(r?.events[0]?.data).toEqual({ turn_id: "p1", prompt_chars: 5 });
    expect(r?.hints).toEqual({ prompt: "héllo", desktop_id: "local_abc-123", claude_pid: null });
    expect(hook("UserPromptSubmit", { prompt: 3 }, { HOME: home })?.hints).toEqual({ claude_pid: null });
    expect(hook("Stop", {}, { CLAUDE_CODE_HOST_SESSION_ID: "not a desktop id", HOME: home })?.hints).toEqual({
      claude_pid: null,
    });
    expect(hook("PostToolUse", { tool_name: "Bash" }, { HOME: home })?.hints).toEqual({});
  });
  // PROTOCOL.md §4: the harness's own word, forwarded verbatim, and the injected flag.
  // The recorded fixtures prove the shapes 2.1.304 sends; these are the rest.
  it("turn.started: submitted_by is forwarded as given, never mapped; a bad shape is dropped", () => {
    for (const w of ["user", "sdk", "system", "loop_wakeup", "schedule_wakeup", "poll_event", "a_word_we_dont_know"])
      expect(hook("UserPromptSubmit", { prompt: "hi", source: w })?.events[0]?.data).toEqual({
        prompt_chars: 2,
        submitted_by: w,
      });
    // The shape the spec allows is the whole guard, tier 0 being unredacted: a sentence, an
    // over-long word, a leading space, an empty string, a leading _, a non-string all go.
    for (const bad of ["a person typed it", "x".repeat(41), " user", "", "_user", 7, null, { kind: "user" }])
      expect(hook("UserPromptSubmit", { prompt: "hi", source: bad })?.events[0]?.data).toEqual({ prompt_chars: 2 });
    expect(hook("UserPromptSubmit", { prompt: "hi", source: "x".repeat(40) })?.events[0]?.data).toEqual({
      prompt_chars: 2,
      submitted_by: "x".repeat(40),
    });
    // session.started.source is this spec's own enum, a different vocabulary: the same word
    // is normalised there and forwarded here.
    expect(hook("SessionStart", { source: "loop_wakeup" })?.events[0]?.data).toEqual({ source: "unknown" });
  });
  it("turn.started: injected marks one of Claude Code's own wrappers, trimmed, and nothing else", () => {
    for (const p of [
      "<task-notification>\n<status>completed</status>\n</task-notification>",
      "\n  <task-notification>\n<status>completed</status>\n</task-notification>\n",
      "<task-notification/>",
      '<cross-session-message from="uds:/tmp/x.sock">\nAgreed.\n</cross-session-message>',
      "<system-reminder>x</system-reminder>",
      "<local-command-stdout>x</local-command-stdout>",
      "<command-name>/clear</command-name>",
    ])
      expect(hook("UserPromptSubmit", { prompt: p })?.events[0]?.data).toEqual({
        prompt_chars: [...p].length,
        injected: true,
      });
    for (const p of [
      "fix the build",
      "1 < 2 and 3 > 2",
      // Prompts the transcript reader's wider isInjected calls injected: a pasted JSX
      // element, an SVG, an HTML comment, a tag that merely starts like a wrapper. Marking
      // one of these would drop a turn the person started, the costly direction.
      "<Component>hello</Component>",
      '<svg viewBox="0 0 1 1"><path d="M0 0h1v1z"/></svg>',
      "<!-- why is this commented out? -->",
      "<taskmaster>plan it</taskmaster>",
      // The two gaps the spec admits: a peer message with no wrapper, a cron's own text.
      "status from another session",
      "run the nightly report",
    ])
      expect(hook("UserPromptSubmit", { prompt: p })?.events[0]?.data).toEqual({ prompt_chars: [...p].length });
    // An empty prompt still counts 0 chars; a non-string prompt is left unread.
    expect(hook("UserPromptSubmit", { prompt: "" })?.events[0]?.data).toEqual({ prompt_chars: 0 });
    expect(hook("UserPromptSubmit", { prompt: [{ type: "text", text: "hi" }] })?.events[0]?.data).toEqual({});
  });
  it("turn.started: a message absorbed mid-turn repeats the turn_id, injected and all", () => {
    // Claude Code fires a second UserPromptSubmit with the RUNNING turn's prompt_id when it
    // absorbs a message. Both events go out; PROTOCOL.md §4 is what stops a receiver
    // letting the second one reclassify a turn it already accepted as the person's.
    const peer = '<cross-session-message from="uds:/tmp/x.sock">\nAgreed.\n</cross-session-message>';
    expect(hook("UserPromptSubmit", { prompt: "fix the build", prompt_id: "p9" })?.events[0]?.data).toEqual({
      turn_id: "p9",
      prompt_chars: 13,
    });
    expect(hook("UserPromptSubmit", { prompt: peer, prompt_id: "p9" })?.events[0]?.data).toEqual({
      turn_id: "p9",
      prompt_chars: [...peer].length,
      injected: true,
    });
  });
});

describe("claude-code config dirs and the registry pid", () => {
  it("claudeDirs: ~/.claude first, CLAUDE_CONFIG_DIR, then ~/.claude-* dirs that hold projects or settings", () => {
    mkdirSync(path.join(home, ".claude-work"));
    writeFileSync(path.join(home, ".claude-work", "settings.json"), "{}");
    mkdirSync(path.join(home, ".claude_two", "projects"), { recursive: true });
    mkdirSync(path.join(home, ".claude-empty"));
    writeFileSync(path.join(home, ".claude-file"), "");
    const other = path.join(home, "elsewhere");
    mkdirSync(other);
    expect(claudeDirs({ HOME: home, CLAUDE_CONFIG_DIR: other })).toEqual([
      dir,
      other,
      path.join(home, ".claude-work"),
      path.join(home, ".claude_two"),
    ]);
    expect(claudeDirs({ HOME: home, CLAUDE_CONFIG_DIR: dir })).toEqual([
      dir,
      path.join(home, ".claude-work"),
      path.join(home, ".claude_two"),
    ]);
    // The default dir is listed even before it exists; a configured one only once it does.
    expect(claudeDirs({ HOME: path.join(home, "none"), CLAUDE_CONFIG_DIR: path.join(home, "none2") })).toEqual([
      path.join(home, "none", ".claude"),
    ]);
    expect(claudeDirs().length).toBeGreaterThan(0);
    expect(claudeCode.detect(env)).toBe(true);
    expect(claudeCode.configFiles(env)).toHaveLength(3);
  });
  it.runIf(process.platform !== "win32")("claudePid: the nearest ancestor with a registry file, up to six hops", () => {
    realPs = true;
    expect(claudePid(env)).toBeNull();
    registry(process.ppid, { sessionId: SID });
    expect(claudePid(env)).toBe(process.ppid);
    rmSync(path.join(dir, "sessions"), { recursive: true });
    const grand = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(process.ppid)], { encoding: "utf8" }).trim());
    if (grand > 1) {
      registry(grand, { sessionId: SID });
      expect(claudePid(env)).toBe(grand);
    }
    realPs = false;
  });
});

describe("claude-code facts", () => {
  it("title from the first ask, model from the last real assistant, account, version, times, cwd and branch", () => {
    writeFileSync(
      path.join(dir, ".claude.json"),
      JSON.stringify({ oauthAccount: { accountUuid: "acct-1", emailAddress: "me@example.com" } }),
    );
    const file = transcript([
      rec({ type: "summary", summary: "x" }),
      user("<command-name>/clear</command-name>"),
      user("fix the  build\nplease", { isMeta: false }),
      assistant("On it.", "claude-sonnet-5"),
      assistant("Done.", "<synthetic>"),
      rec({ type: "system", subtype: "bridge_status", url: "https://claude.ai/code/session_AbC123" }),
    ]);
    const state = memState();
    const facts = claudeFacts(file, SID, {}, state);
    expect(facts).toEqual({
      url: "https://claude.ai/code/session_AbC123",
      first_ask: "fix the build please",
      title: "fix the build please",
      title_source: "first-ask",
      account_id: "acct-1",
      model: "claude-sonnet-5",
      harness_version: "2.1.258",
      started_at: Date.parse("2026-10-05T10:00:00.000Z"),
      last_at: Date.parse("2026-10-05T10:00:05.000Z"),
      cwd: "/w/app",
      branch: "main",
    });
    expect(state.mem).toEqual({ url: "https://claude.ai/code/session_AbC123", first_ask: "fix the build please" });
    // Through the adapter: git facts of the folder (none in a temp dir), the branch kept, the desktop url only when no link exists.
    expect(claudeCode.facts({ id: SID, cwd: home }, file, { desktop_id: "local_1" }, state).url).toBe(
      "https://claude.ai/code/session_AbC123",
    );
    expect(claudeCode.facts({ id: SID, cwd: home }, undefined, { desktop_id: "local_1" }, memState())).toEqual({
      url: "claude://code/continue/local_1",
    });
    expect(claudeCode.facts({ id: SID }, undefined, {}, memState())).toEqual({});
  });
  it("skips meta, sidechain and non-human asks, reads text parts, a detached HEAD is no branch", () => {
    const file = transcript([
      user("meta", { isMeta: true, gitBranch: "HEAD" }),
      user("side", { isSidechain: true }),
      user("agent", { origin: { kind: "agent" } }),
      user([{ type: "image" }, { type: "text", text: " real " }, { type: "text", text: "ask" }], {
        origin: { kind: "human" },
        gitBranch: "HEAD",
      }),
      user(""),
      rec({ type: "user", message: {} }),
      rec({ type: "user", message: { content: 5 } }),
    ]);
    const facts = claudeFacts(file, "", {}, memState());
    expect(facts.title).toBe("real ask");
    expect(facts.branch).toBeUndefined();
    expect(facts.account_id).toBeUndefined();
    expect(claudeFacts(path.join(home, "missing.jsonl"), SID, {}, memState())).toEqual({});
  });
  it("a /rename beats a custom-title record beats Claude's own name beats its ai-title beats the first ask", () => {
    const base = [user("the ask"), assistant("ok")];
    const state = memState();
    expect(
      claudeFacts(transcript([...base, rec({ type: "ai-title", aiTitle: "AI title" })]), SID, {}, state),
    ).toMatchObject({ title: "AI title", title_source: "harness" });
    registry(4242, { sessionId: SID, name: "  Auto name ", nameSource: "auto" });
    _resetClaudeCaches();
    expect(
      claudeFacts(transcript([...base, rec({ type: "ai-title", aiTitle: "AI title" })]), SID, {}, state),
    ).toMatchObject({ title: "Auto name", title_source: "harness" });
    expect(state.mem).toMatchObject({ name: "Auto name", name_source: "harness" });
    expect(
      claudeFacts(transcript([...base, rec({ type: "custom-title", customTitle: "Custom" })]), SID, {}, state),
    ).toMatchObject({ title: "Custom", title_source: "custom" });
    registry(4242, { sessionId: SID, name: "Renamed", nameSource: "user", bridgeSessionId: "session_Xyz9" });
    _resetClaudeCaches();
    const renamed = claudeFacts(
      transcript([...base, rec({ type: "custom-title", customTitle: "Custom" })]),
      SID,
      {},
      state,
    );
    expect(renamed).toMatchObject({
      title: "Renamed",
      title_source: "custom",
      url: "https://claude.ai/code/session_Xyz9",
    });
    // With the registry gone the remembered name and url still stand.
    rmSync(path.join(dir, "sessions"), { recursive: true });
    _resetClaudeCaches();
    expect(claudeFacts(transcript(base), SID, {}, state)).toMatchObject({
      title: "Renamed",
      title_source: "custom",
      url: "https://claude.ai/code/session_Xyz9",
    });
    // A registry name with a source that ranks nowhere (derived) is no name.
    registry(4243, { sessionId: SID, name: "Derived", nameSource: "derived", bridgeSessionId: "not-a-bridge" });
    _resetClaudeCaches();
    expect(claudeFacts(transcript(base), SID, {}, memState())).toMatchObject({
      title: "the ask",
      title_source: "first-ask",
    });
    // A content that is neither text nor blocks is no ask.
    expect(claudeFacts(transcript([user(42), user("the ask")]), SID, {}, memState())).toMatchObject({
      title: "the ask",
      title_source: "first-ask",
    });
  });
  it("finds the registry entry through the hook's pid when the session id is filed under another", () => {
    registry(777, { sessionId: "another-session", name: "Via pid", nameSource: "hook" });
    registry("broken", "{ not json");
    registry(779, { name: "no session or source" });
    registry(780, "null");
    const file = transcript([user("ask"), assistant("ok")]);
    expect(claudeFacts(file, SID, { claude_pid: 777 }, memState())).toMatchObject({
      title: "Via pid",
      title_source: "harness",
    });
    expect(claudeFacts(file, SID, { claude_pid: 778 }, memState())).toMatchObject({
      title: "ask",
      title_source: "first-ask",
    });
    expect(claudeFacts(file, SID, {}, memState()).title).toBe("ask");
  });
  it("the bridge link from a bridge-session record (cse_ or session_), the head before the tail", () => {
    expect(
      claudeFacts(
        transcript([rec({ type: "bridge-session", bridgeSessionId: "cse_Q1w2" }), user("a"), assistant("b")]),
        SID,
        {},
        memState(),
      ).url,
    ).toBe("https://claude.ai/code/session_Q1w2");
    expect(
      claudeFacts(
        transcript([
          rec({ type: "bridge-session", bridgeSessionId: "odd" }),
          rec({ type: "system", subtype: "bridge_status", url: "https://evil.test/x" }),
        ]),
        SID,
        {},
        memState(),
      ).url,
    ).toBeUndefined();
    const state = memState();
    state.mem.url = "https://claude.ai/code/session_Remembered";
    expect(claudeFacts(transcript([user("a")]), SID, {}, state).url).toBe("https://claude.ai/code/session_Remembered");
  });
  it("a file too big for its ends: titles are scanned once and remembered, the first ask found past the head", () => {
    const pad = Array(400).fill(PAD);
    const file = transcript([
      ...pad,
      rec({ type: "custom-title", customTitle: "Deep title" }),
      "not json at all",
      user("deep ask"),
      assistant("ok"),
      ...pad,
    ]);
    const state = memState();
    const first = claudeFacts(file, SID, {}, state);
    expect(first).toMatchObject({ title: "Deep title", title_source: "custom", first_ask: "deep ask" });
    expect(state.mem).toMatchObject({ scan_custom: "Deep title", scan_ai: null, first_ask: "deep ask" });
    const upto = state.mem.scan_upto as number;
    expect(upto).toBeGreaterThan(400_000);
    // Remembered: nothing is scanned again, the title and ask come from memory.
    expect(claudeFacts(file, SID, {}, state)).toMatchObject({ title: "Deep title", first_ask: "deep ask" });
    expect(state.mem.scan_upto).toBe(upto);
    // A file shorter than where the scan stopped was replaced: scan it afresh.
    const shorter = transcript([...pad, rec({ type: "ai-title", aiTitle: "New AI" }), ...pad]);
    state.mem.scan_upto = upto + 10_000_000;
    state.mem.scan_custom = "stale";
    expect(claudeFacts(shorter, SID, {}, state)).toMatchObject({ title: "New AI", title_source: "harness" });
    expect(state.mem.scan_custom).toBeNull();
  });
  it("a file over 16 MB with no ask remembers that, so it is not scanned again", () => {
    const file = transcript(Array(17_000).fill(PAD));
    const state = memState();
    expect(claudeFacts(file, SID, {}, state).first_ask).toBeUndefined();
    expect(state.mem.first_ask_none).toBe(true);
    expect(claudeFacts(file, SID, {}, state).title).toBeUndefined();
  });
  it("appTitle collapses whitespace and cuts at 50", () => {
    expect(appTitle("  a \n b  ")).toBe("a b");
    expect(appTitle("x".repeat(60))).toBe(`${"x".repeat(50)}...`);
  });
});

describe("claude-code transcript and backfill", () => {
  it("reads turns, and a missing file as none", () => {
    const file = transcript([user("ask"), assistant("answer")]);
    expect(claudeCode.readTranscript(file, 0).turns.map((t) => [t.user, t.assistant])).toEqual([["ask", "answer"]]);
    expect(claudeCode.readTranscript(path.join(home, "none"), 4)).toEqual({ turns: [], line: 4 });
  });
  it("backfill lists recent transcripts in every config dir's projects, skipping odd names and timeless files", () => {
    const file = transcript([user("ask"), assistant("answer")]);
    const old = transcript([user("old"), assistant("x")], "11111111-1111-4111-8111-111111111111");
    utimesSync(old, new Date(Date.now() - 86_400_000), new Date(Date.now() - 86_400_000));
    transcript([rec({ type: "summary" })], "22222222-2222-4222-8222-222222222222");
    transcript([user("not a session file")], "notes");
    transcript([user("no branch", { gitBranch: undefined }), assistant("x")], "33333333-3333-4333-8333-333333333333");
    const rows = claudeCode.backfill(Date.now() - 3_600_000, env);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.session.id.startsWith("3333"))?.session).not.toHaveProperty("branch");
    rows.splice(
      rows.findIndex((r) => r.session.id.startsWith("3333")),
      1,
    );
    expect(rows[0]).toMatchObject({
      session: { id: SID, cwd: "/w/app", branch: "main", title: "ask", title_source: "first-ask" },
      started_at: Date.parse("2026-10-05T10:00:00.000Z"),
    });
    expect(rows[0]?.session).not.toHaveProperty("first_ask");
    expect(rows[0]?.session).not.toHaveProperty("harness_version");
    expect(file).toContain(SID);
  });
});

describe("claude-code: a payload another harness ran", () => {
  // Devin imports ~/.claude/settings.json hooks (read_config_from.claude, on by
  // default), so our claude-code entries there can be run by Devin. Its payload has no
  // transcript_path and its session id is a word-word slug: reporting that as a Claude
  // Code session would invent one that does not exist.
  it("is dropped when it names no transcript and its session id is not a UUID", () => {
    const devinish = JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "frill-vulture",
      source: "startup",
    });
    expect(
      claudeCode.fromHook({ argv: ["claude-code", "SessionStart"], stdin: devinish, env: {}, cwd: "/" }),
    ).toBeNull();
    // A real Claude Code payload is untouched.
    const real = JSON.stringify({
      session_id: "ed6c7665-589f-40c7-b7b4-e38ee662b7bc",
      transcript_path: "/Users/x/.claude/projects/p/ed6c7665-589f-40c7-b7b4-e38ee662b7bc.jsonl",
      source: "startup",
    });
    expect(
      claudeCode.fromHook({ argv: ["claude-code", "SessionStart"], stdin: real, env: {}, cwd: "/" })?.session.id,
    ).toBe("ed6c7665-589f-40c7-b7b4-e38ee662b7bc");
  });

  it("keeps every recorded Claude Code fixture: each names a transcript and a UUID", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const dir = path.resolve(here, "../../../conformance/harness/claude-code");
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      const fx = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as {
        input: { argv: string[]; stdin: string; env?: Record<string, string>; cwd?: string };
      };
      const s = JSON.parse(fx.input.stdin) as { session_id: string; transcript_path?: string };
      expect(typeof s.transcript_path, f).toBe("string");
      expect(s.session_id, f).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(
        claudeCode.fromHook({
          argv: fx.input.argv,
          stdin: fx.input.stdin,
          env: fx.input.env ?? {},
          cwd: fx.input.cwd ?? "/",
        }),
        f,
      ).not.toBeNull();
    }
  });
});
