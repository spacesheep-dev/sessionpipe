// SPDX-License-Identifier: Apache-2.0
// The sink contract (core/src/sinks/types.ts), the same for every sink: a batch
// goes out whole, the result says how many the medium counted, a bad event or a
// failing medium is a result, never a throw. The HTTP sink then answers HTTP.md §2
// status by status, and the drain moves a cursor only on success.
import { createHmac } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Cursors, type Event, FileSink, Outbox, readConfig, type Sink, StdoutSink, ulid } from "@sessionpipe/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpSink, webhookId } from "../src/http-sink.js";
import { buildSinks, flush, readBackoff } from "../src/run.js";

const ev = (session: string, seq: number, type = "tool.ended"): Event => ({
  protocol: 1,
  id: ulid(),
  type,
  time: new Date().toISOString(),
  tier: 3,
  harness: { name: "codex" },
  session: { id: session, seq },
  privacy: { rulesets: ["secrets@1"], pii: false },
  data: type === "tool.ended" ? { tool: "Bash", ok: true } : {},
});
const batch = (n: number, session = "s") => Array.from({ length: n }, (_, i) => ev(session, i));

/** One request the receiver saw. */
interface Hit {
  headers: IncomingMessage["headers"];
  raw: string;
  events: Event[];
}
type Answer = { status: number; headers?: Record<string, string>; body?: string | object } | "hang";

/** A receiver that answers from a script and remembers what it got. */
async function receiver(script: (n: number, hit: Hit) => Answer): Promise<{
  url: string;
  hits: Hit[];
  close: () => Promise<void>;
}> {
  const hits: Hit[] = [];
  const open = new Set<ServerResponse>();
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d: Buffer) => {
      raw += d.toString("utf8");
    });
    req.on("end", () => {
      let events: Event[] = [];
      try {
        events = (JSON.parse(raw) as { events: Event[] }).events;
      } catch {}
      const hit = { headers: req.headers, raw, events };
      hits.push(hit);
      const a = script(hits.length, hit);
      if (a === "hang") {
        open.add(res);
        return;
      }
      const body = typeof a.body === "string" ? a.body : JSON.stringify(a.body ?? {});
      res.writeHead(a.status, { "content-type": "application/json", ...a.headers }).end(body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hits,
    close: () => {
      for (const r of open) r.destroy();
      server.closeAllConnections();
      return new Promise<void>((r) => server.close(() => r()));
    },
  };
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "sp-sink-"));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(tmp, { recursive: true, force: true });
});

/** Each sink with a way to read back what it delivered and a way to break its medium. */
interface Subject {
  name: string;
  make(): Promise<{ sink: Sink; delivered: () => Event[]; close?: () => Promise<void> }>;
  broken(): Promise<{ sink: Sink; close?: () => Promise<void> }>;
}
const subjects: Subject[] = [
  {
    name: "file",
    async make() {
      const file = path.join(tmp, "nested", "dir", "out.jsonl");
      return {
        sink: new FileSink("f", file, 3, false),
        delivered: () =>
          readFileSync(file, "utf8")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l) as Event),
      };
    },
    async broken() {
      // The path is a directory: appendFileSync fails with EISDIR.
      mkdirSync(path.join(tmp, "isdir"), { recursive: true });
      return { sink: new FileSink("f", path.join(tmp, "isdir"), 3, false) };
    },
  },
  {
    name: "stdout",
    async make() {
      const lines: string[] = [];
      return {
        sink: new StdoutSink("o", 3, false, (l) => lines.push(l)),
        delivered: () => lines.map((l) => JSON.parse(l) as Event),
      };
    },
    async broken() {
      return {
        sink: new StdoutSink("o", 3, false, () => {
          throw new Error("EPIPE: broken pipe");
        }),
      };
    },
  },
  {
    name: "http",
    async make() {
      const rx = await receiver((_n, hit) => ({
        status: 202,
        body: { accepted: hit.events.length, duplicates: 0, rejected: [] },
      }));
      return {
        sink: new HttpSink({ name: "h", url: rx.url, tier: 3, token: "t" }, 3),
        delivered: () => rx.hits.flatMap((h) => h.events),
        close: rx.close,
      };
    },
    async broken() {
      // Nothing listens on the discard port.
      return { sink: new HttpSink({ name: "h", url: "http://127.0.0.1:9", tier: 3, token: "t" }, 3) };
    },
  },
];

