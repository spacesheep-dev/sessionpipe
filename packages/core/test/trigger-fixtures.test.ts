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
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
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
/** `SESSIONPIPE_WRITE_TRIGGER_HISTORY=1`: write each step's history as this model reads it into
 *  the files (as `npm run vectors` writes the control vectors), for a person to review in the diff. */
const WRITE = process.env.SESSIONPIPE_WRITE_TRIGGER_HISTORY === "1";
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
  /** A notice's run or refusal: its subject, and its state when it had one. */
  subject?: string;
  state?: string;
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
  run_ended?: number[];
  headless_ended?: number;
  resume?: string;
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
  sessions?: Record<string, { level: StartPermission; held: boolean; folder?: string }>;
  seen?: { receiver: string; id: string; at: string }[];
  today?: { rule: string; subject?: string; state?: string; at: string; result: string }[];
  starts?: { running: number; last_hour: number; headless?: number };
  limits?: { start_concurrent?: number; headless?: number };
  last_tick?: Record<string, string>;
  zone?: string;
  steps: Step[];
}
const STEP_KINDS = [
  "poll",
  "hello",
  "change",
  "machine",
  "resume",
  "tick",
  "wake",
  "release",
  "start_ended",
  "headless_ended",
  "run_ended",
  "permission",
];
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
  /** Runs counted against a rule's cap and cooldown; `key` names the one that may be given back. */
  const counted: {
    rule: string;
    subject?: string | undefined;
    state?: string | undefined;
    day: string;
    key?: string;
  }[] = (c.today ?? [])
    .filter((t) => t.result === "ran" || t.result === "failed")
    .map((t) => ({ rule: t.rule, subject: t.subject, state: t.state, day: day(Date.parse(t.at)) }));
  // The machine's caps on starts, as a local ask counts them: starts in progress, and starts in a
  // sliding hour (the case's `last_hour` made at its first step's instant).
  const firstAt = Date.parse(c.steps[0]?.at ?? AT);
  let running = c.starts?.running ?? 0;
  const startTimes: number[] = Array(c.starts?.last_hour ?? 0).fill(firstAt);
  const concurrent = c.limits?.start_concurrent ?? 2;
  // The headless slots: turns the daemon runs as its own child, a continued run's among them.
  let headless = c.starts?.headless ?? 0;
  const slots = c.limits?.headless ?? 3;
  const lastTick = new Map(Object.entries(c.last_tick ?? {}).map(([k, v]) => [k, Date.parse(v)]));
  const machinePaused = new Set<string>();
  type Waiting = {
    key: string;
    id?: string;
    rule: TriggerRule;
    notice?: ControlNotice;
    why: "held" | "start_limit" | "busy";
    until: number;
  };
  let waiting: Waiting[] = [];
  /** Triggered runs by index, in the case's order, and which are still running. */
  const triggered: TriggerRule[] = [];
  const stillRunning = new Set<number>();

  const harnessOf = (r: TriggerRule) => (isStart(r.target) ? r.target.start : r.target.continue.split(":")[0]!);
  const ref = (r: TriggerRule) => (isStart(r.target) ? null : r.target.continue);
  const allowed = (f: string) => machine.folders.some((a) => f === a || f.startsWith(`${a}/`));
  const free = (now: number) => running < concurrent && startTimes.filter((t) => now - t < H).length < 10;
  /** What a run waits for, or null when it may begin: its own rule's earlier run (one at a time,
   *  in the order they were taken), a window, the start caps or (continuing) a headless slot. */
  const blocker = (w: { key: string; rule: TriggerRule }, now: number): Waiting["why"] | null => {
    const ahead = waiting.findIndex((x) => x.rule.name === w.rule.name);
    if ([...stillRunning].some((i) => triggered[i]!.name === w.rule.name)) return "busy";
    if (ahead >= 0 && waiting[ahead]!.key !== w.key) return "busy";
    if (ref(w.rule) !== null && sessions[ref(w.rule)!]!.held) return "held";
    if (isStart(w.rule.target) ? !free(now) : headless >= slots) return "start_limit";
    return null;
  };
  const giveBack = (key: string) => {
    const i = counted.findIndex((x) => x.key === key);
    if (i >= 0) counted.splice(i, 1);
  };
  const active = (): TriggersFile | null =>
    file ? { ...file, rules: file.rules.filter((r) => !machinePaused.has(r.name)) } : null;
  const hellos = () => JSON.stringify(machine.receivers.map((r) => helloTriggers(active(), r)));
  const byId = (xs: Ack[]) => [...xs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  for (const [si, s] of c.steps.entries()) {
    const where = `${c.name}, step ${si + 1}`;
    expect(STEP_KINDS.filter((k) => k in s).length, `${where}: one kind a step`).toBeLessThanOrEqual(1);
    for (const k of Object.keys(s.expect)) expect(EXPECT_KEYS.has(k), `${where}: expect.${k}`).toBe(true);
    const now = Date.parse(s.at ?? AT);
    const before = hellos();
    const acks: Ack[] = [];
    const runs: Run[] = [];
    const history: History[] = [];
    const paused: string[] = [];
    let cancelled: number[] | undefined;
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
        running++;
        startTimes.push(now);
      } else headless++;
      stillRunning.add(triggered.push(r) - 1);
      if (id) acks.push({ id, outcome: "ran", session: ref(r) ?? `${harnessOf(r)}:*` });
      history.push({ rule: r.name, result: "ran", ...of(n) });
    };
    /** A notice's subject and state, as its rule's history keeps them. */
    const of = (n: ControlNotice | undefined) =>
      n ? { subject: n.subject, ...(n.state !== undefined ? { state: n.state } : {}) } : {};
    /** Every run and refusal of a rule that took the cause goes to its history (§14.10). */
    const refuse = (w: { id?: string; rule: TriggerRule; notice?: ControlNotice }, code: string) => {
      if (w.id) acks.push({ id: w.id, outcome: "refused", code });
      history.push({ rule: w.rule.name, result: "refused", code, ...of(w.notice) });
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
      // A continued session runs in its own folder (§14.1): it is the rule's and allowed, or no run.
      const there = ref(r) ? sessions[ref(r)!]!.folder : undefined;
      if (there !== undefined && (there !== r.folder || !allowed(there))) return "folder";
      return null;
    };
    /** A run that passed its checks: counted now, then begun, or waiting (taken) for a window or the caps. */
    const take = (w: Omit<Waiting, "why" | "until">, until: number) => {
      const n = w.notice;
      counted.push({ rule: w.rule.name, subject: n?.subject, state: n?.state, day: day(now), key: w.key });
      const why = blocker(w, now);
      if (why) {
        waiting.push({ ...w, why, until });
        if (w.id) acks.push({ id: w.id, outcome: "taken" });
      } else begin(w.rule, n, w.id);
    };
    /** Every waiting run that may begin now, in the order they were taken. */
    const drain = () => {
      for (const w of [...waiting]) {
        const why = blocker(w, now);
        if (why) w.why = why;
        else letGo(w);
      }
    };
    const letGo = (w: Waiting) => {
      waiting = waiting.filter((x) => x !== w);
      const why = recheck(w.rule);
      if (why) {
        giveBack(w.key);
        refuse(w, why);
      } else begin(w.rule, w.notice, w.id);
    };
    // Time passes first. A deadline is exclusive: at its own instant a waiting run has expired,
    // before anything else at that instant, refused for what it waited for; its count is given back.
    for (const w of [...waiting])
      if (now >= w.until) {
        const why = blocker(w, now) ?? w.why;
        waiting = waiting.filter((x) => x !== w);
        giveBack(w.key);
        refuse(w, why);
      }
    // The sliding hour may have room again.
    drain();

    if (s.machine) Object.assign(machine, s.machine);
    if (s.resume) machinePaused.delete(s.resume);
    if (s.change !== undefined) {
      const was = file?.on;
      const old = file;
      file = rulesOf(s.change, machine.places);
      // The machine's own pause ends with the rule, or when its target changes.
      for (const name of [...machinePaused]) {
        const a = old?.rules.find((r) => r.name === name);
        const b = file?.rules.find((r) => r.name === name);
        if (!b || JSON.stringify(a?.target) !== JSON.stringify(b.target)) machinePaused.delete(name);
      }
      if (was && !file?.on) {
        for (const w of waiting) {
          giveBack(w.key);
          refuse(w, "triggers_off");
        }
        waiting = [];
        // Only the triggered turns still running are cancelled.
        cancelled = [...stillRunning].sort((a, b) => a - b);
        stillRunning.clear();
      }
    }
    for (const i of s.run_ended ?? []) {
      expect(stillRunning.has(i), `${where}: run ${i} is running`).toBe(true);
      stillRunning.delete(i);
      if (isStart(triggered[i]!.target)) running--;
      else headless--;
    }
    if (s.headless_ended) headless -= s.headless_ended;
    if (s.hello) {
      expect(machine.receivers, `${where}: a hello goes to a receiver the machine is paired with`).toContain(s.hello);
      const t = helloTriggers(active(), s.hello);
      expect(s.expect.triggers, where).toEqual(t);
      const hi = { name: "studio-mac", harnesses: [], modes: [], keys: [], version: "1", triggers: t };
      expect(validate("control-hello", hi)).toEqual([]);
      expect(Object.keys(t).sort()).toEqual(["on", "topics"]);
    }
    if (s.release) sessions[s.release]!.held = false;
    if (s.start_ended) running -= s.start_ended;
    drain();
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
        // One (rule, subject, state) a day: two notices with no state are the same state.
        const today = counted.filter((x) => x.rule === rule.name && x.day === day(now));
        if (today.some((x) => x.subject === n.subject && x.state === n.state)) {
          refuse({ id, rule, notice: n }, "cooldown");
          continue;
        }
        if (today.length >= rule.cap.per_day) {
          refuse({ id, rule, notice: n }, "cap");
          continue;
        }
        const why = recheck(rule);
        if (why) refuse({ id, rule, notice: n }, why);
        else take({ key, id, rule, notice: n }, Date.parse(n.expires_at));
      }
      const past = (s.poll.body.notices ?? []).slice(50).map((n) => (n as { id: string }).id);
      expect(s.expect.unacked ?? [], where).toEqual(past);
      expect(left, where).toBe(past.length);
      expect(s.expect.message_acks ?? [], where).toEqual((s.poll.body.messages ?? []).map((m) => m.id));
    }
    // The clock, read in UTC: a tick now, or the latest one missed while the machine slept. A tick
    // takes steps 2 and 8 to 11 (CONTROL.md §14.7): paused first (nothing, on or off), then off,
    // then late (missed, never counted), the cap, the re-check, and the start caps, where it waits.
    const ticks: [TriggerRule, number][] = [];
    if (s.tick) ticks.push([file?.rules.find((r) => r.name === s.tick) ?? ({ name: s.tick } as TriggerRule), now]);
    if (s.wake)
      for (const r of file?.rules ?? []) {
        if (isNoticeSource(r.source)) continue;
        const t = latestTick(r.source.every, Date.parse(s.asleep!), now, lastTick.get(r.name));
        if (t !== null) ticks.push([r, t]);
      }
    for (const [r, t] of ticks) {
      if (r.paused || machinePaused.has(r.name)) continue;
      if (!file?.on) history.push({ rule: r.name, result: "refused", code: "triggers_off" });
      else if (now - t >= 6 * H) history.push({ rule: r.name, result: "missed" });
      else if (counted.filter((x) => x.rule === r.name && x.day === day(now)).length >= r.cap.per_day)
        history.push({ rule: r.name, result: "refused", code: "cap" });
      else {
        const why = recheck(r);
        if (why) history.push({ rule: r.name, result: "refused", code: why });
        else take({ key: `tick|${r.name}|${t}`, rule: r }, t + 6 * H);
      }
    }

    expect(byId(s.expect.acks ?? []), `${where}: acks`).toEqual(byId(acks));
    expect(s.expect.runs ?? [], `${where}: runs`).toEqual(runs);
    if (WRITE) {
      if (history.length) s.expect.history = history;
      else delete s.expect.history;
    } else expect(s.expect.history ?? [], `${where}: history`).toEqual(history);
    expect(s.expect.paused ?? [], `${where}: paused`).toEqual(paused);
    expect(s.expect.cancelled, `${where}: cancelled`).toEqual(cancelled);
    // A hello goes at once when what some receiver's `triggers` says changes, and not otherwise.
    expect(s.expect.hello ?? false, `${where}: hello at once`).toBe(hellos() !== before);
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
      "run-session-folder.json",
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
      if (WRITE) writeFileSync(path.join(dir, f), `${JSON.stringify(fx, null, 2)}\n`);
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
    cases: { name: string; file: unknown; ok: boolean; places?: TriggerPlaces }[];
  };
  it(`${fx.cases.length} files, each read whole or refused whole`, () => {
    for (const c of fx.cases) expect(checkTriggers(c.file, c.places ?? fx.places).ok, c.name).toBe(c.ok);
  });
});
