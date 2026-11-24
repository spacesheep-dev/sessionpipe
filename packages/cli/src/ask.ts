// SPDX-License-Identifier: Apache-2.0
// `sessionpipe ask` (spec/CONTROL.md §13): a session hands a task to another agent on
// this machine and gets the answer back on stdout. The request goes to the control
// daemon's local socket, as `wait` does, never to a receiver; the daemon runs the agent,
// caps it, and streams what comes back on the same connection. Progress and the child's
// id go to stderr, the answer alone to stdout, so a shell can take it as is. `ask on |
// off | status` is the switch and its state; `ask setup` tells Claude Code and Codex the
// command exists, in their own instruction files, since hooks never inject anything.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  claudeDirs,
  codexControl,
  drivableHarnesses,
  homeDir,
  machineName,
  readConfig,
  stateDir,
  writeWhole,
} from "@sessionpipe/core";
import { parseSessionRef } from "@sessionpipe/core/control";
import { isBroad } from "./connect.js";
import type { Status } from "./control/daemon.js";
import { type AskRequest, ask, askMany, type LocalReply, reach, socketPath } from "./control/local.js";
import { installService, uninstallService } from "./control/pair.js";
import { askOn, type ControlConfig, readControl, writeControl } from "./control/store.js";
import { waitSession } from "./control/wait.js";
import { rerunGlobally, stableNode, viaNpx } from "./runtime.js";

export const ASK_HELP = `  sessionpipe ask <agent|harness:id> "<task>" [--cwd DIR] [--permission read|safe] [--model M] [--json] [--quiet]
                                                   (hand a task to another agent here; its answer comes back on stdout;
                                                    \`--text -\` reads the task from stdin, words after \`--\` are the task)
  sessionpipe ask on | off | status                (whether sessions on this machine may ask each other; \`on\` is the
                                                    person's to run at the terminal, never a session's)
  sessionpipe ask setup [--remove]                 (tell Claude Code and Codex the command exists)`;

/** What the asker writes where. `out` is one line on stdout: the answer, or a status
 *  line of on/off/status/setup. `err` is stderr, raw: progress and what went wrong. */
export interface AskIo {
  out: (s?: string) => void;
  err: (s: string) => void;
  /** Stdin, whole, for `--text -`. */
  stdin?: () => string;
  /** Whether a person is watching stderr (it is a terminal): the answer as it grows is
   *  shown only then. Taken as watched when not said. */
  watched?: boolean;
}

export interface AskOptions {
  env?: NodeJS.ProcessEnv;
  /** Where the CLI's dist lives: the service points at its cli.js. */
  distDir?: string;
  /** The agents this machine can run headlessly (tests stand in for the PATH walk). */
  harnesses?: (env: NodeJS.ProcessEnv) => string[];
  /** What the Codex here makes of the rules `ask setup` writes for it (tests stand in). */
  codexReads?: RulesReads;
}

const TEXT_MAX = 20_000;
const HARNESS = /^[a-z][a-z0-9-]{0,39}$/;
/** No clock of our own: the daemon bounds the run (a headless turn is capped there), and
 *  the harness's own command timeout is the asker's, as for `wait`. */
const ASK_TIMEOUT_MS = 2 ** 31 - 1;
const VALUED = new Set(["--cwd", "--permission", "--model", "--text"]);
/** `--no-color` is the whole CLI's and changes nothing here; it is a word of this command
 *  all the same, so that it cannot stand between `ask` and what follows unseen. */
const SWITCHES = new Set(["--json", "--quiet", "--remove", "--no-service", "--yes", "--no-color"]);
/** The words after `ask` that are not an agent. Each is read only as the first word:
 *  `sessionpipe ask on --yes`, never `sessionpipe ask --yes on` or `sessionpipe ask -- on`.
 *  A rule that tells these from an ask by the words in order (Codex's, below) then tells
 *  them apart for certain. */
const OWN = ["on", "off", "status", "setup"];
/** Every word that can stand where the agent goes and is not it: `--`, this command's
 *  flags, and the two the CLI answers with help wherever they are. */
