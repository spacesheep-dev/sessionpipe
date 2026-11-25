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
  matchNotice,
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
import { type DropWhy, stateOf } from "./trigger-state.js";

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
  /** Asked by the daemon at the moment the turn would begin, before anything starts: whether it
   *  may. A run handed over is checked again here (its rule there, unpaused and the same, and the
   *  folder, harness, session and level as they are now); false, it is dropped and must not begin. */
  ready(): boolean;
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
      /** The folder a run of it really uses (its transcript's); null when the machine can't tell it,
       *  or it is not one the machine allows. Either way no run (§14.7 step 12). */
      folder: string | null;
    };

export interface TriggerDeps {
  now(): number;
  /** The machine's time zone; its own when unsaid. */
  zone?: string;
  /** The user's home folder, for comparing `~/` and full folder paths in rule fingerprints. */
  home?: string;
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
  /** The notices step's dedup store: `id` is a notice this machine received from `receiver`. A
   *  notice only ever gets acks when it did (a waiting run read from the record may name any), and
   *  at most one final ack. A notice taken by `fire` in this engine's life was received. */
  received?(receiver: string, id: string): boolean;
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

/** A value in one spelling: keys sorted, a list of words as a set (sorted, once each), and what is
 *  absent, empty or null left out, so a file written by hand or by another version reads the same. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) {
    const xs = v.map(canonical).filter((x) => x !== undefined);
    // A rule's lists are lists of words (states, people, tools): a set, in one order.
    return xs.length ? [...new Set(xs as string[])].sort() : undefined;
  }
  if (typeof v === "object" && v !== null) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      const x = canonical((v as Record<string, unknown>)[k]);
      if (x !== undefined) out[k] = x;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return v === null || v === "" ? undefined : v;
}

/** A folder in one spelling (`~` expanded against `home`, trailing `/` dropped) so `~/work/acme`
 *  and `/home/sam/work/acme` hash the same (§14.7, *Paused, removed or changed*). */
function folderKey(f: string, home?: string): string {
  const abs = home && f.startsWith("~/") ? `${home}${f.slice(1)}` : f;
  return abs.replace(/\/+$/, "");
}

/** A rule's fingerprint: a hash of what decides what a run of it does (where it comes from and
 *  what it takes, what it runs, where, at which level, with which tools and words), in one
 *  spelling. Its name, its cap and its pause are left out: none of them changes a run. */
export const fingerprint = (r: TriggerRule, home?: string): string =>
  createHash("sha256")
    .update(
      JSON.stringify(
        canonical({
          source: r.source,
          when: r.when,
          subject: r.subject,
          target: r.target,
          folder: folderKey(r.folder, home),
          level: r.level,
          tools: r.tools,
          words: r.words,
        }),
      ),
    )
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
  /** Notices this engine was given by `fire`, and those already given their final ack. */
  private readonly heard = new Set<string>();
  private readonly finals = new Set<string>();
  /** The daemon stopped (`suspend`): nothing more is done, said or saved. */
  private stopped = false;

  constructor(private readonly deps: TriggerDeps) {
    this.zone = zoneOf(deps.zone);
    this.state = stateOf(deps.load(), {
      now: deps.now(),
      log: deps.log,
      drop: (cause, why) => this.settle(cause, why),
    });
    this.lastSaved = JSON.stringify(this.state);
  }

  private get waits(): Waiting[] {
    return this.state.waiting;
  }

  private fp(r: TriggerRule): string {
    return fingerprint(r, this.deps.home);
  }

  // --- the rules file -----------------------------------------------------------------

