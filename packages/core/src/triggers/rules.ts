// SPDX-License-Identifier: Apache-2.0
// The person's trigger rules (spec/CONTROL.md §14): reading `<config>/triggers.json` against
// the generated definition (config.proto), saying a rule in plain words, the topics a hello
// lists, matching a notice, and the level a run gets. Pure functions: nothing here reads a
// file, runs a harness or keeps a count. "A receiver decides whether to send. Only the machine
// decides whether to run" (CONTROL.md §1): every function here is the machine's side of that.

import type {
  ClockSource,
  ContinueTarget,
  NoticeSource,
  StartTarget,
  TriggerMiss,
  TriggerRule,
  TriggerRun,
  TriggersFile,
  TriggerTestAnswer,
} from "../../gen/config.js";
import { CONFIG_SCHEMAS } from "../../gen/config-schemas.js";
import type {
  ControlHelloTriggers,
  ControlNotice,
  MachineMode,
  TriggerRefusal as Refusal,
  StartPermission,
} from "../../gen/v1.js";
import { HOME_RELATIVE_RE, levelRank, narrower, parseSessionRef } from "../control/verify.js";
import { problems } from "../schema/validate.js";
import { subjectPattern } from "./pattern.js";
import { composeWords, placeholdersIn } from "./words.js";

/** A notice rule runs at most at this level: the receiver holds other people's text, and a rule
 *  a stranger's edit can set off must not run in the harness's auto mode (CONTROL.md §14). */
export const NOTICE_LEVEL_MAX: StartPermission = "edits";
/** An interval clock runs at most this often, and at least this rarely, in minutes. */
export const EVERY_MIN_MINUTES = 15;
export const EVERY_MAX_MINUTES = 7 * 24 * 60;
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const DAY_NAMES: Record<string, string> = {
  sun: "Sunday",
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
};

export const isNoticeSource = (s: TriggerRule["source"]): s is NoticeSource => "receiver" in s;
export const isStart = (t: TriggerRule["target"]): t is StartTarget => "start" in t;

/** A clock, read: once a week on `day` (0 Sunday to 6 Saturday), every day, or every `minutes`;
 *  `at` is minutes after local midnight. */
export type Every =
  | { kind: "week"; day: number; at: number }
  | { kind: "day"; at: number }
  | { kind: "interval"; minutes: number };

/** A clock's `every`, read, or why it is refused (CONTROL.md §14, *The clock*). */
export function parseEvery(every: string): Every | { error: string } {
  const timed = /^(mon|tue|wed|thu|fri|sat|sun|day) ([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(every);
  if (timed) {
    const at = Number(timed[2]) * 60 + Number(timed[3]);
    return timed[1] === "day"
      ? { kind: "day", at }
      : { kind: "week", day: DAYS.indexOf(timed[1] as (typeof DAYS)[number]), at };
  }
  const span = /^([1-9][0-9]{0,4})([mh])$/.exec(every);
  if (!span) return { error: "a clock is `mon 09:00`, `day 08:30`, or an interval such as `30m` or `2h`" };
  const minutes = Number(span[1]) * (span[2] === "h" ? 60 : 1);
  if (minutes < EVERY_MIN_MINUTES || minutes > EVERY_MAX_MINUTES)
    return { error: `an interval is ${EVERY_MIN_MINUTES} minutes to 7 days` };
  return { kind: "interval", minutes };
}

/** Why one rule breaks what its schema can't say, or null. */
function ruleProblem(r: TriggerRule): string | null {
  const notice = isNoticeSource(r.source);
  if (!(r.folder.startsWith("/") || /^[A-Za-z]:[\\/]/.test(r.folder) || HOME_RELATIVE_RE.test(r.folder)))
    return "the folder is absolute, or under ~";
  if (!isStart(r.target) && !parseSessionRef((r.target as ContinueTarget).continue))
    return "the session to continue is <harness>:<id>, the id by its harness's rule";
  const names = placeholdersIn(r.words);
  if (!Array.isArray(names)) return names.error;
  if (notice) {
    if (levelRank(r.level) > levelRank(NOTICE_LEVEL_MAX))
      return `a rule a notice runs is at ${NOTICE_LEVEL_MAX} at most: the receiver holds other people's text`;
    if (r.subject !== undefined) {
      const p = subjectPattern(r.subject);
      if ("error" in p) return `the subject pattern: ${p.error}`;
    }
    return null;
  }
  const clock = parseEvery((r.source as ClockSource).every);
  if ("error" in clock) return clock.error;
  if (r.when !== undefined || r.subject !== undefined) return "a clock rule has no notice to filter";
  if (names.length) return "a clock rule's words have no notice to fill {subject}, {state}, {for} or {by} from";
  return null;
}

/** A rules file, checked: the typed file, or every problem with it. A file that doesn't fit
 *  is refused whole, never read in part or guessed at (CONTROL.md §14). */
export function checkTriggers(value: unknown): { ok: true; file: TriggersFile } | { ok: false; problems: string[] } {
  const shape = problems(CONFIG_SCHEMAS.triggers, value);
  if (shape.length) return { ok: false, problems: shape };
  const file = value as TriggersFile;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const [i, r] of file.rules.entries()) {
    if (seen.has(r.name)) out.push(`$.rules[${i}]: a second rule named ${r.name}`);
    seen.add(r.name);
    const why = ruleProblem(r);
    if (why) out.push(`$.rules[${i}] (${r.name}): ${why}`);
  }
  return out.length ? { ok: false, problems: out } : { ok: true, file };
}

/** The rules file's text, read and checked. */
export function readTriggers(text: string): ReturnType<typeof checkTriggers> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, problems: ["$: not JSON"] };
  }
  return checkTriggers(value);
}

