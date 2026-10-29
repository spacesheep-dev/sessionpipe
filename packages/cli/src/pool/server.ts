// SPDX-License-Identifier: Apache-2.0
// The loopback listener Claude Code is pointed at (DESIGN §2.1): 127.0.0.1, a port
// remembered in pool.json, a bearer minted once. A request is checked (constant time),
// buffered (32 MiB cap), given to the account the policy picks — its bearer in place of
// ours, `metadata.user_id` naming it, the OAuth beta header on — and forwarded with the
// same method, path and query. The answer streams back as it arrives, status and
// headers kept (the `anthropic-ratelimit-unified-*` ones included, so Claude Code's own
// footer still works), and its limit headers are read on the way. A 429 or a `rejected`
// before any byte was written sends the request again on the next account, once; after
// the first byte nothing is retried. With no account left the upstream's own answer
// passes through unchanged, so Claude Code shows its own message. The listener is
// thin: the policy decides, the adapter knows the vendor.
//
// What it refuses before any account is touched: a Host that isn't this loopback (a page
// that rebinds its name to 127.0.0.1 would otherwise read /health), a request-target
// that isn't a plain path under /v1/ or /api/ (the URL is built here, never from the
// target's own shape, so `..`, an absolute form and `*` go nowhere and rest nobody), the
// endpoints that mint keys or touch billing (the pool bearer must never become a
// permanent API key), and everything while the pool is off.
import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { retryAfterMs } from "../http-sink.js";
import type { Credentials } from "./credentials.js";
import { type AccountState, choose, observe, type PolicyState, pin, roomAt, withRoom } from "./policy.js";
import type { PoolAdapter, PoolLimits } from "./types.js";

export const BODY_CAP = 32 * 1024 * 1024;

export interface PoolServerDeps {
  adapter: Pick<PoolAdapter, "POOL_ENDPOINTS" | "readLimits" | "parseUserId" | "withAccount" | "upstreamHeaders">;
  fetch: typeof fetch;
  now: () => number;
  /** Nothing secret ever goes in: account ids, statuses, timings. */
  log: (line: string) => void;
  /** The port pool.json remembers; 0 or taken: a free one is picked. */
  port: number;
  /** The bearer Claude Code presents (settings.json); read on every request, since
   *  `pool on` mints a new one in another process. Null: the secrets store can't be
   *  read right now, which is a 503, not an unknown bearer. */
  token: () => string | null;
  on: () => boolean;
  /** Shared with the façade and mutated here through choose/observe/pin. */
  state: PolicyState;
  accountUuid: (id: string) => string | null;
  credentials: Credentials;
  /** The state changed (a pin, a hold, fresh numbers): write it down. */
  persist: () => void;
  /** An account's windows changed on a request: the daemon's `limits.observed`.
   *  `accountId` is the pool's id; the façade maps it to the account uuid. */
  onLimits: (accountId: string, session: string | null, limits: PoolLimits) => void;
  /** An account's standing changed (held, in error): the daemon sends a hello. */
  onStanding?: () => void;
  /** Where requests go (tests: the fake upstream). */
  upstream?: string;
  bodyCap?: number;
}

export interface PoolStats {
  requests: number;
  upstream: number;
  retries: number;
  /** Answered with our own 429: no account could even be tried. */
  refused: number;
  /** Requests whose client left before the answer ended. */
  aborted: number;
  /** Requests being answered right now (the daemon's busy(): never restart mid-stream). */
  in_flight: number;
}

export interface PoolServer {
  port: number;
  /** True when the port isn't the one asked for: settings.json must be rewritten. */
  moved: boolean;
  stats: PoolStats;
  close(): Promise<void>;
}

/** Headers that describe this hop, not the message; `content-encoding` and
 *  `content-length` go too because fetch already decoded the body. */
const HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-encoding",
  "content-length",
  "te",
  "trailer",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
]);

/** Paths proxied at all: Claude Code's own API and the OAuth reads its footer needs. */
const ALLOW_PATH = /^\/(v1|api)\//;
/** Never proxied: anything that mints a credential or touches money. A loopback bearer
 *  must not become a permanent key for every pooled account. */
const DENY_PATH = [
  /^\/api\/oauth\/claude_cli\/create_api_key$/,
  /create_api_key/,
  /^\/v1\/oauth\//,
  /^\/api\/oauth\/organizations\/[^/]+\/(payment_method|billing|prepaid|overage|setup_overage_billing|admin_requests)/,
];

