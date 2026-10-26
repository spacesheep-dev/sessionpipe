// SPDX-License-Identifier: Apache-2.0
// Codex CLI (OpenAI) — control delivery (spec/CONTROL.md §6). Codex on this machine,
// as the control daemon needs it: which `codex` to run, with which sandbox flags, one
// headless turn (`codex exec --json` for a new session, `codex exec resume --json <id>`
// for the next message), and its JSONL output read as it streams. Codex picks a new
// session's id itself (the first line, `thread.started`), so the daemon names it after
// the command that started it (CONTROL.md §6 `start`). Shapes measured on codex-cli
// 0.160.0, 2026-10-04.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MODEL_RE, type RunLevel, type StartPermission } from "../control/verify.js";
import {
  findBinary,
  jobEnv,
  type Login,
  type Mode,
  type Reading,
  type RunResult,
  runFailure,
  stderrTail,
} from "./headless.js";

export { codexFacts, findRollout } from "./codex.js";

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
 *  The model is its own argument after `-m`. The prompt goes after `--`, so a message
 *  that starts with a dash is never a flag. */
export function codexArgs(o: {
  permission: RunLevel;
  prompt: string;
  cwd?: string;
  resume?: string;
  model?: string;
}): string[] {
  const common = ["--json", "--skip-git-repo-check"];
  const model = o.model ? ["-m", o.model] : [];
  if (o.resume)
    return ["exec", "resume", ...common, ...codexModeFlags(o.permission, true), ...model, "--", o.resume, o.prompt];
  return [
    "exec",
    ...common,
    ...(o.cwd ? ["-C", o.cwd] : []),
    ...codexModeFlags(o.permission),
    ...model,
    "--",
    o.prompt,
  ];
}

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
  return new Promise((resolve) => {
    execFile(
      bin,
      ["login", "status"],
      { encoding: "utf8", timeout: 20_000, env: codexEnv(env), maxBuffer: 256 * 1024 },
      (err) => {
        if (!err) return resolve({ loggedIn: true });
        const code = (err as { code?: unknown }).code;
        resolve(code === 1 ? { loggedIn: false } : { loggedIn: null });
      },
    );
  });
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
