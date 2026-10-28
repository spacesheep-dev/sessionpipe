// SPDX-License-Identifier: Apache-2.0
// What the pool engine needs from the vendor adapter (core's `claudePool`,
// adapters/claude-code-pool.ts), as an interface: the engine never names an endpoint, a
// header or an OAuth detail itself. `claudePool` is the default; tests pass a fake. Each
// shape here is structural, so the adapter's own exported types satisfy it.

import type { DataOf } from "@sessionpipe/core";

/** One usage window, as `limits.observed` carries it (PROTOCOL.md): `id`,
 *  `used_percent`, `resets_at?` (RFC 3339; a window whose reset has passed counts as
 *  empty), `window_minutes?`. */
export type LimitWindow = DataOf<"limits.observed">["windows"][number];

/** An account's limits as last seen: from response headers (with the unified status)
 *  or from the usage endpoint (windows only). */
export interface PoolLimits {
  /** Empty when only a status or a reset was readable: then the windows known so far stay. */
  windows: LimitWindow[];
  /** `allowed`, `allowed_warning` or `rejected`, when the source said. */
  status?: string;
  /** On a refusal: the window that refused, and when it resets. */
  claim?: string;
  resets_at?: string;
  observed_at?: number;
}

/** An OAuth credential: the access token, the refresh token, and when the access
 *  token expires in epoch milliseconds. */
export interface PoolCredential {
  access: string;
  refresh: string;
  expires_at: number;
}

export interface PoolProfile {
  account_uuid: string;
  email: string;
  org?: string;
  plan?: string;
}

export interface PendingLogin {
  url: string;
  verifier: string;
  state: string;
}

/** A Claude Code login on this machine, as the adapter reads it. `account_uuid` is
 *  absent when the dir's .claude.json names no login (the profile endpoint fills it);
 *  `expires_at` 0 means refresh before first use. */
export interface ImportableLogin {
  dir: string;
  credential: PoolCredential;
  account_uuid?: string;
  email?: string;
  source: "keychain" | "file";
}

/** Runs a command and returns what it printed (the keychain reader on macOS); throws
 *  when it fails. */
export type Exec = (cmd: string, args: string[]) => string;
type Now = () => number;

export interface PoolAdapter {
  /** `api`: the base URL requests are forwarded to; the OAuth endpoints beside it. A
   *  test upstream stands in for every one of their origins (index.ts, N1). */
  POOL_ENDPOINTS: { api: string; token?: string; profile?: string; usage?: string };
  /** The rate-limit headers of a response → limits, or null when it carried none. */
  readLimits(headers: Headers, now: number): PoolLimits | null;
  /** The usage endpoint's JSON → limits, or null when it isn't one. */
  usageLimits(json: unknown, now: number): PoolLimits | null;
  /** `metadata.user_id` of a request body: the session uuid and the account part;
   *  null when the body carries none. */
  parseUserId(body: Buffer): { session?: string; account?: string } | null;
  /** The same body with `metadata.user_id` naming `accountUuid`. */
  withAccount(body: Buffer, accountUuid: string): Buffer;
  /** The request headers to send upstream: the person's, with our bearer and the
   *  OAuth beta header, minus what must not be forwarded. */
  upstreamHeaders(reqHeaders: Record<string, string | string[] | undefined>, access: string): Record<string, string>;
  beginLogin(random?: (n: number) => Buffer): PendingLogin;
  completeLogin(
    code: string,
    pending: { verifier: string; state: string },
    fetch: typeof globalThis.fetch,
    now: Now,
  ): Promise<{ credential: PoolCredential; profile: PoolProfile }>;
  /** Throws PoolAuthError when the refresh token is refused (sign in again); anything
   *  else that fails is an upstream failure. */
  refreshCredential(cred: PoolCredential, fetch: typeof globalThis.fetch, now: Now): Promise<PoolCredential>;
  fetchProfile(access: string, fetch: typeof globalThis.fetch): Promise<PoolProfile>;
  fetchUsage(access: string, fetch: typeof globalThis.fetch, now: Now): Promise<PoolLimits | null>;
  /** Never throws; [] when nothing is readable. */
  importableLogins(env: NodeJS.ProcessEnv, exec: Exec): ImportableLogin[];
  PoolAuthError: new (message?: string) => Error;
}
