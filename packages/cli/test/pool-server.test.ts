// SPDX-License-Identifier: Apache-2.0
// The loopback listener against a real node:http fake upstream: the bearer check, the
// body cap, the rewrite, headers through (limit headers included, hop-by-hop not), a
// 429 and a `rejected` retried once on the next account, a 5xx passed through with a
// rest, a 401 on a fresh and on a stale token, slow SSE streamed as it arrives, a
// client that leaves, a 10 MiB body, no account with room, no account at all, a port
// that is taken, and logs with no secret in them.
import http from "node:http";
import type net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Credentials } from "../src/pool/credentials.js";
import { type AccountState, HOLD_MS, type PolicyState } from "../src/pool/policy.js";
import {
  BODY_CAP,
  bearerOk,
  hostOk,
  type PoolServer,
  type PoolServerDeps,
  startPoolServer,
  upstreamUrl,
} from "../src/pool/server.js";
import type { PoolCredential, PoolLimits } from "../src/pool/types.js";
import { body, credential, FakeAuthError, fakeAdapter, uuidOf } from "./helpers/pool-fake.js";

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) => void;
interface Upstream {
  url: string;
  seen: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string; closed: boolean }[];
  handler: Handler;
  close(): Promise<void>;
}

function upstream(): Promise<Upstream> {
  const u: Upstream = { url: "", seen: [], handler: () => {}, close: async () => {} };
  const s = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const rec = {
        method: req.method!,
        url: req.url!,
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
        closed: false,
      };
      u.seen.push(rec);
      res.on("close", () => {
        rec.closed = !res.writableFinished;
      });
      u.handler(req, res, Buffer.concat(chunks));
    });
  });
  return new Promise((r) =>
    s.listen(0, "127.0.0.1", () => {
      u.url = `http://127.0.0.1:${(s.address() as net.AddressInfo).port}`;
      u.close = () =>
        new Promise((d) => {
          s.closeAllConnections();
          s.close(() => d());
        });
      r(u);
    }),
  );
}

const json = (res: http.ServerResponse, status: number, headers: Record<string, string>, o: unknown) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(o));
};
const limitHeaders = (used5h: number, resetIn = 3600, status = "allowed") => ({
  "anthropic-ratelimit-unified-status": status,
  "anthropic-ratelimit-unified-5h-utilization": String(used5h),
  "anthropic-ratelimit-unified-5h-reset": String(Math.floor(T0 / 1000) + resetIn),
  "anthropic-ratelimit-unified-7d-utilization": "0.2",
});

const T0 = Date.parse("2026-10-29T10:00:00Z");
const TOKEN = "pool-bearer-token-xyz";
const S1 = "aaaaaaaa-0000-4000-8000-000000000001";
const S2 = "aaaaaaaa-0000-4000-8000-000000000002";

let up: Upstream;
let srv: PoolServer | null;
let now: number;
let state: PolicyState;
let logs: string[];
let limits: { id: string; session: string | null; limits: PoolLimits }[];
let standing: number;
let persisted: number;
let creds: Map<string, PoolCredential>;
let credentials: Credentials;
let on: boolean;
const adapter = fakeAdapter();

const acct = (id: string, over: Partial<AccountState> = {}): AccountState => ({ id, enabled: true, ...over });

async function start(over: Partial<PoolServerDeps> = {}): Promise<PoolServer> {
  srv = await startPoolServer({
    adapter,
    fetch: globalThis.fetch,
    now: () => now,
    log: (l) => logs.push(l),
    port: 0,
    token: () => TOKEN,
    on: () => on,
    state,
    accountUuid: (id) => (id === "noid" ? null : uuidOf(id)),
    credentials,
    persist: () => persisted++,
    onLimits: (id, session, l) => limits.push({ id, session, limits: l }),
    onStanding: () => standing++,
    upstream: up.url,
    ...over,
  });
  return srv;
}

const send = (path: string, init: RequestInit & { token?: string | null } = {}) =>
  fetch(`http://127.0.0.1:${srv!.port}${path}`, {
    method: init.method ?? "POST",
    headers: {
      "content-type": "application/json",
      ...(init.token === null ? {} : { authorization: `Bearer ${init.token ?? TOKEN}` }),
      ...(init.headers as Record<string, string>),
    },
    ...(init.body !== undefined ? { body: init.body } : {}),
  });

/** A request-target or Host sent as written, which fetch would never do. */
const raw = (o: { path: string; method?: string; host?: string; token?: string | null; big?: number }) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: srv!.port,
        method: o.method ?? "POST",
        path: o.path,
        headers: {
          ...(o.host !== undefined ? { host: o.host } : {}),
          ...(o.token === null ? {} : { authorization: `Bearer ${o.token ?? TOKEN}` }),
          "content-type": "application/json",
        },
      },
      (res) => {
        let text = "";
        res.on("data", (c) => {
          text += c;
        });
        res.on("end", () => resolve({ status: res.statusCode as number, body: text }));
      },
    );
    req.on("error", reject);
    req.end(o.method === "GET" ? undefined : body(S1, uuidOf("own"), o.big ? { pad: "x".repeat(o.big) } : {}));
  });

