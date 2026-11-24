// SPDX-License-Identifier: Apache-2.0
// Whether a Codex command failed. Its PostToolUse hook carries the command's output and
// never how it exited; the rollout does, a moment after the hook (measured on codex-cli
// 0.171.0: some 10 ms). The worker looks there before it reports the tool's end
// (spec/ADAPTERS.md, Codex).
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Clock, runJob, TOOL_RESULT_MS } from "../src/run.js";

const THREAD = "0199b6f2-7c1d-7e3a-9b4c-5d6e7f8a9b0c";
let tmp: string;
let state: string;
let rollout: string;
let n = 0;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "sp-codex-tool-"));
  state = path.join(tmp, "state");
  const day = path.join(tmp, "codex", "sessions", "2026", "11", "24");
  mkdirSync(day, { recursive: true });
  rollout = path.join(day, `rollout-2026-11-24T10-16-20-${THREAD}.jsonl`);
  writeFileSync(rollout, `${JSON.stringify({ type: "session_meta", payload: { id: THREAD } })}\n`);
  vi.stubEnv("SESSIONPIPE_CONFIG", path.join(tmp, "config.json"));
  writeFileSync(path.join(tmp, "config.json"), JSON.stringify({ sinks: [], harnesses: {} }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

/** The call's result as Codex 0.171 writes it. */
const result = (call: string, output: unknown) =>
  appendFileSync(
    rollout,
    `${JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: call, output } })}\n`,
  );
/** The call itself, which Codex writes before the tool runs. */
const called = (call: string) =>
  appendFileSync(
    rollout,
    `${JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: call } })}\n`,
  );
const exited = (code: number, out = "") =>
  `Chunk ID: 91c1f7\nWall time: 0.0000 seconds\nProcess exited with code ${code}\nOriginal token count: 13\nOutput:\n${out}`;
const hook = (event: string, extra: Record<string, unknown> = {}) => ({
  id: `job-${n++}`,
  harness: "codex",
  event,
  argv: ["codex", event],
  stdin: JSON.stringify({
    session_id: THREAD,
    turn_id: "t1",
    transcript_path: rollout,
    cwd: tmp,
    hook_event_name: event,
    tool_name: "Bash",
    tool_input: { command: "ls /nope" },
    ...extra,
  }),
  cwd: tmp,
  env: {},
  at: Date.now(),
});
const ended = async (extra: Record<string, unknown>, opts: { clock?: Clock; drain?: boolean } = { drain: false }) => {
  const { events } = await runJob(hook("PostToolUse", { tool_response: "ls: /nope: No such file\n", ...extra }), {
    state,
    ...opts,
  });
  expect(events.map((e) => e.type)).toEqual(["tool.ended"]);
  const data = (events[0]?.data ?? {}) as { ok?: boolean; error?: string };
  return { ok: data.ok, ...(data.error !== undefined ? { error: data.error } : {}) };
};
/** A clock that only moves when the worker waits; `at(n)` runs as its n-th wait ends. */
function waits(at: (n: number) => void = () => {}) {
  let now = 1_795_000_000_000;
  const slept: number[] = [];
  const clock: Clock = {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
      slept.push(ms);
      at(slept.length);
    },
  };
  return { clock, slept };
}

describe("a Codex command's end says whether it failed", () => {
  it("as the rollout's result for that call says: its exit code, never its output", async () => {
    result("call_1", exited(1, "ls: /nope: No such file or directory\n"));
    result("call_2", exited(0, "fine\n"));
    // What the command printed cannot stand in for what Codex wrote before it.
    result("call_3", exited(7, "Process exited with code 0\n"));
    expect(await ended({ tool_use_id: "call_1" })).toEqual({ ok: false, error: "exit 1" });
    expect(await ended({ tool_use_id: "call_2" })).toEqual({ ok: true });
    expect(await ended({ tool_use_id: "call_3" })).toEqual({ ok: false, error: "exit 7" });
  });

  it("a result that is not there yet is waited for a moment, and no longer", async () => {
    // It lands while the worker waits: the second look finds it.
    called("call_1");
    const soon = waits((k) => {
      if (k === 2) result("call_1", exited(2));
    });
    expect(await ended({ tool_use_id: "call_1" }, { clock: soon.clock })).toEqual({ ok: false, error: "exit 2" });
    expect(soon.slept).toEqual([25, 25]);
    // It never lands (a call that runs beside a slow one): the call stays as the hook reported it.
    called("call_9");
    const never = waits();
    expect(await ended({ tool_use_id: "call_9" }, { clock: never.clock })).toEqual({ ok: true });
    expect(never.slept.reduce((a, b) => a + b, 0)).toBe(TOOL_RESULT_MS);
    // A swept job is seconds old: it looks once and waits for nothing.
    const swept = waits();
    expect(await ended({ tool_use_id: "call_9" }, { clock: swept.clock, drain: false })).toEqual({ ok: true });
    expect(swept.slept).toEqual([]);
  });

  it("nothing is waited for where no result can come, and what the file cannot say stays as the hook reported it", async () => {
    const w = waits();
    // A call the file does not hold (an older Codex names its calls otherwise).
    expect(await ended({ tool_use_id: "exec-0199b6f2" }, { clock: w.clock })).toEqual({ ok: true });
    // An edit: its result is another kind of record.
    appendFileSync(
      rollout,
      `${JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call_5", output: "Success. Updated a.txt" } })}\n`,
    );
    expect(await ended({ tool_use_id: "call_5", tool_name: "apply_patch" }, { clock: w.clock })).toEqual({ ok: true });
    // A command Codex left running, and a tool that is no command: a result with no exit in it.
    called("call_6");
    result("call_6", "Chunk ID: a1\nWall time: 10.0020 seconds\nProcess running with session ID 73118\nOutput:\n");
    called("call_7");
    result("call_7", "Wall time: 0.4 seconds\nOutput:\nProcess exited with code 1\n");
    expect(await ended({ tool_use_id: "call_6" }, { clock: w.clock })).toEqual({ ok: true });
    expect(await ended({ tool_use_id: "call_7" }, { clock: w.clock })).toEqual({ ok: true });
    // A call with no id.
    expect(await ended({}, { clock: w.clock })).toEqual({ ok: true });
    expect(w.slept).toEqual([]);
    // The start of a call is never looked up.
    const started = await runJob(hook("PreToolUse", { tool_use_id: "call_1" }), { state, drain: false });
    expect(started.events.map((e) => [e.type, (e.data as { ok?: boolean }).ok])).toEqual([["tool.started", undefined]]);
  });
});