/** The upstream URL for a request-target, or why not. Built from the parsed path, so
 *  dot segments are already folded and cannot leave the two prefixes. */
export function upstreamUrl(target: string, base: string): { url: string } | { status: 400 | 403; why: string } {
  if (!target.startsWith("/")) return { status: 400, why: "sessionpipe pool: bad request path" };
  // A path against a fixed base always parses (odd bytes are percent-encoded).
  const u = new URL(target, base);
  if (u.origin !== new URL(base).origin || !ALLOW_PATH.test(u.pathname))
    return { status: 400, why: "sessionpipe pool: path not proxied" };
  if (DENY_PATH.some((re) => re.test(u.pathname)))
    return { status: 403, why: "sessionpipe pool: that endpoint is not proxied" };
  return { url: `${u.origin}${u.pathname}${u.search}` };
}

/** The Host this loopback answers to: itself, by address or name, with its own port. */
export function hostOk(host: string | undefined, port: number): boolean {
  const m = /^(127\.0\.0\.1|localhost)(?::(\d{1,5}))?$/i.exec(host ?? "");
  return m !== null && (m[2] === undefined || Number(m[2]) === port);
}

/** A bearer compared in constant time, whatever its length: both sides are hashed first. */
export function bearerOk(header: string | undefined, token: string): boolean {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  if (!m) return false;
  const a = createHash("sha256")
    .update(m[1] as string)
    .digest();
  const b = createHash("sha256").update(token).digest();
  return timingSafeEqual(a, b);
}

const why = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const errorBody = (type: string, message: string) => JSON.stringify({ type: "error", error: { type, message } });

function sendJson(res: http.ServerResponse, status: number, body: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...extra });
  res.end(body);
}

/** The body, whole, or null once it passed the cap (a 413 was sent). The client is
 *  still writing when the cap is hit: a socket destroyed on the spot reaches it as
 *  EPIPE, not as the 413. So the answer goes out with `connection: close` and the rest
 *  is dropped; node ends the socket once the answer is flushed, and the sender stops
 *  there. */
function readBody(req: http.IncomingMessage, res: http.ServerResponse, cap: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (over) return;
      if (size > cap) {
        over = true;
        chunks.length = 0;
        sendJson(res, 413, errorBody("request_too_large", `sessionpipe pool: request body over ${cap} bytes`), {
          connection: "close",
        });
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", () => resolve(null));
  });
}