const NOT_AN_AGENT = ["--", ...VALUED, ...SWITCHES, "--help", "-h"];

/** Run `sessionpipe ask …`; `argv` starts with "ask". Returns the exit code: 0 with the
 *  answer on stdout, 1 when the daemon refused or the run failed, 2 for a usage error. */
export async function askMain(argv: string[], io: AskIo, o: AskOptions = {}): Promise<number> {
  const env = o.env ?? process.env;
  const flags: Record<string, string | true> = {};
  const rest: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i] as string;
    // After `--` every word is the task, flags or not: a task composed from text that
    // happens to start with --cwd or --model never moves the child or picks its model.
    if (a === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (VALUED.has(a)) flags[a] = argv[++i] ?? "";
    else if (SWITCHES.has(a)) flags[a] = true;
    else if (/^--?[a-z]/.test(a) && !rest.length) {
      io.err(`sessionpipe ask: unknown flag ${a}\nusage:\n${ASK_HELP}\n`);
      return 2;
    } else rest.push(a);
  }
  const harnesses = o.harnesses ?? drivableHarnesses;
  if (rest[0] !== undefined && OWN.includes(rest[0]) && argv[1] !== rest[0]) {
    io.err(`sessionpipe ask: \`${rest[0]}\` goes right after \`ask\`: sessionpipe ask ${rest[0]} …\n`);
    return 2;
  }
  switch (rest[0]) {
    case undefined:
      io.err(`usage:\n${ASK_HELP}\n`);
      return 2;
    case "on":
      return on(argv, io, env, o.distDir, harnesses, !!flags["--no-service"], !!flags["--yes"]);
    case "off":
      return off(io, env);
    case "status":
      return status(io, env, harnesses);
    case "setup":
      return setup(io, env, harnesses, !!flags["--remove"], o.codexReads);
    default:
      return askOnce(rest, flags, io, env, harnesses);
  }
}

