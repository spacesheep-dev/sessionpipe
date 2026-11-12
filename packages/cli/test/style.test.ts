// SPDX-License-Identifier: Apache-2.0
// style.ts: when colour is on, the marks, the width, and how a line folds.
import { describe, expect, it } from "vitest";
import {
  cols,
  commands,
  failure,
  fixes,
  fold,
  heading,
  makeUi,
  mark,
  PLAIN,
  pad,
  paint,
  plain,
  span,
  table,
  tint,
  type Ui,
} from "../src/style.js";

const ESC = String.fromCharCode(27);
const tty = (columns = 80, env: NodeJS.ProcessEnv = {}): Ui =>
  makeUi({ isTTY: true, columns, env, platform: "darwin" });
/** A terminal with no colour: only the folding shows. */
const mono = (columns = 80): Ui => makeUi({ isTTY: true, columns, env: { NO_COLOR: "1" }, platform: "darwin" });

describe("makeUi: when colour is on", () => {
  it("a terminal gets colour; a pipe gets none and whole lines", () => {
    expect(tty()).toEqual({ color: true, unicode: true, width: 79, tty: true });
    expect(makeUi({ isTTY: false, env: {} })).toEqual(PLAIN);
    expect(makeUi({ env: {} }).tty).toBe(false);
    // With nothing said, the process's own environment decides.
    expect(makeUi().tty).toBe(false);
  });

  it("NO_COLOR and TERM=dumb turn it off, an empty NO_COLOR doesn't", () => {
    expect(tty(80, { NO_COLOR: "1" }).color).toBe(false);
    expect(tty(80, { NO_COLOR: "" }).color).toBe(true);
    expect(tty(80, { TERM: "dumb" }).color).toBe(false);
    expect(tty(80, { TERM: "xterm-256color" }).color).toBe(true);
  });

  it("FORCE_COLOR decides before NO_COLOR, on a pipe too; 0 and false mean off", () => {
    expect(makeUi({ isTTY: false, env: { FORCE_COLOR: "1" } }).color).toBe(true);
    expect(makeUi({ isTTY: false, env: { FORCE_COLOR: "1" } }).width).toBe(Number.POSITIVE_INFINITY);
    expect(tty(80, { FORCE_COLOR: "1", NO_COLOR: "1" }).color).toBe(true);
    expect(tty(80, { FORCE_COLOR: "0" }).color).toBe(false);
    expect(tty(80, { FORCE_COLOR: "false" }).color).toBe(false);
  });

  it("--no-color wins over everything", () => {
    expect(makeUi({ isTTY: true, env: { FORCE_COLOR: "1" }, noColor: true }).color).toBe(false);
  });

  it("the width is the terminal's less one, between 40 and 100, 80 when it won't say", () => {
    expect(tty(120).width).toBe(100);
    expect(tty(100).width).toBe(99);
    expect(tty(20).width).toBe(40);
    expect(makeUi({ isTTY: true, env: {} }).width).toBe(79);
    expect(makeUi({ isTTY: true, columns: 0, env: {} }).width).toBe(79);
  });

  it("the old Windows console gets marks its fonts have", () => {
    const old = makeUi({ isTTY: true, env: {}, platform: "win32" });
    expect(old.unicode).toBe(false);
    expect(plain(mark(old, "ok"))).toBe("√");
    expect(plain(mark(old, "bad"))).toBe("×");
    for (const env of [{ WT_SESSION: "1" }, { TERM: "xterm" }, { TERM_PROGRAM: "vscode" }])
      expect(makeUi({ isTTY: true, env, platform: "win32" }).unicode).toBe(true);
    // A pipe on Windows is a file: it keeps the marks.
    expect(makeUi({ isTTY: false, env: {}, platform: "win32" }).unicode).toBe(true);
  });
});