export function startPoolServer(deps: PoolServerDeps): Promise<PoolServer> {
  const stats: PoolStats = { requests: 0, upstream: 0, retries: 0, refused: 0, aborted: 0, in_flight: 0 };
  const base = (deps.upstream ?? deps.adapter.POOL_ENDPOINTS.api).replace(/\/$/, "");
  const cap = deps.bodyCap ?? BODY_CAP;
  const short = (s: string | undefined) => (s ? s.slice(0, 8) : "-");

  /** When no account has room, the account whose own answer should pass through: the
   *  session's, else the first that could be asked at all. One held by a limit (a 429's
   *  Retry-After, a `rejected`) is not asked again: the pool knows that answer and says
   *  it itself. One resting after a 5xx is asked, so the upstream's own words come
   *  through. Null: nothing to try. */
  const fallback = (session: string | undefined, tried: Set<string>): AccountState | null => {
    const now = deps.now();
    const limited = (a: AccountState) => a.hold_why === "limit" && (a.hold_until ?? 0) > now;
    const usable = (a: AccountState) => a.enabled && !a.error && !tried.has(a.id) && !limited(a);
    const p = session ? deps.state.pins[session] : undefined;
    const pinned = p && deps.state.accounts.find((a) => a.id === p.account && usable(a));
    return pinned ?? deps.state.accounts.find(usable) ?? null;
  };

  /** Why accounts were skipped on the way to a refusal, so the answer names the real
   *  cause: a store that can't be read and a token endpoint that is down are 503s
   *  (Claude Code retries those by itself); holds and nothing signed in are 429s. */
  interface Skipped {
    unreadable: number;
    upstream: string | null;
  }
  const refuse = (res: http.ServerResponse, skipped: Skipped): void => {
    stats.refused++;
    if (skipped.unreadable) {
      sendJson(
        res,
        503,
        errorBody("api_error", "sessionpipe pool: the pool's secrets can't be read right now (retrying every 30 s)"),
        { "retry-after": "30" },
      );
      return;
    }
    if (skipped.upstream !== null) {
      sendJson(
        res,
        503,
        errorBody("api_error", `sessionpipe pool: Anthropic's token endpoint is not answering (${skipped.upstream})`),
        { "retry-after": "30" },
      );
      return;
    }
    const now = deps.now();
    const ats = deps.state.accounts.map((a) => roomAt(a, now)).filter((t): t is number => t !== null);
    const at = ats.length ? Math.min(...ats) : null;
    const when = at === null ? "an account is signed in" : new Date(at).toISOString();
    const secs = at === null ? 60 : Math.max(1, Math.ceil((at - now) / 1000));
    sendJson(res, 429, errorBody("rate_limit_error", `sessionpipe pool: no account has room until ${when}`), {
      "retry-after": String(secs),
    });
  };

  async function forward(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: Buffer,
    url: string,
  ): Promise<void> {
    const session = deps.adapter.parseUserId(body)?.session;
    const tried = new Set<string>();
    const skipped: Skipped = { unreadable: 0, upstream: null };
    const started = deps.now();
    let retried = false;
    let account = choose(deps.state, { session, now: started }).account ?? fallback(session, tried);
    const next = (): AccountState | null => {
      const now = deps.now();
      return choose(deps.state, { session, now, exclude: [...tried] }).account ?? fallback(session, tried);
    };
    const ctl = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) {
        stats.aborted++;
        ctl.abort();
      }
    });
    while (account) {
      const a = account;
      tried.add(a.id);
      const uuid = deps.accountUuid(a.id);
      const cred = await deps.credentials.get(a.id);
      if (!cred.ok || !uuid) {
        if (cred.ok === false && cred.why === "sign-in") {
          observe(deps.state, a.id, { error: "sign in again" }, deps.now());
          deps.onStanding?.();
        }
        if (cred.ok === false && cred.why === "unreadable") skipped.unreadable++;
        if (cred.ok === false && cred.why === "upstream") skipped.upstream = cred.detail;
        deps.log(`${a.id}: skipped — ${cred.ok ? "no account uuid on record" : cred.detail}`);
        account = next();
        continue;
      }
      // The rewrite happens before the try: a fault of ours must not read as the
      // upstream being down and rest every account in turn.
      const hasBody = body.length > 0 && req.method !== "GET" && req.method !== "HEAD";
      const init: RequestInit = {
        method: req.method as string,
        headers: deps.adapter.upstreamHeaders(req.headers, cred.access),
        ...(hasBody ? { body: new Uint8Array(deps.adapter.withAccount(body, uuid)) } : {}),
        signal: ctl.signal,
        redirect: "manual",
      };
      let up: Response;
      try {
        stats.upstream++;
        up = await deps.fetch(url, init);
      } catch (e) {
        if (ctl.signal.aborted) return;
        observe(deps.state, a.id, { upstream5xx: true }, deps.now());
        deps.onStanding?.();
        deps.log(`${a.id}: upstream unreachable — ${why(e)}`);
        const other = retried ? null : next();
        if (other) {
          retried = true;
          stats.retries++;
          account = other;
          continue;
        }
        sendJson(res, 502, errorBody("api_error", "sessionpipe pool: the upstream could not be reached"));
        return;
      }
      const now = deps.now();
      const limits = deps.adapter.readLimits(up.headers, now);
      // Only windows make a `limits.observed` (the schema wants one); a status alone
      // still changes the account's standing.
      if (limits && observe(deps.state, a.id, limits, now)) deps.onLimits(a.id, session ?? null, limits);
      const status = up.status;
      const rejected = status === 429 || limits?.status === "rejected";
      let moveOn = false;
      if (rejected) {
        const ra = up.headers.get("retry-after");
        observe(
          deps.state,
          a.id,
          { status: 429, ...(ra !== null ? { retryAfterMs: retryAfterMs(ra, now) } : {}) },
          now,
        );
        moveOn = true;
      } else if (status === 401 || status === 403) {
        if (cred.fresh) {
          // A fresh token refused is the upstream's trouble, not a sign-out: rest 60 s.
          observe(deps.state, a.id, { upstream5xx: true }, now);
          moveOn = true;
        } else {
          const again = await deps.credentials.get(a.id, true);
          if (again.ok) {
            // Same account, new token: this is the one retry.
            tried.delete(a.id);
            moveOn = true;
          } else {
            if (again.why === "sign-in") observe(deps.state, a.id, { error: "sign in again" }, now);
            moveOn = true;
          }
        }
      } else if (status >= 500) {
        observe(deps.state, a.id, { upstream5xx: true }, now);
      }
      if (moveOn) deps.onStanding?.();
      if (moveOn && !retried) {
        const other = next();
        if (other) {
          retried = true;
          stats.retries++;
          account = other;
          deps.log(`${a.id}: ${status}${limits?.status ? ` (${limits.status})` : ""}; trying ${other.id}`);
          await up.body?.cancel();
          continue;
        }
      }
      // Pass through: this is the answer, whatever it is.
      pin(deps.state, session, a.id, now);
      const headers: Record<string, string> = {};
      up.headers.forEach((v, k) => {
        if (!HOP.has(k)) headers[k] = v;
      });
      res.writeHead(status, headers);
      try {
        if (up.body) for await (const chunk of up.body as AsyncIterable<Uint8Array>) res.write(chunk);
        res.end();
      } catch {
        // The client went away, or the upstream broke mid-stream: nothing to retry.
        res.destroy();
      }
      deps.log(
        `${a.id}: ${req.method} ${(req.url as string).split("?")[0]} → ${status} in ${deps.now() - started} ms (session ${short(session)})`,
      );
      return;
    }
    deps.log(`no account could be tried (session ${short(session)})`);
    refuse(res, skipped);
  }

  const server = http.createServer((req, res) => {
    stats.requests++;
    if (!hostOk(req.headers.host, (server.address() as { port: number }).port)) {
      sendJson(res, 421, errorBody("invalid_request_error", "sessionpipe pool: not this host"));
      return;
    }
    const pathname = (req.url as string).split("?")[0];
    if (req.method === "GET" && pathname === "/health") {
      sendJson(
        res,
        200,
        JSON.stringify({ ok: true, on: deps.on(), accounts_with_room: withRoom(deps.state, deps.now()) }),
      );
      return;
    }
    const token = deps.token();
    if (token === null) {
      sendJson(res, 503, errorBody("api_error", "sessionpipe pool: the pool's secrets can't be read right now"), {
        "retry-after": "30",
      });
      return;
    }
    if (!bearerOk(req.headers.authorization, token)) {
      sendJson(res, 401, errorBody("authentication_error", "sessionpipe pool: unknown bearer"));
      return;
    }
    if (!deps.on()) {
      // Off means off: no pooled credential is used, whatever a stale settings.json says.
      sendJson(res, 503, errorBody("api_error", "sessionpipe pool: the pool is off (sessionpipe pool on)"), {
        "retry-after": "60",
      });
      return;
    }
    const where = upstreamUrl(req.url as string, base);
    if ("status" in where) {
      sendJson(
        res,
        where.status,
        errorBody(where.status === 403 ? "permission_error" : "invalid_request_error", where.why),
      );
      return;
    }
    stats.in_flight++;
    res.once("close", () => stats.in_flight--);
    void readBody(req, res, cap).then(async (body) => {
      if (body === null) return;
      try {
        await forward(req, res, body, where.url);
      } catch (e) {
        // Nothing throws once the answer is being written (the stream has its own
        // catch), so this is always before headers.
        deps.log(`request failed: ${why(e)}`);
        sendJson(res, 502, errorBody("api_error", "sessionpipe pool: request failed"));
      } finally {
        deps.persist();
      }
    });
  });
  server.keepAliveTimeout = 65_000;

  return new Promise((resolve, reject) => {
    let moved = deps.port === 0;
    server.once("listening", () => {
      const addr = server.address() as { port: number };
      resolve({
        port: addr.port,
        moved,
        stats,
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
    server.once("error", (e: NodeJS.ErrnoException) => {
      if (e.code !== "EADDRINUSE" || deps.port === 0) return reject(e);
      deps.log(`port ${deps.port} is taken; picking another`);
      moved = true;
      server.once("error", reject);
      server.listen(0, "127.0.0.1");
    });
    server.listen(deps.port, "127.0.0.1");
  });
}
