// SPDX-License-Identifier: Apache-2.0
// The trigger engine's own corners (control/triggers.ts), beyond what the scenario files say:
// what the daemon's runner may answer (a failure, a refusal, a hold found at the last moment),
// a record that can't be saved or read, a rule changed or removed in the file, a resume, the
// hello's topics with the machine's own pauses, and the order of the checks.
import type { ControlNotice, NoticeResult, StartPermission, TriggerRule, TriggersFile } from "@sessionpipe/core";
import { describe, expect, it } from "vitest";
import {
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
  } = {},
) {
  const s = {
    now: T0,
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
    e.load(file(card()));
    expect(s.acks.at(-1)).toMatchObject({ id: "01KB4M2Q8V3T6Y9C0D1E2F3G4M", outcome: "refused", code: "triggers_off" });
    // Still no room: it keeps waiting, unchecked. Let go: checked again, refused folder.
    s.allowed = false;
    e.retry();
    expect(e.waitingNow()).toEqual(["card"]);
    s.room = true;
    e.retry();
    expect(s.acks.at(-1)).toMatchObject({ id: notice().id, outcome: "refused", code: "folder" });
    expect(s.saved?.rules.card?.today).toEqual({ day: "2026-11-24", runs: 0, keys: [] });
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
    first.e.fire("card", { kind: "tick", due: T0 });
    const left = structuredClone(first.s.saved);
    const after = rig({ saved: first.s.saved });
    after.e.load(file(card({ source: { every: "day 09:00" }, words: "Go." })));
    expect(after.e.waitingNow()).toEqual(["card"]);
    after.s.room = false;
    after.s.now = T0 + 6 * 3600_000;
    after.e.retry();
    expect(lines(after.s)[0]).toMatchObject({ result: "refused", code: "start_limit" });
    // Looked at before any rules file is read: there is no rule to run, and it ends.
    const blind = rig({ saved: left });
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
    const { e, s, take } = rig({ answer: (on) => on.queued() });
    e.load(file(card({ target: { continue: SID } })));
    take(notice({ expires_at: "2026-11-24T10:00:00.000Z" }));
    expect(s.acks).toEqual([{ id: notice().id, outcome: "taken" }]);
    expect(e.runningNow()).toEqual(["card"]);
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
