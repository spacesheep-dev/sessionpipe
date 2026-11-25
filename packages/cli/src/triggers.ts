// SPDX-License-Identifier: Apache-2.0
// `sessionpipe triggers on|off|status` and `sessionpipe trigger add|list|pause|resume|remove|test`
// (spec/CONTROL.md §14.1): the person's rules, made at this computer's own terminal. The commands
// are written by hand as the others are (RFC 0001's step 3, the command surface in proto, is not
// built yet); every `--json` prints a message of config.proto (`TriggerList`,
// `TriggerTestAnswer`), checked against the schemas the definition generates before it is printed.
//
// Who may run what. "The mode, like the folders, is the person's choice at the machine's own
// terminal, and no command changes it" (CONTROL.md §2), and a rule is a standing order:
//   - `trigger add`, `trigger resume` and `triggers on` widen what this computer does by itself.
//     Each needs an interactive terminal, shows what will run in plain words (the level it will
//     really run at here, with why where that is narrower than the rule asks), and takes a typed
//     `yes`. No flag skips it.
//   - Every command that changes a rule or the switch refuses inside a harness session (the guard
//     `ask on` uses, and CLAUDECODE). `pause`, `remove` and `triggers off` only narrow, and need
//     no terminal, as `ask off` needs none.
//   - `list`, `status` and `test` change nothing and run anywhere.
// Both guards stop an honest session doing this by accident. Neither is proof that a person typed
// it: a pseudo-terminal passes the first, and a cleared environment the second.
import os from "node:os";
import path from "node:path";
import {
  acpControl,
  antigravityControl,
  CONFIG_SCHEMAS,
  type ControlNotice,
  checkTriggers,
  claudeControl,
  claudeDirs,
  codexControl,
  configFile,
  describeRule,
  drivableHarnesses,
  homeDir,
  isNoticeSource,
  isStart,
  type MachineMode,
  machineName,
  parseNotice,
  placeholdersIn,
  problems,
  RULE_NAME_RE,
  RULE_TEXT_MARK,
  readConfig,
  realFolderProblem,
  realPath,
  type StartPermission,
  sampleNotice,
  stateDir,
  type TriggerHistoryLine,
  type TriggerList,
  type TriggerMiss,
  type TriggerRefusal,
  type TriggerRule,
  type TriggersFile,
  type TriggerTestAnswer,
  testAnswer,
  tilde,
  triggerLevel,
  triggerPlaces,
  ulid,
  untilde,
  visible,
} from "@sessionpipe/core";
import { levelRank, parseSessionRef } from "@sessionpipe/core/control";
import { aliasFile, readAliases } from "./control/aliases.js";
import { localDay, type Zone, zoneOf } from "./control/clock.js";
import { ask, type LocalReply, type LocalRequest, socketPath } from "./control/local.js";
import { installService } from "./control/pair.js";
import { HEADLESS } from "./control/route.js";
import {
  harnessSession,
  type RulesRead,
  readRulesText,
  triggerStateFile,
  triggersFile,
  writeRules,
} from "./control/rules-file.js";
import {
  allowedIn,
  type ControlConfig,
  controlState,
  readControl,
  writeControl,
  writePrivate,
} from "./control/store.js";
import { readStateFile } from "./control/trigger-state.js";
import { type RuleState, stateOf, type TriggerState } from "./control/triggers.js";
import { Refusal } from "./refusal.js";
import { cliPath, stableNode } from "./runtime.js";
import { cols, commands, fold, mark, tint, type Ui } from "./style.js";
import { readWellKnown } from "./wellknown.js";

export const TRIGGER_HELP = `  sessionpipe triggers on | off | status [--json]   (whether this computer runs your rules)
  sessionpipe trigger add <name> (--on <receiver> --topic <t> [--event <e>] | --every "<when>")
      [--when state=<s> --when for=<who> --when by=<who>] [--subject '<pattern>']
      (--start <agent> | --continue <agent>:<id>) --folder <dir> [--level read|safe|edits|auto]
      [--tools mcp__<server>[__<tool>],…] [--cap <n>/day] --words "<text>"
  sessionpipe trigger list [--json] | pause <name> | resume <name> | remove <name>
  sessionpipe trigger test <name> [--subject X-001 --state todo --for <who> --by <who>] [--json]`;

/** What the commands reach beyond this process; tests stand in for each. */
export interface TriggerDeps {
  env: NodeJS.ProcessEnv;
  /** The person is at a terminal: this command's input and output are both one. */
  interactive: () => boolean;
  /** Ask the person, and give back what they typed. */
  confirm: (question: string) => Promise<string>;
  /** The agents this computer runs headlessly (core's drivableHarnesses). */
  harnesses: () => string[];
  /** One request to the background service; null when none answers. */
  local: (req: LocalRequest, ms: number) => Promise<LocalReply | null>;
  /** A receiver's well-known file; throws with a sentence when it can't be read. */
  wellKnown: (url: string) => Promise<{ control?: { notices?: boolean } }>;
  /** The session `<harness>:<id>` is on this computer. */
  sessionThere: (ref: string) => boolean;
  /** The folder a session on this computer runs in; null when it is not here. */
  sessionFolder: (ref: string) => string | null;
  /** Write and start the background service; what it did, in words. */
  installService: () => string;
  now: () => number;
  /** The time zone a rule's day is read in; the machine's own when unsaid. */
  zone?: string;
}

/** Where the lines go: `say` a line set for this terminal, `print` one for a program. */
export interface TriggerOut {
  ui: Ui;
  say: (line?: string) => void;
  print: (line: string) => void;
}

export function defaultTriggerDeps(distDir: string, env: NodeJS.ProcessEnv = process.env): TriggerDeps {
  return {
    env,
    /* v8 ignore start -- the terminal itself: tests stand in for it */
    interactive: () => !!process.stdin.isTTY && !!process.stdout.isTTY,
    confirm: (q) => readLine(q),
    /* v8 ignore stop */
    harnesses: () => drivableHarnesses(env),
    local: (req, ms) => ask(socketPath(stateDir(env), env), req, ms),
    wellKnown: (url) => readWellKnown(url, 3000) as Promise<{ control?: { notices?: boolean } }>,
    sessionThere: (ref) => sessionThere(ref, env),
    sessionFolder: (ref) => sessionFolder(ref, env),
    /* v8 ignore next -- writes and starts this computer's real service: tests stand in for it */
    installService: () => installService({ node: stableNode(process.execPath), cli: cliPath(distDir), env }),
    now: Date.now,
  };
}

