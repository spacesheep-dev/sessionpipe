// SPDX-License-Identifier: Apache-2.0
// The person's trigger rules (spec/CONTROL.md §14): reading `<config>/triggers.json` against
// the generated definition (config.proto), saying a rule in plain words, the topics a hello
// lists, matching a notice, and the level a run gets. Pure functions: nothing here reads a
// file, runs a harness or keeps a count (the places a folder may not be are passed in). "A receiver decides whether to send. Only the machine
// decides whether to run" (CONTROL.md §1): every function here is the machine's side of that.
import path from "node:path";
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
import { HOME_RELATIVE_RE, levelRank, narrower, parseSessionRef, START_PERMISSIONS } from "../control/verify.js";
import { problems } from "../schema/validate.js";
import { subjectPattern } from "./pattern.js";
import { hiddenIn, hiddenProblem, visible } from "./text.js";
import { composeWords, placeholdersIn } from "./words.js";

/** What a rule's folder is checked against (CONTROL.md §14.1, *The folder's floor*): the places a
 *  run there could widen later runs from. Absolute paths; places.ts reads them for this machine. */
export interface TriggerPlaces {
  /** The home folder of the user the daemon runs as. */
  home: string;
  /** sessionpipe's config folder (where config.json and triggers.json are). */
  config: string;
  /** sessionpipe's state folder. */
  state: string;
  /** Each harness's own folders (`~/.claude` or `CLAUDE_CONFIG_DIR`, `~/.codex` or `CODEX_HOME`,
   *  …): where its settings, allow rules and hooks are, which every later session reads. */
  harnesses: string[];
  /** The platform whose paths these are: `win32` paths are read as Windows paths, and on `darwin`
   *  and `win32` folders are compared without regard to case, as their file systems usually do. */
  platform: NodeJS.Platform;
}

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

const RULE = CONFIG_SCHEMAS.triggers.properties.rules.items;
const EVERY_RE = new RegExp(RULE.properties.source.oneOf[1].properties.every.pattern);

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
  // The shape is the definition's (config.proto ClockSource.every); past it, the parts are fixed.
  if (!EVERY_RE.test(every))
    return { error: "a clock is `mon 09:00`, `day 08:30`, or an interval such as `30m` or `2h`" };
  const [day, time] = every.split(" ");
  if (time !== undefined) {
    const at = Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
    return day === "day" ? { kind: "day", at } : { kind: "week", day: DAYS.indexOf(day as (typeof DAYS)[number]), at };
  }
  const minutes = Number(every.slice(0, -1)) * (every.endsWith("h") ? 60 : 1);
  if (minutes < EVERY_MIN_MINUTES || minutes > EVERY_MAX_MINUTES)
    return { error: `an interval is ${EVERY_MIN_MINUTES} minutes to 7 days` };
  return { kind: "interval", minutes };
}

/** A rule's folder with `~` expanded against `home`, in the platform's own path syntax. */
export function expandFolder(folder: string, home: string, platform: NodeJS.Platform): string {
  const P = platform === "win32" ? path.win32 : path.posix;
  return folder === "~" ? home : /^~[\\/]/.test(folder) ? P.join(home, folder.slice(2)) : folder;
}

/** Why a rule's folder is under the floor (CONTROL.md §14.1, *The folder's floor*), or null. The
 *  floor: not the home folder, nor a folder that holds it; not sessionpipe's config or state
 *  folders, nor inside them, nor holding them; not a harness's own folder, nor inside or holding
 *  one; not a dot-folder directly in the home folder, nor inside one; on macOS not `~/Library`,
 *  nor inside it. Compared on whole path segments, `~` expanded and `.` and `..` resolved, without
 *  regard to case on darwin and win32. Pure, so it sees no links: the CLI and the daemon compare
 *  real paths with places.ts's `realFolderProblem`. A floor, not a guarantee: the machine's folder
 *  allowlist stays the person's control. */