/** What a hello to `receiver` says of the machine's triggers (CONTROL.md §14): whether they are
 *  on, and the topics of the rules (not paused) whose source is that receiver, once each, in
 *  the file's order. Never a filter, words, target or level. */
export function helloTriggers(file: TriggersFile | null, receiver: string): ControlHelloTriggers {
  if (!file?.on) return { on: false, topics: [] };
  const topics = new Set<string>();
  for (const r of file.rules)
    if (!r.paused && isNoticeSource(r.source) && r.source.receiver === receiver) topics.add(r.source.topic);
  return { on: true, topics: [...topics] };
}

/** Whether a rule takes a notice that came from `receiver`: its source, its filters, its subject
 *  pattern, and a field for every placeholder its words name. Paused or not is the caller's. */
export function matchNotice(
  rule: TriggerRule,
  receiver: string,
  n: ControlNotice,
): { ok: true } | { ok: false; miss: TriggerMiss } {
  const miss = (m: TriggerMiss) => ({ ok: false as const, miss: m });
  const s = rule.source;
  // "Your server or none": a notice counts only from the rule's own receiver.
  if (!isNoticeSource(s) || s.receiver !== receiver) return miss("receiver");
  if (s.topic !== n.topic) return miss("topic");
  if (s.event !== undefined && s.event !== n.event) return miss("event");
  const listed = (allowed: string[] | undefined, v: string | undefined) =>
    !allowed || (v !== undefined && allowed.includes(v));
  if (!listed(rule.when?.state, n.state)) return miss("state");
  if (!listed(rule.when?.for, n.for)) return miss("for");
  if (!listed(rule.when?.by, n.by)) return miss("by");
  if (rule.subject !== undefined) {
    const p = subjectPattern(rule.subject);
    if ("error" in p || !p.test(n.subject)) return miss("subject");
  }
  const names = placeholdersIn(rule.words);
  if (!Array.isArray(names) || names.some((f) => n[f] === undefined)) return miss("placeholder");
  return { ok: true };
}

/** The rule that takes a notice: the first in the file's order, not paused, that matches; null
 *  when none does, and then nothing runs ("a notice that no rule matches runs nothing"). One
 *  notice runs at most one rule. Whether triggers are on is the caller's first check. */
export function firstMatch(file: TriggersFile, receiver: string, n: ControlNotice): TriggerRule | null {
  return file.rules.find((r) => !r.paused && matchNotice(r, receiver, n).ok) ?? null;
}

/** The widest level the machine's mode lets a named level run at: `inherit` lets a named level
 *  be `safe` at most, as it does a start's (CONTROL.md §2). */
const MODE_CEILING: Record<MachineMode, StartPermission> = { safe: "safe", auto: "auto", inherit: "safe" };

/** The level a run of `rule` gets: the narrower of its own, the machine's mode and, continuing a
 *  session, that session's recorded level (`inherit` recorded caps nothing more). Never wider
 *  than any of them: "nothing is ever auto-allowed". */
export function triggerLevel(
  rule: Pick<TriggerRule, "level">,
  mode: MachineMode,
  recorded?: StartPermission | "inherit",
): StartPermission {
  const capped = narrower(rule.level, MODE_CEILING[mode]);
  return recorded && recorded !== "inherit" ? narrower(capped, recorded) : capped;
}

const quote = (s: string) => `“${s}”`;
const listOf = (xs: string[]) => (xs.length === 1 ? xs[0]! : `${xs.slice(0, -1).join(", ")} or ${xs[xs.length - 1]}`);
const hhmm = (at: number) => `${String(Math.floor(at / 60)).padStart(2, "0")}:${String(at % 60).padStart(2, "0")}`;