/* v8 ignore start -- the terminal itself: tests stand in for it (TriggerDeps.confirm) */
/** One line typed at the terminal. */
function readLine(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    let got = "";
    const onData = (d: Buffer) => {
      got += d.toString("utf8");
      const nl = got.indexOf("\n");
      if (nl < 0) return;
      process.stdin.off("data", onData);
      process.stdin.pause();
      resolve(got.slice(0, nl));
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}
/* v8 ignore stop */

/** Whether a session is on this computer: Claude Code's transcript; a Codex rollout; or a
 *  session the background service started and named (aliases.json). */
export function sessionThere(ref: string, env: NodeJS.ProcessEnv): boolean {
  return sessionFolder(ref, env) !== null;
}

/** The folder a session runs in, as the machine records it (the background service's start,
 *  Claude Code's transcript, a Codex rollout); null when the session is not on this computer.
 *  A rule that continues a session runs there, so that is the rule's folder (CONTROL.md §14.1). */
export function sessionFolder(ref: string, env: NodeJS.ProcessEnv): string | null {
  const r = parseSessionRef(ref);
  if (!r) return null;
  const aliases = readAliases(aliasFile(controlState(env)));
  if (Object.hasOwn(aliases, ref)) return (aliases[ref] as { cwd: string }).cwd;
  if (r.harness === "claude-code") {
    const t = claudeControl.findTranscript(r.id, claudeDirs(env));
    return t ? (claudeControl.sessionFolder(t) ?? null) : null;
  }
  if (r.harness === "codex") {
    const f = codexControl.findRollout(r.id, env);
    return f ? (codexControl.codexFacts(f).cwd ?? null) : null;
  }
  return null;
}

// --- words --------------------------------------------------------------------------------

const LABEL = new Map([
  ["claude-code", "Claude Code"],
  ["codex", "Codex"],
  ["antigravity", "Antigravity"],
]);
const label = (h: string): string => LABEL.get(h) ?? h;

/** The escapes `visible` writes, marked so they can't be mistaken for typed text. */
const marked = (ui: Ui, s: string): string => s.replace(/\\(?:t|n|r|u\{[0-9a-fA-F]+\})/g, (e) => tint(ui, "yellow", e));
/** Text from a rule or a notice, as a person reads it: every character that does not show
 *  written out (core's `visible`), and marked. */
const shown = (ui: Ui, s: string): string => marked(ui, visible(s));

/** The widest level this computer's mode lets a rule run at (CONTROL.md §2). */
const ceiling = (mode: MachineMode): StartPermission => (mode === "auto" ? "auto" : "safe");

/** The levels each harness takes on this machine: the background service's own word (its
 *  hello's `start`), else what Codex and Antigravity take by the mode. Claude Code's depend on
 *  what its `claude --help` lists, which only the service reads: unsaid, not narrowed here. */
export type Offered = Record<string, readonly StartPermission[] | undefined>;
async function offeredHere(d: TriggerDeps, mode: MachineMode): Promise<Offered> {
  const r = await d.local({ op: "status" }, 2000);
  const start =
    r?.op === "status" ? (r.status as { start?: Record<string, { permissions: StartPermission[] }> }).start : undefined;
  if (start) return Object.fromEntries(Object.entries(start).map(([h, e]) => [h, e.permissions]));
  return { codex: codexControl.offeredLevels(mode), antigravity: antigravityControl.offeredLevels(mode) };
}

/** The level a rule runs at on this computer (the definition's `triggerLevel`), and why, when
 *  that is narrower than the rule asks; null when the harness takes no level so narrow. */
export function levelHere(
  rule: TriggerRule,
  mode: MachineMode,
  offered: Offered,
): { level: StartPermission | null; why: string | null } {
  const harness = targetHarness(rule);
  const levels = Object.hasOwn(offered, harness) ? offered[harness] : undefined;
  const level = triggerLevel(rule, mode, levels ? { offered: levels } : {});
  if (level === rule.level) return { level, why: null };
  const bySource = triggerLevel(rule, "auto");
  const byMode = triggerLevel(rule, mode);
  return {
    level,
    why:
      bySource !== rule.level
        ? `a rule a notice runs is ${bySource} at most`
        : byMode !== rule.level
          ? `this computer's mode is ${mode}`
          : `${label(harness)} has no ${rule.level} level here`,
  };
}

/** What a level lets that agent do, where it is not plain from the word. */
export function levelMeans(harness: string, level: StartPermission, folder: string): string {
  const where = visible(folder);
  if (harness === "codex")
    return {
      read: "Codex reads and plans in its read-only sandbox, and changes nothing.",
      safe: `Codex's safe is its workspace sandbox: it writes files in ${where}, with no network.`,
      edits: `Codex's edits is its workspace sandbox: it writes files in ${where}, with no network.`,
      auto: "Codex's automatic review decides what it runs.",
    }[level];
  if (harness === "claude-code")
    return {
      read: "Claude Code reads and plans, and changes nothing.",
      safe: "Claude Code does only what the folder's own settings allow; anything that would ask is denied.",
      edits: `Claude Code edits files in ${where}; a command that would ask is denied.`,
      auto: "Claude Code's auto mode decides what it runs.",
    }[level];
  return `${label(harness)} runs at its own ${level} level.`;
}

const targetHarness = (r: TriggerRule): string =>
  isStart(r.target) ? r.target.start : (parseSessionRef(r.target.continue)?.harness as string);
const short = (ref: string): string => {
  const i = ref.indexOf(":");
  return `${ref.slice(0, i)}:${ref.slice(i + 1, i + 9)}`;
};

/** A rule in a line: where it comes from, what it runs at which level here, and today's count. */
function ruleSummary(ui: Ui, r: TriggerRule, mode: MachineMode, offered: Offered, today: number): string {
  const s = r.source;
  const filters = [
    ...(["state", "for", "by"] as const).flatMap((k) => (r.when?.[k] ? [`${k}=${r.when[k].join(",")}`] : [])),
    ...(r.subject !== undefined ? [`subject ${r.subject}`] : []),
  ];
  const from = isNoticeSource(s)
    ? [s.receiver, s.topic, ...(s.event ? [s.event] : []), ...filters].join(" ")
    : `every ${s.every}`;
  const what = isStart(r.target) ? r.target.start : `continue ${short(r.target.continue)}`;
  const { level, why } = levelHere(r, mode, offered);
  const lvl =
    level === null
      ? tint(ui, "red", `no level ${label(targetHarness(r))} takes here`)
      : why
        ? `${tint(ui, "yellow", level)} (asks ${r.level})`
        : level;
  return `${shown(ui, from)} → ${what} ${lvl} · ${today}/${r.cap.per_day} today`;
}

/** A history line's refusal, in words. */
const REFUSED: Record<TriggerRefusal, (l: TriggerHistoryLine, r: TriggerRule) => string> = {
  cooldown: (l) => `ran for ${l.subject}/${l.state ?? "no state"} today`,
  cap: (_l, r) => `it ran its ${r.cap.per_day} time${r.cap.per_day === 1 ? "" : "s"} today`,
  folder: () =>
    "the background service doesn't allow its folder now: it checks with its own settings (CLAUDE_CONFIG_DIR, CODEX_HOME), which can differ from your shell's",
  harness: (_l, r) => `${label(targetHarness(r))} can't run headlessly here now`,
  no_session: () => "the session it continues is gone",
  held: () => "a window held the session for as long as it could wait",
  start_limit: () => "this computer's caps on new sessions stayed reached for as long as it could wait",
  triggers_off: () => "triggers were off",
  bad_notice: () => "a broken notice",
  busy: () => "its own earlier run was still going for as long as this one could wait",
};

/** A refusal's words; a code this version doesn't know (a newer one's) is said as that. */
const refusedWords = (l: TriggerHistoryLine, r: TriggerRule): string =>
  typeof l.code === "string" && Object.hasOwn(REFUSED, l.code)
    ? REFUSED[l.code as TriggerRefusal](l, r)
    : `a reason this version doesn't know (${visible(String(l.code))})`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** When, as a person reads it in this computer's time: the time today, else the day and the time. */
function when(iso: string, now: number, zone: Zone): string {
  const local = (t: number) => new Date(t + zone.offset(t) * 60_000);
  const d = local(Date.parse(iso));
  const hm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  return d.toISOString().slice(0, 10) === local(now).toISOString().slice(0, 10)
    ? hm
    : `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${hm}`;
}

const span = (ms: number): string =>
  ms < 90_000
    ? `${Math.round(ms / 1000)} s`
    : ms < 90 * 60_000
      ? `${Math.round(ms / 60_000)} min`
      : `${Math.round(ms / 3600_000)} h`;

/** A history line: when, and what became of it. */
function historyLine(ui: Ui, l: TriggerHistoryLine, r: TriggerRule, now: number, zone: Zone): [string, string] {
  const subject = l.subject ? `${visible(l.subject)} ` : "";
  const what =
    l.result === "missed"
      ? `${tint(ui, "yellow", "missed")}: this computer was asleep or off until six hours after its time`
      : l.result === "ran"
        ? `${subject}→ ${l.session ? visible(short(l.session)) : "a new session"}${l.ms !== undefined ? ` · ${span(l.ms)}` : " · running"}`
        : l.result === "failed"
          ? `${subject}${tint(ui, "red", "couldn't start")}`
          : `${subject}${tint(ui, "yellow", "refused")}: ${refusedWords(l, r)}`;
  return [tint(ui, "dim", when(l.at, now, zone).padStart(5)), what];
}

// --- what is on disk -------------------------------------------------------------------------

/** The daemon's record of the rules' runs, as the CLI reads it (it writes it only to let go of a
 *  pause when no daemon is running to do it). */
export function readRecord(env: NodeJS.ProcessEnv): TriggerState {
  return stateOf(readStateFile(triggerStateFile(env)));
}

/** A rule's runs today, by the daemon's record. */
const todayOf = (st: RuleState | undefined, day: string): NonNullable<RuleState["today"]> =>
  st?.today?.day === day ? st.today : { day, runs: 0, keys: [] };

interface Here {
  read: RulesRead;
  /** The file's exact text as read (null: not there): a change after it is never written over. */
  text: string | null;
  file: TriggersFile | null;
  mode: MachineMode;
  offered: Offered;
  record: TriggerState;
  day: string;
}
async function here(d: TriggerDeps): Promise<Here> {
  const { read, text } = readRulesText(d.env);
  const mode = readControl(d.env)?.mode ?? "safe";
  return {
    read,
    text,
    file: read.state === "ok" ? read.file : null,
    mode,
    offered: await offeredHere(d, mode),
    record: readRecord(d.env),
    day: localDay(zoneOf(d.zone), d.now()),
  };
}

/** The file to change: refused when it can't be read, rather than written over. */
function editable(h: Here, d: TriggerDeps): TriggersFile {
  if (h.read.state === "refused")
    throw new Refusal(
      `the rules file can't be read (${said(h.read.problems[0] as string)}), so triggers are off and nothing in it runs. Fix it, or move it away and add the rules again: ${tilde(triggersFile(d.env), homeDir())}`,
      "",
    );
  return h.file ?? { v: 1, on: false, rules: [] };
}

function ruleOf(f: TriggersFile, name: string | undefined, verb: string): TriggerRule {
  if (!name) throw new Refusal(`which rule? \`sessionpipe trigger ${verb} <name>\``, "sessionpipe trigger list");
  const r = f.rules.find((x) => x.name === name);
  if (!r) throw new Refusal(`there is no rule named ${visible(name)} on this computer`, "sessionpipe trigger list");
  return r;
}

/** A problem in sessionpipe's own words, which may quote a value: every character in it that
 *  doesn't show as itself written out, one at a time, so an escape the problem already wrote
 *  (`shown as \u{a0}`) is not written out twice. */
const said = (problem: string): string => [...problem].map((c) => visible(c)).join("");

/** The person's command, refused inside a harness session (CONTROL.md §14.1). */
function personOnly(d: TriggerDeps, what: string): void {
  const v = harnessSession(d.env);
  if (v)
    throw new Refusal(
      `this runs inside a coding session (${v} is set). ${what} is the person's to do at this computer's own terminal, so nothing was changed: ask them to run it there`,
      "",
    );
}

/** After the `yes`: the file is still exactly what was shown, or nothing is written. */
function unchanged(h: Here, d: TriggerDeps, o: TriggerOut): boolean {
  if (readRulesText(d.env).text === h.text) return true;
  say(
    o,
    `  ${mark(o.ui, "warn")} `,
    "The rules changed while you were reading. Nothing was written. Run the command again.",
  );
  return false;
}

/** At the terminal, with a `yes`: no flag skips it. */
function atTerminal(d: TriggerDeps, what: string): void {
  if (!d.interactive())
    throw new Refusal(
      `${what} needs this computer's own terminal, where you can read what will run and type yes; run it there`,
      "",
    );
}
async function confirmed(d: TriggerDeps, o: TriggerOut, what: string, question: string): Promise<boolean> {
  atTerminal(d, what);
  const typed = (await d.confirm(`  ${question} `)).trim().toLowerCase();
  if (typed === "yes") return true;
  o.say(`  ${mark(o.ui, "info")} Nothing changed.`);
  return false;
}

const say = (o: TriggerOut, first: string, body: string, hang?: number) => {
  for (const l of fold(o.ui, first, body, hang)) o.say(commands(o.ui, l));
};
/** The person's words, or a sentence that holds them: folded, and nothing in them coloured as a
 *  command (a token in backticks is the notice's, not something to run). */
const sayWords = (o: TriggerOut, first: string, body: string, then?: string) => {
  const hang = cols(first);
  // In a block of words each line keeps its bar (`then`, as wide as `first`), a folded one too.
  for (const [i, l] of fold(o.ui, first, body).entries()) o.say(then && i ? then + l.slice(hang) : l);
};

// --- the JSON --------------------------------------------------------------------------------

/** The JSON of a definition's message (config.proto, its schema generated), printed only once
 *  it fits. */
export function printJson(
  o: TriggerOut,
  name: "trigger-list" | "trigger-test",
  value: TriggerList | TriggerTestAnswer,
): void {
  const bad = problems(CONFIG_SCHEMAS[name] as never, value);
  if (bad.length) throw new Error(`the JSON would not fit its definition: ${said(bad[0] as string)}`);
  o.print(JSON.stringify(value, null, 2));
}
/** A history line as the definition has it: a newer sessionpipe's code is left out of the JSON
 *  (the list says it as a reason this version doesn't know). */
const LINE = (CONFIG_SCHEMAS["trigger-list"].properties.rules.items.properties.recent as unknown as { items: object })
  .items;

function listOf(h: Here): TriggerList {
  return {
    on: !!h.file?.on,
    rules: (h.file?.rules ?? []).map((rule) => {
      const st = h.record.rules[rule.name];
      return {
        rule,
        ...(st?.paused ? { machine_paused: st.paused.why ?? "gone" } : {}),
        today: todayOf(st, h.day).runs,
        recent: (st?.history ?? []).filter((l) => !problems(LINE as never, l).length).slice(0, 20),
      };
    }),
  };
}

// --- the commands ------------------------------------------------------------------------------

const VALUED = new Set([
  "--on",
  "--topic",
  "--event",
  "--every",
  "--when",
  "--subject",
  "--start",
  "--continue",
  "--folder",
  "--level",
  "--tools",
  "--cap",
  "--words",
  "--state",
  "--for",
  "--by",
]);
const SWITCHES = new Set(["--json", "--no-service"]);

interface Parsed {
  words: string[];
  flags: Map<string, string[]>;
}
function parse(argv: string[]): Parsed {
  const words: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (VALUED.has(a)) {
      const v = argv[++i];
      if (v === undefined) throw new Refusal(`${a} needs a value`, "sessionpipe trigger --help");
      flags.set(a, [...(flags.get(a) ?? []), v]);
    } else if (SWITCHES.has(a)) flags.set(a, ["yes"]);
    else if (a.startsWith("--")) throw new Refusal(`unknown option ${visible(a)}`, "sessionpipe trigger --help");
    else words.push(a);
  }
  return { words, flags };
}
const one = (p: Parsed, f: string): string | undefined => p.flags.get(f)?.at(-1);

