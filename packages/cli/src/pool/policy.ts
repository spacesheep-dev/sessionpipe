// SPDX-License-Identifier: Apache-2.0
// The routing policy, in one sentence (DESIGN decision 4): a request goes to the first
// account in your order that has room; a session stays on its account while that
// account has room. Room is: enabled, not in error, not held, no window at or past the
// switch point, and no `rejected` status. Nothing here does I/O or reads a clock: the
// caller passes `now`, and persists the state it gets back. No knobs besides order and
// enabled.
import type { LimitWindow, PoolLimits } from "./types.js";

/** A window this full sends new work elsewhere (bb's threshold; Claude Code's own
 *  footer turns red about there). */
export const SWITCH_PERCENT = 98;
/** A session that sent nothing for this long is no longer pinned. */
export const PIN_IDLE_MS = 30 * 60_000;
/** How long an account rests after an upstream 5xx or a 429 that named no reset. */
export const HOLD_MS = 60_000;
/** A `rejected` status with no window naming a reset is believed this long. */
export const REJECTED_MS = 5 * 60_000;
/** The longest a Retry-After is believed: a vendor's typo must not park an account for a year. */
export const MAX_HOLD_MS = 60 * 60_000;
/** Pins kept at most; the oldest go first. A caller inventing session ids fills nothing
 *  but this. */
export const PINS_MAX = 4096;
/** A window a response does not name stays shown this long after the usage endpoint
 *  last listed it: three polls missed in a row (signed out there, or failing) and the
 *  endpoint's own windows go, rather than look current under each response's time. */
export const KEEP_MS = 15 * 60_000;
/** A response's number this recent outranks a usage poll's for the same window when the
 *  two are less than a point apart (see). */
export const FRESH_MS = 5 * 60_000;
/** Two resets this close are the same reset. */
const SAME_RESET_MS = 1_000;
/** The wire's cap on an account's windows (`limits.observed`, the hello). */
const WINDOWS_MAX = 8;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AccountState {
  id: string;
  enabled: boolean;
  /** Why the account can't serve until a person acts (`sign in again`). */
  error?: string;
  /** Out of the rotation until this time (ms): a 429's Retry-After, a 5xx rest. */
  hold_until?: number;
  /** When the hold was set. A clock that then went backwards (NTP on a laptop) would
   *  stretch a minute's rest into an hour; a hold set in the future is cut to HOLD_MS. */
  hold_at?: number;
  /** Why: `limit` (a 429 or a `rejected`: the pool knows the answer and says it itself)
   *  or `upstream` (a 5xx rest: the upstream's own answer still passes through). */
  hold_why?: "limit" | "upstream";
  /** The freshest numbers, whatever their source, and when they were taken (ms): what
   *  room is judged on (newest wins, as it always was). */
  limits?: PoolLimits;
  limits_at?: number;
  /** Every window the account's numbers name now, for the hello, `limits.observed` and
   *  `pool status` (see): the usage endpoint's whole list, each response's windows put
   *  over it. Absent in a state file from before it: then `limits` is what is shown. */
  shown?: LimitWindow[];
  /** When the usage endpoint last listed the account's windows (ms): the next poll is
   *  due POLL_MS after it, whether the account is busy or idle (pollDue). */
  usage_at?: number;
  /** The usage endpoint's names for its per-model weeks ("Opus 5.5"), for `pool status`. */
  names?: Record<string, string>;
  /** When a response last named each window (ms): kept in memory only (see). */
  heard?: Record<string, number>;
}

export interface Pin {
  account: string;
  /** Last request at (ms). */
  used: number;
}

export interface PolicyState {
  /** In the person's order. */
  accounts: AccountState[];
  /** Session uuid → the account serving it. */
  pins: Record<string, Pin>;
}

export type Observation =
  | PoolLimits
  | { status: 429; retryAfterMs?: number }
  | { upstream5xx: true }
  | { error: string }
  | { error: null };

export type Reason = "pinned" | "first-with-room" | "moved" | "none";

