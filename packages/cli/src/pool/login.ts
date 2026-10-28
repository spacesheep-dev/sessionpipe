// SPDX-License-Identifier: Apache-2.0
// Adding an account by signing in: a PKCE login in two steps, because the daemon has
// no browser. `begin` makes the URL and keeps the verifier (state.json, ten minutes,
// one at a time: a new begin replaces the last); `complete` trades the pasted
// `code#state` for a credential and a profile. The adapter knows the endpoints; this
// file only keeps the pending login honest and turns a profile into an account record.
import { shortId } from "@sessionpipe/core";
import type { PoolAccount, PoolState } from "./store.js";
import type { PoolAdapter, PoolCredential, PoolProfile } from "./types.js";

export const LOGIN_TTL_MS = 10 * 60_000;

export type Pending = NonNullable<PoolState["pending"]>;

/** The pool's id for an account: eight hex digits of its uuid, like a session's short
 *  id, the same on every machine that pools it. */
export const accountId = (accountUuid: string): string => shortId("claude-code-pool", accountUuid);

export function beginLogin(
  adapter: Pick<PoolAdapter, "beginLogin">,
  now: number,
  random?: (n: number) => Buffer,
): Pending {
  const p = adapter.beginLogin(random);
  return {
    id: accountId(`${p.state}:${now}`),
    url: p.url,
    verifier: p.verifier,
    state: p.state,
    expires_at: now + LOGIN_TTL_MS,
  };
}

/** The pending login `id` names, still valid; null with why not. */
export function pendingLogin(
  pending: Pending | undefined,
  id: string | undefined,
  now: number,
): { pending: Pending } | { why: "no_pending" | "login_expired" | "unknown_login" } {
  if (!pending) return { why: "no_pending" };
  if (id !== undefined && id !== pending.id) return { why: "unknown_login" };
  if (pending.expires_at <= now) return { why: "login_expired" };
  return { pending };
}

/** A record for a profile, or the existing record of the same account brought up to
 *  date (a login repeated for an account already in the pool refreshes its credential
 *  and its email, never makes a twin). */
export function accountFor(
  accounts: readonly PoolAccount[],
  profile: PoolProfile,
  now: number,
): { account: PoolAccount; existed: boolean } {
  const seen = accounts.find((a) => a.account_uuid === profile.account_uuid);
  if (seen) return { account: { ...seen, email: profile.email || seen.email }, existed: true };
  return {
    account: {
      id: accountId(profile.account_uuid),
      email: profile.email,
      account_uuid: profile.account_uuid,
      enabled: true,
      added_at: new Date(now).toISOString(),
    },
    existed: false,
  };
}

export async function completeLogin(
  adapter: Pick<PoolAdapter, "completeLogin">,
  fetch: typeof globalThis.fetch,
  pending: Pending,
  code: string,
  accounts: readonly PoolAccount[],
  now: number,
): Promise<{ account: PoolAccount; existed: boolean; credential: PoolCredential }> {
  const { credential, profile } = await adapter.completeLogin(code.trim(), pending, fetch, () => now);
  return { ...accountFor(accounts, profile, now), credential };
}
