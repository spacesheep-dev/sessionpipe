// SPDX-License-Identifier: Apache-2.0
// Which Codex threads are sessions of their own, measured on codex-cli 0.160.0
// (2026-10-20). Codex Desktop runs its own background threads (ambient suggestions,
// their safety review, a new chat's title) as ephemeral threads: no rollout, and
// `transcript_path: null` on every hook. A subagent's thread belongs to its parent:
// the parent's hooks report it (SubagentStart, SubagentStop, its tool calls under the
// parent's session_id), while notify names the subagent's own thread. Ids, folders and
// words below are synthetic; the record shapes are the recorded ones.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codex } from "../src/adapters/codex.js";
import type { HookInput } from "../src/adapters/types.js";

const ROOT = "01a15698-0000-7000-8000-000000000001";
const CHILD = "01a1569c-0000-7000-8000-000000000002";
const FORK = "01a156a0-0000-7000-8000-000000000003";
const EPHEMERAL = "01a15a50-0000-7000-8000-000000000004";

const homes: string[] = [];
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const meta = (id: string, payload: Record<string, unknown>) =>
  JSON.stringify({
    timestamp: "2026-10-20T00:00:00.000Z",
    type: "session_meta",
    payload: { id, session_id: id, cwd: "/workspace", cli_version: "0.160.0", source: "vscode", ...payload },
  });
const message = (role: "user" | "assistant", text: string, at: string) =>
  JSON.stringify({
    timestamp: at,
    type: "response_item",
    payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] },
  });
const own = (id: string) =>
  JSON.stringify({
    timestamp: "2026-10-20T00:00:01.000Z",
    type: "event_msg",
    payload: { type: "thread_settings_applied", thread_id: id },
  });

/** A CODEX_HOME holding the root thread, a subagent it spawned and a fork the person made. */
function codexHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "sp-codex-threads-"));
  homes.push(home);
  const day = path.join(home, "sessions", "2026", "10", "19");
  mkdirSync(day, { recursive: true });
  const write = (id: string, lines: string[]) =>
    writeFileSync(path.join(day, `rollout-2026-10-19T17-00-00-${id}.jsonl`), `${lines.join("\n")}\n`);
  write(ROOT, [
    meta(ROOT, {}),
    message("user", "Design a camera mount", "2026-10-20T00:00:02.000Z"),
    message("assistant", "Three agents are on it.", "2026-10-20T00:00:30.000Z"),
  ]);
  write(CHILD, [
    meta(CHILD, {
      session_id: ROOT,
      forked_from_id: ROOT,
      parent_thread_id: ROOT,
      thread_source: "subagent",
      agent_nickname: "Galileo",
      agent_path: "/root/source_research",
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: ROOT,
            depth: 1,
            agent_path: "/root/source_research",
            agent_nickname: "Galileo",
            agent_role: null,
          },
        },
      },
    }),
    meta(ROOT, {}),
    message("user", "Design a camera mount", "2026-10-20T00:00:02.000Z"),
    own(CHILD),
    message("assistant", "Found the datasheet.", "2026-10-20T00:03:52.000Z"),
  ]);
  write(FORK, [
    meta(FORK, { forked_from_id: ROOT }),
    meta(ROOT, {}),
    message("user", "Design a camera mount", "2026-10-20T00:00:02.000Z"),
    own(FORK),
    message("user", "Try a lighter mount", "2026-10-20T00:40:00.000Z"),
    message("assistant", "Lighter version drawn.", "2026-10-20T00:41:00.000Z"),
  ]);
  return home;
}

const notify = (home: string, threadId: string): HookInput => ({
  argv: [
    "codex",
    "notify",
    JSON.stringify({
      type: "agent-turn-complete",
      "thread-id": threadId,
      "turn-id": "01a1569c-0000-7000-8000-0000000000aa",
      cwd: "/workspace",
      client: "Codex Desktop",
      "input-messages": [],
      "last-assistant-message": "done",
    }),
  ],
  stdin: "",
  env: { CODEX_HOME: home },
  cwd: "/workspace",
});
const hook = (home: string, event: string, payload: Record<string, unknown>): HookInput => ({
  argv: ["codex", event],
  stdin: JSON.stringify({ hook_event_name: event, cwd: "/", model: "gpt-6-luna", ...payload }),
  env: { CODEX_HOME: home },
  cwd: "/",
});
const rollout = (home: string, id: string) =>
  path.join(home, "sessions", "2026", "10", "19", `rollout-2026-10-19T17-00-00-${id}.jsonl`);

