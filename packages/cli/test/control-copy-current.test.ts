import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { clip, copyIsStale, copyNotesText } from "../src/control/copy-notes.js";

const fixture = JSON.parse(
  readFileSync(path.join(__dirname, "..", "..", "..", "conformance", "control-copy-current.json"), "utf8"),
) as { cases: { name: string; last_ran: string; session_written_s: number; expect: "stale" | "current" }[] };

describe("a copy is the session as it was (conformance/control-copy-current.json)", () => {
  for (const c of fixture.cases)
    it(c.name, () => {
      const base = Date.parse(c.last_ran || "2026-11-24T00:00:00.000Z");
      expect(copyIsStale(c.last_ran || undefined, base + c.session_written_s * 1000) ? "stale" : "current").toBe(
        c.expect,
      );
    });
});

describe("what the session is told about its copies", () => {
  it("each message and answer, oldest first, said as context and never as a request", () => {
    const text = copyNotesText([
      { at: "2026-11-24T19:40:30.000Z", ask: "drop", reply: "Removed the line." },
      { at: "2026-11-24T19:44:42.000Z", ask: "you dropped the whole thing?", reply: "" },
    ]);
    expect(text).toContain("ran 2 messages for it in a copy of this session");
    expect(text).toContain("nothing here asks for an answer");
    expect(text.indexOf("Asked: drop")).toBeLessThan(text.indexOf("Asked: you dropped"));
    expect(text).toContain("(2026-11-24 19:40 UTC)");
    expect(text).toContain("The copy answered: (no answer recorded)");
  });
});

describe("a note's edges", () => {
  it("one message says so; a note with no time, words or answer still reads", () => {
    const text = copyNotesText([{ at: "", ask: "", reply: "" }]);
    expect(text).toContain("ran a message for it in a copy");
    expect(text).toContain("1.\nAsked: (nothing readable)");
  });
  it("clip keeps short words whole and marks where long ones were cut", () => {
    expect(clip("  short  ", 10)).toBe("short");
    expect(clip("abcdefghijkl", 6)).toBe("abcde…");
  });
});
