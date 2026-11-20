// SPDX-License-Identifier: Apache-2.0
// spec/OUTBOX.md §3, as vectors (conformance/outbox/read.json): what a reader returns for a
// session file's exact bytes; and §2 (conformance/outbox/append.json): what an append
// writes for an event too long to be one line. A second implementation (RFC 0002) runs the
// same files.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Outbox } from "../src/outbox.js";
import type { Event } from "../src/types.js";

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

const appends = JSON.parse(readFileSync(path.join(root, "conformance/outbox/append.json"), "utf8")) as {
  cases: {
    name: string;
    type: string;
    data: Record<string, unknown>;
    expect: Record<string, { length: number; starts: string; ends: string }>;
    whole: string[];
  }[];
};

/** A value of a case's `data`, its `{ repeat, times }` recipes made into strings. */
function made(v: unknown): unknown {
  if (!v || typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  if (typeof o.repeat === "string" && typeof o.times === "number") return o.repeat.repeat(o.times);
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, made(x)]));
}

describe("outbox append vectors (OUTBOX.md §2, a line a reader can read)", () => {
  for (const c of appends.cases) {
    it(c.name, () => {
      const outbox = new Outbox(mkdtempSync(path.join(os.tmpdir(), "sp-outbox-vec-")));
      const ref = { harness: "codex", session: "s1" };
      const data = made(c.data) as Record<string, unknown>;
      const event = {
        protocol: 1,
        id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        type: c.type,
        time: "2026-09-28T00:00:00.000Z",
        tier: 3,
        harness: { name: "codex" },
        session: { id: "s1", seq: 0 },
        privacy: { rulesets: ["secrets@1"], pii: false },
        data,
      } as unknown as Event;
      outbox.append(ref, [event]);
      const line = readFileSync(outbox.file(ref), "utf8");
      expect(line.endsWith("\n")).toBe(true);
      expect(line.length - 1).toBeLessThanOrEqual(2_796_202);
      const written = (JSON.parse(line) as Event).data as Record<string, unknown>;
      for (const [key, want] of Object.entries(c.expect)) {
        const got = written[key] as string;
        expect(typeof got, key).toBe("string");
        expect([got.length, got.charAt(0), got.charAt(got.length - 1)], key).toEqual([
          want.length,
          want.starts,
          want.ends,
        ]);
      }
      for (const key of c.whole) expect(written[key], key).toEqual(data[key]);
      const back = outbox.read(ref, 0);
      expect(back.events).toHaveLength(1);
      expect(back.offset).toBe(Buffer.byteLength(line));
    });
  }
});
