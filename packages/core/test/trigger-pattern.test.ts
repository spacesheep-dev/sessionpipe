// SPDX-License-Identifier: Apache-2.0
// The subject pattern language (CONTROL.md §14): a subset of regular expressions with the meaning
// a JavaScript RegExp gives it, matched without backtracking, so a subject an attacker picks can
// never make a match slow. Everything outside the subset is refused, never read another way.
import { describe, expect, it } from "vitest";
import { SUBJECT_PATTERN_MAX, subjectPattern } from "../src/triggers/pattern.js";

const compiled = (src: string) => {
  const p = subjectPattern(src);
  if ("error" in p) throw new Error(`${src}: ${p.error}`);
  return p;
};
const ALPHABET = "ABXYZabxyz0189_-";
/** A small seeded generator, so a failure names the same subject every run. */
function* subjects(seed: number, count: number): Generator<string> {
  let x = seed;
  const next = () => {
    x = (x * 1103515245 + 12345) % 2 ** 31;
    return x;
  };
  for (let i = 0; i < count; i++) {
    const len = 1 + (next() % 12);
    let s = "";
    for (let j = 0; j < len; j++) s += ALPHABET[next() % ALPHABET.length];
    yield s;
  }
}

describe("subjectPattern", () => {
  it("reads the RFC's example as a RegExp does: X-, one to six digits, the whole subject", () => {
    const p = compiled("^X-[0-9]{1,6}$");
    for (const s of ["X-1", "X-001", "X-123456"]) expect(p.test(s), s).toBe(true);
    for (const s of ["X-", "X-1234567", "x-1", "XX-1", "X-1a", "aX-1"]) expect(p.test(s), s).toBe(false);
    expect(p.source).toBe("^X-[0-9]{1,6}$");
  });
  it("means what a JavaScript RegExp means, on every subject tried", () => {
    const patterns = [
      "^X-[0-9]{1,6}$",
      "^.*$",
      "^a+$",
      "^a*b?$",
      "^[A-Z]{2,}-\\d+$",
      "^[^0-9]+$",
      "^[-a]x$",
      "^[a-]x$",
      "^[a-zA-Z0-9_]*-?$",
      "^\\w{3}$",
      "^.{0,3}$",
      "^a{0}b$",
      "^z{2}$",
      "^[xyz]+[0-9]*$",
      "^$",
      "^_+-+$",
      "^a*a*a*b$",
    ];
    for (const src of patterns) {
      const p = compiled(src);
      const re = new RegExp(src);
      for (const s of [...subjects(src.length, 400), "X-12", "aaab", "zz", "AB-9", "___--"])
        expect(p.test(s), `${src} on ${s}`).toBe(re.test(s));
    }
  });
  it("refuses everything outside the subset, with a reason", () => {
    const refused: [string, RegExp][] = [
      ["X-1", /starts with \^ and ends with \$/],
      ["^X-1", /starts with \^/],
      ["X-1$", /starts with \^/],
      ["^", /starts with \^/],
      ["^(a+)+$", /not part of the pattern language/],
      ["^a|b$", /not part of the pattern language/],
      ["^a$b$", /not part of the pattern language/],
      ["^a^b$", /not part of the pattern language/],
      ["^a b$", /not part of the pattern language/],
      ["^(?=a)a$", /not part of the pattern language/],
      ["^\\1$", /only escapes are \\d and \\w/],
      ["^\\s$", /only escapes/],
      ["^a\\$", /only escapes/],
      ["^[a$", /never closes/],
      ["^[]$", /an empty class/],
      ["^[^]$", /an empty class/],
      ["^[a.]$", /in a class/],
      ["^[\\d]$", /in a class/],
      ["^[z-a]$", /the range z-a/],
      ["^[A-z]$", /the range A-z/],
      ["^[0-Z]$", /the range 0-Z/],
      ["^a{41}$", /at most 40/],
      ["^a{3,2}$", /runs up/],
      ["^a{1,41}$", /at most 40/],
      ["^a{,3}$", /a count is/],
      ["^a{x}$", /a count is/],
      ["^a{123}$", /a count is/],
      ["^a*?$", /one quantifier to a piece/],
      ["^a+*$", /one quantifier/],
      ["^a{2}{3}$", /one quantifier/],
      ["^a?+$", /one quantifier/],
      ["^*a$", /not part of the pattern language/],
      [`^${"a".repeat(SUBJECT_PATTERN_MAX - 1)}$`, /at most 100 characters/],
    ];
    for (const [src, why] of refused) {
      const p = subjectPattern(src);
      expect("error" in p ? p.error : "compiled", src).toMatch(why);
    }
    expect("error" in subjectPattern(`^${"a".repeat(SUBJECT_PATTERN_MAX - 2)}$`)).toBe(false);
  });
  it("never backtracks: a pattern that would take a RegExp exponentially long is quick, and a group is refused", () => {
    const evil = compiled(`^${"a*".repeat(40)}b$`);
    const t = performance.now();
    for (let i = 0; i < 20; i++) expect(evil.test("a".repeat(40))).toBe(false);
    expect(performance.now() - t).toBeLessThan(2000);
    expect(evil.test(`${"a".repeat(39)}b`)).toBe(true);
    expect(subjectPattern("^(a|aa)+$")).toHaveProperty("error");
  });
  it("matches nothing outside the subject's alphabet, whatever the pattern", () => {
    expect(compiled("^.+$").test("a b")).toBe(false);
    expect(compiled("^[^a]$").test("!")).toBe(false);
    expect(compiled("^a?$").test("")).toBe(true);
  });
});