describe("tint, mark, commands", () => {
  it("colours only when colour is on, and ends only what it began", () => {
    expect(tint(PLAIN, "red", "x")).toBe("x");
    expect(tint(tty(), "red", "x")).toBe(`${ESC}[31mx${ESC}[39m`);
    expect(tint(tty(), "bold", "x")).toBe(`${ESC}[1mx${ESC}[22m`);
    expect(tint(tty(), "dim", "")).toBe("");
    expect(heading(tty(), "Agents")).toBe(`${ESC}[1mAgents${ESC}[22m`);
  });

  it("every state has a sign, coloured on a terminal", () => {
    expect(["ok", "warn", "bad", "info", "same"].map((m) => mark(PLAIN, m as "ok"))).toEqual(["✓", "!", "✗", "·", "="]);
    expect(mark(tty(), "ok")).toBe(`${ESC}[32m✓${ESC}[39m`);
    expect(mark(tty(), "warn")).toBe(`${ESC}[33m!${ESC}[39m`);
  });

  it("a `command` keeps its backticks and gains a colour", () => {
    expect(commands(PLAIN, "run `sessionpipe update` now")).toBe("run `sessionpipe update` now");
    expect(commands(tty(), "run `sessionpipe update` now")).toBe(`run ${ESC}[36m\`sessionpipe update\`${ESC}[39m now`);
  });

  it("cols and pad count what is seen, not the colour codes", () => {
    expect(cols(tint(tty(), "red", "abc"))).toBe(3);
    expect(cols("✓ ok")).toBe(4);
    expect(pad(tint(tty(), "red", "ab"), 4)).toBe(`${ESC}[31mab${ESC}[39m  `);
    expect(pad("abcdef", 2)).toBe("abcdef");
  });
});

describe("fold", () => {
  it("a pipe gets the line whole", () => {
    expect(fold(PLAIN, "  ! ", "a ".repeat(100).trim())).toHaveLength(1);
  });

  it("a terminal folds at spaces, under the body's first letter", () => {
    const lines = fold(mono(40), "  ! ", "one two three four five six seven eight nine ten eleven twelve");
    expect(lines).toEqual(["  ! one two three four five six seven", "    eight nine ten eleven twelve"]);
    for (const l of lines) expect(cols(l)).toBeLessThanOrEqual(40);
  });

  it("never folds inside a `command`, whatever touches it", () => {
    const lines = fold(mono(40), "  ", "to bring them up to date run (`sessionpipe install --allow-downgrade`).");
    expect(lines).toEqual(["  to bring them up to date run", "  (`sessionpipe install --allow-downgrade`)."]);
    // A backtick with no partner is only a character.
    expect(fold(mono(40), "", "a ` b")).toEqual(["a ` b"]);
  });

  it("a word longer than the line stands alone; an empty body is one line", () => {
    expect(fold(mono(40), "  ", `see ${"x".repeat(60)} now`)).toEqual(["  see", `  ${"x".repeat(60)}`, "  now"]);
    expect(fold(mono(40), "  ", "")).toEqual(["  "]);
  });

  it("leaves room for a few words however deep the indent", () => {
    expect(fold(mono(40), " ".repeat(36), "aaaa bbbb cccc dddd eeee")).toEqual([
      `${" ".repeat(36)}aaaa bbbb cccc dddd`,
      `${" ".repeat(36)}eeee`,
    ]);
  });
});

describe("paint: the lines commands have always written", () => {
  it("a pipe gets them back byte for byte", () => {
    const line = "  ✓ claude-code: ~/.claude/settings.json written — run `sessionpipe doctor`";
    expect(paint(PLAIN, line)).toBe(line);
  });

  it("colours the mark and the command, and nothing else", () => {
    expect(paint(tty(), "  ✓ done, see `sessionpipe status`")).toBe(
      `  ${ESC}[32m✓${ESC}[39m done, see ${ESC}[36m\`sessionpipe status\`${ESC}[39m`,
    );
    expect(paint(tty(), "  ✗ no")).toBe(`  ${ESC}[31m✗${ESC}[39m no`);
    expect(paint(tty(), "plain words")).toBe("plain words");
    expect(paint(tty(), "")).toBe("");
  });

  it("folds under the text after a mark, a label or a number", () => {
    const u = mono(40);
    expect(paint(u, "  ! one two three four five six seven eight nine ten")).toBe(
      "  ! one two three four five six seven\n    eight nine ten",
    );
    // A label as long as the longest the commands write: what follows hangs under its text.
    expect(paint(u, "  Background service: one two three four five six seven eight nine")).toBe(
      `  Background service: one two three four\n${" ".repeat(22)}five six seven eight\n${" ".repeat(22)}nine`,
    );
    expect(paint(u, "  Mode: one two three four five six seven eight nine")).toBe(
      "  Mode: one two three four five six\n        seven eight nine",
    );
    expect(paint(u, "  1. one two three four five six seven eight nine ten")).toBe(
      "  1. one two three four five six seven\n     eight nine ten",
    );
    expect(paint(u, "  one two three four five six seven eight nine ten")).toBe(
      "  one two three four five six seven\n  eight nine ten",
    );
  });

  it("takes each line of several on its own", () => {
    expect(paint(tty(), "  ✓ a\n  ! b")).toBe(`  ${ESC}[32m✓${ESC}[39m a\n  ${ESC}[33m!${ESC}[39m b`);
  });

  it("the old Windows console gets the marks it can show", () => {
    const old = makeUi({ isTTY: true, env: { NO_COLOR: "1" }, platform: "win32" });
    expect(paint(old, "  ✓ written")).toBe("  √ written");
    expect(paint(old, "  ✗ refused")).toBe("  × refused");
  });
});