describe.each(subjects)("sink contract: $name", (subject) => {
  it("delivers a batch whole, in order, and acknowledges every event", async () => {
    const s = await subject.make();
    try {
      const events = batch(7);
      const res = await s.sink.send(events);
      expect(res).toMatchObject({ ok: true, acknowledged: 7, accepted: 7, duplicates: 0, rejected: [] });
      expect(s.delivered().map((e) => e.id)).toEqual(events.map((e) => e.id));
      // A second batch appends; nothing of the first is sent again.
      const more = batch(2, "t");
      expect((await s.sink.send(more)).acknowledged).toBe(2);
      expect(s.delivered().map((e) => e.id)).toEqual([...events, ...more].map((e) => e.id));
    } finally {
      await s.close?.();
    }
  });
  it("an empty batch is acknowledged as nothing", async () => {
    const s = await subject.make();
    try {
      expect(await s.sink.send([])).toMatchObject({ ok: true, acknowledged: 0 });
    } finally {
      await s.close?.();
    }
  });
  it("never throws on a bad event: a shape the outbox should never hold still goes out", async () => {
    const s = await subject.make();
    try {
      const bad = [{ id: undefined, type: 42, data: null } as unknown as Event, { session: {} } as unknown as Event];
      const res = await s.sink.send(bad);
      expect(res.ok).toBe(true);
      expect(res.acknowledged).toBe(2);
      expect(s.delivered()).toHaveLength(2);
    } finally {
      await s.close?.();
    }
  });
  it("a failing medium is a result that asks for a retry, never a throw", async () => {
    const s = await subject.broken();
    try {
      const res = await s.sink.send(batch(3));
      expect(res.ok).toBe(false);
      expect(res.acknowledged).toBe(0);
      expect(res.action).toBe("retry");
      expect(res.error).toBeTruthy();
    } finally {
      await s.close?.();
    }
  });
  it("carries its name, tier and pii flag", async () => {
    const s = await subject.make();
    try {
      expect(typeof s.sink.name).toBe("string");
      expect(s.sink.tier).toBe(3);
      expect(s.sink.pii).toBe(false);
    } finally {
      await s.close?.();
    }
  });
});

describe("stdout sink", () => {
  it("writes one JSON line per event to process.stdout by default", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      const events = batch(2);
      await new StdoutSink("o", 1, true).send(events);
      expect(lines).toEqual(events.map((e) => `${JSON.stringify(e)}\n`));
    } finally {
      spy.mockRestore();
    }
  });
});

describe("file sink", () => {
  it("creates the file's folders and expands nothing: the path is taken as given", async () => {
    const file = path.join(tmp, "a", "b", "c.jsonl");
    const res = await new FileSink("f", file, 0, false).send(batch(1));
    expect(res.ok).toBe(true);
    expect(statSync(file).size).toBeGreaterThan(0);
  });
});

