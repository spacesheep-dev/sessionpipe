// SPDX-License-Identifier: Apache-2.0
// The trigger engine's own corners (control/triggers.ts), beyond what the scenario files say:
// what the daemon's runner may answer (a failure, a refusal, a hold found at the last moment),
// a record that can't be saved or read, a rule changed or removed in the file, a resume, the
// hello's topics with the machine's own pauses, and the order of the checks.
import type { ControlNotice, NoticeResult, StartPermission, TriggerRule, TriggersFile } from "@sessionpipe/core";
import { describe, expect, it } from "vitest";
import {
  fingerprint,
  type RunEvents,
  type SessionLook,
  stateOf,
  TriggerEngine,
  type TriggerJob,
  type TriggerState,
} from "../src/control/triggers.js";

const T0 = Date.parse("2026-11-24T09:14:05.000Z");
const SID = "codex:019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b";

const notice = (over: Partial<ControlNotice> = {}): ControlNotice => ({
  id: "01KB4M2Q8V3T6Y9C0D1E2F3G4H",
  topic: "acme/tasks",
  event: "record.updated",
  subject: "X-001",
  at: "2026-11-24T09:14:02.000Z",
  expires_at: "2026-11-25T09:14:02.000Z",
  ...over,
});
const card = (over: Partial<TriggerRule> = {}): TriggerRule => ({
  name: "card",
  paused: false,
  source: { receiver: "board.example", topic: "acme/tasks" },
  target: { start: "codex" },
  folder: "~/work",
  level: "safe",
  cap: { per_day: 3 },
  words: "Card {subject}.",
  ...over,
});

/** An engine and everything it was told. `answer` says what the runner does with a run. */
function rig(
  o: {
    answer?: (on: RunEvents) => void;
    session?: SessionLook;
    saved?: unknown;
    save?: () => void;
    offered?: StartPermission[];
    now?: number;
  } = {},
) {
  const s = {
    now: o.now ?? T0,
    acks: [] as (NoticeResult & { id: string })[],
    jobs: [] as TriggerJob[],
    logs: [] as string[],
    allowed: true,
    room: true,
    session: o.session ?? ({ held: false } as SessionLook),
    saved: o.saved as TriggerState | undefined,
    changed: 0,
    cancelled: 0,
    /** The last run's events, for a test to end it. */
    on: null as RunEvents | null,
  };
  const e = new TriggerEngine({
    now: () => s.now,
    zone: "UTC",
    mode: () => "auto",
    allowed: () => s.allowed,
    harnesses: () => ["codex"],
    ...(o.offered ? { offered: () => o.offered } : {}),
    session: () => s.session,
    startRoom: () => s.room,
    run: (job, on) => {
      s.jobs.push(job);
      s.on = on;
      (o.answer ?? ((x) => x.began("codex:new")))(on);
      return { cancel: () => s.cancelled++ };
    },
    ack: (_r, id, r) => s.acks.push({ id, ...r }),
    load: () => s.saved,
    save:
      o.save ??
      ((x) => {
        s.saved = structuredClone(x);
      }),
    log: (l) => s.logs.push(l),
    changed: () => s.changed++,
  });
  const take = (n = notice()) => e.fire("card", { kind: "notice", receiver: "board.example", notice: n });
  return { e, s, take };
}
const file = (...rules: TriggerRule[]): TriggersFile => ({ v: 1, on: true, rules });
const lines = (s: { saved?: TriggerState | undefined }, name = "card") => s.saved?.rules[name]?.history ?? [];

describe("the record", () => {
  it("anything that is not one is no record; one without waiting runs has none", () => {
    expect(stateOf(null)).toEqual({ v: 1, rules: {}, waiting: [] });
    expect(stateOf({ v: 1, rules: [] })).toEqual({ v: 1, rules: {}, waiting: [] });
    expect(stateOf({ v: 1, rules: { a: { history: [] } } })).toEqual({
      v: 1,
      rules: { a: { history: [] } },
      waiting: [],
    });
  });
  it("a disk that won't take it is said in the log, and the run still goes", () => {
    const { e, s, take } = rig({
      save: () => {
        throw new Error("the disk is full");
      },
    });
    e.load(file(card()));
    take();
    expect(s.jobs).toHaveLength(1);
    expect(s.logs).toContain("couldn't save the triggers' record: the disk is full");
  });
  it("history keeps a notice's tokens only where they fit their patterns", () => {
    const { e, s, take } = rig();
    e.load(file(card({ cap: { per_day: 1 } })));
    take(notice({ subject: "X-001", state: "todo" }));
    take(notice({ subject: "X-002", state: "Not a state" }));
    expect(lines(s)[0]).toEqual({ at: new Date(T0).toISOString(), result: "refused", code: "cap", subject: "X-002" });
  });
});

