// SPDX-License-Identifier: Apache-2.0
// The Claude Code pool: everything the daemon's loopback proxy has to know about
// Anthropic, in one file, so nothing else in core names an endpoint, a header or a
// credential file. Pure functions over bytes, headers and JSON, plus four `fetch`
// wrappers whose `fetch` is injected: the tests never reach the network or the keychain.
//
// Facts were read from the installed Claude Code (2.1.312) with `strings`, and checked
// against bb's Account Pooler for the request shapes; none of its code is copied.
// - OAuth: PKCE S256 against `authorize`, the code pasted back as `code#state` (the
//   manual redirect, `callback`), exchanged at `token` as JSON
//   `{grant_type, code, state, client_id, redirect_uri, code_verifier}`; refreshed with
//   `{grant_type: "refresh_token", refresh_token, client_id}`. Every OAuth call carries
//   `anthropic-beta: oauth-2025-04-20`. Claude Code 2.1.312 signs in at
//   platform.claude.com (the token URL and the manual callback); the older
//   console.anthropic.com names bb still uses are the same service.
// - Limits come back on every response as `anthropic-ratelimit-unified-*` headers:
//   `5h`/`7d` (and `7d_<model>`) × `utilization` (a fraction 0–1), `reset` (epoch
//   seconds), `status`; a whole-account `status` (allowed · allowed_warning · rejected);
//   on a refusal `representative-claim` names the window and `reset` says when. The
//   usage endpoint says the same per window as `{utilization (a percent), resets_at}`.
// - Claude Code's own login is a generic password in the macOS keychain, service
//   `Claude Code-credentials` (plus `-<8 hex of sha256(config dir)>` when
//   CLAUDE_CONFIG_DIR is set), account = the login user; elsewhere
//   `<config dir>/.credentials.json`. Either holds
//   `{claudeAiOauth: {accessToken, refreshToken, expiresAt (epoch ms), …}}`.
// - `metadata.user_id` in a request body is, since 2.1.x, a JSON string
//   `{"device_id","account_uuid","session_id"[,"parent_session_id"]}`; older builds sent
//   `user_<hash>_account_<uuid>_session_<uuid>`. Both are read; the account part is
//   rewritten in place so the serving account sees its own id and nothing else moves.

import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { homeDir } from "../paths.js";
import type { DataOf } from "../types.js";
import { claudeDirs } from "./claude-code.js";

export type LimitWindow = DataOf<"limits.observed">["windows"][number];

/** Claude Code 2.1.312's own prod endpoints. bb signs in at claude.ai/oauth/authorize with
 *  console.anthropic.com's callback and token URL, which still answer; the paste-back code
 *  works the same at either. */
export const POOL_ENDPOINTS = {
  authorize: "https://claude.com/cai/oauth/authorize",
  token: "https://platform.claude.com/v1/oauth/token",
  callback: "https://platform.claude.com/oauth/code/callback",
  profile: "https://api.anthropic.com/api/oauth/profile",
  usage: "https://api.anthropic.com/api/oauth/usage",
  api: "https://api.anthropic.com",
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  // The six Claude Code itself asks for with this client id: a token minted with fewer
  // than the client's usual set is the kind of thing that fails only live.
  scopes: [
    "user:inference",
    "user:profile",
    "org:create_api_key",
    "user:sessions:claude_code",
    "user:mcp_servers",
    "user:file_upload",
  ],
  beta: "oauth-2025-04-20",
} as const;

export interface PoolCredential {
  access: string;
  refresh: string;
  /** Epoch milliseconds. */
  expires_at: number;
}
export type PoolStatus = "allowed" | "allowed_warning" | "rejected";
export interface PoolLimits {
  windows: LimitWindow[];
  /** The account as a whole. */
  status?: PoolStatus;
  /** On a refusal: the window that refused (`five_hour`, `seven_day`, …) and when it resets. */
  claim?: string;
  resets_at?: string;
  observed_at: number;
}
export interface PoolProfile {
  account_uuid: string;
  email: string;
  org?: string;
  plan?: string;
}
export interface ImportableLogin {
  /** The Claude Code config dir the login belongs to. */
  dir: string;
  credential: PoolCredential;
  /** From the dir's .claude.json; absent when that file has no login (fetchProfile fills it). */
  account_uuid?: string;
  email?: string;
  source: "keychain" | "file";
}