describe("http sink: the request (HTTP.md §2)", () => {
  it("POSTs {events} with the protocol header and the bearer token to the default path", async () => {
    const rx = await receiver(() => ({ status: 202, body: { accepted: 1, duplicates: 0, rejected: [] } }));
    try {
      const events = batch(1);
      const sink = new HttpSink({ name: "h", url: `${rx.url}/`, tier: 3, token: "tok" }, 3);
      await sink.send(events);
      const hit = rx.hits[0]!;
      expect(hit.headers["content-type"]).toBe("application/json");
      expect(hit.headers["sessionpipe-protocol"]).toBe("1");
      expect(hit.headers.authorization).toBe("Bearer tok");
      expect(hit.headers["webhook-id"]).toBeUndefined();
      expect(JSON.parse(hit.raw)).toEqual({ events: JSON.parse(JSON.stringify(events)) });
    } finally {
      await rx.close();
    }
  });
  it("sends no authorization header without a token", async () => {
    const rx = await receiver(() => ({ status: 202 }));
    try {
      await new HttpSink({ name: "h", url: rx.url, tier: 3 }, 3).send(batch(1));
      expect(rx.hits[0]!.headers.authorization).toBeUndefined();
    } finally {
      await rx.close();
    }
  });
  it("signs with Standard Webhooks headers when the secret is a whsec_ key; the same batch keeps its id", async () => {
    const rx = await receiver(() => ({ status: 202 }));
    try {
      const key = Buffer.from("0123456789abcdef0123456789abcdef");
      const secret = `whsec_${key.toString("base64")}`;
      const events = batch(3);
      const sink = new HttpSink({ name: "h", url: rx.url, tier: 3, token: "t", secret }, 3);
      await sink.send(events);
      await sink.send(events);
      const [a, b] = rx.hits as [Hit, Hit];
      expect(a.headers["webhook-id"]).toBe(webhookId(events));
      expect(b.headers["webhook-id"]).toBe(a.headers["webhook-id"]);
      const ts = Number(a.headers["webhook-timestamp"]);
      expect(Math.abs(ts - Date.now() / 1000)).toBeLessThan(5);
      const want = createHmac("sha256", key).update(`${a.headers["webhook-id"]}.${ts}.${a.raw}`).digest("base64");
      expect(a.headers["webhook-signature"]).toBe(`v1,${want}`);
    } finally {
      await rx.close();
    }
  });
  it("a secret without the whsec_ prefix signs nothing", async () => {
    const rx = await receiver(() => ({ status: 202 }));
    try {
      await new HttpSink({ name: "h", url: rx.url, tier: 3, token: "t", secret: "plain" }, 3).send(batch(1));
      expect(rx.hits[0]!.headers["webhook-signature"]).toBeUndefined();
    } finally {
      await rx.close();
    }
  });
  it("uses the events endpoint learned from the well-known file: a path, or an absolute URL", async () => {
    const rx = await receiver(() => ({ status: 202 }));
    const paths: string[] = [];
    const other = createServer((req, res) => {
      paths.push(req.url ?? "");
      res.writeHead(202).end("{}");
    });
    await new Promise<void>((r) => other.listen(0, "127.0.0.1", () => r()));
    try {
      const cfg = { name: "h", url: rx.url, tier: 3 as const, endpoints: { events: "/custom/events" } };
      await new HttpSink(cfg, 3).send(batch(1));
      const otherUrl = `http://127.0.0.1:${(other.address() as AddressInfo).port}/elsewhere`;
      const absolute = { ...cfg, endpoints: { events: otherUrl } };
      await new HttpSink(absolute, 3).send(batch(1));
      expect(rx.hits).toHaveLength(1);
      expect(paths).toEqual(["/elsewhere"]);
    } finally {
      await rx.close();
      await new Promise<void>((r) => other.close(() => r()));
    }
  });
  it("takes its name, pii and tier from the config, capped by the caller", () => {
    const sink = new HttpSink({ name: "mine", url: "https://r.example", tier: 3, pii: true }, 1);
    expect(sink.name).toBe("mine");
    expect(sink.pii).toBe(true);
    expect(sink.tier).toBe(1);
  });
});

