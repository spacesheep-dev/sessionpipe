// SPDX-License-Identifier: Apache-2.0
// The trigger engine (spec/CONTROL.md §14): what the daemon does with the person's rules once
// something says one may run. One entry, `fire(rule, cause)`, where the cause is a clock tick
// or a notice a rule took; the checks of §14.7 that are not about the wire, in order; the run,
// handed to the daemon's own ask path (`deps.run`); the runs that wait; the clock; `off`; and
// the history `sessionpipe trigger list` shows. "A receiver decides whether to send. Only the
// machine decides whether to run" (CONTROL.md §1): every refusal here is the machine's.
//
// Pure in the way the daemon's other parts are: the time, the machine's mode, its folders, its
// harnesses, its sessions, its caps on starts, the run itself, a notice's ack and the disk all
// come in as `deps`, so a test drives every path with a fake clock and a fake runner (and the
// scenarios under conformance/triggers are driven from their own files). Nothing here starts a
// timer: the daemon calls `check()` on its own clock, and `retry()` when something that held a
// run let go of it.
//
// What it keeps, in `<state>/control/triggers-state.json` (written whole, 0600, by the daemon
// only): per rule its latest history lines, its runs today and what they were for, its clock's
// last tick, and a pause the machine made itself (a rule whose session is gone, §14.7 step 11);
// and every run that waits, so a restart neither loses one nor runs one twice. Never a rule's
// words, and of a notice only its own closed set of validated tokens. The rules file is the
// person's, written by the CLI only: the machine's own pause lives here, so
// `<config>/triggers.json` stays exactly what the person confirmed.

import { createHash } from "node:crypto";
import {
  type ControlHelloTriggers,
  type ControlNotice,
  type Every,
  firstMatch as firstRule,
  helloTriggers,
  isNoticeSource,
  isStart,
  levelRefusal,
  type MachineMode,
  type NoticeResult,
  parseEvery,
  type StartPermission,
  TRIGGERED_BY_ENV,
  type TriggerHistoryLine,
  type TriggerPause,
  type TriggerRefusal,
  type TriggerRule,
  type TriggerRun,
  type TriggersFile,
  triggerRun,
} from "@sessionpipe/core";
import { parseSessionRef } from "@sessionpipe/core/control";
import { dueTick, localDay, TICK_LATE_MS, type Zone, zoneOf } from "./clock.js";
import { stateOf } from "./trigger-state.js";

export { stateOf } from "./trigger-state.js";

/** What made a rule run: its clock (`due` is the tick's instant), or a notice a rule took from
 *  `receiver` (steps 1 to 6 of §14.7 are the caller's: the id read, the shape, the expiry, the
 *  dedup, the match). Plain data, so a run that waits is kept on disk as it is. */
export type Cause = { kind: "tick"; due: number } | { kind: "notice"; receiver: string; notice: ControlNotice };

/** A code a rule's history may carry: the generated line's own (an ack's refusal codes; a
 *  missed tick is a line's `result`, never a code). */
export type HistoryCode = NonNullable<TriggerHistoryLine["code"]>;

/** One run, as the daemon is asked to begin it: the rule's name, what `triggerRun` made of it
 *  (target, folder, narrowed level, tools, framed words), and what the session's environment
 *  gains. This is also the `runs` entry of the conformance scenarios. */
export interface TriggerJob {
  rule: string;
  run: TriggerRun;
  env: Record<string, string>;
}

/** What the daemon says of a run it was handed, in order: `began` (the session it runs in) or
 *  `failed` or `refused`, then `ended` once it is over (after `began` only). */
export interface RunEvents {
  /** Handed over and waiting, nothing run yet: in its session's line (`held`), or for the
   *  machine's headless slot (`start_limit`). */
  queued(why: "held" | "start_limit"): void;
  began(session: string): void;
  failed(detail: string): void;
  /** Nothing ran. `held` and `start_limit` put the run back to wait. */
  refused(code: string, detail: string): void;
  ended(ms: number): void;
}

