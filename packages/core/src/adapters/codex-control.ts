// SPDX-License-Identifier: Apache-2.0
// Codex CLI (OpenAI) — control delivery (spec/CONTROL.md §6). Codex on this machine,
// as the control daemon needs it: which `codex` to run, with which sandbox flags, one
// headless turn (`codex exec --json` for a new session, `codex exec resume --json <id>`
// for the next message), and its JSONL output read as it streams. Codex picks a new
// session's id itself (the first line, `thread.started`), so the daemon names it after
// the command that started it (CONTROL.md §6 `start`). Shapes measured on codex-cli
// 0.160.0, 2026-10-04; `--image` on 0.171.0, 2026-11-19; the whole stream recorded on
// 0.171.0, 2026-11-24 (conformance/control-codex-exec-stream.json).
import { execFile, execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PICTURE_TYPES, type Picture, type PictureLimits, picturesFor } from "../control/pictures.js";
import { MODEL_RE, type RunLevel, type StartPermission } from "../control/verify.js";
import { linesFromEnd } from "../readers/files.js";
import {
  findBinary,
  jobEnv,
  type Login,
  type Mode,
  pictureThere,
  probe,
  type Reading,
  type RunResult,
  runFailure,
  shimNote,
  spawnable,
  stderrTail,
} from "./headless.js";

export { codexFacts, findRollout, threadLocked } from "./codex.js";

const LABEL = "Codex";

/** The `codex` to run: SESSIONPIPE_CODEX, else on PATH, else beside the node running
 *  this (an `npm install -g` there) or where the installers put it. */
