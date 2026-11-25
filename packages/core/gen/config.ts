// SPDX-License-Identifier: Apache-2.0
// GENERATED from proto/sessionpipe/v1/*.proto by tools/doors; do not edit. `npm run schemas` rewrites it.
// The machine's own files' shapes as TypeScript (config.proto): never on the wire.

import type { ControlNotice, StartPermission, TriggerRefusal } from "./v1.js";

/** What became of a run of a rule: a notice or a clock tick the rule took (CONTROL.md §14). */
export type TriggerResult = "ran" | "refused" | "failed" | "missed" | "dropped";

/**
 * Why the machine itself paused a rule (CONTROL.md §14.7 step 11), kept in the daemon's state and
 * never in the rules file.
 */
export type TriggerPause = "gone" | "unknown_level";

/**
 * Which part of a rule a notice did not fit (`sessionpipe trigger test`). The machine's own
 * word, for the person at its terminal: never in an ack, which says `no_match` alone.
 */
export type TriggerMiss = "receiver" | "topic" | "event" | "state" | "for" | "by" | "subject" | "placeholder";

/** A rule's notices: one receiver the machine is paired with, and one topic. */
export interface NoticeSource {
  /**
   * The receiver, as the machine names it: the host (and port, when there is one) of the
   * address it was paired with, lowercase (`board.example`).
   */
  receiver: string;
  /** The topic, listed in the hello to that receiver and to no other. */
  topic: string;
  /** Only notices of this event; any event when absent. */
  event?: string | undefined;
}

/** A rule's clock: it runs with no receiver at all, in the machine's local time. */
export interface ClockSource {
  /**
   * `mon 09:00` to `sun 09:00` once a week, `day 08:30` every day, or an interval: `30m`, `2h`.
   * Beyond the pattern the reader checks an interval is 15 minutes to 7 days.
   */
  every: string;
}

/** When a rule runs, exactly one of: a receiver's notice on a topic, or a clock. */
export type TriggerSource = NoticeSource | ClockSource;

/** A new session of a harness this machine runs headlessly. */
export interface StartTarget {
  /** The harness (`claude-code`, `codex`). */
  start: string;
}

/** An existing session, continued with the rule's words. */
export interface ContinueTarget {
  /** The session, `<harness>:<id>`; the id follows its adapter's rule (Claude Code: a UUID). */
  continue: string;
}

/** What a rule runs, exactly one of: a new session, or an existing one continued. */
export type TriggerTarget = StartTarget | ContinueTarget;

/**
 * Which notices a rule takes beyond its source. Each list, when present, allows only its
 * values, and a notice without that field fits it not at all; an absent list allows any
 * value. A list is never empty. A filter is a limit, not a secret: a receiver that sends
 * notices can learn it from the acks (CONTROL.md §14.4).
 */
export interface TriggerWhen {
  /** The states it takes (`todo`). */
  state?: string[] | undefined;
  /** Whom the subject must be for (`studio-claude`). */
  for?: string[] | undefined;
  /**
   * Who must have made the change (`u-41c9`), in the receiver's word: it keeps a rule to the
   * people the person trusts on an honest receiver, and protects nothing against a receiver
   * that was broken into, which can name anyone.
   */
  by?: string[] | undefined;
}

/** How often a rule may run. */
export interface TriggerCap {
  /**
   * Runs a day at most, by the machine's local calendar. Every run counts, whether it then
   * works or fails.
   */
  per_day: number;
}

/**
 * One of the person's rules (CONTROL.md §14), made only at the machine's own terminal, shown in
 * plain words and confirmed there. No command and no notice makes, changes, pauses, resumes or
 * removes one.
 */
export interface TriggerRule {
  /** The rule's name: what `triggered_by` carries and the CLI names it by. */
  name: string;
  /** A paused rule runs nothing, and its topic leaves the hello. */
  paused: boolean;
  /** When it runs. */
  source: TriggerSource;
  /** A notice rule only: which notices it takes, beyond its source. */
  when?: TriggerWhen | undefined;
  /**
   * A notice rule only: the subjects it takes, in the safe pattern language of CONTROL.md
   * §14 (`^X-[0-9]{1,6}$`): anchored, no groups, no alternation, matched without
   * backtracking. The reader compiles it; one that doesn't compile is refused.
   */
  subject?: string | undefined;
  /** What it runs. */
  target: TriggerTarget;
  /**
   * The folder it runs in: absolute, or `~/…` under the daemon's user's home; never the home
   * folder itself, nor a folder that holds sessionpipe's config or state folders or lies inside
   * them (a session there could write itself a rule). Checked against the machine's allowlist
   * again at every run. Text a person reads before saying `yes`, so no character that does not
   * show: the pattern refuses every control character (C0, DEL, C1); the reader refuses the
   * rest by Unicode's categories (format, line and paragraph separators, private use,
   * unassigned, surrogates), which no pattern every reader runs can name.
   */
  folder: string;
  /**
   * The widest level it runs at. A run gets the narrowest of this, the source's ceiling (a
   * notice rule `edits` at most: the receiver holds other people's text), the machine's mode and,
   * continuing, the session's recorded level; then the widest level the harness takes here that
   * is no wider. When nothing fits, no run exists (CONTROL.md §14.7). A notice rule above
   * `edits` makes the file not fit; the reader checks that.
   */
  level: StartPermission;
  /**
   * MCP servers or tools (`mcp__board`, `mcp__board__records_get`) its runs may use without
   * asking, as `control.session_tools` (HTTP.md §1) are: never a built-in tool, never a
   * shell pattern. The pattern is the daemon's for `session_tools`, and so looser than the two
   * shapes: any `mcp__` name of letters, digits, `_` and `-`.
   */
  tools?: string[] | undefined;
  /** How often it may run. */
  cap: TriggerCap;
  /**
   * The person's words for the session. A notice rule's may name `{subject}`, `{state}`,
   * `{for}` and `{by}`, each filled with the notice's token in backticks; no other brace,
   * and a clock rule's none. What the person confirms is what the session gets, so no
   * character that does not show but tab and line feed: the pattern refuses every other
   * control character (C0 with carriage return, DEL, C1); the reader refuses the rest by
   * Unicode's categories, as for `folder`.
   */
  words: string;
}