  /** The rules file as the daemon read it now (null: none, or one it refused whole). Turning
   *  triggers off, or a file it can't read, is off (§14.10): every waiting run is dropped and
   *  every running triggered turn cancelled. A rule removed or paused drops its own. */
  load(file: TriggersFile | null): void {
    if (this.stopped) return;
    const was = this.file;
    const said = JSON.stringify(this.hellos(was));
    this.file = file;
    const now = this.deps.now();
    if (file) {
      // Pruned only against a file read whole: a file being edited (refused for a moment)
      // must not wipe a rule's counts for the day, which would let it run past its cap.
      for (const name of Object.keys(this.state.rules))
        if (!file.rules.some((r) => r.name === name)) delete this.state.rules[name];
      this.fitWaits(file);
      for (const r of file.rules) {
        const st = this.ruleState(r.name);
        if (st.paused && st.paused.rule !== shapeOf(r)) delete st.paused;
        // Resumed: a clock counts from now, so the ticks it slept through don't run.
        if (was?.rules.find((x) => x.name === r.name)?.paused && !r.paused && st.clock)
          st.clock = { every: st.clock.every, since: now };
      }
    }
    // Off: a run still queued (its session's line, the headless slot) never began and is dropped
    // like a waiting one; a run that has begun is stopped (§14.10). A rule paused or removed drops
    // its queued runs too, and lets a running one finish.
    for (const run of [...this.running]) {
      // A queued run is the rule's as it was taken: changed under the same name, it is dropped.
      const live = this.live(run.rule);
      if (file?.on && (run.began || (live && this.fp(live) === run.w.shape))) continue;
      // A run whose turn has not begun ends without running: its count given back.
      if (!run.began) {
        run.done = true;
        this.running.delete(run);
        this.letGo(run.w);
      }
      this.call("cancel", () => run.cancel());
    }
    for (const w of this.waits.filter((x) => !this.live(x.rule))) {
      this.waits.splice(this.waits.indexOf(w), 1);
      this.letGo(w);
    }
    // A rule changed under the same name drops the runs that waited for it as it was.
    for (const w of this.waits.filter(
      (x) => x.shape !== undefined && x.shape !== this.fp(this.live(x.rule) as TriggerRule),
    )) {
      this.waits.splice(this.waits.indexOf(w), 1);
      this.letGo(w);
    }
    this.saved();
    if (JSON.stringify(this.hellos(file)) !== said) this.changed();
  }

  /** The rules as they run: the file's, with the machine's own pauses on them. */
  private rules(f: TriggersFile | null = this.file): TriggerRule[] {
    return (f?.rules ?? []).map((r) => (this.state.rules[r.name]?.paused ? { ...r, paused: true } : r));
  }

  /** What every hello's `triggers` would say: on, and each receiver's topics. A hello goes at
   *  once only when that changes (§14.3). */
  private hellos(f: TriggersFile | null): unknown {
    if (!f?.on) return false;
    // Each receiver's topics as a set: rules moved in the file need no hello (§14.3).
    const pairs = this.rules(f).flatMap((r) =>
      !r.paused && isNoticeSource(r.source) ? [`${r.source.receiver} ${r.source.topic}`] : [],
    );
    return [...new Set(pairs)].sort();
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
    if (this.stopped) return;
    if (cause.kind === "notice") {
      const k = `${cause.receiver}\n${cause.notice.id}`;
      this.heard.add(k);
      if (this.heard.size > 10_000) this.heard.delete(this.heard.values().next().value as string);
    }
    let taken: Waiting | null = null;
    try {
      this.fireNow(name, cause, (w) => {
        taken = w;
      });
    } catch (e) {
      // Nothing in a rule's run may stop the engine: a run that could not begin, said once.
      if (taken) this.fault(taken, e);
      else {
        this.deps.log(`trigger ${name}: the run could not begin: ${String(e)}`);
        // Only a rule in the file gets this far (its look is what threw).
        this.history(name, line(this.deps.now(), "failed", this.fields({ cause } as Waiting)));
        this.tell(cause, { outcome: "failed" });
      }
    }
  }

  private fireNow(name: string, cause: Cause, counted: (w: Waiting) => void): void {
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
    const w: Waiting = { rule: name, cause, until, reason: "start_limit", day, key, shape: this.fp(rule) };
    counted(w);
    this.attempt(w);
  }