describe("the rules file", () => {
  it("no file: no rule takes anything, and the hello says off", () => {
    const { e } = rig();
    expect(e.firstMatch("board.example", notice())).toBeNull();
    expect(e.helloFor("board.example")).toEqual({ on: false, topics: [] });
  });
  it("a rule removed in a file read whole goes from the record; a file refused keeps it", () => {
    const { e, s, take } = rig();
    e.load(file(card()));
    take();
    e.load(null);
    expect(s.saved?.rules.card?.today?.runs).toBe(1);
    e.load(file());
    expect(s.saved?.rules.card).toBeUndefined();
  });
  it("a machine's pause goes when the rule's target changes, and its topic comes back to the hello", () => {
    const { e, s, take } = rig({ session: { gone: true } });
    const r = card({ target: { continue: SID } });
    e.load(file(r));
    take();
    expect(s.acks.at(-1)).toMatchObject({ outcome: "refused", code: "no_session" });
    expect(e.pausedByMachine()).toEqual(["card"]);
    expect(e.helloFor("board.example")).toEqual({ on: true, topics: [] });
    expect(e.firstMatch("board.example", notice())).toBeNull();
    e.load(file(r));
    expect(e.pausedByMachine()).toEqual(["card"]);
    // Other words keep it; another session to continue is a rule the pause no longer concerns.
    e.load(file({ ...r, words: "Card {subject}, again." }));
    expect(e.pausedByMachine()).toEqual(["card"]);
    e.load(file({ ...r, target: { start: "codex" } }));
    expect(e.pausedByMachine()).toEqual([]);
    expect(e.helloFor("board.example")).toEqual({ on: true, topics: ["acme/tasks"] });
  });
  it("resumed in the file, a clock counts from then", () => {
    const { e, s } = rig();
    const tick = card({ source: { every: "2h" }, words: "Go." });
    e.load(file(tick));
    e.check();
    e.load(file({ ...tick, paused: true }));
    s.now += 5 * 3600_000;
    e.check();
    e.load(file(tick));
    expect(s.saved?.rules.card?.clock).toEqual({ every: "2h", since: s.now });
    s.now += 2 * 3600_000;
    e.check();
    expect(s.jobs).toHaveLength(1);
  });
});

