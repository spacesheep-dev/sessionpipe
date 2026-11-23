// SPDX-License-Identifier: Apache-2.0
// Access tokens: from the store on demand, cached in memory, refreshed five minutes
// early, one refresh in flight per account, and what each way of failing means.
import { describe, expect, it } from "vitest";
import {
  type CredentialDeps,
  Credentials,
  REFRESH_BACKOFF_MS,
  REFRESH_EARLY_MS,
  STORE_BACKOFF_MS,
  STORE_RETRY_MS,
  UNSAVED_HOLD_MS,
} from "../src/pool/credentials.js";
import type { PoolCredential } from "../src/pool/types.js";

class AuthError extends Error {}
const cred = (n: string, expires_at: number): PoolCredential => ({ access: `a-${n}`, refresh: `r-${n}`, expires_at });

function make(over: Partial<CredentialDeps> = {}) {
  const store = new Map<string, PoolCredential>();
  const log: string[] = [];
  let t = 1_000_000;
  const deps: CredentialDeps = {
    now: () => t,
    load: (id) => store.get(id) ?? null,
    save: (id, c) => {
      store.set(id, c);
      return true;
    },
    refresh: async (c) => ({ access: `${c.access}+`, refresh: c.refresh, expires_at: t + 3_600_000 }),
    isAuthError: (e) => e instanceof AuthError,
    log: (l) => log.push(l),
    ...over,
  };
  return { c: new Credentials(deps), store, log, tick: (ms: number) => (t += ms), now: () => t };
}