/** How a rule's session to continue stands: gone (its transcript is not there), or there,
 *  with whether a window holds it now and the level the session was recorded at. */
export type SessionLook =
  | { gone: true }
  | {
      gone?: false;
      held: boolean;
      level?: StartPermission | "inherit";
      /** The folder a run of it really uses (its transcript's); null when that folder is not one
       *  the machine allows. Absent: not known here. */
      folder?: string | null;
    };

export interface TriggerDeps {
  now(): number;
  /** The machine's time zone; its own when unsaid. */
  zone?: string;
  mode(): MachineMode;
  /** The folder is on the machine's allowlist (§5 step 6) and over the floor, by its real path. */
  allowed(folder: string): boolean;
  /** Two folders name the same one, by their real paths (a continued session's folder against
   *  its rule's). Plain equality when unsaid. */
  sameFolder?(a: string, b: string): boolean;
  /** The harnesses this machine runs headlessly now (§6 `start`). */
  harnesses(): string[];
  session(ref: string): SessionLook;
  /** The machine's caps on starts allow one more now (shared with receivers' starts and asks). */
  startRoom(): boolean;
  /** The levels a harness takes on this machine (the hello's `start.<harness>.permissions`);
   *  a run gets the widest that is no wider than its own. Absent: not narrowed by the harness. */
  offered?(harness: string): readonly StartPermission[] | undefined;
  /** Begin a run through the daemon's own ask path; `cancel` stops it as a `cancel` would. */
  run(job: TriggerJob, on: RunEvents): { cancel(): void };
  /** A notice's outcome, for its receiver (§14.4): `taken` at most once, then exactly one
   *  final. The notices step sends it; with no receiver to tell (a clock), it is never called. */
  ack?(receiver: string, id: string, result: NoticeResult): void;
  /** The engine's record as last saved (undefined when there is none). */
  load(): unknown;
  /** Save the record whole; throws when it can't. */
  save(s: TriggerState): void;
  log(line: string): void;
  /** What a hello says of triggers may have changed (a rule, a pause, the switch). */
  changed?(): void;
  /** Each history line as it is written (the record keeps the latest HISTORY_KEPT). */
  noted?(rule: string, line: TriggerHistoryLine): void;
}

/** A rule's runs today: how many, and for which subject in which state (the cooldown). */
interface Today {
  day: string;
  runs: number;
  keys: string[];
}

/** Everything the engine keeps for one rule. */
export interface RuleState {
  /** Newest first, at most HISTORY_KEPT, none older than HISTORY_MS. */
  history: TriggerHistoryLine[];
  today?: Today;
  /** A clock rule: since when it counts (made, resumed, or its `every` changed), and its last
   *  tick, as instants. */
  clock?: { every: string; since: number; last?: number };
  /** Paused by the machine (§14.7 step 11), with the rule's target then (another target is a
   *  rule the pause no longer concerns) and why: the session is gone, or its recorded level is
   *  one this machine doesn't know (which `trigger resume` can't clear). */
  paused?: { at: string; code: "no_session"; rule: string; why?: TriggerPause };
}

/** A run that waits: for a session a window holds, or for room under the machine's caps, until
 *  `until` (a tick's six hours, a notice's `expires_at`). It holds its count of the rule's day
 *  (`day`, and for a notice the cooldown `key`) from when it was taken. */
export interface Waiting {
  rule: string;
  cause: Cause;
  until: number;
  reason: "held" | "start_limit" | "busy";
  day: string;
  key: string | null;
  /** Its notice was acked `taken`: said once, however often it waits again. */
  told?: boolean;
  /** The rule as it was taken (a hash of its JSON): one changed under the same name meanwhile
   *  is another rule, and this run is not its own. */
  shape?: string;
}

/** The engine's record (triggers-state.json). */
export interface TriggerState {
  v: 1;
  rules: Record<string, RuleState>;
  waiting: Waiting[];
}

/** Lines a rule's history keeps, and for how long. */
export const HISTORY_KEPT = 20;
export const HISTORY_MS = 7 * 24 * 3600_000;