export function folderProblem(folder: string, places: TriggerPlaces): string | null {
  const P = places.platform === "win32" ? path.win32 : path.posix;
  const fold = places.platform === "darwin" || places.platform === "win32";
  const norm = (p: string) => (fold ? P.resolve(p).toLowerCase() : P.resolve(p));
  const within = (a: string, b: string) => {
    const r = P.relative(b, a);
    return r === "" || (r !== ".." && !r.startsWith(`..${P.sep}`) && !P.isAbsolute(r));
  };
  const home = norm(places.home);
  const abs = norm(expandFolder(folder, places.home, places.platform));
  if (abs === home) return "the folder is the home folder: name a project folder under it";
  if (within(home, abs)) return "the folder holds the home folder: name a project folder under it";
  for (const [d, what] of [
    [places.config, "sessionpipe's config folder"],
    [places.state, "sessionpipe's state folder"],
    ...places.harnesses.map((h) => [h, "a harness's own folder, whose settings and hooks every later session reads"]),
  ] as [string, string][]) {
    const n = norm(d);
    // A harness folder that is the home folder or holds it is no floor of its own: home's rule says it.
    if (within(home, n)) continue;
    if (within(abs, n) || within(n, abs)) return `the folder is, holds or lies inside ${what} (${d})`;
  }
  if (within(abs, home) && P.relative(home, abs).split(P.sep)[0]!.startsWith("."))
    return "the folder is a dot-folder in the home folder, or inside one: those hold settings and keys other programs read";
  if (places.platform === "darwin" && within(abs, norm(P.join(places.home, "Library"))))
    return "the folder is ~/Library or inside it: it holds what macOS and other programs start and read";
  return null;
}

/** Why one rule breaks what its schema can't say, or null. */
function ruleProblem(r: TriggerRule, places: TriggerPlaces): string | null {
  const notice = isNoticeSource(r.source);
  if (!(r.folder.startsWith("/") || /^[A-Za-z]:[\\/]/.test(r.folder) || HOME_RELATIVE_RE.test(r.folder)))
    return "the folder is absolute, or under ~";
  const hiddenFolder = hiddenIn(r.folder);
  if (hiddenFolder) return hiddenProblem("the folder holds", hiddenFolder);
  const hiddenWords = hiddenIn(r.words, "\t\n");
  if (hiddenWords) return hiddenProblem("the words hold", hiddenWords);
  const placed = folderProblem(r.folder, places);
  if (placed) return placed;
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
export function checkTriggers(
  value: unknown,
  places: TriggerPlaces,
): { ok: true; file: TriggersFile } | { ok: false; problems: string[] } {
  const shape = problems(CONFIG_SCHEMAS.triggers, value);
  if (shape.length) return { ok: false, problems: shape.map(visible) };
  const file = value as TriggersFile;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const [i, r] of file.rules.entries()) {
    if (seen.has(r.name)) out.push(`$.rules[${i}]: a second rule named ${r.name}`);
    seen.add(r.name);
    const why = ruleProblem(r, places);
    if (why) out.push(`$.rules[${i}] (${r.name}): ${why}`);
  }
  return out.length ? { ok: false, problems: out } : { ok: true, file };
}

/** The rules file's text, read and checked. */
export function readTriggers(text: string, places: TriggerPlaces): ReturnType<typeof checkTriggers> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, problems: ["$: not JSON"] };
  }
  return checkTriggers(value, places);
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
 *  notice runs at most one rule, and a match the cap or the cooldown then refuses does not fall
 *  through to a later rule. Whether triggers are on is the caller's first check. */
export function firstMatch(file: TriggersFile, receiver: string, n: ControlNotice): TriggerRule | null {
  return file.rules.find((r) => !r.paused && matchNotice(r, receiver, n).ok) ?? null;
}

/** The widest level the machine's mode lets a named level run at: `inherit` lets a named level
 *  be `safe` at most, as it does a start's (CONTROL.md §2). */
const MODE_CEILING: Record<MachineMode, StartPermission> = { safe: "safe", auto: "auto", inherit: "safe" };