beforeEach(async () => {
  up = await upstream();
  now = T0;
  on = true;
  logs = [];
  limits = [];
  standing = 0;
  persisted = 0;
  state = { accounts: [acct("a"), acct("b"), acct("c")], pins: {} };
  creds = new Map([
    ["a", credential("a", 3_600_000, T0)],
    ["b", credential("b", 3_600_000, T0)],
    ["c", credential("c", 3_600_000, T0)],
  ]);
  credentials = new Credentials({
    now: () => now,
    load: (id) => creds.get(id) ?? null,
    save: (id, c) => {
      creds.set(id, c);
      return true;
    },
    refresh: (c) => adapter.refreshCredential(c, globalThis.fetch, () => now),
    isAuthError: (e) => e instanceof FakeAuthError,
    log: (l) => logs.push(l),
  });
  adapter.refresh = async (c, t) => ({ ...c, access: `${c.access}+`, expires_at: t + 3_600_000 });
  up.handler = (_req, res) => json(res, 200, limitHeaders(0.1), { id: "msg_1", content: [] });
});
afterEach(async () => {
  await srv?.close();
  srv = null;
  await up.close();
});

describe("the front door", () => {
  it("/health needs no bearer and counts the accounts with room; everything else does", async () => {
    await start();
    state.accounts[1]!.hold_until = now + 1;
    const h = await send("/health", { method: "GET", token: null });
    expect(h.status).toBe(200);
    expect(await h.json()).toEqual({ ok: true, on: true, accounts_with_room: 2 });
    on = false;
    expect(((await (await send("/health?x=1", { method: "GET", token: null })).json()) as { on: boolean }).on).toBe(
      false,
    );
    for (const token of [null, "", "wrong", `${TOKEN}x`, TOKEN.slice(1)]) {
      const r = await send("/v1/messages", { token, body: "{}" });
      expect(r.status).toBe(401);
      expect(await r.json()).toMatchObject({ type: "error", error: { type: "authentication_error" } });
    }
    expect(up.seen).toEqual([]);
    expect(bearerOk("bearer " + TOKEN, TOKEN)).toBe(true);
    expect(bearerOk("Basic abc", TOKEN)).toBe(false);
    expect(bearerOk(undefined, TOKEN)).toBe(false);
  });
  it("a body over the cap is a 413 before anything goes upstream; a 10 MiB one goes through", async () => {
    await start({ bodyCap: 1024 });
    const r = await send("/v1/messages", { body: body(S1, uuidOf("own"), { pad: "x".repeat(2048) }) });
    expect(r.status).toBe(413);
    expect(await r.json()).toMatchObject({ error: { type: "request_too_large" } });
    expect(up.seen).toEqual([]);
    await srv!.close();
    srv = null;
    await start();
    expect(BODY_CAP).toBe(32 * 1024 * 1024);
    const big = body(S1, uuidOf("own"), { pad: "y".repeat(10 * 1024 * 1024) });
    const ok = await send("/v1/messages", { body: big });
    expect(ok.status).toBe(200);
    expect(up.seen[0]!.body.length).toBeGreaterThan(10 * 1024 * 1024);
  });
});