/** `argv` starts with `triggers` or `trigger`. */
export async function triggerMain(argv: string[], o: TriggerOut, d: TriggerDeps): Promise<void> {
  const p = parse(argv.slice(1));
  const sub = p.words[0];
  if (argv[0] === "triggers")
    switch (sub) {
      case "on":
        return on(p, o, d);
      case "off":
        return off(o, d);
      case "status":
      case undefined:
        return status(p, o, d);
      default:
        throw new Refusal(`triggers takes on, off or status`, "sessionpipe triggers --help");
    }
  switch (sub) {
    case "add":
      return add(p, o, d);
    case "list":
    case undefined:
      return list(p, o, d);
    case "pause":
    case "remove":
      return narrow(sub, p.words[1], o, d);
    case "resume":
      return resume(p.words[1], o, d);
    case "test":
      return test(p, o, d);
    default:
      throw new Refusal(`trigger takes add, list, pause, resume, remove or test`, "sessionpipe trigger --help");
  }
}

/** describeRule's lines, whole: the sentence, then the folder and the words, each on lines of
 *  their own under a dim bar (a folded line keeps it). The text is the definition's, which writes
 *  out what does not show: its escapes are marked, never escaped twice. */
function sayRule(o: TriggerOut, r: TriggerRule): void {
  // The definition cuts every line to the width itself, the sentence included (a cut line of the
  // words keeps its mark), so nothing here wraps them again: each is marked and printed as it comes.
  const width = o.ui.width === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : o.ui.width - 2;
  for (const l of describeRule(r, { width }).lines)
    o.say(`  ${marked(o.ui, l).replace(/ ([│┆]) /, (_m, bar: string) => ` ${tint(o.ui, "dim", bar)} `)}`);
}