/** A run handed to the daemon and not over: queued for the headless slot (until `until`, then
 *  refused `start_limit`), or running. */
interface Running {
  rule: string;
  cancel(): void;
  w: Waiting;
  queued: boolean;
  /** Its turn began: from here a stop keeps its count. */
  began: boolean;
  /** Over, as far as the engine is concerned: what the daemon says of it later changes nothing. */
  done: boolean;
}

/** The busy refusal: the rule's own earlier run was still going at the deadline. */
const BUSY: TriggerRefusal = "busy";

const harnessOf = (r: TriggerRule): string =>
  isStart(r.target) ? r.target.start : (parseSessionRef(r.target.continue)?.harness as string);

const SUBJECT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const STATE_RE = /^[a-z0-9_-]{1,32}$/;

/** What a machine's pause is kept against: the rule's target. A rule pointed at another session
 *  is a rule the pause no longer concerns (§14.7 step 11). */
const shapeOf = (r: TriggerRule): string => JSON.stringify(r.target);

/** A rule's fingerprint: a hash of its JSON with the switch it may flip left out. */
const fingerprint = (r: TriggerRule): string =>
  createHash("sha256")
    .update(JSON.stringify({ ...r, paused: false }))
    .digest("base64url");

/** A history line as the record keeps it: only fields of the definition, and a notice's tokens
 *  only where they fit their pattern (never anything a receiver could have put there). */
function line(
  at: number,
  result: TriggerHistoryLine["result"],
  o: { code?: HistoryCode; subject?: string | undefined; state?: string | undefined; session?: string },
): TriggerHistoryLine {
  return {
    at: new Date(at).toISOString(),
    result,
    ...(o.code ? { code: o.code } : {}),
    ...(o.subject && SUBJECT_RE.test(o.subject) ? { subject: o.subject } : {}),
    ...(o.state && STATE_RE.test(o.state) ? { state: o.state } : {}),
    ...(o.session ? { session: o.session } : {}),
  };
}

/** A daemon's refusal of a run (its ack's code) that a rule's history says as it is; any other
 *  is a run that could not begin. */
const REFUSAL_CODES: ReadonlySet<string> = new Set<TriggerRefusal>(["folder", "harness", "no_session"]);

export class TriggerEngine {
  private file: TriggersFile | null = null;
  private state: TriggerState;
  private readonly zone: Zone;
  private readonly running = new Set<Running>();

  private lastSaved = "";

  constructor(private readonly deps: TriggerDeps) {
    this.zone = zoneOf(deps.zone);
    this.state = stateOf(deps.load(), { now: deps.now(), log: deps.log });
    this.lastSaved = JSON.stringify(this.state);
  }

  private get waits(): Waiting[] {
    return this.state.waiting;
  }

  // --- the rules file -----------------------------------------------------------------

  /** The rules file as the daemon read it now (null: none, or one it refused whole). Turning
   *  triggers off, or a file it can't read, is off (§14.10): every waiting run is dropped and
   *  every running triggered turn cancelled. A rule removed or paused drops its own. */
  load(file: TriggersFile | null): void {
    const was = this.file;
    const said = JSON.stringify(this.hellos(was));
    this.file = file;
    const now = this.deps.now();
    if (file) {
      // Pruned only against a file read whole: a file being edited (refused for a moment)
      // must not wipe a rule's counts for the day, which would let it run past its cap.
      for (const name of Object.keys(this.state.rules))
        if (!file.rules.some((r) => r.name === name)) delete this.state.rules[name];
      // A waiting run whose cause doesn't fit its rule's source (a tick for a notice rule) was
      // never this rule's: a hand-edited record.
      for (const w of [...this.waits]) {
        const rule = file.rules.find((x) => x.name === w.rule);
        if (rule && isNoticeSource(rule.source) !== (w.cause.kind === "notice")) {
          this.waits.splice(this.waits.indexOf(w), 1);
          this.deps.log(`trigger ${w.rule}: a waiting run whose cause does not fit the rule was dropped`);
        }
      }
      for (const r of file.rules) {
        const st = this.ruleState(r.name);
        if (st.paused && st.paused.rule !== shapeOf(r)) delete st.paused;
        // Resumed: a clock counts from now, so the ticks it slept through don't run.
        if (was?.rules.find((x) => x.name === r.name)?.paused && !r.paused && st.clock)
          st.clock = { every: st.clock.every, since: now };
      }
    }
    // Off: a run still queued for the headless slot never began and is dropped like a waiting
    // one; a run that has begun is stopped (§14.10).
    if (!file?.on)
      for (const run of [...this.running]) {
        // A run whose turn has not begun ends without running: refused, its count given back.
        if (!run.began) {
          run.done = true;
          this.running.delete(run);
          this.end(run.w, "triggers_off");
        }
        run.cancel();
      }
    this.drop((w) => !this.live(w.rule), "triggers_off");
    this.saved();
    if (JSON.stringify(this.hellos(file)) !== said) this.deps.changed?.();
  }

