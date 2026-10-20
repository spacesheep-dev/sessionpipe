// SPDX-License-Identifier: Apache-2.0
// One headless agent turn as a child process (spec/CONTROL.md §6): the spawner the
// control daemon runs every harness through, and the shape each harness's reading of
// its own output takes. Which binary, which flags and how the answer is read are the
// harness's own (`<harness>-control.ts`); what is the same for all of them is here.
import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

/** A headless turn still running after this is stopped. */
export const JOB_TIMEOUT_MS = 30 * 60_000;
const OUT_CAP = 1024 * 1024;

export type Mode = "safe" | "auto";

export function isExe(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** A harness's CLI: the override the person set (`SESSIONPIPE_<NAME>`), else the first
 *  of `names` on PATH, else the first of `dirs` that holds one. A launchd or systemd
 *  service starts with a short PATH, so the installers' own folders are looked in too. */
export function findBinary(o: {
  override?: string | undefined;
  names: string[];
  dirs: string[];
  env?: NodeJS.ProcessEnv;
}): string | null {
  if (o.override && isExe(o.override)) return o.override;
  for (const d of String(o.env?.PATH || "").split(path.delimiter)) {
    if (!d || !path.isAbsolute(d)) continue;
    for (const n of o.names) if (isExe(path.join(d, n))) return path.join(d, n);
  }
  for (const d of o.dirs) for (const n of o.names) if (isExe(path.join(d, n))) return path.join(d, n);
  return null;
}

/** The env every headless turn runs with: SESSIONPIPE_CONTROL_JOB tells the turn's own
 *  hooks that the daemon runs it, so its Stop hook never takes a message meant for a
 *  person's session (cli/src/hook.ts). */
export function jobEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, SESSIONPIPE_CONTROL_JOB: "1" };
}

/** Whether a harness is signed in, in its own words. `loggedIn: null` means it can't
 *  say (too old, or it didn't answer): never a reason to refuse. */
export interface Login {
  loggedIn: boolean | null;
  /** claude.ai, an API key, a long-lived token… as the harness names it. */
  method?: string;
  subscription?: string;
}

export interface RunResult {
  error?: string;
  code?: number | null;
  signal?: NodeJS.Signals | null;
  stdout?: string | null;
  tooBig?: boolean;
  stderr?: string;
  timedOut?: boolean;
}

export interface RunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Streaming: each stdout line as it arrives. Only the lines `keep` names are kept
   *  for the RunResult (none by default), so a long stream never hits the cap. */
  onLine?: (line: string) => void;
  keep?: (line: string) => boolean;
}

/** Run one headless turn in its own process group, stdin closed (Codex waits on an open
 *  one), holding at most 1 MB of stdout. */
export function runHeadless(bin: string, args: string[], o: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    let out: Buffer[] = [];
    let outLen = 0;
    let tooBig = false;
    let errTail = "";
    let timedOut = false;
    let settled = false;
    let child: import("node:child_process").ChildProcess;
    try {
      child = spawn(bin, args, {
        cwd: o.cwd,
        env: o.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (e) {
      resolve({ error: (e as Error).message });
      return;
    }
    const kill = (sig: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        try {
          child.kill(sig);
        } catch {}
      }
    };
    const keep = (line: string) => {
      if (!o.keep?.(line)) return;
      out = [Buffer.from(line)];
      outLen = line.length;
    };
    let partial = "";
    child.stdout?.on("data", (b: Buffer) => {
      if (o.onLine) {
        const chunk = partial + b.toString("utf8");
        const lines = chunk.split("\n");
        partial = lines.pop() as string;
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            o.onLine(line);
          } catch {}
          keep(line);
        }
        if (partial.length > OUT_CAP) partial = "";
        return;
      }
      if (tooBig) return;
      if (outLen + b.length > OUT_CAP) {
        tooBig = true;
        out = [];
        return;
      }
      out.push(b);
      outLen += b.length;
    });
    child.stderr?.on("data", (b: Buffer) => {
      errTail = (errTail + b.toString("utf8")).slice(-4000);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 10_000).unref();
    }, o.timeoutMs ?? JOB_TIMEOUT_MS);
    const result = (code: number | null, signal: NodeJS.Signals | null): RunResult => ({
      code,
      signal,
      stdout: tooBig ? null : Buffer.concat(out).toString("utf8"),
      tooBig,
      stderr: errTail,
      timedOut,
    });
    const finish = (r: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    child.on("error", (e) => finish({ error: e.message }));
    // A tool the agent left running can hold stdout open after the harness exits.
    child.on("exit", (code, signal) => setTimeout(() => finish(result(code, signal)), 2000).unref());
    child.on("close", (code, signal) => {
      // The last line may end without a newline: it is often the result itself.
      if (o.onLine && partial.trim()) {
        try {
          o.onLine(partial);
        } catch {}
        keep(partial);
        partial = "";
      }
      finish(result(code, signal));
    });
  });
}

/** A harness's output read as it streams: the session it names, the answer so far, and
 *  the outcome once the process is gone. One per run. */
export interface Reading {
  /** One stdout line. True when the answer so far changed. */
  feed(line: string): boolean;
  /** The session id the harness revealed (it picks its own), or null so far. */
  readonly session: string | null;
  /** The answer so far, whole. */
  readonly text: string;
  /** How many lines were fed. */
  readonly lines: number;
  outcome(res: RunResult): { failed: string } | { reply: string };
}

/** The last few lines a harness wrote to stderr, on one line. */
export function stderrTail(stderr: string | undefined, n = 3): string {
  return String(stderr || "")
    .trim()
    .split("\n")
    .slice(-n)
    .join(" ")
    .trim();
}

/** What a run that wasn't there to ask says about the actions it was refused. */
export function deniedNote(names: string[], count: number): string {
  if (!count) return "";
  return `\n\n(Not allowed on this machine, since nobody was there to approve: ${names.join(", ") || `${count} action(s)`}.)`;
}

/** A process that failed before or without its answer, in words. */
export function runFailure(label: string, res: RunResult): string | null {
  if (res.error) return `couldn't start ${label}: ${res.error}`;
  if (res.timedOut) return `${label} was still working after 30 minutes, so it was stopped`;
  return null;
}