describe("Codex threads that are not sessions of their own", () => {
  it("reports nothing for an ephemeral thread's hooks, which say transcript_path null", () => {
    const home = codexHome();
    const base = { session_id: EPHEMERAL, transcript_path: null, permission_mode: "bypassPermissions" };
    const turn = { ...base, turn_id: "01a15a50-0000-7000-8000-0000000000bb" };
    expect(codex.fromHook(hook(home, "SessionStart", { ...base, source: "startup" }))).toBeNull();
    expect(codex.fromHook(hook(home, "UserPromptSubmit", { ...turn, prompt: "# Overview\n\nGenerate…" }))).toBeNull();
    expect(
      codex.fromHook(
        hook(home, "PostToolUse", {
          ...turn,
          tool_name: "mcp__codex_apps__gmail__search_emails",
          tool_use_id: "exec-0",
          tool_input: {},
          tool_response: "[]",
        }),
      ),
    ).toBeNull();
    expect(codex.fromHook(hook(home, "Stop", { ...turn, stop_hook_active: false }))).toBeNull();
    expect(codex.fromHook(hook(home, "SessionEnd", { ...base, reason: "other" }))).toBeNull();
  });

  it("still reports a hook that names no transcript_path at all", () => {
    const r = codex.fromHook(hook(codexHome(), "SessionStart", { session_id: ROOT, source: "startup" }));
    expect(r?.events.map((e) => e.type)).toEqual(["session.started"]);
    expect(r?.transcript).toBeUndefined();
  });

  it("reports nothing for an ephemeral thread's notify: it has no rollout", () => {
    expect(codex.fromHook(notify(codexHome(), EPHEMERAL))).toBeNull();
  });

  it("reports nothing for a subagent's notify; its parent's hooks already carry it", () => {
    expect(codex.fromHook(notify(codexHome(), CHILD))).toBeNull();
  });

  it("reports the root thread's notify, and a fork the person made, with their rollouts", () => {
    const home = codexHome();
    for (const id of [ROOT, FORK]) {
      const r = codex.fromHook(notify(home, id));
      expect(r?.session.id).toBe(id);
      expect(r?.events.map((e) => e.type)).toEqual(["turn.ended"]);
      expect(r?.transcript).toBe(rollout(home, id));
    }
  });

  it("takes a rollout that doesn't open with its own session_meta for the person's", () => {
    const home = codexHome();
    for (const first of ["{not json", JSON.stringify({ type: "event_msg", payload: { type: "task_started" } })]) {
      writeFileSync(
        rollout(home, ROOT),
        `${first}\n${message("user", "Design a camera mount", "2026-10-20T00:00:02.000Z")}\n`,
      );
      expect(codex.fromHook(notify(home, ROOT))?.events.map((e) => e.type)).toEqual(["turn.ended"]);
    }
  });

  it("keeps a subagent's tool call on its parent without reading the subagent's rollout as the parent's", () => {
    const home = codexHome();
    const call = (transcript_path: string) =>
      codex.fromHook(
        hook(home, "PostToolUse", {
          session_id: ROOT,
          turn_id: "01a1569c-0000-7000-8000-0000000000cc",
          transcript_path,
          permission_mode: "default",
          tool_name: "Bash",
          tool_use_id: "exec-1",
          tool_input: { command: "ls" },
          tool_response: "a.stl",
        }),
      );
    const inChild = call(rollout(home, CHILD));
    expect(inChild?.session.id).toBe(ROOT);
    expect(inChild?.events.map((e) => e.type)).toEqual(["tool.ended"]);
    expect(inChild?.transcript).toBeUndefined();
    expect(call(rollout(home, ROOT))?.transcript).toBe(rollout(home, ROOT));
    expect(call("/elsewhere/transcript.jsonl")?.transcript).toBe("/elsewhere/transcript.jsonl");
  });

  it("backfills the root thread and a fork the person made, never a subagent", () => {
    const rows = codex.backfill!(0, { CODEX_HOME: codexHome() });
    expect(rows.map((r) => r.session.id).sort()).toEqual([ROOT, FORK].sort());
  });
});