async function askOnce(
  rest: string[],
  flags: Record<string, string | true>,
  io: AskIo,
  env: NodeJS.ProcessEnv,
  harnesses: (env: NodeJS.ProcessEnv) => string[],
): Promise<number> {
  const usage = (why: string): number => {
    io.err(`sessionpipe ask: ${why}\n`);
    return 2;
  };
  const target = rest[0] as string;
  let harness = target;
  let session: string | undefined;
  if (target.includes(":")) {
    const ref = parseSessionRef(target);
    if (!ref) return usage(`${target} isn't a session: a session is <harness>:<id>, an agent is its name (codex)`);
    harness = ref.harness;
    session = target;
  } else if (!HARNESS.test(target)) return usage(`${target} isn't an agent's name (claude-code, codex, gemini-cli, …)`);
  const given = flags["--text"];
  const text =
    given === "-"
      ? (io.stdin ?? (() => readFileSync(0, "utf8")))()
      : typeof given === "string"
        ? given
        : rest.slice(1).join(" ");
  if (!text.trim()) return usage("nothing to ask: put the task in quotes after the agent, or pipe it with `--text -`");
  if (text.length > TEXT_MAX)
    return usage(
      `the task is ${text.length.toLocaleString("en")} characters; an ask carries ${TEXT_MAX.toLocaleString("en")} at most`,
    );
  const permission = flags["--permission"];
  if (permission !== undefined && permission !== "read" && permission !== "safe")
    return usage("--permission is read or safe: an asked agent never runs wider than this machine's mode");
  const model = flags["--model"];
  if (model === "") return usage("--model needs a name");
  const cwd = path.resolve(typeof flags["--cwd"] === "string" ? flags["--cwd"] : process.cwd());
  const from = waitSession(undefined, env) ?? undefined;
  const chain = (env.SESSIONPIPE_ASK_CHAIN ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const req: AskRequest = {
    op: "ask",
    harness,
    text,
    cwd,
    chain,
    pid: process.pid,
    ...(from ? { from } : {}),
    ...(session ? { session } : {}),
    ...(permission ? { permission } : {}),
    ...(typeof model === "string" ? { model } : {}),
  };
  const quiet = !!flags["--quiet"];
  // The answer as it grows is for a person watching: never for a session that asks (it is
  // a model reading, whether its harness gave the command a terminal or not), and never
  // into a pipe. A harness hands its model stdout and stderr as one text, and there the
  // model read the answer twice, run together (Codex 0.171's command output: "okok").
  const growing = !quiet && !from && (io.watched ?? true);
  const json = !!flags["--json"];
  const label = session ?? harness;
  let state: "nothing" | "asked" | "done" = "nothing";
  let code = 1;
  /** The answer so far, as shown on stderr; a progress frame carries the whole text. */
  let shown = "";
  const endLine = () => {
    if (shown && !shown.endsWith("\n")) io.err("\n");
  };
  const onReply = (r: LocalReply): void => {
    switch (r.op) {
      case "asked":
        state = "asked";
        if (!quiet) io.err(`sessionpipe ask: ${r.session ?? harness} is on it (ask ${r.ask_id})\n`);
        return;
      case "progress":
        if (growing) {
          // A text that restarts (shown is never empty then: anything starts with "") goes on its own line.
          io.err(r.text.startsWith(shown) ? r.text.slice(shown.length) : `\n${r.text}`);
          shown = r.text;
        }
        return;
      case "answer":
        state = "done";
        code = 0;
        endLine();
        if (json) io.out(JSON.stringify({ ask_id: r.ask_id, session: r.session, reply: r.text, ms: r.ms }));
        else {
          if (!quiet) io.err(`sessionpipe ask: ${r.session} answered in ${(r.ms / 1000).toFixed(1)} s\n`);
          io.out(r.text);
        }
        return;
      case "refused":
        state = "done";
        endLine();
        io.err(`sessionpipe ask: refused (${r.code}): ${r.detail}\n${refusedHint(r.code, env, harnesses)}`);
        return;
      case "failed":
        state = "done";
        endLine();
        io.err(`sessionpipe ask: ${label} failed: ${r.detail}\n`);
        return;
      default:
        // Not an ask's reply; askMany ends on a garbled line, this ends on a wrong one.
        return;
    }
  };
  const sock = socketPath(stateDir(env), env);
  await askMany(sock, req, onReply, ASK_TIMEOUT_MS);
  if (state === "nothing")
    io.err(
      (await reach(sock)) === "blocked"
        ? `sessionpipe ask: ${BLOCKED} ${blockedHint(env)}\n`
        : "sessionpipe ask: no control daemon is answering on this machine. The person runs `sessionpipe ask on` once at its terminal (not from inside a session): that starts the daemon as a service and keeps it running.\n",
    );
  else if (state === "asked") {
    endLine();
    io.err(`sessionpipe ask: the control daemon went away before ${label} answered\n`);
  }
  return code;
}

/** The connection to the daemon's socket was refused by the system itself: this command
 *  runs in a sandbox. Said as that, and never as "no daemon": a model told to have the
 *  person run `ask on` passes on an instruction that changes nothing (Codex 0.171 answers
 *  EPERM for every unix socket at its read-only and workspace sandboxes). */
const BLOCKED =
  "this command was stopped on its way to this computer's background service (permission denied on its socket), so nothing here says the service is not running.";
const inCodexSandbox = (env: NodeJS.ProcessEnv): boolean => !!(env.CODEX_SANDBOX || env.CODEX_SANDBOX_NETWORK_DISABLED);
/** What lets it through, for the model that reads this. Codex runs a command outside its
 *  sandbox only where its rules allow the whole command line, read as plain words. */
const blockedHint = (env: NodeJS.ProcessEnv): string =>
  inCodexSandbox(env)
    ? 'Codex runs commands in a sandbox that closes that way, and lets this one out only as a whole command line under its bare name: `sessionpipe ask <agent> "<task>"`, the agent right after `ask`, nothing chained, piped or redirected, and no `$`, backtick or backslash in the task. If it is still stopped, the person runs `sessionpipe ask setup` once at this machine\'s terminal: it writes the Codex rule that lets this one command through.'
    : "A sandbox around this command is the usual reason. The person can run it at this machine's terminal, or let this command out of the sandbox.";

/** What to do about a refusal, when there is something to do (CONTROL.md §13 codes). */
function refusedHint(code: string, env: NodeJS.ProcessEnv, harnesses: (env: NodeJS.ProcessEnv) => string[]): string {
  switch (code) {
    case "ask_off":
      return "  `sessionpipe ask on` at this machine's terminal allows it.\n";
    case "folder":
      return "  `sessionpipe control folders add <folder>` allows a folder; an asked agent runs only in one of those.\n";
    case "harness": {
      const have = harnesses(env);
      return have.length
        ? `  Agents sessionpipe can run here: ${have.join(", ")}.\n`
        : "  No agent sessionpipe can run headlessly is installed here.\n";
    }
    default:
      return "";
  }
}

function on(
  argv: string[],
  io: AskIo,
  env: NodeJS.ProcessEnv,
  distDir: string | undefined,
  harnesses: (env: NodeJS.ProcessEnv) => string[],
  noService: boolean,
  yes: boolean,
): number {
  // The person's command, at the terminal: it allows a folder and installs a service
  // that runs for good. A session's shell carries its harness's id (or the daemon's job
  // mark), and a model that read "run `sessionpipe ask on`" in a refusal would run it
  // there; it gets told whose command that is instead, unless the person said --yes.
  if (!yes && (env.SESSIONPIPE_CONTROL_JOB || env.CLAUDE_CODE_SESSION_ID || env.CODEX_SESSION_ID)) {
    io.err(
      "sessionpipe ask on: this runs inside a session. Turning asking on allows a folder and installs the daemon as a service, which is the person's decision: ask them to run `sessionpipe ask on` at this machine's terminal (or `sessionpipe ask on --yes` here, if they say so).\n",
    );
    return 1;
  }
  // A service must point at a copy that stays (pair's rule), never an npx cache.
  if (distDir && viaNpx(distDir)) {
    rerunGlobally(argv, io.out);
    return 0;
  }
  // Never paired: control.json starts here, with no receiver, in safe mode. The folder this
  // ran in is allowed, as `control pair` allows it, unless that is the home folder or above.
  const c: ControlConfig = readControl(env) ?? {
    name: machineName(readConfig(), os.hostname()),
    folders: [],
    mode: "safe",
    receivers: [],
  };
  let allowed: string | null = null;
  if (!c.folders.length && !isBroad(process.cwd(), os.homedir())) {
    allowed = process.cwd();
    c.folders = [allowed];
  }
  writeControl({ ...c, ask: true }, env);
  io.out('  ✓ Sessions on this machine may ask another agent: `sessionpipe ask <agent> "<task>"` from any of them.');
  io.out(agentsLine(harnesses(env)));
  if (allowed)
    io.out(`  Allowed ${allowed} for asked agents to run in; \`sessionpipe control folders add\` names more.`);
  else if (!c.folders.length)
    io.out(
      "  ! No folder is allowed, so every ask is refused until `sessionpipe control folders add <project>` names one.",
    );
  if (noService)
    io.out("  Background service: not installed as a service (--no-service); run `sessionpipe control run` yourself");
  else {
    let cli = path.join(distDir ?? ".", "cli.js");
    try {
      cli = statSync(cli).isFile() ? path.resolve(cli) : cli;
    } catch {}
    io.out(`  Background service: ${installService({ node: stableNode(process.execPath), cli, env })}`);
  }
  io.out("  `sessionpipe ask setup` tells Claude Code and Codex the command exists.");
  return 0;
}

function off(io: AskIo, env: NodeJS.ProcessEnv): number {
  const c = readControl(env);
  if (!c) {
    io.out("  Asking is already off: control isn't set up on this machine.");
    return 0;
  }
  writeControl({ ...c, ask: false }, env);
  io.out("  ✓ Sessions on this machine can no longer ask another agent (`sessionpipe ask on` turns it back on).");
  if (c.receivers.length)
    io.out("  The background service uses the new setting within seconds; your receivers' messages still arrive.");
  else {
    uninstallService(env);
    io.out("  Background service: removed; with no receiver paired, nothing was left for it to do.");
  }
  return 0;
}

async function status(
  io: AskIo,
  env: NodeJS.ProcessEnv,
  harnesses: (env: NodeJS.ProcessEnv) => string[],
): Promise<number> {
  // No control.json: nothing is set up, so no daemon runs and nobody can ask.
  const c = readControl(env);
  const sock = socketPath(stateDir(env), env);
  const r = await ask(sock, { op: "status" }, 2000);
  const running = r?.op === "status" ? (r.status as Status) : null;
  io.out(`  ask: ${c && askOn(c) ? "on" : "off (`sessionpipe ask on` turns it on)"}`);
  io.out(
    running
      ? `  daemon: running (pid ${running.pid}, ${running.version})`
      : (await reach(sock)) === "blocked"
        ? `  daemon: not reachable from here (permission denied on its socket). ${blockedHint(env)}`
        : "  daemon: not running (`sessionpipe ask on` installs it as a service)",
  );
  // The agents an ask can start, as the daemon says (an ACP agent takes no start options,
  // so `start` never lists it); a daemon from before `ask` in its status has only `start`.
  const have = running?.ask?.harnesses ?? Object.keys(running?.start ?? {});
  io.out(agentsLine(have.length ? have : harnesses(env)));
  const folders = c?.folders ?? [];
  io.out(
    folders.length
      ? `  folders: ${folders.join(", ")}`
      : "  folders: none allowed (`sessionpipe control folders add <project>`)",
  );
  return 0;
}

const agentsLine = (have: string[]): string =>
  have.length
    ? `  agents: ${have.join(", ")}`
    : "  agents: none sessionpipe can run headlessly is installed here (Claude Code, Codex, Antigravity, an ACP agent)";

// ---- ask setup: the section in CLAUDE.md / AGENTS.md ----------------------------------

export const ASK_OPEN = "<!-- sessionpipe ask -->";
export const ASK_CLOSE = "<!-- /sessionpipe ask -->";

/** The section a model reads, between the markers; `agents` is what this machine can run. */
export function askSection(agents: string[]): string {
  const here = agents.length
    ? `Agents here: ${agents.join(", ")}.`
    : "No agent sessionpipe can run is installed here yet; `sessionpipe ask status` says when one is.";
  return `${ASK_OPEN}
## Asking another agent

Another coding agent on this machine can take a task for you: \`sessionpipe ask <agent> "<task>"\`
runs it, waits, and prints its whole answer on stdout (progress on stderr; \`--json\` for
\`{ask_id, session, reply, ms}\`; \`sessionpipe ask <harness>:<id> "…"\` continues a session).
${here} Good for a review, a second opinion, or work another agent does better. It runs only
in folders this machine allows (\`--cwd DIR\` picks one). Run it as a command of its own, under
its bare name and with the agent right after \`ask\`, never chained, piped or redirected: a
sandbox around your commands lets it through only that way.
Never use it to send your own reply: your answer to the person goes where it always goes, and
an asked agent's answer comes back to you by itself.
${ASK_CLOSE}`;
}

/** The files `ask setup` writes: every Claude Code config dir's CLAUDE.md, and Codex's
 *  AGENTS.md. A file is written when it exists or its harness dir does; a harness that
 *  isn't here is left alone. */
export function setupFiles(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME || homeDir();
  return [
    ...claudeDirs(env, home).map((d) => path.join(d, "CLAUDE.md")),
    path.join(env.CODEX_HOME || path.join(home, ".codex"), "AGENTS.md"),
  ];
}

const sectionAt = (text: string): { start: number; end: number } | null => {
  const start = text.indexOf(ASK_OPEN);
  const close = start < 0 ? -1 : text.indexOf(ASK_CLOSE, start);
  return close < 0 ? null : { start, end: close + ASK_CLOSE.length };
};

/** `text` with the section in: replaced in place when one is there, else after what is
 *  there with one newline between (reversible byte for byte by withoutAskSection). */
export function withAskSection(text: string | null, section: string): string {
  if (!text) return `${section}\n`;
  const at = sectionAt(text);
  if (at) return text.slice(0, at.start) + section + text.slice(at.end);
  return `${text}\n${section}\n`;
}

/** `text` without the section and the newline that joined it on: what the file held
 *  before setup wrote it. Unchanged when there is no section. */
export function withoutAskSection(text: string): string {
  const at = sectionAt(text);
  if (!at) return text;
  let { start, end } = at;
  if (text[end] === "\n") end++;
  if (start > 0 && text[start - 1] === "\n") start--;
  return text.slice(0, start) + text.slice(end);
}

export type SetupDid = "added" | "updated" | "unchanged" | "removed" | "absent" | "skipped";

/** Write (or take out) the section in every file setupFiles names. */
export function setupAsk(env: NodeJS.ProcessEnv, agents: string[], remove: boolean): { file: string; did: SetupDid }[] {
  const section = askSection(agents);
  const out: { file: string; did: SetupDid }[] = [];
  for (const file of setupFiles(env)) {
    const had = existsSync(file) ? readFileSync(file, "utf8") : null;
    if (had === null && (remove || !existsSync(path.dirname(file)))) {
      out.push({ file, did: remove ? "absent" : "skipped" });
      continue;
    }
    if (remove) {
      const next = withoutAskSection(had as string);
      if (next === had) out.push({ file, did: "absent" });
      else {
        // An empty file afterwards was ours: setup creates the file only when the harness
        // dir had none, so it goes with the section.
        if (next === "") unlinkSync(file);
        else writeFileSync(file, next);
        out.push({ file, did: "removed" });
      }
      continue;
    }
    const next = withAskSection(had, section);
    if (next === had) out.push({ file, did: "unchanged" });
    else {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, next);
      out.push({ file, did: had === null ? "added" : "updated" });
    }
  }
  return out;
}