describe("forwarding", () => {
  it("rewrites the bearer, the account and the beta header; copies status and headers back minus hop-by-hop", async () => {
    await start();
    up.handler = (_req, res) => {
      res.writeHead(201, {
        ...limitHeaders(0.42, 1800, "allowed_warning"),
        "request-id": "req_1",
        "content-encoding": "identity",
        connection: "keep-alive",
        "transfer-encoding": "chunked",
      });
      res.end('{"ok":true}');
    };
    const r = await send("/v1/messages?beta=true", {
      body: body(S1),
      headers: { "x-app": "claude-cli", "anthropic-version": "2023-06-01" },
    });
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ ok: true });
    expect(r.headers.get("request-id")).toBe("req_1");
    expect(r.headers.get("anthropic-ratelimit-unified-5h-utilization")).toBe("0.42");
    expect(r.headers.get("anthropic-ratelimit-unified-status")).toBe("allowed_warning");
    expect(r.headers.get("content-encoding")).toBeNull();
    const seen = up.seen[0]!;
    expect(seen.method).toBe("POST");
    expect(seen.url).toBe("/v1/messages?beta=true");
    expect(seen.headers.authorization).toBe("Bearer access-a");
    expect(seen.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(seen.headers["x-app"]).toBe("claude-cli");
    expect(JSON.parse(seen.body).metadata.user_id).toBe(`user_abc123_account_${uuidOf("a")}_session_${S1}`);
    expect(limits).toEqual([
      {
        id: "a",
        session: S1,
        limits: {
          status: "allowed_warning",
          observed_at: T0,
          windows: [
            expect.objectContaining({ id: "five_hour", used_percent: 42 }),
            { id: "seven_day", used_percent: 20 },
          ],
        },
      },
    ]);
    expect(state.pins[S1]).toEqual({ account: "a", used: T0 });
    expect(persisted).toBe(1);
    expect(srv!.stats).toMatchObject({ requests: 1, upstream: 1, retries: 0, refused: 0 });
    // The same numbers again change nothing; a request with no session pins nothing,
    // and numbers that changed on it are reported with no session.
    await send("/v1/messages", { body: body(S2) });
    up.handler = (_req, res) => json(res, 200, limitHeaders(0.5), {});
    await send("/v1/messages", { body: "not json" });
    up.handler = (_req, res) => {
      res.writeHead(204, limitHeaders(0.5));
      res.end();
    };
    expect((await send("/v1/models", { method: "GET" })).status).toBe(204);
    expect(limits.length).toBe(2);
    expect(limits[1]).toMatchObject({ id: "a", session: null });
    expect(Object.keys(state.pins)).toEqual([S1, S2]);
    expect(up.seen[2]!.body).toBe("not json");
    expect(up.seen[3]).toMatchObject({ method: "GET", url: "/v1/models", body: "" });
    for (const l of logs) expect(l).not.toMatch(/access-|refresh-|pool-bearer/);
    expect(logs.some((l) => /^a: POST \/v1\/messages → 201 in \d+ ms \(session aaaaaaaa\)$/.test(l))).toBe(true);
    expect(logs.some((l) => l.endsWith("(session -)"))).toBe(true);
  });
  it("a pinned session stays on its account; a 429 moves it once and holds the account until Retry-After", async () => {
    await start();
    state.pins[S1] = { account: "b", used: T0 };
    let calls = 0;
    up.handler = (req, res) => {
      calls++;
      if (req.headers.authorization === "Bearer access-b")
        return json(
          res,
          429,
          { "retry-after": "120", ...limitHeaders(1, 120, "rejected") },
          { type: "error", error: { type: "rate_limit_error", message: "upstream says no" } },
        );
      json(res, 200, limitHeaders(0.3), { id: "ok" });
    };
    const r = await send("/v1/messages", { body: body(S1) });
    expect(r.status).toBe(200);
    expect(calls).toBe(2);
    expect(up.seen.map((s) => s.headers.authorization)).toEqual(["Bearer access-b", "Bearer access-a"]);
    expect(state.accounts[1]!.hold_until).toBe(T0 + 120_000);
    expect(state.pins[S1]).toEqual({ account: "a", used: T0 });
    expect(srv!.stats.retries).toBe(1);
    expect(standing).toBe(1);
    expect(logs).toContain("b: 429 (rejected); trying a");
    // Everyone 429s: the second answer passes through unchanged, no third try.
    up.handler = (_req, res) =>
      json(res, 429, { "retry-after": "5" }, { type: "error", error: { type: "rate_limit_error", message: "no" } });
    up.seen.length = 0;
    const r2 = await send("/v1/messages", { body: body(S2) });
    expect(r2.status).toBe(429);
    expect(await r2.json()).toEqual({ type: "error", error: { type: "rate_limit_error", message: "no" } });
    expect(up.seen.map((s) => s.headers.authorization)).toEqual(["Bearer access-a", "Bearer access-c"]);
    expect(state.accounts.map((a) => a.hold_until)).toEqual([T0 + 5_000, T0 + 120_000, T0 + 5_000]);
  });
  it("a `rejected` status on a 200 is treated like a 429 (a reset from the headers, no Retry-After)", async () => {
    await start();
    up.handler = (req, res) =>
      req.headers.authorization === "Bearer access-a"
        ? json(res, 200, limitHeaders(0.99, 600, "rejected"), { id: "late" })
        : json(res, 200, limitHeaders(0.1), { id: "fine" });
    const r = await send("/v1/messages", { body: body(S1) });
    expect(await r.json()).toEqual({ id: "fine" });
    expect(state.accounts[0]!.hold_until).toBe(T0 + 600_000);
    expect(state.pins[S1]!.account).toBe("b");
  });
  it("a 5xx passes through and rests the account a minute", async () => {
    await start();
    up.handler = (_req, res) =>
      json(res, 503, {}, { type: "error", error: { type: "overloaded_error", message: "busy" } });
    const r = await send("/v1/messages", { body: body(S1) });
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ error: { type: "overloaded_error" } });
    expect(up.seen.length).toBe(1);
    expect(state.accounts[0]!.hold_until).toBe(T0 + HOLD_MS);
    expect(state.accounts[1]!.hold_until).toBeUndefined();
  });
  it("a 401 on a token that wasn't fresh refreshes it and retries the same account once", async () => {
    await start();
    up.handler = (req, res) =>
      req.headers.authorization === "Bearer access-a"
        ? json(res, 401, {}, { type: "error", error: { type: "authentication_error", message: "expired" } })
        : json(res, 200, {}, { id: "ok" });
    const r = await send("/v1/messages", { body: body(S1) });
    expect(r.status).toBe(200);
    expect(up.seen.map((s) => s.headers.authorization)).toEqual(["Bearer access-a", "Bearer access-a+"]);
    expect(state.accounts[0]!.hold_until).toBeUndefined();
    expect(state.pins[S1]!.account).toBe("a");
  });
  it("a 401 on a fresh token is the upstream's trouble: a minute's rest, next account", async () => {
    creds.set("a", credential("a", 60_000, T0));
    await start();
    up.handler = (req, res) =>
      req.headers.authorization === "Bearer access-a+"
        ? json(res, 403, {}, { type: "error", error: { type: "permission_error", message: "no" } })
        : json(res, 200, {}, { id: "ok" });
    const r = await send("/v1/messages", { body: body(S1) });
    expect(r.status).toBe(200);
    expect(up.seen.map((s) => s.headers.authorization)).toEqual(["Bearer access-a+", "Bearer access-b"]);
    expect(state.accounts[0]!.hold_until).toBe(T0 + HOLD_MS);
    expect(state.accounts[0]!.error).toBeUndefined();
  });
  it("a refresh the vendor refuses after a 401 puts the account in error and moves on; a second 401 passes through", async () => {
    await start();
    adapter.refresh = async () => {
      throw new FakeAuthError("invalid_grant");
    };
    up.handler = (req, res) =>
      req.headers.authorization === "Bearer access-a"
        ? json(res, 401, {}, { type: "error", error: { type: "authentication_error", message: "a" } })
        : json(res, 200, {}, { id: "ok" });
    expect((await send("/v1/messages", { body: body(S1) })).status).toBe(200);
    expect(state.accounts[0]!.error).toBe("sign in again");
    expect(state.pins[S1]!.account).toBe("b");
    up.handler = (_req, res) =>
      json(res, 401, {}, { type: "error", error: { type: "authentication_error", message: "all" } });
    adapter.refresh = async (c) => ({ ...c, access: `${c.access}+` });
    const r = await send("/v1/messages", { body: body(S2) });
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({ error: { message: "all" } });
    // b: 401 → refreshed → same account again → 401 again → passes through; c never asked.
    expect(up.seen.slice(2).map((s) => s.headers.authorization)).toEqual(["Bearer access-b", "Bearer access-b+"]);
    // A refresh that fails some other way: the stale token is sent again, once.
    adapter.refresh = async () => {
      throw new Error("503");
    };
    up.handler = (req, res) => json(res, req.headers.authorization === "Bearer access-c" ? 401 : 200, {}, {});
    state.pins[S2] = { account: "c", used: T0 };
    expect((await send("/v1/messages", { body: body(S2) })).status).toBe(401);
    expect(up.seen.slice(-2).map((s) => s.headers.authorization)).toEqual(["Bearer access-c", "Bearer access-c"]);
    // ...unless it has run out by then: the next account, no error on this one.
    for (const a of state.accounts) {
      delete a.error;
      delete a.hold_until;
    }
    creds.set("a", credential("a", 5_000, T0));
    credentials.forget("a");
    up.handler = (req, res) => {
      if (req.headers.authorization === "Bearer access-a") {
        now += 10_000;
        return json(res, 401, {}, {});
      }
      json(res, 200, {}, { id: "b-served" });
    };
    const r3 = await send("/v1/messages", { body: body("bbbbbbbb-0000-4000-8000-000000000003") });
    expect(await r3.json()).toEqual({ id: "b-served" });
    expect(state.accounts[0]!.error).toBeUndefined();
    expect(up.seen.slice(-2).map((s) => s.headers.authorization)).toEqual(["Bearer access-a", "Bearer access-b+"]);
  });
  it("an account whose credential can't be read, or whose uuid is unknown, is skipped", async () => {
    creds.delete("a");
    state.accounts.splice(1, 0, acct("noid"));
    creds.set("noid", credential("noid"));
    await start();
    const r = await send("/v1/messages", { body: body(S1) });
    expect(r.status).toBe(200);
    expect(up.seen.map((s) => s.headers.authorization)).toEqual(["Bearer access-b"]);
    expect(logs.slice(0, 2)).toEqual([
      "a: skipped — no credential readable for this account",
      "noid: skipped — no account uuid on record",
    ]);
    expect(srv!.stats.retries).toBe(0);
  });
  it("a credential whose refresh is refused on the way in marks the account and tells the daemon", async () => {
    creds.set("a", credential("a", 1_000, T0));
    adapter.refresh = async () => {
      throw new FakeAuthError("revoked");
    };
    await start();
    expect((await send("/v1/messages", { body: body(S1) })).status).toBe(200);
    expect(state.accounts[0]!.error).toBe("sign in again");
    expect(standing).toBe(1);
    expect(up.seen[0]!.headers.authorization).toBe("Bearer access-b");
  });
});

