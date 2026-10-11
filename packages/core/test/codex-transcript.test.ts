// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codex, codexFacts } from "../src/adapters/codex.js";
import { codexInjected, readCodex } from "../src/readers/transcripts.js";

// Codex writes the AGENTS.md it read into the session as a "user" message (measured on
// codex-cli 0.160.0, 2026-10-04): a turn and a title built from it named the
// instructions instead of what the person asked.
const user = (text: string) =>
  JSON.stringify({
    type: "response_item",
    timestamp: "2026-10-04T12:00:00Z",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
  });
const assistant = (text: string) =>
  JSON.stringify({
    type: "response_item",
    timestamp: "2026-10-04T12:00:05Z",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
  });
const ROLLOUT = [
  JSON.stringify({ type: "session_meta", payload: { cwd: "/workspace", cli_version: "0.160.0" } }),
  user("# AGENTS.md instructions for /workspace\n\n<INSTRUCTIONS>\n# This machine\n…\n</INSTRUCTIONS>"),
  user("<environment_context>\n  <cwd>/workspace</cwd>\n</environment_context>"),
  user("what folder are you in?"),
  assistant("/workspace"),
];

const dirs: string[] = [];
const rolloutFile = (lines: string[]) => {
  const dir = mkdtempSync(path.join(tmpdir(), "sp-codex-"));
  dirs.push(dir);
  mkdirSync(path.join(dir, "sessions"));
  const file = path.join(dir, "sessions", "rollout-2026-10-09T23-47-06-11111111-1111-4111-8111-111111111111.jsonl");
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("a Codex rollout", () => {
  it("knows Codex's own injections from the person's words", () => {
    expect(codexInjected("# AGENTS.md instructions for /workspace\n\n<INSTRUCTIONS>")).toBe(true);
    expect(codexInjected("<environment_context>")).toBe(true);
    expect(codexInjected("fix the AGENTS.md instructions please")).toBe(false);
  });

  it("pairs the person's ask with the answer, not the instructions", () => {
    const read = readCodex(ROLLOUT, 0);
    expect(read.turns.map((t) => [t.user, t.assistant])).toEqual([["what folder are you in?", "/workspace"]]);
  });

  it("titles the session after the first real ask", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sp-codex-"));
    const file = path.join(dir, "rollout-2026-10-04T12-00-00-01a10928-77cd-7080-b626-70eff7eff680.jsonl");
    writeFileSync(file, `${ROLLOUT.join("\n")}\n`);
    expect(codexFacts(file)).toMatchObject({
      cwd: "/workspace",
      title: "what folder are you in?",
      title_source: "first-ask",
    });
  });

  it("keeps the existing non-forked fixture's serialized output byte for byte", () => {
    const file = rolloutFile(ROLLOUT);
    expect(JSON.stringify(readCodex(ROLLOUT, 0))).toBe(
      '{"turns":[{"user":"what folder are you in?","assistant":"/workspace","at":1791115200000,"endLine":4}],"line":5}',
    );
    expect(JSON.stringify(codexFacts(file))).toBe(
      '{"cwd":"/workspace","harness_version":"0.160.0","title":"what folder are you in?","title_source":"first-ask","started_at":1791115200000,"last_at":1791115205000}',
    );
    expect(JSON.stringify(readCodex([...ROLLOUT, ""], 5))).toBe('{"turns":[],"line":5}');
  });
});

// Entirely synthetic: the reported Codex 0.160.0 layout, including a replayed
// parent session_meta, three completed turns and a pending parent prompt.
const FORK = readFileSync(new URL("./fixtures/codex-forked-subagent.jsonl", import.meta.url), "utf8")
  .trimEnd()
  .split("\n");
const CHILD_TURNS = [
  {
    user: "",
    assistant: "I will inspect the sorting code.\n\nThe sorting code handles the synthetic input.",
    at: Date.parse("2026-10-09T23:47:08.000Z"),
    endLine: 44,
  },
];

