// SPDX-License-Identifier: Apache-2.0
// The routing policy (DESIGN decision 4), table by table: who has room, who a request
// goes to, what a pinned session does, what a 429, a 5xx, an error and fresh numbers
// change, when a pin expires, and what the summary says.
import { describe, expect, it } from "vitest";
import {
  type AccountState,
  choose,
  expirePins,
  HOLD_MS,
  hasRoom,
  MAX_HOLD_MS,
  observe,
  PIN_IDLE_MS,
  PINS_MAX,
  type PolicyState,
  pin,
  REJECTED_MS,
  roomAt,
  summary,
  withRoom,
} from "../../cli/src/pool/policy.js";

const T0 = Date.parse("2026-10-29T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const acct = (id: string, over: Partial<AccountState> = {}): AccountState => ({ id, enabled: true, ...over });
const st = (accounts: AccountState[], pins: PolicyState["pins"] = {}): PolicyState => ({ accounts, pins });

describe("room", () => {
  const cases: [string, Partial<AccountState>, boolean, number | null][] = [
    ["nothing known yet", {}, true, null],
    ["disabled", { enabled: false }, false, null],
    ["in error", { error: "sign in again" }, false, null],
    ["held until later", { hold_until: T0 + 5_000 }, false, T0 + 5_000],
    ["a hold that ran out", { hold_until: T0 - 1 }, true, null],
    ["a window at 97", { limits: { windows: [{ id: "five_hour", used_percent: 97 }] } }, true, null],
    [
      "a window at 98 that resets later",
      { limits: { windows: [{ id: "five_hour", used_percent: 98, resets_at: iso(T0 + 60_000) }] } },
      false,
      T0 + 60_000,
    ],
    [
      "a window at 100 whose reset passed",
      { limits: { windows: [{ id: "five_hour", used_percent: 100, resets_at: iso(T0 - 1) }] } },
      true,
      null,
    ],
    [
      "a full window naming no reset",
      { limits: { windows: [{ id: "seven_day", used_percent: 99 }] } },
      false,
      T0 + HOLD_MS,
    ],
    [
      "a full window with an unreadable reset",
      { limits: { windows: [{ id: "seven_day", used_percent: 99, resets_at: "soon" }] } },
      false,
      T0 + HOLD_MS,
    ],
    [
      "two full windows: room when the later one resets",
      {
        limits: {
          windows: [
            { id: "five_hour", used_percent: 100, resets_at: iso(T0 + 1_000) },
            { id: "seven_day", used_percent: 98, resets_at: iso(T0 + 9_000) },
          ],
        },
      },
      false,
      T0 + 9_000,
    ],
    [
      "status rejected, windows under the line: until the last reset",
      {
        limits: {
          status: "rejected",
          windows: [
            { id: "five_hour", used_percent: 50, resets_at: iso(T0 + 2_000) },
            { id: "seven_day", used_percent: 10, resets_at: iso(T0 + 3_000) },
          ],
        },
      },
      false,
      T0 + 3_000,
    ],
    [
      "status rejected with no reset named, seen just now",
      { limits: { status: "rejected", windows: [] }, limits_at: T0 },
      false,
      T0 + REJECTED_MS,
    ],
    [
      "status rejected with no reset and no time seen",
      { limits: { status: "rejected", windows: [] } },
      false,
      T0 + REJECTED_MS,
    ],
    [
      "status rejected whose resets all passed",
      { limits: { status: "rejected", windows: [{ id: "five_hour", used_percent: 50, resets_at: iso(T0 - 5) }] } },
      true,
      null,
    ],
    [
      "status allowed_warning",
      { limits: { status: "allowed_warning", windows: [{ id: "five_hour", used_percent: 80 }] } },
      true,
      null,
    ],
    [
      "a hold and a window: the later wins",
      {
        hold_until: T0 + 90_000,
        limits: { windows: [{ id: "five_hour", used_percent: 99, resets_at: iso(T0 + 10_000) }] },
      },
      false,
      T0 + 90_000,
    ],
  ];
  it.each(cases)("%s", (_name, over, room, at) => {
    const a = acct("a", over);
    expect(hasRoom(a, T0)).toBe(room);
    expect(roomAt(a, T0)).toBe(at);
  });
});

describe("choose", () => {
  const full = { limits: { windows: [{ id: "five_hour", used_percent: 100, resets_at: iso(T0 + 3_600_000) }] } };
  it("walks the order and takes the first with room", () => {
    const s = st([acct("a", full), acct("b", { enabled: false }), acct("c"), acct("d")]);
    expect(choose(s, { now: T0 })).toMatchObject({ account: { id: "c" }, reason: "first-with-room" });
    expect(choose(s, { now: T0, session: "s1" })).toMatchObject({ account: { id: "c" }, reason: "first-with-room" });
  });
  it("a pinned session stays on its account while it has room, even when it isn't first", () => {
    const s = st([acct("a"), acct("b")], { s1: { account: "b", used: T0 } });
    expect(choose(s, { now: T0, session: "s1" })).toMatchObject({ account: { id: "b" }, reason: "pinned" });
    expect(choose(s, { now: T0, session: "s2" })).toMatchObject({ account: { id: "a" }, reason: "first-with-room" });
  });
  it("a pinned session moves when its account loses room", () => {
    const s = st([acct("a"), acct("b", full)], { s1: { account: "b", used: T0 } });
    expect(choose(s, { now: T0, session: "s1" })).toMatchObject({ account: { id: "a" }, reason: "moved" });
  });
  it("a pin to an account no longer in the pool is a move", () => {
    const s = st([acct("a")], { s1: { account: "gone", used: T0 } });
    expect(choose(s, { now: T0, session: "s1" })).toMatchObject({ account: { id: "a" }, reason: "moved" });
  });
  it("an excluded account is skipped, pinned or not", () => {
    const s = st([acct("a"), acct("b")], { s1: { account: "a", used: T0 } });
    expect(choose(s, { now: T0, session: "s1", exclude: ["a"] })).toMatchObject({
      account: { id: "b" },
      reason: "moved",
    });
    expect(choose(s, { now: T0, exclude: ["a", "b"] })).toEqual({ account: null, reason: "none" });
  });
  it("nobody with room is none", () => {
    expect(choose(st([acct("a", full), acct("b", { error: "x" })]), { now: T0, session: "s" })).toEqual({
      account: null,
      reason: "none",
    });
    expect(choose(st([]), { now: T0 })).toEqual({ account: null, reason: "none" });
  });
});

describe("pins", () => {
  it("pin records a uuid-shaped session; no session, or a caller's string, no pin (SECURITY M4)", () => {
    const s = st([acct("a")]);
    pin(s, undefined, "a", T0);
    pin(s, "s1", "a", T0);
    pin(s, "x".repeat(4000), "a", T0);
    pin(s, "aaaaaaaa-0000-4000-8000-00000000000g", "a", T0);
    expect(s.pins).toEqual({});
    pin(s, "aaaaaaaa-0000-4000-8000-000000000001", "a", T0);
    pin(s, "AAAAAAAA-0000-4000-8000-000000000001", "a", T0 + 1);
    expect(Object.keys(s.pins).length).toBe(2);
  });
  it("pins are capped; the one used longest ago goes first (SECURITY M4)", () => {
    const s = st([acct("a")]);
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    for (let n = 0; n < PINS_MAX; n++) pin(s, id(n), "a", T0 + n);
    expect(Object.keys(s.pins).length).toBe(PINS_MAX);
    pin(s, id(7), "a", T0 + PINS_MAX); // used again: now the freshest, not a new pin
    pin(s, id(0), "a", T0 + PINS_MAX); // the first inserted is no longer the oldest
    pin(s, id(PINS_MAX), "a", T0 + PINS_MAX + 1);
    expect(Object.keys(s.pins).length).toBe(PINS_MAX);
    expect(s.pins[id(1)]).toBeUndefined();
    expect(s.pins[id(0)]).toBeDefined();
    expect(s.pins[id(7)]).toBeDefined();
    expect(s.pins[id(PINS_MAX)]).toBeDefined();
  });
  it("expire drops pins idle for 30 minutes and pins to accounts that left", () => {
    const s = st([acct("a")], {
      fresh: { account: "a", used: T0 - PIN_IDLE_MS + 1 },
      idle: { account: "a", used: T0 - PIN_IDLE_MS },
      gone: { account: "z", used: T0 },
    });
    expect(expirePins(s, T0)).toBe(2);
    expect(Object.keys(s.pins)).toEqual(["fresh"]);
    expect(expirePins(s, T0)).toBe(0);
  });
});

describe("observe", () => {
  it("an unknown account is ignored", () => {
    const s = st([acct("a")]);
    expect(observe(s, "zz", { windows: [] }, T0)).toBe(false);
  });
  it("fresh numbers replace the old; the answer says whether they changed", () => {
    const s = st([acct("a", { hold_until: T0 - 1 })]);
    const w = { windows: [{ id: "five_hour", used_percent: 10 }], status: "allowed", observed_at: T0 };
    expect(observe(s, "a", w, T0)).toBe(true);
    expect(s.accounts[0]).toEqual({
      id: "a",
      enabled: true,
      limits: { windows: w.windows, status: "allowed" },
      limits_at: T0,
    });
    expect(observe(s, "a", { ...w, observed_at: T0 + 1 }, T0 + 1)).toBe(false);
    expect(observe(s, "a", { windows: w.windows }, T0 + 2)).toBe(true);
    expect(s.accounts[0]?.limits).toEqual({ windows: w.windows });
    expect(observe(s, "a", { windows: [{ id: "five_hour", used_percent: 11 }] }, T0 + 3)).toBe(true);
  });
  it("a status or a reset alone keeps the windows known so far and changes no numbers", () => {
    const s = st([acct("a"), acct("b", { limits: { windows: [{ id: "five_hour", used_percent: 40 }] } })]);
    expect(
      observe(s, "a", { windows: [], status: "rejected", claim: "seven_day", resets_at: iso(T0 + 5_000) }, T0),
    ).toBe(false);
    expect(s.accounts[0]?.limits).toEqual({
      windows: [],
      status: "rejected",
      claim: "seven_day",
      resets_at: iso(T0 + 5_000),
    });
    expect(roomAt(s.accounts[0] as AccountState, T0)).toBe(T0 + 5_000);
    expect(summary(s, T0)[0]).toMatchObject({ status: "limited", limited_by: "seven_day", until: iso(T0 + 5_000) });
    expect(observe(s, "b", { windows: [], status: "allowed" }, T0)).toBe(false);
    expect(s.accounts[1]?.limits).toEqual({ windows: [{ id: "five_hour", used_percent: 40 }], status: "allowed" });
    expect(hasRoom(s.accounts[1] as AccountState, T0)).toBe(true);
  });
  it("a live hold outlasts fresh numbers", () => {
    const s = st([acct("a", { hold_until: T0 + 5_000 })]);
    observe(s, "a", { windows: [{ id: "five_hour", used_percent: 1 }] }, T0);
    expect(hasRoom(s.accounts[0] as AccountState, T0)).toBe(false);
  });
  it("a 429 holds until Retry-After, else the nearest future reset, else a minute; never shortens a hold", () => {
    const s = st([
      acct("a"),
      acct("b", {
        limits: {
          windows: [
            { id: "five_hour", used_percent: 50, resets_at: iso(T0 + 7_000) },
            { id: "seven_day", used_percent: 1, resets_at: iso(T0 - 1) },
          ],
        },
      }),
      acct("c"),
      acct("d", { hold_until: T0 + 99_000 }),
    ]);
    expect(observe(s, "a", { status: 429, retryAfterMs: 3_000 }, T0)).toBe(false);
    expect(s.accounts[0]?.hold_until).toBe(T0 + 3_000);
    observe(s, "b", { status: 429 }, T0);
    expect(s.accounts[1]?.hold_until).toBe(T0 + 7_000);
    observe(s, "c", { status: 429 }, T0);
    expect(s.accounts[2]?.hold_until).toBe(T0 + HOLD_MS);
    observe(s, "d", { status: 429, retryAfterMs: 1 }, T0);
    expect(s.accounts[3]?.hold_until).toBe(T0 + 99_000);
    // A Retry-After of a year is believed for an hour (SECURITY L3).
    observe(s, "c", { status: 429, retryAfterMs: 365 * 24 * 3_600_000 }, T0 + 1);
    expect(s.accounts[2]?.hold_until).toBe(T0 + 1 + MAX_HOLD_MS);
  });
  it("a 5xx rests the account a minute", () => {
    const s = st([acct("a")]);
    expect(observe(s, "a", { upstream5xx: true }, T0)).toBe(false);
    expect(s.accounts[0]?.hold_until).toBe(T0 + HOLD_MS);
    observe(s, "a", { upstream5xx: true }, T0 - 50_000);
    expect(s.accounts[0]?.hold_until).toBe(T0 + HOLD_MS);
  });
  it("an error is set and cleared by name", () => {
    const s = st([acct("a")]);
    expect(observe(s, "a", { error: "sign in again" }, T0)).toBe(false);
    expect(s.accounts[0]?.error).toBe("sign in again");
    observe(s, "a", { error: null }, T0);
    expect(s.accounts[0]?.error).toBeUndefined();
  });
});

describe("summary", () => {
  it("one status word per account, one current, until when limited", () => {
    const s = st([
      acct("a", {
        limits: {
          windows: [
            { id: "five_hour", used_percent: 100, resets_at: iso(T0 + 60_000) },
            { id: "seven_day", used_percent: 20 },
          ],
        },
      }),
      acct("b", { enabled: false }),
      acct("c", { error: "sign in again", limits: { windows: [] } }),
      acct("d", { limits: { windows: [{ id: "five_hour", used_percent: 3 }] } }),
      acct("e"),
    ]);
    const aw = s.accounts[0]?.limits?.windows;
    expect(summary(s, T0)).toEqual([
      {
        id: "a",
        status: "limited",
        current: false,
        until: iso(T0 + 60_000),
        used_percent: 100,
        windows: aw,
        limited_by: "five_hour",
      },
      { id: "b", status: "disabled", current: false },
      { id: "c", status: "error", current: false, limited_by: "error" },
      { id: "d", status: "ready", current: true, used_percent: 3, windows: [{ id: "five_hour", used_percent: 3 }] },
      { id: "e", status: "ready", current: false },
    ]);
    expect(withRoom(s, T0)).toBe(2);
    expect(summary(st([]), T0)).toEqual([]);
  });
  it("limited_by names the window that resets last, or rejected for a hold or a status", () => {
    const two = st([
      acct("a", {
        limits: {
          windows: [
            { id: "five_hour", used_percent: 99, resets_at: iso(T0 + 1_000) },
            { id: "seven_day", used_percent: 98 },
          ],
        },
      }),
      acct("b", { hold_until: T0 + 5_000, limits: { windows: [{ id: "five_hour", used_percent: 1 }] } }),
      acct("c", { limits: { status: "rejected", windows: [] }, limits_at: T0 }),
      acct("d", { hold_until: T0 + 1 }),
      acct("e", {
        limits: {
          windows: [
            { id: "seven_day", used_percent: 98, resets_at: iso(T0 + 9_000) },
            { id: "five_hour", used_percent: 99, resets_at: iso(T0 + 1_000) },
          ],
        },
      }),
    ]);
    expect(summary(two, T0).map((x) => x.limited_by)).toEqual([
      "seven_day",
      "rejected",
      "rejected",
      "rejected",
      "seven_day",
    ]);
    expect(summary(two, T0)[2]?.windows).toBeUndefined();
  });
});
