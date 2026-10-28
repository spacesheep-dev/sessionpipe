// SPDX-License-Identifier: Apache-2.0
// Adding the accounts Claude Code is already signed in to on this machine: every
// config dir's login (the keychain item or .credentials.json, read by the adapter) that
// isn't in the pool yet. A copy: the person's own login stays where it is and Claude
// Code keeps refreshing it; the pool refreshes its copy. Two config dirs signed in to
// one account are one pool account. The façade finds each login's account uuid first
// (the profile endpoint, when .claude.json names none) and hands them in here.
import { accountFor } from "./login.js";
import type { PoolAccount } from "./store.js";
import type { PoolCredential } from "./types.js";

export interface ResolvedLogin {
  dir: string;
  account_uuid: string;
  email: string;
  credential: PoolCredential;
}

export interface Imported {
  added: { account: PoolAccount; credential: PoolCredential; dir: string }[];
  /** Logins left out: already pooled, seen twice in this run, or unreadable. */
  skipped: { dir: string; email?: string; why: string }[];
}

export function importLogins(
  logins: readonly ResolvedLogin[],
  accounts: readonly PoolAccount[],
  now: number,
): Imported {
  const out: Imported = { added: [], skipped: [] };
  const have = [...accounts];
  for (const l of logins) {
    const { account, existed } = accountFor(have, { account_uuid: l.account_uuid, email: l.email }, now);
    if (existed) {
      const pooled = accounts.some((a) => a.account_uuid === l.account_uuid);
      out.skipped.push({
        dir: l.dir,
        email: l.email,
        why: pooled ? "already in the pool" : "same account as another dir",
      });
      continue;
    }
    have.push(account);
    out.added.push({ account, credential: l.credential, dir: l.dir });
  }
  return out;
}
