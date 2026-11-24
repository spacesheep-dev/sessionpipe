// SPDX-License-Identifier: Apache-2.0
// A Codex turn whose Stop hook fires before the rollout says the turn is over: the hook
// came ahead of Codex's `task_complete`, or the Stop was answered with a block (a message
// handed over, CONTROL.md §6 `turn`) and the turn goes on. The worker holds that turn back
// until the file says it is over, so it goes out once and whole (spec/ADAPTERS.md, Codex).
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { frameMarked, IN_PLACE_ANSWER } from "@sessionpipe/core/control";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Clock, runJob, SETTLE_FAST_MS } from "../src/run.js";

const THREAD = "0199b6f2-7c1d-7e3a-9b4c-5d6e7f8a9b0c";
let tmp: string;
let state: string;
let rollout: string;
let n = 0;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "sp-codex-growing-"));
  state = path.join(tmp, "state");
  const day = path.join(tmp, "codex", "sessions", "2026", "11", "24");
  mkdirSync(day, { recursive: true });
  rollout = path.join(day, `rollout-2026-11-24T11-11-00-${THREAD}.jsonl`);
  writeFileSync(rollout, "");
  vi.stubEnv("SESSIONPIPE_CONFIG", path.join(tmp, "config.json"));
  writeFileSync(
    path.join(tmp, "config.json"),
    JSON.stringify({ sinks: [{ name: "f", url: `file:${path.join(tmp, "events.jsonl")}`, tier: 2 }], harnesses: {} }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

const row = (type: string, payload: Record<string, unknown>) =>
  appendFileSync(rollout, `${JSON.stringify({ timestamp: "2026-11-24T19:11:00.000Z", type, payload })}\n`);
const says = (role: string, text: string) =>
  row("response_item", {
    type: "message",
    role,
    content: [{ type: role === "user" ? "input_text" : "output_text", text }],
  });
const began = () => row("event_msg", { type: "task_started", turn_id: "t1" });
const over = () => row("event_msg", { type: "task_complete", turn_id: "t1" });
/** The message a blocked Stop hands over, as Codex writes it down. */
const handed = (text: string) =>
  says(
    "user",
    `<hook_prompt hook_run_id="stop:10:/h/hooks.json">${`${frameMarked(text, "https://board.example.com", "01JD0000000000000123456789")}\n\n${IN_PLACE_ANSWER}`
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")}</hook_prompt>`,
  );
const stop = () => ({
  id: `job-${n++}`,
  harness: "codex",
  event: "Stop",
  argv: ["codex", "Stop"],
  stdin: JSON.stringify({
    session_id: THREAD,
    turn_id: "t1",
    transcript_path: rollout,
    cwd: tmp,
    hook_event_name: "Stop",
  }),
  cwd: tmp,
  env: {},
  at: Date.now(),
});
/** A Stop the hook answered with a message for the session (hook.ts). */
const answered = () => ({ ...stop(), continued: true });
const sessionEnd = () => ({
  ...stop(),
  event: "SessionEnd",
  argv: ["codex", "SessionEnd"],
  stdin: JSON.stringify({ session_id: THREAD, transcript_path: rollout, cwd: tmp, hook_event_name: "SessionEnd" }),
});
const shown = (events: { type: string; data: unknown }[]) =>
  events.map((e) => {
    const d = e.data as { user?: string; assistant?: string; injected?: boolean };
    return e.type === "turn.transcript" ? [e.type, d.user, d.assistant, ...(d.injected ? ["injected"] : [])] : [e.type];
  });
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

describe("a Codex turn that is not over in its rollout when its Stop is read", () => {
  it("a Stop nothing answered: the turn goes at once, as it stands, whatever the file's end record", async () => {
    // The hook can come ahead of Codex's `task_complete` (a slow Stop hook of the person's
    // own holds it back for as long as it runs): the turn is over all the same.
    began();
    says("user", "what is in the folder?");
    says("assistant", "One file.");
    const w = waits();
    const { events } = await runJob(stop(), { state, clock: w.clock });
    expect(shown(events)).toEqual([["turn.ended"], ["turn.transcript", "what is in the folder?", "One file."]]);
    expect(w.slept).toEqual([]);
  });

  it("the Stop was answered with a message: the turn before it goes at once, the message's own turn when it is over", async () => {
    began();
    says("user", "what is in the folder?");
    says("assistant", "One file.");
    handed("and how big is it?");
    // The first Stop's worker reads late: the continuation has said something and gone to a tool.
    says("assistant", "Let me look first.");
    const w = waits();
    const first = await runJob(answered(), { state, clock: w.clock });
    expect(shown(first.events)).toEqual([["turn.ended"], ["turn.transcript", "what is in the folder?", "One file."]]);
    // Nothing to look again for: the message's turn ends at the turn's next Stop.
    expect(w.slept).toEqual([]);
    says("assistant", "12 bytes.");
    over();
    const second = await runJob(stop(), { state, drain: false });
    expect(shown(second.events)).toEqual([
      ["turn.ended"],
      ["turn.transcript", "and how big is it?", "Let me look first.\n\n12 bytes.", "injected"],
    ]);
  });

  it("read before Codex wrote the message down: a second look, and the turn the Stop ended goes", async () => {
    began();
    says("user", "what is in the folder?");
    says("assistant", "One file.");
    const w = waits((k) => {
      if (k === 2) handed("and how big is it?");
    });
    const { events } = await runJob(answered(), { state, clock: w.clock });
    expect(shown(events)).toEqual([["turn.ended"], ["turn.transcript", "what is in the folder?", "One file."]]);
    expect(w.slept).toEqual([25, 25]);
  });

  it("the message's row never comes (Codex was killed): the look ends, and the session's end sends what there is", async () => {
    began();
    says("user", "what is in the folder?");
    says("assistant", "One file.");
    const w = waits();
    const { events } = await runJob(answered(), { state, clock: w.clock });
    expect(shown(events)).toEqual([["turn.ended"]]);
    // Under the lock for SETTLE_FAST_MS at most; the rest of the looking is outside it.
    expect(w.slept.filter((ms) => ms === 25).reduce((a, b) => a + b, 0)).toBe(SETTLE_FAST_MS);
    expect(readFileSync(path.join(state, "log"), "utf8")).toContain("waits for the session's next hook");
    const end = await runJob(sessionEnd(), { state, drain: false });
    expect(shown(end.events)).toEqual([["session.ended"], ["turn.transcript", "what is in the folder?", "One file."]]);
  });
});
