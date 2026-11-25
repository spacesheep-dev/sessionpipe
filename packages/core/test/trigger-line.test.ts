// SPDX-License-Identifier: Apache-2.0
// conformance/triggers/trigger-line.json against core's triggerLine (CONTROL.md §14.1): each rule's
// line and words exactly, and the line split as a POSIX shell splits it gives those words back.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { shellWord, triggerLine } from "../src/triggers/line.js";
import type { TriggerRule } from "../src/types.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const fx = JSON.parse(readFileSync(path.join(root, "conformance/triggers/trigger-line.json"), "utf8")) as {
  spec: string;
  cases: { name: string; rule: TriggerRule; line: string; argv: string[] }[];
};

/** Words as a POSIX shell splits a command: single quotes, double quotes and backslashes; a bare
 *  character the shell would act on fails, and so does a bare word starting with `=` (zsh). */
function shSplit(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let word = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string;
    if (c === "'") {
      const j = line.indexOf("'", i + 1);
      if (j < 0) throw new Error("an open quote");
      cur += line.slice(i + 1, j);
      i = j;
    } else if (c === "\\") cur += line[++i];
    else if (c === " " || c === "\t" || c === "\n") {
      if (word) out.push(cur);
      cur = "";
      word = false;
      continue;
    } else if ('|&;<>()$`*?[#~!"'.includes(c) || (c === "=" && !word)) throw new Error(`a bare ${c}`);
    else cur += c;
    word = true;
  }
  if (word) out.push(cur);
  return out;
}

describe("trigger-line.json", () => {
  it("is the spec's", () => {
    expect(fx.spec).toMatch(/^CONTROL\.md §14\.1/);
    expect(fx.cases.length).toBeGreaterThan(10);
  });
  for (const c of fx.cases)
    it(c.name, () => {
      expect(triggerLine(c.rule)).toEqual({ line: c.line, argv: c.argv });
      expect(shSplit(c.line)).toEqual(["sessionpipe", ...c.argv]);
      // Paused, it is the same line: a rule is made again unpaused.
      expect(triggerLine({ ...c.rule, paused: true })).toEqual({ line: c.line, argv: c.argv });
    });
  it("quotes a word only when it must", () => {
    expect(shellWord("abc")).toBe("abc");
    expect(shellWord("")).toBe("''");
    expect(shellWord("=x")).toBe("'=x'");
    expect(shellWord("-x")).toBe("'-x'");
    expect(shellWord("it's")).toBe("'it'\\''s'");
    expect(shSplit("a\\ b")).toEqual(["a b"]);
    expect(() => shSplit("'open")).toThrow("an open quote");
    expect(() => shSplit("=bare")).toThrow("a bare =");
  });
});