describe("streaming", () => {
  it("SSE chunks arrive as the upstream writes them, not at the end", async () => {
    await start();
    let release: () => void = () => {};
    up.handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream", ...limitHeaders(0.5) });
      res.write("event: message_start\ndata: {}\n\n");
      release = () => {
        res.write("event: message_stop\ndata: {}\n\n");
        res.end();
      };
    };
    const r = await send("/v1/messages", { body: body(S1, uuidOf("own"), { stream: true }) });
    expect(r.headers.get("content-type")).toBe("text/event-stream");
    const reader = r.body!.getReader();
    const first = await reader.read();
    expect(Buffer.from(first.value!).toString()).toContain("message_start");
    release();
    let rest = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += Buffer.from(value).toString();
    }
    expect(rest).toContain("message_stop");
  });
  it("a 429 after the first byte is never retried: the stream is the answer", async () => {
    await start();
    up.handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream", ...limitHeaders(1, 60, "rejected") });
      res.end("event: error\ndata: {}\n\n");
    };
    // Headers say rejected before the body: the retry happens; both accounts answer the same.
    const r = await send("/v1/messages", { body: body(S1) });
    expect(r.status).toBe(200);
    expect(up.seen.length).toBe(2);
    expect(await r.text()).toContain("event: error");
  });
  it("when the client leaves mid-stream the upstream request is aborted", async () => {
    await start();
    let upstreamClosed = () => {};
    const closed = new Promise<void>((r) => {
      upstreamClosed = r;
    });
    up.handler = (req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: 1\n\n");
      const t = setInterval(() => res.write("data: tick\n\n"), 5);
      req.on("close", () => {
        clearInterval(t);
        upstreamClosed();
      });
    };
    await new Promise<void>((resolve) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: srv!.port,
          method: "POST",
          path: "/v1/messages",
          headers: { authorization: `Bearer ${TOKEN}` },
        },
        (res) => {
          res.once("data", () => {
            req.destroy();
            resolve();
          });
        },
      );
      req.on("error", () => {});
      req.end(body(S1));
    });
    await closed;
    for (let i = 0; i < 50 && !up.seen[0]!.closed; i++) await new Promise((r) => setTimeout(r, 20));
    expect(srv!.stats.aborted).toBe(1);
    expect(up.seen[0]!.closed).toBe(true);
  });
});