describe("http sink: the response (HTTP.md §2)", () => {
  const sinkFor = (url: string) => new HttpSink({ name: "h", url, tier: 3, token: "t" }, 3);

  it("202: the receiver's counts come back as given, with a lowered max_tier", async () => {
    const rx = await receiver(() => ({
      status: 202,
      body: { accepted: 2, duplicates: 1, rejected: [{ id: "x", reason: "tier_type" }], max_tier: 1 },
    }));
    try {
      expect(await sinkFor(rx.url).send(batch(4))).toEqual({
        ok: true,
        acknowledged: 4,
        accepted: 2,
        duplicates: 1,
        rejected: [{ id: "x", reason: "tier_type" }],
        max_tier: 1,
        status: 202,
      });
    } finally {
      await rx.close();
    }
  });
  it("202 with an empty or malformed body: every event counts as accepted", async () => {
    const rx = await receiver((n) => ({ status: 202, body: n === 1 ? "" : "{not json" }));
    try {
      for (let i = 0; i < 2; i++) {
        const res = await sinkFor(rx.url).send(batch(3));
        expect(res).toMatchObject({ ok: true, acknowledged: 3, accepted: 3, duplicates: 0, rejected: [] });
        expect(res.max_tier).toBeUndefined();
      }
    } finally {
      await rx.close();
    }
  });
  it("202 with a rejected field that is not a list reads as no rejections", async () => {
    const rx = await receiver(() => ({ status: 202, body: { accepted: 1, rejected: "none" } }));
    try {
      expect((await sinkFor(rx.url).send(batch(1))).rejected).toEqual([]);
    } finally {
      await rx.close();
    }
  });
  it("200 is taken as success too (a lenient receiver), though the spec names 202", async () => {
    const rx = await receiver(() => ({ status: 200, body: { accepted: 1 } }));
    try {
      expect(await sinkFor(rx.url).send(batch(1))).toMatchObject({ ok: true, acknowledged: 1, status: 200 });
    } finally {
      await rx.close();
    }
  });
  it("207 is not success: the spec has no partial batch, the cursor may not move", async () => {
    const rx = await receiver(() => ({ status: 207, body: { accepted: 1, rejected: [] } }));
    try {
      const res = await sinkFor(rx.url).send(batch(2));
      expect(res.ok).toBe(false);
      expect(res.acknowledged).toBe(0);
      expect(res.status).toBe(207);
      expect(res.action).toBe("retry");
    } finally {
      await rx.close();
    }
  });
  it("a partial batch is a 202 with rejected ids: the whole batch is acknowledged", async () => {
    const rx = await receiver((_n, hit) => ({
      status: 202,
      body: { accepted: hit.events.length - 1, duplicates: 0, rejected: [{ id: hit.events[0]!.id, reason: "bad" }] },
    }));
    try {
      const events = batch(3);
      const res = await sinkFor(rx.url).send(events);
      expect(res.ok).toBe(true);
      expect(res.acknowledged).toBe(3);
      expect(res.accepted).toBe(2);
      expect(res.rejected).toEqual([{ id: events[0]!.id, reason: "bad" }]);
    } finally {
      await rx.close();
    }
  });
  it("400: drop the batch; the reason is the error, or the body's start when there is none", async () => {
    const rx = await receiver((n) => ({
      status: 400,
      body: n === 1 ? { reason: "unsupported_protocol", supported: [1] } : "plain text, not json",
    }));
    try {
      expect(await sinkFor(rx.url).send(batch(1))).toEqual({
        ok: false,
        acknowledged: 0,
        status: 400,
        error: "unsupported_protocol",
        action: "drop",
      });
      expect(await sinkFor(rx.url).send(batch(1))).toMatchObject({ action: "drop", error: "plain text, not json" });
    } finally {
      await rx.close();
    }
  });
  it("401: pause the sink", async () => {
    const rx = await receiver(() => ({ status: 401, body: { reason: "unauthorized" } }));
    try {
      expect(await sinkFor(rx.url).send(batch(1))).toEqual({
        ok: false,
        acknowledged: 0,
        status: 401,
        error: "unauthorized",
        action: "pause",
      });
    } finally {
      await rx.close();
    }
  });
  it("403: lower the tier to the receiver's max_tier; without one, no tier is named", async () => {
    const rx = await receiver((n) => ({
      status: 403,
      body: n === 1 ? { reason: "tier_above_max", max_tier: 1 } : { reason: "tier_above_max" },
    }));
    try {
      expect(await sinkFor(rx.url).send(batch(1))).toEqual({
        ok: false,
        acknowledged: 0,
        status: 403,
        error: "tier_above_max",
        action: "lower-tier",
        max_tier: 1,
      });
      const bare = await sinkFor(rx.url).send(batch(1));
      expect(bare.action).toBe("lower-tier");
      expect(bare.max_tier).toBeUndefined();
    } finally {
      await rx.close();
    }
  });
  it("413: split the batch", async () => {
    const rx = await receiver(() => ({ status: 413, body: { reason: "too_large" } }));
    try {
      expect(await sinkFor(rx.url).send(batch(2))).toEqual({
        ok: false,
        acknowledged: 0,
        status: 413,
        error: "too_large",
        action: "split",
      });
    } finally {
      await rx.close();
    }
  });
  it("429: retry after what retry-after says, in seconds or as an HTTP date; a minute when it is missing", async () => {
    const soon = new Date(Date.now() + 30_000).toUTCString();
    const rx = await receiver((n) => ({
      status: 429,
      headers: n === 1 ? { "retry-after": "7" } : n === 2 ? { "retry-after": soon } : {},
      body: { reason: "rate_limited" },
    }));
    try {
      expect(await sinkFor(rx.url).send(batch(1))).toEqual({
        ok: false,
        acknowledged: 0,
        status: 429,
        error: "rate_limited",
        action: "retry",
        retryAfterMs: 7000,
      });
      const dated = await sinkFor(rx.url).send(batch(1));
      expect(dated.action).toBe("retry");
      expect(dated.retryAfterMs).toBeGreaterThan(25_000);
      expect(dated.retryAfterMs).toBeLessThanOrEqual(31_000);
      expect((await sinkFor(rx.url).send(batch(1))).retryAfterMs).toBe(60_000);
    } finally {
      await rx.close();
    }
  });
  it("5xx: retry, with the body's reason or text as the error", async () => {
    const rx = await receiver((n) => ({ status: 500 + n, body: n === 1 ? { reason: "down" } : "<html>oops" }));
    try {
      expect(await sinkFor(rx.url).send(batch(1))).toEqual({
        ok: false,
        acknowledged: 0,
        status: 501,
        error: "down",
        action: "retry",
      });
      expect(await sinkFor(rx.url).send(batch(1))).toMatchObject({ status: 502, error: "<html>oops", action: "retry" });
    } finally {
      await rx.close();
    }
  });
  it("a network error: retry, with the error's message", async () => {
    const res = await sinkFor("http://127.0.0.1:9").send(batch(1));
    expect(res).toMatchObject({ ok: false, acknowledged: 0, action: "retry" });
    expect(res.status).toBeUndefined();
    expect(res.error).toMatch(/fetch failed|ECONNREFUSED/);
  });
  it("a receiver that never answers: the 15 s timeout aborts the request, then retry", async () => {
    const rx = await receiver(() => "hang");
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const p = sinkFor(rx.url).send(batch(1));
      // The request is in flight; nothing has aborted it yet.
      await vi.advanceTimersByTimeAsync(14_999);
      await vi.advanceTimersByTimeAsync(1);
      const res = await p;
      expect(res).toMatchObject({ ok: false, acknowledged: 0, action: "retry" });
      expect(res.error).toMatch(/abort/i);
    } finally {
      vi.useRealTimers();
      await rx.close();
    }
  });
});

