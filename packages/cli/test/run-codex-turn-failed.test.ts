// SPDX-License-Identifier: Apache-2.0
// A Codex turn that failed at the model's service fires no Stop hook and no notify
// (measured on codex-cli 0.171.0): the hooks hold it as running. The worker asks the
// rollout how it ended as soon as something shows it cannot be running any more, and
// reports that first, at every tier (spec/ADAPTERS.md, Codex).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runJob } from "../src/run.js";

const THREAD = "0199b6f2-7c1d-7e3a-9b4c-5d6e7f8a9b0c";
let tmp: string;
let state: string;
let rollout: string;
let sink: string;
let n = 0;

const config = (sinks: unknown[]) =>
  writeFileSync(path.join(tmp, "config.json"), JSON.stringify({ sinks, harnesses: {} }));
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "sp-codex-failed-"));
  state = path.join(tmp, "state");
  const day = path.join(tmp, "codex", "sessions", "2026", "11", "24");
  mkdirSync(day, { recursive: true });
  rollout = path.join(day, `rollout-2026-11-24T09-31-29-${THREAD}.jsonl`);
  sink = path.join(tmp, "events.jsonl");
  vi.stubEnv("SESSIONPIPE_CONFIG", path.join(tmp, "config.json"));
  config([]);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

const line = (type: string, payload: Record<string, unknown>) =>
  JSON.stringify({ timestamp: "2026-11-24T17:31:29.000Z", type, payload });
const asked = (text: string) =>
  line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text }] });
