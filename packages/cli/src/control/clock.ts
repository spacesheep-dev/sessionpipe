// SPDX-License-Identifier: Apache-2.0
// The clock a trigger rule runs on (spec/CONTROL.md §14.6), in the machine's local time: when
// its ticks fall, the local day a run counts against, and what a change of the clocks does.
// Pure functions of a time zone and an instant: nothing here keeps time, sleeps or remembers.
//
// A tick is an instant, worked out afresh from the rule's `every` each time it is asked for,
// never by adding up waits, so nothing drifts: `day 09:00` is 09:00 on each local date, and
// `2h` is the rule's last tick plus two hours, whenever the machine happened to look.
//
// The two nights a year the clocks change are read as the Temporal API's "compatible" choice:
// a local time that does not exist that night (02:30 where the clock jumps from 02:00 to 03:00)
// falls the length of the jump later (03:30, the same instant 02:30 would have been on the old
// offset); a local time that happens twice (02:30 where the clock goes back from 03:00 to
// 02:00) is the first of the two, and only that one, so a rule never runs twice in one night.
import type { Every } from "@sessionpipe/core";

/** A time zone, as far as the clock needs one. */
export interface Zone {
  /** Minutes the zone's wall clock is ahead of UTC at instant `t`. */
  offset(t: number): number;
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** A tick later than this is refused `missed` (§14.6), and a clock rule's run waits no longer. */
export const TICK_LATE_MS = 6 * 3600_000;

/** A time zone by its IANA name (`Europe/Berlin`), or the machine's own when none is named. */
export function zoneOf(name?: string): Zone {
  const f = new Intl.DateTimeFormat("en-US", {
    ...(name ? { timeZone: name } : {}),
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  });
  return {
    offset(t: number): number {
      const p = Object.fromEntries(f.formatToParts(t).map((x) => [x.type, Number(x.value)]));
      const wall = Date.UTC(p.year as number, (p.month as number) - 1, p.day, p.hour, p.minute);
      return Math.round((wall - Math.floor(t / MINUTE) * MINUTE) / MINUTE);
    },
  };
}

/** The wall clock at `t` in the zone, read as if it were UTC: its date and time of day. */
const wall = (z: Zone, t: number): Date => new Date(t + z.offset(t) * MINUTE);

/** The local date at `t`, `YYYY-MM-DD`: the day a run counts against (a rule's `cap`). */
export function localDay(z: Zone, t: number): string {
  return wall(z, t).toISOString().slice(0, 10);
}

/** The instant a local date (`date` read as UTC midnight of it) and minute of the day name in
 *  the zone, with the compatible choice for a time the night's change skips or repeats. */
export function atLocal(z: Zone, date: number, minutes: number): number {
  const w = date + minutes * MINUTE;
  // The offsets a day either side: a change of the clocks lies between them, if one does.
  const before = z.offset(w - DAY);
  const after = z.offset(w + DAY);
  const fits = [before, after].map((o) => w - o * MINUTE).filter((t) => z.offset(t) * MINUTE === w - t);
  // Repeated: the earlier of the two. Skipped: none fits, and the offset before the jump
  // puts it as far after the jump as it was into the hour that was skipped.
  return fits.length ? Math.min(...fits) : w - before * MINUTE;
}

/** Midnight (as UTC) of the local date `back` days before the one at `t`. */
const dateBefore = (z: Zone, t: number, back: number): number => {
  const d = wall(z, t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back);
};

/** The latest tick of `every` at or before `now` and after `after` (the rule's last tick, or
 *  just before it was made or resumed); null when none falls between. An interval counts from
 *  `anchor`: its last tick, or when it was made or resumed. */
export function dueTick(every: Every, z: Zone, o: { now: number; after: number; anchor: number }): number | null {
  if (every.kind === "interval") {
    const step = every.minutes * MINUTE;
    const k = Math.floor((o.now - o.anchor) / step);
    const t = o.anchor + k * step;
    return k >= 1 && t > o.after ? t : null;
  }
  // Back over the last eight local dates (a week, and the day a change of the clocks may
  // push a tick onto): the first tick at or before now is the latest.
  for (let back = 0; back <= 8; back++) {
    const date = dateBefore(z, o.now, back);
    if (every.kind === "week" && new Date(date).getUTCDay() !== every.day) continue;
    const t = atLocal(z, date, every.at);
    if (t > o.now) continue;
    return t > o.after ? t : null;
  }
  /* v8 ignore next -- a week always holds one of its days */
  return null;
}

/** The first tick of `every` after `now`: what `trigger list` says comes next. */
export function nextTick(every: Every, z: Zone, o: { now: number; anchor: number }): number {
  if (every.kind === "interval") {
    const step = every.minutes * MINUTE;
    return o.anchor + (Math.floor((o.now - o.anchor) / step) + 1) * step;
  }
  for (let ahead = 0; ; ahead++) {
    const date = dateBefore(z, o.now, -ahead);
    if (every.kind === "week" && new Date(date).getUTCDay() !== every.day) continue;
    const t = atLocal(z, date, every.at);
    if (t > o.now) return t;
  }
}
