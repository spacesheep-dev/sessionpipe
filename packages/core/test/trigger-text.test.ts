// SPDX-License-Identifier: Apache-2.0
// Text a person reads before saying `yes` (CONTROL.md §14.1): every character that does not show
// is found, and written out wherever text is shown.
import { describe, expect, it } from "vitest";
import { hiddenIn, visible } from "../src/triggers/text.js";

describe("hiddenIn and visible", () => {
  it("find every class that does not show, and let through only what the caller allows", () => {
    for (const c of [
      "\u0000",
      "\r",
      "\u007f",
      "\u0085",
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
    ])
      expect(hiddenIn(`a${c}b`), JSON.stringify(c)).toMatch(/^U\+[0-9A-F]{4,6}$/);
    expect(hiddenIn("a\u202eb")).toBe("U+202E");
    expect(hiddenIn("a\u{e0041}")).toBe("U+E0041");
    expect(hiddenIn("tab\tand\nline")).toBe("U+0009");
    expect(hiddenIn("tab\tand\nline", "\t\n")).toBeNull();
    expect(hiddenIn("café 🐑 ✓ ﬁ")).toBeNull();
  });
  it("visible writes each one out, and leaves the rest as it is", () => {
    expect(visible("a\nb\tc\rd")).toBe("a\\nb\\tc\\rd");
    expect(visible("x\u202ey\u001b[2K\u{e0041}")).toBe("x\\u{202e}y\\u{1b}[2K\\u{e0041}");
    expect(visible("café 🐑 C:\\work")).toBe("café 🐑 C:\\work");
  });
});