describe("a forked Codex subagent rollout", () => {
  it("reads only the child's complete reply with its real timestamp and original line numbers", () => {
    const file = rolloutFile(FORK);
    expect(codex.readTranscript!(file, 0)).toEqual({ turns: CHILD_TURNS, line: 46 });
    const rows = codex.backfill!(0, { CODEX_HOME: path.dirname(path.dirname(file)) });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.session).toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      cwd: "/synthetic/child",
      model: "child-model",
    });
  });

  it("does not title the child after the parent's ask or inherit its model", () => {
    const facts = codexFacts(rolloutFile(FORK));
    expect(facts).toEqual({
      cwd: "/synthetic/child",
      harness_version: "0.160.0",
      model: "child-model",
      started_at: Date.parse("2026-10-09T23:47:06.489Z"),
      last_at: Date.parse("2026-10-09T23:47:11.000Z"),
    });
  });

  it.each(["forked_from_id", "source"])("recognizes a fork using only %s", (key) => {
    const meta = JSON.parse(FORK[0]!);
    delete meta.payload[key === "source" ? "forked_from_id" : "source"];
    expect(readCodex([JSON.stringify(meta), ...FORK.slice(1)], 0)).toEqual({ turns: CHILD_TURNS, line: 46 });
  });

  it("reconstructs the boundary when a saved cursor is inside the parent's replay", () => {
    expect(readCodex(FORK, 12)).toEqual({ turns: CHILD_TURNS, line: 46 });
    expect(readCodex(FORK, 37)).toEqual({ turns: CHILD_TURNS, line: 46 });
    expect(readCodex(FORK, 46)).toEqual({ turns: [], line: 46 });
  });

  it("waits for the child's boundary, ignoring events that name the parent", () => {
    const prefix = FORK.slice(0, 37);
    expect(readCodex(prefix, 0)).toEqual({ turns: [], line: 37 });
    expect(codexFacts(rolloutFile(prefix))).toEqual({
      cwd: "/synthetic/child",
      harness_version: "0.160.0",
      started_at: Date.parse("2026-10-09T23:47:06.489Z"),
      last_at: Date.parse("2026-10-09T23:47:06.489Z"),
    });
    expect(readCodex(FORK, 37)).toEqual({ turns: CHILD_TURNS, line: 46 });
  });

  it("keeps a later real child ask and holds the cursor until its reply arrives", () => {
    const ask = JSON.parse(user("Check synthetic edge cases."));
    ask.timestamp = "2026-10-09T23:48:00.000Z";
    const reply = JSON.parse(assistant("The synthetic edge cases pass."));
    reply.timestamp = "2026-10-09T23:48:05.000Z";
    const pending = [...FORK, JSON.stringify(ask)];
    expect(readCodex(pending, 46)).toEqual({
      turns: [],
      line: 46,
      open: { user: "Check synthetic edge cases.", at: Date.parse("2026-10-09T23:48:00.000Z") },
    });
    const complete = [...pending, JSON.stringify(reply)];
    expect(readCodex(complete, 46)).toEqual({
      turns: [
        {
          user: ask.payload.content[0].text,
          assistant: reply.payload.content[0].text,
          at: Date.parse(ask.timestamp),
          endLine: 47,
        },
      ],
      line: 48,
    });
    expect(codexFacts(rolloutFile(complete))).toMatchObject({
      title: "Check synthetic edge cases.",
      title_source: "first-ask",
    });
  });

  it("does not use a parent title or model when replay exceeds the facts head and tail windows", () => {
    const padding = JSON.stringify({
      type: "event_msg",
      payload: { type: "token_count", padding: "x".repeat(200_000) },
    });
    const prefix = [...FORK.slice(0, 7), padding, ...FORK.slice(7, 37)];
    const facts = codexFacts(rolloutFile(prefix));
    expect(facts.title).toBeUndefined();
    expect(facts.model).toBeUndefined();
    const complete = [...prefix, ...FORK.slice(37)];
    expect(codexFacts(rolloutFile(complete))).toMatchObject({ model: "child-model" });
    expect(codexFacts(rolloutFile(complete)).title).toBeUndefined();
    expect(readCodex(complete, 0)).toEqual({ turns: [{ ...CHILD_TURNS[0], endLine: 45 }], line: 47 });
  });

  it("keeps current child facts when the boundary falls between the sampled windows", () => {
    const padding = JSON.stringify({
      type: "event_msg",
      payload: { type: "token_count", padding: "x".repeat(200_000) },
    });
    const lines = [...FORK.slice(0, 37), padding, ...FORK.slice(37, 39), padding, ...FORK.slice(39)];
    expect(codexFacts(rolloutFile(lines))).toEqual({
      cwd: "/synthetic/child",
      harness_version: "0.160.0",
      model: "child-model",
      started_at: Date.parse("2026-10-09T23:47:06.489Z"),
      last_at: Date.parse("2026-10-09T23:47:11.000Z"),
    });
  });
});