/**
 * `<config>/triggers.json` (mode 0600), written by the CLI only and read by the daemon, as the
 * mode and the folders are. A file that doesn't fit is read as no rules and triggers off,
 * never guessed at.
 */
export interface TriggersFile {
  /** Always 1. */
  v: 1;
  /**
   * Whether triggers are on: the person's switch at the machine (`sessionpipe triggers on`).
   * Off until they turn it on.
   */
  on: boolean;
  /** The rules, in the order a notice is tried against them: the first that takes it runs. */
  rules: TriggerRule[];
}

/**
 * One line of a rule's history (`trigger list`): a run, a refusal, a failure, a missed tick or a
 * waiting run dropped. `code` comes with `refused` only.
 */
export interface TriggerHistoryLine {
  /** When. */
  at: string;
  /** What became of it. */
  result: TriggerResult;
  /** refused: why. */
  code?: TriggerRefusal | undefined;
  /** The notice's subject; absent for a clock tick. */
  subject?: string | undefined;
  /** The notice's state, when it had one. */
  state?: string | undefined;
  /** ran: the session, `<harness>:<id>`. */
  session?: string | undefined;
  /** ran: how long the run took, in milliseconds, once it ended. */
  ms?: number | undefined;
}

/** One rule as `sessionpipe trigger list --json` prints it. */
export interface TriggerListEntry {
  /** The rule, as the file has it. */
  rule: TriggerRule;
  /** Its runs today, against `cap.per_day`. */
  today: number;
  /** Its latest lines, newest first. */
  recent: TriggerHistoryLine[];
  /** When the machine paused it itself: why. Absent when it didn't. */
  machine_paused?: TriggerPause | undefined;
}

/** `sessionpipe trigger list --json`. */
export interface TriggerList {
  /** Whether triggers are on. A rules file that can't be read is off. */
  on: boolean;
  /** Every rule, in the file's order. */
  rules: TriggerListEntry[];
  /**
   * When the rules file can't be read: what is wrong with it, in the machine's words. Absent when
   * it reads, or is not there.
   */
  problem?: string | undefined;
}

/** What one run of a rule is, as the daemon would start it. */
export interface TriggerRun {
  /** A new session of a harness, or an existing one continued. */
  target: TriggerTarget;
  /** The folder. */
  folder: string;
  /**
   * The level: already the narrowest of the rule's, its source's ceiling, the machine's mode and,
   * continuing, the session's recorded level, then the widest the harness takes that is no wider.
   * A run whose level none of those leaves is not a run, and is never described by this message.
   */
  level: StartPermission;
  /** The MCP tools it may use without asking. */
  tools: string[];
  /** The words the session is given, framed and with the notice's tokens in backticks. */
  words: string;
}

/**
 * `sessionpipe trigger line <name> --json`: the one `sessionpipe trigger add` command that makes
 * the rule again, as a line and as its words.
 */
export interface TriggerLine {
  /**
   * The command, flags in their fixed order, each value one POSIX shell word (CONTROL.md §14.1,
   * conformance/triggers/trigger-line.json). One line, unless the words hold a line feed, which
   * stays inside their quotes.
   */
  line: string;
  /**
   * The words the line splits into, from `trigger` on (no `sessionpipe`): at least a clock rule's
   * fourteen (its words written `--words=<value>`), at most a rule with every flag's twenty-nine.
   */
  argv: string[];
}

/**
 * `sessionpipe trigger test <name> --json`: what a sample notice, or a tick, would run. It runs
 * nothing and records nothing.
 */
export interface TriggerTestAnswer {
  /** The rule's name. */
  rule: string;
  /** The sample notice; absent for a clock rule. */
  notice?: ControlNotice | undefined;
  /** Whether the rule takes it. */
  matches: boolean;
  /** When it doesn't: which part of the rule it does not fit. */
  miss?: TriggerMiss | undefined;
  /** A check that would refuse it now (triggers off, the cap, the folder), when one would. */
  refusal?: TriggerRefusal | undefined;
  /** When it matches: what would run. */
  run?: TriggerRun | undefined;
}
