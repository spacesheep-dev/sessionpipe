// SPDX-License-Identifier: Apache-2.0
// Antigravity (Google) — control delivery (spec/CONTROL.md §6). Its CLI, `agy`, as the
// control daemon needs it: which `agy` to run, one headless turn (`agy -p … --output-
// format stream-json`, and `--conversation <id>` for the next message), and its stream
// read as it arrives. agy picks a new conversation's id itself (the `init` line) and
// starts a fresh one for an id it doesn't know, so the daemon names it after the
// command that started it (CONTROL.md §6 `start`). No transcript records the folder, so
// the daemon keeps that too. Shapes measured on agy 1.2.16, 2026-10-04.
import os from "node:os";
import path from "node:path";
import type { RunLevel, StartPermission } from "../control/verify.js";
import { deniedNote, findBinary, jobEnv, type Mode, type Reading, type RunResult, runFailure } from "./headless.js";

const LABEL = "Antigravity";

/** The `agy` to run: SESSIONPIPE_AGY, else on PATH, else where its installer puts it. */
export function findAgy(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string | null {
  return findBinary({
    override: env.SESSIONPIPE_AGY,
    names: process.platform === "win32" ? ["agy.exe", "agy.cmd"] : ["agy"],
    env,
    dirs: [path.join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"],
  });
}

/** Permission flags for a level. Safe: none — agy denies every tool call nobody is
 *  there to approve, and says which. Edits: `--mode accept-edits`, its widest, which is
 *  also what an auto machine's mode means for it. Inherit: none either, so agy runs as
 *  it would by itself. agy has no read-only mode known, so `read` is never offered and
 *  throws rather than run at safe. Never `--dangerously-skip-permissions`: no path here
 *  writes it. */
export function agyModeFlags(level: RunLevel): string[] {
  if (level === "read") throw new Error("Antigravity has no read-only mode");
  return level === "safe" || level === "inherit" ? [] : ["--mode", "accept-edits"];
}

/** The levels a start may ask agy for on a machine in `mode`: safe, and edits on an
 *  auto machine. */
export const offeredLevels = (mode: Mode): StartPermission[] => (mode === "auto" ? ["safe", "edits"] : ["safe"]);

/** What a start that names no level gets, said as what it is: edits on an auto machine,
 *  no flag on an inherit one. */
export const defaultLevel = (mode: Mode): RunLevel => (mode === "auto" ? "edits" : mode);

/** One headless turn in the folder it is spawned in. A message that starts with a dash
 *  would read as a flag after `-p`; a leading space keeps it the prompt. */
export function agyArgs(o: { permission: RunLevel; prompt: string; resume?: string }): string[] {
  const prompt = o.prompt.startsWith("-") ? ` ${o.prompt}` : o.prompt;
  return [
    ...(o.resume ? ["--conversation", o.resume] : []),
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    ...agyModeFlags(o.permission),
  ];
}

/** The env a headless turn runs with. */
export const agyEnv = (env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => jobEnv(env);

export interface AgyResult {
  status: string;
  response: string;
  error: string;
  denied: unknown[];
}

/** One stream-json line, as much of it as the daemon uses. */
export interface AgyPiece {
  /** The conversation's id, which agy chose (`init`, then every step and the result). */
  session?: string;
  /** Text an `agent_response` step wrote, and which step it belongs to. */
  delta?: { step: number; text: string };
  /** The final `result`. */
  result?: AgyResult;
  /** An `error_message` step's words: the reason only if the run then fails. */
  note?: string;
}

export function agyLine(line: string): AgyPiece | null {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(line);
  } catch {
    return null;
  }
  if (!j || typeof j !== "object") return null;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const out: AgyPiece = {};
  if (j.event === "init") {
    if (str(j.conversation_id)) out.session = str(j.conversation_id);
  } else if (j.event === "step_update") {
    const s = (j.step_update ?? {}) as Record<string, unknown>;
    if (str(s.conversation_id)) out.session = str(s.conversation_id);
    if (s.step_type === "agent_response" && str(s.text_delta))
      out.delta = { step: Number(s.step_index ?? 0), text: str(s.text_delta) };
    if (s.step_type === "error_message") {
      const why = str(s.text_delta) || str(s.error) || str(s.message);
      if (why) out.note = why;
    }
  } else if (j.event === "result") {
    const r = (j.result ?? {}) as Record<string, unknown>;
    if (str(r.conversation_id)) out.session = str(r.conversation_id);
    out.result = {
      status: str(r.status),
      response: str(r.response),
      error: str(r.error),
      denied: Array.isArray(r.denied_actions) ? r.denied_actions : [],
    };
  } else return null;
  return Object.keys(out).length ? out : null;
}

/** What agy names a denied action by, whatever shape the entry has. */
function deniedName(d: unknown): string | null {
  if (typeof d === "string") return d.slice(0, 80);
  if (!d || typeof d !== "object") return null;
  const o = d as Record<string, unknown>;
  for (const k of ["tool_name", "toolName", "name", "tool", "action", "type"])
    if (typeof o[k] === "string" && o[k]) return (o[k] as string).slice(0, 80);
  return null;
}

/** An `AGY_ERROR: {…}` agy may end stderr with, in words. */
export function agyError(stderr: string | undefined): string {
  const s = String(stderr || "");
  const i = s.lastIndexOf("AGY_ERROR:");
  if (i < 0) return "";
  const raw = s.slice(i + "AGY_ERROR:".length).trim();
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    for (const k of ["message", "error", "detail"]) if (typeof j[k] === "string" && j[k]) return j[k] as string;
  } catch {}
  return (raw.split("\n")[0] as string).slice(0, 300);
}

/** An agy run read as it streams: the answer is the agent_response steps' text, and the
 *  result's `response` once it comes. */
export class AgyReading implements Reading {
  session: string | null = null;
  lines = 0;
  private buf = "";
  private step: number | null = null;
  private result: AgyResult | null = null;
  private note: string | null = null;

  get text(): string {
    return this.buf;
  }

  feed(line: string): boolean {
    this.lines++;
    const p = agyLine(line);
    if (!p) return false;
    if (p.session && !this.session) this.session = p.session;
    if (p.note) this.note = p.note;
    if (p.result) this.result = p.result;
    if (!p.delta) return false;
    // A new response step after a tool step starts a new paragraph.
    if (this.step !== null && p.delta.step !== this.step && this.buf && !this.buf.endsWith("\n\n")) this.buf += "\n\n";
    this.step = p.delta.step;
    this.buf += p.delta.text;
    return true;
  }

  outcome(res: RunResult): { failed: string } | { reply: string } {
    const broke = runFailure(LABEL, res);
    if (broke) return { failed: broke };
    const r = this.result;
    if (!r) {
      const why = agyError(res.stderr) || this.note || "";
      return {
        failed: `Antigravity exited (${res.signal || `code ${res.code}`}) without an answer${why ? `: ${why}` : ""}`,
      };
    }
    if (r.status !== "SUCCESS")
      return { failed: r.error || agyError(res.stderr) || this.note || "Antigravity reported an error" };
    const names = [...new Set(r.denied.map(deniedName).filter((n): n is string => !!n))];
    const text = r.response.trim()
      ? r.response.trim()
      : this.buf.trim() || "(Antigravity finished without a written reply.)";
    return { reply: text + deniedNote(names, r.denied.length) };
  }
}

export const reading = (): AgyReading => new AgyReading();
