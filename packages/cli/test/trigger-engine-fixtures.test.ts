// SPDX-License-Identifier: Apache-2.0
// conformance/triggers/*.json (CONTROL.md §14) run against the engine (control/triggers.ts): every
// expectation of every step, an absent list meaning none, as core's model checks them. core's
// trigger-fixtures test holds the definition's functions and a small model of §14.7; this one
// drives the same files through the machine's own engine: the day's counts, the cooldown, the
// folder, the harness and the levels it takes, the session a rule continues, the caps on starts,
// a window that holds a session, the clock, waking, turning off, the machine's own pause.
//
// Steps 1 to 6 of §14.7 are not the engine's: the notices step reads the id, the switch, the
// shape, the expiry, the dedup and the match, then calls `fire`. Here they are done by the test,
// as that step will do them, with core's functions and the engine's own `firstMatch`; the poll's
// messages are the command path's. So notice-duplicate, notice-broken-id and notice-bad-shape run
// here too, and what they check beyond the engine waits for the notices on the wire.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkTriggers,
  type MachineMode,
  type NoticeResult,
  noticeId,
  noticesIn,
  parseNotice,
  type StartPermission,
  type TriggerHistoryLine,
  type TriggerPlaces,
  type TriggersFile,
} from "@sessionpipe/core";
import { describe, expect, it } from "vitest";
import { localDay, zoneOf } from "../src/control/clock.js";
import { type RunEvents, TriggerEngine, type TriggerJob, type TriggerState } from "../src/control/triggers.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dir = path.join(root, "conformance/triggers");
const PURE = new Set(["subject-patterns.json", "rules-file.json"]);
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".json") && !PURE.has(f))
  .sort();
const H = 3600_000;

interface Ack {
  id: string;
  outcome: string;
  code?: string;
  session?: string;
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
  at: string;
  poll?: { receiver: string; body: { notices?: unknown[]; messages?: { id: string }[] } };
  hello?: string;
  change?: unknown;
  machine?: Partial<Machine>;
  tick?: string;
  wake?: boolean;
  asleep?: string;
  release?: string;
  start_ended?: number;
  headless_ended?: number;
  run_ended?: number[];
  resume?: string;
  permission?: { run: number };
  expect: {
    acks?: Ack[];
    runs?: TriggerJob[];
    triggers?: unknown;
    hello?: boolean;
    history?: { rule: string; result: string; code?: string }[];
    paused?: string[];
    cancelled?: number[];
    unacked?: string[];
    message_acks?: string[];
    answered_by_machine?: boolean;
  };
}
interface Case {
  name: string;
  machine: Machine;
  triggers: unknown;
  sessions?: Record<string, { level: StartPermission; held: boolean; folder?: string }>;
  seen?: { receiver: string; id: string; at: string }[];
  today?: { rule: string; subject: string; state?: string; at: string; result: string }[];
  starts?: { running: number; last_hour: number; headless?: number };
  limits?: { start_concurrent?: number; start_per_hour?: number; headless?: number };
  last_tick?: Record<string, string>;
  zone?: string;
  steps: Step[];
}

const fileOf = (v: unknown, places: TriggerPlaces): TriggersFile | null => {
  if (v === null) return null;
  const r = checkTriggers(v, places);
  return r.ok ? r.file : null;
};

/** The record a machine had before the case: its rules' runs earlier that day, and their
 *  clocks' last ticks. */
function seeded(c: Case, file: TriggersFile | null): TriggerState {
  const z = zoneOf(c.zone ?? "UTC");
  const s: TriggerState = { v: 1, rules: {}, waiting: [] };
  for (const t of c.today ?? []) {
    s.rules[t.rule] ??= { history: [] };
    const st = s.rules[t.rule] as NonNullable<(typeof s.rules)[string]>;
    if (t.result === "ran" || t.result === "failed") {
      const day = localDay(z, Date.parse(t.at));
      st.today ??= { day, runs: 0, keys: [] };
      st.today.runs++;
      st.today.keys.push(`${t.subject}/${t.state ?? ""}`);
    }
    st.history.unshift({
      at: t.at,
      result: t.result as "ran",
      subject: t.subject,
      ...(t.state ? { state: t.state } : {}),
    });
  }
  // An interval clock with no last tick: its time comes at the case's first tick of it, so it
  // counts from one interval before that.
  for (const r of file?.rules ?? []) {
    const every = (r.source as { every?: string }).every;
    const first = c.steps.find((x) => x.tick === r.name);
    const m = every && /^(\d+)([mh])$/.exec(every);
    if (!m || !first || c.last_tick?.[r.name]) continue;
    const since = Date.parse(first.at) - Number(m[1]) * (m[2] === "h" ? H : 60_000);
    s.rules[r.name] ??= { history: [] };
    (s.rules[r.name] as NonNullable<(typeof s.rules)[string]>).clock = { every, since };
  }
  for (const [name, at] of Object.entries(c.last_tick ?? {})) {
    const rule = file?.rules.find((r) => r.name === name) as { source: { every: string } };
    const last = Date.parse(at);
    s.rules[name] ??= { history: [] };
    (s.rules[name] as NonNullable<(typeof s.rules)[string]>).clock = { every: rule.source.every, since: last, last };
  }
  return s;
}

