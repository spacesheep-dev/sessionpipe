// SPDX-License-Identifier: Apache-2.0
// A rule's clock (CONTROL.md §14.6, control/clock.ts): local time, the local day, the ticks of
// `mon 09:00`, `day 08:30` and `2h`, and the two nights a year the clocks change. Berlin's
// clocks skip 02:00 to 03:00 on 2026-03-29 and repeat 02:00 to 03:00 on 2026-10-25, so a
// `day 02:30` rule meets both cases.
import { parseEvery } from "@sessionpipe/core";
import { describe, expect, it } from "vitest";
import { atLocal, dueTick, localDay, nextTick, zoneOf } from "../src/control/clock.js";
import { TriggerEngine, type TriggerJob, type TriggerState } from "../src/control/triggers.js";

const berlin = zoneOf("Europe/Berlin");
const utc = zoneOf("UTC");
const at = (s: string) => Date.parse(s);
const date = (s: string) => Date.parse(`${s}T00:00:00.000Z`);
const every = (s: string) => parseEvery(s) as Exclude<ReturnType<typeof parseEvery>, { error: string }>;

describe("the zone", () => {
  it("says its offset, and the machine's own zone is one too", () => {
    expect(berlin.offset(at("2026-01-15T12:00:00Z"))).toBe(60);
    expect(berlin.offset(at("2026-07-15T12:00:00Z"))).toBe(120);
    expect(utc.offset(at("2026-07-15T12:00:00Z"))).toBe(0);
    expect(typeof zoneOf().offset(Date.now())).toBe("number");
  });
  it("names the local day an instant falls on", () => {
    expect(localDay(berlin, at("2026-11-23T23:30:00Z"))).toBe("2026-11-24");
    expect(localDay(utc, at("2026-11-23T23:30:00Z"))).toBe("2026-11-23");
  });
  it("a local time the night skips falls the length of the jump later; one it repeats is the first", () => {
    expect(atLocal(berlin, date("2026-03-29"), 150)).toBe(at("2026-03-29T01:30:00Z")); // 03:30 summer time
    expect(atLocal(berlin, date("2026-10-25"), 150)).toBe(at("2026-10-25T00:30:00Z")); // the first 02:30
    expect(atLocal(berlin, date("2026-06-01"), 540)).toBe(at("2026-06-01T07:00:00Z"));
  });
});

describe("ticks", () => {
  it("a weekly clock: the latest Monday 09:00 at or before now, after the last", () => {
    const e = every("mon 09:00");
    const now = at("2026-11-25T10:00:00Z"); // a Wednesday
    expect(dueTick(e, utc, { now, after: 0, anchor: 0 })).toBe(at("2026-11-23T09:00:00Z"));
    expect(dueTick(e, utc, { now, after: at("2026-11-23T09:00:00Z"), anchor: 0 })).toBeNull();
    expect(nextTick(e, utc, { now, anchor: 0 })).toBe(at("2026-11-30T09:00:00Z"));
  });
  it("a daily clock: today's, or yesterday's before its time", () => {
    const e = every("day 08:30");
    expect(dueTick(e, utc, { now: at("2026-11-25T08:00:00Z"), after: 0, anchor: 0 })).toBe(at("2026-11-24T08:30:00Z"));
    expect(nextTick(e, utc, { now: at("2026-11-25T08:00:00Z"), anchor: 0 })).toBe(at("2026-11-25T08:30:00Z"));
    expect(nextTick(e, utc, { now: at("2026-11-25T09:00:00Z"), anchor: 0 })).toBe(at("2026-11-26T08:30:00Z"));
  });
  it("an interval counts from its anchor, never from when the machine looked: no drift", () => {
    const e = every("2h");
    const anchor = at("2026-11-23T07:00:00Z");
    expect(dueTick(e, utc, { now: at("2026-11-23T08:59:00Z"), after: anchor, anchor })).toBeNull();
    expect(dueTick(e, utc, { now: at("2026-11-23T13:10:00Z"), after: anchor, anchor })).toBe(
      at("2026-11-23T13:00:00Z"),
    );
    expect(nextTick(e, utc, { now: at("2026-11-23T13:10:00Z"), anchor })).toBe(at("2026-11-23T15:00:00Z"));
  });
  it("day 02:30 on the night the clock skips that hour runs at 03:30, once", () => {
    const e = every("day 02:30");
    const after = at("2026-03-28T01:30:00Z");
    expect(dueTick(e, berlin, { now: at("2026-03-29T01:29:00Z"), after, anchor: 0 })).toBeNull();
    expect(dueTick(e, berlin, { now: at("2026-03-29T01:30:00Z"), after, anchor: 0 })).toBe(at("2026-03-29T01:30:00Z"));
    expect(nextTick(e, berlin, { now: at("2026-03-29T00:00:00Z"), anchor: 0 })).toBe(at("2026-03-29T01:30:00Z"));
  });
  it("day 02:30 on the night the clock repeats that hour runs at the first, and not at the second", () => {
    const e = every("day 02:30");
    const first = at("2026-10-25T00:30:00Z");
    expect(dueTick(e, berlin, { now: first, after: at("2026-10-24T00:30:00Z"), anchor: 0 })).toBe(first);
    // The second 02:30 (winter time) is 01:30 UTC: no tick then.
    expect(dueTick(e, berlin, { now: at("2026-10-25T01:31:00Z"), after: first, anchor: 0 })).toBeNull();
  });
});

describe("a 02:30 rule through both nights, run by the engine every half hour", () => {
  for (const [night, from, want] of [
    [
      "skipped",
      "2026-03-28T00:00:00Z",
      ["2026-03-28T01:30:00.000Z", "2026-03-29T01:30:00.000Z", "2026-03-30T00:30:00.000Z"],
    ],
    [
      "repeated",
      "2026-10-24T00:00:00Z",
      ["2026-10-24T00:30:00.000Z", "2026-10-25T00:30:00.000Z", "2026-10-26T01:30:00.000Z"],
    ],
  ] as const)
    it(`the ${night} hour: one run a day, at the instants worked out above`, () => {
      let now = at(from);
      const ran: number[] = [];
      let saved: TriggerState | undefined;
      const e = new TriggerEngine({
        now: () => now,
        zone: "Europe/Berlin",
        mode: () => "auto",
        allowed: () => true,
        harnesses: () => ["codex"],
        session: () => ({ gone: true }),
        startRoom: () => true,
        run: (_job: TriggerJob, on) => {
          ran.push(now);
          on.began("codex:x");
          on.ended(1);
          return { cancel: () => {} };
        },
        load: () => saved,
        save: (s) => {
          saved = s;
        },
        log: () => {},
      });
      e.load({
        v: 1,
        on: true,
        rules: [
          {
            name: "night",
            paused: false,
            source: { every: "day 02:30" },
            target: { start: "codex" },
            folder: "/work",
            level: "safe",
            cap: { per_day: 5 },
            words: "Tidy up.",
          },
        ],
      });
      for (; now < at(from) + 3 * 24 * 3600_000; now += 30 * 60_000) e.check();
      expect(ran.map((t) => new Date(t).toISOString())).toEqual(want);
    });
});
