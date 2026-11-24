// SPDX-License-Identifier: Apache-2.0
// Codex's adapter beyond the fixtures: the notify fallback (one JSON argument, not
// stdin), the events no payload was recorded for, and every way config.toml's notify
// line can already be taken — ours, moved into a table, Codex Computer Use's with or
// without ours chained behind it, another tool's. All in a temp CODEX_HOME.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codex, codexAccounts } from "../src/adapters/codex.js";
import type { HookCommand } from "../src/adapters/types.js";

const SID = "01a0e5c5-5b2f-7c60-9287-31f9f0aa9f65";
const cmd: HookCommand = (a) => ({
  argv: ["/usr/local/bin/node", "/opt/sessionpipe/dist/hook.js", ...a],
  command: `"/usr/local/bin/node" "/opt/sessionpipe/dist/hook.js" ${a.join(" ")}`,
});
const OURS = JSON.stringify(cmd(["codex", "notify"]).argv);
const OLD = JSON.stringify(["/old/node", "/old/sessionpipe/dist/hook.js", "codex", "notify"]);
const CU = "/Applications/Codex/SkyComputerUseClient";
const hook = (event: string, payload: unknown, env: NodeJS.ProcessEnv = {}, extraArgv: string[] = []) =>
  codex.fromHook({
    argv: ["codex", event, ...extraArgv],
    stdin: typeof payload === "string" ? payload : JSON.stringify({ session_id: SID, ...(payload as object) }),
    env,
    cwd: "/",
  });

let home: string;
let toml: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "sp-codex-"));
  mkdirSync(path.join(home, ".codex"));
  toml = path.join(home, ".codex", "config.toml");
  env = { HOME: home, CODEX_HOME: path.join(home, ".codex") };
});
afterEach(() => rmSync(home, { recursive: true, force: true }));
const notifyState = () => codex.installed(cmd, env)[1]?.state;