const ms = (iso: string | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

/** A window still counts against the account: full, and not yet reset. */
const blocking = (w: LimitWindow, now: number): boolean => {
  if (w.used_percent < SWITCH_PERCENT) return false;
  const at = ms(w.resets_at);
  return at === null || at > now;
};

/** When a status `rejected` stops counting: the last reset among its windows, else
 *  REJECTED_MS after it was seen. */
function rejectedUntil(a: AccountState, now: number): number | null {
  if (a.limits?.status !== "rejected") return null;
  const named = ms(a.limits.resets_at);
  const resets = a.limits.windows.map((w) => ms(w.resets_at)).filter((t): t is number => t !== null);
  const until = named ?? (resets.length ? Math.max(...resets) : (a.limits_at ?? now) + REJECTED_MS);
  return until > now ? until : null;
}

/** When the account has room again, as far as its numbers say; null when it has room
 *  now, or when nothing says (an error, disabled). */
export function roomAt(a: AccountState, now: number): number | null {
  if (!a.enabled || a.error) return null;
  const times: number[] = [];
  const hold =
    a.hold_until !== undefined && a.hold_at !== undefined && a.hold_at > now
      ? Math.min(a.hold_until, now + HOLD_MS)
      : a.hold_until;
  if (hold !== undefined && hold > now) times.push(hold);
  const rej = rejectedUntil(a, now);
  if (rej !== null) times.push(rej);
  for (const w of a.limits?.windows ?? [])
    if (blocking(w, now)) {
      const at = ms(w.resets_at);
      // A full window with no reset named blocks until fresher numbers arrive; HOLD_MS
      // keeps the account out of `until` guesses without parking it for good.
      times.push(at ?? now + HOLD_MS);
    }
  return times.length ? Math.max(...times) : null;
}

export const hasRoom = (a: AccountState, now: number): boolean => a.enabled && !a.error && roomAt(a, now) === null;

/** The account a request goes to. A pinned session stays while its account has room
 *  (and isn't excluded: the retry after a 429 names the account that just refused). */
export function choose(
  state: PolicyState,
  o: { session?: string | undefined; now: number; exclude?: readonly string[] },
): { account: AccountState | null; reason: Reason } {
  const skip = new Set(o.exclude ?? []);
  const pin = o.session ? state.pins[o.session] : undefined;
  if (pin) {
    const a = state.accounts.find((x) => x.id === pin.account);
    if (a && !skip.has(a.id) && hasRoom(a, o.now)) return { account: a, reason: "pinned" };
  }
  const a = state.accounts.find((x) => !skip.has(x.id) && hasRoom(x, o.now));
  if (!a) return { account: null, reason: "none" };
  return { account: a, reason: pin ? "moved" : "first-with-room" };
}

/** Record that `session` was just served by `account`. Only a uuid-shaped session id
 *  (Claude Code's) is pinned: anything else is a caller's string, not a session. */
export function pin(state: PolicyState, session: string | undefined, account: string, now: number): void {
  if (!session || !UUID_RE.test(session)) return;
  const had = session in state.pins;
  state.pins[session] = { account, used: now };
  if (had) return;
  const keys = Object.keys(state.pins);
  if (keys.length <= PINS_MAX) return;
  const oldest = keys.reduce((a, b) => ((state.pins[a] as Pin).used <= (state.pins[b] as Pin).used ? a : b));
  delete state.pins[oldest];
}

/** Forget pins idle for PIN_IDLE_MS and pins to accounts no longer in the pool. */
export function expirePins(state: PolicyState, now: number): number {
  let dropped = 0;
  const ids = new Set(state.accounts.map((a) => a.id));
  for (const [s, p] of Object.entries(state.pins))
    if (p.used <= now - PIN_IDLE_MS || !ids.has(p.account)) {
      delete state.pins[s];
      dropped++;
    }
  return dropped;
}

/** Where a window goes among the limits: the session and the week, then Fable's week,
 *  then any other model's week, then whatever else (Extra usage, an unknown key). */
const rankOf = (id: string): number =>
  id === "five_hour" || id === "seven_day" ? 0 : id === "seven_day_fable" ? 1 : id.startsWith("seven_day_") ? 2 : 3;
/** At most eight, in their order. Past eight, what stays first: a window at the level
 *  room is judged at (SWITCH_PERCENT; so the window an account is limited by is always
 *  one it shows), then the ids in `first` (a response's own), then by rankOf; the last of
 *  a rank goes first. */
function capped(windows: LimitWindow[], first: ReadonlySet<string> = new Set()): LimitWindow[] {
  const rank = (w: LimitWindow) => (w.used_percent >= SWITCH_PERCENT ? -2 : first.has(w.id) ? -1 : rankOf(w.id));
  const keep = new Set(
    windows
      .map((w, i) => ({ w, i }))
      .sort((a, b) => rank(a.w) - rank(b.w) || a.i - b.i)
      .slice(0, WINDOWS_MAX)
      .map((x) => x.w),
  );
  return windows.filter((w) => keep.has(w));
}
const hasReset = (w: LimitWindow, now: number): boolean => {
  const at = ms(w.resets_at);
  return at !== null && at <= now;
};
/** The same reading of a window: the same percent and length, the reset within a second
 *  (the headers say it in whole seconds, the usage endpoint to the microsecond). */
function same(a: LimitWindow, b: LimitWindow): boolean {
  return a.used_percent === b.used_percent && a.window_minutes === b.window_minutes && sameReset(a, b);
}
function sameReset(a: LimitWindow, b: LimitWindow): boolean {
  const x = ms(a.resets_at);
  const y = ms(b.resets_at);
  return x === null || y === null ? x === y : Math.abs(x - y) < SAME_RESET_MS;
}

/** One window the usage answer and a response from the last FRESH_MS put a point or more
 *  apart for the same reset: what the daemon's log notes (pool/index.ts), since whether
 *  the two sources agree is known only on a person's own machine. */
export interface Apart {
  id: string;
  response: number;
  usage: number;
}

/** What the account shows: its windows as `see` keeps them, else (a state file from
 *  before) the numbers room is judged on. */
export const shownOf = (a: AccountState): LimitWindow[] => a.shown ?? a.limits?.windows ?? [];

/** Take in what the account's numbers now show (AccountState.shown), and say whether
 *  that changed. The usage endpoint lists every window the account has (`shown` of its
 *  answer), so its answer is the list. A response names only the windows its headers
 *  carry: those are put over the list in place, one new to it goes after the last known
 *  limit, and every other window stays, unless its reset has passed (it reset; a
 *  receiver would only show it as such) or the usage endpoint has not listed the
 *  account's windows for KEEP_MS. A window read the same again keeps the object it had
 *  (same), and a poll leaves a window alone that a response named within FRESH_MS when
 *  the two are less than a point apart: the response's number is the more exact one,
 *  and a list that flipped between the two would make an event of each flip. Room is
 *  not judged on any of this (observe is). A status or a reset alone shows nothing new. */
export function see(
  state: PolicyState,
  accountId: string,
  what: PoolLimits,
  from: "usage" | "response",
  now: number,
  apart: Apart[] = [],
) {
  const a = state.accounts.find((x) => x.id === accountId);
  const fresh = from === "usage" ? (what.shown ?? what.windows) : what.windows;
  if (!a || !fresh.length) return false;
  const before = shownOf(a);
  const had = new Map(before.map((w) => [w.id, w]));
  const heard = a.heard ?? {};
  if (from === "usage") {
    const last = a.usage_at;
    a.shown = capped(
      fresh.map((w) => {
        const o = had.get(w.id);
        if (!o) return w;
        if (same(o, w)) return o;
        const h = heard[w.id];
        // A response's number for the same reset, named since the last poll and recently.
        const heardHere = h !== undefined && now - h < FRESH_MS && (last === undefined || h >= last) && sameReset(o, w);
        const gap = Math.abs(o.used_percent - w.used_percent);
        if (heardHere && gap >= 1) apart.push({ id: w.id, response: o.used_percent, usage: w.used_percent });
        // Within a point of it: the response's, the more exact one, stays; but never a
        // number under the judged level when the poll says the window is full.
        return heardHere && gap < 1 && w.used_percent < SWITCH_PERCENT ? o : w;
      }),
    );
    a.usage_at = now;
    const names = Object.entries(what.names ?? {}).filter(([id]) => a.shown?.some((w) => w.id === id));
    if (names.length) a.names = Object.fromEntries(names);
    else delete a.names;
  } else {
    const byId = new Map(fresh.map((w) => [w.id, w]));
    for (const w of fresh) heard[w.id] = now;
    a.heard = heard;
    const keep = a.usage_at !== undefined && now - a.usage_at <= KEEP_MS;
    const out: LimitWindow[] = [];
    for (const w of before) {
      const f = byId.get(w.id);
      if (f) {
        out.push(same(w, f) ? w : f);
        byId.delete(w.id);
      } else if (keep && !hasReset(w, now)) out.push(w);
    }
    let at = 0;
    out.forEach((w, i) => {
      if (rankOf(w.id) < 3) at = i + 1;
    });
    out.splice(at, 0, ...byId.values());
    a.shown = capped(out, new Set(fresh.map((w) => w.id)));
  }
  return JSON.stringify(before) !== JSON.stringify(a.shown);
}

/** A response's numbers into the account: its room judged on them (observe, as it always
 *  was) and what it shows (see). The windows a `limits.observed` for it carries, when one
 *  is due (either changed); else null. */
export function fromResponse(state: PolicyState, accountId: string, limits: PoolLimits, now: number) {
  const shown = see(state, accountId, limits, "response", now);
  const judged = observe(state, accountId, limits, now);
  const a = state.accounts.find((x) => x.id === accountId);
  return a && (shown || judged) ? shownOf(a) : null;
}

/** A usage poll's answer into the account, `at` the poll's own time: what it shows, and,
 *  when `judge` (pollDue), its room, on the answer's top-level windows only, as before;
 *  an answer with none of those was no numbers to judge, as before. The account's
 *  windows when either changed; else null. */
export function fromUsage(
  state: PolicyState,
  accountId: string,
  limits: PoolLimits,
  at: number,
  now: number,
  judge: boolean,
  apart: Apart[] = [],
) {
  const shown = see(state, accountId, limits, "usage", at, apart);
  const judged = judge && limits.windows.length > 0 && observe(state, accountId, limits, now);
  const a = state.accounts.find((x) => x.id === accountId);
  return a && (shown || judged) ? shownOf(a) : null;
}

/** Whether an account's usage is to be asked for at tick `t`, polls `every` ms apart, and
 *  whether that answer is judged: only when it would have been before every account was
 *  polled (the account's numbers `every` old, or none), so which account serves a
 *  request is decided as it was. Every enabled account without a sign-in to fix is asked
 *  on its own clock (`usage_at`), busy or idle; a tick a little early still counts, or
 *  the timer's jitter would make it every other tick. Null: not now. */
export function pollDue(a: AccountState, t: number, every: number): { judge: boolean } | null {
  if (!a.enabled || a.error) return null;
  const judge = a.limits_at === undefined || t - a.limits_at >= every;
  return judge || a.usage_at === undefined || t - a.usage_at >= every - every / 10 ? { judge } : null;
}

const sameLimits = (a: PoolLimits | undefined, b: PoolLimits): boolean =>
  !!a && a.status === b.status && JSON.stringify(a.windows) === JSON.stringify(b.windows);

/** Take in what was just learnt about an account. Newest wins. Returns whether the
 *  account's windows changed (the daemon appends a `limits.observed` then) — a 429, a
 *  5xx or an error changes its standing, not its numbers. */
export function observe(state: PolicyState, accountId: string, what: Observation, now: number): boolean {
  const a = state.accounts.find((x) => x.id === accountId);
  if (!a) return false;
  if ("windows" in what) {
    // A status or a reset alone (no window readable) is kept on the account; the
    // windows known so far stay, and nobody hears of a change in numbers.
    const windows = what.windows.length ? what.windows : (a.limits?.windows ?? []);
    const changed = what.windows.length > 0 && !sameLimits(a.limits, what);
    a.limits = {
      windows,
      ...(what.status !== undefined ? { status: what.status } : {}),
      ...(what.claim !== undefined ? { claim: what.claim } : {}),
      ...(what.resets_at !== undefined ? { resets_at: what.resets_at } : {}),
    };
    a.limits_at = now;
    // A hold that has run out is tidied away; a live one is trusted over the numbers.
    if (a.hold_until !== undefined && a.hold_until <= now) {
      delete a.hold_until;
      delete a.hold_at;
      delete a.hold_why;
    }
    return changed;
  }
  if ("upstream5xx" in what) {
    a.hold_until = Math.max(a.hold_until ?? 0, now + HOLD_MS);
    a.hold_at = now;
    // A limit's hold keeps its reason; a rest never shortens or outranks it.
    if (a.hold_why !== "limit") a.hold_why = "upstream";
    return false;
  }
  if ("error" in what) {
    if (what.error === null) delete a.error;
    else a.error = what.error;
    return false;
  }
  // A 429: out until the reset it named (an hour at most); with none, until the
  // freshest numbers' nearest future reset; with none of those either, HOLD_MS.
  let until = what.retryAfterMs !== undefined ? now + Math.min(what.retryAfterMs, MAX_HOLD_MS) : null;
  if (until === null) {
    const resets = (a.limits?.windows ?? [])
      .map((w) => ms(w.resets_at))
      .filter((t): t is number => t !== null && t > now);
    until = resets.length ? Math.min(...resets) : now + HOLD_MS;
  }
  a.hold_until = Math.max(a.hold_until ?? 0, until);
  a.hold_at = now;
  a.hold_why = "limit";
  return false;
}

export type AccountStatus = "ready" | "limited" | "error" | "disabled";

export interface AccountSummary {
  id: string;
  status: AccountStatus;
  /** Serving new sessions now: the first with room. */
  current: boolean;
  /** Limited: when it has room again, RFC 3339, if known. */
  until?: string;
  /** The fullest window shown, for a status line. */
  used_percent?: number;
  /** Every window the account shows (AccountState.shown, 1–8): the usage poll's list
   *  with each response's numbers put over it. */
  windows?: LimitWindow[];
  /** What took it out: the window that is full (the one that resets last when
   *  several are), else the window a `rejected` status named (`claim`), else
   *  `rejected` for a 429 / a 5xx rest, `error` for a sign-in needed. Only with
   *  status limited or error. */
  limited_by?: string;
}

/** The window that keeps the account out longest, when a window does at all. */
function limitedBy(a: AccountState, now: number): string {
  let best: { id: string; at: number } | null = null;
  for (const w of a.limits?.windows ?? [])
    if (blocking(w, now)) {
      const at = ms(w.resets_at) ?? now + HOLD_MS;
      if (!best || at > best.at) best = { id: w.id, at };
    }
  return best?.id ?? ((a.limits?.status === "rejected" && a.limits.claim) || "rejected");
}

/** What the hello and `pool status` say per account. */
export function summary(state: PolicyState, now: number): AccountSummary[] {
  const current = choose(state, { now }).account?.id;
  return state.accounts.map((a) => {
    const at = roomAt(a, now);
    const status: AccountStatus = !a.enabled ? "disabled" : a.error ? "error" : at === null ? "ready" : "limited";
    const shown = shownOf(a);
    const used = shown.length ? Math.max(...shown.map((w) => w.used_percent)) : undefined;
    return {
      id: a.id,
      status,
      current: a.id === current,
      ...(at !== null ? { until: new Date(at).toISOString() } : {}),
      ...(used !== undefined ? { used_percent: used } : {}),
      ...(shown.length ? { windows: shown.slice(0, WINDOWS_MAX) } : {}),
      ...(status === "error" ? { limited_by: "error" } : status === "limited" ? { limited_by: limitedBy(a, now) } : {}),
    };
  });
}

/** How many accounts have room now (the /health answer). */
export const withRoom = (state: PolicyState, now: number): number =>
  state.accounts.filter((a) => hasRoom(a, now)).length;