describe("the drain and its cursors (PROTOCOL.md ground rule 1, HTTP.md §2)", () => {
  const sinks = (url: string, extra: Record<string, unknown> = {}) => [
    { name: "s", url, tier: 3 as const, token: "t", ...extra },
  ];
  const cursor = () => new Cursors(tmp, "s").read()["codex/c"];

  it("the cursor moves only on success; a refused batch is sent again intact, as the same message", async () => {
    const rx = await receiver((n) => (n === 1 ? { status: 503 } : { status: 202 }));
    try {
      const outbox = new Outbox(tmp);
      const events = batch(5, "c");
      outbox.append({ harness: "codex", session: "c" }, events);
      const secret = `whsec_${Buffer.from("k".repeat(32)).toString("base64")}`;
      const cfg = sinks(rx.url, { secret });
      expect((await flush(tmp, cfg, outbox)).s).toBe(0);
      expect(cursor()).toBeUndefined();
      expect(readBackoff(tmp, "s")?.failures).toBe(1);
      // The next worker, once the wait is over, sends the very same batch.
      expect((await flush(tmp, cfg, outbox, undefined, { force: true })).s).toBe(5);
      expect(rx.hits).toHaveLength(2);
      expect(rx.hits[1]!.events.map((e) => e.id)).toEqual(events.map((e) => e.id));
      expect(rx.hits[1]!.headers["webhook-id"]).toBe(rx.hits[0]!.headers["webhook-id"]);
      expect(cursor()).toBe(statSync(outbox.file({ harness: "codex", session: "c" })).size);
      expect(readBackoff(tmp, "s")).toBeNull();
      // Nothing more to send: the cursor stays.
      expect((await flush(tmp, cfg, outbox)).s).toBe(0);
      expect(rx.hits).toHaveLength(2);
    } finally {
      await rx.close();
    }
  });
  it("a refused batch stops the sink for the run: later sessions wait behind it, in order", async () => {
    const rx = await receiver((n) => (n === 1 ? { status: 500 } : { status: 202 }));
    try {
      const outbox = new Outbox(tmp);
      outbox.append({ harness: "codex", session: "c" }, batch(60, "c"));
      outbox.append({ harness: "codex", session: "d" }, batch(3, "d"));
      const cfg = sinks(rx.url);
      expect((await flush(tmp, cfg, outbox, { harness: "codex", session: "c" })).s).toBe(0);
      expect(rx.hits).toHaveLength(1);
      expect(rx.hits[0]!.events).toHaveLength(50);
      expect(new Cursors(tmp, "s").read()).toEqual({});
      expect((await flush(tmp, cfg, outbox, { harness: "codex", session: "c" }, { force: true })).s).toBe(63);
      expect(rx.hits.map((h) => h.events.length)).toEqual([50, 50, 13]);
      expect(rx.hits[1]!.events.map((e) => e.session.seq)).toEqual(rx.hits[0]!.events.map((e) => e.session.seq));
    } finally {
      await rx.close();
    }
  });
  it("400 drops the batch and moves on: the cursor passes it, the log says so", async () => {
    const rx = await receiver((n) => (n === 1 ? { status: 400, body: { reason: "malformed" } } : { status: 202 }));
    try {
      const outbox = new Outbox(tmp);
      outbox.append({ harness: "codex", session: "c" }, batch(60, "c"));
      expect((await flush(tmp, sinks(rx.url), outbox)).s).toBe(60);
      expect(rx.hits.map((h) => h.events.length)).toEqual([50, 10]);
      expect(cursor()).toBe(statSync(outbox.file({ harness: "codex", session: "c" })).size);
      expect(readFileSync(path.join(tmp, "log"), "utf8")).toMatch(/sink s: 400 malformed → drop/);
    } finally {
      await rx.close();
    }
  });
  it("413 halves the batch until it fits; one event too large alone is dropped and logged", async () => {
    // Anything over 12 events is too large; one event is too large whatever the batch.
    const outbox = new Outbox(tmp);
    const events = batch(30, "c");
    const fat = events[7]!;
    const rx = await receiver((_n, hit) =>
      hit.events.length > 12 || hit.events.some((e) => e.id === fat.id) ? { status: 413 } : { status: 202 },
    );
    try {
      outbox.append({ harness: "codex", session: "c" }, events);
      expect((await flush(tmp, sinks(rx.url), outbox)).s).toBe(30);
      const sizes = rx.hits.map((h) => `${h.events.length}${h.events.some((e) => e.id === fat.id) ? "!" : ""}`);
      // 30 → 15 → 8 → 4+4 → 2+2 → 1+1: the fat event's halves narrow down to it
      // alone; the other 15 are over the limit too and go as 8+7.
      expect(sizes).toEqual(["30!", "15!", "8!", "4", "4!", "2", "2!", "1", "1!", "7", "15", "8", "7"]);
      const got = rx.hits.filter((h) => h.events.length <= 12 && !h.events.some((e) => e.id === fat.id));
      expect(got.flatMap((h) => h.events.map((e) => e.id)).sort()).toEqual(
        events
          .filter((e) => e.id !== fat.id)
          .map((e) => e.id)
          .sort(),
      );
      expect(cursor()).toBe(statSync(outbox.file({ harness: "codex", session: "c" })).size);
      expect(readFileSync(path.join(tmp, "log"), "utf8")).toMatch(new RegExp(`${fat.id}.*too large alone, dropped`));
      expect(readBackoff(tmp, "s")).toBeNull();
    } finally {
      await rx.close();
    }
  });
  it("a split whose half is refused leaves the cursor where it was", async () => {
    const rx = await receiver((_n, hit) => (hit.events.length > 2 ? { status: 413 } : { status: 503 }));
    try {
      const outbox = new Outbox(tmp);
      outbox.append({ harness: "codex", session: "c" }, batch(4, "c"));
      expect((await flush(tmp, sinks(rx.url), outbox)).s).toBe(0);
      expect(rx.hits.map((h) => h.events.length)).toEqual([4, 2]);
      expect(cursor()).toBeUndefined();
      expect(readBackoff(tmp, "s")?.failures).toBe(1);
    } finally {
      await rx.close();
    }
  });
  it("a split whose half is answered 400 drops that half alone: the other half is still sent", async () => {
    const events = batch(4, "c");
    const bad = events[0]!;
    const rx = await receiver((_n, hit) =>
      hit.events.length > 2
        ? { status: 413 }
        : hit.events.some((e) => e.id === bad.id)
          ? { status: 400, body: { reason: "malformed" } }
          : { status: 202 },
    );
    try {
      const outbox = new Outbox(tmp);
      outbox.append({ harness: "codex", session: "c" }, events);
      expect((await flush(tmp, sinks(rx.url), outbox)).s).toBe(4);
      expect(rx.hits.map((h) => h.events.map((e) => e.session.seq))).toEqual([
        [0, 1, 2, 3],
        [0, 1],
        [2, 3],
      ]);
      expect(cursor()).toBe(statSync(outbox.file({ harness: "codex", session: "c" })).size);
      expect(readFileSync(path.join(tmp, "log"), "utf8")).toMatch(/sink s: 400 malformed → drop, 2 of 4 events/);
      expect(readBackoff(tmp, "s")).toBeNull();
    } finally {
      await rx.close();
    }
  });
  it("a split whose other half is refused after one half was dropped leaves the cursor where it was", async () => {
    const events = batch(4, "c");
    const bad = events[0]!;
    const rx = await receiver((_n, hit) =>
      hit.events.length > 2
        ? { status: 413 }
        : hit.events.some((e) => e.id === bad.id)
          ? { status: 400, body: { reason: "malformed" } }
          : { status: 503 },
    );
    try {
      const outbox = new Outbox(tmp);
      outbox.append({ harness: "codex", session: "c" }, events);
      expect((await flush(tmp, sinks(rx.url), outbox)).s).toBe(0);
      expect(rx.hits.map((h) => h.events.length)).toEqual([4, 2, 2]);
      expect(cursor()).toBeUndefined();
      expect(readBackoff(tmp, "s")?.failures).toBe(1);
    } finally {
      await rx.close();
    }
  });
  it("401 pauses the sink in the config: the next worker builds no sink for it", async () => {
    const file = path.join(tmp, "config.json");
    const rx = await receiver(() => ({ status: 401, body: { reason: "bad_token" } }));
    const prev = process.env.SESSIONPIPE_CONFIG;
    process.env.SESSIONPIPE_CONFIG = file;
    try {
      const cfg = sinks(rx.url);
      writeFileSync(file, JSON.stringify({ sinks: cfg, harnesses: {} }));
      const outbox = new Outbox(tmp);
      outbox.append({ harness: "codex", session: "c" }, batch(2, "c"));
      expect((await flush(tmp, cfg, outbox)).s).toBe(0);
      const paused = readConfig().sinks[0]!.paused;
      expect(paused).toMatch(/^\d{4}-.* bad_token$/);
      expect(cursor()).toBeUndefined();
      expect(readBackoff(tmp, "s")).toBeNull();
      expect(await flush(tmp, readConfig().sinks, outbox)).toEqual({});
      expect(rx.hits).toHaveLength(1);
    } finally {
      if (prev === undefined) delete process.env.SESSIONPIPE_CONFIG;
      else process.env.SESSIONPIPE_CONFIG = prev;
      await rx.close();
    }
  });
  it("403 lowers the sink's tier to max_tier: the next worker re-filters and the batch goes through", async () => {
    const file = path.join(tmp, "config.json");
    const rx = await receiver((_n, hit) =>
      hit.events.some((e) => e.tier > 1)
        ? { status: 403, body: { reason: "tier_above_max", max_tier: 1 } }
        : { status: 202 },
    );
    const prev = process.env.SESSIONPIPE_CONFIG;
    process.env.SESSIONPIPE_CONFIG = file;
    try {
      const cfg = sinks(rx.url);
      writeFileSync(file, JSON.stringify({ sinks: cfg, harnesses: {} }));
      const outbox = new Outbox(tmp);
      outbox.append({ harness: "codex", session: "c" }, [ev("c", 0, "turn.started"), ev("c", 1)]);
      expect((await flush(tmp, cfg, outbox)).s).toBe(0);
      expect(readConfig().sinks[0]!.max_tier).toBe(1);
      expect(readConfig().sinks[0]!.paused).toBeUndefined();
      expect(cursor()).toBeUndefined();
      expect((await flush(tmp, readConfig().sinks, outbox)).s).toBe(2);
      expect(rx.hits[1]!.events.map((e) => e.tier)).toEqual([1, 1]);
      expect(cursor()).toBe(statSync(outbox.file({ harness: "codex", session: "c" })).size);
    } finally {
      if (prev === undefined) delete process.env.SESSIONPIPE_CONFIG;
      else process.env.SESSIONPIPE_CONFIG = prev;
      await rx.close();
    }
  });
  it("a verdict for a sink the config no longer has, or a config that can't be written, changes nothing", async () => {
    const file = path.join(tmp, "config.json");
    const rx = await receiver(() => ({ status: 401 }));
    const prev = process.env.SESSIONPIPE_CONFIG;
    process.env.SESSIONPIPE_CONFIG = file;
    try {
      const other = { sinks: [{ name: "other", url: "stdout", tier: 0 }], harnesses: {} };
      writeFileSync(file, JSON.stringify(other));
      const outbox = new Outbox(tmp);
      outbox.append({ harness: "codex", session: "c" }, batch(1, "c"));
      await flush(tmp, sinks(rx.url), outbox);
      expect(readConfig().sinks).toEqual(other.sinks);
      const cfg = sinks(rx.url);
      writeFileSync(file, JSON.stringify({ sinks: cfg, harnesses: {} }));
      chmodSync(file, 0o400);
      await flush(tmp, cfg, outbox);
      expect(readConfig().sinks[0]!.paused).toBeUndefined();
      expect(rx.hits).toHaveLength(2);
    } finally {
      if (prev === undefined) delete process.env.SESSIONPIPE_CONFIG;
      else process.env.SESSIONPIPE_CONFIG = prev;
      await rx.close();
    }
  });
});

