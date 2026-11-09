// SPDX-License-Identifier: Apache-2.0
// spec/OUTBOX.md §3, as vectors (conformance/outbox/read.json): what a reader returns for a
// session file's exact bytes. A second implementation (RFC 0002) runs the same file.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Outbox } from "../src/outbox.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const vectors = JSON.parse(readFileSync(path.join(root, "conformance/outbox/read.json"), "utf8")) as {
  cases: {
    name: string;
    file: string;
    maxEvents: number;
    reads: { from: number; events: unknown[]; offset: number; maxEvents?: number }[];
  }[];
};

describe("outbox read vectors (OUTBOX.md §3)", () => {
  for (const c of vectors.cases) {
    it(c.name, () => {
      const state = mkdtempSync(path.join(os.tmpdir(), "sp-outbox-vec-"));
      const outbox = new Outbox(state);
      const ref = { harness: "codex", session: "s1" };
      mkdirSync(path.dirname(outbox.file(ref)), { recursive: true });
      writeFileSync(outbox.file(ref), c.file);
      for (const r of c.reads) {
        const got = outbox.read(ref, r.from, r.maxEvents ?? c.maxEvents);
        expect(got.events, `${c.name}: events from ${r.from}`).toEqual(r.events);
        expect(got.offset, `${c.name}: offset from ${r.from}`).toBe(r.offset);
      }
    });
  }
});
