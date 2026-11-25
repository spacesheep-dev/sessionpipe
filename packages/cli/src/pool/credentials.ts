// SPDX-License-Identifier: Apache-2.0
// Each account's access token, ready to use: read from the secrets store on demand and
// kept in memory only, refreshed five minutes before it expires with one refresh in
// flight per account however many requests arrive at once. A refresh the vendor refuses
// (PoolAuthError) means the person must sign in again; any other failure is the
// upstream's and is retried next time. A store that can't be read (a keychain locked
// with nobody at the screen) is asked again no sooner than every 30 s, like the sinks.
//
// A refresh replaces the sign-in itself: the vendor hands out a new refresh token and the
// old one is dead. One the store would not take lived in memory only, and was gone at the
// daemon's next start: three accounts refreshed in the small hours behind a locked
// keychain all needed signing in again once the daemon restarted (2026-11-22). So no
// refresh is made while the store cannot be reached, unless a request is waiting on a
// token that no longer works; and one made then is offered to the store again until it
// is in. A locked keychain answers neither a read nor a write, and each waits out the
// tool's eight seconds with the whole daemon: so it is asked with one read, and after a
// refusal no sooner than 30 s, 60 s, then every five minutes.
import type { PoolCredential } from "./types.js";

/** Refresh this long before `expires_at`. */
export const REFRESH_EARLY_MS = 5 * 60_000;
/** Don't ask a store that just refused again before this. */
export const STORE_RETRY_MS = 30_000;
/** A store found shut is asked again after this long: the sinks' cadence. */
export const STORE_BACKOFF_MS = [STORE_RETRY_MS, 60_000, 300_000] as const;
/** How long a refreshed sign-in the store has not taken holds the daemon back from a
 *  restart of its own. A store shut for longer than a day is not one a wait will open. */
export const UNSAVED_HOLD_MS = 24 * 3_600_000;
/** After a refresh the token endpoint failed (not refused), wait this long before the
 *  next try: the sinks' cadence. Never one call per request. */
export const REFRESH_BACKOFF_MS = [30_000, 60_000, 300_000] as const;

export interface CredentialDeps {
  now: () => number;
  /** From the secrets store; null when it can't be read right now. */
  load: (id: string) => PoolCredential | null;
  /** Into the secrets store; false when it refused (the memory copy still serves). */
  save: (id: string, c: PoolCredential) => boolean;
  /** Whether the store can be reached right now, asked by reading this account's item
   *  (a locked keychain answers no read). Without it the store is taken to be open. */
  storeOpen?: (id: string) => boolean;
  refresh: (c: PoolCredential) => Promise<PoolCredential>;
  isAuthError: (e: unknown) => boolean;
  log: (line: string) => void;
}

export type Fetched =
  | { ok: true; access: string /** Refreshed within this call or the last minute. */; fresh: boolean }
  | { ok: false; why: "unreadable" | "sign-in" | "upstream"; detail: string };

export class Credentials {
  private readonly cache = new Map<string, PoolCredential>();
  private readonly inflight = new Map<string, { p: Promise<Fetched>; background: boolean }>();
  private readonly refusedAt = new Map<string, number>();
  private readonly refreshedAt = new Map<string, number>();
  private readonly failed = new Map<string, { at: number; n: number; detail: string }>();
  /** Refreshed credentials the store refused, by when each was first refused. */
  private readonly unsaved = new Map<string, number>();
  /** The store, when it was last found shut and how many times running. */
  private shut = { at: Number.NEGATIVE_INFINITY, n: 0 };
  constructor(private readonly deps: CredentialDeps) {}

  /** Put a credential just obtained (login, import) into memory and the store. */
  set(id: string, c: PoolCredential): boolean {
    this.cache.set(id, c);
    this.refusedAt.delete(id);
    this.unsaved.delete(id);
    return this.deps.save(id, c);
  }

  forget(id: string): void {
    this.cache.delete(id);
    this.refusedAt.delete(id);
    this.refreshedAt.delete(id);
    this.failed.delete(id);
    this.unsaved.delete(id);
  }

  /** How many refreshed credentials are in memory only: a restart now signs those
   *  accounts out. */
  pending(): number {
    return this.unsaved.size;
  }

  /** How many of them are recent enough to hold a restart back (UNSAVED_HOLD_MS). */
  holding(): number {
    const now = this.deps.now();
    return [...this.unsaved.values()].filter((since) => now - since < UNSAVED_HOLD_MS).length;
  }