describe("one run", () => {
  it("off, a fire is refused triggers_off; a paused rule takes nothing", () => {
    const { e, s, take } = rig();
    e.load({ ...file(card()), on: false });
    take();
    expect(s.acks).toEqual([{ id: notice().id, outcome: "refused", code: "triggers_off" }]);
    e.load(file(card({ paused: true })));
    take();
    e.fire("card", { kind: "tick", due: T0 });
    expect(s.acks.at(-1)).toEqual({ id: notice().id, outcome: "no_match" });
    expect(s.jobs).toEqual([]);
  });
  it("a notice without a state has its own cooldown key", () => {
    const { e, s, take } = rig();
    e.load(file(card()));
    take(notice());
    take(notice({ id: "01KB4M2Q8V3T6Y9C0D1E2F3G4J" }));
    expect(s.acks.map((a) => a.outcome)).toEqual(["ran", "refused"]);
  });
  it("a run that could not begin counts, and is a failure", () => {
    const { e, s, take } = rig({ answer: (on) => on.failed("codex isn't signed in") });
    e.load(file(card()));
    take();
    expect(s.acks).toEqual([{ id: notice().id, outcome: "failed" }]);
    expect(lines(s)[0]?.result).toBe("failed");
    expect(s.saved?.rules.card?.today?.runs).toBe(1);
    expect(e.runningNow()).toEqual([]);
  });
  it("a hold found at the last moment waits again, taken once; past its time it is refused held", () => {
    let held = true;
    const { e, s, take } = rig({
      answer: (on) => (held ? on.refused("held", "a window has it") : on.began(SID)),
      session: { held: false },
    });
    e.load(file(card({ target: { continue: SID } })));
    take();
    expect(s.acks).toEqual([{ id: notice().id, outcome: "taken" }]);
    e.retry();
    expect(s.acks).toHaveLength(1);
    held = false;
    e.retry();
    expect(s.acks.at(-1)).toEqual({ id: notice().id, outcome: "ran", session: SID });
    s.on?.ended(1);
    held = true;
    take(notice({ id: "01KB4M2Q8V3T6Y9C0D1E2F3G4K", subject: "X-002", expires_at: "2026-11-24T09:14:05.000Z" }));
    expect(s.acks.at(-1)).toMatchObject({ outcome: "refused", code: "held" });
    expect(s.saved?.rules.card?.today?.runs).toBe(1);
  });
  it("the caps reached at the last moment wait; a session found gone pauses; any other no is a failure", () => {
    const answers: ((on: RunEvents) => void)[] = [
      (on) => on.refused("start_limit", "full"),
      (on) => on.refused("no_session", "gone"),
    ];
    const { e, s, take } = rig({ answer: (on) => (answers.shift() ?? ((x) => x.refused("permission", "no")))(on) });
    e.load(file(card({ target: { continue: SID } })));
    take();
    expect(e.waitingNow()).toEqual(["card"]);
    e.retry();
    expect(e.pausedByMachine()).toEqual(["card"]);
    expect(s.acks.at(-1)).toMatchObject({ outcome: "refused", code: "no_session" });
    expect(e.lift("card")).toBe(true);
    expect(e.lift("card")).toBe(false);
    take(notice({ subject: "X-009" }));
    expect(s.acks.at(-1)).toEqual({ id: notice().id, outcome: "failed" });
  });
  it("a run that waits is dropped when its rule goes, or its folder is no longer allowed", () => {
    const { e, s, take } = rig();
    s.room = false;
    e.load(file(card(), card({ name: "other" })));
    take();
    e.fire("other", {
      kind: "notice",
      receiver: "board.example",
      notice: notice({ id: "01KB4M2Q8V3T6Y9C0D1E2F3G4M" }),
    });
    expect(e.waitingNow()).toEqual(["card", "other"]);
    // Its rule removed: the switch is on, so its notice met no rule (no_match), and its count goes back.
    e.load(file(card()));
    expect(s.acks.at(-1)).toEqual({ id: "01KB4M2Q8V3T6Y9C0D1E2F3G4M", outcome: "no_match" });
    expect(s.logs).toContain("trigger other: a run that waited was dropped: the rule is paused, removed or changed");
    // Still no room: it keeps waiting, unchecked. Let go: checked again, refused folder.
    s.allowed = false;
    e.retry();
    expect(e.waitingNow()).toEqual(["card"]);
    s.room = true;
    e.retry();
    expect(s.acks.at(-1)).toMatchObject({ id: notice().id, outcome: "refused", code: "folder" });
    expect(s.saved?.rules.card?.today).toEqual({ day: "2026-11-24", runs: 0, keys: [] });
  });
  it("a run that waits meets only its own rule: one changed under the same name drops it, written nowhere", () => {
    const { e, s, take } = rig();
    s.room = false;
    e.load(file(card()));
    take();
    expect(e.waitingNow()).toEqual(["card"]);
    // The same name, other words: the run waited for the rule it was fired for, not this one.
    e.load(file(card({ words: "Something else." })));
    s.room = true;
    e.retry();
    expect(s.jobs).toHaveLength(0);
    expect(s.acks.at(-1)).toEqual({ id: notice().id, outcome: "no_match" });
    expect(lines(s)).toEqual([]);
    expect(s.saved?.rules.card?.today).toEqual({ day: "2026-11-24", runs: 0, keys: [] });
    expect(s.logs).toContain("trigger card: the rule changed while a run of it waited; the run was dropped");
    // The same rule as fired: it runs.
    s.room = false;
    take(notice({ id: "01KB4M2Q8V3T6Y9C0D1E2F3G4N" }));
    s.room = true;
    e.retry();
    expect(s.jobs).toHaveLength(1);
  });
  it("a continued session's own folder is the run's: the rule's, and allowed, or refused folder", () => {
    const { e, s, take } = rig({ session: { held: false, folder: "~/work" } });
    e.load(file(card({ target: { continue: SID } })));
    take();
    expect(s.jobs).toHaveLength(1);
    s.session = { held: false, folder: "~/elsewhere" };
    take(notice({ id: "01KB4M2Q8V3T6Y9C0D1E2F3G4P", subject: "X-002" }));
    expect(s.acks.at(-1)).toMatchObject({ outcome: "refused", code: "folder" });
    s.session = { held: false, folder: null };
    take(notice({ id: "01KB4M2Q8V3T6Y9C0D1E2F3G4R", subject: "X-003" }));
    expect(s.acks.at(-1)).toMatchObject({ outcome: "refused", code: "folder" });
    expect(s.jobs).toHaveLength(1);
  });
  it("a run waiting in its session's line is taken, and at its deadline is stopped and refused held", () => {
    const { e, s, take } = rig({ answer: (on) => on.queued("held") });
    e.load(file(card({ target: { continue: SID } })));
    take(notice({ expires_at: "2026-11-24T10:00:00.000Z" }));
    expect(s.acks).toEqual([{ id: notice().id, outcome: "taken" }]);
    expect(e.waitingNow()).toEqual(["card"]);
    s.now = Date.parse("2026-11-24T10:00:00.000Z");
    e.expire();
    expect(s.cancelled).toBe(1);
    expect(s.acks.at(-1)).toEqual({ id: notice().id, outcome: "refused", code: "held" });
    expect(s.saved?.rules.card?.today?.runs).toBe(0);
  });
  it("a waiting run whose cause does not fit its rule's source is dropped when read", () => {
    const { e, s } = rig({
      saved: {
        v: 1,
        rules: {},
        waiting: [
          {
            rule: "card",
            cause: { kind: "tick", due: T0 - 60_000 },
            until: T0 + 3600_000,
            reason: "held",
            day: "2026-11-24",
            key: null,
          },
        ],
      },
    });
    e.load(file(card()));
    expect(e.waitingNow()).toEqual([]);
    expect(s.logs).toContain("trigger card: a waiting run was dropped: its cause does not fit the rule");
  });
  it("a clock rule's run is acked to nobody", () => {
    const { e, s } = rig({ answer: (on) => on.refused("folder", "no") });
    e.load(file(card({ source: { every: "day 09:00" }, words: "Go." })));
    e.fire("card", { kind: "tick", due: T0 });
    expect(s.acks).toEqual([]);
    expect(lines(s)[0]).toMatchObject({ result: "refused", code: "folder" });
  });
  it("a restart takes up the runs that waited, and a tick waits at most six hours", () => {
    const first = rig();
    first.s.room = false;
    first.e.load(file(card({ source: { every: "day 09:00" }, words: "Go." })));
    // Seen at 09:14: its first tick is the next day's 09:00, which waits for room.
    first.e.check();
    const due = Date.parse("2026-11-25T09:00:00.000Z");
    first.s.now = due + 10_000;
    first.e.check();
    expect(first.e.waitingNow()).toEqual(["card"]);
    const left = structuredClone(first.s.saved);
    const after = rig({ saved: first.s.saved, now: due + 20_000 });
    after.e.load(file(card({ source: { every: "day 09:00" }, words: "Go." })));
    expect(after.e.waitingNow()).toEqual(["card"]);
    after.s.room = false;
    after.s.now = due + 6 * 3600_000;
    after.e.retry();
    expect(lines(after.s)[0]).toMatchObject({ result: "refused", code: "start_limit" });
    // Looked at before any rules file is read: there is no rule to run, and it ends.
    const blind = rig({ saved: left, now: due + 20_000 });
    blind.e.retry();
    expect(blind.e.waitingNow()).toEqual([]);
  });

  it("a harness that takes no level so narrow is refused harness, and the count goes back", () => {
    const { e, s, take } = rig({ offered: ["edits"] });
    e.load(file(card()));
    take();
    expect(s.acks).toEqual([{ id: notice().id, outcome: "refused", code: "harness" }]);
    expect(s.jobs).toEqual([]);
    expect(s.saved?.rules.card?.today?.runs).toBe(0);
  });

  it("a session recorded at a level the machine doesn't know can't be continued: no_session, and the rule paused", () => {
    const { e, s, take } = rig({ session: { held: false, level: "AUTO" as never } });
    e.load(file(card({ target: { continue: SID } })));
    take();
    expect(s.acks).toEqual([{ id: notice().id, outcome: "refused", code: "no_session" }]);
    expect(e.pausedByMachine()).toEqual(["card"]);
  });

  it("one run of a rule at a time: the next waits, taken, and at its deadline is refused busy, its count back", () => {
    const { e, s, take } = rig();
    e.load(file(card()));
    take();
    const first = s.on as RunEvents;
    take(notice({ id: "01KB4M2Q8V3T6Y9C0D1E2F3G4N", subject: "X-2" }));
    expect(s.acks.at(-1)).toEqual({ id: "01KB4M2Q8V3T6Y9C0D1E2F3G4N", outcome: "taken" });
    expect(e.waitingNow()).toEqual(["card"]);
    expect(s.saved?.rules.card?.today?.runs).toBe(2);
    // The first ends: the second goes at once.
    first.ended(5);
    expect(s.acks.at(-1)).toEqual({ id: "01KB4M2Q8V3T6Y9C0D1E2F3G4N", outcome: "ran", session: "codex:new" });
    take(notice({ id: "01KB4M2Q8V3T6Y9C0D1E2F3G4P", subject: "X-3", expires_at: "2026-11-24T10:00:00.000Z" }));
    s.now = Date.parse("2026-11-24T10:00:00.000Z");
    e.expire();
    expect(s.acks.at(-1)).toEqual({ id: "01KB4M2Q8V3T6Y9C0D1E2F3G4P", outcome: "refused", code: "busy" });
    expect(s.saved?.rules.card?.today?.runs).toBe(2);
    // Taken at its own deadline while the rule runs: refused busy at once.
    take(notice({ id: "01KB4M2Q8V3T6Y9C0D1E2F3G4Q", subject: "X-4", expires_at: "2026-11-24T10:00:00.000Z" }));
    expect(s.acks.at(-1)).toEqual({ id: "01KB4M2Q8V3T6Y9C0D1E2F3G4Q", outcome: "refused", code: "busy" });
    // Said of a run that is over already, nothing changes.
    first.ended(9);
    first.failed("late");
    first.refused("held", "late");
  });
  it("a run queued for the headless slot is taken; at its deadline it is stopped and refused start_limit", () => {
    const { e, s, take } = rig({ answer: (on) => on.queued("start_limit") });
    e.load(file(card({ target: { continue: SID } })));
    take(notice({ expires_at: "2026-11-24T10:00:00.000Z" }));
    expect(s.acks).toEqual([{ id: notice().id, outcome: "taken" }]);
    expect(e.runningNow()).toEqual([]);
    expect(e.waitingNow()).toEqual(["card"]);
    s.now = Date.parse("2026-11-24T10:00:00.000Z");
    e.expire();
    expect(s.cancelled).toBe(1);
    expect(s.acks.at(-1)).toEqual({ id: notice().id, outcome: "refused", code: "start_limit" });
    expect(s.saved?.rules.card?.today?.runs).toBe(0);
    (s.on as RunEvents).began(SID);
    expect(s.acks).toHaveLength(2);
  });
  it("a tick that waits for its rule's own run is refused busy at six hours", () => {
    const { e, s } = rig();
    e.load(file(card({ source: { every: "day 09:00" }, words: "Go." })));
    e.fire("card", { kind: "tick", due: T0 });
    e.fire("card", { kind: "tick", due: T0 + 60_000 });
    s.now = T0 + 6 * 3600_000 + 60_000;
    e.retry();
    expect(lines(s)[0]).toMatchObject({ result: "refused", code: "busy" });
  });
});