export function findCodex(
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
  nodeDir = path.dirname(process.execPath),
): string | null {
  return findBinary({
    override: env.SESSIONPIPE_CODEX,
    names: process.platform === "win32" ? ["codex.exe", "codex.cmd"] : ["codex"],
    env,
    dirs: [nodeDir, path.join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"],
  });
}

/** Sandbox flags for a level (a machine's mode is one: safe, auto, inherit). Read: the
 *  read-only sandbox. Safe: workspace-write, and nothing escalates unattended (exec never
 *  asks); that sandbox already edits inside the folder, so `edits` is never offered and
 *  means the same. Auto: approval requests go through Codex's own automatic review.
 *  Inherit: none, so `sandbox_mode` and `approval_policy` come from the person's own
 *  config.toml, a new session's and a resume's alike. Never
 *  `--dangerously-bypass-approvals-and-sandbox`, `--dangerously-bypass-hook-trust` or
 *  `danger-full-access`: no path here writes them. */
export function codexModeFlags(level: RunLevel, resume = false): string[] {
  if (level === "inherit") return [];
  const sandbox = level === "read" ? "read-only" : "workspace-write";
  // `codex exec resume` takes neither `-s` nor `--approve-for-me` (0.160: "unexpected
  // argument"), so a resume says the same thing as config overrides, which it does take.
  if (resume)
    return level === "auto"
      ? [
          "-c",
          'sandbox_mode="workspace-write"',
          "-c",
          'approval_policy="on-request"',
          "-c",
          'approvals_reviewer="auto_review"',
        ]
      : ["-c", `sandbox_mode="${sandbox}"`];
  return level === "auto" ? ["--approve-for-me"] : ["-s", sandbox];
}

/** The levels a start may ask Codex for on a machine in `mode`: read and safe, and auto
 *  on an auto machine. */
export const offeredLevels = (mode: Mode): StartPermission[] =>
  mode === "auto" ? ["read", "safe", "auto"] : ["read", "safe"];

/** What a start that names no level gets: what the machine's mode means for Codex. */
export const defaultLevel = (mode: Mode): RunLevel => mode;

/** One headless turn. A new session runs in `cwd` (`-C`); a resume names the thread.
 *  The model is its own argument after `-m`. Each picture is its own `--image <path>`,
 *  in order, after every other flag (`codex exec` reads `--image` as a list, which the
 *  next flag or `--` ends). The prompt goes after `--`, so a message that starts with a
 *  dash is never a flag. With no pictures the arguments are what they always were. */
export function codexArgs(o: {
  permission: RunLevel;
  prompt: string;
  cwd?: string;
  resume?: string;
  model?: string;
  pictures?: readonly string[];
}): string[] {
  const common = ["--json", "--skip-git-repo-check"];
  const model = o.model ? ["-m", o.model] : [];
  const images = (o.pictures ?? []).flatMap((p) => ["--image", p]);
  if (o.resume)
    return [
      "exec",
      "resume",
      ...common,
      ...codexModeFlags(o.permission, true),
      ...model,
      ...images,
      "--",
      o.resume,
      o.prompt,
    ];
  return [
    "exec",
    ...common,
    ...(o.cwd ? ["-C", o.cwd] : []),
    ...codexModeFlags(o.permission),
    ...model,
    ...images,
    "--",
    o.prompt,
  ];
}

/** What Codex takes as `--image` (spec/ADAPTERS.md, Codex, Control): PNG, JPEG, WebP and
 *  GIF, as OpenAI's image input takes them — a still picture only (it takes no animated
 *  GIF) — of at most 30 000 patches of 32 × 32 px. Codex sends a picture as it is
 *  (`detail: "original"`, measured on 0.171.0 with a 4000 × 2000 PNG: no resizing), and
 *  OpenAI refuses one over 30 000 patches at that detail rather than shrink it. No count
 *  or size of its own below a command's ten files of 25 MiB: OpenAI takes up to 1 500
 *  pictures and 512 MB in one request. */
export const CODEX_PICTURES: PictureLimits = { types: PICTURE_TYPES, maxPatches: 30_000, still: true };

/** The saved pictures a Codex run is given as `--image`, by path, in order: those Codex
 *  takes, still there as saved when the arguments are built, and whose path has no comma.
 *  Codex splits each `--image` value on commas (0.171.0, exec and exec resume alike):
 *  `/w/b,c.png` is read as `/w/b` and a relative `c.png`, so a file named `x,README.png`
 *  would attach another file of the folder. A path with a comma (in the file's name or the
 *  session's folder) stays in the text's list only. */
export const codexPictures = (pictures: readonly Picture[]): string[] =>
  picturesFor(pictures, CODEX_PICTURES)
    .filter((p) => !p.path.includes(",") && pictureThere(p))
    .map((p) => p.path);

/** A Codex that has no `--image` for this command (one older than the flag) says so the
 *  way its argument parser says everything, before it starts anything: exit 2, nothing on
 *  stdout, and `error: unexpected argument '--image' found` on stderr (0.171.0's words for
 *  an argument it doesn't know). The run is made again without the pictures. */
export const codexRefusedPictures = (res: RunResult): boolean =>
  res.code === 2 && !res.stdout?.trim() && /unexpected argument '--image'/.test(res.stderr ?? "");

/** The models a hello offers for Codex (CONTROL.md §2 `start`): the slugs Codex's own
 *  picker lists, from `$CODEX_HOME/models_cache.json` (visibility `list`; hidden ones,
 *  such as its review model, left out), at most 50. Empty when there is no cache. */
export function codexModels(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string[] {
  try {
    const file = path.join(env.CODEX_HOME || path.join(home, ".codex"), "models_cache.json");
    const j = JSON.parse(readFileSync(file, "utf8")) as { models?: unknown };
    if (!Array.isArray(j.models)) return [];
    const out: string[] = [];
    for (const m of j.models as { slug?: unknown; visibility?: unknown }[])
      if (m && m.visibility === "list" && typeof m.slug === "string" && MODEL_RE.test(m.slug) && m.slug.length <= 100)
        if (!out.includes(m.slug)) out.push(m.slug);
    return out.slice(0, 50);
  } catch {
    return [];
  }
}

/** The env a headless turn runs with. */
export const codexEnv = (env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => jobEnv(env);

export const LOGIN_HINT = "Codex isn't signed in on this machine: run `codex login --device-auth` there.";

/** Whether Codex can run as this process: CODEX_API_KEY in the env is enough; else
 *  `codex login status` (exit 0 signed in, exit 1 "Not logged in"). Anything else —
 *  it didn't run, it timed out — is null, never a reason to refuse. */
export function codexLogin(bin: string, env: NodeJS.ProcessEnv = process.env): Promise<Login> {
  if (env.CODEX_API_KEY) return Promise.resolve({ loggedIn: true, method: "api key" });
  const c = probe(bin, ["login", "status"]); // a codex.cmd shim can't be spawned bare (#165)
  return new Promise((resolve) => {
    execFile(
      c.file,
      c.args,
      { encoding: "utf8", timeout: 20_000, env: codexEnv(env), maxBuffer: 256 * 1024, shell: c.shell },
      (err) => {
        if (!err) return resolve({ loggedIn: true });
        const code = (err as { code?: unknown }).code;
        resolve(code === 1 ? { loggedIn: false } : { loggedIn: null });
      },
    );
  });
}

/** A headless turn Codex refused because a live process has the thread: it locks an open
 *  thread itself (`$CODEX_HOME/thread-writer-locks/<thread>.lock`), and a second writer
 *  ends at once, exit 1, nothing on stdout, stderr `thread <id> already has an active
 *  writer` (0.171.0). The holder is a window, the background server a window starts,
 *  which keeps the thread about a minute after its last use, or another run. Nothing was
 *  run or written. `thread`: the one the turn was for, which the refusal must name. */
export function heldElsewhere(res: RunResult, thread: string): boolean {
  const said = String(res.stderr ?? "").toLowerCase();
  return res.code === 1 && said.includes(`thread ${thread.toLowerCase()} already has an active writer`);
}

/** The first Codex whose lock on an open thread was measured (`heldElsewhere`). */
const LOCKS_FROM = [0, 171, 0] as const;

/** Whether this `codex` refuses a thread that another process of Codex has: asked of the
 *  binary itself (`codex --version`), since a daemon may be running an older one than the
 *  window that has the thread, and an older one would write beside it. False for a
 *  version before the one this was measured on, and for a binary that does not say. */
export function codexLocks(bin: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const c = probe(bin, ["--version"]);
  let said = "";
  try {
    said = execFileSync(c.file, c.args, {
      encoding: "utf8",
      timeout: 4000,
      stdio: ["ignore", "pipe", "ignore"],
      env: codexEnv(env),
      shell: c.shell,
    });
  } catch {
    return false;
  }
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(said);
  if (!m) return false;
  const v = [Number(m[1]), Number(m[2]), Number(m[3])];
  const at = v.findIndex((n, i) => n !== LOCKS_FROM[i]);
  return at < 0 || (v[at] as number) > (LOCKS_FROM[at] as number);
}

/** How a thread's last turn stands in its rollout, by Codex's own records of a turn's
 *  start (`task_started`, with what began it: `user`, `exec`, `queue`) and end
 *  (`task_complete`, `turn_aborted`): the last of them, looked for from the file's end
 *  however far back it is. `at`: when that record was written; `written`: when the file
 *  last was. Null for a rollout with no such record, or one that can't be read.
 *
 *  A turn with no end is not always running: a headless run that is killed writes none
 *  (0.171.0: SIGTERM to `codex exec` leaves its `task_started` as the last record, and a
 *  window opened on the thread afterwards writes nothing until its own first turn). */
export function lastTurn(
  rollout: string,
): { open: boolean; trigger: string | null; at: number; written: number } | null {
  let written = 0;
  try {
    written = statSync(rollout).mtimeMs;
  } catch {
    return null;
  }
  for (const line of linesFromEnd(rollout)) {
    if (!line.includes('"event_msg"')) continue;
    let j: { timestamp?: unknown; payload?: { type?: unknown; turn_attribution?: { turn_trigger?: unknown } } };
    try {
      j = JSON.parse(line) as typeof j;
    } catch {
      continue;
    }
    const p = j?.payload;
    if (p?.type === "task_complete" || p?.type === "turn_aborted")
      return { open: false, trigger: null, at: 0, written };
    if (p?.type !== "task_started") continue;
    const trigger = p.turn_attribution?.turn_trigger;
    return {
      open: true,
      trigger: typeof trigger === "string" ? trigger : null,
      at: Date.parse(String(j.timestamp ?? "")) || 0,
      written,
    };
  }
  return null;
}

/** Codex's own word that a message is in a thread's queue. */
const QUEUED = /^Queued message \S+ for thread /m;

/** Hand a message to the thread through Codex's own queue: `codex queue --thread <id>
 *  --message=<text> --resume`. The process that has the thread takes it, at once when it
 *  is idle and as its turn ends when it is not, as a turn of its own (`turn_trigger:
 *  "queue"`); `--resume` has a background server that holds the thread take it without
 *  waiting for its next look at the queue (ten seconds apart), and only warns where there
 *  is none (it warns the same where a window with no server took the message, so the
 *  warning says nothing). Only ever for a thread a live process holds (`heldElsewhere`):
 *  queued for one nobody has, the message sits until a later run takes it into its own
 *  turn.
 *
 *  `ok`: true when Codex said it is queued, whatever else happened to the command; false
 *  when the command ended without saying so; null when it did not end in time, so nobody
 *  knows (Codex puts the message in its queue before it says so). It is never ended early
 *  for that reason: a command cut short leaves the same doubt, and a queued message
 *  cannot be taken back. `said` is what Codex wrote last, or how it ended,
 *  without this machine's home in it and never the command line (the message is on it).
 *  The text goes as one argument joined to its flag: a text that begins with a dash is
 *  refused as a flag otherwise (measured). Never rejects. */
export function codexQueue(
  bin: string,
  thread: string,
  text: string,
  env: NodeJS.ProcessEnv = process.env,
  o: { timeoutMs?: number; home?: string } = {},
): Promise<{ ok: boolean | null; said: string }> {
  // No shell: the message is one argument, whatever it holds (#165 for a .cmd shim).
  const c = spawnable(bin, ["queue", "--thread", thread, `--message=${text}`, "--resume"]);
  if (!c) return Promise.resolve({ ok: false, said: shimNote(bin) });
  return new Promise((resolve) => {
    execFile(
      c.file,
      c.args,
      { encoding: "utf8", timeout: o.timeoutMs ?? 20_000, env: codexEnv(env), maxBuffer: 256 * 1024 },
      (err, stdout, stderr) => {
        if (QUEUED.test(String(stdout))) return resolve({ ok: true, said: "" });
        const home = o.home ?? os.homedir();
        const wrote = stderrTail(String(stderr)).split(home).join("~");
        if (!err) return resolve({ ok: false, said: wrote });
        if (err.killed) return resolve({ ok: null, said: "it did not answer in time" });
        resolve({
          ok: false,
          said: wrote || (typeof err.code === "number" ? `it exited with code ${err.code}` : "it could not be run"),
        });
      },
    );
  });
}

/** What this Codex makes of one command line under a rules file of its execution policy
 *  (`$CODEX_HOME/rules/*.rules`): `codex execpolicy check --rules <file>
 *  --resolve-host-executables <words…>` prints `{matchedRules, decision?}`. The answer is
 *  the decision (`allow`, `prompt`, `forbidden`), `none` where no rule matched, or null
 *  where this Codex could not say: it has no such command, or it could not read the file.
 *  One construct it does not know and Codex reads none of its rules files, the person's own
 *  included, so a file is tried here before it is put where Codex loads it. Measured on
 *  codex-cli 0.171.0, 2026-11-24. */
export function codexRuleReading(
  bin: string,
  rulesFile: string,
  words: string[],
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  // No shell, ever: the file's path and the words go as they are (a codex.cmd shim's own
  // script runs under this node, #165).
  const c = spawnable(bin, ["execpolicy", "check", "--rules", rulesFile, "--resolve-host-executables", ...words]);
  if (!c) return null;
  try {
    const out = execFileSync(c.file, c.args, {
      encoding: "utf8",
      timeout: 20_000,
      env: codexEnv(env),
      maxBuffer: 256 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const decision = (JSON.parse(out) as { decision?: unknown }).decision;
    return typeof decision === "string" ? decision : "none";
  } catch {
    return null;
  }
}

/** One `--json` line, as much of it as the daemon uses. */
export interface CodexPiece {
  /** `thread.started`: the session's id, which Codex chose. */
  session?: string;
  /** A finished `agent_message`: one part of the answer. */
  message?: string;
  /** `turn.completed` (or `turn.failed`). */
  done?: boolean;
  /** `turn.failed`: why. */
  failed?: string;
  /** A top-level `error` ("Reconnecting... 2/5"): transient, the reason only if the run then fails. */
  note?: string;
  /** An `error` item: a warning Codex printed and carried on after (hook trust, a clamped timeout). */
  warning?: string;
}

export function codexLine(line: string): CodexPiece | null {
  let j: {
    type?: unknown;
    thread_id?: unknown;
    message?: unknown;
    item?: { type?: unknown; text?: unknown; message?: unknown };
    error?: { message?: unknown };
  };
  try {
    j = JSON.parse(line);
  } catch {
    return null;
  }
  if (!j || typeof j !== "object") return null;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  switch (j.type) {
    case "thread.started":
      return str(j.thread_id) ? { session: str(j.thread_id) } : null;
    case "item.completed": {
      const it = j.item;
      if (it?.type === "agent_message" && str(it.text)) return { message: str(it.text) };
      if (it?.type === "error" && str(it.message)) return { warning: str(it.message) };
      return null;
    }
    case "turn.completed":
      return { done: true };
    case "turn.failed":
      return { done: true, failed: str(j.error?.message) || "Codex reported an error" };
    case "error":
      return str(j.message) ? { note: str(j.message) } : null;
    default:
      return null;
  }
}

/** A Codex run read as it streams: the answer is its finished agent messages. */
export class CodexReading implements Reading {
  session: string | null = null;
  lines = 0;
  readonly warnings: string[] = [];
  private readonly messages: string[] = [];
  private done = false;
  private failed: string | null = null;
  private note: string | null = null;

  get text(): string {
    return this.messages.join("\n\n");
  }

  feed(line: string): boolean {
    this.lines++;
    const p = codexLine(line);
    if (!p) return false;
    if (p.session && !this.session) this.session = p.session;
    if (p.note) this.note = p.note;
    if (p.warning && this.warnings.length < 20) this.warnings.push(p.warning);
    if (p.failed) this.failed = p.failed;
    if (p.done) this.done = true;
    if (p.message?.trim()) {
      this.messages.push(p.message.trim());
      return true;
    }
    return false;
  }

  /** A failure is `turn.failed`, or a run that exits non-zero having said nothing; an
   *  `error` item before a turn that then succeeds is only a warning. */
  outcome(res: RunResult): { failed: string } | { reply: string } {
    const broke = runFailure(LABEL, res);
    if (broke) return { failed: broke };
    if (this.failed) return { failed: this.failed };
    if (this.done || res.code === 0 || this.messages.length)
      return { reply: this.text || "(Codex finished without a written reply.)" };
    const why = this.note || codexStderr(res.stderr) || this.warnings.at(-1) || "";
    return { failed: `Codex exited (${res.signal || `code ${res.code}`}) without an answer${why ? `: ${why}` : ""}` };
  }
}

/** stderr's tail without the line Codex prints even with stdin closed. */
function codexStderr(stderr: string | undefined): string {
  return stderrTail(
    String(stderr || "")
      .split("\n")
      .filter((l) => !/^Reading additional input from stdin/.test(l.trim()))
      .join("\n"),
  );
}

export const reading = (): CodexReading => new CodexReading();