// ---- ask setup: Codex's rules for the one command ------------------------------------

/** The first line of the rules file sessionpipe writes, whole: how it knows the file is its
 *  own. It never changes: a file that starts otherwise is the person's. */
export const CODEX_RULES_MARK =
  "# sessionpipe ask: written by `sessionpipe ask setup`, taken out by `sessionpipe ask setup --remove`.";

const starlark = (words: string[]): string => `[${words.map((w) => JSON.stringify(w)).join(", ")}]`;

/** Codex's rules for `sessionpipe ask` (its execution policy, `$CODEX_HOME/rules/*.rules`).
 *  Codex runs the commands of a session in a sandbox that refuses every unix socket, the
 *  daemon's included, and no setting of it opens one socket alone: its network is all or
 *  nothing. A command its rules allow is run outside the sandbox, where the whole command
 *  line is that command in plain words (chained to, piped into or redirected to anything
 *  the rules do not also allow, it stays inside). Four lines, each closing something
 *  measured on Codex 0.171.0 (conformance/control-ask-codex-rules.json):
 *  - `host_executable(…, paths=[])`: without it Codex takes ANY program reached by a path
 *    and named `sessionpipe` for this one (`./sessionpipe ask x`), and a session could write
 *    such a file into its own workspace and run it outside the sandbox. With it only the
 *    bare name matches, which the person's own PATH resolves.
 *  - the allow: `sessionpipe ask …`.
 *  - `on`, `off` and `setup` are the person's (the narrower rule wins).
 *  - a flag or `--` in the agent's place is refused, so what follows `ask` is always the
 *    word that says what the command is, whatever a parser older than this file made of
 *    `sessionpipe ask --yes on`. */