/** What the level of a run also depends on, beyond the rule and the mode. */
export interface LevelFacts {
  /** Continuing: the session's recorded level. Absent (none recorded) and `inherit` (it ran with no
   *  permission flag) cap nothing more, as CONTROL.md §6 reads them; any other word is unknown and
   *  no run gets a level from it. */
  recorded?: StartPermission | "inherit";
  /** The levels the harness takes here (the hello's `start.<harness>.permissions`); a run gets
   *  the widest of them that is no wider. Absent: not narrowed by the harness. */
  offered?: readonly StartPermission[];
}

/** The widest a rule may run at by its source alone: a notice rule `edits`, a clock rule `auto`. */
export const sourceCeiling = (rule: Pick<TriggerRule, "source">): StartPermission =>
  isNoticeSource(rule.source) ? NOTICE_LEVEL_MAX : "auto";

/** Whether `l` is one of the four levels a rule may name (never `inherit`). */
export const isLevel = (l: unknown): l is StartPermission => levelRank(l) >= 0;

/** Why no level can be given to a run of `rule`, as the refusal a run gets, or null when one can:
 *  a rule's level that is none of the four is a rules file that does not fit (`triggers_off`, the
 *  file read as off); a recorded level the machine doesn't know is a session it can't continue
 *  as it was (`no_session`, the rule paused); a harness that takes no level so narrow, `harness`. */
export function levelRefusal(
  rule: Pick<TriggerRule, "level" | "source">,
  mode: MachineMode,
  o: LevelFacts = {},
): Refusal | null {
  if (!isLevel(rule.level)) return "triggers_off";
  if (o.recorded !== undefined && o.recorded !== "inherit" && !isLevel(o.recorded)) return "no_session";
  return triggerLevel(rule, mode, o) === null ? "harness" : null;
}

/** The level a run of `rule` gets: the narrowest of its own, its source's ceiling (a notice rule
 *  `edits` at most, whether or not the file was checked), the machine's mode and, continuing a
 *  session, that session's recorded level; then the widest the harness takes that is no wider.
 *  Null when there is none: the rule's level is not one of the four, the recorded level is a word
 *  it doesn't know, or the harness takes none so narrow (levelRefusal says which). Never wider
 *  than any of them, and never a level it was not given: "nothing is ever auto-allowed". */
export function triggerLevel(
  rule: Pick<TriggerRule, "level" | "source">,
  mode: MachineMode,
  o: LevelFacts = {},
): StartPermission | null {
  if (!isLevel(rule.level)) return null;
  if (o.recorded !== undefined && o.recorded !== "inherit" && !isLevel(o.recorded)) return null;
  let level = narrower(narrower(rule.level, sourceCeiling(rule)), MODE_CEILING[mode]);
  if (o.recorded && o.recorded !== "inherit") level = narrower(level, o.recorded);
  if (!o.offered) return level;
  const fits = START_PERMISSIONS.filter((l) => levelRank(l) <= levelRank(level) && o.offered!.includes(l));
  return fits.at(-1) ?? null;
}

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

/** What a level means for a harness where its word alone would mislead (CONTROL.md §14.7). */
const LEVEL_NOTES: Readonly<Record<string, Partial<Record<StartPermission, string>>>> = {
  codex: {
    safe: "for Codex, safe is its workspace sandbox, which writes files in the folder",
    edits: "Codex has no edits level, so it runs at safe, its workspace sandbox, which writes files in the folder",
  },
};

/** A rule in plain words, as a person confirms it: `lines[0]` is the sentence about the rule, and
 *  every line after it is a marked line of the folder or the words, so nothing in the folder or the
 *  words can read as part of the sentence or as a line of its own. Print `lines` whole (or the
 *  description itself: it prints as all of its lines); never one of them alone. */
export interface RuleDescription {
  readonly lines: readonly string[];
  toString(): string;
}

/** The mark every line of the folder and the words begins with. */
export const RULE_TEXT_MARK = " │ ";

/** The rule in plain words: what `trigger add` shows before it asks for `yes`, from the rule as
 *  it will be written, so what the person confirms is what runs. The sentence holds only what the
 *  definition's patterns keep to plain tokens (and a subject pattern only when it compiles); the
 *  folder and the words, free text, stand apart on marked lines, one line of the words per line
 *  of output. Every character that does not show as itself is written out (text.ts). */