  /** The rules as they run: the file's, with the machine's own pauses on them. */
  private rules(f: TriggersFile | null = this.file): TriggerRule[] {
    return (f?.rules ?? []).map((r) => (this.state.rules[r.name]?.paused ? { ...r, paused: true } : r));
  }

  /** What every hello's `triggers` would say: on, and each receiver's topics. A hello goes at
   *  once only when that changes (§14.3). */
  private hellos(f: TriggersFile | null): unknown {
    if (!f?.on) return false;
    return this.rules(f).flatMap((r) =>
      !r.paused && isNoticeSource(r.source) ? [[r.source.receiver, r.source.topic]] : [],
    );
  }

  /** What a hello to `receiver` says of triggers (§14.3), the machine's own pauses counted:
   *  the seam for the hello, which is the notices step's to send. */
  helloFor(receiver: string): ControlHelloTriggers {
    return helloTriggers(this.file ? { ...this.file, rules: this.rules() } : null, receiver);
  }

  /** The rule that takes a notice from `receiver` (§14.7 step 6): the first in the file's
   *  order, not paused by the person or the machine, that matches; null runs nothing. */
  firstMatch(receiver: string, n: ControlNotice): TriggerRule | null {
    return this.file ? firstRule({ ...this.file, rules: this.rules() }, receiver, n) : null;
  }

  /** The rules the machine has paused itself, by name. */
  pausedByMachine(): string[] {
    return Object.entries(this.state.rules)
      .filter(([, s]) => s.paused)
      .map(([n]) => n);
  }

  private live(name: string): TriggerRule | null {
    if (!this.file?.on) return null;
    const r = this.rules().find((x) => x.name === name);
    return r && !r.paused ? r : null;
  }

  private ruleState(name: string): RuleState {
    // `rules` has no prototype (trigger-state.ts): `constructor` is a name like any other.
    if (!Object.hasOwn(this.state.rules, name)) this.state.rules[name] = { history: [] };
    return this.state.rules[name] as RuleState;
  }

  // --- one run ------------------------------------------------------------------------

