// SPDX-License-Identifier: Apache-2.0
// The delivery scenarios (conformance/delivery, HTTP.md §7) from the sender's side:
// each fixture's steps go through the HTTP sink to a scripted receiver that answers
// as the spec says, and the sink's result is what HTTP.md §2 tells the sender to do
// with that status. The receiver here is a fake; a real one is checked by the
// conformance runner. The fixture's `read` step is the receiver's own; it is made
// directly, so the forget scenario stays whole.
import { createHmac } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Cursors, type DeliveryResult, type Event, Outbox, ulid } from "@sessionpipe/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpSink } from "../src/http-sink.js";
import { flush } from "../src/run.js";

const DIR = path.resolve(__dirname, "../../../conformance/delivery");
const TOKEN = "sink_token_for_fixtures";
const SECRET = `whsec_${Buffer.from("secret_for_fixtures").toString("base64")}`;
const MAX_TIER = 2;
const MAX_EVENTS = 50;
const MAX_BYTES = 262_144;
const CAPABILITIES = ["events", "forget"];

interface Step {
  send?: { auth?: string; headers?: Record<string, string>; events: unknown };
  read?: { session: string };
  expect: { status: number; body?: Record<string, unknown> };
}
interface Fixture {
  name: string;
  spec: string;
  skip_when?: string;
  capability?: string;
  steps: Step[];
}

/** Whether the request carries a Standard Webhooks signature made with `secret` within
 *  5 minutes of now (HTTP.md §2 `webhook-signature`). */
