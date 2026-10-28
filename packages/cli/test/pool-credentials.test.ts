// SPDX-License-Identifier: Apache-2.0
// Access tokens: from the store on demand, cached in memory, refreshed five minutes
// early, one refresh in flight per account, and what each way of failing means.
import { describe, expect, it } from "vitest";
import { type CredentialDeps, Credentials, REFRESH_EARLY_MS, STORE_RETRY_MS } from "../src/pool/credentials.js";
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
    expect(await c.get("a")).toMatchObject({ ok: false, why: "upstream" });
  });
  it("set puts a credential in memory and the store; forget drops it; a store that refuses is logged", async () => {
    const { c, store, log } = make({ save: () => false });
    expect(c.set("a", cred("a", 1_000_000 + 1_000))).toBe(false);
    expect(store.size).toBe(0);
    expect(await c.get("a")).toMatchObject({ ok: true, access: "a-a+" });
    expect(log).toEqual(["a: refreshed token kept in memory only; the store refused it"]);
    c.forget("a");
    expect(await c.get("a")).toMatchObject({ ok: false, why: "unreadable" });
  });
});