/** The person has to sign in (again): a refused code, a dead refresh token, a 401. */
export class PoolAuthError extends Error {}
/** Anthropic did not answer properly right now; the same call may work in a minute. */
export class PoolUpstreamError extends Error {}

// --- limits ---------------------------------------------------------------------------

const PREFIX = "anthropic-ratelimit-unified-";
const WINDOW_IDS: Record<string, string> = { "5h": "five_hour", "7d": "seven_day" };
const WINDOW_MINUTES: Record<string, number> = { five_hour: 300, seven_day: 10_080 };
const STATUSES = new Set<string>(["allowed", "allowed_warning", "rejected"]);
const ID_RE = /^[a-z0-9_]{1,64}$/;

type HeaderBag = Headers | Record<string, string | string[] | undefined>;
/** Every header as (lowercase name, first value). */
function entries(h: HeaderBag): [string, string][] {
  const out: [string, string][] = [];
  if (h instanceof Headers) {
    h.forEach((v, k) => {
      out.push([k.toLowerCase(), v]);
    });
    return out;
  }
  for (const [k, v] of Object.entries(h)) {
    const s = Array.isArray(v) ? v[0] : v;
    if (typeof s === "string") out.push([k.toLowerCase(), s]);
  }
  return out;
}
/** Epoch seconds (a header's `reset`, usage's numeric `resets_at`) or an RFC 3339 string
 *  as RFC 3339; anything that is not a plausible time is no time. */
function isoTime(v: unknown): string | undefined {
  if (typeof v === "number") return v > 0 && v < 1e11 ? new Date(v * 1000).toISOString() : undefined;
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return isoTime(Number(s));
  if (!/^\d{4}-\d{2}-\d{2}T/.test(s)) return undefined;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}
const percentOf = (n: number) => Math.round(Math.max(0, n) * 10) / 10;
/** The window id a `5h`/`7d`/`7d_opus` header part names; the same ids Claude Code's status line uses. */
const windowId = (part: string): string => WINDOW_IDS[part] ?? `seven_day_${part.slice(3)}`;

/** The account's limits from a response's headers; null when the limiter did not run
 *  (no `anthropic-ratelimit-unified-*` header at all). A window needs a readable
 *  utilization; a status or a reset alone is kept on the account. */
export function readLimits(headers: HeaderBag, now: number): PoolLimits | null {
  const seen = new Map<string, { used?: number; resets_at?: string }>();
  const out: PoolLimits = { windows: [], observed_at: now };
  let any = false;
  for (const [name, value] of entries(headers)) {
    if (!name.startsWith(PREFIX)) continue;
    any = true;
    const rest = name.slice(PREFIX.length);
    if (rest === "status") {
      if (STATUSES.has(value)) out.status = value as PoolStatus;
      continue;
    }
    if (rest === "representative-claim") {
      if (ID_RE.test(value)) out.claim = value;
      continue;
    }
    if (rest === "reset") {
      const t = isoTime(value);
      if (t) out.resets_at = t;
      continue;
    }
    const m = /^(5h|7d|7d_[a-z0-9_]+)-(utilization|reset)$/.exec(rest);
    if (!m) continue;
    const id = windowId(m[1] as string);
    if (!ID_RE.test(id)) continue;
    const w = seen.get(id) ?? {};
    seen.set(id, w);
    if (m[2] === "utilization") {
      const n = Number(value);
      if (value.trim() && Number.isFinite(n)) w.used = percentOf(n * 100);
    } else {
      const t = isoTime(value);
      if (t) w.resets_at = t;
    }
  }
  if (!any) return null;
  for (const [id, w] of seen) {
    if (w.used === undefined) continue;
    const minutes = WINDOW_MINUTES[id];
    out.windows.push({
      id,
      used_percent: w.used,
      ...(w.resets_at ? { resets_at: w.resets_at } : {}),
      ...(minutes ? { window_minutes: minutes } : {}),
    });
  }
  return out;
}

/** The usage endpoint's JSON: `{five_hour: {utilization, resets_at}, seven_day: {…},
 *  seven_day_<model>: {…}, …}`, utilization a percent already. Any other key shaped
 *  like a window passes through under its own id; null when none is. */
