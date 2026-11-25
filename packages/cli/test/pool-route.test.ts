// SPDX-License-Identifier: Apache-2.0
// Which account serves each request, step by step, is what it was before the pool showed
// the usage endpoint's per-model weeks: the same responses and polls, replayed through the
// pool's own policy (fromResponse, fromUsage, pollDue), give the same served account,
// standing, holds and pins as the recording made with the version before
// (fixtures/pool-route-before.json); `7d_oi`'s window has its new name. And an hour of
// responses and polls makes no more events than before.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fromResponse, fromUsage, pollDue } from "../src/pool/policy.js";
import { type Engine, EVERY, HOURS, ROUTES, replay } from "./helpers/pool-route.js";

const before = JSON.parse(
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "pool-route-before.json"), "utf8"),
) as Record<string, string[] | { events: number; pollEvents: number; asked: number }>;

/** The pool as it is: server.ts's and index.ts's calls, nothing else. */
const pool: Engine = {
  respond: (state, id, limits, now) => fromResponse(state, id, limits, now),
  tick(state, t, answer) {
    let asked = 0;
    let events = 0;
    for (const a of state.accounts) {
      const due = pollDue(a, t, EVERY);
      if (!due) continue;
      asked++;
      const limits = answer(a.id);
      if (limits && fromUsage(state, a.id, limits, t, limits.observed_at as number, due.judge)) events++;
    }
    return { asked, events };
  },
};

describe("which account serves a request is decided as before", () => {
  it.each(Object.keys(ROUTES))("%s", (name) => {
    const was = (before[name] as string[]).map((l) => l.replaceAll("seven_day_oi", "seven_day_fable"));
    const r = replay(ROUTES[name]!, pool);
    expect(r.log).toEqual(was);
    // And at every step, the window an account is limited by is one it shows.
    expect(r.strays).toEqual([]);
  });
});

describe("an hour of a busy account: events, and usage asked", () => {
  // Before: an account in steady use was asked once (its numbers never grew old), and
  // made an event per change in its responses' numbers. Now it is asked every five
  // minutes, and its events are those, and at most one more for the first answer.
  it.each(Object.keys(HOURS))("%s", (name) => {
    const was = before[name] as { events: number; pollEvents: number; asked: number };
    const r = replay(HOURS[name]!, pool);
    expect(r.asked).toBe(12);
    expect(r.events).toBe(was.events);
    expect(r.pollEvents).toBeLessThanOrEqual(was.pollEvents + 1);
  });
});
