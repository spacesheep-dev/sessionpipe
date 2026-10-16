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