export function usageLimits(json: unknown, now: number): PoolLimits | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const windows: LimitWindow[] = [];
  for (const [id, v] of Object.entries(json as Record<string, unknown>)) {
    if (!ID_RE.test(id) || !v || typeof v !== "object" || Array.isArray(v)) continue;
    const w = v as { utilization?: unknown; resets_at?: unknown };
    if (typeof w.utilization !== "number" || !Number.isFinite(w.utilization)) continue;
    const resets_at = isoTime(w.resets_at);
    const minutes = WINDOW_MINUTES[id];
    windows.push({
      id,
      used_percent: percentOf(w.utilization),
      ...(resets_at ? { resets_at } : {}),
      ...(minutes ? { window_minutes: minutes } : {}),
    });
  }
  return windows.length ? { windows: windows.slice(0, 8), observed_at: now } : null;
}

// --- metadata.user_id -----------------------------------------------------------------

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_RE = new RegExp(`^${UUID}$`, "i");
const LEGACY_ACCOUNT = new RegExp(`(?:^|_)account_(${UUID})(?=_|$)`, "i");
const LEGACY_SESSION = new RegExp(`(?:^|_)session_(${UUID})$`, "i");

function userIdOf(body: unknown): string | null {
  let v = body;
  if (Buffer.isBuffer(v) || typeof v === "string") {
    try {
      v = JSON.parse(v.toString());
    } catch {
      return null;
    }
  }
  const id = (v as { metadata?: { user_id?: unknown } } | null)?.metadata?.user_id;
  return typeof id === "string" && id.length <= 4096 ? id : null;
}
/** The session and account a `metadata.user_id` names, in either of its two forms. */
function partsOf(id: string): { session?: string; account?: string } {
  if (id.startsWith("{")) {
    try {
      const j = JSON.parse(id) as { account_uuid?: unknown; session_id?: unknown };
      return {
        ...(typeof j.session_id === "string" && j.session_id ? { session: j.session_id } : {}),
        ...(typeof j.account_uuid === "string" && UUID_RE.test(j.account_uuid) ? { account: j.account_uuid } : {}),
      };
    } catch {
      return {};
    }
  }
  const s = LEGACY_SESSION.exec(id)?.[1];
  const a = LEGACY_ACCOUNT.exec(id)?.[1];
  return { ...(s ? { session: s } : {}), ...(a ? { account: a } : {}) };
}

/** `metadata.user_id` of a request body (parsed, or the raw bytes): the session to pin
 *  on and the account the body claims. null when the body carries none. */
export function parseUserId(body: unknown): { session?: string; account?: string } | null {
  const id = userIdOf(body);
  return id === null ? null : partsOf(id);
}

/** The body with the account part of `metadata.user_id` set to `accountUuid`, the same
 *  bytes when there is nothing to rewrite. Done on the string, not a parse/stringify
 *  round trip: Claude Code's bodies are JSON.stringify output and would survive one, but
 *  a body a person built by hand (an SDK, a `CLAUDE_CODE_EXTRA_BODY`) can carry number
 *  forms and escapes a round trip rewrites, and a prompt cache is keyed on bytes. The
 *  only change is the UUID inside that one string literal. */
export function withAccount(body: Buffer, accountUuid: string): Buffer {
  if (!UUID_RE.test(accountUuid)) return body;
  const id = userIdOf(body);
  if (id === null) return body;
  const current = partsOf(id).account;
  if (!current || current.toLowerCase() === accountUuid.toLowerCase()) return body;
  const text = body.toString("utf8");
  // The literal as JSON.stringify writes it; a body that escaped it another way
  // (`\u005f` for an underscore) is left alone rather than guessed at.
  const literal = JSON.stringify(id).slice(1, -1);
  const m = [...text.matchAll(/"user_id"\s*:\s*"((?:[^"\\]|\\.)*)"/g)].find((x) => x[1] === literal);
  if (!m) return body;
  const start = m.index + m[0].length - 1 - literal.length + literal.indexOf(current);
  return Buffer.from(text.slice(0, start) + accountUuid + text.slice(start + current.length), "utf8");
}

// --- headers upstream -----------------------------------------------------------------

/** Headers that describe this hop, not the request; and the ones the proxy owns. */
const DROP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "host",
  "content-length",
  "authorization",
  "x-api-key",
]);