  /** Whether the store can be reached, asked no sooner after a refusal than
   *  STORE_BACKOFF_MS says (`now`: whatever the last refusal). A store that throws is shut. */
  private storeOpen(id: string, now: number, asap = false): boolean {
    const wait = this.shut.n ? (STORE_BACKOFF_MS[Math.min(this.shut.n, STORE_BACKOFF_MS.length) - 1] as number) : 0;
    if (!asap && now - this.shut.at < wait) return false;
    let open = false;
    try {
      open = this.deps.storeOpen ? this.deps.storeOpen(id) : true;
    } catch {}
    this.shut = open ? { at: Number.NEGATIVE_INFINITY, n: 0 } : { at: now, n: this.shut.n + 1 };
    return open;
  }

  /** Into the store; a store that throws has refused. */
  private keep(id: string, c: PoolCredential): boolean {
    try {
      return this.deps.save(id, c);
    } catch {
      return false;
    }
  }

  /** Offer the store every refreshed credential it refused, once it can be reached
   *  (`asap`: asked now, whatever the last refusal). How many it still has not taken. */
  flush(asap = false): number {
    const [first] = this.unsaved.keys();
    if (first === undefined) return 0;
    const now = this.deps.now();
    if (!this.storeOpen(first, now, asap)) return this.unsaved.size;
    for (const id of [...this.unsaved.keys()]) {
      if (!this.keep(id, this.cache.get(id) as PoolCredential)) {
        this.shut = { at: now, n: this.shut.n + 1 };
        break;
      }
      this.unsaved.delete(id);
      this.deps.log(`${id}: refreshed token is in the store now`);
    }
    return this.unsaved.size;
  }

  /** The access token to send now. `force` refreshes whatever the expiry says (a 401
   *  on a token that wasn't fresh). `background`: nobody waits on the answer (the idle
   *  usage poll), so a token that has run out is left so while the store is shut. */
  get(id: string, force = false, background = false): Promise<Fetched> {
    const running = this.inflight.get(id);
    // A request never takes a background call's answer: that one may have left a token
    // that ran out as it was, for nobody waiting, which a request waiting on it would not.
    // It waits for it instead, then asks for itself (a refresh made meanwhile is in memory).
    if (running && (background || !running.background)) return running.p;
    if (running) return running.p.then(() => this.get(id, force, background));
    const p = this.fetch(id, force, background).finally(() => this.inflight.delete(id));
    this.inflight.set(id, { p, background });
    return p;
  }

  private async fetch(id: string, force: boolean, background: boolean): Promise<Fetched> {
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
    this.flush();
    if (!force && c.expires_at - now > REFRESH_EARLY_MS)
      return { ok: true, access: c.access, fresh: now - (this.refreshedAt.get(id) ?? 0) < 60_000 };
    const f = this.failed.get(id);
    if (f && now - f.at < (REFRESH_BACKOFF_MS[Math.min(f.n, REFRESH_BACKOFF_MS.length) - 1] as number)) {
      if (c.expires_at > now) return { ok: true, access: c.access, fresh: false };
      return { ok: false, why: "upstream", detail: f.detail };
    }
    // Due for a refresh. One the store could not keep is only worth making when a request
    // waits on a token that no longer works (see the top of this file).
    const works = !force && c.expires_at > now;
    if ((works || background) && !this.storeOpen(id, now))
      return works
        ? { ok: true, access: c.access, fresh: false }
        : { ok: false, why: "unreadable", detail: "the secrets store cannot be reached; not refreshed" };
    try {
      const next = await this.deps.refresh(c);
      // Removed, or signed in afresh, while the vendor was asked: what came back is nobody's.
      const cur = this.cache.get(id);
      if (cur !== c)
        return cur
          ? { ok: true, access: cur.access, fresh: true }
          : { ok: false, why: "unreadable", detail: "the account was removed while its token was refreshed" };
      this.cache.set(id, next);
      this.failed.delete(id);
      this.refreshedAt.set(id, this.deps.now());
      if (this.keep(id, next)) this.unsaved.delete(id);
      else {
        if (!this.unsaved.has(id)) this.unsaved.set(id, this.deps.now());
        this.deps.log(`${id}: refreshed token kept in memory only; the store refused it`);
      }
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
