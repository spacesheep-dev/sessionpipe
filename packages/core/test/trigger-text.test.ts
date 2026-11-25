// SPDX-License-Identifier: Apache-2.0
// Text a person reads before saying `yes` (CONTROL.md §14.1): every character that does not show as
// itself is found, said with where it is, and written out wherever text is shown.
import { describe, expect, it } from "vitest";
import { hiddenIn, hiddenProblem, MARKS_MAX, visible } from "../src/triggers/text.js";

describe("hiddenIn", () => {
  it("finds every class that does not show as itself, and lets through only what the caller allows", () => {
    const classes = [
      "\u0000",
      "\r",
      "\u007f",
      "\u0085",
      "\u00ad",
      "\u200b",
      "\u202e",
      "\u2028",
      "\u2029",
      "\ufeff",
      "\u{e0001}",
      "\ue000",
      "\u{10fffd}",
      "\u{2fffe}",
      "\ud800",
      "\u034f",
      "\ufe00",
      "\ufe0f",
      "\u{e0100}",
      "\u{e01ef}",
      "\u17b4",
      "\u180b",
      "\u180d",
      "\u3164",
      "\u115f",
      "\u1160",
      "\uffa0",
      "\u2800",
      "\ufffc",
      "\u00a0",
      "\u2003",
      "\u202f",
      "\u3000",
    ];
    for (const c of classes) expect(hiddenIn(`ab${c}c`)?.at, JSON.stringify(c)).toBe(3);
    expect(hiddenIn("a\u202eb")).toEqual({ code: "U+202E", escape: "\\u{202e}", at: 2 });
    expect(hiddenIn("🐑\u{e0041}")).toEqual({ code: "U+E0041", escape: "\\u{e0041}", at: 2 });
    expect(hiddenIn("tab\tand\nline")).toEqual({ code: "U+0009", escape: "\\t", at: 4 });
    expect(hiddenIn("x\ny")?.escape).toBe("\\n");
    expect(hiddenIn("x\ry")?.escape).toBe("\\r");
    expect(hiddenIn("tab\tand\nline", "\t\n")).toBeNull();
    expect(hiddenIn("café 🐑 ✓ ﬁ, plain spaces")).toBeNull();
  });
  it("lets four combining marks stand on one character, and finds the fifth", () => {
    expect(hiddenIn(`e${"\u0301".repeat(MARKS_MAX)} e\u0301`)).toBeNull();
    expect(hiddenIn(`e${"\u0336".repeat(300)}`)).toEqual({ code: "U+0336", escape: "\\u{336}", at: 6 });
  });
  it("hiddenProblem says which, where and what to do", () => {
    expect(hiddenProblem("the words hold", { code: "U+00A0", escape: "\\u{a0}", at: 12 })).toBe(
      "the words hold U+00A0 at character 12 (shown as \\u{a0}), which does not show as itself, so what you confirm would not be what runs: retype that character (a space pasted from a web page or a document is often one)",
    );
  });
});

describe("visible", () => {
  it("writes each hidden character out, and leaves the rest as typed", () => {
    expect(visible("a\nb\tc\rd")).toBe("a\\nb\\tc\\rd");
    expect(visible("x\u202ey\u001b[2K\u{e0041}\u00a0\u2800")).toBe("x\\u{202e}y\\u{1b}[2K\\u{e0041}\\u{a0}\\u{2800}");
    expect(visible(`e\u0336\u0336\u0336\u0336\u0336\u0336`)).toBe("e\u0336\u0336\u0336\u0336\\u{336}\\u{336}");
    expect(visible("café 🐑 C:\\work ^\\d+$")).toBe("café 🐑 C:\\work ^\\d+$");
  });
  it("doubles a backslash wherever it could start an escape, so a typed one never reads as written out", () => {
    // A typed backslash-n, a real line feed, a backslash before a line feed: three different outputs.
    expect(visible("\\n")).toBe("\\\\n");
    expect(visible("\n")).toBe("\\n");
    expect(visible("\\\n")).toBe("\\\\\\n");
    expect(visible("\\\\")).toBe("\\\\\\");
    expect(visible("\\u{a0}")).toBe("\\\\u{a0}");
    expect(visible("\\t \\r")).toBe("\\\\t \\\\r");
    expect(visible("trailing\\")).toBe("trailing\\");
  });
});
