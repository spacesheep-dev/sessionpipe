// SPDX-License-Identifier: Apache-2.0
// Each account's access token, ready to use: read from the secrets store on demand and
// kept in memory only, refreshed five minutes before it expires with one refresh in
// flight per account however many requests arrive at once. A refresh the vendor refuses
// (PoolAuthError) means the person must sign in again; any other failure is the
// upstream's and is retried next time. A store that can't be read (a keychain locked
// with nobody at the screen) is asked again no sooner than every 30 s, like the sinks.
import type { PoolCredential } from "./types.js";

/** Refresh this long before `expires_at`. */
export const REFRESH_EARLY_MS = 5 * 60_000;
/** Don't ask a store that just refused again before this. */
export const STORE_RETRY_MS = 30_000;
/** After a refresh the token endpoint failed (not refused), wait this long before the
 *  next try: the sinks' cadence. Never one call per request. */
export const REFRESH_BACKOFF_MS = [30_000, 60_000, 300_000] as const;

export interface CredentialDeps {
  now: () => number;
  /** From the secrets store; null when it can't be read right now. */
  load: (id: string) => PoolCredential | null;
  /** Into the secrets store; false when it refused (the memory copy still serves). */
  save: (id: string, c: PoolCredential) => boolean;
  refresh: (c: PoolCredential) => Promise<PoolCredential>;
  isAuthError: (e: unknown) => boolean;
  log: (line: string) => void;
}

export type Fetched =
  | { ok: true; access: string /** Refreshed within this call or the last minute. */; fresh: boolean }
  | { ok: false; why: "unreadable" | "sign-in" | "upstream"; detail: string };

export class Credentials {
  private readonly cache = new Map<string, PoolCredential>();
  private readonly inflight = new Map<string, Promise<Fetched>>();
  private readonly refusedAt = new Map<string, number>();
  private readonly refreshedAt = new Map<string, number>();
  private readonly failed = new Map<string, { at: number; n: number; detail: string }>();
  constructor(private readonly deps: CredentialDeps) {}

  /** Put a credential just obtained (login, import) into memory and the store. */
  set(id: string, c: PoolCredential): boolean {
    this.cache.set(id, c);
    this.refusedAt.delete(id);
    return this.deps.save(id, c);
  }

  forget(id: string): void {
    this.cache.delete(id);
    this.refusedAt.delete(id);
    this.refreshedAt.delete(id);
    this.failed.delete(id);
  }

  /** The access token to send now. `force` refreshes whatever the expiry says (a 401
   *  on a token that wasn't fresh). */
  get(id: string, force = false): Promise<Fetched> {
    const running = this.inflight.get(id);
    if (running) return running;
    const p = this.fetch(id, force).finally(() => this.inflight.delete(id));
    this.inflight.set(id, p);
    return p;
  }

  private async fetch(id: string, force: boolean): Promise<Fetched> {
    const now = this.deps.now();
    let c = this.cache.get(id);
    if (!c) {
      const at = this.refusedAt.get(id);
      if (at !== undefined && now - at < STORE_RETRY_MS)
        return { ok: false, why: "unreadable", detail: "credential store unreadable; retrying" };
      const loaded = this.deps.load(id);
      if (!loaded) {
        this.refusedAt.set(id, now);
        return { ok: false, why: "unreadable", detail: "no credential readable for this account" };
      }
      this.refusedAt.delete(id);
      c = loaded;
      this.cache.set(id, c);
    }
    if (!force && c.expires_at - now > REFRESH_EARLY_MS)
      return { ok: true, access: c.access, fresh: now - (this.refreshedAt.get(id) ?? 0) < 60_000 };
    const f = this.failed.get(id);
    if (f && now - f.at < (REFRESH_BACKOFF_MS[Math.min(f.n, REFRESH_BACKOFF_MS.length) - 1] as number)) {
      if (c.expires_at > now) return { ok: true, access: c.access, fresh: false };
      return { ok: false, why: "upstream", detail: f.detail };
    }
    try {
      const next = await this.deps.refresh(c);
      this.cache.set(id, next);
      this.failed.delete(id);
      this.refreshedAt.set(id, this.deps.now());
      if (!this.deps.save(id, next)) this.deps.log(`${id}: refreshed token kept in memory only; the store refused it`);
      return { ok: true, access: next.access, fresh: true };
    } catch (e) {
      const detail = String((e as Error).message ?? e);
      if (this.deps.isAuthError(e)) return { ok: false, why: "sign-in", detail };
      this.failed.set(id, { at: now, n: (f?.n ?? 0) + 1, detail });
      // A stale token may still work for a while; the upstream decides.
      if (c.expires_at > this.deps.now()) return { ok: true, access: c.access, fresh: false };
      return { ok: false, why: "upstream", detail };
    }
  }
}