/** A rule in plain words, as `add` and `resume` show it before they ask. */
function showRule(o: TriggerOut, r: TriggerRule, h: Here, machine: string): void {
  sayRule(o, r);
  o.say("");
  const { level, why } = levelHere(r, h.mode, h.offered);
  const harness = targetHarness(r);
  if (level === null)
    throw new Refusal(
      `${label(harness)} takes no level as narrow as ${r.level} on this computer, so the rule could never run`,
      "",
    );
  say(
    o,
    `  ${mark(o.ui, why ? "warn" : "info")} `,
    why
      ? `On ${machine} it runs at ${tint(o.ui, "bold", level)}: it asks for ${r.level}, and ${why}, so it will run at ${level}.`
      : `On ${machine} it runs at ${tint(o.ui, "bold", level)}.`,
  );
  say(o, "    ", levelMeans(harness, level, r.folder));
  if (!isStart(r.target)) say(o, "    ", "If that session was started at a narrower level, it runs at that one.");
}

async function add(p: Parsed, o: TriggerOut, d: TriggerDeps): Promise<void> {
  personOnly(d, "Adding a rule");
  const name = p.words[1];
  if (!name || p.words.length > 2)
    throw new Refusal("`trigger add` takes the rule's name, then its options", "sessionpipe trigger add --help");
  if (!RULE_NAME_RE.test(name))
    throw new Refusal(
      `${visible(name)} can't be a rule's name: lowercase letters, digits, - and _, up to 40, starting with a letter or digit`,
      "",
    );
  const h = await here(d);
  const f = editable(h, d);
  if (f.rules.some((r) => r.name === name))
    throw new Refusal(
      `there is a rule named ${name} already: remove it first, or pick another name`,
      "sessionpipe trigger list",
    );
  const control = readControl(d.env);
  const home = homeDir();
  const warn: string[] = [];
  const notes: string[] = [];

  // Where it comes from: a receiver's notices on a topic, or a clock.
  const receiverName = one(p, "--on");
  const every = one(p, "--every");
  if (!!receiverName === !!every)
    throw new Refusal(
      'a rule runs on a receiver\'s notices (--on <receiver> --topic <t>) or on a clock (--every "mon 09:00"): one of the two',
      "sessionpipe trigger add --help",
    );
  let source: TriggerRule["source"];
  let pairedUrl: string | null = null;
  if (receiverName) {
    const topic = one(p, "--topic");
    if (!topic)
      throw new Refusal(
        "a rule on a receiver's notices names their topic: --topic <topic>",
        "sessionpipe trigger add --help",
      );
    const host = hostOf(receiverName);
    const paired = (control?.receivers ?? []).filter((r) => hostOf(r.url) === host);
    if (!paired.length)
      throw new Refusal(
        `this computer isn't paired with ${visible(host ?? receiverName)}: a rule takes notices only from a receiver it is paired with`,
        `sessionpipe control pair ${host ?? receiverName}`,
      );
    if (paired.length > 1)
      throw new Refusal(
        `${host} names ${paired.length} pairings on this computer, so a notice could not be told apart: remove the one you don't use`,
        "sessionpipe control status",
      );
    pairedUrl = (paired[0] as { url: string }).url;
    const event = one(p, "--event");
    source = { receiver: host as string, topic, ...(event ? { event } : {}) };
  } else {
    for (const f2 of ["--topic", "--event", "--when", "--subject"])
      if (p.flags.has(f2))
        throw new Refusal(
          `a clock rule has no notice to filter: ${f2} goes with --on`,
          "sessionpipe trigger add --help",
        );
    source = { every: every as string };
  }

  // What it runs.
  const start = one(p, "--start");
  const cont = one(p, "--continue");
  if (!!start === !!cont)
    throw new Refusal(
      "a rule starts a new session (--start <agent>) or continues one (--continue <agent>:<id>): one of the two",
      "sessionpipe trigger add --help",
    );
  const target: TriggerRule["target"] = start ? { start } : { continue: cont as string };
  const harness = (start ?? parseSessionRef(cont as string)?.harness ?? (cont as string).split(":")[0]) as string;

  // Its folder. A rule that continues a session runs in that session's own folder: that IS the
  // rule's folder (§14.1), shown on the folder line and written, and another is refused.
  let given = one(p, "--folder");
  if (cont) {
    const there = d.sessionFolder(cont);
    if (there === null)
      throw new Refusal(
        `there is no ${label(harness)} session ${visible(short(cont))} on this computer: a rule continues a session that is here`,
        "",
      );
    if (given !== undefined && realPath(path.resolve(untilde(given, home))) !== realPath(there))
      throw new Refusal(
        `that session runs in ${visible(tilde(there, home))}, and a rule that continues a session runs in the session's own folder: leave --folder out, or name ${visible(tilde(there, home))}`,
        "",
      );
    given = there;
  }
  if (!given) throw new Refusal("a rule names the folder it runs in: --folder <dir>", "sessionpipe trigger add --help");
  const abs = path.resolve(untilde(given, home));
  const folder = tilde(abs, home);
  // The definition's floor (§14.1), on real paths as the background service checks it at every
  // run: never the home folder or one that holds it, sessionpipe's own folders, a harness's own,
  // a dot-folder in the home folder, ~/Library; a link into one of them is caught for what it is.
  const placed = realFolderProblem(folder, triggerPlaces(d.env));
  if (placed) throw new Refusal(`${visible(folder)}: ${placed}`, "");
  if (!allowedIn(abs, control?.folders ?? []))
    throw new Refusal(
      `${visible(folder)} isn't a folder this computer lets sessions run in, so the rule could never run`,
      `sessionpipe control folders add ${folder}`,
    );

  const level = (one(p, "--level") ?? "safe") as StartPermission;
  if (!p.flags.has("--level")) notes.push("No --level, so it is written as safe.");
  const capText = one(p, "--cap");
  const cap = capText === undefined ? 5 : Number(/^(\d{1,2})(?:\/day)?$/.exec(capText)?.[1] ?? Number.NaN);
  if (!Number.isInteger(cap) || cap < 1 || cap > 50)
    throw new Refusal(`--cap is a number of runs a day, 1 to 50: --cap 5/day`, "sessionpipe trigger add --help");
  if (capText === undefined) notes.push("No --cap, so it is written as 5 runs a day at most.");
  const tools = one(p, "--tools")
    ?.split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const words = one(p, "--words");
  if (words === undefined)
    throw new Refusal('a rule names its words for the session: --words "<text>"', "sessionpipe trigger add --help");

  const when: NonNullable<TriggerRule["when"]> = {};
  for (const w of p.flags.get("--when") ?? []) {
    const m = /^(state|for|by)=(.+)$/.exec(w);
    if (!m)
      throw new Refusal(
        `--when is state=<s>, for=<who> or by=<who>, not ${visible(w)}`,
        "sessionpipe trigger add --help",
      );
    const k = m[1] as keyof typeof when;
    when[k] = [...new Set([...(when[k] ?? []), ...(m[2] as string).split(",")])];
  }
  const subject = one(p, "--subject");
  const rule: TriggerRule = {
    name,
    paused: false,
    source,
    ...(Object.keys(when).length ? { when } : {}),
    ...(subject !== undefined ? { subject } : {}),
    target,
    folder,
    level,
    ...(tools?.length ? { tools } : {}),
    cap: { per_day: cap },
    words,
  };
  // Read back as the daemon will read it: a rule the file would refuse is refused here.
  const next: TriggersFile = { ...f, rules: [...f.rules, rule] };
  const bad = checkWhole(next, d.env);
  if (bad) throw new Refusal(`the rule can't be written: ${bad}`, "sessionpipe trigger add --help");

  // What a run would check (§14.7): the agent here, the session to continue.
  const runs = d.harnesses().filter((x) => HEADLESS.has(x));
  if (acpControl.acpAgent(harness))
    throw new Refusal(
      `a rule can't run ${harness} yet: it takes no level here and would run at this computer's mode, not the rule's`,
      "",
    );
  if (!runs.includes(harness))
    throw new Refusal(
      `${label(harness)} can't run headlessly on this computer${runs.length ? `; these can: ${runs.join(", ")}` : ""}`,
      "",
    );

  // What would make it never run, said before it is confirmed.
  for (const fld of placeholdersIn(words) as string[])
    if (fld !== "subject" && !when[fld as "state"])
      warn.push(
        `The words name {${fld}}, and the rule doesn't require one (--when ${fld}=…): a notice without a ${fld} never matches it.`,
      );
  if (pairedUrl) {
    try {
      const wk = await d.wellKnown(pairedUrl);
      if (wk.control?.notices !== true)
        warn.push(
          `${hostOf(pairedUrl)} doesn't say it sends notices (control.notices in its well-known file), so this rule will never run until it does.`,
        );
    } catch (e) {
      warn.push(
        // Never the other side's own text (an error's words carry bytes of the body): ours.
        `${hostOf(pairedUrl)}'s well-known file couldn't be read now, so whether it sends notices isn't known.`,
      );
    }
  }

  // A folder on the allowlist means control.json is there, and names this computer.
  const machine = (control as ControlConfig).name;
  if (!isNoticeSource(rule.source) && (await d.local({ op: "status" }, 2000))?.op !== "status")
    notes.push(
      "A clock rule's first tick is the first after the background service has seen it, and it isn't running now: `sessionpipe triggers on` installs it.",
    );
  o.say(`  ${tint(o.ui, "bold", "Add this rule?")}`);
  o.say("");
  showRule(o, rule, h, machine);
  for (const n of notes) say(o, `  ${mark(o.ui, "info")} `, n);
  for (const w of warn) say(o, `  ${mark(o.ui, "warn")} `, w);
  o.say("");
  if (!(await confirmed(d, o, "Adding a rule", "Type yes to add it, anything else to stop:"))) return;
  if (!unchanged(h, d, o)) return;
  writeRules(next, d.env);
  say(
    o,
    `  ${mark(o.ui, "ok")} `,
    next.on
      ? `Added ${name}. The background service reads it within seconds.`
      : `Added ${name}. Triggers are off, so it runs once you turn them on: \`sessionpipe triggers on\`.`,
  );
}

