// SPDX-License-Identifier: Apache-2.0
// conformance/triggers/*.json (CONTROL.md §14), held against the definition: every rules file reads
// or is refused as its case says, every notice reads as the pure functions read it, every run a
// match makes is the rule's own, every hello says the topics and nothing else, and every ack fits
// control-notice-ack.json. What needs a machine's state is held against a small model of §14.7
// below, step by step: dedup, when a run counts and when the count is given back, the cooldown and
// the cap, the allowlist, the harnesses, held sessions, the start caps, the clock (in UTC), the
// machine's own pause and turning off. The model is this test's reading of the spec, not a daemon:
// the daemon's tests run the same files against the daemon. What neither checks here is listed in
// conformance/README.md: a clock in another time zone, a restart while a run waits, and a
// permission prompt left unanswered (the files say what must happen; only a daemon can show it).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SCHEMAS, validate } from "../src/schema/index.js";
import { noticeId, noticesIn, parseNotice } from "../src/triggers/notice.js";
import { subjectPattern } from "../src/triggers/pattern.js";
import {
  checkTriggers,
  firstMatch,
  helloTriggers,
  isNoticeSource,
  isStart,
  parseEvery,
  type TriggerPlaces,
  triggerRun,
} from "../src/triggers/rules.js";
import type { ControlNotice, MachineMode, StartPermission, TriggerRule, TriggersFile } from "../src/types.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dir = path.join(root, "conformance/triggers");
const read = (f: string) => JSON.parse(readFileSync(path.join(dir, f), "utf8"));
const PURE = new Set(["subject-patterns.json", "rules-file.json"]);
const scenarios = readdirSync(dir)
  .filter((f) => f.endsWith(".json") && !PURE.has(f))
  .sort();

interface Ack {
  id: string;
  outcome: string;
  code?: string;
  session?: string;
}
interface Run {
  rule: string;
  run: unknown;
  env: Record<string, string>;
}
interface History {
  rule: string;
  result: string;
  code?: string;
}
interface Machine {
  mode: MachineMode;
  folders: string[];
  harnesses: string[];
  receivers: string[];
  places: TriggerPlaces;
  levels?: Record<string, StartPermission[]>;
}
interface Step {
  at?: string;
  poll?: { receiver: string; body: { messages?: { id: string }[]; notices?: unknown[] } };
  hello?: string;
  change?: unknown;
  machine?: Partial<Machine>;
  tick?: string;
  wake?: boolean;
  asleep?: string;
  release?: string;
  start_ended?: number;
  permission?: unknown;
  expect: {
    acks?: Ack[];
    runs?: Run[];
    triggers?: unknown;
    hello?: boolean;
    history?: History[];
    unacked?: string[];
    cancelled?: number[];
    paused?: string[];
    message_acks?: string[];
    answered_by_machine?: boolean;
  };
}
interface Case {
  name: string;
  machine: Machine;
  triggers: unknown;
  triggers_ok?: boolean;
  sessions?: Record<string, { level: StartPermission; held: boolean }>;
  seen?: { receiver: string; id: string; at: string }[];
  today?: { rule: string; subject?: string; state?: string; at: string; result: string }[];
  starts?: { running: number; last_hour: number };
  limits?: { start_concurrent?: number };
  last_tick?: Record<string, string>;
  zone?: string;
  steps: Step[];
}
const STEP_KINDS = ["poll", "hello", "change", "machine", "tick", "wake", "release", "start_ended", "permission"];
const EXPECT_KEYS = new Set([
  "acks",
  "runs",
  "triggers",
  "hello",
  "history",
  "unacked",
  "cancelled",
  "paused",
  "message_acks",
  "answered_by_machine",
]);
const AT = "2026-11-24T09:14:05.000Z";
const H = 3600_000;
const day = (t: number) => new Date(t).toISOString().slice(0, 10);

/** The rules file as the machine reads it: refused or absent is no rules, triggers off. */
function rulesOf(v: unknown, places: TriggerPlaces, expectOk = true): TriggersFile | null {
  if (v === null) return null;
  const r = checkTriggers(v, places);
  expect(r.ok, JSON.stringify(r.ok ? "" : r.problems)).toBe(expectOk);
  return r.ok ? r.file : null;
}
/** An ack as a machine sends it: its clock, and a real session id where the fixture says any. */
const sent = (a: Ack) => ({
  ...a,
  at: AT,
  ...(a.session ? { session: a.session.replace(/:\*$/, ":8c132906-8c3f-4814-870a-afc3d05e1d2e") } : {}),
});

