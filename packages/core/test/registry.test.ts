// SPDX-License-Identifier: Apache-2.0
// A harness cannot land without fixtures: every adapter in the registry has at least
// one under conformance/harness/<name>/, and each fixture names the harness it is in.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ADAPTERS } from "../src/adapters/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dir = path.join(root, "conformance/harness");

describe("every adapter has fixtures", () => {
  for (const a of ADAPTERS) {
    it(`${a.name}: conformance/harness/${a.name}/*.json`, () => {
      const d = path.join(dir, a.name);
      expect(statSync(d).isDirectory(), `${d} is a directory`).toBe(true);
      const files = readdirSync(d).filter((f) => f.endsWith(".json"));
      expect(files.length, "at least one fixture").toBeGreaterThan(0);
      for (const f of files) {
        const fx = JSON.parse(readFileSync(path.join(d, f), "utf8")) as { harness?: string; event?: string };
        expect(fx.harness, `${f} names its harness`).toBe(a.name);
        expect(typeof fx.event, `${f} names its event`).toBe("string");
      }
    });
  }
  it("names no harness without an adapter", () => {
    const dirs = readdirSync(dir).filter((n) => statSync(path.join(dir, n)).isDirectory());
    for (const n of dirs)
      expect(
        ADAPTERS.map((a) => a.name),
        `conformance/harness/${n}`,
      ).toContain(n);
  });
});
