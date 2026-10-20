// SPDX-License-Identifier: Apache-2.0
// turn.progress: a running turn's words reach a tier-2 sink before the turn ends
// (a 21-minute turn showed nothing on its receiver for 21 minutes, 2026-10-11).
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { filterEvent } from "@sessionpipe/core";
import { afterAll, describe, expect, it } from "vitest";
import { openTurn, PROGRESS_MS, runJob } from "../src/run.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "sp-progress-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const out = path.join(tmp, "events.jsonl");
process.env.SESSIONPIPE_CONFIG = path.join(tmp, "config.json");
writeFileSync(
  process.env.SESSIONPIPE_CONFIG,
  JSON.stringify({ sinks: [{ name: "f", url: `file:${out}`, tier: 2 }], harnesses: {} }),
);

const transcript = path.join(tmp, "t.jsonl");
writeFileSync(transcript, "");
const line = (role: "user" | "assistant", text: string, at: string) =>
  appendFileSync(
    transcript,
    `${JSON.stringify(
      role === "user"
        ? { type: "user", timestamp: at, message: { role, content: text } }
        : { type: "assistant", timestamp: at, message: { role, content: [{ type: "text", text }] } },
    )}\n`,
  );

let clock = Date.parse("2026-10-11T21:36:00.000Z");
const job = (event: string, extra: Record<string, unknown> = {}) => ({
  harness: "claude-code",
  event,
  argv: ["claude-code", event],
  stdin: JSON.stringify({
    session_id: "live-1",
    cwd: tmp,
    hook_event_name: event,
    transcript_path: transcript,
    ...extra,
  }),
  cwd: tmp,
  env: { CLAUDE_CONFIG_DIR: tmp },
  at: clock,
});
const sent = () =>
  existsSync(out)
    ? readFileSync(out, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
const progress = () => sent().filter((e) => e.type === "turn.progress");
const tool = (id: string) =>
  job("PostToolUse", { tool_name: "Bash", tool_input: { command: "ls" }, tool_response: "ok", tool_use_id: id });

describe("turn.progress", () => {
  it("the prompt goes out as the turn starts, before the transcript holds it", async () => {
    await runJob(job("SessionStart", { source: "startup" }), { state: tmp });
    await runJob(job("UserPromptSubmit", { prompt: "Build the thermal viewer" }), { state: tmp });
    const p = progress();
    expect(p).toHaveLength(1);
    expect(p[0].tier).toBe(2);
    expect(p[0].data).toMatchObject({ turn: 0, user: "Build the thermal viewer", assistant: "" });
  });

  it("what it has said so far follows on a tool call, at most every PROGRESS_MS", async () => {
    line("user", "Build the thermal viewer", "2026-10-11T21:36:00.000Z");
    line("assistant", "Reading the dashboard source.", "2026-10-11T21:36:05.000Z");
    clock += 5_000;
    await runJob(tool("a"), { state: tmp });
    expect(progress()).toHaveLength(1); // 5 s after the prompt: too soon
    clock += PROGRESS_MS;
    await runJob(tool("b"), { state: tmp });
    expect(progress()).toHaveLength(2);
    expect(progress()[1].data).toMatchObject({
      turn: 0,
      user: "Build the thermal viewer",
      assistant: "Reading the dashboard source.",
    });
    clock += PROGRESS_MS;
    await runJob(tool("c"), { state: tmp });
    expect(progress()).toHaveLength(2); // nothing new said: nothing sent
    line("assistant", "Writing the viewer module now.", "2026-10-11T21:37:00.000Z");
    clock += PROGRESS_MS;
    await runJob(tool("d"), { state: tmp });
    expect(progress()[2].data.assistant).toBe("Reading the dashboard source.\n\nWriting the viewer module now.");
  });

  it("the turn's end delivers it whole under the same number, and no progress rides with it", async () => {
    line("assistant", "The viewers are live.", "2026-10-11T21:57:00.000Z");
    clock += 60_000;
    const before = progress().length;
    await runJob(job("Stop"), { state: tmp });
    expect(progress()).toHaveLength(before);
    const t = sent().filter((e) => e.type === "turn.transcript");
    expect(t).toHaveLength(1);
    expect(t[0].data.turn).toBe(0);
    // The next turn is numbered after it.
    clock += 60_000;
    await runJob(job("UserPromptSubmit", { prompt: "Now the floorplans" }), { state: tmp });
    expect(progress().at(-1).data).toMatchObject({ turn: 1, user: "Now the floorplans", assistant: "" });
    const end = await runJob(job("SessionEnd", { reason: "other" }), { state: tmp });
    expect(end.events.map((e) => e.type)).toEqual(["session.ended"]);
    expect(end.delivered).toEqual({ f: 1 });
    expect(sent().at(-1)).toMatchObject({ type: "session.ended", data: { reason: "other" } });
    expect(sent().filter((e) => e.type === "turn.transcript")).toHaveLength(1);
  });

  it("a long reply keeps its end, for the sender and for every sink", () => {
    const long = `${"a".repeat(30_000)}THE END`;
    const p = openTurn({ turns: [{ user: "q", assistant: long, at: 1, endLine: 2 }], line: 3 }, { base: 4, at: 9 });
    expect(p).toMatchObject({ turn: 4, user: "q", at: 1 });
    expect(p?.assistant.length).toBe(20_000);
    expect(p?.assistant.startsWith("…")).toBe(true);
    expect(p?.assistant.endsWith("THE END")).toBe(true);
    const e = {
      v: 1,
      id: "01J0000000000000000000000",
      type: "turn.progress",
      time: "2026-10-11T21:36:00.000Z",
      tier: 2,
      harness: { name: "claude-code" },
      session: { id: "s", seq: 1 },
      data: { turn: 0, user: "q", assistant: long, at: "2026-10-11T21:36:00.000Z" },
    };
    // biome-ignore lint/suspicious/noExplicitAny: a hand-built event
    const f = filterEvent(e as any, 2, false);
    expect(String(f?.data.assistant).endsWith("THE END")).toBe(true);
    // biome-ignore lint/suspicious/noExplicitAny: a hand-built event
    expect(filterEvent(e as any, 1, false)).toBeNull();
  });

  it("a prompt the transcript already answered is that turn, not a new one", () => {
    const read = { turns: [{ user: "Fix the bug", assistant: "On it.", at: 5, endLine: 2 }], line: 3 };
    expect(openTurn(read, { base: 0, prompt: "Fix the bug", at: 9 })).toMatchObject({ turn: 0, assistant: "On it." });
    expect(openTurn(read, { base: 0, prompt: "Something else", at: 9 })).toMatchObject({
      turn: 1,
      user: "Something else",
      assistant: "",
    });
    expect(openTurn({ turns: [], line: 0 }, { base: 0, at: 9 })).toBeNull();
  });
});

// A message sent while a turn runs is absorbed by that turn: Claude Code writes it as a
// `queued_command` attachment and fires UserPromptSubmit with the running turn's own
// prompt_id (2.1.301, recorded 2026-10-20). Its reading went out numbered as the next
// turn, which the transcript never delivers, and the receiver kept that reading, its
// reply empty, in place of the running turn ("Starting on it…" for 1 h 20 min).
describe("turn.progress: a message absorbed mid-turn", () => {
  const sid = "absorb-1";
  const tr = path.join(tmp, "absorb.jsonl");
  writeFileSync(tr, "");
  const rec = (r: Record<string, unknown>) => appendFileSync(tr, `${JSON.stringify(r)}\n`);
  const ask = (text: string, at: string, origin: Record<string, unknown> = { kind: "human" }) =>
    rec({ type: "user", timestamp: at, origin, message: { role: "user", content: text } });
  const say = (text: string, at: string) =>
    rec({ type: "assistant", timestamp: at, message: { role: "assistant", content: [{ type: "text", text }] } });
  const queued = (prompt: string, origin: Record<string, unknown>, at: string) =>
    rec({
      type: "attachment",
      timestamp: at,
      attachment: { type: "queued_command", prompt, commandMode: "prompt", origin, timestamp: at },
    });
  let t = Date.parse("2026-10-20T19:49:03.000Z");
  const hook = (event: string, extra: Record<string, unknown> = {}) => ({
    harness: "claude-code",
    event,
    argv: ["claude-code", event],
    stdin: JSON.stringify({ session_id: sid, cwd: tmp, hook_event_name: event, transcript_path: tr, ...extra }),
    cwd: tmp,
    env: { CLAUDE_CONFIG_DIR: tmp },
    at: t,
  });
  const toolDone = (prompt_id: string, n: string) =>
    hook("PostToolUse", {
      prompt_id,
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_response: "ok",
      tool_use_id: n,
    });
  const mine = () => sent().filter((e) => e.session?.id === sid);
  const readings = () =>
    mine()
      .filter((e) => e.type === "turn.progress")
      .map((e) => e.data);
  const delivered = () =>
    mine()
      .filter((e) => e.type === "turn.transcript")
      .map((e) => e.data.turn);

  it("another session's message keeps the reading on the turn that absorbed it", async () => {
    const P = "b55c909a-463d-456d-8c3a-635713272ac3";
    await runJob(hook("SessionStart", { source: "startup" }), { state: tmp });
    await runJob(hook("UserPromptSubmit", { prompt_id: P, prompt: "Write the hub update" }), { state: tmp });
    ask("Write the hub update", "2026-10-20T19:49:03.100Z");
    say("All 12 readers came back.", "2026-10-20T19:49:12.797Z");
    t += PROGRESS_MS;
    await runJob(toolDone(P, "t1"), { state: tmp });
    const peer =
      '<cross-session-message from="uds:/tmp/cc-socks/76094.sock" from-name="gyroscope-b4" from-mode="bypass">' +
      "Agreed: I won't touch the hub until your commit lands.</cross-session-message>";
    t += 60_000;
    await runJob(hook("UserPromptSubmit", { prompt_id: P, prompt: peer }), { state: tmp });
    queued(peer, { kind: "peer", name: "gyroscope-b4" }, "2026-10-20T19:51:43.392Z");
    say("The second workflow is running.", "2026-10-20T19:58:17.469Z");
    t += PROGRESS_MS;
    await runJob(toolDone(P, "t2"), { state: tmp });
    t += 5_000;
    await runJob(hook("Stop", { prompt_id: P }), { state: tmp });
    expect(delivered()).toEqual([0]);
    expect(readings().map((r) => r.turn)).toEqual([0, 0, 0, 0]);
    expect(readings().some((r) => String(r.user).includes("cross-session-message"))).toBe(false);
    expect(readings().at(-1)).toMatchObject({
      user: "Write the hub update",
      assistant: "All 12 readers came back.\n\nThe second workflow is running.",
    });
  });

  it("the person's own mid-turn message opens no turn the transcript won't deliver", async () => {
    const Q = "9e6a05a5-2448-4d2e-bb55-2f6e39a45a71";
    t += 60_000;
    await runJob(hook("UserPromptSubmit", { prompt_id: Q, prompt: "Troubleshoot the session page" }), { state: tmp });
    ask("Troubleshoot the session page", "2026-10-20T21:14:52.869Z");
    say("Reading the board row first.", "2026-10-20T21:16:30.000Z");
    t += PROGRESS_MS;
    await runJob(toolDone(Q, "t3"), { state: tmp });
    const also = "Also, the other session should be under Working.";
    t += 10_000;
    await runJob(hook("UserPromptSubmit", { prompt_id: Q, prompt: also }), { state: tmp });
    queued(also, { kind: "human" }, "2026-10-20T21:16:43.004Z");
    say("Noted; looking at that one too.", "2026-10-20T21:18:05.000Z");
    t += PROGRESS_MS;
    await runJob(toolDone(Q, "t4"), { state: tmp });
    t += 5_000;
    await runJob(hook("Stop", { prompt_id: Q }), { state: tmp });
    // Whichever turn the transcript files the message under, every reading is of a
    // turn it delivers: none is left standing for the receiver to show.
    const turns = readings()
      .slice(4)
      .map((r) => r.turn);
    expect(turns.length).toBeGreaterThan(0);
    for (const n of turns) expect(delivered()).toContain(n);
  });

  it("a task notification starts a turn without being its ask", async () => {
    const R = "0efce330-aa04-4bed-aed9-33c376e56e30";
    const note =
      "<task-notification>\n<task-id>w0wdh6zft</task-id>\n<status>completed</status>\n" +
      '<summary>Workflow "readers" completed</summary>\n</task-notification>';
    t += 60_000;
    const before = readings().length;
    await runJob(hook("UserPromptSubmit", { prompt_id: R, prompt: note }), { state: tmp });
    ask(note, "2026-10-20T21:30:00.000Z", { kind: "task-notification", producer: "session-task" });
    expect(readings()).toHaveLength(before); // nothing to read yet, and the notification is no ask
    say("The readers are back.", "2026-10-20T21:30:09.000Z");
    t += PROGRESS_MS;
    await runJob(toolDone(R, "t5"), { state: tmp });
    expect(readings().at(-1)).toMatchObject({ user: "", assistant: "The readers are back." });
    expect(readings().some((r) => String(r.user).startsWith("<task-notification>"))).toBe(false);
  });
});