/** The first problem with a rules file, in the person's words, or null: the reader's own check,
 *  so a rule the daemon would refuse is refused here. */
function checkWhole(f: TriggersFile, env: NodeJS.ProcessEnv): string | null {
  const v = checkTriggers(f, triggerPlaces(env));
  return v.ok ? null : said(v.problems[0] as string).replace(/^\$\.rules\[\d+\](?: \([^)]*\))?: /, "");
}

/** The receiver's name as a rule says it: the host (and port, when not the default) of its
 *  address, lowercase. A bracketed IPv6 address is no name a rule takes. */
export function hostOf(s: string): string | null {
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
    const host = u.host.toLowerCase();
    return host.startsWith("[") ? null : host;
  } catch {
    return null;
  }
}

async function list(p: Parsed, o: TriggerOut, d: TriggerDeps): Promise<void> {
  const h = await here(d);
  if (p.flags.has("--json")) return printJson(o, "trigger-list", listOf(h));
  headline(o, h, d);
  rulesBlock(o, h, d);
}

function headline(o: TriggerOut, h: Here, d: TriggerDeps): void {
  if (h.read.state === "refused") {
    say(
      o,
      `${mark(o.ui, "bad")} `,
      `${tint(o.ui, "bold", "Triggers are off")}: the rules file can't be read (${said(h.read.problems[0] as string)}), and nothing in it runs. Fix it, or move it away and add the rules again: ${tilde(triggersFile(d.env), homeDir())}`,
    );
    return;
  }
  const rules = h.file?.rules ?? [];
  const paused = rules.filter((r) => r.paused || h.record.rules[r.name]?.paused).length;
  const count = `${rules.length} rule${rules.length === 1 ? "" : "s"}${paused ? `, ${paused} paused` : ""}`;
  if (h.file?.on)
    say(o, `${mark(o.ui, "ok")} `, `${tint(o.ui, "bold", tint(o.ui, "green", "Triggers are on"))} · ${count}`);
  else
    say(
      o,
      `${mark(o.ui, "info")} `,
      `${tint(o.ui, "bold", "Triggers are off")} · ${count} · \`sessionpipe triggers on\` turns them on`,
    );
}

