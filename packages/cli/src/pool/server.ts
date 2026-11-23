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
// passes through unchanged, so Claude Code shows its own message. The one answer that is
// not passed on is a 401 for an account whose sign-in has just been found dead: what
// helps then is the pool's own words (NEEDS_PERSON, SIGN_IN), not "token expired". The listener is
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
/** How much of a body past the cap is read and dropped before the 413 goes out anyway
 *  (a quarter of the cap: a request somewhat over it is drained whole, which takes
 *  milliseconds on loopback), and for how long at most. */
export const DRAIN_BYTES = 8 * 1024 * 1024;
export const DRAIN_MS = 5_000;

/** The status of an answer no wait will change: a person has to act. Which status it is
 *  decides what the person sees, and each was tried on Claude Code 2.1.327 with the
 *  pool's own words as the message:
 *  - 429 with Retry-After (what the pool used to say): asked again every minute for ten,
 *    the terminal showing only "retrying", `claude -p` and apps on it nothing at all.
 *  - 401: asked again with a backoff for minutes, then "Please run /login".
 *  - 403: shown at once, behind "Please run /login", which is not where a pooled
 *    account is signed in; an app on the Agent SDK is told `authentication_failed`.
 *  - 400: shown at once and clean, after six requests.
 *  - 407: shown clean by Claude Code, but a network failure to anything on a standard
 *    `fetch` (Node's throws on a 407 from a server that is not its proxy), so its words
 *    are never read there.
 *  - 422 and 424: shown clean, but where one of Claude Code's own switches is on they
 *    make it clear older tool results out of the session and ask again; 451 it calls
 *    "blocked".
 *  - 428 (and 402): one request, shown at once as `API Error: 428 <the pool's words>`,
 *    nothing in front of them, and no meaning of its own to Claude Code, to a standard
 *    `fetch`, or to the SDKs' retries (408, 409, 429 and 5xx).
 *  428 it is: something is required before this request can be served. */
export const NEEDS_PERSON = 428;

/** What a person types to sign the pool's accounts in again: one command, which takes
 *  them through each account that needs it (pool/cli.ts `login`). Every answer that says
 *  an account needs signing in says this too: Claude Code, and whatever runs on it, shows
 *  the answer's words where the person is looking. */
export const SIGN_IN = "sessionpipe pool login";

export interface PoolServerDeps {
  adapter: Pick<PoolAdapter, "POOL_ENDPOINTS" | "readLimits" | "parseUserId" | "withAccount" | "upstreamHeaders">;
  fetch: typeof fetch;
  now: () => number;
  /** Nothing secret ever goes in: account ids, statuses, timings. */
  log: (line: string) => void;
  /** The port pool.json remembers; 0 or taken: a free one is picked. */
  port: number;
  /** The bearers Claude Code may present: the current one (settings.json) and, for a
   *  while after a rotation, the one before it, so a session that started with the old
   *  token keeps working. Read on every request, since `pool on` mints in another
   *  process. Null: the secrets store can't be read right now, which is a 503, not an
   *  unknown bearer. */
  token: () => readonly string[] | null;
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
  /** Bytes past the cap drained before the 413 (DRAIN_BYTES). */
  drainBytes?: number;
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

/** Printable ASCII only: a control byte or anything past 0x7e has no place in a path we forward. */
const plainAscii = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) return false;
  }
  return true;
};

/** The path as the upstream will read it, or null for one it must never see: each
 *  segment percent-decoded once (an upstream router decodes before it routes, so the
 *  deny list has to read what the router reads), then refused if anything is still
 *  encoded (`%` left over: a double encoding), if a decoded byte is a slash, a
 *  backslash, whitespace or a control character (an encoded separator or an odd byte
 *  Claude Code never sends), if a segment is empty or a dot segment (`//`, `%2e%2e`),
 *  or if a segment does not decode at all. What comes back is re-encoded per segment,
 *  so what was checked is what is sent. */
