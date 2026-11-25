// SPDX-License-Identifier: Apache-2.0
// A pool's hour, replayed without a network: requests served by the server's own account
// loop (choose, the one retry after a refusal, the fallback, pins) over the real header
// and usage readers, and the usage poll on its clock. What the numbers do to an account
// is the engine's: the pool's own (pool-route.test.ts) or, for the recording it is held
// to, the one before this change. Each step's chosen account, holds, pins and standing
// go into a log, written only when something in it changed.
import { claudePool } from "../../../core/src/index.js";
import { choose, observe, type PolicyState, pin, summary } from "../../src/pool/policy.js";
import type { PoolLimits } from "../../src/pool/types.js";

export const MIN = 60_000;
export const EVERY = 5 * MIN;
/** How long a usage answer takes: its numbers are dated this much after the tick. */
const LAT = 300;
export const T0 = Date.parse("2026-11-25T10:00:00Z");
export const WEEK = T0 + 4 * 86_400_000;
const H = "anthropic-ratelimit-unified-";
const epoch = (t: number) => String(Math.floor(t / 1000));

export interface Engine {
  /** A response's numbers (non-null) for the account; the windows of the event it makes, or null. */
  respond(state: PolicyState, id: string, limits: PoolLimits, now: number): unknown[] | null;
  /** The usage poll's tick at `t` for every account, `usage` its answer. How many it asked. */
  tick(state: PolicyState, t: number, answer: (id: string) => PoolLimits | null): { asked: number; events: number };
}

export type Headers = Record<string, string>;
export interface Scenario {
  accounts: string[];
  minutes: number;
  /** The usage endpoint's JSON for an account at time t. */
  usage: (id: string, t: number) => unknown;
  /** A response's headers (and status) for an account at time t. */
  headers: (id: string, t: number) => { status: number; headers: Headers };
  /** Requests at time t: session ids. */
  requests: (t: number) => string[];
  /** Step, ms. */
  step?: number;
}

export interface Outcome {
  log: string[];
  /** Responses that made a `limits.observed` (a session's event). */
  events: number;
  /** Usage requests asked. */
  asked: number;
  pollEvents: number;
  /** Steps where `limited_by` named a window the account did not show. */
  strays: string[];
}

/** One hour (or `minutes`) of a scenario, through `engine`. */
export function replay(s: Scenario, engine: Engine): Outcome {
  const state: PolicyState = { accounts: s.accounts.map((id) => ({ id, enabled: true })), pins: {} };
  const log: string[] = [];
  let events = 0;
  let asked = 0;
  let pollEvents = 0;
  const strays: string[] = [];
  let last = "";
  const step = s.step ?? 30_000;
  const fallback = (session: string, tried: Set<string>, now: number) => {
    const limited = (a: PolicyState["accounts"][number]) => a.hold_why === "limit" && (a.hold_until ?? 0) > now;
    const usable = (a: PolicyState["accounts"][number]) => a.enabled && !a.error && !tried.has(a.id) && !limited(a);
    const p = state.pins[session];
    return (p && state.accounts.find((a) => a.id === p.account && usable(a))) ?? state.accounts.find(usable) ?? null;
  };
  const request = (session: string, t: number): string => {
    const tried = new Set<string>();
    let retried = false;
    const next = () => choose(state, { session, now: t, exclude: [...tried] }).account ?? fallback(session, tried, t);
    let account = choose(state, { session, now: t }).account ?? fallback(session, tried, t);
    while (account) {
      const a = account;
      tried.add(a.id);
      const r = s.headers(a.id, t);
      const limits = claudePool.readLimits(r.headers, t);
      if (limits && engine.respond(state, a.id, limits, t)) events++;
      if (r.status === 429 || limits?.status === "rejected") {
        const ra = r.headers["retry-after"];
        observe(state, a.id, { status: 429, ...(ra ? { retryAfterMs: Number(ra) * 1000 } : {}) }, t);
        if (!retried) {
          const other = next();
          if (other) {
            retried = true;
            account = other;
            continue;
          }
        }
        pin(state, session, a.id, t);
        return `${a.id}(429)`;
      }
      pin(state, session, a.id, t);
      return a.id;
    }
    return "none";
  };
  for (let t = T0; t <= T0 + s.minutes * MIN; t += step) {
    const m = (t - T0) / MIN;
    if ((t - T0) % EVERY === 0) {
      const r = engine.tick(state, t + 7, (id) => claudePool.usageLimits(s.usage(id, t + 7), t + 7 + LAT));
      asked += r.asked;
      pollEvents += r.events;
    }
    const served = s.requests(t).map((session) => `${label(session)}->${request(session, t)}`);
    const sums = summary(state, t);
    for (const x of sums)
      if (
        x.limited_by &&
        !["rejected", "error"].includes(x.limited_by) &&
        !x.windows?.some((w) => w.id === x.limited_by)
      )
        strays.push(`m${m} ${x.id}:${x.limited_by}`);
    const standing = sums
      .map(
        (x) =>
          `${x.id}:${x.status}${x.limited_by ? `/${x.limited_by}` : ""}${x.until ? `@${(Date.parse(x.until) - T0) / MIN}` : ""}`,
      )
      .join(" ");
    const holds = state.accounts
      .filter((a) => a.hold_until !== undefined && a.hold_until > t)
      .map((a) => `${a.id}~${((a.hold_until as number) - T0) / MIN}/${a.hold_why}`)
      .join(" ");
    const pins = Object.entries(state.pins)
      .map(([k, p]) => `${label(k)}:${p.account}`)
      .join(" ");
    const now = `${standing} | holds ${holds || "-"} | pins ${pins || "-"}`;
    if (served.length || now !== last) log.push(`m${m} ${served.join(" ") || "-"} | ${now}`);
    last = now;
  }
  return { log, events, asked, pollEvents, strays };
}