describe("table", () => {
  it("sets columns as wide as their widest cell and folds the last", () => {
    expect(
      table(mono(40), [
        ["a", "one"],
        ["bbbb", "one two three four five six seven eight nine"],
      ]),
    ).toEqual(["  a     one", "  bbbb  one two three four five six", "        seven eight nine"]);
  });

  it("a row with fewer cells keeps its indent; no rows, no lines", () => {
    expect(table(PLAIN, [["a", "b"], ["only"], []])).toEqual(["  a  b", "  only", "  "]);
    expect(table(PLAIN, [])).toEqual([]);
  });

  it("measures cells without their colour", () => {
    const u = tty();
    expect(table(u, [[tint(u, "cyan", "ab"), "x"]]).map(plain)).toEqual(["  ab  x"]);
  });
});

describe("fixes and failure", () => {
  it("numbers what to do, the command alone on its own line", () => {
    expect(
      fixes(PLAIN, [{ say: "Update this computer:", run: "sessionpipe update" }, { say: "Nothing to type." }]),
    ).toEqual(["  1. Update this computer:", "       sessionpipe update", "  2. Nothing to type."]);
    const ten = fixes(
      PLAIN,
      Array.from({ length: 10 }, () => ({ say: "x" })),
    );
    expect(ten[0]).toBe("   1. x");
    expect(ten[9]).toBe("  10. x");
    expect(fixes(tty(), [{ say: "do `it`", run: "it" }])[1]).toBe(`       ${ESC}[36mit${ESC}[39m`);
  });

  it("a failure is one error line and one line to try: the command the message names", () => {
    expect(failure(PLAIN, "the pairing link expired; run `sessionpipe control pair` again", "sessionpipe --help")).toBe(
      "error  the pairing link expired; run `sessionpipe control pair` again\ntry    sessionpipe control pair\n",
    );
    expect(failure(PLAIN, "fetch failed", "sessionpipe sink --help")).toBe(
      "error  fetch failed\ntry    sessionpipe sink --help\n",
    );
  });

  it("a command with a placeholder can't be typed, so the help is offered", () => {
    expect(failure(PLAIN, "run `sessionpipe control pair <receiver>` first", "sessionpipe control --help")).toContain(
      "try    sessionpipe control --help",
    );
    expect(failure(PLAIN, "add it (`sessionpipe sink add … --tier 1`)", "sessionpipe --help")).toContain(
      "try    sessionpipe --help",
    );
  });

  it("on a terminal the word is red and bold and a long message folds under itself", () => {
    const said = failure(tty(40), "one two three four five six seven eight nine ten", "sessionpipe --help");
    expect(said.startsWith(`${ESC}[31m${ESC}[1merror${ESC}[22m${ESC}[39m  one two`)).toBe(true);
    expect(plain(said).split("\n")[1]?.startsWith("       ")).toBe(true);
    expect(said).toContain(`${ESC}[36msessionpipe --help${ESC}[39m`);
  });
});

describe("span", () => {
  it("says a length of time in the unit a person reads", () => {
    expect(span(-5)).toBe("0 s");
    expect(span(12_000)).toBe("12 s");
    expect(span(3 * 60_000)).toBe("3 min");
    expect(span(2 * 3600_000)).toBe("2 h");
    expect(span(5 * 86_400_000)).toBe("5 days");
  });
});