describe("Credentials", () => {
  it("reads from the store once, serves from memory, and knows a fresh token", async () => {
    const { c, store, tick } = make();
    store.set("a", cred("a", 1_000_000 + 3_600_000));
    expect(await c.get("a")).toEqual({ ok: true, access: "a-a", fresh: false });
    store.delete("a");
    expect(await c.get("a")).toEqual({ ok: true, access: "a-a", fresh: false });
    tick(3_600_000 - REFRESH_EARLY_MS);
    expect(await c.get("a")).toEqual({ ok: true, access: "a-a+", fresh: true });
    expect(store.get("a")?.access).toBe("a-a+");
    tick(59_000);
    expect(await c.get("a")).toEqual({ ok: true, access: "a-a+", fresh: true });
    tick(2_000);
    expect(await c.get("a")).toEqual({ ok: true, access: "a-a+", fresh: false });
  });
  it("an unreadable store is asked again only after 30 s", async () => {
    const loads: string[] = [];
    const { c, store, tick } = make({
      load: (id) => {
        loads.push(id);
        return store.get(id) ?? null;
      },
    });
    expect(await c.get("a")).toMatchObject({ ok: false, why: "unreadable" });
    store.set("a", cred("a", 9_999_999_999));
    expect(await c.get("a")).toMatchObject({
      ok: false,
      why: "unreadable",
      detail: "credential store unreadable; retrying",
    });
    tick(STORE_RETRY_MS);
    expect(await c.get("a")).toMatchObject({ ok: true, access: "a-a" });
    expect(loads).toEqual(["a", "a"]);
  });
  it("one refresh in flight however many ask; a forced refresh ignores the expiry", async () => {
    let refreshes = 0;
    const { c, store } = make({
      refresh: async (x) => {
        refreshes++;
        await new Promise((r) => setTimeout(r, 5));
        return { ...x, access: `${x.access}+`, expires_at: 9_999_999_999 };
      },
    });
    store.set("a", cred("a", 1_000_000 + 1_000));
    const [x, y] = await Promise.all([c.get("a"), c.get("a")]);
    expect(x).toEqual(y);
    expect(refreshes).toBe(1);
    expect(await c.get("a", true)).toMatchObject({ access: "a-a++", fresh: true });
    expect(refreshes).toBe(2);
  });
  it("a refused refresh is a sign-in; another failure keeps a token that still has time", async () => {
    let fail: Error | null = new AuthError("invalid_grant");
    const { c, store, tick } = make({
      refresh: async () => {
        throw fail;
      },
    });
    store.set("a", cred("a", 1_000_000 + 60_000));
    expect(await c.get("a")).toEqual({ ok: false, why: "sign-in", detail: "invalid_grant" });
    fail = new Error("503");
    expect(await c.get("a")).toEqual({ ok: true, access: "a-a", fresh: false });
    tick(61_000);
    expect(await c.get("a")).toEqual({ ok: false, why: "upstream", detail: "503" });
    fail = Object.assign(new Error(), { message: undefined }) as Error;
    tick(300_000); // past the backoff, so the endpoint is asked again
    expect(await c.get("a")).toMatchObject({ ok: false, why: "upstream" });
  });
  it("set puts a credential in memory and the store; forget drops it", async () => {
    const { c, store } = make({ save: () => false });
    expect(c.set("a", cred("a", 1_000_000 + 3_600_000))).toBe(false);
    expect(store.size).toBe(0);
    expect(await c.get("a")).toMatchObject({ ok: true, access: "a-a" });
    c.forget("a");
    expect(await c.get("a")).toMatchObject({ ok: false, why: "unreadable" });
  });

  // A refresh replaces the sign-in: the old refresh token is dead once it is used. Three
  // accounts were refreshed in the small hours behind a locked keychain, the new tokens
  // lived in memory only, and after the daemon's next start all three needed signing in
  // again (2026-11-22).
  describe("a store that cannot be reached", () => {
    /** A store that can be shut (it then answers no read and takes no write), and how
     *  often it and the vendor were asked. */
    const shuttable = () => {
      const state = { shut: true, refreshes: 0, asks: 0, throws: false };
      const m = make();
      const { store } = m;
      const c = new Credentials({
        now: m.now,
        load: (id) => store.get(id) ?? null,
        save: (id, cr) => {
          if (state.throws) throw new Error("EACCES");
          if (state.shut) return false;
          store.set(id, cr);
          return true;
        },
        storeOpen: () => {
          state.asks++;
          if (state.throws) throw new Error("EACCES");
          return !state.shut;
        },
        refresh: async (cr) => {
          state.refreshes++;
          return { access: `${cr.access}+`, refresh: `${cr.refresh}+`, expires_at: m.now() + 3_600_000 };
        },
        isAuthError: () => false,
        log: (l) => m.log.push(l),
      });
      return { ...m, c, state };
    };

    it("a token that still works is not refreshed while the store could not keep the new one", async () => {
      const { c, store, state, tick, log } = shuttable();
      store.set("a", cred("a", 1_000_000 + 60_000)); // inside the five minutes before it runs out
      expect(await c.get("a")).toEqual({ ok: true, access: "a-a", fresh: false });
      expect(state.refreshes).toBe(0);
      // Asked again at once: the store is not asked a second time inside 30 s.
      expect(await c.get("a")).toEqual({ ok: true, access: "a-a", fresh: false });
      expect(state.asks).toBe(1);
      // The store opens: now it is refreshed, and kept.
      state.shut = false;
      tick(STORE_RETRY_MS);
      expect(await c.get("a")).toEqual({ ok: true, access: "a-a+", fresh: true });
      expect(store.get("a")).toMatchObject({ access: "a-a+", refresh: "r-a+" });
      expect(c.pending()).toBe(0);
      expect(log).toEqual([]);
    });

    it("a shut store is asked again after 30 s, then 60 s, then every five minutes; one that throws is shut", async () => {
      const { c, store, state, tick } = shuttable();
      store.set("a", cred("a", 1_000_000 + 3_600_000));
      tick(3_600_000 + 1); // run out, and nobody waiting from here on
      const asked = async (after: number) => {
        tick(after);
        await c.get("a", false, true);
        return state.asks;
      };
      expect(await asked(0)).toBe(1);
      expect(await asked(STORE_BACKOFF_MS[0] - 1)).toBe(1);
      expect(await asked(1)).toBe(2);
      expect(await asked(STORE_BACKOFF_MS[1] - 1)).toBe(2);
      expect(await asked(1)).toBe(3);
      expect(await asked(STORE_BACKOFF_MS[2] - 1)).toBe(3);
      expect(await asked(1)).toBe(4);
      expect(await asked(STORE_BACKOFF_MS[2])).toBe(5);
      state.throws = true;
      expect(await c.get("a", false, true)).toMatchObject({ ok: false, why: "unreadable" });
      expect(state.refreshes).toBe(0);
    });

    it("with nobody waiting, a token that has run out is left so: the sign-in in the store stays good", async () => {
      const { c, store, state, tick } = shuttable();
      store.set("a", cred("a", 1_000_000 + 60_000));
      tick(120_000);
      expect(await c.get("a", false, true)).toEqual({
        ok: false,
        why: "unreadable",
        detail: "the secrets store cannot be reached; not refreshed",
      });
      expect(state.refreshes).toBe(0);
      expect(store.get("a")).toMatchObject({ refresh: "r-a" });
      state.shut = false;
      tick(STORE_RETRY_MS);
      expect(await c.get("a", false, true)).toEqual({ ok: true, access: "a-a+", fresh: true });
    });

    it("a request waiting on a token that has run out is served; the new sign-in is offered to the store until it is in", async () => {
      const { c, store, state, tick, log } = shuttable();
      store.set("a", cred("a", 1_000_000 + 60_000));
      tick(120_000);
      expect(await c.get("a")).toEqual({ ok: true, access: "a-a+", fresh: true });
      expect(log).toEqual(["a: refreshed token kept in memory only; the store refused it"]);
      expect(c.pending()).toBe(1);
      expect(store.get("a")).toMatchObject({ refresh: "r-a" });
      // Offered again once the store can be reached: asked with one read, backed off as above.
      expect(c.flush()).toBe(1);
      expect(state.asks).toBe(1);
      expect(await c.get("a")).toMatchObject({ ok: true, access: "a-a+" });
      expect(state.asks).toBe(1);
      tick(STORE_RETRY_MS);
      expect(c.flush()).toBe(1);
      expect(state.asks).toBe(2);
      // A stop asks at once, whatever the time.
      expect(c.flush(true)).toBe(1);
      expect(state.asks).toBe(3);
      // The store answers the read but refuses the write (or throws): still owed.
      state.shut = false;
      state.throws = true;
      expect(c.flush(true)).toBe(1);
      state.throws = false;
      expect(c.flush(true)).toBe(0);
      expect(store.get("a")).toMatchObject({ access: "a-a+", refresh: "r-a+" });
      expect(log.at(-1)).toBe("a: refreshed token is in the store now");
      expect(c.flush()).toBe(0);
    });

    it("a store that takes the read and refuses the write after a refresh: kept and owed all the same", async () => {
      let takes = false;
      let throws = true;
      const m = make({
        save: () => {
          // A file that cannot be written throws; a keychain says no.
          if (throws) throw new Error("EROFS: read-only file system");
          return takes;
        },
        storeOpen: () => true,
      });
      m.store.set("a", cred("a", 1_000_000 + 60_000));
      expect(await m.c.get("a")).toEqual({ ok: true, access: "a-a+", fresh: true });
      expect(m.c.pending()).toBe(1);
      throws = false;
      // Refreshed again before the store took the first: owed once, from the first time.
      m.tick(3_600_000);
      expect(await m.c.get("a")).toMatchObject({ ok: true, access: "a-a++" });
      expect(m.c.pending()).toBe(1);
      takes = true;
      m.tick(STORE_BACKOFF_MS[2]);
      expect(m.c.flush()).toBe(0);
    });

    it("holds a restart back for a day and no longer; a token refused upstream is refreshed whatever the store says", async () => {
      const { c, store, tick } = shuttable();
      store.set("a", cred("a", 1_000_000 + 3_600_000));
      expect(c.holding()).toBe(0);
      expect(await c.get("a", true)).toEqual({ ok: true, access: "a-a+", fresh: true });
      expect([c.pending(), c.holding()]).toEqual([1, 1]);
      tick(UNSAVED_HOLD_MS - 1);
      expect(c.holding()).toBe(1);
      tick(1);
      expect([c.pending(), c.holding()]).toEqual([1, 0]);
    });

    it("an account forgotten or signed in afresh is not owed to the store, nor is one removed while the vendor was asked", async () => {
      const { c, store, state, tick } = shuttable();
      store.set("a", cred("a", 1_000_000 + 60_000));
      tick(120_000);
      await c.get("a");
      expect(c.pending()).toBe(1);
      c.forget("a");
      expect(c.pending()).toBe(0);
      store.set("b", cred("b", m0() + 60_000));
      tick(120_000);
      await c.get("b");
      expect(c.pending()).toBe(1);
      state.shut = false;
      expect(c.set("b", cred("b2", m0() + 9_000_000))).toBe(true);
      expect(c.pending()).toBe(0);
      function m0() {
        return 1_000_000 + 120_000;
      }
    });

    it("removed, or signed in afresh, while its refresh was with the vendor: what came back is not kept", async () => {
      let release: (c: PoolCredential) => void = () => {};
      const m = make({
        refresh: (c) =>
          new Promise<PoolCredential>((res) => {
            release = () => res({ access: `${c.access}+`, refresh: `${c.refresh}+`, expires_at: 9_999_999_999 });
          }),
      });
      m.store.set("a", cred("a", 1_000_000 + 60_000));
      const removed = m.c.get("a");
      await Promise.resolve();
      m.c.forget("a");
      m.store.delete("a");
      release(cred("x", 0));
      expect(await removed).toEqual({
        ok: false,
        why: "unreadable",
        detail: "the account was removed while its token was refreshed",
      });
      expect(m.store.has("a")).toBe(false);
      // Signed in afresh meanwhile: the new sign-in is the one used and kept.
      m.store.set("b", cred("b", 1_000_000 + 60_000));
      const replaced = m.c.get("b");
      await Promise.resolve();
      m.c.set("b", cred("b-new", 9_999_999_999));
      release(cred("x", 0));
      expect(await replaced).toEqual({ ok: true, access: "a-b-new", fresh: true });
      expect(m.store.get("b")?.access).toBe("a-b-new");
    });
  });
});