/** The latest tick of a clock rule after `from` and at most `to` (UTC), or null. */
function latestTick(every: string, from: number, to: number, last?: number): number | null {
  const e = parseEvery(every) as Exclude<ReturnType<typeof parseEvery>, { error: string }>;
  if (e.kind === "interval") {
    const n = Math.floor((to - last!) / (e.minutes * 60_000));
    const t = last! + n * e.minutes * 60_000;
    return n > 0 && t > from ? t : null;
  }
  for (let d = 0; ; d++) {
    const base = new Date(to - d * 24 * H);
    const t = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), 0, e.at);
    if (t > to || (e.kind === "week" && new Date(t).getUTCDay() !== e.day)) continue;
    return t > from ? t : null;
  }
}

/** One case run through the model, step by step, against what each step expects. */
function runCase(c: Case) {
  expect([undefined, "UTC"], `${c.name}: the model reads the clock in UTC only`).toContain(c.zone);
  const machine: Machine = structuredClone(c.machine);
  let file = rulesOf(c.triggers, machine.places, c.triggers_ok ?? true);
  const sessions = structuredClone(c.sessions ?? {});
  const seen = new Map((c.seen ?? []).map((s) => [`${s.receiver}|${s.id}`, Date.parse(s.at)]));
  const counted: {
    rule: string;
    subject?: string | undefined;
    state?: string | undefined;
    day: string;
    id?: string;
  }[] = (c.today ?? [])
    .filter((t) => t.result === "ran" || t.result === "failed")
    .map((t) => ({ rule: t.rule, subject: t.subject, state: t.state, day: day(Date.parse(t.at)) }));
  const starts = { ...(c.starts ?? { running: 0, last_hour: 0 }) };
  const concurrent = c.limits?.start_concurrent ?? 2;
  const lastTick = new Map(Object.entries(c.last_tick ?? {}).map(([k, v]) => [k, Date.parse(v)]));
  const machinePaused = new Set<string>();
  type Waiting = { id: string; rule: TriggerRule; notice: ControlNotice; why: "held" | "start_limit"; until: number };
  let waiting: Waiting[] = [];
  let triggeredRuns = 0;

  const harnessOf = (r: TriggerRule) => (isStart(r.target) ? r.target.start : r.target.continue.split(":")[0]!);
  const ref = (r: TriggerRule) => (isStart(r.target) ? null : r.target.continue);
  const allowed = (f: string) => machine.folders.some((a) => f === a || f.startsWith(`${a}/`));
  const free = () => starts.running < concurrent && starts.last_hour < 10;
  const giveBack = (id: string) => {
    const i = counted.findIndex((x) => x.id === id);
    if (i >= 0) counted.splice(i, 1);
  };
  const active = (): TriggersFile | null =>
    file ? { ...file, rules: file.rules.filter((r) => !machinePaused.has(r.name)) } : null;

  for (const [si, s] of c.steps.entries()) {
    const where = `${c.name}, step ${si + 1}`;
    expect(STEP_KINDS.filter((k) => k in s).length, `${where}: one kind a step`).toBeLessThanOrEqual(1);
    for (const k of Object.keys(s.expect)) expect(EXPECT_KEYS.has(k), `${where}: expect.${k}`).toBe(true);
    const now = Date.parse(s.at ?? AT);
    const acks: Ack[] = [];
    const runs: Run[] = [];
    const history: History[] = [];
    const paused: string[] = [];
    let cancelled: number[] | undefined;
    let hello = false;
    const begin = (r: TriggerRule, n: ControlNotice | undefined, id?: string) => {
      const recorded = ref(r) ? sessions[ref(r)!]?.level : undefined;
      const offered = machine.levels?.[harnessOf(r)];
      const facts = { ...(recorded ? { recorded } : {}), ...(offered ? { offered } : {}) };
      runs.push({
        rule: r.name,
        run: triggerRun(r, machine.mode, n, facts),
        env: { SESSIONPIPE_TRIGGERED_BY: r.name },
      });
      if (isStart(r.target)) {
        starts.running++;
        starts.last_hour++;
      }
      triggeredRuns++;
      if (id) acks.push({ id, outcome: "ran", session: ref(r) ?? `${harnessOf(r)}:*` });
    };
    /** Steps 9 to 11 (CONTROL.md §14.7), at a run's first check and again when it is let go. */
    const recheck = (r: TriggerRule): string | null => {
      if (!allowed(r.folder)) return "folder";
      if (!machine.harnesses.includes(harnessOf(r))) return "harness";
      if (ref(r) && !sessions[ref(r)!]) {
        machinePaused.add(r.name);
        paused.push(r.name);
        return "no_session";
      }
      return null;
    };
    const letGo = (w: Waiting) => {
      waiting = waiting.filter((x) => x !== w);
      const why = recheck(w.rule);
      if (why) {
        giveBack(w.id);
        acks.push({ id: w.id, outcome: "refused", code: why });
      } else begin(w.rule, w.notice, w.id);
    };
    // Time passes first: a waiting run past its deadline is refused why it waited, its count given back.
    for (const w of [...waiting])
      if (now >= w.until) {
        waiting = waiting.filter((x) => x !== w);
        giveBack(w.id);
        acks.push({ id: w.id, outcome: "refused", code: w.why });
      }

    if (s.machine) Object.assign(machine, s.machine);
    if (s.change !== undefined) {
      const was = file?.on;
      file = rulesOf(s.change, machine.places);
      hello = true;
      if (was && !file?.on) {
        for (const w of waiting) {
          giveBack(w.id);
          acks.push({ id: w.id, outcome: "refused", code: "triggers_off" });
        }
        waiting = [];
        cancelled = Array.from({ length: triggeredRuns }, (_, i) => i);
      }
    }
    if (s.hello) {
      const t = helloTriggers(active(), s.hello);
      expect(s.expect.triggers, where).toEqual(t);
      const hi = { name: "studio-mac", harnesses: [], modes: [], keys: [], version: "1", triggers: t };
      expect(validate("control-hello", hi)).toEqual([]);
      expect(Object.keys(t).sort()).toEqual(["on", "topics"]);
    }
    if (s.release) {
      sessions[s.release]!.held = false;
      for (const w of waiting.filter((x) => x.why === "held" && ref(x.rule) === s.release)) letGo(w);
    }
    if (s.start_ended) {
      starts.running -= s.start_ended;
      for (const w of waiting.filter((x) => x.why === "start_limit")) if (free()) letGo(w);
    }
    if (s.permission !== undefined) expect(s.expect.answered_by_machine, where).toBe(false);
    if (s.poll) {
      const { notices, left } = noticesIn(s.poll.body);
      for (const raw of notices) {
        const id = noticeId(raw);
        if (id === null) continue; // nothing to ack
        if (!file?.on) {
          acks.push({ id, outcome: "refused", code: "triggers_off" });
          continue;
        }
        const r = parseNotice(raw, now);
        if (!r.ok) {
          acks.push(r.code === "expired" ? { id, outcome: "expired" } : { id, outcome: "refused", code: "bad_notice" });
          continue;
        }
        const key = `${s.poll.receiver}|${id}`;
        if (seen.has(key) && now - seen.get(key)! < 25 * H) {
          acks.push({ id, outcome: "duplicate" });
          continue;
        }
        seen.set(key, now);
        const n = r.notice;
        const rule = firstMatch(active()!, s.poll.receiver, n);
        if (!rule) {
          acks.push({ id, outcome: "no_match" });
          continue;
        }
        const today = counted.filter((x) => x.rule === rule.name && x.day === day(now));
        if (today.some((x) => x.subject === n.subject && x.state === n.state)) {
          acks.push({ id, outcome: "refused", code: "cooldown" });
          continue;
        }
        if (today.length >= rule.cap.per_day) {
          acks.push({ id, outcome: "refused", code: "cap" });
          continue;
        }
        const why = recheck(rule);
        if (why) {
          acks.push({ id, outcome: "refused", code: why });
          continue;
        }
        // It counts now, when it is taken or begins (CONTROL.md §14.7, *When a run counts*).
        counted.push({ rule: rule.name, subject: n.subject, state: n.state, day: day(now), id });
        const held = ref(rule) !== null && sessions[ref(rule)!]!.held;
        if (held || (isStart(rule.target) && !free())) {
          waiting.push({ id, rule, notice: n, why: held ? "held" : "start_limit", until: Date.parse(n.expires_at) });
          acks.push({ id, outcome: "taken" });
        } else begin(rule, n, id);
      }
      const past = (s.poll.body.notices ?? []).slice(50).map((n) => (n as { id: string }).id);
      expect(s.expect.unacked ?? [], where).toEqual(past);
      expect(left, where).toBe(past.length);
      expect(s.expect.message_acks ?? [], where).toEqual((s.poll.body.messages ?? []).map((m) => m.id));
    }
    // The clock, read in UTC: a tick now, or the latest one missed while the machine slept.
    const ticks: [TriggerRule, number][] = [];
    if (s.tick) ticks.push([file?.rules.find((r) => r.name === s.tick) ?? ({ name: s.tick } as TriggerRule), now]);
    if (s.wake)
      for (const r of file?.rules ?? []) {
        if (isNoticeSource(r.source)) continue;
        const t = latestTick(r.source.every, Date.parse(s.asleep!), now, lastTick.get(r.name));
        if (t !== null) ticks.push([r, t]);
      }
    for (const [r, t] of ticks) {
      if (!file?.on) history.push({ rule: r.name, result: "refused", code: "triggers_off" });
      else if (r.paused || machinePaused.has(r.name)) continue;
      else if (now - t >= 6 * H) history.push({ rule: r.name, result: "missed" });
      else if (counted.filter((x) => x.rule === r.name && x.day === day(now)).length >= r.cap.per_day)
        history.push({ rule: r.name, result: "refused", code: "cap" });
      else {
        counted.push({ rule: r.name, day: day(now) });
        begin(r, undefined);
        history.push({ rule: r.name, result: "ran" });
      }
    }

    expect(s.expect.acks ?? [], `${where}: acks`).toEqual(acks);
    expect(s.expect.runs ?? [], `${where}: runs`).toEqual(runs);
    expect(s.expect.history ?? [], `${where}: history`).toEqual(history);
    expect(s.expect.paused ?? [], `${where}: paused`).toEqual(paused);
    expect(s.expect.cancelled, `${where}: cancelled`).toEqual(cancelled);
    expect(s.expect.hello ?? false, `${where}: hello at once`).toBe(hello);
    for (const a of acks)
      expect(validate("control-notice-ack", { acks: [sent(a)] }), `${where}: ${JSON.stringify(a)}`).toEqual([]);
    for (const h of history.filter((x) => x.code)) {
      const ack = { id: "01KB4M2Q8V3T6Y9C0D1E2F3G4H", outcome: "refused", at: AT, code: h.code };
      expect(validate("control-notice-ack", { acks: [ack] })).toEqual([]);
    }
  }
}

