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