describe("codex fromHook", () => {
  // Synthetic compatibility fixtures: no dropped Desktop payload has been captured.
  it.each(["thread_id", "conversation_id"])("claims a hook carrying only %s", (key) => {
    const file = new URL(`./fixtures/codex-hook-${key.replaceAll("_", "-")}.json`, import.meta.url);
    const stdin = readFileSync(file, "utf8");
    const payload = JSON.parse(stdin);
    expect(payload.session_id).toBeUndefined();
    expect(hook("SessionStart", stdin, env)).toMatchObject({
      session: { id: payload[key], cwd: payload.cwd },
      events: [{ type: "session.started", data: { source: "startup" }, harnessEvent: "SessionStart" }],
    });
  });
  it.each(["session_id", "thread_id", "conversation_id", "thread-id", "session-id"])(
    "prefers %s over later id aliases and skips null aliases",
    (key) => {
      const keys = ["session_id", "thread_id", "conversation_id", "thread-id", "session-id"];
      const payload = Object.fromEntries(keys.map((k, i) => [k, i < keys.indexOf(key) ? null : `id-${k}`]));
      expect(hook("SessionStart", JSON.stringify(payload), env)?.session.id).toBe(`id-${key}`);
      expect(hook("SessionStart", JSON.stringify({ [key]: SID }), env)?.session.id).toBe(SID);
      expect(hook("SessionStart", JSON.stringify({ [key]: SID, transcript_path: null }), env)).toBeNull();
    },
  );
  /** The thread's rollout under this test's CODEX_HOME: what makes a notify a session's. */
  const rollout = (id: string) => {
    const day = path.join(home, ".codex", "sessions", "2026", "09", "27");
    mkdirSync(day, { recursive: true });
    const f = path.join(day, `rollout-2026-09-27T19-08-31-${id}.jsonl`);
    writeFileSync(f, "");
    return f;
  };
  it("notify: the payload is one JSON argument, stdin only as a fallback; the thread id under any of its names", () => {
    const f = rollout(SID);
    const r = hook("notify", "", env, [
      JSON.stringify({ type: "agent-turn-complete", "thread-id": SID, "turn-id": "t1", cwd: "/w" }),
    ]);
    expect(r).toEqual({
      session: { id: SID, cwd: "/w" },
      events: [{ type: "turn.ended", data: { reason: "stop", turn_id: "t1" }, harnessEvent: "notify" }],
      // The road this end came by: with its hooks on, Codex's Stop hook says the same end
      // first, and the worker drops the second of the two (conformance/turn-end-once.json).
      hints: { fallback: true },
      transcript: f,
    });
    // A turn's end is the only thing Codex's notify says (0.171.0); another `type` is not one.
    expect(hook("notify", "", env, [JSON.stringify({ type: "approval-requested", "thread-id": SID })])).toBeNull();
    expect(hook("notify", "", env, [JSON.stringify({ type: 7, "thread-id": SID })])?.events[0]?.type).toBe(
      "turn.ended",
    );
    expect(hook("notify", JSON.stringify({ thread_id: SID }), env)?.session).toEqual({ id: SID, cwd: "/" });
    expect(hook("notify", JSON.stringify({ "session-id": SID }), env)?.events[0]?.data).toEqual({ reason: "stop" });
    expect(hook("notify", JSON.stringify({ session_id: SID }), env)?.session.id).toBe(SID);
    expect(hook("notify", "", env)).toBeNull();
    expect(hook("notify", "null", env)).toBeNull();
    expect(hook("notify", "[]", env)).toBeNull();
    expect(hook("notify", "", env, ["{ broken"])).toBeNull();
  });
  describe("codexAccounts: who Codex is signed in as, from its sign-in file", () => {
    const ACCT = "0aaa1111-2222-4333-8444-555566667777";
    const USER = "user-0000000000000000000000AB";
    const jwt = (c: unknown) => `e30.${Buffer.from(JSON.stringify(c)).toString("base64url")}.c2ln`;
    const who = (extra: Record<string, unknown> = {}) => ({
      "https://api.openai.com/auth": { chatgpt_user_id: USER, chatgpt_plan_type: "plus" },
      ...extra,
    });
    const tokens = (id_token: unknown, account_id: unknown = ACCT) => ({
      auth_mode: "chatgpt",
      tokens: { id_token, access_token: "ACCESS-SECRET", refresh_token: "REFRESH-SECRET", account_id },
    });
    let codexDir: string;
    let e: NodeJS.ProcessEnv;
    const write = (auth: unknown) =>
      writeFileSync(path.join(codexDir, "auth.json"), typeof auth === "string" ? auth : JSON.stringify(auth));
    beforeEach(() => {
      codexDir = path.join(home, "codex-signed-in");
      mkdirSync(codexDir, { recursive: true });
      e = { CODEX_HOME: codexDir };
    });

    it("the account is the workspace and the person in it; the email is its label; neither token is ever in it", () => {
      expect(codexAccounts(e)).toEqual([]); // no sign-in file: nobody
      write(tokens(jwt(who({ email: "me@example.com" }))));
      expect(codexAccounts(e)).toEqual([{ harness: "codex", id: `${ACCT}.${USER}`, email: "me@example.com" }]);
      expect(JSON.stringify(codexAccounts(e))).not.toMatch(/SECRET|e30\.|plus/);
      // The email under OpenAI's profile claim; the person's id under its older name.
      write(
        tokens(
          jwt({
            "https://api.openai.com/profile": { email: "work@example.com" },
            "https://api.openai.com/auth": { user_id: "user-OLD" },
          }),
        ),
      );
      expect(codexAccounts(e)).toEqual([{ harness: "codex", id: `${ACCT}.user-OLD`, email: "work@example.com" }]);
      // The same account is what a thread made under it carries (codexFacts).
      const f = path.join(codexDir, "rollout.jsonl");
      writeFileSync(
        f,
        `${JSON.stringify({ type: "session_meta", payload: { id: "t", creator_account_id: ACCT, creator_user_id: "user-OLD" } })}\n`,
      );
      const none = { get: () => ({}), save: () => {} };
      expect(codex.facts({ id: "t" }, f, {}, none).account_id).toBe(codexAccounts(e)[0]?.id);
    });

    it("an id token that names no person or no usable email still names the account", () => {
      for (const bad of ["not-a-jwt", "a.b.c", jwt("text"), jwt(null), jwt({}), 7, undefined]) {
        write(tokens(bad));
        expect(codexAccounts(e), JSON.stringify(bad)).toEqual([{ harness: "codex", id: ACCT }]);
      }
      // A person's id that is no id, or would make the whole too long, is left out.
      for (const user of ["a b", "me@example.com", 7, "u".repeat(100)]) {
        write(tokens(jwt({ "https://api.openai.com/auth": { chatgpt_user_id: user } })));
        expect(codexAccounts(e), JSON.stringify(user)).toEqual([{ harness: "codex", id: ACCT }]);
      }
      // An address a board could be made to draw as something else is no label.
      for (const email of ["no at sign", "a b@example.com", "a‮@example.com", "a@exa\u0000mple.com", "<b>@x.io", 7]) {
        write(tokens(jwt(who({ email }))));
        expect(codexAccounts(e), JSON.stringify(email)).toEqual([{ harness: "codex", id: `${ACCT}.${USER}` }]);
      }
    });

    it("nobody: an API key, an account id that is none, a file that is no sign-in file", () => {
      for (const none of [
        { OPENAI_API_KEY: "sk-test" },
        { tokens: null },
        tokens(jwt(who()), "me@example.com"),
        tokens(jwt(who()), 7),
        {},
        "{ broken",
        "null",
      ]) {
        write(none);
        expect(codexAccounts(e), JSON.stringify(none)).toEqual([]);
      }
      // Larger than any sign-in file, or not a file at all: never read.
      write(JSON.stringify({ ...tokens(jwt(who())), pad: "x".repeat(1024 * 1024) }));
      expect(codexAccounts(e)).toEqual([]);
      rmSync(path.join(codexDir, "auth.json"));
      mkdirSync(path.join(codexDir, "auth.json"));
      expect(codexAccounts(e)).toEqual([]);
      // With no CODEX_HOME it is this user's ~/.codex; with no environment given, this process's.
      expect(Array.isArray(codexAccounts({}))).toBe(true);
      expect(Array.isArray(codexAccounts())).toBe(true);
    });

    it("limits are the account's that this Codex process started under, which a resumed thread's creator may not be", () => {
      const f = path.join(codexDir, "rollout.jsonl");
      const rate_limits = {
        limit_id: "codex",
        primary: { used_percent: 12.5, window_minutes: 300, resets_at: 1795560000 },
      };
      writeFileSync(
        f,
        [
          JSON.stringify({
            type: "session_meta",
            payload: { id: SID, creator_account_id: "acct-then", creator_user_id: USER },
          }),
          JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: null, rate_limits } }),
        ].join("\n"),
      );
      const kept = new Map<string, Record<string, unknown>>();
      const state = {
        get: (h: string, s: string) => kept.get(`${h}:${s}`) ?? {},
        save: (h: string, s: string, patch: Record<string, unknown>) =>
          void kept.set(`${h}:${s}`, { ...kept.get(`${h}:${s}`), ...patch }),
      };
      const about = { state, session: SID };
      const start = (as: NodeJS.ProcessEnv) => {
        const r = hook("SessionStart", { session_id: SID, transcript_path: f, source: "resume" }, as);
        expect(r?.hints).toEqual({ started: true });
        return codex.facts({ id: SID }, f, r?.hints ?? {}, state, as);
      };
      // No start seen (hooks not approved yet), or no state to ask: unstamped, the session's account's.
      expect(codex.limits?.(f, about)).not.toHaveProperty("account_id");
      expect(codex.limits?.(f)).not.toHaveProperty("account_id");
      // Started with nobody the sign-in file names (an API key, a keyring): unstamped still.
      expect(start(e).account_id).toBe(`acct-then.${USER}`);
      expect(codex.limits?.(f, about)).not.toHaveProperty("account_id");
      // Started under another account than the thread's creator: its limits are that one's.
      write(tokens(jwt(who())));
      start(e);
      expect(codex.limits?.(f, about)).toMatchObject({ account_id: `${ACCT}.${USER}`, windows: [{ id: "primary" }] });
      // The person signs in as somebody else while this window stays open: it runs on as it started.
      write(tokens(jwt(who()), "acct-later"));
      expect(codex.limits?.(f, about)).toMatchObject({ account_id: `${ACCT}.${USER}` });
      // Any other hook of the session asks nothing and changes nothing.
      codex.facts({ id: SID }, f, {}, state, e);
      expect(codex.limits?.(f, about)).toMatchObject({ account_id: `${ACCT}.${USER}` });
      // Its next start is under the new sign-in.
      start(e);
      expect(codex.limits?.(f, about)).toMatchObject({ account_id: `acct-later.${USER}` });
      // A rollout with no limits in it has none, whoever is signed in.
      writeFileSync(f, "");
      expect(codex.limits?.(f, about)).toBeNull();
    });
  });

  it("toolResult: only what Codex itself wrote first in a call's result counts", () => {
    const f = rollout(SID);
    const row = (payload: Record<string, unknown>, type = "response_item") => JSON.stringify({ type, payload });
    const out = (call_id: string, output: unknown) => row({ type: "function_call_output", call_id, output });
    writeFileSync(
      f,
      [
        row({ id: SID }, "session_meta"),
        row({ type: "function_call", call_id: "c1", name: "exec_command" }),
        out("c1", "Wall time: 4.0 seconds\nProcess exited with code 2\nOutput:\n"),
        out("c2", "Chunk ID: a1\nWall time: 0.1 seconds\nProcess exited with code -1\n"),
        // The command's own words, a result cut short by the person, a result that is no text.
        out("c3", "Process exited with code 0\nWall time: 1 seconds\nProcess exited with code 0\n"),
        out("c4", "Wall time: 4.0 seconds\naborted by user"),
        out("c5", { content: "x", success: false }),
        // A message that quotes the id and the record's name; an event of the same name; a broken line.
        row({ type: "message", role: "user", content: [{ type: "input_text", text: 'c6 "function_call_output"' }] }),
        row(
          { type: "function_call_output", call_id: "c7", output: "Wall time: 1 seconds\nProcess exited with code 0\n" },
          "event_msg",
        ),
        '{"type":"response_item","payload":{"type":"function_call_output","call_id":"c8"',
        // An edit's result is another kind of record; a call with no result yet.
        row({ type: "custom_tool_call_output", call_id: "c9", output: "Success." }),
        row({ type: "function_call", call_id: "c10", name: "exec_command" }),
      ].join("\n"),
    );
    const res = (id: string) => codex.toolResult?.(f, id);
    expect(res("c1")).toEqual({ ok: false, error: "exit 2" });
    expect(res("c2")).toEqual({ ok: false, error: "exit -1" });
    // Nothing to read as ok or not, and nothing to wait for.
    for (const id of ["c3", "c4", "c5", "c6", "c7", "c8", "c9", "nope"]) expect(res(id), id).toEqual({});
    expect(codex.toolResult?.(path.join(home, "no-such-rollout.jsonl"), "c1")).toEqual({});
    // The call is there and its result is not: it may still come.
    expect(res("c10")).toBeNull();
  });

  it("turnEnd: the rollout's own word for how a turn ended, and nothing where it has none", () => {
    const f = rollout(SID);
    const line = (payload: Record<string, unknown>, type = "event_msg") => JSON.stringify({ type, payload });
    writeFileSync(
      f,
      [
        line({ type: "task_started", turn_id: "t1" }),
        // A prompt that quotes the very words looked for is not the event.
        line(
          { type: "message", role: "user", content: [{ type: "input_text", text: 't1 "task_complete"' }] },
          "response_item",
        ),
        line({ type: "task_complete", turn_id: "t1", last_agent_message: "done" }),
        line({
          type: "task_complete",
          turn_id: "t2",
          error: { message: "private words", codex_error_info: "usage_limit_exceeded" },
        }),
        line({
          type: "task_complete",
          turn_id: "t3",
          error: { message: "x", codex_error_info: { response_too_many_failed_attempts: { http_status_code: 500 } } },
        }),
        line({ type: "task_complete", turn_id: "t4", error: { message: "x" } }),
        line({ type: "task_complete", turn_id: "t5", error: { message: "x", codex_error_info: "Not A Class!" } }),
        line({ type: "task_complete", turn_id: "t6", error: { message: "x", codex_error_info: 7 } }),
        line({ type: "turn_aborted", turn_id: "t7", reason: "interrupted" }),
        '{"type":"event_msg","payload":{"type":"task_complete","turn_id":"t8"',
        '["t9","task_complete"]',
        "null",
        line({ type: "task_complete", turn_id: "t10x" }),
        line({ type: "other_event", turn_id: "t11", kind: "turn_aborted" }),
      ].join("\n"),
    );
    const end = (id: string) => codex.turnEnd?.(f, id);
    expect(end("t1")).toEqual({ reason: "stop" });
    expect(end("t2")).toEqual({ reason: "error", error: "usage_limit_exceeded" });
    expect(end("t3")).toEqual({ reason: "error", error: "response_too_many_failed_attempts" });
    // No class, or one that is no class name: the reason alone.
    for (const id of ["t4", "t5", "t6"]) expect(end(id)).toEqual({ reason: "error" });
    expect(end("t7")).toEqual({ reason: "interrupt" });
    // A line cut short, a list, a null, an id that is only part of another's, another event.
    for (const id of ["t8", "t9", "t10", "t11", "nope"]) expect(end(id)).toBeNull();
    expect(codex.turnEnd?.(path.join(home, "no-such-rollout.jsonl"), "t1")).toBeNull();
    // Looked for in the file's last 4 MiB and no further back: a rollout can be very large.
    const filler = line(
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "x".repeat(64 * 1024) }] },
      "response_item",
    );
    writeFileSync(
      f,
      [
        line({ type: "session_meta" }, "session_meta"),
        line({ type: "task_complete", turn_id: "old", error: { codex_error_info: "other" } }),
        ...Array.from({ length: 70 }, () => filler),
        line({ type: "task_complete", turn_id: "new", error: { codex_error_info: "unauthorized" } }),
      ].join("\n"),
    );
    expect(end("new")).toEqual({ reason: "error", error: "unauthorized" });
    expect(end("old")).toBeNull();
  });
  it("notify without the thread's rollout under CODEX_HOME is an ephemeral thread: nothing", () => {
    expect(hook("notify", "", env, [JSON.stringify({ "thread-id": SID })])).toBeNull();
    const f = rollout(SID);
    expect(hook("notify", "", env, [JSON.stringify({ "thread-id": SID })])?.transcript).toBe(f);
    expect(hook("notify", "", env, [JSON.stringify({ "thread-id": "other-thread-id" })])).toBeNull();
  });
  it("needs a session id and a known event; the model rides on the session", () => {
    expect(hook("Stop", "{}")).toBeNull();
    expect(hook("Stop", "null")).toBeNull();
    expect(hook("SomethingNew", {})).toBeNull();
    expect(hook("Stop", { model: "gpt-6", cwd: "/w", transcript_path: "/t" })).toMatchObject({
      session: { id: SID, cwd: "/w", model: "gpt-6" },
      transcript: "/t",
    });
    expect(hook("PreToolUse", {})?.events).toEqual([]);
    expect(hook("PostToolUse", { tool_name: "x y" })?.events).toEqual([]);
  });
  it("the events no payload was recorded for: permission, interrupt, subagents, compaction, session end", () => {
    expect(hook("PermissionRequest", { tool_name: "Bash", tool_use_id: "exec-1" })?.events[0]?.data).toEqual({
      attention_id: "exec-1",
      kind: "permission",
      tool: "Bash",
    });
    expect(hook("PermissionRequest", {})?.events[0]?.data).toEqual({
      attention_id: expect.stringMatching(/^perm-\d+$/),
      kind: "permission",
    });
    expect(hook("Interrupt", { turn_id: "t" })?.events[0]?.data).toEqual({ turn_id: "t", reason: "interrupt" });
    expect(hook("SubagentStart", { subagent_id: "s", agent_type: "explorer" })?.events[0]?.data).toEqual({
      agent_id: "s",
      agent_type: "explorer",
    });
    expect(hook("SubagentStop", { agent_id: "a" })?.events[0]?.data).toEqual({ agent_id: "a" });
    expect(hook("SubagentStop", {})?.events[0]?.data).toEqual({ agent_id: "" });
    expect(hook("SubagentStop", { subagent_id: "s", agent_type: 3 })?.events[0]?.data).toEqual({ agent_id: "s" });
    expect(hook("SubagentStart", { agent_id: "a" })?.events[0]?.data).toEqual({ agent_id: "a" });
    expect(hook("SubagentStart", {})?.events[0]?.data).toEqual({ agent_id: "" });
    expect(hook("SubagentStop", { agent_id: "a", agent_type: "reviewer" })?.events[0]?.data).toEqual({
      agent_id: "a",
      agent_type: "reviewer",
    });
    expect(hook("PreCompact", { trigger: "manual" })?.events[0]?.data).toEqual({ trigger: "manual" });
    expect(hook("PreCompact", {})?.events[0]?.data).toEqual({ trigger: "auto" });
    expect(hook("PostCompact", {})?.events).toEqual([]);
    for (const [r, want] of [
      ["clear", "clear"],
      ["logout", "logout"],
      ["exit", "exit"],
      ["prompt_input_exit", "other"],
    ])
      expect(hook("SessionEnd", { reason: r })?.events[0]?.data).toEqual({ reason: want });
    expect(hook("SessionStart", { source: "fork" })?.events[0]?.data).toEqual({ source: "fork" });
    expect(hook("SessionStart", {})?.events[0]?.data).toEqual({ source: "unknown" });
    expect(hook("UserPromptSubmit", { prompt: "héllo" })?.events[0]?.data).toEqual({ prompt_chars: 5 });
  });
  it("facts without a transcript are none; a missing transcript reads as none", () => {
    const noState = { get: () => ({}), save: () => {} };
    expect(codex.facts({ id: SID }, undefined, {}, noState)).toEqual({});
    const rollout = path.join(home, "rollout.jsonl");
    const item = (text: unknown, extra: Record<string, unknown> = {}) =>
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-10-04T12:00:00Z",
        payload: {
          type: "message",
          role: "user",
          content: text === null ? undefined : [{ type: "input_text", text }],
          ...extra,
        },
      });
    writeFileSync(
      rollout,
      `${[
        JSON.stringify({
          type: "session_meta",
          payload: { cwd: "/w", git: { branch: "main", repository_url: "https://user:token@github.com/a/b.git" } },
        }),
        item(null),
        item("   "),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [] } }),
        item(`\n\n${"word ".repeat(30)}end`),
      ].join("\n")}\n`,
    );
    const facts = codex.facts({ id: SID }, rollout, {}, noState);
    expect(facts).toMatchObject({
      cwd: "/w",
      branch: "main",
      repo: "https://github.com/a/b.git",
      title_source: "first-ask",
    });
    expect(facts.title?.endsWith("…")).toBe(true);
    expect(facts.title?.length).toBeLessThanOrEqual(81);
    expect(codex.readTranscript(path.join(home, "none.jsonl"), 2)).toEqual({ turns: [], line: 2 });
    expect(codex.detect(env)).toBe(true);
    expect(codex.configFiles(env)).toEqual([path.join(home, ".codex", "hooks.json"), toml]);
    expect(typeof codex.detect()).toBe("boolean");
    expect(codex.configFiles()).toHaveLength(2);
  });
  it("backfill skips rollouts without a thread id in their name or without times", () => {
    const day = path.join(home, ".codex", "sessions", "2026", "10", "01");
    mkdirSync(day, { recursive: true });
    writeFileSync(path.join(day, "rollout-2026-10-01T10-00-00-short.jsonl"), "");
    writeFileSync(
      path.join(day, `rollout-2026-10-01T10-00-00-${SID}.jsonl`),
      `${JSON.stringify({ type: "session_meta", payload: { cwd: "/w" } })}\n`,
    );
    expect(codex.backfill(0, env)).toEqual([]);
  });
});

