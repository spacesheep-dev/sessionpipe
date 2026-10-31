// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hashMachine, reducePii, reducePiiDeep } from "../src/privacy/pii.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const fx = JSON.parse(readFileSync(path.join(root, "conformance/redaction/pii.json"), "utf8"));

describe("pii@1 vectors", () => {
  for (const c of fx.cases as { name: string; in: string; out: string; home?: string }[]) {
    it(c.name, () => expect(reducePii(c.in, c.home)).toBe(c.out));
  }
  for (const s of fx.session as { name: string; in: { machine: string }; out: { machine: string } }[]) {
    it(s.name, () => expect(hashMachine(s.in.machine)).toBe(s.out.machine));
  }
  it("is idempotent on every vector", () => {
    for (const c of fx.cases as { in: string; out: string; home?: string }[]) {
      expect(reducePii(c.out, c.home)).toBe(c.out);
      expect(reducePii(reducePii(c.in, c.home), c.home)).toBe(c.out);
    }
  });
});

describe("pii@1 edges", () => {
  it("empty text, a bare digit run, a dotted run", () => {
    expect(reducePii("")).toBe("");
    expect(reducePii("order 12345678")).toBe("order 12345678");
    expect(reducePii("10.100.1000.100")).toBe("10.100.1000.100");
    expect(reducePii("+1 (415) 555-0100 x")).toBe("[phone] x");
  });
  it("a date is kept unless what follows could carry a phone on", () => {
    expect(reducePii("2026-10-31T12:00:00Z, 2026-10-31 9:00, 2026-10-31.")).toBe(
      "2026-10-31T12:00:00Z, 2026-10-31 9:00, 2026-10-31.",
    );
    expect(reducePii("1999-01-01/2026-12-31 (2026-10-31) v2026-10-31")).toBe(
      "1999-01-01/2026-12-31 (2026-10-31) v2026-10-31",
    );
    expect(reducePii("+2026-10-31,42")).toBe("+2026-10-31,42");
    // One digit after the date is never a phone's group: the date stays.
    expect(reducePii("2026-10-31 5 files changed, 2026-10-31-7, 2026-10-31.5")).toBe(
      "2026-10-31 5 files changed, 2026-10-31-7, 2026-10-31.5",
    );
    expect(reducePii("2026-10-31 1-415-555-0132")).toBe("2026-10-31 1-[phone]");
    // The years it knows, a filename, the end of the string.
    expect(reducePii("1900-01-01 and 2099-12-31, report-2026-10-31.pdf, due 2026-10-31")).toBe(
      "1900-01-01 and 2099-12-31, report-2026-10-31.pdf, due 2026-10-31",
    );
    // Month 13, day 32, a year outside 1900–2099, or a digit group after it: a phone's shape, as before.
    for (const s of [
      "2026-13-01",
      "2026-10-32",
      "1899-12-31",
      "2100-01-01",
      "2026-10-3112",
      "2026-10-31-1234",
      "2012-12-12 34",
    ])
      expect(reducePii(`x ${s}`)).toBe("x [phone]");
    expect(reducePii("2026-10-31 415-555-0132")).toBe("[phone]-[phone]");
    expect(reducePii("+1 2026-10-31")).toBe("[phone]");
    // Only an hour, 00–23, right before ":mm" counts as a time.
    expect(reducePii("2026-10-31 0132: call")).toBe("[phone]: call");
    expect(reducePii("2026-10-31 99:00, 2026-10-31 41:555-0132")).toBe("[phone]:00, [phone]:[phone]");
    expect(reducePii("2026-10-31 00:00, 2026-10-31 23:59")).toBe("2026-10-31 00:00, 2026-10-31 23:59");
    expect(reducePii("2026-10-31-12:00")).toBe("[phone]:00");
    expect(reducePii("2026-10-31.12:00")).toBe("[phone]:00");
    expect(reducePii("2026-10-31 12:00:00, 2026-10-31 (415) 555-0132")).toBe("2026-10-31 12:00:00, 2026-10-31 [phone]");
    // A phone's prefix the pass could not take (a letter or a phone before it) would take the date next time.
    expect(reducePii("x(415) 2026-10-31, (+45) 2026-10-31")).toBe("x(415) [phone], (+45) [phone]");
  });
  it("a date after a phone reads the same on a second pass", () => {
    const once = reducePii("415-555-0132+2026-10-31");
    expect(once).toBe("[phone]+2026-10-31");
    expect(reducePii(once)).toBe(once);
    expect(reducePii("(650) 210-0867+1 2046-01-19")).toBe("[phone]+1 [phone]");
    expect(reducePii("555-0132(902) 1993-05-10")).toBe("[phone](902) [phone]");
    expect(reducePii("856-975-2345(430)-1957-01-02")).toBe("[phone](430)-[phone]");
    for (const s of [
      "2026-10-31 12:00 555-0132",
      "2026-10-31 9:00 1234567",
      "415-555-0132(20)2026-10-31",
      "(650) 210-0867+1 2046-01-19",
      "555-0132(902) 1993-05-10",
      "0907-0049+2-2052-03-15",
      "856-975-2345(430)-1957-01-02",
    ])
      expect(reducePii(reducePii(s))).toBe(reducePii(s));
  });
  it("the home path: regex characters in it, a quote after it, never a neighbour", () => {
    expect(reducePii("see /Users/mi.sha/x and /Users/mixsha/x", "/Users/mi.sha")).toBe("see ~/x and /Users/mixsha/x");
    expect(reducePii('cwd="/home/m" or `/home/m`', "/home/m")).toBe('cwd="~" or `~`');
    expect(reducePii("/home/m2/x and /home/m", "/home/m")).toBe("/home/m2/x and ~");
    expect(reducePii("x/home/m/y", "/home/m")).toBe("x/home/m/y");
    expect(reducePii("/home/m/y", "")).toBe("/home/m/y");
  });
  it("reducePiiDeep walks arrays and objects, leaves the rest", () => {
    expect(reducePiiDeep({ a: ["x@y.io", 1, null, { b: "/home/m/x" }], c: true }, "/home/m")).toEqual({
      a: ["[email]", 1, null, { b: "~/x" }],
      c: true,
    });
    expect(reducePiiDeep(null)).toBeNull();
  });
});