/** The request's headers as they go to Anthropic: the serving account's bearer in place
 *  of the pool's own token, the OAuth beta present, hop-by-hop and the ones the sender
 *  sets (host, content-length) gone. Our token and any x-api-key never go through. */
export function upstreamHeaders(
  req: Record<string, string | string[] | undefined>,
  access: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req)) {
    const name = k.toLowerCase();
    if (v === undefined || DROP.has(name) || name.startsWith("proxy-")) continue;
    out[name] = Array.isArray(v) ? v.join(", ") : v;
  }
  out.authorization = `Bearer ${access}`;
  const betas = (out["anthropic-beta"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!betas.includes(POOL_ENDPOINTS.beta)) betas.push(POOL_ENDPOINTS.beta);
  out["anthropic-beta"] = betas.join(",");
  return out;
}

// --- OAuth ----------------------------------------------------------------------------

/** PKCE, as Claude Code builds its own sign-in URL (the same parameters in the same
 *  order; `code=true` asks for the paste-back page). 32 random bytes base64url is a
 *  43-character verifier, inside RFC 7636's 43–128. */
export function beginLogin(random: (n: number) => Buffer = randomBytes): {
  url: string;
  verifier: string;
  state: string;
} {
  const verifier = random(32).toString("base64url");
  const state = random(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const u = new URL(POOL_ENDPOINTS.authorize);
  u.searchParams.append("code", "true");
  u.searchParams.append("client_id", POOL_ENDPOINTS.clientId);
  u.searchParams.append("response_type", "code");
  u.searchParams.append("redirect_uri", POOL_ENDPOINTS.callback);
  u.searchParams.append("scope", POOL_ENDPOINTS.scopes.join(" "));
  u.searchParams.append("code_challenge", challenge);
  u.searchParams.append("code_challenge_method", "S256");
  u.searchParams.append("state", state);
  return { url: u.toString(), verifier, state };
}

/** What the person pasted: `code#state` from the callback page, the callback URL
 *  itself, or a bare code. A state that is there and differs is somebody else's login. */
function pastedCode(pasted: string, state: string): string {
  const s = pasted.trim();
  if (!s) throw new PoolAuthError("Paste the code the sign-in page shows.");
  if (/^https?:\/\//i.test(s)) {
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      throw new PoolAuthError("That is not the sign-in page's code.");
    }
    const code = u.searchParams.get("code");
    const st = u.searchParams.get("state");
    if (!code) throw new PoolAuthError("That URL carries no code.");
    if (st !== null && st !== state) throw new PoolAuthError("That code belongs to another sign-in; start again.");
    return code;
  }
  const hash = s.indexOf("#");
  if (hash < 0) return s;
  const code = s.slice(0, hash).trim();
  const st = s.slice(hash + 1).trim();
  if (!code) throw new PoolAuthError("Paste the code the sign-in page shows.");
  if (st && st !== state) throw new PoolAuthError("That code belongs to another sign-in; start again.");
  return code;
}

type Fetch = typeof globalThis.fetch;
const JSON_HEADERS = { "content-type": "application/json", "anthropic-beta": POOL_ENDPOINTS.beta };

async function post(fetch: Fetch, url: string, body: unknown, what: string): Promise<Response> {
  try {
    return await fetch(url, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
  } catch (e) {
    throw new PoolUpstreamError(`${what}: ${(e as Error).message || "no answer from Anthropic"}`);
  }
}
async function get(fetch: Fetch, url: string, access: string, what: string): Promise<Response> {
  try {
    return await fetch(url, { headers: { authorization: `Bearer ${access}`, "anthropic-beta": POOL_ENDPOINTS.beta } });
  } catch (e) {
    throw new PoolUpstreamError(`${what}: ${(e as Error).message || "no answer from Anthropic"}`);
  }
}
async function jsonOf(r: Response): Promise<unknown> {
  try {
    return await r.json();
  } catch {
    return null;
  }
}
/** A token response into a credential; the refresh token stays when the answer omits it. */
function credentialOf(j: unknown, now: number, keepRefresh: string | undefined, what: string): PoolCredential {
  const t = j as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown } | null;
  const refresh = typeof t?.refresh_token === "string" && t.refresh_token ? t.refresh_token : keepRefresh;
  if (!t || typeof t.access_token !== "string" || !t.access_token || !refresh || typeof t.expires_in !== "number")
    throw new PoolUpstreamError(`${what}: Anthropic's answer had no token in it`);
  return { access: t.access_token, refresh, expires_at: now + t.expires_in * 1000 };
}