  /** A run's look threw (a dependency of the daemon's): what was handed over and never began is let
   *  go of, and the run, not waiting and not running, could not begin. Its count goes back, since
   *  nothing ran; its notice is told `failed`. */
  private fault(w: Waiting, e: unknown): void {
    this.deps.log(`trigger ${w.rule}: the run could not begin: ${String(e)}`);
    this.unhand(w);
    if (this.placed(w)) return;
    this.giveBack(w);
    this.history(w.rule, line(this.deps.now(), "failed", this.fields(w)));
    this.tell(w.cause, { outcome: "failed" });
  }

  /** A run of `w` handed to the daemon whose turn never began: no longer the engine's. */
  private unhand(w: Waiting): void {
    for (const r of [...this.running])
      if (r.w === w && !r.began) {
        r.done = true;
        this.running.delete(r);
      }
  }

  /** `w` waits, or runs. */
  private placed(w: Waiting): boolean {
    return this.waits.includes(w) || [...this.running].some((r) => r.w === w && !r.done);
  }

  private fields(w: Waiting): { subject?: string; state?: string } {
    const n = w.cause.kind === "notice" ? w.cause.notice : undefined;
    return n ? { subject: n.subject, ...(n.state !== undefined ? { state: n.state } : {}) } : {};
  }

  /** Waiting runs read from the record that these rules could never have made, dropped and said,
   *  their notices told: a cause of the other kind (a tick for a notice rule), a tick that is no
   *  tick of its rule's clock or more than six hours old, a notice past its `expires_at` or one its
   *  rule would not take, or more for one rule and day than its cap (the oldest kept). No stored day
   *  is trusted: a run's day is its cause's own (a tick's due time, a notice's `at`) in this
   *  machine's zone now, and today's cap counts the runs of today that do not wait as well. A
   *  hand-made record runs a rule no more than its rule allows. */
  private fitWaits(file: TriggersFile): void {
    const now = this.deps.now();
    const todayIs = localDay(this.zone, now);
    // Today's runs that are not waiting: the stored count less the waits it was counted for.
    const ranToday = new Map<string, number>();
    for (const r of file.rules) {
      const st = this.state.rules[r.name];
      if (!st?.today) continue;
      // A day after today is no day a run was taken.
      if (st.today.day > todayIs) st.today.day = todayIs;
      if (st.today.day !== todayIs) continue;
      const labelled = this.waits.filter((w) => w.rule === r.name && w.day === todayIs).length;
      ranToday.set(r.name, Math.max(0, st.today.runs - labelled));
    }
    const per = new Map<string, number>();
    const kept = new Map<string, Waiting[]>();
    for (const w of [...this.waits]) {
      const rule = file.rules.find((x) => x.name === w.rule);
      if (!rule) continue;
      const c = w.cause;
      const causeAt = c.kind === "tick" ? c.due : Date.parse(c.notice.at);
      const causeDay = localDay(this.zone, causeAt);
      // Keep the day the run was taken when it lies within [causeDay, today], else clamp it into
      // that range: honest overnight waits stay on today's count, and a hand-made day cannot escape.
      if (w.day < causeDay) w.day = causeDay;
      if (w.day > todayIs) w.day = todayIs;
      // Never wait more than 24 h past now, whatever a hand-made record claims.
      w.until = Math.min(w.until, now + 24 * 3600_000);
      const n = (per.get(`${w.rule}\n${w.day}`) ?? 0) + 1 + (w.day === todayIs ? (ranToday.get(w.rule) ?? 0) : 0);
      let why: [string, DropWhy] | null = null;
      if (isNoticeSource(rule.source) !== (c.kind === "notice")) why = ["its cause does not fit the rule", "no_match"];
      else if (c.kind === "tick") {
        if (!this.realTick(rule, c.due)) why = ["its tick is no tick of the rule's clock", "no_match"];
        else if (now - c.due >= TICK_LATE_MS) why = ["its tick is six hours old or more", "expired"];
      } else if (
        causeAt > now + 5 * 60_000 ||
        now >= Date.parse(c.notice.expires_at) ||
        Date.parse(c.notice.expires_at) - causeAt > 24 * 3600_000
      )
        why = ["its notice has expired", "expired"];
      else if (!matchNotice(rule, c.receiver, c.notice).ok) why = ["its rule does not take its notice", "no_match"];
      if (!why && n > rule.cap.per_day) why = ["more for that day than the rule's cap", "cap"];
      if (!why) {
        per.set(`${w.rule}\n${w.day}`, (per.get(`${w.rule}\n${w.day}`) ?? 0) + 1);
        if (w.day === todayIs) kept.set(w.rule, [...(kept.get(w.rule) ?? []), w]);
        continue;
      }
      this.waits.splice(this.waits.indexOf(w), 1);
      this.deps.log(`trigger ${w.rule}: a waiting run was dropped: ${why[0]}`);
      this.settle(c, why[1]);
    }
    // Today's count is what ran today and what waits for today; the keys, theirs.
    for (const r of file.rules) {
      const waits = kept.get(r.name) ?? [];
      const st = this.state.rules[r.name];
      if (!st || (!waits.length && !ranToday.has(r.name))) continue;
      const keys = st.today?.day === todayIs ? st.today.keys : [];
      st.today = {
        day: todayIs,
        runs: (ranToday.get(r.name) ?? 0) + waits.length,
        keys: [...new Set([...keys, ...waits.flatMap((w) => (w.key ? [w.key] : []))])],
      };
    }
  }