function rulesBlock(o: TriggerOut, h: Here, d: TriggerDeps): void {
  const rules = h.file?.rules ?? [];
  if (h.read.state === "refused") return;
  if (!rules.length) {
    o.say("");
    say(o, "  ", "No rules yet. One that runs Codex every Monday morning:");
    // The command whole, on lines a shell takes as one: a fold never lands inside it.
    for (const l of [
      'sessionpipe trigger add weekly --every "mon 09:00" \\',
      '  --start codex --folder ~/work/sales --words "…"',
    ])
      o.say(`    ${tint(o.ui, "cyan", l)}`);
    say(o, "  ", "`sessionpipe trigger add --help` has every option.");
    return;
  }
  const now = d.now();
  let narrowed = false;
  for (const r of rules) {
    const st = h.record.rules[r.name];
    const machinePaused = !!st?.paused;
    const m = machinePaused ? "warn" : r.paused || !h.file?.on ? "info" : "ok";
    o.say("");
    const pausedWord = machinePaused
      ? st?.paused?.why === "unknown_level"
        ? ` · ${tint(o.ui, "yellow", "paused by this computer")}: the session it continues was started at a level this computer doesn't know. \`trigger resume\` won't clear that: point the rule at another session (remove it and add it again)`
        : ` · ${tint(o.ui, "yellow", "paused by this computer")}: the session it continues is gone. \`sessionpipe trigger resume ${r.name}\` once it is back, or remove the rule`
      : r.paused
        ? ` · ${tint(o.ui, "yellow", "paused")}`
        : "";
    say(
      o,
      `${mark(o.ui, m)} ${tint(o.ui, "bold", r.name)}  `,
      `${ruleSummary(o.ui, r, h.mode, h.offered, todayOf(st, h.day).runs)}${pausedWord}`,
    );
    if (levelHere(r, h.mode, h.offered).why) narrowed = true;
    const lines = (st?.history ?? []).slice(0, 5);
    if (!lines.length) o.say(`    ${tint(o.ui, "dim", "nothing yet")}`);
    for (const l of lines) {
      const [at, what] = historyLine(o.ui, l, r, now, zoneOf(d.zone));
      say(o, `    ${at}  `, what);
    }
  }
  if (narrowed) {
    o.say("");
    say(
      o,
      `  ${mark(o.ui, "warn")} `,
      `A rule shown in yellow asks for a wider level than it runs at here. This computer's mode is ${h.mode}; \`sessionpipe control mode auto\` at this terminal lets a rule run as wide as it asks.`,
    );
  }
}