  /** A rule may run, because of `cause`. §14.7's checks that are not about the wire, in
   *  order, each with its own refusal: triggers on; the rule there and not paused; the
   *  cooldown (notices only); the cap; the folder; the harness; the session to continue. Then
   *  it runs, or waits for a window to let go or for room under the machine's caps. */
  fire(name: string, cause: Cause): void {
    if (!this.file?.on) {
      this.refuse(name, cause, "triggers_off");
      return;
    }
    const rule = this.live(name);
    // A paused rule's tick is nothing; a notice no rule takes ran nothing (step 6).
    if (!rule) {
      this.tell(cause, { outcome: "no_match" });
      return;
    }
    const day = localDay(this.zone, this.deps.now());
    const today = this.today(name, day);
    const n = cause.kind === "notice" ? cause.notice : undefined;
    const key = n ? `${n.subject}/${n.state ?? ""}` : null;
    // A notice sets a rule off once a day per subject and state, however often the board
    // changes; a clock rule has no subject.
    if (key && today.keys.includes(key)) {
      this.refuse(name, cause, "cooldown");
      return;
    }
    // A run counts against the cap from the moment it is taken, and keeps counting whether it
    // then works or fails; one that ends without running gives its count back.
    if (today.runs >= rule.cap.per_day) {
      this.refuse(name, cause, "cap");
      return;
    }
    const why = this.cannot(rule);
    if (why) {
      this.refuse(name, cause, why);
      return;
    }
    today.runs++;
    if (key) today.keys.push(key);
    const until = n ? Date.parse(n.expires_at) : (cause as { due: number }).due + TICK_LATE_MS;
    this.attempt({ rule: name, cause, until, reason: "start_limit", day, key, shape: fingerprint(rule) });
  }

  /** Why the rule can't run here now (§14.7 steps 9 to 11), or null. A session that is gone
   *  pauses the rule, which the machine says in `trigger list` and its next hello. */
  private cannot(rule: TriggerRule): TriggerRefusal | null {
    if (!this.deps.allowed(rule.folder)) return "folder";
    const harness = isStart(rule.target) ? rule.target.start : parseSessionRef(rule.target.continue)?.harness;
    if (!harness || !this.deps.harnesses().includes(harness)) return "harness";
    if (!isStart(rule.target)) {
      const look = this.deps.session(rule.target.continue);
      if (look.gone) {
        this.pause(rule, "gone");
        return "no_session";
      }
      // The folder the run really uses is the session's: it is the rule's, allowed and over the
      // floor, or the run is refused (§14.1 `folder`).
      if (look.folder === null) return "folder";
      const same = this.deps.sameFolder ?? ((a: string, b: string) => a === b);
      if (look.folder !== undefined && !(same(look.folder, rule.folder) && this.deps.allowed(look.folder)))
        return "folder";
    }
    return null;
  }

  private pause(rule: TriggerRule, why: TriggerPause): void {
    const said = JSON.stringify(this.hellos(this.file));
    this.ruleState(rule.name).paused = {
      at: new Date(this.deps.now()).toISOString(),
      code: "no_session",
      rule: shapeOf(rule),
      why,
    };
    this.deps.log(`trigger ${rule.name}: the session it continues is gone; this computer paused the rule`);
    if (JSON.stringify(this.hellos(this.file)) !== said) this.deps.changed?.();
  }

  /** Begin it now, or wait. A start waits for room under the machine's caps; a session a
   *  window holds is waited for, never forked, never handed to the window (§14.7). */
  private attempt(w: Waiting): void {
    const rule = this.live(w.rule) as TriggerRule;
    // One run of a rule at a time: the next waits while its last is still going.
    if ([...this.running].some((x) => x.rule === w.rule && !x.done)) {
      this.wait(w, "busy");
      return;
    }
    let level: StartPermission | "inherit" | undefined;
    if (isStart(rule.target)) {
      if (!this.deps.startRoom()) {
        this.wait(w, "start_limit");
        return;
      }
    } else {
      const look = this.deps.session(rule.target.continue) as Exclude<SessionLook, { gone: true }>;
      if (look.held) {
        this.wait(w, "held");
        return;
      }
      level = look.level;
    }
    // The level is triggerRun's, never computed here: the narrowest of the rule's, its source's
    // ceiling, the machine's mode and the session's own, then the widest the harness takes that
    // is no wider. No run: the definition's levelRefusal says why, never a default level (a rule
    // level that is none of the four is a file that doesn't fit; a recorded level the machine
    // doesn't know is a session it can't continue as it was, and the rule is paused; nothing so
    // narrow offered is the harness's).
    const offered = this.deps.offered?.(harnessOf(rule));
    const facts = { ...(level ? { recorded: level } : {}), ...(offered ? { offered } : {}) };
    const run = triggerRun(rule, this.deps.mode(), w.cause.kind === "notice" ? w.cause.notice : undefined, facts);
    if (!run) {
      // A matched notice fills every field its words name (matchNotice): no level is the one way here.
      const code = levelRefusal(rule, this.deps.mode(), facts) as TriggerRefusal;
      if (code === "no_session") this.pause(rule, "unknown_level");
      this.end(w, code);
      return;
    }
    this.begin(w, { rule: w.rule, run, env: { [TRIGGERED_BY_ENV]: w.rule } });
  }