const said = (text: string) =>
  line("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text }] });
const failed = (turn: string, cls: unknown = "usage_limit_exceeded") =>
  line("event_msg", {
    type: "task_complete",
    turn_id: turn,
    last_agent_message: null,
    error: { message: "You've hit your usage limit. Try again at 2:40 PM.", codex_error_info: cls },
  });
const done = (turn: string, last: string) =>
  line("event_msg", { type: "task_complete", turn_id: turn, last_agent_message: last });
const write = (...lines: string[]) => writeFileSync(rollout, `${lines.join("\n")}\n`);

/** A Codex hook's job, as 0.171 fires it. */
const hook = (event: string, extra: Record<string, unknown> = {}) => ({
  id: `job-${n++}`,
  harness: "codex",
  event,
  argv: ["codex", event],
  stdin: JSON.stringify({ session_id: THREAD, transcript_path: rollout, cwd: tmp, hook_event_name: event, ...extra }),
  cwd: tmp,
  env: {},
  at: Date.now(),
});
const run = async (event: string, extra: Record<string, unknown> = {}) =>
  (await runJob(hook(event, extra), { state, drain: false })).events.map((e) => ({
    type: e.type,
    ...(e.data as Record<string, unknown>),
  }));

describe("a Codex turn no hook ended", () => {
  it("codex exec: the session's end finds the turn failed and says so first, with the error's class", async () => {
    write(asked("Why did the build fail?"));
    expect(await run("UserPromptSubmit", { turn_id: "t1", prompt: "Why did the build fail?" })).toEqual([
      { type: "turn.started", turn_id: "t1", prompt_chars: 23 },
    ]);
    write(asked("Why did the build fail?"), failed("t1"));
    expect(await run("SessionEnd", { reason: "other" })).toEqual([
      { type: "turn.ended", turn_id: "t1", reason: "error", error: "usage_limit_exceeded" },
      { type: "session.ended", reason: "other" },
    ]);
    // Said once: the turn is no longer held as running.
    expect(await run("SessionStart", { source: "resume" })).toEqual([{ type: "session.started", source: "resume" }]);
    // None of the error's words went anywhere.
    expect(readFileSync(path.join(state, "log"), "utf8")).not.toContain("usage limit");
  });

  it("an open window: the next prompt finds it, and the two turns are two", async () => {
    write(asked("first"));
    await run("UserPromptSubmit", { turn_id: "t1", prompt: "first" });
    write(
      asked("first"),
      failed("t1", { response_too_many_failed_attempts: { http_status_code: 500 } }),
      asked("second"),
    );
    expect(await run("UserPromptSubmit", { turn_id: "t2", prompt: "second" })).toEqual([
      { type: "turn.ended", turn_id: "t1", reason: "error", error: "response_too_many_failed_attempts" },
      { type: "turn.started", turn_id: "t2", prompt_chars: 6 },
    ]);
    // The second turn is the one held as running now: its own Stop ends it as ever.
    write(asked("first"), failed("t1"), asked("second"), said("ok"), done("t2", "ok"));
    expect(await run("Stop", { turn_id: "t2" })).toEqual([{ type: "turn.ended", turn_id: "t2", reason: "stop" }]);
  });

  it("only a failure is taken from the file: a turn that finished or was stopped waits for its own hook", async () => {
    write(asked("first"));
    await run("UserPromptSubmit", { turn_id: "t1", prompt: "first" });
    // The next prompt's worker comes first; the turn's own Stop is on its way.
    write(asked("first"), said("done"), done("t1", "done"), asked("second"));
    expect(await run("UserPromptSubmit", { turn_id: "t2", prompt: "second" })).toEqual([
      { type: "turn.started", turn_id: "t2", prompt_chars: 6 },
    ]);
    expect(await run("Stop", { turn_id: "t1" })).toEqual([{ type: "turn.ended", turn_id: "t1", reason: "stop" }]);
    // That late end left the second turn held as running: when it fails, that is still found.
    write(asked("first"), said("done"), done("t1", "done"), asked("second"), failed("t2"));
    expect(await run("SessionEnd", { reason: "other" })).toEqual([
      { type: "turn.ended", turn_id: "t2", reason: "error", error: "usage_limit_exceeded" },
      { type: "session.ended", reason: "other" },
    ]);
  });

  it("a stopped turn is ended by its Interrupt hook alone, whichever worker comes first", async () => {
    const aborted = line("event_msg", { type: "turn_aborted", turn_id: "t1", reason: "interrupted" });
    write(asked("first"));
    await run("UserPromptSubmit", { turn_id: "t1", prompt: "first" });
    write(asked("first"), aborted);
    expect(await run("SessionEnd", { reason: "other" })).toEqual([{ type: "session.ended", reason: "other" }]);
    expect(await run("Interrupt", { turn_id: "t1" })).toEqual([
      { type: "turn.ended", turn_id: "t1", reason: "interrupt" },
    ]);
  });

  it("a turn's end with no id, and a session's end, let go of the turn held as running", async () => {
    write(asked("first"));
    await run("UserPromptSubmit", { turn_id: "t1", prompt: "first" });
    await run("Stop");
    write(asked("first"), failed("t1"));
    // Nothing is held any more, so nothing is asked of the file.
    expect(await run("SessionEnd", { reason: "other" })).toEqual([{ type: "session.ended", reason: "other" }]);
  });

  it("nothing is made up: a rollout that does not say the turn is over, a message into the running turn, a tool call", async () => {
    write(asked("first"));
    await run("UserPromptSubmit", { turn_id: "t1", prompt: "first" });
    // A second prompt under the running turn's own id is absorbed by it (a queued message).
    expect(await run("UserPromptSubmit", { turn_id: "t1", prompt: "and this" })).toEqual([
      { type: "turn.started", turn_id: "t1", prompt_chars: 8 },
    ]);
    // A tool call is no sign that the turn is over, whatever the file says; nor is a
    // compaction, which Codex does in the middle of a turn.
    write(asked("first"), failed("t1"));
    const tool = await run("PreToolUse", { turn_id: "t1", tool_name: "Bash", tool_input: { command: "ls" } });
    expect(tool.map((e) => e.type)).toEqual(["tool.started"]);
    expect((await run("PreCompact", { trigger: "auto" })).map((e) => e.type)).toEqual(["context.compacted"]);
    // The file does not name the turn: the next prompt starts a turn and ends none.
    write(asked("first"), asked("second"));
    expect((await run("UserPromptSubmit", { turn_id: "t2", prompt: "second" })).map((e) => e.type)).toEqual([
      "turn.started",
    ]);
  });

  it("tier 2: the failed turn's prompt goes out as its own turn, and the next turn's words are its own", async () => {
    config([{ name: "f", url: `file:${sink}`, tier: 2 }]);
    write(asked("Why did the build fail?"), failed("t1"));
    // The failure is in the file before the prompt's hook is read: nothing is running to show.
    expect(
      (await run("UserPromptSubmit", { turn_id: "t1", prompt: "Why did the build fail?" })).map((e) => e.type),
    ).toEqual(["turn.started"]);
    expect(await run("SessionEnd", { reason: "other" })).toMatchObject([
      { type: "turn.ended", turn_id: "t1", reason: "error", error: "usage_limit_exceeded" },
      { type: "session.ended" },
      { type: "turn.transcript", turn: 0, user: "Why did the build fail?", assistant: "" },
    ]);
    write(
      asked("Why did the build fail?"),
      failed("t1"),
      asked("And now?"),
      said("It is fine."),
      done("t2", "It is fine."),
    );
    await run("UserPromptSubmit", { turn_id: "t2", prompt: "And now?" });
    expect(await run("Stop", { turn_id: "t2" })).toMatchObject([
      { type: "turn.ended", turn_id: "t2", reason: "stop" },
      { type: "turn.transcript", turn: 1, user: "And now?", assistant: "It is fine." },
    ]);
  });
});
