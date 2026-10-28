// SPDX-License-Identifier: Apache-2.0
// `sessionpipe ask` (spec/CONTROL.md §13): a session hands a task to another agent on
// this machine and gets the answer back on stdout. The request goes to the control
// daemon's local socket, as `wait` does, never to a receiver; the daemon runs the agent,
// caps it, and streams what comes back on the same connection. Progress and the child's
// id go to stderr, the answer alone to stdout, so a shell can take it as is. `ask on |
// off | status` is the switch and its state; `ask setup` tells Claude Code and Codex the
// command exists, in their own instruction files, since hooks never inject anything.
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeDirs, drivableHarnesses, homeDir, machineName, readConfig, stateDir } from "@sessionpipe/core";
import { parseSessionRef } from "@sessionpipe/core/control";
import { isBroad } from "./connect.js";
import type { Status } from "./control/daemon.js";
import { type AskRequest, ask, askMany, type LocalReply, socketPath } from "./control/local.js";
import { installService, uninstallService } from "./control/pair.js";
import { askOn, type ControlConfig, readControl, writeControl } from "./control/store.js";
import { waitSession } from "./control/wait.js";
import { rerunGlobally, stableNode, viaNpx } from "./runtime.js";

export const ASK_HELP = `  sessionpipe ask <agent|harness:id> "<task>" [--cwd DIR] [--permission read|safe] [--model M] [--json] [--quiet]
                                                   (hand a task to another agent here; its answer comes back on stdout)
  sessionpipe ask on | off | status                (whether sessions on this machine may ask each other)
  sessionpipe ask setup [--remove]                 (tell Claude Code and Codex the command exists)`;

/** What the asker writes where. `out` is one line on stdout: the answer, or a status
 *  line of on/off/status/setup. `err` is stderr, raw: progress and what went wrong. */
export interface AskIo {
  out: (s?: string) => void;
  err: (s: string) => void;
  /** Stdin, whole, for `--text -`. */
  stdin?: () => string;
}

export interface AskOptions {
  env?: NodeJS.ProcessEnv;
  /** Where the CLI's dist lives: the service points at its cli.js. */
  distDir?: string;
  /** The agents this machine can run headlessly (tests stand in for the PATH walk). */
  harnesses?: (env: NodeJS.ProcessEnv) => string[];
}

const TEXT_MAX = 20_000;
const HARNESS = /^[a-z][a-z0-9-]{0,39}$/;
/** No clock of our own: the daemon bounds the run (a headless turn is capped there), and
 *  the harness's own command timeout is the asker's, as for `wait`. */
const ASK_TIMEOUT_MS = 2 ** 31 - 1;
const VALUED = new Set(["--cwd", "--permission", "--model", "--text"]);
const SWITCHES = new Set(["--json", "--quiet", "--remove", "--no-service"]);

/** Run `sessionpipe ask …`; `argv` starts with "ask". Returns the exit code: 0 with the
 *  answer on stdout, 1 when the daemon refused or the run failed, 2 for a usage error. */
export async function askMain(argv: string[], io: AskIo, o: AskOptions = {}): Promise<number> {
  const env = o.env ?? process.env;
  const flags: Record<string, string | true> = {};
  const rest: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i] as string;
    if (VALUED.has(a)) flags[a] = argv[++i] ?? "";
    else if (SWITCHES.has(a)) flags[a] = true;
    else if (/^--?[a-z]/.test(a) && !rest.length) {
      io.err(`sessionpipe ask: unknown flag ${a}\nusage:\n${ASK_HELP}\n`);
      return 2;
    } else rest.push(a);
  }
  const harnesses = o.harnesses ?? drivableHarnesses;
  switch (rest[0]) {
    case undefined:
      io.err(`usage:\n${ASK_HELP}\n`);
      return 2;
    case "on":
      return on(argv, io, env, o.distDir, harnesses, !!flags["--no-service"]);
    case "off":
      return off(io, env);
    case "status":
      return status(io, env, harnesses);
    case "setup":
      return setup(io, env, harnesses, !!flags["--remove"]);
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
        if (!quiet) {
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
  await askMany(socketPath(stateDir(env), env), req, onReply, ASK_TIMEOUT_MS);
  if (state === "nothing")
    io.err(
      "sessionpipe ask: no control daemon is answering on this machine. Run `sessionpipe ask on` once at its terminal: that starts the daemon as a service and keeps it running.\n",
    );
  else if (state === "asked") {
    endLine();
    io.err(`sessionpipe ask: the control daemon went away before ${label} answered\n`);
  }
  return code;
}

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
): number {
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
  if (noService) io.out("  Daemon: not installed as a service (--no-service); run `sessionpipe control run` yourself");
  else {
    let cli = path.join(distDir ?? ".", "cli.js");
    try {
      cli = statSync(cli).isFile() ? path.resolve(cli) : cli;
    } catch {}
    io.out(`  Daemon: ${installService({ node: stableNode(process.execPath), cli, env })}`);
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
    io.out("  The control daemon uses the new setting within seconds; your receivers' messages still arrive.");
  else {
    uninstallService(env);
    io.out("  Daemon: removed; with no receiver paired, nothing was left for it to do.");
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
  const r = await ask(socketPath(stateDir(env), env), { op: "status" }, 2000);
  const running = r?.op === "status" ? (r.status as Status) : null;
  io.out(`  ask: ${c && askOn(c) ? "on" : "off (`sessionpipe ask on` turns it on)"}`);
  io.out(
    running
      ? `  daemon: running (pid ${running.pid}, ${running.version})`
      : "  daemon: not running (`sessionpipe ask on` installs it as a service)",
  );
  const have = Object.keys(running?.start ?? {});
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
in folders this machine allows (\`--cwd DIR\` picks one). Never use it to send your own reply:
your answer to the person goes where it always goes, and an asked agent's answer comes back to
you by itself.
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

function setup(
  io: AskIo,
  env: NodeJS.ProcessEnv,
  harnesses: (env: NodeJS.ProcessEnv) => string[],
  remove: boolean,
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
  for (const r of setupAsk(env, harnesses(env), remove))
    io.out(`  ${words[r.did]} ${r.file.startsWith(home) ? `~${r.file.slice(home.length)}` : r.file}`);
  if (!remove)
    io.out("  A session reads it when it starts; one that is open now learns the command on its next start.");
  return 0;
}