/** Exchange the pasted code for a credential and read whose it is. */
export async function completeLogin(
  code: string,
  pending: { verifier: string; state: string },
  fetch: Fetch,
  now: () => number,
): Promise<{ credential: PoolCredential; profile: PoolProfile }> {
  const c = pastedCode(code, pending.state);
  const r = await post(
    fetch,
    POOL_ENDPOINTS.token,
    {
      grant_type: "authorization_code",
      code: c,
      state: pending.state,
      client_id: POOL_ENDPOINTS.clientId,
      redirect_uri: POOL_ENDPOINTS.callback,
      code_verifier: pending.verifier,
    },
    "sign-in",
  );
  if (r.status >= 400 && r.status < 500)
    throw new PoolAuthError(`Anthropic did not accept the code (HTTP ${r.status}); start the sign-in again.`);
  if (!r.ok) throw new PoolUpstreamError(`sign-in: Anthropic answered HTTP ${r.status}; try again in a minute`);
  const credential = credentialOf(await jsonOf(r), now(), undefined, "sign-in");
  const profile = await fetchProfile(credential.access, fetch);
  return { credential, profile };
}

/** A fresh access token. 400/401 means the refresh token is dead (revoked, expired,
 *  used elsewhere): the person signs in again. Anything else is Anthropic's moment. */
export async function refreshCredential(
  cred: PoolCredential,
  fetch: Fetch,
  now: () => number,
): Promise<PoolCredential> {
  const r = await post(
    fetch,
    POOL_ENDPOINTS.token,
    { grant_type: "refresh_token", refresh_token: cred.refresh, client_id: POOL_ENDPOINTS.clientId },
    "refresh",
  );
  if (r.status === 400 || r.status === 401)
    throw new PoolAuthError("This account's sign-in has expired; sign in again.");
  if (!r.ok) throw new PoolUpstreamError(`refresh: Anthropic answered HTTP ${r.status}; try again in a minute`);
  return credentialOf(await jsonOf(r), now(), cred.refresh, "refresh");
}

/** Whose token this is: `{account: {uuid, email, …}, organization: {name, …}}`. */
export async function fetchProfile(access: string, fetch: Fetch): Promise<PoolProfile> {
  const r = await get(fetch, POOL_ENDPOINTS.profile, access, "profile");
  if (r.status === 401 || r.status === 403)
    throw new PoolAuthError("Anthropic does not know this token; sign in again.");
  if (!r.ok) throw new PoolUpstreamError(`profile: Anthropic answered HTTP ${r.status}; try again in a minute`);
  const j = (await jsonOf(r)) as {
    account?: { uuid?: unknown; email?: unknown; subscription_type?: unknown };
    organization?: { name?: unknown };
  } | null;
  const a = j?.account;
  if (typeof a?.uuid !== "string" || !UUID_RE.test(a.uuid) || typeof a.email !== "string" || !a.email)
    throw new PoolUpstreamError("profile: Anthropic's answer did not say whose token this is");
  const org = j?.organization?.name;
  const plan = a.subscription_type;
  return {
    account_uuid: a.uuid.toLowerCase(),
    email: a.email,
    ...(typeof org === "string" && org ? { org } : {}),
    ...(typeof plan === "string" && plan ? { plan } : {}),
  };
}

/** The account's windows from the usage endpoint; null when it reports none. */
export async function fetchUsage(access: string, fetch: Fetch, now: () => number): Promise<PoolLimits | null> {
  const r = await get(fetch, POOL_ENDPOINTS.usage, access, "usage");
  if (r.status === 401 || r.status === 403)
    throw new PoolAuthError("Anthropic does not know this token; sign in again.");
  if (!r.ok) throw new PoolUpstreamError(`usage: Anthropic answered HTTP ${r.status}; try again in a minute`);
  return usageLimits(await jsonOf(r), now());
}

// --- Claude Code's own logins ---------------------------------------------------------

