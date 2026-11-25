// SPDX-License-Identifier: Apache-2.0
// Text a person reads before saying `yes` (CONTROL.md §14.1): every character that does not show as
// itself is found, said with where it is, and written out wherever text is shown.
import { describe, expect, it, vi } from "vitest";
import {
  columnsOf,
  graphemes,
  hiddenIn,
  hiddenProblem,
  MARKS_MAX,
  visible,
  wrapColumns,
} from "../src/triggers/text.js";

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
    for (const c of classes) {
      expect(hiddenIn(`ab${c}c`)?.codePoint, JSON.stringify(c)).toBe(2);
      // Its own character, or hidden inside the one before it when it extends that one.
      expect([2, 3], JSON.stringify(c)).toContain(hiddenIn(`ab${c}c`)?.at);
    }
    expect(hiddenIn("a\u202eb")).toEqual({ code: "U+202E", escape: "\\u{202e}", at: 2, codePoint: 1 });
    // A tag character hides inside the character it follows: the person looks at the sheep.
    expect(hiddenIn("🐑\u{e0041}")).toEqual({ code: "U+E0041", escape: "\\u{e0041}", at: 1, codePoint: 1 });
    expect(hiddenIn("tab\tand\nline")).toEqual({ code: "U+0009", escape: "\\t", at: 4, codePoint: 3 });
    // A person counts characters as they show: a flag, a family, a letter and its accent are one each.
    expect(hiddenIn("🇫🇷👍🏽e\u0301\u00a0")).toEqual({ code: "U+00A0", escape: "\\u{a0}", at: 4, codePoint: 6 });
    expect(hiddenIn("x\ny")?.escape).toBe("\\n");
    expect(hiddenIn("x\ry")?.escape).toBe("\\r");
    expect(hiddenIn("tab\tand\nline", "\t\n")).toBeNull();
    expect(hiddenIn("café 🐑 ✓ ﬁ, plain spaces")).toBeNull();
  });
  it("lets four combining marks stand on one character, and finds the fifth", () => {
    expect(hiddenIn(`e${"\u0301".repeat(MARKS_MAX)} e\u0301`)).toBeNull();
    expect(hiddenIn(`e${"\u0336".repeat(300)}`)).toEqual({ code: "U+0336", escape: "\\u{336}", at: 1, codePoint: 5 });
  });
  it("hiddenProblem's hint is the honest case of each kind of character", () => {
    const hint = (text: string) =>
      hiddenProblem("the words hold", hiddenIn(text) as NonNullable<ReturnType<typeof hiddenIn>>);
    expect(hint("Thanks \u2764\ufe0f")).toContain("leave the emoji out, or write it in words");
    expect(hint("a\u200dfamily")).toContain("leave the emoji out");
    expect(hint(`e${"\u0301".repeat(5)}`)).toContain("take out the marks stacked on that character");
    expect(hint("zero\u200bwidth")).toContain("retype the text around it");
    expect(hint("thin\u2009space")).toContain("retype that space");
    expect(hint("Thanks \u2764\ufe0f")).not.toContain("a space pasted");
  });
  it("hiddenProblem says which, where and what to do", () => {
    expect(hiddenProblem("the words hold", { code: "U+00A0", escape: "\\u{a0}", at: 12, codePoint: 11 })).toBe(
      "the words hold U+00A0 at character 12 (shown as \\u{a0}), which does not show as itself, so what you confirm would not be what runs: retype that space (a space pasted from a web page or a document is often one)",
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

describe("graphemes, columnsOf and wrapColumns", () => {
  it("count characters as a person does, with a fallback where the runtime has no segmenter", () => {
    expect(graphemes("e\u0301🐑🇫🇷a")).toEqual(["e\u0301", "🐑", "🇫🇷", "a"]);
    vi.stubGlobal("Intl", { ...Intl, Segmenter: undefined });
    try {
      expect(graphemes("\u0301e\u0301\u0302🐑a")).toEqual(["\u0301", "e\u0301\u0302", "🐑", "a"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("count a wide character and a pictograph two columns, a mark none", () => {
    expect(columnsOf("a")).toBe(1);
    expect(columnsOf("字")).toBe(2);
    expect(columnsOf("🐑")).toBe(2);
    expect(columnsOf("e\u0301")).toBe(1);
    expect(columnsOf("Ｗ")).toBe(2);
  });
  it("cut to the room, at a space in the piece's second half, else at the edge, never inside a character", () => {
    expect(wrapColumns("aaaa bbbb cccc", 10)).toEqual(["aaaa bbbb ", "cccc"]);
    expect(wrapColumns("a bbbbbbbbbbbb", 10)).toEqual(["a bbbbbbbb", "bbbb"]);
    expect(wrapColumns("short", 10)).toEqual(["short"]);
    expect(wrapColumns("", 10)).toEqual([""]);
    expect(wrapColumns("字字字字字字", 5)).toEqual(["字字", "字字", "字字"]);
    expect(wrapColumns("🐑", 1)).toEqual(["🐑"]);
    // After a cut at a space, what is left plus a wide character still fits.
    expect(wrapColumns("aaaaaa bbb字", 10)).toEqual(["aaaaaa ", "bbb字"]);
    expect(wrapColumns("aaaaa bbbb字字", 10)).toEqual(["aaaaa ", "bbbb字字"]);
    for (const room of [1, 2, 3, 7, 10])
      for (const p of wrapColumns("x字 y🐑 zé ".repeat(9), room))
        expect(graphemes(p).reduce((n, g) => n + columnsOf(g), 0) <= Math.max(room, 2), p).toBe(true);
  });
});