  private begin(w: Waiting, job: TriggerJob): void {
    const n = w.cause.kind === "notice" ? w.cause.notice : undefined;
    const fields = n ? { subject: n.subject, state: n.state } : {};
    let entry: TriggerHistoryLine | null = null;
    let handle: { cancel(): void } | null = null;
    const running: Running = {
      rule: w.rule,
      cancel: () => handle?.cancel(),
      w,
      queued: false,
      began: false,
      done: false,
    };
    /** The run is over: what waits behind it (the rule's next run) gets its turn. */
    const over = (): boolean => {
      if (running.done) return false;
      running.done = true;
      this.running.delete(running);
      return true;
    };
    const failed = () => {
      this.history(w.rule, line(this.deps.now(), "failed", fields));
      this.tell(w.cause, { outcome: "failed" });
    };
    this.running.add(running);
    handle = this.deps.run(job, {
      queued: (why) => {
        // Handed over and waiting (the session's line, the headless slot): taken, under the
        // run's own deadline, refused for what it waits for when that passes.
        running.queued = true;
        w.reason = why;
        if (!w.told) this.tell(w.cause, { outcome: "taken" });
        w.told = true;
      },
      began: (session) => {
        if (running.done) return;
        running.queued = false;
        running.began = true;
        entry = this.history(w.rule, line(this.deps.now(), "ran", { ...fields, session }));
        this.deps.log(`trigger ${w.rule}: ran in ${session}`);
        this.tell(w.cause, { outcome: "ran", session });
      },
      failed: (detail) => {
        if (!over()) return;
        this.deps.log(`trigger ${w.rule}: the run could not begin: ${detail}`);
        failed();
        this.retry();
      },
      refused: (code, detail) => {
        if (!over()) return;
        this.deps.log(`trigger ${w.rule}: the daemon said no (${code}): ${detail}`);
        const rule = this.live(w.rule);
        // Held, or the caps reached, between the look and the run: it waits again.
        if ((code === "held" || code === "start_limit") && rule) return this.wait(w, code);
        if (code === "no_session" && rule) this.pause(rule, "gone");
        if (REFUSAL_CODES.has(code)) this.end(w, code as TriggerRefusal);
        // Anything else the daemon refuses (a level or a session id it won't take) is a run
        // that could not begin: it counts, as a failure does.
        else failed();
        this.retry();
      },
      ended: (ms) => {
        if (!over()) return;
        // `ended` comes only after `began` (the daemon says began before a final delivered).
        (entry as TriggerHistoryLine).ms = Math.max(0, Math.round(ms));
        this.saved();
        this.retry();
      },
    });
  }

  /** It waits: `taken` to its notice, once, and kept on disk. */
  private wait(w: Waiting, reason: Waiting["reason"]): void {
    if (this.deps.now() >= w.until) {
      this.end(w, reason === "busy" ? BUSY : reason);
      return;
    }
    w.reason = reason;
    this.waits.push(w);
    if (!w.told) this.tell(w.cause, { outcome: "taken" });
    const said = w.told;
    w.told = true;
    if (!said)
      this.deps.log(
        `trigger ${w.rule}: waits (${reason === "held" ? "a window holds its session" : reason === "busy" ? "its own earlier run is still going" : "the machine's caps on starts are reached"})`,
      );
    this.saved();
  }

  private tell(cause: Cause, r: NoticeResult): void {
    if (cause.kind === "notice") this.deps.ack?.(cause.receiver, cause.notice.id, r);
  }