describe("what the second review found", () => {
  const DAILY = card({ name: "daily", source: { every: "day 09:00" }, cap: { per_day: 1 }, words: "Do it." });
  const WED_1500 = Date.parse("2026-11-25T15:00:00.000Z");
  const tickWait = (due: number, over: Record<string, unknown> = {}) => ({
    rule: "daily",
    cause: { kind: "tick", due },
    until: 8.64e15,
    reason: "busy",
    day: "2026-11-25",
    key: null,
    ...over,
  });

  it("a hand-made record runs a rule no more than its cap, and only for ticks its clock had", () => {
    // Six waiting ticks at 14:59:59 for a day-09:00 rule of cap 1: none is a tick of its clock.
    const fake = rig({
      now: WED_1500,
      saved: {
        v: 1,
        rules: {
          daily: { history: [], clock: { every: "day 09:00", since: WED_1500 - 3600_000, last: WED_1500 - 3600_000 } },
        },
        waiting: Array.from({ length: 6 }, () => tickWait(WED_1500 - 1000)),
      },
    });
    fake.e.load(file(DAILY));
    fake.e.check();
    expect(fake.s.jobs).toHaveLength(0);
    expect(fake.s.logs.filter((l) => l.endsWith("its tick is no tick of the rule's clock"))).toHaveLength(6);
    expect(fake.s.saved?.rules.daily?.today?.runs ?? 0).toBe(0);
    // Six copies of its real 09:00 tick: one is kept (the rest are there twice), and it runs once.
    const nine = Date.parse("2026-11-25T09:00:00.000Z");
    const real = rig({
      now: WED_1500,
      saved: {
        v: 1,
        rules: { daily: { history: [], clock: { every: "day 09:00", since: nine - 86400_000, last: nine } } },
        waiting: Array.from({ length: 6 }, () => tickWait(nine)),
      },
    });
    real.s.room = false;
    real.e.load(file(DAILY));
    expect(real.e.waitingNow()).toEqual(["daily"]);
    expect(real.s.logs.filter((l) => l.endsWith("it is there twice"))).toHaveLength(5);
    expect(real.s.saved?.rules.daily?.today?.runs).toBe(1);
    // Four real ticks of a 15-minute clock waiting for one day, cap 2: the two oldest are kept.
    const every = card({ name: "daily", source: { every: "15m" }, cap: { per_day: 2 }, words: "Do it." });
    const since = WED_1500 - 3600_000;
    const four = rig({
      now: WED_1500,
      saved: {
        v: 1,
        rules: { daily: { history: [], clock: { every: "15m", since, last: since + 60 * 60_000 } } },
        waiting: [1, 2, 3, 4].map((k) => tickWait(since + k * 15 * 60_000)),
      },
    });
    four.s.room = false;
    four.e.load(file(every));
    expect(four.e.waitingNow()).toEqual(["daily", "daily"]);
    expect(four.s.logs.filter((l) => l.endsWith("more wait for that day than the rule's cap"))).toHaveLength(2);
    // An interval tick off its clock's step, and one before the clock began, are no ticks either.
    const off = rig({
      now: WED_1500,
      saved: {
        v: 1,
        rules: { daily: { history: [], clock: { every: "15m", since, last: since + 60 * 60_000 } } },
        waiting: [tickWait(since + 7 * 60_000), tickWait(since - 15 * 60_000), tickWait(since + 30 * 60_000)],
      },
    });
    off.s.room = false;
    off.e.load(file(every));
    expect(off.e.waitingNow()).toEqual(["daily"]);
    // A clock rule whose record has no clock: no tick of it can have waited.
    const none = rig({ now: WED_1500, saved: { v: 1, rules: {}, waiting: [tickWait(nine)] } });
    none.e.load(file(DAILY));
    expect(none.e.waitingNow()).toEqual([]);
  });

  it("every waiting run the record or the rules drop gets its notice's final ack", () => {
    const n = (id: string, over: Partial<ControlNotice> = {}) => notice({ id, ...over });
    const nw = (id: string, over: Record<string, unknown> = {}, nOver: Partial<ControlNotice> = {}) => ({
      rule: "card",
      cause: { kind: "notice", receiver: "board.example", notice: n(id, nOver) },
      until: T0 + 3600_000,
      reason: "start_limit",
      day: "2026-11-24",
      key: null,
      ...over,
    });
    const { e, s } = rig({
      saved: {
        v: 1,
        rules: {},
        waiting: [
          nw("01KB4M2Q8V3T6Y9C0D1E2F3G41", { rule: "Not A Name" }),
          nw("01KB4M2Q8V3T6Y9C0D1E2F3G42", { reason: "bored" }, { expires_at: "2026-11-24T09:00:00.000Z" }),
          nw("01KB4M2Q8V3T6Y9C0D1E2F3G43"),
          nw("01KB4M2Q8V3T6Y9C0D1E2F3G43"),
          nw("01KB4M2Q8V3T6Y9C0D1E2F3G44", { key: "X-002/" }, { subject: "X-002" }),
          nw("01KB4M2Q8V3T6Y9C0D1E2F3G45", { key: "X-003/" }, { subject: "X-003" }),
          nw("01KB4M2Q8V3T6Y9C0D1E2F3G46", { rule: "gone" }),
        ],
      },
    });
    // Read: a rule's name that is none, and a run past its time, are told so at once.
    expect(s.acks).toEqual([
      { id: "01KB4M2Q8V3T6Y9C0D1E2F3G41", outcome: "no_match" },
      { id: "01KB4M2Q8V3T6Y9C0D1E2F3G42", outcome: "expired" },
    ]);
    s.room = false;
    e.load(file(card({ cap: { per_day: 2 } })));
    // Against the rules: one there twice is no rule's run; one past the cap is refused cap; one
    // for a rule that is not there met no rule.
    expect(s.acks.slice(2)).toEqual([
      { id: "01KB4M2Q8V3T6Y9C0D1E2F3G43", outcome: "no_match" },
      { id: "01KB4M2Q8V3T6Y9C0D1E2F3G45", outcome: "refused", code: "cap" },
      { id: "01KB4M2Q8V3T6Y9C0D1E2F3G46", outcome: "no_match" },
    ]);
    expect(e.waitingNow()).toEqual(["card", "card"]);
    // More than the record keeps: refused cap, each told.
    const many = rig({
      saved: {
        v: 1,
        rules: {},
        waiting: Array.from({ length: 2502 }, (_x, i) => nw(`01KB4M2Q8V3T6Y9C0D1E2F${String(i).padStart(4, "0")}`)),
      },
    });
    expect(many.s.acks).toEqual([
      { id: "01KB4M2Q8V3T6Y9C0D1E2F2500", outcome: "refused", code: "cap" },
      { id: "01KB4M2Q8V3T6Y9C0D1E2F2501", outcome: "refused", code: "cap" },
    ]);
  });

  it("a rule paused or removed drops its waiting and queued runs as no_match; off is triggers_off", () => {
    const { e, s, take } = rig({ answer: () => {} });
    s.room = false;
    e.load(file(card()));
    take();
    expect(e.waitingNow()).toEqual(["card"]);
    e.load(file(card({ paused: true })));
    expect(s.acks.at(-1)).toEqual({ id: notice().id, outcome: "no_match" });
    expect(s.saved?.rules.card?.today?.runs).toBe(0);
    expect(lines(s)).toEqual([]);
    // Queued in the daemon (its session's line): dropped the same way, and cancelled.
    const q = rig({ answer: (on) => on.queued("held") });
    q.e.load(file(card()));
    q.take();
    q.e.load(file());
    expect(q.s.cancelled).toBe(1);
    expect(q.s.acks.at(-1)).toEqual({ id: notice().id, outcome: "no_match" });
    // A running one is left to finish when its rule is paused; turned off, it is stopped.
    const r = rig({ answer: (on) => on.began("codex:x") });
    r.e.load(file(card()));
    r.take();
    r.e.load(file(card({ paused: true })));
    expect(r.s.cancelled).toBe(0);
    r.e.load({ v: 1, on: false, rules: [card()] });
    expect(r.s.cancelled).toBe(1);
    // Off, a waiting one is refused triggers_off.
    const o = rig();
    o.s.room = false;
    o.e.load(file(card()));
    o.take();
    o.e.load({ v: 1, on: false, rules: [card()] });
    expect(o.s.acks.at(-1)).toEqual({ id: notice().id, outcome: "refused", code: "triggers_off" });
  });

  it("the fingerprint is of what a run does: key order, defaults and the pause change nothing", () => {
    const r = card({ when: { state: ["todo", "review"] }, tools: ["mcp__a", "mcp__b"] });
    const shuffled = JSON.parse(
      '{"words":"Card {subject}.","tools":["mcp__b","mcp__a","mcp__a"],"cap":{"per_day":9},"level":"safe","folder":"~/work","target":{"start":"codex"},"subject":"","when":{"for":[],"state":["review","todo"]},"source":{"topic":"acme/tasks","receiver":"board.example"},"paused":true,"name":"card"}',
    ) as TriggerRule;
    expect(fingerprint(shuffled)).toBe(fingerprint(r));
    expect(fingerprint(card({ tools: [], when: {} }))).toBe(fingerprint(card()));
    expect(fingerprint(card({ words: "Other." }))).not.toBe(fingerprint(card()));
    expect(fingerprint(card({ level: "edits" }))).not.toBe(fingerprint(card()));
    // A run that waits through a re-read of the same rule, spelled another way, is still its own.
    const { e, s, take } = rig();
    s.room = false;
    e.load(file(r));
    take();
    e.load(file(shuffled.paused ? { ...shuffled, paused: false } : shuffled));
    s.room = true;
    e.retry();
    expect(s.jobs).toHaveLength(1);
  });

  it("the daemon stopping puts a run that waits in its session's line back with the waiting", () => {
    const first = rig({ answer: (on) => on.queued("held") });
    first.e.load(file(card({ target: { continue: SID } })));
    first.take();
    expect(first.s.saved?.rules.card?.today?.runs).toBe(1);
    first.e.suspend();
    expect(first.s.cancelled).toBe(1);
    expect(first.s.saved?.waiting.map((w) => [w.rule, w.reason, w.told])).toEqual([["card", "held", true]]);
    // The next daemon has it waiting, its count as it was; it runs when its session is free.
    const next = rig({ saved: first.s.saved });
    next.e.load(file(card({ target: { continue: SID } })));
    expect(next.e.waitingNow()).toEqual(["card"]);
    expect(next.s.saved?.rules.card?.today?.runs).toBe(1);
    next.e.retry();
    expect(next.s.jobs).toHaveLength(1);
    expect(next.s.acks).toEqual([{ id: notice().id, outcome: "ran", session: "codex:new" }]);
    // Or it expires at its deadline, refused held, its count back.
    const late = rig({ saved: first.s.saved, session: { held: true } });
    late.e.load(file(card({ target: { continue: SID } })));
    late.s.now = Date.parse(notice().expires_at);
    late.e.retry();
    expect(late.s.acks).toEqual([{ id: notice().id, outcome: "refused", code: "held" }]);
    expect(late.s.saved?.rules.card?.today?.runs).toBe(0);
  });
});