const SERVICE = "Claude Code-credentials";
/** The keychain service Claude Code keeps a config dir's login under: bare for the
 *  default dir, suffixed with 8 hex of sha256(dir) when CLAUDE_CONFIG_DIR names one. */
export function keychainService(dir: string, home: string): string {
  if (path.resolve(dir) === path.join(home, ".claude")) return SERVICE;
  return `${SERVICE}-${createHash("sha256").update(dir).digest("hex").slice(0, 8)}`;
}
/** The keychain item's account: the login user, as Claude Code names it. */
function keychainUser(env: NodeJS.ProcessEnv): string {
  let u = env.USER;
  if (!u) {
    try {
      u = os.userInfo().username;
    } catch {
      u = "";
    }
  }
  return /^[a-zA-Z0-9._-]+$/.test(u) ? u : "claude-code-user";
}
function credentialIn(text: string): PoolCredential | null {
  try {
    const o = (
      JSON.parse(text) as { claudeAiOauth?: { accessToken?: unknown; refreshToken?: unknown; expiresAt?: unknown } }
    ).claudeAiOauth;
    if (typeof o?.accessToken !== "string" || !o.accessToken || typeof o.refreshToken !== "string" || !o.refreshToken)
      return null;
    // No expiry on record means refresh before the first use.
    return {
      access: o.accessToken,
      refresh: o.refreshToken,
      expires_at: typeof o.expiresAt === "number" ? o.expiresAt : 0,
    };
  } catch {
    return null;
  }
}
const EMAIL_RE = /^[^@\s]{1,64}@[^@\s]{1,189}$/;
type ReadFile = (file: string) => string;
const readText: ReadFile = (f) => readFileSync(f, "utf8");

/** Every Claude Code login on this machine the pool could copy, one per config dir
 *  (claudeDirs): the credential from the keychain (macOS) or `.credentials.json`, and
 *  who it is from the dir's .claude.json. `exec` runs `security` and returns stdout; it
 *  is the only thing that touches the keychain, so a test hands in a fake. Returns []
 *  on any failure and never throws: an import that finds nothing is a message, not a
 *  crash, and a token never reaches a log through here. */
export function importableLogins(
  env: NodeJS.ProcessEnv,
  exec: (cmd: string, args: string[]) => string,
  readFile: ReadFile = readText,
  platform: NodeJS.Platform = process.platform,
): ImportableLogin[] {
  const out: ImportableLogin[] = [];
  const home = env.HOME || homeDir();
  const user = keychainUser(env);
  for (const dir of claudeDirs(env, home)) {
    let credential: PoolCredential | null = null;
    let source: ImportableLogin["source"] = "file";
    if (platform === "darwin") {
      const service = keychainService(dir, home);
      // Claude Code writes the item under the login user; an item saved another way
      // (an older build, a renamed user) is still found by service alone.
      for (const args of [
        ["find-generic-password", "-s", service, "-a", user, "-w"],
        ["find-generic-password", "-s", service, "-w"],
      ]) {
        try {
          credential = credentialIn(exec("security", args).trim());
        } catch {}
        if (credential) break;
      }
      if (credential) source = "keychain";
    }
    if (!credential) {
      try {
        credential = credentialIn(readFile(path.join(dir, ".credentials.json")));
      } catch {}
    }
    if (!credential) continue;
    out.push({ dir, credential, ...whoIs(dir, home, readFile), source });
  }
  return out;
}
/** The dir's login, as claude-code.ts reads it: the default dir keeps its .claude.json at ~/.claude.json. */
function whoIs(dir: string, home: string, readFile: ReadFile): { account_uuid?: string; email?: string } {
  const files = [path.join(dir, ".claude.json")];
  if (path.resolve(dir) === path.join(home, ".claude")) files.unshift(path.join(home, ".claude.json"));
  for (const f of files) {
    try {
      const a = (JSON.parse(readFile(f)) as { oauthAccount?: { accountUuid?: unknown; emailAddress?: unknown } })
        .oauthAccount;
      if (typeof a?.accountUuid === "string" && UUID_RE.test(a.accountUuid)) {
        const email = typeof a.emailAddress === "string" && EMAIL_RE.test(a.emailAddress) ? a.emailAddress : undefined;
        return { account_uuid: a.accountUuid.toLowerCase(), ...(email ? { email } : {}) };
      }
    } catch {}
  }
  return {};
}