/** One case, through a machine of its own. */
function play(c: Case): void {
  const machine: Machine = structuredClone(c.machine);
  let file = fileOf(c.triggers, machine.places);
  // A minute before the first step: what the case starts from was already so.
  let now = Date.parse(c.steps[0]!.asleep ?? c.steps[0]!.at) - 60_000;
  const sessions = structuredClone(c.sessions ?? {});
  const seen = new Map((c.seen ?? []).map((x) => [`${x.receiver}|${x.id}`, Date.parse(x.at)]));
  // The machine's caps on starts, as the daemon counts them (startSession): starts in progress,
  // and starts in a sliding hour, the case's `last_hour` made at its first step's instant.
  let running = c.starts?.running ?? 0;
  const startTimes: number[] = Array(c.starts?.last_hour ?? 0).fill(Date.parse(c.steps[0]!.at));
  const lim = { concurrent: c.limits?.start_concurrent ?? 2, hour: c.limits?.start_per_hour ?? 10 };
  /** Triggered runs by index, and which are still running (only those are cancelled). */
  const live = new Set<number>();
  const events: RunEvents[] = [];
  // The headless slots, as the daemon's `slot` gives them: a continued run's turn takes one, and
  // until it has it the run is handed over and waits (queued).
  let headless = c.starts?.headless ?? 0;
  const slots = c.limits?.headless ?? 3;
  const queue: { job: TriggerJob; on: RunEvents; gone: boolean }[] = [];
  const begin = (job: TriggerJob, on: RunEvents) => {
    const i = runs.push(job) - 1;
    const target = job.run.target as { start?: string; continue?: string };
    if (target.start) {
      running++;
      startTimes.push(now);
    } else headless++;
    live.add(i);
    events[i] = on;
    on.began(target.continue ?? `${target.start}:*`);
    return i;
  };
  const grant = () => {
    for (const q of queue.splice(0))
      if (q.gone) continue;
      else if (headless < slots) begin(q.job, q.on);
      else queue.push(q);
  };
  const acks: Ack[] = [];
  const runs: TriggerJob[] = [];
  let cancelled: number[] = [];
  let changed = 0;
  const noted: { rule: string; l: TriggerHistoryLine }[] = [];
  let saved: TriggerState = seeded(c, file);
  const e = new TriggerEngine({
    now: () => now,
    zone: c.zone ?? "UTC",
    mode: () => machine.mode,
    allowed: (f) => machine.folders.some((m) => f === m || f.startsWith(`${m}/`)),
    harnesses: () => machine.harnesses,
    offered: (h) => machine.levels?.[h],
    session: (ref) => {
      const x = sessions[ref];
      if (!x) return { gone: true };
      return { held: x.held, level: x.level, ...(x.folder !== undefined ? { folder: x.folder } : {}) };
    },
    startRoom: () => running < lim.concurrent && startTimes.filter((t) => now - t < H).length < lim.hour,
    run: (job, on) => {
      if ("continue" in job.run.target && headless >= slots) {
        const q = { job, on, gone: false };
        queue.push(q);
        on.queued("start_limit");
        return {
          cancel: () => {
            q.gone = true;
          },
        };
      }
      const i = begin(job, on);
      return {
        cancel: () => {
          if (live.delete(i)) cancelled.push(i);
        },
      };
    },
    ack: (_receiver, id, r: NoticeResult) => acks.push({ id, ...r }),
    load: () => saved,
    save: (s) => {
      saved = structuredClone(s);
    },
    log: () => {},
    changed: () => changed++,
    noted: (rule, l) => noted.push({ rule, l }),
  });
  e.load(file);
  e.check();
  for (const [si, s] of c.steps.entries()) {
    const where = `${c.name}, step ${si + 1}`;
    if (s.asleep) {
      now = Date.parse(s.asleep);
      e.check();
    }
    noted.length = 0;
    const before = { acks: acks.length, runs: runs.length, changed, paused: e.pausedByMachine() };
    cancelled = [];
    now = Date.parse(s.at);
    // Within a step, a waiting run past its deadline ends first, then every waiting run that may
    // begin does, in the order taken.
    e.retry();
    if (s.machine) Object.assign(machine, s.machine);
    if (s.change !== undefined) {
      file = fileOf(s.change, machine.places);
      e.load(file);
    }
    if (s.hello) {
      expect(machine.receivers, `${where}: a hello goes to a receiver the machine is paired with`).toContain(s.hello);
      expect(e.helloFor(s.hello), where).toEqual(s.expect.triggers);
    }
    if (s.release) {
      (sessions[s.release] as { held: boolean }).held = false;
      e.retry();
    }
    if (s.start_ended !== undefined) {
      running -= s.start_ended;
      e.retry();
    }
    for (const i of s.run_ended ?? []) {
      expect(live.delete(i), `${where}: run ${i} was running`).toBe(true);
      if ("start" in (runs[i] as TriggerJob).run.target) running--;
      else headless--;
      (events[i] as RunEvents).ended(1000);
    }
    if (s.resume) e.lift(s.resume);
    if (s.headless_ended) {
      headless -= s.headless_ended;
      grant();
    }
    grant();
    e.retry();
    if (s.permission) {
      // What the scenario says; it is proven where a prompt can be answered at all: the daemon's
      // test, whose stand-in raises one during a triggered turn and gets no allow
      // (control-triggers.test.ts, "nothing answers a permission prompt").
      expect(s.expect.answered_by_machine, where).toBe(false);
    }
    if (s.poll) {
      const { notices, left } = noticesIn(s.poll.body);
      for (const raw of notices) {
        const id = noticeId(raw);
        if (id === null) continue;
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
        if (seen.has(key) && now - (seen.get(key) as number) < 25 * H) {
          acks.push({ id, outcome: "duplicate" });
          continue;
        }
        seen.set(key, now);
        const rule = e.firstMatch(s.poll.receiver, r.notice);
        if (!rule) acks.push({ id, outcome: "no_match" });
        else e.fire(rule.name, { kind: "notice", receiver: s.poll.receiver, notice: r.notice });
      }
      const past = (s.poll.body.notices ?? []).slice(50).map((n) => (n as { id: string }).id);
      expect(s.expect.unacked ?? [], where).toEqual(past);
      expect(left, where).toBe(past.length);
      expect(s.expect.message_acks ?? [], where).toEqual((s.poll.body.messages ?? []).map((m) => m.id));
    }
    // A tick, a wake, or time passing: the clock comes round.
    if (s.tick !== undefined || s.wake || Object.keys(s).every((k) => k === "at" || k === "expect")) e.check();
    const x = s.expect;
    // Acks within one POST have no order: compared by id.
    const byId = (l: Ack[]) => [...l].sort((a, b) => a.id.localeCompare(b.id));
    expect(byId(acks.slice(before.acks)), `${where}: acks`).toEqual(byId(x.acks ?? []));
    expect(runs.slice(before.runs), `${where}: runs`).toEqual(x.runs ?? []);
    // Every line the step wrote, a notice's with its subject and state: in the order written
    // within one rule, the rules side by side as the files list them.
    const sorted = (xs: object[]) => xs.map((x) => JSON.stringify(x)).sort();
    expect(
      sorted(
        noted.splice(0).map(({ rule, l }) => ({
          rule,
          result: l.result,
          ...(l.code ? { code: l.code } : {}),
          ...(l.subject ? { subject: l.subject } : {}),
          ...(l.state ? { state: l.state } : {}),
        })),
      ),
      `${where}: history`,
    ).toEqual(sorted(x.history ?? []));
    expect(
      e.pausedByMachine().filter((n) => !before.paused.includes(n)),
      `${where}: paused`,
    ).toEqual(x.paused ?? []);
    expect(cancelled, `${where}: cancelled`).toEqual(x.cancelled ?? []);
    expect(changed > before.changed, `${where}: a hello at once`).toBe(x.hello ?? false);
  }
}

describe("conformance/triggers, through the engine", () => {
  it("every scenario file", () => {
    expect(files).toHaveLength(15);
  });
  for (const f of files) {
    const fx = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as { cases: Case[] };
    for (const c of fx.cases) it(`${f}: ${c.name}`, () => play(c));
  }
});
