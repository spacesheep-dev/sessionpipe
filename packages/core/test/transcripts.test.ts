// SPDX-License-Identifier: Apache-2.0
// The transcript readers and the line the cursor may advance to.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { openTurn } from "../../cli/src/run.js";
import { readClaude } from "../src/readers/transcripts.js";

const T0 = "2026-10-01T00:00:00.000Z";
const line = (type: string, text: string) =>
  JSON.stringify({ type, message: { content: [{ type: "text", text }] }, timestamp: T0 });

// The reported middle-of-turn compaction, including a summary timestamp before
// its preceding boundary and tool messages that are not part of either text side.
const COMPACTION = readFileSync(new URL("./fixtures/claude-mid-turn-compaction.jsonl", import.meta.url), "utf8")
  .trimEnd()
  .split("\n");
const COMPACTED_TURN = {
  user: "Run experiment 3 and report back.",
  assistant: "Starting experiment 3.\n\nThe plan is ready; writing the scheduler.\n\nWriting the evaluation app now.",
  at: Date.parse("2026-10-20T16:13:30.000Z"),
  endLine: 7,
};
const SUMMARIES = [
  { flag: "isCompactSummary", lines: COMPACTION },
  {
    flag: "repeatsCompactSummary",
    lines: COMPACTION.map((l) => l.replace('"isCompactSummary":true', '"repeatsCompactSummary":true')),
  },
];

describe("readClaude", () => {
  it.each(SUMMARIES)("keeps replies before and after $flag in the person's original turn", ({ lines }) => {
    expect(readClaude(lines, 0)).toEqual({ turns: [COMPACTED_TURN], line: 8 });
  });

  it.each(SUMMARIES)("keeps turn.progress on turn 107 and the person's ask across $flag", ({ lines }) => {
    for (const end of [5, 6, 7, 8]) {
      const read = readClaude(lines.slice(0, end), 0);
      expect(openTurn(read, { base: 107, at: Date.parse("2026-10-20T16:20:30.000Z") })).toEqual({
        turn: 107,
        user: COMPACTED_TURN.user,
        assistant:
          end === 8 ? COMPACTED_TURN.assistant : "Starting experiment 3.\n\nThe plan is ready; writing the scheduler.",
        at: COMPACTED_TURN.at,
      });
    }
  });

  it("a partial last line (a write in progress) is not read and not skipped over", () => {
    const partial = line("user", "second ask").slice(0, 20);
    const r = readClaude([line("user", "hello"), line("assistant", "hi"), partial], 0);
    expect(r.turns).toHaveLength(1);
    expect(r.line).toBe(2);
    const done = readClaude(
      [line("user", "hello"), line("assistant", "hi"), line("user", "second ask"), line("assistant", "ok"), ""],
      r.line,
    );
    expect(done.turns).toEqual([{ user: "second ask", assistant: "ok", at: Date.parse(T0), endLine: 3 }]);
  });
});