describe("nothing a dependency throws wedges the engine", () => {
  const SESSION = "claude-code:8c132906-8c3f-4814-870a-afc3d05e1d2e";
  type Dep =
    | "session"
    | "allowed"
    | "harnesses"
    | "startRoom"
    | "offered"
    | "mode"
    | "run"
    | "ack"
    | "changed"
    | "noted"
    | "cancel";
  /** An engine whose dependency `which` throws the next `times` times it is asked. */
  function shaky(which: Dep, rule: TriggerRule) {
    const s = {
      now: Date.parse("2026-11-24T08:00:00.000Z"),
      left: 0,
      held: false,
      jobs: 0,
      logs: [] as string[],
      acks: [] as string[],
    };
    const boom = <T>(d: Dep, v?: T): T => {
      if (which === d && s.left > 0) {
        s.left--;
        throw new Error(`boom in ${d}`);
      }
      return v as T;
    };
    const e = new TriggerEngine({
      now: () => s.now,
      zone: "UTC",
      mode: () => boom("mode", "auto"),
      allowed: () => boom("allowed", true),
      harnesses: () => boom("harnesses", ["codex", "claude-code"]),
      offered: () => boom("offered", undefined),
      session: () => boom("session", { held: s.held }),
      startRoom: () => boom("startRoom", true),
      run: (_job, on) => {
        boom("run");
        s.jobs++;
        on.began(SESSION);
        on.ended(1);
        return { cancel: () => boom("cancel") };
      },
      ack: (_r, id, r) => {
        boom("ack");
        s.acks.push(`${id} ${r.outcome}`);
      },
      changed: () => boom("changed"),
      noted: () => boom("noted"),
      load: () => undefined,
      save: () => {},
      log: (l) => s.logs.push(l),
    });
    e.load({ v: 1, on: true, rules: [rule] });
    e.check();
    return { e, s };
  }
  const clock = (target: TriggerRule["target"]) =>
    card({ name: "c", source: { every: "15m" }, target, cap: { per_day: 50 }, words: "Go." });

  for (const which of ["session", "allowed", "harnesses", "startRoom", "offered", "mode", "run", "noted"] as const)
    it(`${which} throwing once at a tick: logged, and the next tick runs`, () => {
      const { e, s } = shaky(which, clock(which === "session" ? { continue: SESSION } : { start: "codex" }));
      s.left = 1;
      s.now += 15 * 60_000 + 1;
      e.check();
      expect(s.logs.some((l) => l.includes(`boom in ${which}`))).toBe(true);
      s.now += 15 * 60_000;
      e.check();
      expect(s.jobs).toBeGreaterThanOrEqual(1);
      s.now += 15 * 60_000;
      const before = s.jobs;
      e.check();
      expect(s.jobs).toBe(before + 1);
    });

  it("a throw inside retry leaves every waiting run waiting, and the next look lets them go", () => {
    const { e, s } = shaky("session", clock({ continue: SESSION }));
    s.held = true;
    s.now += 15 * 60_000 + 1;
    e.check();
    expect(e.waitingNow()).toEqual(["c"]);
    s.left = 5;
    e.retry();
    expect(e.waitingNow()).toEqual(["c"]);
    expect(
      s.logs.some((l) => l.includes("a look at a run that waits failed (Error: boom in session); it waits on")),
    ).toBe(true);
    s.left = 0;
    s.held = false;
    s.now += 15 * 60_000;
    e.check();
    expect(s.jobs).toBe(2);
    expect(e.waitingNow()).toEqual([]);
    // Held again, and past its six hours: it is refused at its deadline, as ever.
    s.held = true;
    s.now += 15 * 60_000;
    e.check();
    s.left = 1;
    s.now += 6 * 3600_000;
    e.retry();
    expect(e.waitingNow().length).toBeLessThanOrEqual(1);
  });

  it("an ack, a hello, a cancel or a history line that throws is logged and changes nothing else", () => {
    const n = notice();
    const r = card({ name: "c", cap: { per_day: 50 } });
    const ack = shaky("ack", r);
    ack.s.left = 1;
    ack.e.fire("c", { kind: "notice", receiver: "board.example", notice: n });
    expect(ack.s.jobs).toBe(1);
    expect(ack.s.logs.some((l) => l.startsWith("trigger rules: a notice's ack failed (Error: boom in ack)"))).toBe(
      true,
    );
    const hello = shaky("changed", r);
    hello.s.left = 1;
    hello.e.load({ v: 1, on: false, rules: [r] });
    expect(hello.s.logs.some((l) => l.startsWith("trigger rules: the hello failed"))).toBe(true);
    hello.e.load({ v: 1, on: true, rules: [r] });
    hello.e.fire("c", { kind: "notice", receiver: "board.example", notice: n });
    expect(hello.s.jobs).toBe(1);
    // A cancel that throws, at off: the run is still let go of.
    const cancel = new TriggerEngine({
      now: () => T0,
      zone: "UTC",
      mode: () => "auto",
      allowed: () => true,
      harnesses: () => ["codex"],
      session: () => ({ held: false }),
      startRoom: () => true,
      run: (_j, on) => {
        on.queued("start_limit");
        return {
          cancel: () => {
            throw new Error("boom in cancel");
          },
        };
      },
      load: () => undefined,
      save: () => {},
      log: (l) => hello.s.logs.push(l),
    });
    cancel.load({ v: 1, on: true, rules: [r] });
    cancel.fire("c", { kind: "notice", receiver: "board.example", notice: n });
    expect(cancel.waitingNow()).toEqual(["c"]);
    cancel.load({ v: 1, on: false, rules: [r] });
    expect(cancel.waitingNow()).toEqual([]);
    cancel.load({ v: 1, on: true, rules: [r] });
    cancel.fire("c", {
      kind: "notice",
      receiver: "board.example",
      notice: notice({ id: "01KB4M2Q8V3T6Y9C0D1E2F3G4Z", subject: "X-9" }),
    });
    cancel.suspend();
    expect(hello.s.logs.filter((l) => l.includes("boom in cancel"))).toHaveLength(2);
  });

  it("a runner that says the turn began and then throws: the run is running, and nothing is said twice", () => {
    const ons: RunEvents[] = [];
    const s = { now: T0, acks: [] as string[], logs: [] as string[], room: true };
    const e = new TriggerEngine({
      now: () => s.now,
      zone: "UTC",
      mode: () => "auto",
      allowed: () => true,
      harnesses: () => ["codex"],
      session: () => ({ held: false }),
      startRoom: () => s.room,
      run: (_j, on) => {
        ons.push(on);
        on.began("codex:x");
        throw new Error("after it began");
      },
      ack: (_r, id, r) => s.acks.push(`${id} ${r.outcome}`),
      load: () => undefined,
      save: () => {},
      log: (l) => s.logs.push(l),
    });
    const r = card({ name: "c", cap: { per_day: 50 } });
    e.load(file(r));
    e.fire("c", { kind: "notice", receiver: "board.example", notice: notice({ state: "todo" }) });
    expect(s.acks).toEqual([`${notice().id} ran`]);
    expect(e.runningNow()).toEqual(["c"]);
    // From a retry: a run that waited, let go, begins and the runner throws: it is not put back.
    s.room = false;
    e.fire("c", {
      kind: "notice",
      receiver: "board.example",
      notice: notice({ id: "01KB4M2Q8V3T6Y9C0D1E2F3G4W", subject: "X-7" }),
    });
    expect(e.waitingNow()).toEqual(["c"]);
    (ons[0] as RunEvents).ended(1);
    s.room = true;
    e.retry();
    expect(e.waitingNow()).toEqual([]);
    expect(e.runningNow()).toEqual(["c"]);
    expect(s.logs.some((l) => l.includes("a look at a run that waits failed (Error: after it began)"))).toBe(true);
  });

  it("a fire that throws before anything is counted says the run could not begin", () => {
    const r = card({ name: "c", cap: { per_day: 50 } });
    const { e, s } = shaky("allowed", r);
    s.left = 1;
    e.fire("c", { kind: "notice", receiver: "board.example", notice: notice({ state: "todo" }) });
    expect(s.acks).toEqual([`${notice().id} failed`]);
    expect(s.logs).toContain("trigger c: the run could not begin: Error: boom in allowed");
    // And one that throws after it was counted gives its count back.
    const run = shaky("run", r);
    run.s.left = 1;
    run.e.fire("c", { kind: "notice", receiver: "board.example", notice: notice() });
    expect(run.s.acks).toEqual([`${notice().id} failed`]);
    run.e.fire("c", {
      kind: "notice",
      receiver: "board.example",
      notice: notice({ id: "01KB4M2Q8V3T6Y9C0D1E2F3G4Y", subject: "X-8" }),
    });
    expect(run.s.jobs).toBe(1);
  });
});
