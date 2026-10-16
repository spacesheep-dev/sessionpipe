// SPDX-License-Identifier: Apache-2.0
// The drain packs events from many sessions into one batch and moves every
// cursor only after the batch was acknowledged; a sink that refused waits as
// HTTP.md §2 says, for every worker; one worker drains at a time.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Cursors, type Event, Outbox, takeNamedLock, ulid } from "@sessionpipe/core";
import { afterEach, describe, expect, it } from "vitest";
import { drain, flush, readBackoff } from "../src/run.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "sp-flush-"));
afterEach(() => rmSync(tmp, { recursive: true, force: true }));
const ev = (session: string, seq: number, type = "session.heartbeat"): Event => ({
  protocol: 1,
  id: ulid(),
  type,
  time: new Date().toISOString(),
  tier: 3,
  harness: { name: "codex" },
  session: { id: session, seq },
  privacy: { rulesets: [], pii: false },
  data: type === "tool.ended" ? { tool: "Bash", ok: true } : {},
});

describe("flush", () => {
  it("packs 120 events from 30 sessions into 3 batches and advances every cursor", async () => {
    const outbox = new Outbox(tmp);
    for (let s = 0; s < 30; s++)
      outbox.append(
        { harness: "codex", session: `s${s}` },
        [0, 1, 2, 3].map((i) => ev(`s${s}`, i)),
      );
    const file = path.join(tmp, "out.jsonl");
    const d = await flush(tmp, [{ name: "f", url: `file:${file}`, tier: 0 }], outbox);
    expect(d.f).toBe(120);
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(120);
    const c = new Cursors(tmp, "f").read();
    expect(Object.keys(c)).toHaveLength(30);
    // A second flush sends nothing.
    expect((await flush(tmp, [{ name: "f", url: `file:${file}`, tier: 0 }], outbox)).f).toBe(0);
  });
  it("a tier-0 sink whose events all filter away still moves its cursors", async () => {
    const outbox = new Outbox(tmp);
    outbox.append({ harness: "codex", session: "t" }, [ev("t", 0, "tool.ended"), ev("t", 1, "tool.ended")]);
    const file = path.join(tmp, "out0.jsonl");
    const d = await flush(tmp, [{ name: "z", url: `file:${file}`, tier: 0 }], outbox);
    expect(d.z).toBe(0);
    expect(new Cursors(tmp, "z").read()["codex/t"]).toBeGreaterThan(0);
  });
  it("sinks drain at once: two slow receivers are in flight together", async () => {
    let inflight = 0;
    let most = 0;
    const server = createServer((_req, res) => {
      most = Math.max(most, ++inflight);
      setTimeout(() => {
        inflight--;
        res.writeHead(202, { "content-type": "application/json" }).end("{}");
      }, 300);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const outbox = new Outbox(tmp);
      outbox.append({ harness: "codex", session: "p" }, [ev("p", 0)]);
      const sinks = ["a", "b"].map((name) => ({ name, url, tier: 3 as const, token: "t" }));
      const d = await flush(tmp, sinks, outbox);
      expect(d).toEqual({ a: 1, b: 1 });
      expect(most).toBe(2);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

/** A receiver that answers from a script, counting what it got. */
async function receiver(answers: (n: number) => [number, Record<string, string>]): Promise<{
  url: string;
  hits: () => number;
  close: () => Promise<void>;
}> {
  let n = 0;
  const server: Server = createServer((_req, res) => {
    const [status, headers] = answers(++n);
    res.writeHead(status, { "content-type": "application/json", ...headers }).end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hits: () => n,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe("a sink that refused waits (HTTP.md §2)", () => {
  it("a 429 stops the sink for retry-after, for every flush; the next 202 clears it", async () => {
    const rx = await receiver((n) => (n === 1 ? [429, { "retry-after": "2" }] : [202, {}]));
    try {
      const outbox = new Outbox(tmp);
      outbox.append({ harness: "codex", session: "r" }, [ev("r", 0)]);
      const sink = [{ name: "s", url: rx.url, tier: 3 as const, token: "t" }];
      expect((await flush(tmp, sink, outbox)).s).toBe(0);
      const b = readBackoff(tmp, "s");
      expect(b?.failures).toBe(1);
      expect(b?.until).toBeGreaterThan(Date.now() + 1500);
      // Another worker, right after: no request at all.
      expect((await flush(tmp, sink, outbox)).s).toBe(0);
      expect(rx.hits()).toBe(1);
      // `sessionpipe replay` tries anyway, and the 202 ends the wait.
      expect((await flush(tmp, sink, outbox, undefined, { force: true })).s).toBe(1);
      expect(rx.hits()).toBe(2);
      expect(readBackoff(tmp, "s")).toBeNull();
    } finally {
      await rx.close();
    }
  });
  it("an unreachable sink waits 2 s, then longer each time, up to 30 min", async () => {
    const outbox = new Outbox(tmp);
    outbox.append({ harness: "codex", session: "u" }, [ev("u", 0)]);
    const sink = [{ name: "n", url: "http://127.0.0.1:9", tier: 3 as const, token: "t" }];
    const t0 = Date.now();
    expect((await flush(tmp, sink, outbox)).n).toBe(0);
    const first = readBackoff(tmp, "n");
    expect(first?.failures).toBe(1);
    expect(first?.until).toBeGreaterThanOrEqual(t0 + 2000);
    expect(first?.until).toBeLessThan(t0 + 10_000);
    // The fifth failure in a row waits 30 min, and so does every one after it.
    writeFileSync(path.join(tmp, "backoff", "n.json"), JSON.stringify({ until: 0, failures: 4, why: "" }));
    await flush(tmp, sink, outbox);
    expect(readBackoff(tmp, "n")?.until).toBeGreaterThanOrEqual(Date.now() + 29 * 60_000);
    writeFileSync(path.join(tmp, "backoff", "n.json"), JSON.stringify({ until: 0, failures: 9, why: "" }));
    await flush(tmp, sink, outbox);
    expect(readBackoff(tmp, "n")?.failures).toBe(10);
    expect(readBackoff(tmp, "n")?.until).toBeLessThan(Date.now() + 31 * 60_000);
  });
});

describe("drain: one worker at a time", () => {
  it("a worker that finds another draining sends nothing and marks that there is more", async () => {
    const rx = await receiver(() => [202, {}]);
    try {
      const outbox = new Outbox(tmp);
      outbox.append({ harness: "codex", session: "d" }, [ev("d", 0)]);
      const sink = [{ name: "s", url: rx.url, tier: 3 as const, token: "t" }];
      const held = takeNamedLock(tmp, "flush");
      expect(await drain(tmp, sink, outbox)).toBeNull();
      expect(rx.hits()).toBe(0);
      expect(existsSync(path.join(tmp, "locks", "flush.more"))).toBe(true);
      held?.();
      expect(await drain(tmp, sink, outbox)).toEqual({ s: 1 });
      expect(existsSync(path.join(tmp, "locks", "flush.more"))).toBe(false);
      expect(existsSync(path.join(tmp, "locks", "flush.lock"))).toBe(false);
    } finally {
      await rx.close();
    }
  });
  it("events another worker appended during a pass go out in the next pass of the same drain", async () => {
    const outbox = new Outbox(tmp);
    const rx = await receiver((n) => {
      if (n === 1) {
        // A sibling worker, mid-pass: its events are in the outbox, the lock is taken, it marks.
        outbox.append({ harness: "codex", session: "late" }, [ev("late", 0)]);
        writeFileSync(path.join(tmp, "locks", "flush.more"), "");
      }
      return [202, {}];
    });
    try {
      outbox.append({ harness: "codex", session: "early" }, [ev("early", 0)]);
      const sink = [{ name: "s", url: rx.url, tier: 3 as const, token: "t" }];
      expect(await drain(tmp, sink, outbox)).toEqual({ s: 2 });
      expect(rx.hits()).toBe(2);
      expect(new Cursors(tmp, "s").read()["codex/late"]).toBeGreaterThan(0);
    } finally {
      await rx.close();
    }
  });
});

/** A receiver that sees each batch and answers from it. */
async function sizedReceiver(answer: (events: Event[]) => number): Promise<{
  url: string;
  batches: Event[][];
  close: () => Promise<void>;
}> {
  const batches: Event[][] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d: Buffer) => {
      raw += d.toString("utf8");
    });
    req.on("end", () => {
      const { events } = JSON.parse(raw) as { events: Event[] };
      batches.push(events);
      res.writeHead(answer(events), { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    batches,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe("a batch too large is halved (HTTP.md §2 413)", () => {
  it("halves until it fits; one event too large alone is dropped and logged; the cursor reaches the end", async () => {
    const outbox = new Outbox(tmp);
    const events = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ev("big", i));
    const fat = events[5] as Event;
    // Over three events is too large; the fat one is too large whatever the batch.
    const rx = await sizedReceiver((b) => (b.length > 3 || b.some((e) => e.id === fat.id) ? 413 : 202));
    try {
      outbox.append({ harness: "codex", session: "big" }, events);
      const sink = [{ name: "s", url: rx.url, tier: 3 as const, token: "t" }];
      expect((await flush(tmp, sink, outbox)).s).toBe(8);
      expect(rx.batches.map((b) => b.map((e) => e.session.seq))).toEqual([
        [0, 1, 2, 3, 4, 5, 6, 7],
        [0, 1, 2, 3],
        [0, 1],
        [2, 3],
        [4, 5, 6, 7],
        [4, 5],
        [4],
        [5],
        [6, 7],
      ]);
      const taken = rx.batches.filter((b) => b.length <= 3 && !b.some((e) => e.id === fat.id)).flat();
      expect(taken.map((e) => e.session.seq).sort()).toEqual([0, 1, 2, 3, 4, 6, 7]);
      expect(new Cursors(tmp, "s").read()["codex/big"]).toBe(
        statSync(outbox.file({ harness: "codex", session: "big" })).size,
      );
      expect(readFileSync(path.join(tmp, "log"), "utf8")).toMatch(
        new RegExp(`${fat.id} \\(session.heartbeat\\) is too large alone, dropped`),
      );
      expect(readBackoff(tmp, "s")).toBeNull();
      // Nothing is sent again.
      expect((await flush(tmp, sink, outbox)).s).toBe(0);
    } finally {
      await rx.close();
    }
  });
  it("a half refused for another reason keeps the cursor: the next run sends the whole batch again", async () => {
    const outbox = new Outbox(tmp);
    let down = true;
    const rx = await sizedReceiver((b) => (b.length > 2 ? 413 : down && (b[0] as Event).session.seq >= 2 ? 503 : 202));
    try {
      outbox.append(
        { harness: "codex", session: "half" },
        [0, 1, 2, 3].map((i) => ev("half", i)),
      );
      const sink = [{ name: "s", url: rx.url, tier: 3 as const, token: "t" }];
      expect((await flush(tmp, sink, outbox)).s).toBe(0);
      expect(rx.batches.map((b) => b.length)).toEqual([4, 2, 2]);
      expect(new Cursors(tmp, "s").read()["codex/half"]).toBeUndefined();
      expect(readBackoff(tmp, "s")?.failures).toBe(1);
      down = false;
      expect((await flush(tmp, sink, outbox, undefined, { force: true })).s).toBe(4);
      expect(rx.batches.slice(3).map((b) => b.map((e) => e.session.seq))).toEqual([
        [0, 1, 2, 3],
        [0, 1],
        [2, 3],
      ]);
      expect(new Cursors(tmp, "s").read()["codex/half"]).toBe(
        statSync(outbox.file({ harness: "codex", session: "half" })).size,
      );
    } finally {
      await rx.close();
    }
  });
});
