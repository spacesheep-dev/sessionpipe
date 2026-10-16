// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  firstTableAt,
  insertTopLevel,
  isComputerUse,
  parseArgv,
  previousNotify,
  readNotify,
  replaceNotify,
  stripPreviousRaw,
  withNotify,
  withoutNotify,
  withPrevious,
  withPreviousRaw,
} from "../src/adapters/codex-config.js";

const OURS = 'notify = ["/n", "/sessionpipe/dist/hook.js", "codex", "notify"]';

describe("codex config.toml", () => {
  it("finds the first table outside strings and arrays", () => {
    expect(firstTableAt("a = 1\n[t]\n")).toBe(6);
    expect(firstTableAt('a = """\n[not a table]\n"""\nb = [\n[1],\n]\n[real]\n')).toBe(
      'a = """\n[not a table]\n"""\nb = [\n[1],\n]\n'.length,
    );
    expect(firstTableAt("a = 1\n")).toBe(-1);
  });
  it("reads a top-level notify, ours or another tool's", () => {
    expect(readNotify(`${OURS}\n`)?.other).toBe(false);
    expect(readNotify('notify = ["say", "hi"]\n')?.other).toBe(true);
    expect(readNotify("")).toBeNull();
  });
  it("flags our line inside a table as misplaced and moves it", () => {
    const text = `[projects."/x"]\ntrust_level = "trusted"\n${OURS}\n`;
    expect(readNotify(text)?.misplaced).toBe(true);
    const fixed = withNotify(text, OURS);
    expect(fixed.startsWith(OURS)).toBe(true);
    expect(fixed).not.toContain(`trusted"\n${OURS}`);
    expect(readNotify(fixed)?.misplaced).toBe(false);
  });
  it("inserts before the first table and removes cleanly", () => {
    const t = insertTopLevel('model = "x"\n\n[a]\nb = 1\n', OURS);
    expect(t).toBe(`model = "x"\n${OURS}\n\n[a]\nb = 1\n`);
    expect(withoutNotify(t)).toBe('model = "x"\n\n[a]\nb = 1\n');
  });
  it("chains through --previous-notify", () => {
    const argv = withPrevious(["/client", "turn-ended"], ["/n", "hook.js"]);
    expect(previousNotify(argv)).toEqual(["/n", "hook.js"]);
    expect(withPrevious(argv, null)).toEqual(["/client", "turn-ended"]);
  });
});

describe("codex config.toml, the corners", () => {
  it("a single-quoted string hides a bracket; a notify that is no array is another tool's", () => {
    expect(firstTableAt("a = '[x]'\nb = 1\n[t]\n")).toBe("a = '[x]'\nb = 1\n".length);
    expect(firstTableAt("a = 'unterminated\n[t]\n")).toBe("a = 'unterminated\n".length);
    expect(readNotify('notify = "say done" # a comment\n')).toEqual({
      raw: '"say done" # a comment',
      argv: null,
      index: 0,
      length: 0,
      misplaced: false,
      other: true,
    });
    expect(parseArgv("[1, 2]")).toBeNull();
    expect(parseArgv("{ nope")).toBeNull();
    expect(readNotify(`[t]\n${OURS}\n`)?.misplaced).toBe(true);
    expect(readNotify('[t]\nnotify = ["say", "hi"]\n')).toBeNull();
  });
  it("replaceNotify needs a top-level line; withoutNotify leaves another tool's alone", () => {
    expect(replaceNotify("a = 1\n", OURS)).toBeNull();
    expect(replaceNotify(`[t]\n${OURS}\n`, OURS)).toBeNull();
    expect(replaceNotify(`${OURS}\n`, 'notify = ["x"]')).toBe('notify = ["x"]\n');
    expect(withoutNotify('notify = ["say", "hi"]\n')).toBe('notify = ["say", "hi"]\n');
    expect(withoutNotify(`a = 1\n[t]\n${OURS}\n`)).toBe("a = 1\n[t]\n");
    expect(withNotify(`a = 1\n${OURS}\n[t]\n`, 'notify = ["y"]')).toBe('a = 1\nnotify = ["y"]\n[t]\n');
    expect(insertTopLevel("", OURS)).toBe(`${OURS}\n`);
    expect(insertTopLevel("\n\n[t]\n", OURS)).toBe(`${OURS}\n\n[t]\n`);
  });
  it("the raw --previous-notify pair, kept in the file's own formatting", () => {
    const raw = '["/c/SkyComputerUseClient", "turn-ended" ]';
    const chained = withPreviousRaw(raw, ["/n", "hook.js"]);
    expect(chained).toBe('["/c/SkyComputerUseClient", "turn-ended", "--previous-notify", "[\\"/n\\",\\"hook.js\\"]"]');
    expect(stripPreviousRaw(chained)).toBe('["/c/SkyComputerUseClient", "turn-ended"]');
    expect(withPreviousRaw(chained, ["/m"])).toContain('"[\\"/m\\"]"');
    expect(isComputerUse(["/c/SkyComputerUseClient"])).toBe(true);
    expect(isComputerUse(["SkyComputerUseClient"])).toBe(true);
    expect(isComputerUse(["/usr/bin/say"])).toBe(false);
    expect(isComputerUse(null)).toBe(false);
    expect(previousNotify(null)).toBeNull();
    expect(previousNotify(["/c", "--previous-notify"])).toBeNull();
  });
});