export function codexAskRules(): string {
  return `${CODEX_RULES_MARK}
# Codex keeps a session's commands in a sandbox that closes the way to this computer's
# background service. These rules let one command out of it: sessionpipe ask <agent> "<task>",
# under its bare name and as the whole command line. Turning asking on or off stays the person's.
host_executable(name="sessionpipe", paths=[])
prefix_rule(pattern=["sessionpipe", "ask"], decision="allow")
prefix_rule(pattern=["sessionpipe", "ask", ${starlark(OWN.filter((w) => w !== "status"))}], decision="forbidden", justification="Turning asking on or off, and setting it up, is the person's to do at this machine's terminal.")
prefix_rule(pattern=["sessionpipe", "ask", ${starlark(NOT_AN_AGENT)}], decision="forbidden", justification="Put the agent right after ask: sessionpipe ask <agent> '<task>' [--json] [--cwd DIR]")
`;
}

/** What a Codex that reads the rules as meant says of these command lines: the file goes
 *  where Codex loads it only when the Codex on this machine gives every one of them. */
export const CODEX_RULE_READINGS: ReadonlyArray<readonly [words: string[], decision: string]> = [
  [["sessionpipe", "ask", "codex", "hi"], "allow"],
  [["sessionpipe", "ask", "claude-code:8c132906-8c3f-4814-870a-afc3d05e1d2e", "hi", "--json"], "allow"],
  [["sessionpipe", "ask", "status"], "allow"],
  [["sessionpipe", "ask", "on"], "forbidden"],
  [["sessionpipe", "ask", "off"], "forbidden"],
  [["sessionpipe", "ask", "setup", "--remove"], "forbidden"],
  [["sessionpipe", "ask", "--yes", "on"], "forbidden"],
  [["sessionpipe", "ask", "--", "off"], "forbidden"],
  [["sessionpipe", "ask", "--json", "codex", "hi"], "forbidden"],
  [["sessionpipe", "ask", "--no-color", "on", "--yes"], "forbidden"],
  [["sessionpipe", "ask", "--help"], "forbidden"],
  [["./sessionpipe", "ask", "codex", "hi"], "none"],
  [["/tmp/sessionpipe", "ask", "codex", "hi"], "none"],
  [["sessionpipe", "pool"], "none"],
];

