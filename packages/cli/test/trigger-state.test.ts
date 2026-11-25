// SPDX-License-Identifier: Apache-2.0
// The daemon's record of the rules (`triggers-state.json`), read as untrusted input
// (src/control/trigger-state.ts): every shape that does not fit is dropped and said, nothing in it
// widens a rule (a count below zero, a waiting run past its cause's deadline or of the wrong kind
// of cause, a tick in the future), a rule named `constructor` is a rule like any other, and a file
// over the size cap is no record.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readStateFile, STATE_MAX_BYTES, stateOf, WAITING_MAX } from "../src/control/trigger-state.js";

const NOW = Date.parse("2026-11-24T09:30:00.000Z");
const notice = {
  id: "01KB4M2Q8V3T6Y9C0D1E2F3G4H",
  topic: "acme/tasks",
  event: "record.updated",
  subject: "X-1",
  state: "todo",
  at: "2026-11-24T09:00:00.000Z",
  expires_at: "2026-11-24T12:00:00.000Z",
};
const tick = { kind: "tick", due: NOW - 60_000 };
const wait = (over: Record<string, unknown> = {}) => ({
  rule: "card",
  cause: tick,
  until: NOW + 3600_000,
  reason: "held",
  day: "2026-11-24",
  key: null,
  ...over,
});
const read = (v: unknown) => {
  const log: string[] = [];
  return { s: stateOf(v, { now: NOW, log: (l) => log.push(l) }), log };
};