export function normalPath(pathname: string): string | null {
  const segments = pathname.slice(1).split("/");
  const out: string[] = [];
  for (const seg of segments) {
    let d: string;
    try {
      d = decodeURIComponent(seg);
    } catch {
      return null;
    }
    if (!d || d === "." || d === ".." || /[%/\\\s]/.test(d) || !plainAscii(d)) return null;
    out.push(encodeURIComponent(d));
  }
  return `/${out.join("/")}`;
}

/** The upstream URL for a request-target, or why not. Built from the parsed, then
 *  normalised path (normalPath), compared lower-cased: the upstream's routes are not
 *  case-sensitive in any way the pool should bet on. */
export function upstreamUrl(target: string, base: string): { url: string } | { status: 400 | 403; why: string } {
  if (!target.startsWith("/")) return { status: 400, why: "sessionpipe pool: bad request path" };
  // A path against a fixed base always parses (odd bytes are percent-encoded).
  const u = new URL(target, base);
  const pathname = u.origin === new URL(base).origin ? normalPath(u.pathname) : null;
  if (pathname === null || !ALLOW_PATH.test(pathname.toLowerCase()))
    return { status: 400, why: "sessionpipe pool: path not proxied" };
  if (DENY_PATH.some((re) => re.test(pathname.toLowerCase())))
    return { status: 403, why: "sessionpipe pool: that endpoint is not proxied" };
  return { url: `${u.origin}${pathname}${u.search}` };
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

/** Why nobody can serve and no wait will change it, with what to type: `all` accounts in
 *  the pool, `on` of them enabled, `out` of those needing a sign-in. Counts only: an
 *  answer's words go wherever an app sends its errors. */
export function nobody(all: number, on: number, out: number): string {
  if (!all) return `the pool has no Claude account. In a terminal run: ${SIGN_IN}`;
  if (!on)
    return "every Claude account in the pool is turned off. In a terminal run: sessionpipe pool (it lists them), then sessionpipe pool enable <account>";
  const need = (n: number) => `need${n === 1 ? "s" : ""} signing in again`;
  const who =
    out < on
      ? `${out} of the ${on} Claude accounts that are on ${need(out)} and no other can serve`
      : on < all
        ? `the ${on === 1 ? "one Claude account that is" : `${on} Claude accounts that are`} on ${need(on)}`
        : on === 1
          ? `its Claude account ${need(1)}`
          : `all ${on} of its Claude accounts ${need(on)}`;
  return `${who}. In a terminal run: ${SIGN_IN}`;
}

const why = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const errorBody = (type: string, message: string) => JSON.stringify({ type: "error", error: { type, message } });

function sendJson(res: http.ServerResponse, status: number, body: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...extra });
  res.end(body);
}

/** The body, whole, or null once it passed the cap (the 413 is then this function's to
 *  send, and the caller does nothing more). The client is still writing when the cap
 *  is hit, and node ends the socket once an answer is flushed: the bytes the client
 *  sends after that meet a closed socket, the reset that comes back can throw away the
 *  413 it has not read yet (macOS, Windows), and it sees EPIPE or ECONNRESET instead.
 *  So nothing is answered mid-body: the rest is read and dropped (never kept), and the
 *  413 goes out when the request ends, or once `drain` bytes past the cap or DRAIN_MS
 *  have gone by, whichever comes first, so an endless or stalled upload holds nothing.
 *  The answer says `connection: close`; one sent on a budget may still meet a reset. */
function readBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cap: number,
  drain: number,
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let timer: NodeJS.Timeout | undefined;
    // Once the answer is out or the client gone, nothing of this request is left
    // running: no timer, no listener but the error one (an error with none throws).
    const stop = () => {
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      res.off("close", stop);
    };
    const answer = () => {
      stop();
      sendJson(res, 413, errorBody("request_too_large", `sessionpipe pool: request body over ${cap} bytes`), {
        connection: "close",
      });
    };
    const onData = (c: Buffer) => {
      size += c.length;
      if (size <= cap) {
        chunks.push(c);
        return;
      }
      if (timer === undefined) {
        chunks.length = 0;
        resolve(null);
        timer = setTimeout(answer, DRAIN_MS);
        res.once("close", stop);
      }
      if (size > cap + drain) answer();
    };
    const onEnd = () => (timer === undefined ? resolve(Buffer.concat(chunks)) : answer());
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", () => resolve(null));
  });
}