describe("nothing with room", () => {
  it("passes the upstream's own answer through on the session's account, else the first that can be asked", async () => {
    await start();
    const full = { windows: [{ id: "five_hour", used_percent: 100, resets_at: new Date(T0 + 60_000).toISOString() }] };
    for (const a of state.accounts) a.limits = full;
    state.pins[S1] = { account: "c", used: T0 };
    up.handler = (_req, res) =>
      json(
        res,
        429,
        { "retry-after": "30" },
        { type: "error", error: { type: "rate_limit_error", message: "upstream's own words" } },
      );
    const r = await send("/v1/messages", { body: body(S1) });
    expect(r.status).toBe(429);
    expect(await r.json()).toMatchObject({ error: { message: "upstream's own words" } });
    expect(up.seen.map((s) => s.headers.authorization)).toEqual(["Bearer access-c", "Bearer access-a"]);
    expect(srv!.stats.refused).toBe(0);
    // The 429s just taken hold c and a for 30 s: now only b can be asked.
    for (const a of state.accounts) {
      delete a.hold_until;
      delete a.hold_at;
    }
    up.seen.length = 0;
    state.accounts[0]!.enabled = false;
    expect((await send("/v1/messages", { body: body(S2) })).status).toBe(429);
    expect(up.seen.map((s) => s.headers.authorization)).toEqual(["Bearer access-b", "Bearer access-c"]);
    for (const a of state.accounts) {
      delete a.hold_until;
      delete a.hold_at;
    }
    up.seen.length = 0;
    expect((await send("/v1/messages", { body: "no session here" })).status).toBe(429);
    expect(up.seen.map((s) => s.headers.authorization)).toEqual(["Bearer access-b", "Bearer access-c"]);
    // One account only: its 429 is the answer, nobody else to try.
    state.accounts = [acct("a", { limits: full })];
    up.seen.length = 0;
    expect((await send("/v1/messages", { body: body(S1) })).status).toBe(429);
    expect(up.seen.length).toBe(1);
    expect(srv!.stats.refused).toBe(0);
  });
  it("a client that cuts the request body short gets nothing and costs nothing upstream", async () => {
    await start();
    await new Promise<void>((resolve) => {
      const req = http.request({
        host: "127.0.0.1",
        port: srv!.port,
        method: "POST",
        path: "/v1/messages",
        headers: { authorization: `Bearer ${TOKEN}`, "content-length": "100000" },
      });
      req.on("error", () => {});
      req.write('{"partial":');
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 20);
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(up.seen).toEqual([]);
    expect(srv!.stats.upstream).toBe(0);
  });
  it("answers itself, in Anthropic's error shape, when no account can even be tried", async () => {
    await start();
    state.accounts[0]!.enabled = false;
    state.accounts[1]!.error = "sign in again";
    state.accounts[2]!.hold_until = T0 + 90_000;
    state.accounts[2]!.hold_at = T0;
    state.accounts[2]!.hold_why = "limit";
    const r = await send("/v1/messages", { body: body(S1) });
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("90");
    expect(await r.json()).toEqual({
      type: "error",
      error: {
        type: "rate_limit_error",
        message: `sessionpipe pool: no account has room until ${new Date(T0 + 90_000).toISOString()}`,
      },
    });
    expect(up.seen).toEqual([]);
    expect(srv!.stats.refused).toBe(1);
    state.accounts = [];
    const r2 = await send("/v1/messages", { body: body(S1) });
    expect(r2.headers.get("retry-after")).toBe("60");
    expect(((await r2.json()) as { error: { message: string } }).error.message).toBe(
      "sessionpipe pool: no account has room until an account is signed in",
    );
    expect(logs).toContain("no account could be tried (session aaaaaaaa)");
  });
  it("an upstream that can't be reached: the next account, then a 502 of our own", async () => {
    const dead = await upstream();
    await dead.close();
    await start({ upstream: dead.url });
    const r = await send("/v1/messages", { body: body(S1) });
    expect(r.status).toBe(502);
    expect(await r.json()).toMatchObject({ error: { type: "api_error" } });
    expect(srv!.stats).toMatchObject({ upstream: 2, retries: 1 });
    expect(state.accounts[0]!.hold_until).toBe(T0 + HOLD_MS);
    expect(state.accounts[1]!.hold_until).toBe(T0 + HOLD_MS);
    expect(state.accounts[2]!.hold_until).toBeUndefined();
    expect(logs.filter((l) => /upstream unreachable/.test(l)).length).toBe(2);
  });
  it("a client that leaves while the upstream is being connected is simply dropped", async () => {
    await start({
      fetch: ((_u: string, init: RequestInit) =>
        new Promise((_r, reject) => {
          init.signal!.addEventListener("abort", () => reject(new Error("aborted")));
        })) as typeof fetch,
    });
    await new Promise<void>((resolve) => {
      const req = http.request({
        host: "127.0.0.1",
        port: srv!.port,
        method: "POST",
        path: "/v1/messages",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      req.on("error", () => {});
      req.end(body(S1));
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 30);
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(srv!.stats).toMatchObject({ upstream: 1, retries: 0, aborted: 1 });
    expect(state.accounts[0]!.hold_until).toBeUndefined();
  });
  it("a failure inside the engine is a 502 before headers, a cut connection after", async () => {
    await start({
      adapter: {
        ...adapter,
        parseUserId: () => {
          throw new Error("boom");
        },
      },
    });
    const r = await send("/v1/messages", { body: body(S1) });
    expect(r.status).toBe(502);
    expect(logs).toContain("request failed: boom");
    expect(persisted).toBe(1);
    await srv!.close();
    srv = null;
    await start({
      fetch: (() => Promise.reject("no fetch")) as unknown as typeof fetch,
    });
    expect((await send("/v1/messages", { body: body(S1) })).status).toBe(502);
    expect(logs.filter((l) => l.endsWith("upstream unreachable — no fetch")).length).toBe(2);
    await srv!.close();
    srv = null;
    let bodies = 0;
    const fakeBody = {
      [Symbol.asyncIterator]: async function* () {
        bodies++;
        yield Buffer.from("x");
        throw new Error("mid-stream");
      },
    };
    await start({
      fetch: (async () =>
        new Proxy(new Response("x"), {
          get: (t, k) => (k === "body" ? fakeBody : Reflect.get(t, k)),
        })) as unknown as typeof fetch,
    });
    await expect(send("/v1/messages", { body: body(S1) }).then((r) => r.text())).rejects.toThrow();
    expect(bodies).toBe(1);
  });
});

describe("the port", () => {
  it("takes the remembered port, or a free one when it is taken or unset, and says so", async () => {
    const first = await start();
    expect(first.moved).toBe(true);
    const taken = first.port;
    const second = await startPoolServer({
      adapter,
      fetch: globalThis.fetch,
      now: () => now,
      log: (l) => logs.push(l),
      port: taken,
      token: () => TOKEN,
      on: () => on,
      state,
      accountUuid: () => null,
      credentials,
      persist: () => {},
      onLimits: () => {},
    });
    expect(second.moved).toBe(true);
    expect(second.port).not.toBe(taken);
    expect(logs).toContain(`port ${taken} is taken; picking another`);
    await second.close();
    await first.close();
    srv = null;
    const third = await start({ port: taken });
    expect(third).toMatchObject({ port: taken, moved: false });
    await expect(start({ port: 1 })).rejects.toThrow(/EACCES|EADDRINUSE|listen/);
    srv = third;
  });
});

describe("the security review's findings", () => {
  it("H2/M5: only plain paths under /v1/ and /api/ are proxied; the rest is refused and rests nobody", async () => {
    await start();
    for (const [path, status] of [
      ["/api/oauth/claude_cli/create_api_key", 403],
      ["/api/oauth/organizations/org_1/payment_method", 403],
      ["/api/oauth/organizations/org_1/billing/x", 403],
      ["/v1/oauth/token", 403],
      ["/v1/messages/../../api/oauth/claude_cli/create_api_key", 403],
      ["/v2/messages", 400],
      ["/", 400],
      ["/v1", 400],
      ["/v1/messages/../../etc/passwd", 400],
      ["http://evil.example/steal", 400],
      ["//evil.example/v1/messages", 400],
      ["*", 400],
    ] as const) {
      const r = await raw({ path, method: path === "*" ? "OPTIONS" : "POST" });
      expect([path, r.status]).toEqual([path, status]);
      expect(JSON.parse(r.body)).toMatchObject({
        type: "error",
        error: { type: status === 403 ? "permission_error" : "invalid_request_error" },
      });
    }
    expect(up.seen).toEqual([]);
    expect(srv!.stats.upstream).toBe(0);
    expect(state.accounts.every((a) => a.hold_until === undefined)).toBe(true);
    expect(logs.some((l) => /unreachable/.test(l))).toBe(false);
    // The reads Claude Code's own footer makes stay proxied; dot segments are folded first.
    expect((await send("/api/oauth/usage", { method: "GET" })).status).toBe(200);
    expect((await send("/v1/messages/../models?x=1", { method: "GET" })).status).toBe(200);
    expect(up.seen.map((x) => x.url)).toEqual(["/api/oauth/usage", "/v1/models?x=1"]);
    expect(upstreamUrl("/v1/messages?beta=1", "https://api.anthropic.com")).toEqual({
      url: "https://api.anthropic.com/v1/messages?beta=1",
    });
    expect(upstreamUrl("/v1/messages#frag", "https://api.anthropic.com")).toEqual({
      url: "https://api.anthropic.com/v1/messages",
    });
  });
  it("L4: a Host that isn't this loopback is turned away before anything else, /health included", async () => {
    await start();
    const r = await raw({ path: "/health", method: "GET", host: "evil.example", token: null });
    expect(r.status).toBe(421);
    expect(JSON.parse(r.body)).toMatchObject({ error: { type: "invalid_request_error" } });
    for (const host of [`localhost:${srv!.port}`, `127.0.0.1:${srv!.port}`, "localhost", "127.0.0.1"])
      expect((await raw({ path: "/health", method: "GET", host, token: null })).status).toBe(200);
    for (const host of [`127.0.0.1:${srv!.port + 1}`, "127.0.0.1.evil.example", "evil.example:1"])
      expect((await raw({ path: "/health", method: "GET", host, token: null })).status).toBe(421);
    expect((await raw({ path: "/v1/messages", host: "evil.example" })).status).toBe(421);
    expect(up.seen).toEqual([]);
    expect(hostOk(undefined, 1)).toBe(false);
    expect(hostOk("LOCALHOST:1", 1)).toBe(true);
  });
  it("M2: while the pool is off no request is served and no credential is touched; /health still answers", async () => {
    await start();
    on = false;
    const r = await send("/v1/messages", { body: body(S1) });
    expect(r.status).toBe(503);
    expect(r.headers.get("retry-after")).toBe("60");
    expect(await r.json()).toMatchObject({ error: { type: "api_error", message: /pool is off/ } });
    expect(up.seen).toEqual([]);
    expect(srv!.stats.upstream).toBe(0);
    expect((await send("/health", { method: "GET", token: null })).status).toBe(200);
    on = true;
    expect((await send("/v1/messages", { body: body(S1) })).status).toBe(200);
  });
  it("H1: the bearer is read on every request, so one minted by `pool on` elsewhere works at once", async () => {
    let current = TOKEN;
    await start({ token: () => current });
    expect((await send("/v1/messages", { body: body(S1) })).status).toBe(200);
    current = "rotated-bearer";
    expect((await send("/v1/messages", { body: body(S1) })).status).toBe(401);
    expect((await send("/v1/messages", { body: body(S1), token: "rotated-bearer" })).status).toBe(200);
  });
  it("M4: pins are kept only for uuid-shaped sessions", async () => {
    await start();
    const odd = JSON.stringify({
      metadata: { user_id: '{"account_uuid":"' + uuidOf("own") + '","session_id":"not a uuid at all"}' },
    });
    expect(adapter.parseUserId(Buffer.from(odd))).toBeNull();
    await send("/v1/messages", { body: body(S1) });
    await send("/v1/messages", { body: body("anything-goes") });
    expect(Object.keys(state.pins)).toEqual([S1]);
  });
});

describe("what the soak found", () => {
  it("F3: while every account is held the pool answers its own 429 with the shortest hold; nobody upstream is asked", async () => {
    await start();
    for (const [i, a] of state.accounts.entries()) {
      a.hold_until = T0 + (i + 1) * 10_000;
      a.hold_at = T0;
      a.hold_why = "limit";
    }
    const r = await send("/v1/messages", { body: body(S1) });
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("10");
    expect(await r.json()).toMatchObject({ error: { type: "rate_limit_error", message: /no account has room until/ } });
    expect(up.seen).toEqual([]);
    expect(srv!.stats.refused).toBe(1);
    // A full window (not a hold) still lets the upstream's own words through.
    state.accounts[0]!.hold_until = T0 - 1;
    state.accounts[0]!.limits = {
      windows: [{ id: "five_hour", used_percent: 100, resets_at: new Date(T0 + 60_000).toISOString() }],
    };
    up.handler = (_req, res) =>
      json(
        res,
        429,
        { "retry-after": "7" },
        { type: "error", error: { type: "rate_limit_error", message: "vendor's words" } },
      );
    const r2 = await send("/v1/messages", { body: body(S2) });
    expect(await r2.json()).toMatchObject({ error: { message: "vendor's words" } });
    expect(up.seen.map((x) => x.headers.authorization)).toEqual(["Bearer access-a"]);
    // Accounts resting after a 5xx are asked: the upstream's own 503 is the answer.
    for (const a of state.accounts) {
      a.hold_until = T0 + 60_000;
      a.hold_at = T0;
      a.hold_why = "upstream";
      delete a.limits;
    }
    up.seen.length = 0;
    up.handler = (_req, res) =>
      json(res, 503, {}, { type: "error", error: { type: "overloaded_error", message: "busy" } });
    const r3 = await send("/v1/messages", { body: body(S2) });
    expect(r3.status).toBe(503);
    expect(up.seen.length).toBe(1);
  });
  it("F4: a refusal names the real cause: the store, the token endpoint, or nothing signed in", async () => {
    await start();
    creds.clear();
    const r = await send("/v1/messages", { body: body(S1) });
    expect(r.status).toBe(503);
    expect(r.headers.get("retry-after")).toBe("30");
    expect(await r.json()).toMatchObject({ error: { type: "api_error", message: /secrets can't be read right now/ } });
    expect(up.seen).toEqual([]);
    // Every token expired and the endpoint down: a 503 naming the endpoint, not a sign-in.
    for (const id of ["a", "b", "c"]) {
      creds.set(id, credential(id, -1_000, T0));
      credentials.forget(id);
    }
    adapter.refresh = async () => {
      throw new Error("HTTP 503");
    };
    const r2 = await send("/v1/messages", { body: body(S1) });
    expect(r2.status).toBe(503);
    expect(await r2.json()).toMatchObject({
      error: { type: "api_error", message: "sessionpipe pool: Anthropic's token endpoint is not answering (HTTP 503)" },
    });
    expect(adapter.calls.refresh).toBeGreaterThan(0);
    const n = adapter.calls.refresh;
    // F5 through the listener: the next request inside the backoff asks the endpoint again for nobody.
    await send("/v1/messages", { body: body(S1) });
    expect(adapter.calls.refresh).toBe(n);
    expect(state.accounts.every((a) => a.error === undefined)).toBe(true);
  });
  it("F10: while the secrets store can't be read the answer is a 503 that says so, never an unknown bearer", async () => {
    let token: string | null = TOKEN;
    await start({ token: () => token });
    token = null;
    const r = await send("/v1/messages", { body: body(S1) });
    expect(r.status).toBe(503);
    expect(r.headers.get("retry-after")).toBe("30");
    expect(await r.json()).toMatchObject({ error: { type: "api_error", message: /secrets can't be read right now/ } });
    expect((await send("/v1/messages", { body: body(S1), token: "anything" })).status).toBe(503);
    expect((await send("/health", { method: "GET", token: null })).status).toBe(200);
    token = TOKEN;
    expect((await send("/v1/messages", { body: body(S1) })).status).toBe(200);
  });
  it("F8: a body over the cap gets the 413 itself, three times out of three, not a closed socket", async () => {
    await start({ bodyCap: 64 * 1024 });
    for (let i = 0; i < 3; i++) {
      const r = await raw({ path: "/v1/messages", big: 80 * 1024 }).catch((e: Error) => ({
        status: -1,
        body: e.message,
      }));
      expect([i, r.status]).toEqual([i, 413]);
    }
    expect(up.seen).toEqual([]);
    // Far past the cap: the answer still arrives, then node ends the socket.
    const far = await raw({ path: "/v1/messages", big: 512 * 1024 }).catch(() => ({ status: -1, body: "closed" }));
    expect(far.status).toBe(413);
    expect((await send("/v1/messages", { body: body(S1) })).status).toBe(200);
  });
});