/** When a clock runs, in words. */
function clockWords(every: Every): string {
  if (every.kind === "interval")
    return every.minutes % 60 === 0
      ? `every ${every.minutes / 60 === 1 ? "hour" : `${every.minutes / 60} hours`}`
      : `every ${every.minutes} minutes`;
  const at = `at ${hhmm(every.at)} this computer's time`;
  return every.kind === "day" ? `every day ${at}` : `every ${DAY_NAMES[DAYS[every.day]!]} ${at}`;
}

/** The rule in plain words: the sentence `trigger add` shows before it asks for `yes`, from the
 *  rule as it will be written, so what the person confirms is what runs. */
export function describeRule(r: TriggerRule): string {
  const s = r.source;
  let when: string;
  if (isNoticeSource(s)) {
    const filters: string[] = [];
    if (r.when?.state) filters.push(`its state is ${listOf(r.when.state)}`);
    if (r.when?.for) filters.push(`it is for ${listOf(r.when.for)}`);
    if (r.when?.by) filters.push(`${listOf(r.when.by)} made the change`);
    if (r.subject !== undefined) filters.push(`its subject matches ${r.subject}`);
    when =
      `When ${s.receiver} sends a notice on ${s.topic}` +
      (s.event ? ` for ${s.event}` : "") +
      (filters.length ? ` where ${filters.join(", and ")}` : "");
  } else {
    const every = parseEvery(s.every);
    const w = "error" in every ? `on the clock ${s.every}` : clockWords(every);
    when = w[0]!.toUpperCase() + w.slice(1);
  }
  const what = isStart(r.target)
    ? `start ${r.target.start} in ${r.folder}`
    : `continue ${(r.target as ContinueTarget).continue} (in ${r.folder})`;
  const tools = r.tools?.length ? `, with ${r.tools.join(", ")} allowed without asking` : "";
  const cap = r.cap.per_day === 1 ? "once a day at most" : `at most ${r.cap.per_day} times a day`;
  return (
    `${r.name}: ${when}, ${what} at ${r.level} or narrower${tools}, ${cap}, with these words: ${quote(r.words)}` +
    (r.paused ? " (paused)" : "")
  );
}

/** The words a matching notice (or a clock tick) gives the session, framed (words.ts). */
export function ruleWords(r: TriggerRule, n?: ControlNotice): string | null {
  const s = r.source;
  return composeWords(
    r.words,
    { rule: r.name, start: isStart(r.target), ...(isNoticeSource(s) ? { receiver: s.receiver } : {}) },
    n,
  );
}

/** What a run of `rule` is on this machine: the target, folder, narrowed level, tools and framed
 *  words the daemon starts it with; null when the words can't be filled from `n`. */
export function triggerRun(
  rule: TriggerRule,
  mode: MachineMode,
  n?: ControlNotice,
  recorded?: StartPermission | "inherit",
): TriggerRun | null {
  const words = ruleWords(rule, n);
  if (words === null) return null;
  return {
    target: rule.target,
    folder: rule.folder,
    level: triggerLevel(rule, mode, recorded),
    tools: rule.tools ?? [],
    words,
  };
}

/** A notice as `trigger test` makes one for a notice rule: the rule's topic and event (`sample`
 *  when it names none) with the person's subject and fields; null for a clock rule. Read it with
 *  parseNotice before testing, as the daemon would. */
export function sampleNotice(
  rule: TriggerRule,
  fields: Pick<ControlNotice, "subject" | "state" | "for" | "by">,
  o: { id: string; now: number },
): ControlNotice | null {
  const s = rule.source;
  if (!isNoticeSource(s)) return null;
  const at = new Date(o.now).toISOString();
  const expires_at = new Date(o.now + 3600_000).toISOString();
  return { id: o.id, topic: s.topic, event: s.event ?? "sample", ...fields, at, expires_at };
}

/** `sessionpipe trigger test`'s answer: whether a sample notice (none for a clock rule) fits the
 *  rule, which part it misses, and what would run. A notice rule tested with no notice fits
 *  nothing (`receiver`). `refusal` is a check of the machine's state the caller made (triggers
 *  off, the cap, the folder). It runs nothing and records nothing. */
export function testAnswer(
  rule: TriggerRule,
  o: { mode: MachineMode; receiver?: string; notice?: ControlNotice; refusal?: Refusal },
): TriggerTestAnswer {
  const n = o.notice;
  const m = n ? matchNotice(rule, o.receiver ?? "", n) : isNoticeSource(rule.source) ? null : { ok: true as const };
  const base = { rule: rule.name, ...(n ? { notice: n } : {}), ...(o.refusal ? { refusal: o.refusal } : {}) };
  if (!m) return { ...base, matches: false, miss: "receiver" };
  if (!m.ok) return { ...base, matches: false, miss: m.miss };
  return { ...base, matches: true, run: triggerRun(rule, o.mode, n)! };
}