  /** `due` is a tick the clock of `rule` has had: on its `every`, since the clock counts, and no
   *  later than its last. */
  private realTick(rule: TriggerRule, due: number): boolean {
    const c = this.state.rules[rule.name]?.clock;
    const every = (rule.source as { every: string }).every;
    if (!c || c.every !== every) return false;
    if (c.last === undefined || due > c.last || due < c.since) return false;
    const e = parseEvery(every) as Every;
    if (e.kind === "interval") return (due - c.since) % (e.minutes * 60_000) === 0;
    return dueTick(e, this.zone, { now: due, after: due - 1, anchor: due }) === due;
  }

  /** A notice's final ack for a waiting run dropped before it could run: its rule is none, its
   *  time is past, or it was one too many for its rule's cap. A tick is told nothing. */
  private settle(cause: Cause, why: DropWhy): void {
    this.tell(cause, why === "cap" ? { outcome: "refused", code: "cap" } : { outcome: why });
  }

  /** A run taken for a rule that no longer runs as it was, before its turn began, its count given
   *  back. Off, it is refused `triggers_off` (§14.10); the rule paused, removed or changed, its
   *  notice is told `no_match`, as one that meets only a paused rule is, and the rule's history
   *  says `dropped` while the rule is in the file (§14.7, *Paused, removed or changed*). */
  private letGo(w: Waiting): void {
    if (!this.file?.on) {
      this.end(w, "triggers_off");
      return;
    }
    this.giveBack(w);
    this.deps.log(`trigger ${w.rule}: a run that waited was dropped: the rule is paused, removed or changed`);
    if (this.file.rules.some((r) => r.name === w.rule))
      this.history(w.rule, line(this.deps.now(), "dropped", this.fields(w)));
    this.settle(w.cause, "no_match");
  }

