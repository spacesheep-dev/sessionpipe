// SPDX-License-Identifier: Apache-2.0
// Codex's adapter beyond the fixtures: the notify fallback (one JSON argument, not
// stdin), the events no payload was recorded for, and every way config.toml's notify
// line can already be taken — ours, moved into a table, Codex Computer Use's with or
// without ours chained behind it, another tool's. All in a temp CODEX_HOME.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codex } from "../src/adapters/codex.js";
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
      hints: {},
      transcript: f,
    });
    expect(hook("notify", JSON.stringify({ thread_id: SID }), env)?.session).toEqual({ id: SID, cwd: "/" });
    expect(hook("notify", JSON.stringify({ "session-id": SID }), env)?.events[0]?.data).toEqual({ reason: "stop" });
    expect(hook("notify", JSON.stringify({ session_id: SID }), env)?.session.id).toBe(SID);
    expect(hook("notify", "", env)).toBeNull();
    expect(hook("notify", "null", env)).toBeNull();
    expect(hook("notify", "[]", env)).toBeNull();
    expect(hook("notify", "", env, ["{ broken"])).toBeNull();
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
