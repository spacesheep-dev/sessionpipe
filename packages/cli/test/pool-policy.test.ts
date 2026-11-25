// SPDX-License-Identifier: Apache-2.0
// The routing policy (DESIGN decision 4), table by table: who has room, who a request
// goes to, what a pinned session does, what a 429, a 5xx, an error and fresh numbers
// change, when a pin expires, and what the summary says.
import { describe, expect, it } from "vitest";
import {
  type AccountState,
  type Apart,
  choose,
  expirePins,
  FRESH_MS,
  fromResponse,
  fromUsage,
  HOLD_MS,
  hasRoom,
  KEEP_MS,
  MAX_HOLD_MS,
  observe,
  PIN_IDLE_MS,
  PINS_MAX,
  type PolicyState,
  pin,
  pollDue,
  REJECTED_MS,
  roomAt,
  SWITCH_PERCENT,
  see,
  shownOf,
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
  it("F9: a hold set in the future (the clock went back) is cut to a minute, not stretched", () => {
    const s = st([acct("a"), acct("b")]);
    observe(s, "a", { status: 429, retryAfterMs: 300_000 }, T0);
    expect(s.accounts[0]).toMatchObject({ hold_until: T0 + 300_000, hold_at: T0, hold_why: "limit" });
    expect(roomAt(s.accounts[0] as AccountState, T0 - 3_600_000)).toBe(T0 - 3_600_000 + HOLD_MS);
    expect(roomAt(s.accounts[0] as AccountState, T0 + 1)).toBe(T0 + 300_000);
    // An old state.json with no hold_at keeps the absolute time.
    s.accounts[1]!.hold_until = T0 + 300_000;
    expect(roomAt(s.accounts[1] as AccountState, T0 - 3_600_000)).toBe(T0 + 300_000);
    // Fresh numbers tidy a hold that ran out, with its time.
    observe(s, "a", { windows: [{ id: "five_hour", used_percent: 1 }] }, T0 + 300_000);
    expect(s.accounts[0]!.hold_at).toBeUndefined();
    expect(s.accounts[0]!.hold_why).toBeUndefined();
    // A rest after a limit keeps the limit's reason; a rest on its own is a rest.
    observe(s, "a", { status: 429, retryAfterMs: 1_000 }, T0);
    observe(s, "a", { upstream5xx: true }, T0);
    expect(s.accounts[0]!.hold_why).toBe("limit");
    observe(s, "b", { upstream5xx: true }, T0);
    expect(s.accounts[1]!.hold_why).toBe("upstream");
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

describe("see: what an account shows", () => {
  const W = (id: string, used_percent: number, at?: number) => ({
    id,
    used_percent,
    ...(at !== undefined ? { resets_at: iso(at) } : {}),
  });
  const WEEK = T0 + 7 * 86_400_000;
  const list = [
    W("five_hour", 8, T0 + 3_600_000),
    W("seven_day", 41, WEEK),
    W("seven_day_sonnet", 17, WEEK),
    W("seven_day_fable", 33.5, WEEK),
    W("extra_usage", 12.5),
  ];
  it("an unknown account, or no window, shows nothing new", () => {
    const s = st([acct("a")]);
    expect(see(s, "zz", { windows: list }, "usage", T0)).toBe(false);
    expect(see(s, "a", { windows: [], status: "allowed" }, "response", T0)).toBe(false);
    expect(s.accounts[0]).toEqual({ id: "a", enabled: true });
    expect(shownOf(s.accounts[0] as AccountState)).toEqual([]);
  });
  it("the usage endpoint's answer is the list; a response puts its numbers over it and keeps the rest", () => {
    const s = st([acct("a")]);
    expect(see(s, "a", { windows: list }, "usage", T0)).toBe(true);
    expect(s.accounts[0]).toMatchObject({ shown: list, usage_at: T0 });
    // The same list again changes nothing (no limits.observed for it).
    expect(see(s, "a", { windows: list }, "usage", T0 + 1)).toBe(false);
    expect(s.accounts[0]?.usage_at).toBe(T0 + 1);
    // A response names three windows, one of them new to the list: it goes after the
    // last limit, before the Extra usage; the Sonnet week and Extra usage stay.
    const headers = [W("five_hour", 9, T0 + 3_600_000), W("seven_day", 41, WEEK), W("seven_day_opus", 3, WEEK)];
    expect(see(s, "a", { windows: headers, status: "allowed" }, "response", T0 + 60_000)).toBe(true);
    expect(shownOf(s.accounts[0] as AccountState)).toEqual([
      W("five_hour", 9, T0 + 3_600_000),
      W("seven_day", 41, WEEK),
      W("seven_day_sonnet", 17, WEEK),
      W("seven_day_fable", 33.5, WEEK),
      W("seven_day_opus", 3, WEEK),
      W("extra_usage", 12.5),
    ]);
    // The next response with the same numbers changes nothing: the windows it keeps
    // are the same windows, so a busy account does not get one event per response.
    expect(see(s, "a", { windows: headers }, "response", T0 + 61_000)).toBe(false);
    // The endpoint stops listing the Sonnet week: the next poll's list is the list.
    expect(see(s, "a", { windows: list.filter((w) => w.id !== "seven_day_sonnet") }, "usage", T0 + 300_000)).toBe(true);
    expect(shownOf(s.accounts[0] as AccountState).map((w) => w.id)).toEqual([
      "five_hour",
      "seven_day",
      "seven_day_fable",
      "extra_usage",
    ]);
  });
  it("a kept window goes once it has reset, and all of them once the endpoint has not answered for KEEP_MS", () => {
    const s = st([acct("a")]);
    see(s, "a", { windows: [W("five_hour", 8, T0 + 60_000), W("seven_day_fable", 100, T0 + 120_000)] }, "usage", T0);
    // Fable's week reset at T0 + 2 min; the response at T0 + 3 min does not name it.
    expect(see(s, "a", { windows: [W("five_hour", 1, T0 + 3_600_000)] }, "response", T0 + 180_000)).toBe(true);
    expect(shownOf(s.accounts[0] as AccountState)).toEqual([W("five_hour", 1, T0 + 3_600_000)]);
    // A list whose last answer is too old: polls failing (the endpoint signed out, or
    // down) while responses keep coming show what the responses carry, as before.
    see(s, "a", { windows: [W("five_hour", 8), W("seven_day_sonnet", 50, WEEK)] }, "usage", T0);
    expect(see(s, "a", { windows: [W("five_hour", 2)] }, "response", T0 + KEEP_MS)).toBe(true);
    expect(shownOf(s.accounts[0] as AccountState).map((w) => w.id)).toEqual(["five_hour", "seven_day_sonnet"]);
    expect(see(s, "a", { windows: [W("five_hour", 2)] }, "response", T0 + KEEP_MS + 1)).toBe(true);
    expect(shownOf(s.accounts[0] as AccountState)).toEqual([W("five_hour", 2)]);
  });
  it("an account from a state file before `shown` shows its numbers, then each response's, until a poll", () => {
    const s = st([acct("a", { limits: { windows: [W("five_hour", 5), W("seven_day", 6)] }, limits_at: T0 })]);
    expect(summary(s, T0)[0]?.windows).toEqual([W("five_hour", 5), W("seven_day", 6)]);
    expect(see(s, "a", { windows: [W("five_hour", 5), W("seven_day", 6)] }, "response", T0)).toBe(false);
    expect(see(s, "a", { windows: [W("seven_day", 7)] }, "response", T0)).toBe(true);
    expect(s.accounts[0]?.shown).toEqual([W("seven_day", 7)]);
  });
  it("never more than eight: past eight, what is no known limit goes first", () => {
    const s = st([acct("a")]);
    const junk = "abcdefg".split("").map((k) => W(k, 1));
    see(s, "a", { windows: [W("five_hour", 1), ...junk] }, "usage", T0);
    expect(shownOf(s.accounts[0] as AccountState)).toHaveLength(8);
    see(s, "a", { windows: [W("seven_day", 2), W("seven_day_fable", 3)] }, "response", T0 + 1);
    expect(shownOf(s.accounts[0] as AccountState).map((w) => w.id)).toEqual([
      "five_hour",
      "seven_day",
      "seven_day_fable",
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });
  it("a reading the same again keeps its object; a poll near a fresher response's number leaves it", () => {
    const s = st([acct("a")]);
    const R = T0 + 3_600_000;
    see(s, "a", { windows: [W("five_hour", 10.2, R), W("seven_day", 40, WEEK)] }, "response", T0);
    const kept = shownOf(s.accounts[0] as AccountState)[0];
    // The usage endpoint's reset, to the microsecond: the same reset. Its whole percent
    // (10) beside a response's 10.2 a minute old: the response's stays.
    const poll = {
      windows: [{ id: "five_hour", used_percent: 10, resets_at: iso(R + 565) }, W("seven_day", 40, WEEK + 565)],
    };
    expect(see(s, "a", poll, "usage", T0 + 60_000)).toBe(false);
    expect(shownOf(s.accounts[0] as AccountState)[0]).toBe(kept);
    // A point or more apart, or the response FRESH_MS old: the poll's number is taken.
    expect(see(s, "a", { windows: [W("five_hour", 11.2, R), W("seven_day", 40, WEEK)] }, "usage", T0 + 120_000)).toBe(
      true,
    );
    see(s, "a", { windows: [W("five_hour", 10.2, R)] }, "response", T0 + 180_000);
    expect(see(s, "a", { windows: [W("five_hour", 10, R)] }, "usage", T0 + 180_000 + FRESH_MS)).toBe(true);
    // A response that reads the same keeps the object too, its reset in whole seconds.
    const was = shownOf(s.accounts[0] as AccountState)[0];
    expect(see(s, "a", { windows: [W("five_hour", 10, R)] }, "response", T0 + 200_000 + FRESH_MS)).toBe(false);
    expect(shownOf(s.accounts[0] as AccountState)[0]).toBe(was);
    // A reset and none are not the same reading; a length is part of it.
    expect(see(s, "a", { windows: [W("five_hour", 10)] }, "response", T0 + 210_000 + FRESH_MS)).toBe(true);
    expect(
      see(s, "a", { windows: [{ ...W("five_hour", 10), window_minutes: 300 }] }, "response", T0 + 220_000 + FRESH_MS),
    ).toBe(true);
    // The heard times are the process's own: never written down (store.ts keepStanding).
    expect(s.accounts[0]?.heard?.five_hour).toBe(T0 + 220_000 + FRESH_MS);
  });
  it("a poll's number is taken over a close response's when its reset differs, or when it reaches the judged level", () => {
    const s = st([acct("a")]);
    const R1 = T0 + 60_000;
    const R2 = T0 + 5 * 3_600_000;
    see(s, "a", { windows: [W("five_hour", 0.5, R1)] }, "response", T0);
    // R1 has passed; a minute later the poll says 0 with the new reset: taken, under a point or not.
    expect(see(s, "a", { windows: [W("five_hour", 0, R2)] }, "usage", T0 + 120_000)).toBe(true);
    expect(shownOf(s.accounts[0] as AccountState)).toEqual([W("five_hour", 0, R2)]);
    // A response at 99.5, then a poll at 100 for the same reset: the poll's, the account is full.
    see(s, "a", { windows: [W("seven_day", 99.5, WEEK)] }, "response", T0 + 130_000);
    expect(see(s, "a", { windows: [W("seven_day", SWITCH_PERCENT + 2, WEEK)] }, "usage", T0 + 140_000)).toBe(true);
    expect(shownOf(s.accounts[0] as AccountState)).toEqual([W("seven_day", SWITCH_PERCENT + 2, WEEK)]);
  });
  it("a window no response names, read by two polls with resets a few hundred ms apart, is unchanged: no event", () => {
    const s = st([acct("a")]);
    const first = { id: "seven_day_fable", used_percent: 30, resets_at: iso(WEEK + 120) };
    see(s, "a", { windows: [], shown: [first] }, "usage", T0);
    const again = { windows: [], shown: [{ ...first, resets_at: iso(WEEK + 565) }] };
    expect(see(s, "a", again, "usage", T0 + 300_000)).toBe(false);
    expect(fromUsage(s, "a", again, T0 + 600_000, T0 + 600_000, false)).toBeNull();
    expect(shownOf(s.accounts[0] as AccountState)[0]).toBe(first);
  });
  it("past eight a full window is kept first: the window an account is limited by is one it shows", () => {
    const s = st([acct("a")]);
    const list = [
      "five_hour",
      "seven_day",
      "seven_day_opus",
      "seven_day_sonnet",
      "seven_day_x",
      "seven_day_y",
      "seven_day_z",
      "seven_day_w",
    ];
    see(s, "a", { windows: [], shown: [...list.map((id) => W(id, 1)), W("extra_usage", 100)] }, "usage", T0);
    expect(shownOf(s.accounts[0] as AccountState).map((w) => w.id)).toEqual([...list.slice(0, 7), "extra_usage"]);
  });
  it("the usage answer and a response a point or more apart for the same reset, since the last poll, are noted", () => {
    const s = st([acct("a")]);
    const apart: Apart[] = [];
    see(s, "a", { windows: [W("seven_day_fable", 33, WEEK)] }, "usage", T0, apart);
    see(s, "a", { windows: [W("seven_day_fable", 30, WEEK), W("five_hour", 5, T0 + 60_000)] }, "response", T0 + 1);
    see(
      s,
      "a",
      { windows: [W("seven_day_fable", 33, WEEK), W("five_hour", 0, T0 + 5 * 3_600_000)] },
      "usage",
      T0 + 300_000,
      apart,
    );
    // Fable apart; the 5-hour window reset in between, so its numbers are not compared.
    expect(apart).toEqual([{ id: "seven_day_fable", response: 30, usage: 33 }]);
    // The next poll, no response since: the poll's own number, nothing to note.
    see(s, "a", { windows: [W("seven_day_fable", 34, WEEK)] }, "usage", T0 + 600_000, apart);
    expect(apart).toHaveLength(1);
  });
  it("past eight a response's own windows are kept before those it does not name; the names come with the list", () => {
    const s = st([acct("a")]);
    const list = [
      "five_hour",
      "seven_day",
      "seven_day_opus",
      "seven_day_sonnet",
      "seven_day_x",
      "seven_day_y",
      "seven_day_z",
      "seven_day_w",
    ];
    see(s, "a", { windows: [], shown: list.map((id) => W(id, 1)), names: { seven_day_x: "X 1" } }, "usage", T0);
    expect(s.accounts[0]?.names).toEqual({ seven_day_x: "X 1" });
    see(s, "a", { windows: [W("five_hour", 2), W("seven_day_fable", 3)] }, "response", T0 + 1);
    expect(shownOf(s.accounts[0] as AccountState).map((w) => w.id)).toEqual([
      "five_hour",
      "seven_day",
      "seven_day_opus",
      "seven_day_sonnet",
      "seven_day_x",
      "seven_day_y",
      "seven_day_z",
      "seven_day_fable",
    ]);
    // A list without names takes the old ones away.
    see(s, "a", { windows: [W("five_hour", 1)] }, "usage", T0 + 2);
    expect(s.accounts[0]?.names).toBeUndefined();
  });
  it("fromResponse and fromUsage: shown always, judged as before; the windows of an event, or null", () => {
    const s = st([acct("a"), acct("b")]);
    const answer = { windows: [W("five_hour", 10)], shown: [W("five_hour", 10), W("seven_day_fable", 100, WEEK)] };
    // A poll not judged: shown, and room as it was.
    expect(fromUsage(s, "a", answer, T0, T0, false)).toEqual(answer.shown);
    expect(s.accounts[0]?.limits).toBeUndefined();
    // Judged: on the top-level windows only; the full Fable row takes nobody out.
    // (the numbers are new to room, so an event's windows come back; the same answer again, none).
    expect(fromUsage(s, "a", { ...answer, shown: [...answer.shown] }, T0 + 1, T0 + 1, true)).toEqual(answer.shown);
    expect(fromUsage(s, "a", { ...answer, shown: [...answer.shown] }, T0 + 1, T0 + 1, true)).toBeNull();
    expect(s.accounts[0]).toMatchObject({ limits: { windows: [W("five_hour", 10)] }, limits_at: T0 + 1 });
    expect(hasRoom(s.accounts[0] as AccountState, T0 + 2)).toBe(true);
    // An answer whose top level had no window is no numbers to judge, as before.
    expect(fromUsage(s, "b", { windows: [], shown: [W("seven_day_fable", 5)] }, T0, T0, true)).toEqual([
      W("seven_day_fable", 5),
    ]);
    expect(s.accounts[1]?.limits_at).toBeUndefined();
    expect(fromUsage(s, "zz", answer, T0, T0, true)).toBeNull();
    // A response: an event when its numbers or what is shown changed.
    expect(fromResponse(s, "a", { windows: [W("five_hour", 12)], status: "allowed" }, T0 + 3)).toEqual([
      W("five_hour", 12),
      W("seven_day_fable", 100, WEEK),
    ]);
    expect(fromResponse(s, "a", { windows: [W("five_hour", 12)], status: "allowed" }, T0 + 4)).toBeNull();
    expect(fromResponse(s, "zz", { windows: [W("five_hour", 12)] }, T0)).toBeNull();
  });
  it("pollDue: every enabled account without a sign-in to fix, on its own clock; judged only as before", () => {
    const E = 300_000;
    expect(pollDue(acct("a", { enabled: false }), T0, E)).toBeNull();
    expect(pollDue(acct("a", { error: "sign in again" }), T0, E)).toBeNull();
    expect(pollDue(acct("a"), T0, E)).toEqual({ judge: true });
    // Busy (fresh numbers), last listed a poll ago (a little early still counts): asked, not judged.
    expect(pollDue(acct("a", { limits_at: T0 - 1, usage_at: T0 - E + 1000 }), T0, E)).toEqual({ judge: false });
    expect(pollDue(acct("a", { limits_at: T0 - 1, usage_at: T0 - 1000 }), T0, E)).toBeNull();
    expect(pollDue(acct("a", { limits_at: T0 - 1 }), T0, E)).toEqual({ judge: false });
    // Idle: judged, as it always was.
    expect(pollDue(acct("a", { limits_at: T0 - E, usage_at: T0 }), T0, E)).toEqual({ judge: true });
  });
  it("room is judged as before: a window only the list shows moves nobody; a seven_day_fable from the headers takes the account out as seven_day_oi did", () => {
    // In use: its responses say it has room; the list's full Sonnet week is shown, not judged.
    const busy = acct("a");
    const s = st([busy, acct("b")]);
    see(s, "a", { windows: [W("five_hour", 10), W("seven_day_sonnet", 100, WEEK)] }, "usage", T0);
    observe(s, "a", { windows: [W("five_hour", 10)], status: "allowed" }, T0);
    see(s, "a", { windows: [W("five_hour", 11)], status: "allowed" }, "response", T0 + 1);
    observe(s, "a", { windows: [W("five_hour", 11)], status: "allowed" }, T0 + 1);
    expect(choose(s, { now: T0 + 2 }).account?.id).toBe("a");
    expect(summary(s, T0 + 2)[0]).toMatchObject({
      status: "ready",
      used_percent: 100,
      windows: [W("five_hour", 11), W("seven_day_sonnet", 100, WEEK)],
    });
    // A response's 7d_oi at 100 (seven_day_fable): judged, as any full window from the
    // headers always was (the id is new, the rule is not).
    const two = st([acct("a"), acct("b")]);
    fromResponse(two, "a", { windows: [W("five_hour", 10), W("seven_day_fable", 100, WEEK)] }, T0);
    expect(summary(two, T0)[0]).toMatchObject({ status: "limited", limited_by: "seven_day_fable", until: iso(WEEK) });
    expect(choose(two, { now: T0 }).account?.id).toBe("b");
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
