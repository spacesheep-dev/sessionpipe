// SPDX-License-Identifier: Apache-2.0
// The transcript readers and the line the cursor may advance to.
import { describe, expect, it } from "vitest";
import { readClaude } from "../src/readers/transcripts.js";

const T0 = "2026-10-01T00:00:00.000Z";
const line = (type: string, text: string) =>
  JSON.stringify({ type, message: { content: [{ type: "text", text }] }, timestamp: T0 });

describe("readClaude", () => {
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