export function describeRule(r: TriggerRule): RuleDescription {
  const s = r.source;
  let when: string;
  if (isNoticeSource(s)) {
    const filters: string[] = [];
    if (r.when?.state) filters.push(`its state is ${listOf(r.when.state)}`);
    if (r.when?.for) filters.push(`it is for ${listOf(r.when.for)}`);
    if (r.when?.by) filters.push(`${listOf(r.when.by)} made the change`);
    if (r.subject !== undefined)
      filters.push(
        "error" in subjectPattern(r.subject)
          ? "its subject matches a pattern that does not compile"
          : `its subject matches ${r.subject}`,
      );
    when =
      `When ${s.receiver} sends a notice on ${s.topic}` +
      (s.event ? ` for ${s.event}` : "") +
      (filters.length ? ` where ${filters.join(", and ")}` : "");
  } else {
    const every = parseEvery(s.every);
    const w = "error" in every ? `on the clock ${s.every}` : clockWords(every);
    when = w[0]!.toUpperCase() + w.slice(1);
  }
  const what = isStart(r.target) ? `start ${r.target.start}` : `continue ${(r.target as ContinueTarget).continue}`;
  const tools = r.tools?.length ? `, with ${r.tools.join(", ")} allowed without asking` : "";
  const cap = r.cap.per_day === 1 ? "once a day at most" : `at most ${r.cap.per_day} times a day`;
  const harness = isStart(r.target) ? r.target.start : (r.target as ContinueTarget).continue.split(":")[0]!;
  let at: string;
  if (isLevel(r.level)) {
    const level = narrower(r.level, sourceCeiling(r));
    const note = LEVEL_NOTES[harness]?.[level];
    at = `at ${level} or narrower${note ? ` (${note})` : ""}`;
  } else at = "at a level that is none of read, safe, edits and auto, so it would never run";
  const sentence = `${r.name}: ${when}, ${what} ${at}${tools}, ${cap}, in the folder and with the words below${r.paused ? " (paused)" : ""}:`;
  const lines = [
    visible(sentence),
    `  folder${RULE_TEXT_MARK}${visible(r.folder)}`,
    ...r.words.split("\n").map((l, i) => `  ${i ? "      " : "words "}${RULE_TEXT_MARK}${visible(l)}`),
  ];
  return Object.freeze({ lines: Object.freeze(lines), toString: () => lines.join("\n") });
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
 *  words the daemon starts it with. Null when the words can't be filled from `n`, or when the
 *  harness takes no level so narrow (`o.offered`; the run is refused `harness`). The words are
 *  the session's, unescaped: show them to a person through `visible`. */
export function triggerRun(
  rule: TriggerRule,
  mode: MachineMode,
  n?: ControlNotice,
  o: LevelFacts = {},
): TriggerRun | null {
  const words = ruleWords(rule, n);
  const level = triggerLevel(rule, mode, o);
  if (words === null || level === null) return null;
  return { target: rule.target, folder: rule.folder, level, tools: rule.tools ?? [], words };
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
  o: { mode: MachineMode; receiver?: string; notice?: ControlNotice; refusal?: Refusal } & LevelFacts,
): TriggerTestAnswer {
  const n = o.notice;
  const m = n ? matchNotice(rule, o.receiver ?? "", n) : isNoticeSource(rule.source) ? null : { ok: true as const };
  const base = { rule: rule.name, ...(n ? { notice: n } : {}) };
  const refused = o.refusal ? { refusal: o.refusal } : {};
  if (!m) return { ...base, ...refused, matches: false, miss: "receiver" };
  if (!m.ok) return { ...base, ...refused, matches: false, miss: m.miss };
  const run = triggerRun(rule, o.mode, n, o);
  // A match no level can be given to is refused as the daemon would (levelRefusal).
  // (Words that can't be filled after a match are a file that doesn't fit: off.)
  if (!run) return { ...base, refusal: o.refusal ?? levelRefusal(rule, o.mode, o) ?? "triggers_off", matches: true };
  return { ...base, ...refused, matches: true, run };
}