describe("the triggers' record, read", () => {
  it("nothing is an empty record; another version's shape, or none, is an empty record said once", () => {
    expect(stateOf(undefined)).toEqual({ v: 1, rules: {}, waiting: [] });
    for (const v of [null, [], "x", 3, { v: 2, rules: {} }, { v: 1, rules: [] }, { v: 1 }]) {
      const { s, log } = read(v);
      expect(s).toMatchObject({ v: 1, waiting: [] });
      expect(Object.keys(s.rules)).toEqual([]);
      expect(log).toEqual(["the triggers' record is not one this version reads: it starts empty"]);
    }
  });

  it("a rule named constructor, or __proto__, is a name like any other, and no name is looked up on Object", () => {
    const { s, log } = read(JSON.parse('{"v":1,"rules":{"constructor":{"history":[]},"__proto__":{"history":[]}}}'));
    expect(Object.getPrototypeOf(s.rules)).toBeNull();
    expect(Object.hasOwn(s.rules, "constructor")).toBe(true);
    // __proto__ is no rule's name (a name starts with a letter or a digit): dropped, and said.
    expect(Object.keys(s.rules)).toEqual(["constructor"]);
    expect(log[0]).toContain('a rule\'s record that does not fit ("__proto__")');
    expect(stateOf({ v: 1, rules: {}, waiting: [] }).rules.toString).toBeUndefined();
  });

  it("a rule's record of the wrong shape is dropped; each part that does not fit is left out", () => {
    const { s, log } = read({
      v: 1,
      rules: {
        a: { history: {}, today: { day: "x", runs: 1 }, clock: { every: "day 09:00", since: "y" }, paused: { at: 1 } },
        b: "no",
        c: {
          history: [
            { at: "2026-11-24T09:00:00.000Z", result: "ran" },
            { at: 5 },
            { at: "2026-11-24T09:00:00.000Z", result: "refused", code: "not_yet_known" },
            { at: "2026-11-24T09:00:00.000Z", result: "refused", code: "NOT A CODE" },
          ],
          today: { day: "2026-11-24", runs: 2, keys: ["X-1/todo", "bad key", 7] },
          paused: { at: "2026-11-24T09:00:00.000Z", code: "no_session", rule: "{}", why: "gone" },
        },
        d: {
          today: { day: "2026-11-24", runs: -5 },
          paused: { at: "t", code: "no_session", rule: "{}", why: "other" },
        },
      },
      waiting: [],
    });
    expect(s.rules.a).toEqual({ history: [] });
    expect(s.rules.b).toBeUndefined();
    // A newer version's refusal code is kept: `list` says it as a reason it doesn't know.
    expect(s.rules.c?.history.map((l) => l.code ?? l.result)).toEqual(["ran", "not_yet_known"]);
    expect(s.rules.c?.today).toEqual({ day: "2026-11-24", runs: 2, keys: ["X-1/todo"] });
    expect(s.rules.c?.paused).toEqual({ at: "2026-11-24T09:00:00.000Z", code: "no_session", rule: "{}", why: "gone" });
    expect(s.rules.d?.today).toEqual({ day: "2026-11-24", runs: 0, keys: [] });
    expect(s.rules.d?.paused).toEqual({ at: "t", code: "no_session", rule: "{}" });
    expect(log).toHaveLength(1);
  });

  it("a clock's last tick or start in the future is counted from now, and said", () => {
    const { s, log } = read({
      v: 1,
      rules: {
        a: { history: [], clock: { every: "day 09:00", since: NOW + 1e9, last: NOW + 1e9 } },
        b: { history: [], clock: { every: "day 09:00", since: NOW - 5 } },
      },
      waiting: [],
    });
    expect(s.rules.a?.clock).toEqual({ every: "day 09:00", since: NOW, last: NOW });
    expect(s.rules.b?.clock).toEqual({ every: "day 09:00", since: NOW - 5 });
    expect(log[0]).toContain("a clock's last tick or start lay in the future; counted from now");
  });

  it("a waiting run waits no longer than its cause's own deadline, and holds its count of the day", () => {
    const { s } = read({
      v: 1,
      rules: { card: { history: [], today: { day: "2026-11-24", runs: 0 } } },
      waiting: [
        wait({ until: 1e15 }),
        wait({ cause: { kind: "notice", receiver: "board.example", notice }, until: 1e15, told: true, shape: "{}" }),
        wait({ rule: "other", day: "2026-11-23", key: "X-1/todo" }),
      ],
    });
    expect(s.waiting.map((w) => w.until)).toEqual([
      tick.due + 6 * 3600_000,
      Date.parse(notice.expires_at),
      NOW + 3600_000,
    ]);
    expect(s.waiting[1]).toMatchObject({ told: true, shape: "{}" });
    expect(s.waiting[2]?.key).toBe("X-1/todo");
    expect(s.rules.card?.today?.runs).toBe(2);
    expect(s.rules.other?.today).toEqual({ day: "2026-11-23", runs: 1, keys: [] });
  });

  it("a waiting run of the wrong shape is dropped and said", () => {
    const bad = [
      null,
      "x",
      wait({ rule: "Bad Name" }),
      wait({ cause: null }),
      wait({ cause: { kind: "tick", due: "x" } }),
      wait({ cause: { kind: "tick", due: NOW + 60_000 } }),
      wait({ cause: { kind: "notice", receiver: "b", notice: { id: 1 } } }),
      wait({ cause: { kind: "notice", receiver: "b".repeat(300), notice } }),
      wait({ cause: { kind: "other" } }),
      wait({ until: "soon" }),
      wait({ day: "today" }),
      wait({ reason: "bored" }),
    ];
    const { s, log } = read({ v: 1, rules: {}, waiting: [...bad, wait({ key: "no key", shape: "x".repeat(200) })] });
    expect(s.waiting).toHaveLength(1);
    expect(s.waiting[0]?.key).toBeNull();
    expect(s.waiting[0]?.shape).toBeUndefined();
    expect(log).toEqual(["the triggers' record held what does not fit, dropped: a waiting run that does not fit"]);
    expect(
      read({
        v: 1,
        rules: {},
        waiting: Array.from({ length: WAITING_MAX + 5 }, (_x, i) =>
          wait({ cause: { kind: "tick", due: tick.due - i } }),
        ),
      }).s.waiting,
    ).toHaveLength(WAITING_MAX);
    // One run a cause: a copy is dropped as it is read, and said.
    const twice = read({ v: 1, rules: {}, waiting: [wait(), wait(), wait({ rule: "other" })] });
    expect(twice.s.waiting.map((w) => w.rule)).toEqual(["card", "other"]);
    expect(twice.log).toEqual(["the triggers' record held what does not fit, dropped: a waiting run there twice"]);
  });

  it("on disk: missing, not JSON or over the size cap reads as nothing; the cap is said", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "sp-trigger-state-"));
    try {
      const f = path.join(dir, "triggers-state.json");
      const log: string[] = [];
      expect(readStateFile(f, (l) => log.push(l))).toBeUndefined();
      writeFileSync(f, "{");
      expect(readStateFile(f)).toBeUndefined();
      writeFileSync(f, '{"v":1}');
      expect(readStateFile(f)).toEqual({ v: 1 });
      writeFileSync(f, " ".repeat(STATE_MAX_BYTES + 1));
      expect(readStateFile(f, (l) => log.push(l))).toBeUndefined();
      expect(readStateFile(f)).toBeUndefined();
      expect(log).toEqual(["the triggers' record is larger than any this version writes: it starts empty"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