describe("F5: a token endpoint that fails is not asked on every request", () => {
  it("backs off 30 s, 60 s, then 5 min; a token with time left is sent meanwhile; success resets", async () => {
    let calls = 0;
    let down = true;
    const { c, store, tick } = make({
      refresh: async (x) => {
        calls++;
        if (down) throw new Error("503");
        return { ...x, access: `${x.access}+`, expires_at: 9_999_999_999 };
      },
    });
    store.set("a", cred("a", 1_000_000 + 10_000));
    expect(await c.get("a")).toEqual({ ok: true, access: "a-a", fresh: false });
    expect(await c.get("a")).toEqual({ ok: true, access: "a-a", fresh: false });
    expect(calls).toBe(1);
    tick(11_000); // expired now
    expect(await c.get("a")).toEqual({ ok: false, why: "upstream", detail: "503" });
    expect(calls).toBe(1);
    tick(REFRESH_BACKOFF_MS[0]);
    expect(await c.get("a")).toMatchObject({ ok: false, why: "upstream" });
    expect(calls).toBe(2);
    tick(REFRESH_BACKOFF_MS[1] - 1);
    await c.get("a");
    expect(calls).toBe(2);
    tick(1);
    await c.get("a");
    expect(calls).toBe(3);
    tick(REFRESH_BACKOFF_MS[2] - 1);
    await c.get("a");
    expect(calls).toBe(3);
    tick(1);
    await c.get("a");
    expect(calls).toBe(4);
    tick(REFRESH_BACKOFF_MS[2]);
    down = false;
    expect(await c.get("a")).toMatchObject({ ok: true, access: "a-a+", fresh: true });
    c.forget("a");
    store.set("a", cred("a", 1));
    down = true;
    await c.get("a");
    await c.get("a");
    expect(calls).toBe(6); // forget() cleared the backoff: one new try, the second call inside its window
  });
});