/** `ok`: the Codex here reads the rules as meant. `unfit`: it reads them otherwise, or not
 *  at all (one from before a construct in them). `none`: no `codex` to try them with. */
export type RulesRead = "ok" | "unfit" | "none";
export type RulesReads = (text: string, env: NodeJS.ProcessEnv) => RulesRead;

/** Try the rules on this machine's own Codex, in a file of their own, before they go where
 *  it loads them: Codex reads all of its rules files or none, so one line an older Codex
 *  does not know would take every rule the person has with it. */
export function codexReads(
  text: string,
  env: NodeJS.ProcessEnv,
  codex: string | null = codexControl.findCodex(env, env.HOME || homeDir()),
  reading: typeof codexControl.codexRuleReading = codexControl.codexRuleReading,
): RulesRead {
  if (!codex) return "none";
  const dir = mkdtempSync(path.join(os.tmpdir(), "sp-rules-"));
  try {
    const file = path.join(dir, "sessionpipe.rules");
    writeFileSync(file, text);
    // Asked a second time where Codex gave no answer at all: a slow start on a busy machine
    // is not a Codex that cannot read the file.
    const says = (words: string[]) => reading(codex, file, words, env) ?? reading(codex, file, words, env);
    return CODEX_RULE_READINGS.every(([words, want]) => says(words) === want) ? "ok" : "unfit";
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const codexRulesFile = (env: NodeJS.ProcessEnv = process.env): string =>
  path.join(env.CODEX_HOME || path.join(env.HOME || homeDir(), ".codex"), "rules", "sessionpipe.rules");

export type RulesDid = SetupDid | "foreign" | "unfit" | "unchecked" | "failed";

/** Write (or take out) Codex's rules file. Written only where Codex's own folder is and
 *  the Codex here reads the rules as meant; a file of that name sessionpipe did not write
 *  is left as it is (`foreign`). `failed` with `why`: the file or its folder could not be
 *  read, written or removed (a `rules` that is a file, a folder this user may not write). */
export function setupCodexRules(
  env: NodeJS.ProcessEnv,
  remove: boolean,
  reads: RulesReads = (text, e) => codexReads(text, e),
): { file: string; did: RulesDid; why?: string } {
  const file = codexRulesFile(env);
  try {
    const had = existsSync(file) ? readFileSync(file, "utf8") : null;
    if (had !== null && !had.startsWith(CODEX_RULES_MARK)) return { file, did: "foreign" };
    if (remove) {
      if (had === null) return { file, did: "absent" };
      unlinkSync(file);
      return { file, did: "removed" };
    }
    if (!existsSync(path.dirname(path.dirname(file)))) return { file, did: "skipped" };
    const next = codexAskRules();
    const read = reads(next, env);
    if (read === "none") return { file, did: "unchecked" };
    if (read === "unfit") {
      // A file of ours this Codex cannot read as meant is not left where it loads it.
      if (had !== null) unlinkSync(file);
      return { file, did: "unfit" };
    }
    if (next === had) return { file, did: "unchanged" };
    mkdirSync(path.dirname(file), { recursive: true });
    writeWhole(file, next);
    return { file, did: had === null ? "added" : "updated" };
  } catch (e) {
    return { file, did: "failed", why: (e as Error).message };
  }
}

function setup(
  io: AskIo,
  env: NodeJS.ProcessEnv,
  harnesses: (env: NodeJS.ProcessEnv) => string[],
  remove: boolean,
  reads?: RulesReads,
): number {
  const home = env.HOME || homeDir();
  const words: Record<SetupDid, string> = {
    added: "✓ wrote the section into",
    updated: "✓ brought the section up to date in",
    unchanged: "· already current:",
    removed: "✓ took the section out of",
    absent: "· no section in",
    skipped: "· not here:",
  };
  const short = (file: string) => (file.startsWith(home) ? `~${file.slice(home.length)}` : file);
  for (const r of setupAsk(env, harnesses(env), remove)) io.out(`  ${words[r.did]} ${short(r.file)}`);
  // Codex's sandbox closes the way to the daemon: its own rules file lets the one command out.
  const rules = setupCodexRules(env, remove, reads);
  const at = short(rules.file);
  const ruleWords: Record<RulesDid, string> = {
    added: `✓ wrote Codex's rule for \`sessionpipe ask\` into ${at}`,
    updated: `✓ brought Codex's rule for \`sessionpipe ask\` up to date in ${at}`,
    unchanged: `· Codex's rule for \`sessionpipe ask\` is already current: ${at}`,
    removed: `✓ took Codex's rule for \`sessionpipe ask\` out of ${at}`,
    absent: `· no rule of ours in ${at}`,
    skipped: `· Codex is not here: ${at}`,
    foreign: `! left alone, since sessionpipe did not write it: ${at}`,
    unfit: `! did not write Codex's rule for \`sessionpipe ask\`: the Codex on this machine does not read it as meant. Update Codex, then run \`sessionpipe ask setup\` again. Until then a Codex session's sandbox stops \`sessionpipe ask\`.`,
    unchecked: `· did not write Codex's rule for \`sessionpipe ask\`: no \`codex\` command was found here to try it with`,
    failed: `! could not ${remove ? "take out" : "write"} Codex's rule for \`sessionpipe ask\` (${at}): ${rules.why}`,
  };
  io.out(`  ${ruleWords[rules.did]}`);
  if (rules.did === "added" || rules.did === "updated")
    io.out(
      "    Codex keeps a session's commands in a sandbox that closes the way to this computer's background service. The rule lets `sessionpipe ask <agent> …` out of it and nothing else: `sessionpipe ask on`, `off` and `setup` stay yours.",
    );
  if (!remove)
    io.out("  A session reads it when it starts; one that is open now learns the command on its next start.");
  return rules.did === "failed" ? 1 : 0;
}