describe("codex notify in config.toml", () => {
  it("an older line of ours is updated; one inside a table is moved up", () => {
    writeFileSync(toml, `notify = ${OLD}\n`);
    expect(notifyState()).toBe("stale");
    expect(codex.install(cmd, env)[1]).toEqual({ file: toml, changed: true, note: "notify updated" });
    expect(readFileSync(toml, "utf8")).toBe(`notify = ${OURS}\n`);
    expect(codex.install(cmd, env)[1]).toEqual({ file: toml, changed: false, note: "notify current" });
    // A lean install hooks no PreToolUse.
    expect(codex.install(cmd, env, { lean: true })[0]?.changed).toBe(true);
    expect(JSON.parse(readFileSync(path.join(home, ".codex", "hooks.json"), "utf8")).hooks.PreToolUse).toBeUndefined();
    expect(codex.installed(cmd, env, { lean: true })[0]?.state).toBe("current");
    writeFileSync(toml, `[projects."/x"]\ntrust_level = "trusted"\nnotify = ${OURS}\n`);
    expect(notifyState()).toBe("misplaced");
    expect(codex.install(cmd, env)[1]?.note).toContain("moved to the top level");
    expect(readFileSync(toml, "utf8")).toBe(`notify = ${OURS}\n\n[projects."/x"]\ntrust_level = "trusted"\n`);
  });
  it("Codex Computer Use holding the slot: ours is chained behind it, kept current, re-chained when old, left alone when another's", () => {
    writeFileSync(toml, `notify = ["${CU}", "turn-ended"]\n`);
    expect(notifyState()).toBe("missing");
    expect(codex.install(cmd, env)[1]?.note).toContain("chained");
    expect(notifyState()).toBe("current");
    expect(codex.install(cmd, env)[1]).toEqual({
      file: toml,
      changed: false,
      note: "notify current (after Codex Computer Use)",
    });
    writeFileSync(toml, `notify = ["${CU}", "turn-ended", "--previous-notify", ${JSON.stringify(OLD)}]\n`);
    expect(notifyState()).toBe("missing");
    expect(codex.install(cmd, env)[1]?.note).toContain("chained");
    expect(readFileSync(toml, "utf8")).toContain(JSON.stringify(OURS));
    expect(codex.uninstall(env)[1]).toEqual({ file: toml, changed: true });
    expect(readFileSync(toml, "utf8")).toBe(`notify = ["${CU}", "turn-ended"]\n`);
    writeFileSync(toml, `notify = ["${CU}", "turn-ended", "--previous-notify", "[\\"/usr/bin/say\\", \\"done\\"]"]\n`);
    expect(codex.install(cmd, env)[1]).toMatchObject({ skipped: true, note: expect.stringContaining("left alone") });
    expect(codex.uninstall(env)[1]).toEqual({ file: toml, changed: false });
  });
  it("a notify that is not an array is another tool's; no file or no notify is nothing to remove", () => {
    writeFileSync(toml, 'notify = "say done"\n');
    expect(codex.install(cmd, env)[1]).toMatchObject({ skipped: true, note: expect.stringContaining("say done") });
    expect(notifyState()).toBe("missing");
    expect(codex.uninstall(env)[1]).toEqual({ file: toml, changed: false });
    rmSync(toml);
    expect(codex.uninstall(env)[1]).toEqual({ file: toml, changed: false });
    expect(notifyState()).toBe("missing");
    writeFileSync(toml, 'model = "x"\n');
    expect(codex.uninstall(env)[1]).toEqual({ file: toml, changed: false });
  });
});