async function status(p: Parsed, o: TriggerOut, d: TriggerDeps): Promise<void> {
  const h = await here(d);
  if (p.flags.has("--json")) return printJson(o, "trigger-list", listOf(h));
  headline(o, h, d);
  const r = await d.local({ op: "status" }, 2000);
  const t = r?.op === "status" ? (r.status as { triggers?: { waiting: number; running: number } }).triggers : undefined;
  o.say("");
  say(
    o,
    "  background service: ",
    r?.op !== "status"
      ? h.file?.on
        ? `not running, so no rule runs: \`sessionpipe triggers on\` installs it`
        : "not running"
      : t
        ? `running · ${t.running} run${t.running === 1 ? "" : "s"} now · ${t.waiting} waiting`
        : "running a sessionpipe from before triggers: `sessionpipe update` brings it up to date",
  );
  say(
    o,
    "  this computer's mode: ",
    `${h.mode}, so a rule runs at ${ceiling(h.mode)} at most here${h.mode === "auto" ? "" : " (a rule a notice runs is edits at most anywhere)"}`,
  );
  say(o, "  ", "`sessionpipe trigger list` shows each rule and what it did.");
}

async function on(p: Parsed, o: TriggerOut, d: TriggerDeps): Promise<void> {
  personOnly(d, "Turning triggers on");
  // At a terminal, always: on already, it still installs the background service.
  atTerminal(d, "Turning triggers on");
  const h = await here(d);
  const f = editable(h, d);
  const control = readControl(d.env);
  const machine = control?.name ?? machineName(readConfig(), os.hostname());
  if (f.on) say(o, `  ${mark(o.ui, "info")} `, "Triggers are on already.");
  else {
    say(o, "  ", tint(o.ui, "bold", `Turn triggers on? Then these rules run on ${machine} by themselves:`));
    if (!f.rules.length)
      say(o, "  ", "There are no rules yet, so nothing runs until you add one with `sessionpipe trigger add`.");
    for (const r of f.rules) {
      o.say("");
      showRule(o, r, h, machine);
    }
    o.say("");
    if (!(await confirmed(d, o, "Turning triggers on", "Type yes to turn them on, anything else to stop:"))) return;
    if (!unchanged(h, d, o)) return;
    writeRules({ ...f, on: true }, d.env);
    // The background service reads its settings from control.json: one that never paired has
    // none, and asking stays as it was (off where nothing was set up).
    if (!control) writeControl({ name: machine, folders: [], mode: "safe", receivers: [], ask: false }, d.env);
    say(o, `  ${mark(o.ui, "ok")} `, "Triggers are on. A rule runs when its clock or its receiver's notice says so.");
  }
  const r = await d.local({ op: "status" }, 2000);
  if (r?.op === "status") say(o, "  ", "Background service: running; it reads the rules within seconds.");
  else if (p.flags.has("--no-service"))
    say(o, "  ", "Background service: not installed (--no-service); run `sessionpipe control run` yourself.");
  else say(o, "  ", `Background service: ${d.installService()}`);
}

async function off(o: TriggerOut, d: TriggerDeps): Promise<void> {
  personOnly(d, "Turning triggers off");
  const h = await here(d);
  if (h.read.state === "refused") {
    say(
      o,
      `  ${mark(o.ui, "info")} `,
      "Triggers are off already: the rules file can't be read, and nothing in it runs.",
    );
    return;
  }
  if (!h.file?.on) {
    say(o, `  ${mark(o.ui, "info")} `, "Triggers are off already.");
    return;
  }
  writeRules({ ...h.file, on: false }, d.env);
  say(
    o,
    `  ${mark(o.ui, "ok")} `,
    "Triggers are off: no rule runs, a run that waits is dropped, and a triggered session that is running is stopped, within seconds. `sessionpipe triggers on` turns them on again.",
  );
}

async function narrow(
  verb: "pause" | "remove",
  name: string | undefined,
  o: TriggerOut,
  d: TriggerDeps,
): Promise<void> {
  personOnly(d, verb === "pause" ? "Pausing a rule" : "Removing a rule");
  const h = await here(d);
  const f = editable(h, d);
  const r = ruleOf(f, name, verb);
  if (verb === "remove") {
    writeRules({ ...f, rules: f.rules.filter((x) => x !== r) }, d.env);
    say(o, `  ${mark(o.ui, "ok")} `, `Removed ${r.name}. What it did goes with it.`);
    return;
  }
  if (r.paused) {
    say(o, `  ${mark(o.ui, "info")} `, `${r.name} is paused already.`);
    return;
  }
  writeRules({ ...f, rules: f.rules.map((x) => (x === r ? { ...x, paused: true } : x)) }, d.env);
  say(o, `  ${mark(o.ui, "ok")} `, `Paused ${r.name}: it runs nothing until \`sessionpipe trigger resume ${r.name}\`.`);
}