// --- the scenarios --------------------------------------------------------------------

const S1 = "aaaaaaaa-0000-4000-8000-000000000001";
const S2 = "aaaaaaaa-0000-4000-8000-000000000002";
/** A session as the log names it. */
const label = (session: string) => `s${Number(session.slice(-1))}`;
const R5 = T0 + 4 * 3600_000;
/** Busy from minute 1 to 30, a pause, busy again from 45; a second session at minute 50. */
const busy = (t: number) => {
  const m = (t - T0) / MIN;
  const out = (m >= 1 && m <= 30) || (m >= 45 && m <= 90) ? ((t - T0) % MIN === 0 ? [S1] : []) : [];
  return m === 50 ? [...out, S2] : out;
};
const ok = (extra: Headers = {}): { status: number; headers: Headers } => ({
  status: 200,
  headers: {
    [`${H}status`]: "allowed",
    [`${H}5h-utilization`]: "0.1",
    [`${H}5h-reset`]: epoch(R5),
    [`${H}7d-utilization`]: "0.4",
    [`${H}7d-reset`]: epoch(WEEK),
    ...extra,
  },
});
const fableRow = (percent: number) => ({
  kind: "weekly_scoped",
  scope: { model: { display_name: "Fable" } },
  percent,
  resets_at: new Date(WEEK).toISOString(),
});
const usage = (fable: (id: string) => number) => (id: string) => ({
  five_hour: { utilization: 10, resets_at: new Date(R5).toISOString() },
  seven_day: { utilization: 40, resets_at: new Date(WEEK).toISOString() },
  limits: [fableRow(fable(id))],
});