describe("codex limits: the newest rate_limits a turn wrote in the rollout", () => {
  const rec = (o: unknown) => JSON.stringify(o);
  const tokens = (rate_limits: unknown) =>
    rec({
      type: "event_msg",
      timestamp: "2026-10-21T20:23:13.395Z",
      payload: { type: "token_count", info: null, rate_limits },
    });
  const file = (lines: string[]) => {
    const f = path.join(home, "rollout.jsonl");
    // A rollout opens with its session_meta (a short file's tail read skips line one).
    writeFileSync(f, `${[rec({ type: "session_meta", payload: { id: SID } }), ...lines].join("\n")}\n`);
    return f;
  };
  // Recorded 2026-10-21, codex-cli 0.163.0-alpha.11 (a Pro Lite account: one weekly window).
  const recorded = {
    limit_id: "codex",
    limit_name: null,
    primary: { used_percent: 6.0, window_minutes: 10080, resets_at: 1793099533 },
    secondary: null,
    credits: { has_credits: false, unlimited: false, balance: "0" },
    individual_limit: null,
    spend_control_reached: null,
    plan_type: "prolite",
    rate_limit_reached_type: null,
  };

  it("reads the last token_count that carries them, past later records without", () => {
    const f = file([
      tokens({ primary: { used_percent: 1, window_minutes: 300, resets_at: 1793000000 } }),
      tokens(recorded),
      tokens(null),
      rec({ type: "event_msg", payload: { type: "agent_message", message: "done" } }),
      "not json",
    ]);
    expect(codex.limits?.(f)).toEqual({
      windows: [{ id: "primary", used_percent: 6, window_minutes: 10080, resets_at: "2026-10-27T11:12:13.000Z" }],
      plan: "prolite",
    });
  });
  it("keeps both windows, and only what each one says", () => {
    const f = file([
      tokens({
        primary: { used_percent: 23.5, window_minutes: 300 },
        secondary: { used_percent: 41, window_minutes: 1.5, resets_at: "soon" },
      }),
    ]);
    expect(codex.limits?.(f)).toEqual({
      windows: [
        { id: "primary", used_percent: 23.5, window_minutes: 300 },
        { id: "secondary", used_percent: 41 },
      ],
    });
  });
  it("reads the account's codex bucket, past a newer snapshot of a model's own", () => {
    const f = file([
      tokens(recorded),
      tokens({ ...recorded, limit_id: "codex_other", primary: { used_percent: 90, window_minutes: 300 } }),
    ]);
    expect(codex.limits?.(f)?.windows).toEqual([
      { id: "primary", used_percent: 6, window_minutes: 10080, resets_at: "2026-10-27T11:12:13.000Z" },
    ]);
    expect(codex.limits?.(file([tokens({ ...recorded, limit_id: "codex_other" })]))).toBeNull();
  });
  it("is null with no window to read, no token_count, or no file", () => {
    expect(codex.limits?.(file([tokens({ primary: null, secondary: { used_percent: -1 } })]))).toBeNull();
    expect(codex.limits?.(file([]))).toBeNull();
    expect(codex.limits?.(path.join(home, "missing.jsonl"))).toBeNull();
  });
});