  /** One call out to the daemon that may throw: said in the log, and the engine goes on. */
  private call(what: string, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.deps.log(`trigger rules: ${what} failed (${String(e)}); the engine goes on`);
    }
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
      const same = this.deps.sameFolder ?? ((a: string, b: string) => a === b);
      if (look.folder === null || !(same(look.folder, rule.folder) && this.deps.allowed(look.folder))) return "folder";
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
    // The machine's own pause drops the rule's other waiting runs as a person's pause does (§14.7).
    for (const w of this.waits.filter((x) => x.rule === rule.name)) {
      this.waits.splice(this.waits.indexOf(w), 1);
      this.letGo(w);
    }
    this.deps.log(`trigger ${rule.name}: the session it continues is gone; this computer paused the rule`);
    if (JSON.stringify(this.hellos(this.file)) !== said) this.changed();
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
    if (isStart(rule.target)) {
      if (!this.deps.startRoom()) {
        this.wait(w, "start_limit");
        return;
      }
    } else if ((this.deps.session(rule.target.continue) as Exclude<SessionLook, { gone: true }>).held) {
      this.wait(w, "held");
      return;
    }
    const job = this.jobFor(w, rule);
    if ("refused" in job) {
      if (job.refused === "no_session") this.pause(rule, "unknown_level");
      this.end(w, job.refused);
      return;
    }
    this.begin(w, job);
  }

  /** The run of `w` as `rule` makes it now. The level is triggerRun's, never computed here: the
   *  narrowest of the rule's, its source's ceiling, the machine's mode and the session's own, then
   *  the widest the harness takes that is no wider. No run: the definition's levelRefusal says why,
   *  never a default level (a rule level that is none of the four is a file that doesn't fit; a
   *  recorded level the machine doesn't know is a session it can't continue as it was; nothing so
   *  narrow offered is the harness's). */
  private jobFor(w: Waiting, rule: TriggerRule): TriggerJob | { refused: TriggerRefusal } {
    const look = isStart(rule.target) ? null : this.deps.session(rule.target.continue);
    const level = look && !look.gone ? look.level : undefined;
    const offered = this.deps.offered?.(harnessOf(rule));
    const facts = { ...(level ? { recorded: level } : {}), ...(offered ? { offered } : {}) };
    const run = triggerRun(rule, this.deps.mode(), w.cause.kind === "notice" ? w.cause.notice : undefined, facts);
    // A matched notice fills every field its words name (matchNotice): no level is the one way here.
    if (!run) return { refused: levelRefusal(rule, this.deps.mode(), facts) as TriggerRefusal };
    return { rule: w.rule, run, env: { [TRIGGERED_BY_ENV]: w.rule } };
  }

  /** A run handed over is checked again the moment its turn would begin: its rule there, unpaused
   *  and the same (else "drop"), and the folder, harness, session and level as they are now (else
   *  refused with that step's code, or "drop" if the job changed in level). */
  private stillSo(w: Waiting, job: TriggerJob): "ok" | "drop" | TriggerRefusal {
    const rule = this.live(w.rule);
    /* v8 ignore next -- load() already drops paused/changed queued runs; defensive guard */
    if (!rule || this.fp(rule) !== w.shape) return "drop";
    const why = this.cannot(rule);
    if (why) return why;
    const now = this.jobFor(w, rule);
    if ("refused" in now) {
      if (now.refused === "no_session") this.pause(rule, "unknown_level");
      return now.refused;
    }
    return JSON.stringify(now) === JSON.stringify(job) ? "ok" : "drop";
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
    const gone = () => this.stopped || running.done;
    handle = this.deps.run(job, {
      ready: () => {
        if (gone()) return false;
        let check: "ok" | "drop" | TriggerRefusal = "drop";
        try {
          check = this.stillSo(w, job);
        } catch (e) {
          this.deps.log(`trigger ${w.rule}: a look before its turn failed (${String(e)})`);
        }
        if (check === "ok") return true;
        over();
        if (check === "drop") {
          this.deps.log(`trigger ${w.rule}: its rule or its level is not what it was when the run was taken`);
          this.letGo(w);
        } else {
          this.deps.log(`trigger ${w.rule}: refused before its turn began (${check})`);
          this.end(w, check);
        }
        this.saved();
        return false;
      },
      queued: (why) => {
        if (gone()) return;
        // Handed over and waiting (the session's line, the headless slot): taken, under the
        // run's own deadline, refused for what it waits for when that passes.
        running.queued = true;
        w.reason = why;
        if (!w.told) this.tell(w.cause, { outcome: "taken" });
        w.told = true;
        // Its count is on disk from here, as a waiting run's is.
        this.saved();
      },
      began: (session) => {
        if (gone()) return;
        running.queued = false;
        running.began = true;
        entry = this.history(w.rule, line(this.deps.now(), "ran", { ...fields, session }));
        this.deps.log(`trigger ${w.rule}: ran in ${session}`);
        this.tell(w.cause, { outcome: "ran", session });
      },
      failed: (detail) => {
        if (this.stopped || !over()) return;
        this.deps.log(`trigger ${w.rule}: the run could not begin: ${detail}`);
        failed();
        this.retry();
      },
      refused: (code, detail) => {
        if (this.stopped || !over()) return;
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
        if (this.stopped || !over()) return;
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

  /** A notice's ack: only for a notice this machine received, and one final ack at most. */
  private tell(cause: Cause, r: NoticeResult): void {
    if (cause.kind !== "notice") return;
    const key = `${cause.receiver}\n${cause.notice.id}`;
    if (!this.heard.has(key) && !this.deps.received?.(cause.receiver, cause.notice.id)) return;
    if (r.outcome !== "taken") {
      if (this.finals.has(key)) return;
      this.finals.add(key);
      if (this.finals.size > 10_000) this.finals.delete(this.finals.values().next().value as string);
    }
    this.call("a notice's ack", () => this.deps.ack?.(cause.receiver, cause.notice.id, r));
  }

  private changed(): void {
    this.call("the hello", () => this.deps.changed?.());
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
    this.call("a history line", () => this.deps.noted?.(name, l));
    this.saved();
    return l;
  }

  /** Save the record, bounded; a disk that won't take it is said in the log. Runs handed over
   *  that are still queued (not yet begun) are written into `waiting` so a crash does not lose them. */
  private saved(): boolean {
    if (this.stopped) return false;
    const old = new Date(this.deps.now() - HISTORY_MS).toISOString();
    for (const st of Object.values(this.state.rules)) st.history = st.history.filter((l) => l.at >= old);
    const queued = [...this.running].filter((r) => r.queued && !r.began && !r.done).map((r) => r.w);
    const disk: TriggerState = queued.length
      ? { ...this.state, waiting: [...queued, ...this.state.waiting] }
      : this.state;
    // Written only when something changed: the clock comes round every half minute.
    const now = JSON.stringify(disk);
    if (now === this.lastSaved) return true;
    try {
      this.deps.save(disk);
      this.lastSaved = now;
      return true;
    } catch (e) {
      this.deps.log(`couldn't save the triggers' record: ${(e as Error).message}`);
      return false;
    }
  }

  // --- the runs that wait -----------------------------------------------------------

  /** Every run that waits gets another look, in the order they came: one past its time is
   *  refused (`held` or `start_limit`, by what it last waited for), and the folder, the
   *  harness and the session are checked again before it runs. */
  private retrying = false;
  retry(): void {
    // A run that ends inside a retry (a runner that answers at once) lets the next go then.
    if (this.retrying || this.stopped) return;
    this.retrying = true;
    let left: Waiting[] = [];
    try {
      this.expire();
      left = this.waits.splice(0);
      while (left.length) {
        const w = left[0] as Waiting;
        try {
          this.look(w);
        } catch (e) {
          // Its look threw: it waits on as it was, in its place, and its deadline still holds.
          this.unhand(w);
          if (!this.placed(w)) this.waits.push(w);
          this.deps.log(`trigger ${w.rule}: a look at a run that waits failed (${String(e)}); it waits on`);
        }
        left.shift();
      }
    } finally {
      // Whatever was not looked at (something threw past the look's own catch) waits on.
      for (const w of left) if (!this.placed(w)) this.waits.push(w);
      this.retrying = false;
      this.saved();
    }
  }

  private look(w: Waiting): void {
    const rule = this.live(w.rule);
    // Another rule under the same name meanwhile: this run was not its own. Nothing of it is
    // written under the new rule; a notice is acked as no rule took it.
    if (!rule || (w.shape !== undefined && w.shape !== this.fp(rule))) this.letGo(w);
    // Still waiting for what it waited for: kept as it is. Only a run that is let go is
    // checked again (steps 9 to 11).
    else if (this.blocked(w, rule)) this.waits.push(w);
    else {
      const why = this.cannot(rule);
      if (why) this.end(w, why);
      else this.attempt(w);
    }
  }

  /** Waiting runs past their deadline end now, refused for what they last waited for (`held`
   *  or `start_limit`), their counts given back: first, whatever else then happens. */
  expire(): void {
    if (this.stopped) return;
    const now = this.deps.now();
    for (const w of this.waits.filter((x) => now >= x.until)) {
      this.waits.splice(this.waits.indexOf(w), 1);
      this.end(w, w.reason === "busy" ? BUSY : w.reason);
    }
    // A run still queued for the headless slot at its deadline never began: it is let go.
    for (const x of [...this.running].filter((y) => y.queued && !y.began && !y.done && now >= y.w.until)) {
      x.done = true;
      this.running.delete(x);
      this.call("cancel", () => x.cancel());
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
    if (this.stopped) return;
    this.checks++;
    const now = this.deps.now();
    for (const r of this.rules())
      try {
        this.tick(r, now);
      } catch (e) {
        this.deps.log(`trigger ${r.name}: its clock could not be read (${String(e)}); the next look tries again`);
      }
    this.retry();
  }

  /** One clock rule at one look of the clock. */
  private tick(r: TriggerRule, now: number): void {
    if (isNoticeSource(r.source)) return;
    const st = this.ruleState(r.name);
    if (st.clock?.every !== r.source.every) st.clock = { every: r.source.every, since: now };
    const c = st.clock;
    if (r.paused) {
      c.since = now;
      delete c.last;
      return;
    }
    const every = parseEvery(r.source.every) as Every;
    const due = dueTick(every, this.zone, { now, after: c.last ?? c.since - 1, anchor: c.last ?? c.since });
    if (due === null) return;
    const was = c.last;
    c.last = due;
    // The tick is on disk before anything runs, or nothing runs: a restart would run it again.
    if (!this.saved()) {
      if (was === undefined) delete c.last;
      else c.last = was;
      this.deps.log(
        `trigger ${r.name}: its tick could not be recorded, so it does not run now; the next look tries again`,
      );
      return;
    }
    if (!this.file?.on) this.refuse(r.name, { kind: "tick", due }, "triggers_off");
    else if (now - due >= TICK_LATE_MS) {
      // Six hours late or more: a line in the history and nothing else (§14.6).
      this.history(r.name, line(now, "missed", {}));
      this.deps.log(`trigger ${r.name}: the tick of ${new Date(due).toISOString()} was missed`);
    } else this.fire(r.name, { kind: "tick", due });
  }

  /** The daemon stops: a run handed over whose turn has not begun (in its session's line, or for
   *  the headless slot) waits again, its count still held, so the next daemon takes it up as any
   *  waiting run (§14.7, *A waiting run outlives a restart*). */
  suspend(): void {
    const back: Waiting[] = [];
    for (const run of [...this.running])
      if (!run.began && !run.done) {
        run.done = true;
        this.running.delete(run);
        back.push(run.w);
        this.call("cancel", () => run.cancel());
      }
    this.waits.unshift(...back);
    if (!this.saved()) this.saved();
    // From here the engine is the next daemon's to take up: nothing more is done, said or saved.
    this.stopped = true;
  }

  // --- the person's resume of a machine's pause --------------------------------------

  /** `trigger resume` at the terminal, for a rule this machine paused: the pause is let go.
   *  It lifts only the machine's own pause, never the person's (the file's), so it widens
   *  nothing the person did not confirm there. */
  lift(name: string): boolean {
    if (this.stopped) return false;
    const st = this.state.rules[name];
    if (!st?.paused) return false;
    const said = JSON.stringify(this.hellos(this.file));
    delete st.paused;
    if (st.clock) st.clock = { every: st.clock.every, since: this.deps.now() };
    this.saved();
    this.deps.log(`trigger ${name}: resumed at the terminal; this computer's pause is let go`);
    if (JSON.stringify(this.hellos(this.file)) !== said) this.changed();
    return true;
  }
}