function signed(h: IncomingHttpHeaders, raw: string, secret: string): boolean {
  const [id, ts, sigs] = [h["webhook-id"], h["webhook-timestamp"], h["webhook-signature"]];
  if (typeof sigs !== "string" || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const key = Buffer.from(secret.slice(6), "base64");
  const want = `v1,${createHmac("sha256", key).update(`${id}.${ts}.${raw}`).digest("base64")}`;
  return sigs.split(" ").includes(want);
}

/** A receiver that keeps HTTP.md §2 and §5: dedup on (harness, session, seq), the
 *  batch bounds, the tier cap, the protocol header, the bearer token, forget. Given a
 *  secret it verifies signatures, and takes a signed request with no bearer. */
async function fakeReceiver(secret?: string): Promise<{ url: string; close: () => Promise<void> }> {
  const store = new Map<string, Map<number, Event>>();
  const server: Server = createServer((req, res) => {
    const answer = (status: number, body: unknown) =>
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    const url = req.url ?? "";
    if (req.method === "GET" && url.startsWith("/api/sessionpipe/v1/sessions/")) {
      const key = decodeURIComponent(url.slice("/api/sessionpipe/v1/sessions/".length));
      const s = store.get(key);
      return s?.size ? answer(200, { session: key, events: s.size }) : answer(404, { reason: "not_found" });
    }
    if (req.method !== "POST" || url !== "/api/sessionpipe/v1/events") return answer(404, { reason: "not_found" });
    let raw = "";
    req.on("data", (d: Buffer) => {
      raw += d.toString("utf8");
    });
    req.on("end", () => {
      const bearer = req.headers.authorization;
      const signedOnly = bearer === undefined && !!secret && signed(req.headers, raw, secret);
      if (bearer !== `Bearer ${TOKEN}` && !signedOnly) return answer(401, { reason: "unauthorized" });
      if (req.headers["sessionpipe-protocol"] !== "1")
        return answer(400, { reason: "unsupported_protocol", supported: [1] });
      let events: Event[];
      try {
        events = (JSON.parse(raw) as { events: Event[] }).events;
        if (!Array.isArray(events) || !events.length) throw new Error("no events");
      } catch {
        return answer(400, { reason: "malformed" });
      }
      if (events.length > MAX_EVENTS || Buffer.byteLength(raw) > MAX_BYTES) return answer(413, { reason: "too_large" });
      if (events.some((e) => e.protocol !== 1)) return answer(400, { reason: "unsupported_protocol", supported: [1] });
      if (events.some((e) => e.tier > MAX_TIER)) return answer(403, { reason: "tier_above_max", max_tier: MAX_TIER });
      let accepted = 0;
      let duplicates = 0;
      for (const e of events) {
        const key = `${e.harness.name}:${e.session.id}`;
        if (e.type === "session.forgotten") {
          store.delete(key);
          accepted++;
          continue;
        }
        const s = store.get(key) ?? new Map<number, Event>();
        if (s.has(e.session.seq)) duplicates++;
        else {
          s.set(e.session.seq, e);
          accepted++;
        }
        store.set(key, s);
      }
      answer(202, { accepted, duplicates, rejected: [], max_tier: MAX_TIER });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const event = (seq: number, run: string, data: Record<string, unknown> = {}): Event => ({
  protocol: 1,
  id: ulid(),
  type: "tool.ended",
  time: new Date().toISOString(),
  tier: 0,
  harness: { name: "conformance", event: "test" },
  session: { id: `conf-${run}`, seq },
  privacy: { rulesets: ["secrets@1"], pii: false },
  data: { tool: "Bash", ok: true, ...data },
});

/** The fixture's placeholders, resolved for this run and this receiver. */
function resolve(v: unknown, run: string): unknown {
  if (typeof v === "string") {
    if (v === "*") return v;
    if (v === "{max_events+1 events}") return Array.from({ length: MAX_EVENTS + 1 }, (_, i) => event(i, run));
    // An unknown type: the sender's filter keeps its data whole (PROTOCOL.md §2 data).
    if (v === "{one batch over max_bytes}")
      return [{ ...event(0, run), type: "conformance.blob", data: { pad: "x".repeat(MAX_BYTES) } }];
    if (v === "{max_tier+1}") return MAX_TIER + 1;
    if (v === "{max_tier}") return MAX_TIER;
    return v.replace(/\{run\}/g, run);
  }
  if (Array.isArray(v)) return v.map((x) => resolve(x, run));
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, resolve(x, run)]));
  return v;
}
const fill = (e: Record<string, unknown>): Event =>
  ({ ...e, id: e.id === "*" ? ulid() : e.id, time: e.time === "*" ? new Date().toISOString() : e.time }) as Event;

/** The fixture's `expect.body` is a subset of what came back. */
function subset(want: unknown, got: unknown): boolean {
  if (want === "*") return true;
  if (Array.isArray(want))
    return Array.isArray(got) && want.length === got.length && want.every((w, i) => subset(w, got[i]));
  if (want && typeof want === "object")
    return (
      !!got &&
      typeof got === "object" &&
      Object.entries(want).every(([k, v]) => subset(v, (got as Record<string, unknown>)[k]))
    );
  return want === got;
}

/** HTTP.md §2: what the sender does with each status. */
const SENDER: Record<number, (res: DeliveryResult, n: number, body?: Record<string, unknown>) => void> = {
  202: (res, n, body) => {
    expect(res.ok).toBe(true);
    expect(res.acknowledged).toBe(n);
    expect(res.max_tier).toBe(MAX_TIER);
    if (body) expect(subset(body, res)).toBe(true);
  },
  400: (res, _n, body) => {
    expect(res).toMatchObject({ ok: false, acknowledged: 0, action: "drop" });
    if (body?.reason) expect(res.error).toBe(body.reason);
  },
  401: (res) => expect(res).toMatchObject({ ok: false, acknowledged: 0, action: "pause" }),
  403: (res, _n, body) =>
    expect(res).toMatchObject({ ok: false, acknowledged: 0, action: "lower-tier", max_tier: body?.max_tier }),
  413: (res) => expect(res).toMatchObject({ ok: false, acknowledged: 0, action: "split" }),
};

/** The sink's credentials for a fixture's `auth`: a wrong bearer, the signature alone, or the bearer. */
const credentials = (auth?: string): { token?: string; secret?: string } =>
  auth === "wrong" ? { token: "wrong-token" } : auth === "signed" ? { secret: SECRET } : { token: TOKEN };

const fixtures = readdirSync(DIR)
  .filter((n) => /^(0[1-8]|34)-.*\.json$/.test(n))
  .map((n) => JSON.parse(readFileSync(path.join(DIR, n), "utf8")) as Fixture);

let rx: { url: string; close: () => Promise<void> };
beforeAll(async () => {
  rx = await fakeReceiver(SECRET);
});
afterAll(() => rx.close());

describe("conformance/delivery through the HTTP sink", () => {
  it("covers the nine sender scenarios of HTTP.md §7", () => {
    expect(fixtures.map((f) => f.name)).toEqual([
      "accept",
      "dedup",
      "oversize",
      "tier",
      "protocol",
      "auth",
      "unknown-type",
      "forget",
      "auth-signed",
    ]);
  });

  // The receiver here verifies signatures with the sink's secret, so `skip_when: "no secret"`
  // never applies.
  it.each(fixtures)("$name ($spec)", async (fx) => {
    const skip = /^max_tier == (\d)$/.exec(fx.skip_when ?? "");
    if (skip && Number(skip[1]) === MAX_TIER) return;
    if (fx.capability && !CAPABILITIES.includes(fx.capability)) return;
    const run = ulid().slice(-8).toLowerCase();
    for (const step of fx.steps) {
      if (step.read) {
        const session = resolve(step.read.session, run) as string;
        const r = await fetch(`${rx.url}/api/sessionpipe/v1/sessions/${encodeURIComponent(session)}`);
        expect(r.status).toBe(step.expect.status);
        continue;
      }
      const send = step.send as NonNullable<Step["send"]>;
      // `headers` cannot be driven through the sink: it pins `sessionpipe-protocol: 1`.
      // The fixture's events carry the foreign protocol too, and that is what refuses.
      const events = (resolve(send.events, run) as Record<string, unknown>[]).map(fill);
      const sink = new HttpSink({ name: fx.name, url: rx.url, tier: 3, ...credentials(send.auth) }, 3);
      const res = await sink.send(events);
      expect(res.status).toBe(step.expect.status);
      const check = SENDER[step.expect.status];
      expect(check, `no sender rule for ${step.expect.status}`).toBeDefined();
      check?.(res, events.length, resolve(step.expect.body, run) as Record<string, unknown> | undefined);
    }
  });

  it("auth-signed, at a receiver that knows only tokens or with another secret: 401, and the sink pauses", async () => {
    const plain = await fakeReceiver();
    try {
      const fx = fixtures.find((f) => f.name === "auth-signed") as Fixture;
      const send = fx.steps[0]?.send as NonNullable<Step["send"]>;
      const other = `whsec_${Buffer.from("another_secret").toString("base64")}`;
      for (const [url, secret] of [
        [plain.url, SECRET],
        [rx.url, other],
      ] as const) {
        const events = (resolve(send.events, ulid().slice(-8).toLowerCase()) as Record<string, unknown>[]).map(fill);
        const res = await new HttpSink({ name: fx.name, url, tier: 3, secret }, 3).send(events);
        expect(res.status).toBe(401);
        SENDER[401]?.(res, events.length);
      }
    } finally {
      await plain.close();
    }
  });

  it("oversize, through the drain: 51 events go as 50 + 1, and one event over max_bytes is dropped", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "sp-fx-"));
    try {
      const run = ulid().slice(-8).toLowerCase();
      const outbox = new Outbox(tmp);
      const fx = fixtures.find((f) => f.name === "oversize") as Fixture;
      const many = resolve(fx.steps[0]?.send?.events, run) as Event[];
      const fat = resolve(fx.steps[1]?.send?.events, run) as Event[];
      const ref = { harness: "conformance", session: `conf-${run}` };
      outbox.append(ref, [...many, ...fat.map((e) => ({ ...e, session: { ...e.session, seq: many.length } }))]);
      // At the receiver's max_tier: the filter stamps the sink's tier on every event.
      const cfg = [{ name: "fx", url: rx.url, tier: MAX_TIER as 2, token: TOKEN }];
      expect((await flush(tmp, cfg, outbox)).fx).toBe(many.length + 1);
      expect(new Cursors(tmp, "fx").read()[`conformance/conf-${run}`]).toBe(statSync(outbox.file(ref)).size);
      const r = await fetch(`${rx.url}/api/sessionpipe/v1/sessions/${encodeURIComponent(`conformance:conf-${run}`)}`);
      expect(await r.json()).toMatchObject({ events: many.length });
      expect(readFileSync(path.join(tmp, "log"), "utf8")).toMatch(/too large alone, dropped/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