describe("the drain: which sinks it builds, and how much it sends per run", () => {
  it("builds stdout, file (with ~ expanded) and http sinks; skips a paused one and a scheme it has no sink for", () => {
    const sinks = buildSinks([
      { name: "o", url: "stdout", tier: 3 },
      { name: "f", url: "file:~/x/out.jsonl", tier: 2, max_tier: 1 },
      { name: "h", url: "https://r.example", tier: 1, pii: true },
      { name: "p", url: "stdout", tier: 0, paused: "2026-10-16T00:00:00.000Z 401" },
      { name: "z", url: "otlp:https://r.example", tier: 0 },
    ]);
    expect(sinks.map((s) => s.name)).toEqual(["o", "f", "h"]);
    expect(sinks[0]).toBeInstanceOf(StdoutSink);
    expect((sinks[1] as FileSink).file).toBe(`${os.homedir()}/x/out.jsonl`);
    expect(sinks[1]!.tier).toBe(1);
    expect(sinks[2]).toBeInstanceOf(HttpSink);
    expect(sinks[2]!.pii).toBe(true);
  });
  it("a stdout sink drains to the process's stdout, one line per event", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      const outbox = new Outbox(tmp);
      const events = batch(3, "c");
      outbox.append({ harness: "codex", session: "c" }, events);
      expect(await flush(tmp, [{ name: "o", url: "stdout", tier: 3 }], outbox)).toEqual({ o: 3 });
      expect(lines.map((l) => (JSON.parse(l) as Event).id)).toEqual(events.map((e) => e.id));
      expect(new Cursors(tmp, "o").read()["codex/c"]).toBe(
        statSync(outbox.file({ harness: "codex", session: "c" })).size,
      );
    } finally {
      spy.mockRestore();
    }
  });
  it("a backoff file without a number in it is no backoff", () => {
    mkdirSync(path.join(tmp, "backoff"), { recursive: true });
    writeFileSync(path.join(tmp, "backoff", "s.json"), JSON.stringify({ failures: 2, why: "" }));
    expect(readBackoff(tmp, "s")).toBeNull();
    writeFileSync(path.join(tmp, "backoff", "s.json"), "not json");
    expect(readBackoff(tmp, "s")).toBeNull();
  });
  it("a split whose second half is refused keeps the cursor; the next run sends the whole batch again", async () => {
    let refuse = true;
    const rx = await receiver((_n, hit) =>
      hit.events.length > 2
        ? { status: 413 }
        : refuse && hit.events[0]!.session.seq >= 2
          ? { status: 503 }
          : { status: 202 },
    );
    try {
      const outbox = new Outbox(tmp);
      const events = batch(4, "c");
      outbox.append({ harness: "codex", session: "c" }, events);
      const cfg = [{ name: "s", url: rx.url, tier: 3 as const, token: "t" }];
      expect((await flush(tmp, cfg, outbox)).s).toBe(0);
      expect(rx.hits.map((h) => h.events.length)).toEqual([4, 2, 2]);
      expect(new Cursors(tmp, "s").read()["codex/c"]).toBeUndefined();
      refuse = false;
      expect((await flush(tmp, cfg, outbox, undefined, { force: true })).s).toBe(4);
      // The first half goes again (the receiver counts it as duplicates), then the second.
      expect(rx.hits.slice(3).map((h) => h.events.map((e) => e.session.seq))).toEqual([
        [0, 1, 2, 3],
        [0, 1],
        [2, 3],
      ]);
      expect(new Cursors(tmp, "s").read()["codex/c"]).toBe(
        statSync(outbox.file({ harness: "codex", session: "c" })).size,
      );
    } finally {
      await rx.close();
    }
  });
  it("one run sends at most 500 events per sink; the rest go with the next", async () => {
    const rx = await receiver(() => ({ status: 202 }));
    try {
      const outbox = new Outbox(tmp);
      outbox.append({ harness: "codex", session: "c" }, batch(520, "c"));
      const cfg = [{ name: "s", url: rx.url, tier: 3 as const, token: "t" }];
      expect((await flush(tmp, cfg, outbox)).s).toBe(500);
      expect(rx.hits).toHaveLength(10);
      expect((await flush(tmp, cfg, outbox)).s).toBe(20);
      expect(rx.hits[10]!.events.map((e) => e.session.seq)[0]).toBe(500);
      expect(new Cursors(tmp, "s").read()["codex/c"]).toBe(
        statSync(outbox.file({ harness: "codex", session: "c" })).size,
      );
    } finally {
      await rx.close();
    }
  });
});