  /** A refusal before anything was counted: a history line, and the notice's ack. */
  private refuse(name: string, cause: Cause, code: TriggerRefusal): void {
    const n = cause.kind === "notice" ? cause.notice : undefined;
    if (this.file?.rules.some((r) => r.name === name))
      this.history(name, line(this.deps.now(), "refused", { code, subject: n?.subject, state: n?.state }));
    this.deps.log(`trigger ${name}: refused (${code})`);
    this.tell(cause, { outcome: "refused", code });
  }

  /** A run that was taken and ends without running: what it held of the day goes back. */
  private end(w: Waiting, code: TriggerRefusal): void {
    this.giveBack(w);
    this.refuse(w.rule, w.cause, code);
  }

  /** A run that ends without running gives its count of the day back, and its cooldown key. */
  private giveBack(w: Waiting): void {
    const st = this.state.rules[w.rule];
    if (st?.today?.day === w.day) {
      st.today.runs = Math.max(0, st.today.runs - 1);
      if (w.key) st.today.keys = st.today.keys.filter((k) => k !== w.key);
    }
  }

  private today(name: string, day: string): Today {
    const st = this.ruleState(name);
    if (st.today?.day !== day) st.today = { day, runs: 0, keys: [] };
    return st.today;
  }

  /** A line at the top of a rule's history, the record saved; the line, for its `ms` later. */
  private history(name: string, l: TriggerHistoryLine): TriggerHistoryLine {
    const st = this.ruleState(name);
    st.history = [l, ...st.history].slice(0, HISTORY_KEPT);
    this.deps.noted?.(name, l);
    this.saved();
    return l;
  }

  /** Save the record, bounded; a disk that won't take it is said in the log. */
  private saved(): void {
    const old = new Date(this.deps.now() - HISTORY_MS).toISOString();
    for (const st of Object.values(this.state.rules)) st.history = st.history.filter((l) => l.at >= old);
    // Written only when something changed: the clock comes round every half minute.
    const now = JSON.stringify(this.state);
    if (now === this.lastSaved) return;
    try {
      this.deps.save(this.state);
      this.lastSaved = now;
    } catch (e) {
      this.deps.log(`couldn't save the triggers' record: ${(e as Error).message}`);
    }
  }

  // --- the runs that wait -----------------------------------------------------------

  /** Every run that waits gets another look, in the order they came: one past its time is
   *  refused (`held` or `start_limit`, by what it last waited for), and the folder, the
   *  harness and the session are checked again before it runs. */
  private retrying = false;
  retry(): void {
    // A run that ends inside a retry (a runner that answers at once) lets the next go then.
    if (this.retrying) return;
    this.retrying = true;
    this.expire();
    for (const w of this.waits.splice(0)) {
      const rule = this.live(w.rule);
      // Another rule under the same name meanwhile: this run was not its own. Nothing of it is
      // written under the new rule; a notice is acked as no rule took it.
      if (rule && w.shape !== undefined && w.shape !== fingerprint(rule)) {
        this.deps.log(`trigger ${w.rule}: the rule changed while a run of it waited; the run was dropped`);
        this.giveBack(w);
        this.tell(w.cause, { outcome: "no_match" });
      } else if (!rule) this.end(w, "triggers_off");
      // Still waiting for what it waited for: kept as it is. Only a run that is let go is
      // checked again (steps 9 to 11).
      else if (this.blocked(w, rule)) this.waits.push(w);
      else {
        const why = this.cannot(rule);
        if (why) this.end(w, why);
        else this.attempt(w);
      }
    }
    this.retrying = false;
    this.saved();
  }

  /** Waiting runs past their deadline end now, refused for what they last waited for (`held`
   *  or `start_limit`), their counts given back: first, whatever else then happens. */
  expire(): void {
    const now = this.deps.now();
    for (const w of this.waits.filter((x) => now >= x.until)) {
      this.waits.splice(this.waits.indexOf(w), 1);
      this.end(w, w.reason === "busy" ? BUSY : w.reason);
    }
    // A run still queued for the headless slot at its deadline never began: it is let go.
    for (const x of [...this.running].filter((y) => y.queued && !y.began && !y.done && now >= y.w.until)) {
      x.done = true;
      this.running.delete(x);
      x.cancel();
      this.end(x.w, x.w.reason === "held" ? "held" : "start_limit");
    }
  }