describe("conformance/triggers: the scenario files", () => {
  it("are there, and name every scenario the spec lists", () => {
    expect(scenarios).toEqual([
      "clock-missed.json",
      "hello-topics-only.json",
      "notice-bad-shape.json",
      "notice-broken-id.json",
      "notice-cap.json",
      "notice-cooldown.json",
      "notice-duplicate.json",
      "notice-expired.json",
      "notice-extra-field.json",
      "notice-no-rule.json",
      "notice-other-receiver.json",
      "run-level-capped.json",
      "run-waits.json",
      "triggers-off.json",
    ]);
  });
  for (const f of scenarios) {
    const fx = read(f) as { spec: string; note: string; cases: Case[] };
    it(`${f}: ${fx.cases.length} cases, step by step`, () => {
      expect(fx.spec).toMatch(/^CONTROL\.md §14/);
      expect(fx.note.length).toBeGreaterThan(40);
      for (const c of fx.cases) runCase(c);
    });
  }
});

describe("conformance/triggers/subject-patterns.json", () => {
  const fx = read("subject-patterns.json") as {
    cases: { pattern: string; ok: boolean; matches?: string[]; misses?: string[] }[];
  };
  const SUBJECT = new RegExp(SCHEMAS["control-notice"].properties.subject.pattern);
  it(`${fx.cases.length} patterns: taken or refused, and what each matches, as a RegExp would`, () => {
    for (const c of fx.cases) {
      const p = subjectPattern(c.pattern);
      expect(!("error" in p), c.pattern).toBe(c.ok);
      if ("error" in p) continue;
      for (const s of c.matches ?? []) {
        expect(SUBJECT.test(s), s).toBe(true);
        expect(p.test(s) && new RegExp(c.pattern).test(s), `${c.pattern} on ${s}`).toBe(true);
      }
      for (const s of c.misses ?? []) expect(p.test(s), `${c.pattern} on ${s}`).toBe(false);
    }
  });
});

describe("conformance/triggers/rules-file.json", () => {
  const fx = read("rules-file.json") as {
    places: TriggerPlaces;
    cases: { name: string; file: unknown; ok: boolean }[];
  };
  it(`${fx.cases.length} files, each read whole or refused whole`, () => {
    for (const c of fx.cases) expect(checkTriggers(c.file, fx.places).ok, c.name).toBe(c.ok);
  });
});
