// SPDX-License-Identifier: Apache-2.0
// Adding accounts: a PKCE login in two steps with a ten-minute pending window, and the
// import of every Claude Code login on the machine, deduped by account uuid.
import { describe, expect, it } from "vitest";
import { importLogins } from "../src/pool/import.js";
import { accountFor, accountId, beginLogin, completeLogin, LOGIN_TTL_MS, pendingLogin } from "../src/pool/login.js";
import type { PoolAccount } from "../src/pool/store.js";
import { credential, fakeAdapter, uuidOf } from "./helpers/pool-fake.js";

const T0 = Date.parse("2026-10-29T10:00:00Z");
const existing: PoolAccount = {
  id: accountId(uuidOf("one")),
  email: "one@x.y",
  account_uuid: uuidOf("one"),
  enabled: true,
  added_at: "x",
};

describe("login", () => {
  it("begin keeps the verifier and a ten-minute window; the id is not the state", () => {
    const a = fakeAdapter();
    const p = beginLogin(a, T0, () => Buffer.from("st4te"));
    expect(p).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{8}$/),
      url: "https://claude.ai/oauth/authorize?state=st4te",
      verifier: "v-st4te",
      state: "st4te",
      expires_at: T0 + LOGIN_TTL_MS,
    });
    expect(p.id).not.toBe("st4te");
    expect(beginLogin(a, T0).state).toBe("r4nd0m");
  });
  it("pendingLogin: none, another id, run out, or the one", () => {
    const p = beginLogin(fakeAdapter(), T0);
    expect(pendingLogin(undefined, undefined, T0)).toEqual({ why: "no_pending" });
    expect(pendingLogin(p, "other", T0)).toEqual({ why: "unknown_login" });
    expect(pendingLogin(p, p.id, T0 + LOGIN_TTL_MS)).toEqual({ why: "login_expired" });
    expect(pendingLogin(p, undefined, T0 + 1)).toEqual({ pending: p });
    expect(pendingLogin(p, p.id, T0 + 1)).toEqual({ pending: p });
  });
  it("accountFor makes a record once per account uuid and brings an old one's email up to date", () => {
    expect(accountFor([existing], { account_uuid: uuidOf("two"), email: "two@x.y" }, T0)).toEqual({
      account: {
        id: accountId(uuidOf("two")),
        email: "two@x.y",
        account_uuid: uuidOf("two"),
        enabled: true,
        added_at: new Date(T0).toISOString(),
      },
      existed: false,
    });
    expect(accountFor([existing], { account_uuid: uuidOf("one"), email: "new@x.y" }, T0)).toEqual({
      account: { ...existing, email: "new@x.y" },
      existed: true,
    });
    expect(accountFor([existing], { account_uuid: uuidOf("one"), email: "" }, T0).account.email).toBe("one@x.y");
  });
  it("complete trades the pasted code for a credential and a record; a bad code is the adapter's error", async () => {
    const a = fakeAdapter();
    const p = beginLogin(a, T0);
    a.logins.set("c0de", {
      credential: credential("two"),
      profile: { account_uuid: uuidOf("two"), email: "two@x.y", plan: "max" },
    });
    const r = await completeLogin(a, globalThis.fetch, p, "  c0de#r4nd0m \n", [existing], T0);
    expect(r).toMatchObject({
      existed: false,
      credential: credential("two"),
      account: { email: "two@x.y", account_uuid: uuidOf("two") },
    });
    await expect(completeLogin(a, globalThis.fetch, p, "c0de#wrong", [], T0)).rejects.toThrow("state mismatch");
    await expect(completeLogin(a, globalThis.fetch, p, "nope#r4nd0m", [], T0)).rejects.toThrow("bad code");
  });
});

describe("import", () => {
  it("adds every login not pooled yet, once per account", () => {
    const logins = [
      { dir: "/h/.claude", account_uuid: uuidOf("one"), email: "one@x.y", credential: credential("one") },
      { dir: "/h/.claude-work", account_uuid: uuidOf("two"), email: "two@x.y", credential: credential("two") },
      { dir: "/h/.claude-again", account_uuid: uuidOf("two"), email: "two@x.y", credential: credential("two2") },
      { dir: "/h/.claude-3", account_uuid: uuidOf("three"), email: "three@x.y", credential: credential("three") },
    ];
    const r = importLogins(logins, [existing], T0);
    expect(r.added.map((x) => [x.account.email, x.dir, x.credential.access])).toEqual([
      ["two@x.y", "/h/.claude-work", "access-two"],
      ["three@x.y", "/h/.claude-3", "access-three"],
    ]);
    expect(r.skipped).toEqual([
      { email: "one@x.y", dir: "/h/.claude", why: "already in the pool" },
      { email: "two@x.y", dir: "/h/.claude-again", why: "same account as another dir" },
    ]);
    expect(importLogins([], [], T0)).toEqual({ added: [], skipped: [] });
  });
});