async function resume(name: string | undefined, o: TriggerOut, d: TriggerDeps): Promise<void> {
  personOnly(d, "Resuming a rule");
  const h = await here(d);
  const f = editable(h, d);
  const r = ruleOf(f, name, "resume");
  const byMachine = !!h.record.rules[r.name]?.paused;
  if (h.record.rules[r.name]?.paused?.why === "unknown_level")
    throw new Refusal(
      `this computer paused ${r.name} because the session it continues was started at a level it doesn't know, and resuming can't change that: remove the rule, and add it again for another session`,
      `sessionpipe trigger remove ${r.name}`,
    );
  if (!r.paused && !byMachine) {
    say(o, `  ${mark(o.ui, "info")} `, `${r.name} isn't paused.`);
    return;
  }
  if (byMachine && !isStart(r.target) && !d.sessionThere(r.target.continue))
    throw new Refusal(
      `the session ${r.name} continues is still gone, so it would only be paused again: remove the rule, or add one for a session that is here`,
      `sessionpipe trigger remove ${r.name}`,
    );
  const machine = readControl(d.env)?.name ?? machineName(readConfig(), os.hostname());
  o.say(`  ${tint(o.ui, "bold", "Resume this rule?")}`);
  o.say("");
  showRule(o, { ...r, paused: false }, h, machine);
  o.say("");
  if (!(await confirmed(d, o, "Resuming a rule", "Type yes to resume it, anything else to stop:"))) return;
  if (!unchanged(h, d, o)) return;
  if (r.paused) writeRules({ ...f, rules: f.rules.map((x) => (x === r ? { ...x, paused: false } : x)) }, d.env);
  if (byMachine) {
    // The pause is the background service's own: it lets go of it; with none running, nothing
    // else writes its record, and the pause is taken out of it here.
    const said = await d.local({ op: "trigger", action: "resume", name: r.name }, 2000);
    if (!said) {
      const rec = readRecord(d.env);
      delete (rec.rules[r.name] as RuleState).paused;
      writePrivate(triggerStateFile(d.env), rec);
    }
  }
  say(
    o,
    `  ${mark(o.ui, "ok")} `,
    `Resumed ${r.name}.${f.on ? "" : " Triggers are off: `sessionpipe triggers on` lets it run."}`,
  );
}

/** Which part of a rule a sample did not fit. A sample is made on the rule's own receiver, topic
 *  and event (core's sampleNotice), so those three never miss. */
const MISS: Partial<Record<TriggerMiss, (r: TriggerRule, n: ControlNotice) => string>> = {
  state: (r, n) =>
    n.state
      ? `its state is ${n.state}, and the rule takes ${r.when?.state?.join(" or ")}`
      : "it has no state, and the rule takes only some",
  for: (r, n) =>
    n.for
      ? `it is for ${n.for}, and the rule takes ${r.when?.for?.join(" or ")}`
      : "it is for nobody, and the rule takes only some",
  by: (r, n) =>
    n.by
      ? `${n.by} made the change, and the rule takes ${r.when?.by?.join(" or ")}`
      : "it names nobody who made the change, and the rule takes only some",
  subject: (r, n) => `its subject ${n.subject} doesn't match ${r.subject}`,
  placeholder: () => "the words name a field the notice doesn't carry",
};

async function test(p: Parsed, o: TriggerOut, d: TriggerDeps): Promise<void> {
  const h = await here(d);
  const f = editable(h, d);
  const r = ruleOf(f, p.words[1], "test");
  const now = d.now();
  let notice: ControlNotice | undefined;
  if (isNoticeSource(r.source)) {
    const subject = one(p, "--subject");
    if (!subject)
      throw new Refusal(
        "a rule on notices is tested with a sample notice: --subject <id> [--state <s> --for <who> --by <who>]",
        `sessionpipe trigger test ${r.name} --subject X-001`,
      );
    const fields = {
      subject,
      ...(one(p, "--state") ? { state: one(p, "--state") as string } : {}),
      ...(one(p, "--for") ? { for: one(p, "--for") as string } : {}),
      ...(one(p, "--by") ? { by: one(p, "--by") as string } : {}),
    };
    const read = parseNotice(sampleNotice(r, fields, { id: ulid(now), now }), now);
    if (!read.ok)
      throw new Refusal(
        `no receiver could send that notice: ${read.why}`,
        `sessionpipe trigger test ${r.name} --subject X-001`,
      );
    notice = read.notice;
  }
  // What would refuse it now, by this computer's state; it runs nothing and records nothing.
  const st = todayOf(h.record.rules[r.name], h.day);
  const control = readControl(d.env);
  const refusal = !f.on
    ? "triggers_off"
    : notice && st.keys.includes(`${notice.subject}/${notice.state ?? ""}`)
      ? "cooldown"
      : st.runs >= r.cap.per_day
        ? "cap"
        : !allowedIn(r.folder, control?.folders ?? [])
          ? "folder"
          : !d.harnesses().includes(targetHarness(r))
            ? "harness"
            : undefined;
  const levels = Object.hasOwn(h.offered, targetHarness(r)) ? h.offered[targetHarness(r)] : undefined;
  const a = testAnswer(r, {
    mode: h.mode,
    ...(levels ? { offered: levels } : {}),
    ...(isNoticeSource(r.source) ? { receiver: r.source.receiver } : {}),
    ...(notice ? { notice } : {}),
    ...(refusal ? { refusal } : {}),
  });
  if (p.flags.has("--json")) return printJson(o, "trigger-test", a);
  if (!a.matches) {
    say(
      o,
      `  ${mark(o.ui, "info")} `,
      `${r.name} doesn't take it: ${(MISS[a.miss as TriggerMiss] as (r: TriggerRule, n: ControlNotice) => string)(r, notice as ControlNotice)}. Nothing would run.`,
    );
    return;
  }
  if (!a.run) {
    say(
      o,
      `  ${mark(o.ui, "warn")} `,
      `${r.name} takes it, and it would be refused: ${label(targetHarness(r))} takes no level as narrow as ${r.level} on this computer.`,
    );
    return;
  }
  const run = a.run;
  const { why } = levelHere(r, h.mode, h.offered);
  say(o, `  ${mark(o.ui, "ok")} `, `${r.name} takes it. Nothing ran: this is what would run.`);
  const what = isStart(run.target) ? `start ${run.target.start}` : `continue ${short(run.target.continue)}`;
  say(
    o,
    "    ",
    `${what} in ${shown(o.ui, run.folder)} at ${tint(o.ui, "bold", run.level)}${why ? ` (it asks for ${r.level}; ${why})` : ""}${run.tools.length ? `, with ${run.tools.join(", ")} allowed without asking` : ""}`,
  );
  if (a.refusal)
    say(
      o,
      `  ${mark(o.ui, "warn")} `,
      `Right now it would be refused: ${refusedWords({ at: "", result: "refused", code: a.refusal, ...(notice ? { subject: notice.subject, ...(notice.state ? { state: notice.state } : {}) } : {}) }, r)}.`,
    );
  o.say(`    ${tint(o.ui, "dim", "the words it would get:")}`);
  const bar = `    ${tint(o.ui, "dim", "│")} `;
  for (const l of run.words.split("\n")) sayWords(o, bar, shown(o.ui, l), bar);
}