export const ROUTES: Record<string, Scenario> = {
  "Fable at 100 in the usage list only, no 7d_oi in the headers": {
    accounts: ["A", "B"],
    minutes: 90,
    usage: usage((id) => (id === "A" ? 100 : 5)),
    headers: () => ok(),
    requests: busy,
  },
  "Fable at 100 in the usage list and 7d_oi at 100 in A's headers": {
    accounts: ["A", "B"],
    minutes: 90,
    usage: usage((id) => (id === "A" ? 100 : 5)),
    headers: (id) => ok({ [`${H}7d_oi-utilization`]: id === "A" ? "1" : "0.05", [`${H}7d_oi-reset`]: epoch(WEEK) }),
    requests: busy,
  },
  "A refused by the Fable limit (claim seven_day_overage_included) from minute 10 to 12": {
    accounts: ["A", "B"],
    minutes: 90,
    usage: usage(() => 20),
    headers: (id, t) => {
      const m = (t - T0) / MIN;
      if (id !== "A" || m < 10 || m > 12)
        return ok({ [`${H}7d_oi-utilization`]: "0.2", [`${H}7d_oi-reset`]: epoch(WEEK) });
      return {
        status: 429,
        headers: {
          ...ok().headers,
          [`${H}status`]: "rejected",
          [`${H}7d_oi-utilization`]: "1",
          [`${H}7d_oi-reset`]: epoch(WEEK),
          [`${H}representative-claim`]: "seven_day_overage_included",
          [`${H}reset`]: epoch(T0 + 40 * MIN),
          "retry-after": "1800",
        },
      };
    },
    requests: busy,
  },
  "7d_fable at 0.2, then 7d_oi at 1, in A's headers": {
    accounts: ["A", "B"],
    minutes: 40,
    usage: usage(() => 5),
    headers: (id) =>
      id === "A"
        ? ok({
            [`${H}7d_fable-utilization`]: "0.2",
            [`${H}7d_fable-reset`]: epoch(WEEK - 86_400_000),
            [`${H}7d_oi-utilization`]: "1",
            [`${H}7d_oi-reset`]: epoch(WEEK),
          })
        : ok(),
    requests: busy,
  },
  "7d_oi at 1, then 7d_fable at 0.2, in A's headers": {
    accounts: ["A", "B"],
    minutes: 40,
    usage: usage(() => 5),
    headers: (id) =>
      id === "A"
        ? ok({
            [`${H}7d_oi-utilization`]: "1",
            [`${H}7d_oi-reset`]: epoch(WEEK),
            [`${H}7d_fable-utilization`]: "0.2",
            [`${H}7d_fable-reset`]: epoch(WEEK - 86_400_000),
          })
        : ok(),
    requests: busy,
  },
  "Extra usage at 100 in a crowded usage answer": {
    accounts: ["A", "B"],
    minutes: 90,
    usage: (id) => ({
      five_hour: { utilization: 1 },
      seven_day: { utilization: 1 },
      seven_day_opus: { utilization: 1 },
      seven_day_sonnet: { utilization: 1 },
      seven_day_oauth_apps: { utilization: 1 },
      seven_day_cowork: { utilization: 1 },
      extra_usage: { utilization: id === "A" ? 100 : 1, is_enabled: true },
      limits: ["Opus 5.5", "Sonnet 4.6", "Fable"].map((name) => ({
        ...fableRow(1),
        scope: { model: { display_name: name } },
      })),
    }),
    headers: () => ok(),
    requests: busy,
  },
};

// --- the reviewer's hour of events ----------------------------------------------------

const rise = (t: number) => 0.1 + ((t - T0) / MIN) * 0.0005;
const one = (t: number) => (t > T0 ? [S1] : []);
const hour = (
  usageAt: (t: number) => unknown,
  headersAt: (t: number) => { status: number; headers: Headers },
): Scenario => ({
  accounts: ["A"],
  minutes: 59,
  step: 10_000,
  usage: (_id, t) => usageAt(t),
  headers: (_id, t) => headersAt(t),
  requests: one,
});
const risingAt = (t: number) => ok({ [`${H}5h-utilization`]: rise(t).toFixed(4) });
const row30 = fableRow(30);

export const HOURS: Record<string, Scenario> = {
  "E1 rising, both sources agree exactly": hour(
    (t) => ({
      five_hour: { utilization: Math.round(rise(t) * 1000) / 10, resets_at: new Date(R5).toISOString() },
      seven_day: { utilization: 40, resets_at: new Date(WEEK).toISOString() },
      limits: [row30],
    }),
    risingAt,
  ),
  "E2 rising, the usage reset in fractions of a second": hour(
    (t) => ({
      five_hour: {
        utilization: Math.round(rise(t) * 1000) / 10,
        resets_at: new Date(R5 + 565).toISOString().replace("Z", "451+00:00"),
      },
      seven_day: { utilization: 40, resets_at: new Date(WEEK + 565).toISOString() },
      limits: [row30],
    }),
    risingAt,
  ),
  "E3 rising, the usage percent in whole numbers": hour(
    (t) => ({
      five_hour: { utilization: Math.round(rise(t) * 100), resets_at: new Date(R5).toISOString() },
      seven_day: { utilization: 40, resets_at: new Date(WEEK).toISOString() },
    }),
    risingAt,
  ),
  "E4 flat, the usage reset at .565 s": hour(
    () => ({
      five_hour: { utilization: 10, resets_at: new Date(R5 + 565).toISOString() },
      seven_day: { utilization: 40, resets_at: new Date(WEEK).toISOString() },
    }),
    () => ok(),
  ),
};
