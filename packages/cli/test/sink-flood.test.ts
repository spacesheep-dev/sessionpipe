// SPDX-License-Identifier: Apache-2.0
// A flood: 200 events from several sessions against a receiver that refuses the
// first batches with 429, then takes them. Nothing lost, nothing sent twice as new,
// every cursor at the end of its file (PROTOCOL.md ground rule 1). The receiver's
// `retry-after: 0` is the knob that keeps the wait at nothing: the code's own
// backoff file honours it, so no test-only knob is needed.
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Cursors, type Event, Outbox, ulid } from "@sessionpipe/core";
import { afterEach, describe, expect, it } from "vitest";
import { flush, readBackoff } from "../src/run.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "sp-flood-"));
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const ev = (session: string, seq: number): Event => ({
  protocol: 1,
  id: ulid(),
  type: "tool.ended",
  time: new Date().toISOString(),
  tier: 1,
  harness: { name: "codex" },
  session: { id: session, seq },
  privacy: { rulesets: ["secrets@1"], pii: false },
  data: { tool: "Bash", ok: true },
});

describe("flood: 200 events, a receiver that says 429 first", () => {
  it("loses none, takes none twice, and leaves every cursor at the end of its file", async () => {
    const REFUSALS = 5;
    const batches: Event[][] = [];
    const taken: Event[] = [];
    const server: Server = createServer((req, res) => {
      let raw = "";
      req.on("data", (d: Buffer) => {
        raw += d.toString("utf8");
      });
      req.on("end", () => {
        const { events } = JSON.parse(raw) as { events: Event[] };
        batches.push(events);
        if (batches.length <= REFUSALS)
          return res.writeHead(429, { "content-type": "application/json", "retry-after": "0" }).end("{}");
        taken.push(...events);
        res
          .writeHead(202, { "content-type": "application/json" })
          .end(JSON.stringify({ accepted: events.length, duplicates: 0, rejected: [] }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const outbox = new Outbox(tmp);
      const sizes = { a: 23, b: 41, c: 50, d: 7, e: 60, f: 14, g: 5 };
      const all: Event[] = [];
      for (const [s, n] of Object.entries(sizes)) {
        const events = Array.from({ length: n }, (_, i) => ev(s, i));
        outbox.append({ harness: "codex", session: s }, events);
        all.push(...events);
      }
      expect(all).toHaveLength(200);
      const cfg = [{ name: "s", url, tier: 3 as const, token: "t" }];
      const t0 = performance.now();
      let delivered = 0;
      let runs = 0;
      // Each worker run stops at a refusal; the next one starts from the same cursors.
      while (delivered < 200 && runs++ < 20) delivered += (await flush(tmp, cfg, outbox)).s ?? 0;
      expect(performance.now() - t0).toBeLessThan(2000);
      expect(delivered).toBe(200);
      expect(runs).toBe(REFUSALS + 1);
      // The refused batch went again, intact, until it was taken.
      for (let i = 1; i <= REFUSALS; i++) expect(batches[i]!.map((e) => e.id)).toEqual(batches[0]!.map((e) => e.id));
      expect(batches.map((b) => b.length)).toEqual([50, 50, 50, 50, 50, 50, 50, 50, 50]);
      // Nothing lost, nothing taken twice.
      expect(taken).toHaveLength(200);
      expect(new Set(taken.map((e) => e.id)).size).toBe(200);
      expect(taken.map((e) => e.id).sort()).toEqual(all.map((e) => e.id).sort());
      // Within a session, seq order held (HTTP.md §6).
      for (const s of Object.keys(sizes)) {
        const seqs = taken.filter((e) => e.session.id === s).map((e) => e.session.seq);
        expect(seqs).toEqual(seqs.map((_, i) => i));
      }
      const cursors = new Cursors(tmp, "s").read();
      for (const s of Object.keys(sizes))
        expect(cursors[`codex/${s}`]).toBe(statSync(outbox.file({ harness: "codex", session: s })).size);
      expect(readBackoff(tmp, "s")).toBeNull();
      // Another run has nothing to send.
      expect((await flush(tmp, cfg, outbox)).s).toBe(0);
      expect(batches).toHaveLength(9);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