  /** What a waiting run still waits for, if anything: its rule's own run, room under the caps
   *  on starts, a window on its session. */
  private blocked(w: Waiting, rule: TriggerRule): boolean {
    if ([...this.running].some((x) => x.rule === w.rule && !x.done)) return true;
    if (isStart(rule.target)) return !this.deps.startRoom();
    const look = this.deps.session(rule.target.continue);
    return !look.gone && look.held;
  }

  /** Waiting runs that end now, refused with `code`: their notices are acked so. */
  private drop(which: (w: Waiting) => boolean, code: TriggerRefusal): void {
    for (const w of this.waits.filter(which)) {
      this.waits.splice(this.waits.indexOf(w), 1);
      this.end(w, code);
    }
  }

  /** The running triggered turns, by rule (for `status`): handed over and not waiting there. */
  runningNow(): string[] {
    return [...this.running].filter((r) => !r.done && !r.queued).map((r) => r.rule);
  }

  /** The runs that wait, by rule: on this engine's list, and handed over but waiting there (in
   *  the session's line, for the headless slot). */
  waitingNow(): string[] {
    return [
      ...this.waits.map((w) => w.rule),
      ...[...this.running].filter((r) => !r.done && r.queued).map((r) => r.rule),
    ];
  }

  // --- the clock --------------------------------------------------------------------

  /** The daemon's clock came round (every half minute, and on waking): every clock rule whose
   *  tick came runs once, however many ticks were missed, when the latest is under six hours
   *  late; later it is refused `missed`. Off, a tick is refused `triggers_off`. A paused rule's
   *  tick is nothing. The tick is recorded before anything runs, so a restart never runs it
   *  twice. Then the runs that wait get another look. */
  /** How many times the clock has come round: what a test waits on, never the wall clock. */
  checks = 0;

  check(): void {
    this.checks++;
    const now = this.deps.now();
    for (const r of this.rules()) {
      if (isNoticeSource(r.source)) continue;
      const st = this.ruleState(r.name);
      if (st.clock?.every !== r.source.every) st.clock = { every: r.source.every, since: now };
      const c = st.clock;
      if (r.paused) {
        c.since = now;
        delete c.last;
        continue;
      }
      const every = parseEvery(r.source.every) as Every;
      const due = dueTick(every, this.zone, { now, after: c.last ?? c.since - 1, anchor: c.last ?? c.since });
      if (due === null) continue;
      c.last = due;
      this.saved();
      if (!this.file?.on) this.refuse(r.name, { kind: "tick", due }, "triggers_off");
      else if (now - due >= TICK_LATE_MS) {
        // Six hours late or more: a line in the history and nothing else (§14.6).
        this.history(r.name, line(now, "missed", {}));
        this.deps.log(`trigger ${r.name}: the tick of ${new Date(due).toISOString()} was missed`);
      } else this.fire(r.name, { kind: "tick", due });
    }
    this.retry();
  }

  // --- the person's resume of a machine's pause --------------------------------------

  /** `trigger resume` at the terminal, for a rule this machine paused: the pause is let go.
   *  It lifts only the machine's own pause, never the person's (the file's), so it widens
   *  nothing the person did not confirm there. */
  lift(name: string): boolean {
    const st = this.state.rules[name];
    if (!st?.paused) return false;
    const said = JSON.stringify(this.hellos(this.file));
    delete st.paused;
    if (st.clock) st.clock = { every: st.clock.every, since: this.deps.now() };
    this.saved();
    this.deps.log(`trigger ${name}: resumed at the terminal; this computer's pause is let go`);
    if (JSON.stringify(this.hellos(this.file)) !== said) this.deps.changed?.();
    return true;
  }
}