export function startPoolServer(deps: PoolServerDeps): Promise<PoolServer> {
  const stats: PoolStats = { requests: 0, upstream: 0, retries: 0, refused: 0, aborted: 0, in_flight: 0 };
  const base = (deps.upstream ?? deps.adapter.POOL_ENDPOINTS.api).replace(/\/$/, "");
  const cap = deps.bodyCap ?? BODY_CAP;
  const drain = deps.drainBytes ?? DRAIN_BYTES;
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
   *  (Claude Code retries those by itself), and accounts at their limit are a 429 with
   *  the time one has room again. When no wait can help, because every account that
   *  could serve needs signing in again, or the pool has none that is on, the answer is
   *  NEEDS_PERSON with what to type. */
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
    const on = deps.state.accounts.filter((a) => a.enabled);
    const out = on.filter((a) => a.error).length;
    if (at === null && (out || !on.length)) {
      sendJson(
        res,
        NEEDS_PERSON,
        errorBody("authentication_error", `sessionpipe pool: ${nobody(deps.state.accounts.length, on.length, out)}`),
      );
      return;
    }
    const when = at === null ? "an account is signed in" : new Date(at).toISOString();
    const secs = at === null ? 60 : Math.max(1, Math.ceil((at - now) / 1000));
    const also = out ? `; ${out} more need${out === 1 ? "s" : ""} signing in again (${SIGN_IN})` : "";
    sendJson(res, 429, errorBody("rate_limit_error", `sessionpipe pool: no account has room until ${when}${also}`), {
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
      /** This account's sign-in was found dead on this very request. */
      let signedOut = false;
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
            if (again.why === "sign-in") {
              observe(deps.state, a.id, { error: "sign in again" }, now);
              signedOut = true;
            }
            // Not a dead sign-in: if nobody else serves, the refusal says which it was.
            if (again.why === "upstream") skipped.upstream = again.detail;
            moveOn = true;
          }
        }
      } else if (status >= 500) {
        observe(deps.state, a.id, { upstream5xx: true }, now);
      }
      if (moveOn) deps.onStanding?.();
      // One retry, on the next account. An account found signed out does not use it up:
      // its 401 came before anything was done with the request, and what the person needs
      // to hear is how many accounts are signed out, which only asking the rest tells.
      if (moveOn && (!retried || signedOut)) {
        const other = next();
        if (other) {
          if (!signedOut) retried = true;
          stats.retries++;
          account = other;
          deps.log(`${a.id}: ${status}${limits?.status ? ` (${limits.status})` : ""}; trying ${other.id}`);
          await up.body?.cancel();
          continue;
        }
      }
      // The upstream's 401 for an account that turned out to be signed out says "token
      // expired": Claude Code asks that again for minutes, then tells the person to
      // /login, which is not where a pooled account is signed in. The pool's own answer
      // says who needs signing in and how.
      if (signedOut) {
        await up.body?.cancel();
        break;
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
    const out = deps.state.accounts.filter((a) => a.enabled && a.error).length;
    deps.log(`no account could be tried (session ${short(session)})${out ? `: ${out} to sign in again` : ""}`);
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
    const tokens = deps.token();
    if (tokens === null) {
      sendJson(res, 503, errorBody("api_error", "sessionpipe pool: the pool's secrets can't be read right now"), {
        "retry-after": "30",
      });
      return;
    }
    if (!tokens.some((t) => bearerOk(req.headers.authorization, t))) {
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
    void readBody(req, res, cap, drain).then(async (body) => {
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
