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
  /** The freshest numbers, whatever their source, and when they were taken (ms). */
  limits?: PoolLimits;
  limits_at?: number;
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
  /** The fullest window, for a status line. */
  used_percent?: number;
  /** The freshest numbers, from headers or the idle poll (1–8 windows). */
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
    const used = a.limits?.windows.length ? Math.max(...a.limits.windows.map((w) => w.used_percent)) : undefined;
    return {
      id: a.id,
      status,
      current: a.id === current,
      ...(at !== null ? { until: new Date(at).toISOString() } : {}),
      ...(used !== undefined ? { used_percent: used } : {}),
      ...(a.limits?.windows.length ? { windows: a.limits.windows.slice(0, 8) } : {}),
      ...(status === "error" ? { limited_by: "error" } : status === "limited" ? { limited_by: limitedBy(a, now) } : {}),
    };
  });
}

/** How many accounts have room now (the /health answer). */
export const withRoom = (state: PolicyState, now: number): number =>
  state.accounts.filter((a) => hasRoom(a, now)).length;
