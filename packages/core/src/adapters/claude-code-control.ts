// SPDX-License-Identifier: Apache-2.0
// Claude Code (Anthropic) — control delivery (spec/CONTROL.md §6). Claude Code on
// this machine, as the control daemon needs it: which `claude` to
// run and with which permission flags, where a session's transcript is and which
// folder it runs in, whether a live process holds it, and running one headless
// turn (`claude -p --resume`, `--fork-session`, `--session-id`). Ported from the
// spacesheep CLI's machine listener (lib/machine.js, 1.22), which ran it in
// production first.
import { execFile, execFileSync } from "node:child_process";
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isExe,
  JOB_TIMEOUT_MS,
  type Login,
  type Mode,
  type RunOptions,
  type RunResult,
  runHeadless,
} from "./headless.js";

export { JOB_TIMEOUT_MS, type Login, type Mode, type RunResult };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A transcript someone else wrote this recently is in use. */
const LIVE_WRITE_MS = 90_000;

/** Dotted versions by number, a missing part as 0: 1.9.0 < 1.10 = 1.10.0. */
export const cmpVersion = (a: string, b: string) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++)
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};

/** The `claude` to run: on PATH, else where the installers put it, else the newest
 *  copy the desktop app ships. Null when this machine has none. */
export function findClaude(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string | null {
  if (env.SESSIONPIPE_CLAUDE && isExe(env.SESSIONPIPE_CLAUDE)) return env.SESSIONPIPE_CLAUDE;
  const names = process.platform === "win32" ? ["claude.exe", "claude.cmd"] : ["claude"];
  for (const d of String(env.PATH || "").split(path.delimiter)) {
    if (!d || !path.isAbsolute(d)) continue;
    for (const n of names) if (isExe(path.join(d, n))) return path.join(d, n);
  }
  for (const p of [
    path.join(home, ".claude", "local", "claude"),
    path.join(home, ".local", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ])
    if (isExe(p)) return p;
  const app = path.join(home, "Library", "Application Support", "Claude", "claude-code");
  let versions: string[] = [];
  try {
    versions = readdirSync(app)
      .filter((n) => /^\d+(\.\d+)*$/.test(n))
      .sort(cmpVersion)
      .reverse();
  } catch {}
  for (const v of versions) {
    const p = path.join(app, v, "claude.app", "Contents", "MacOS", "claude");
    if (isExe(p)) return p;
  }
  return null;
}

/** One option's text in `claude --help`: its line and the deeper-indented lines under it. */
function optionBlock(help: string, flag: string): string | null {
  const lines = help.split("\n");
  const re = new RegExp(`^\\s{0,4}(?:-\\w, )?${flag.replace(/-/g, "\\-")}(?![\\w-])`);
  const start = lines.findIndex((l) => re.test(l));
  if (start < 0) return null;
  const out = [lines[start] as string];
  for (let i = start + 1; i < lines.length && lines[i]?.trim() && !/^\s{0,4}-/.test(lines[i] as string); i++)
    out.push(lines[i] as string);
  return out.join(" ");
}

export interface Caps {
  hasMode: boolean;
  modes: string[];
  promptsNone: boolean;
  fork: boolean;
  /** `--output-format stream-json` with `--include-partial-messages`: the answer can be
   *  forwarded as it is written. Optional so older callers' literals still type. */
  stream?: boolean;
}

export function parseCaps(help: string): Caps {
  const pm = optionBlock(help, "--permission-mode");
  const pp = optionBlock(help, "--permission-prompts");
  return {
    hasMode: !!pm,
    modes: pm ? [...pm.matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1] as string) : [],
    promptsNone: !!pp && /"none"/.test(pp),
    fork: !!optionBlock(help, "--fork-session"),
    stream: !!optionBlock(help, "--include-partial-messages"),
  };
}

/** Permission flags for the machine's mode. Safe: `dontAsk` (nothing that needs
 *  approval runs). Auto: Claude Code's own auto mode, or a refusal. Never
 *  bypassPermissions — no path here writes it. */
export function modeFlags(mode: Mode, caps: Caps): { args: string[] } | { error: string } {
  if (mode === "auto") {
    if (!caps.modes.includes("auto"))
      return { error: "this machine is in auto mode, but its Claude Code has no auto permission mode" };
    return { args: ["--permission-mode", "auto"] };
  }
  if (caps.modes.includes("dontAsk")) return { args: ["--permission-mode", "dontAsk"] };
  const args: string[] = [];
  if (caps.hasMode)
    args.push(
      "--permission-mode",
      caps.modes.includes("manual") && !caps.modes.includes("default") ? "manual" : "default",
    );
  if (caps.promptsNone) args.push("--permission-prompts", "none");
  return { args };
}

/** The env a headless turn runs with: ours, minus the markers that make Claude Code
 *  think it runs inside another session, with CLAUDE_CONFIG_DIR naming the account. */
export function claudeEnv(configDir?: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const e = { ...env };
  for (const k of [
    "CLAUDECODE",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_HOST_SESSION_ID",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_SSE_PORT",
  ])
    delete e[k];
  e.SESSIONPIPE_CONTROL_JOB = "1";
  if (configDir !== undefined) {
    if (path.resolve(configDir) === path.resolve(os.homedir(), ".claude")) delete e.CLAUDE_CONFIG_DIR;
    else e.CLAUDE_CONFIG_DIR = configDir;
  }
  return e;
}

/** Whether Claude Code is signed in for one account, in Claude Code's own words
 *  (`claude auth status --json`). `loggedIn: null` means this Claude Code can't say
 *  (too old for `auth status`, or it didn't answer): never a reason to refuse. */
export function parseAuthStatus(stdout: string | null | undefined): Login {
  const text = String(stdout || "").trim();
  const start = text.indexOf("{");
  if (start < 0) return { loggedIn: null };
  try {
    const j = JSON.parse(text.slice(start)) as Record<string, unknown>;
    if (typeof j.loggedIn !== "boolean") return { loggedIn: null };
    return {
      loggedIn: j.loggedIn,
      ...(typeof j.authMethod === "string" ? { method: j.authMethod } : {}),
      ...(typeof j.subscriptionType === "string" ? { subscription: j.subscriptionType } : {}),
    };
  } catch {
    return { loggedIn: null };
  }
}

/** Ask Claude Code whether the account in `configDir` (the default one when omitted)
 *  is signed in, from this process — which is the point: a login kept in the macOS
 *  keychain is readable from the screen's own session and not from a background
 *  service on a Mac nobody is logged in to, or from an ssh shell, so a headless turn
 *  started there dies with "please run /login". */
export function claudeLogin(bin: string, configDir?: string, env: NodeJS.ProcessEnv = process.env): Promise<Login> {
  return new Promise((resolve) => {
    execFile(
      bin,
      ["auth", "status", "--json"],
      { encoding: "utf8", timeout: 20_000, env: claudeEnv(configDir, env), maxBuffer: 256 * 1024 },
      // `auth status` may exit non-zero when signed out; its JSON still says so.
      (_err, stdout) => resolve(parseAuthStatus(stdout)),
    );
  });
}

/** The command that signs one account in, quoted for a sentence. */
export function loginCommand(configDir: string | undefined): string {
  const home = os.homedir();
  const isDefault = !configDir || path.resolve(configDir) === path.resolve(home, ".claude");
  return isDefault ? "`claude auth login`" : `\`CLAUDE_CONFIG_DIR=${configDir.replace(home, "~")} claude auth login\``;
}

/** What to tell the person when an account isn't signed in for the daemon. */
export function loginHint(configDir: string | undefined, platform: NodeJS.Platform = process.platform): string {
  const shown = configDir ? configDir.replace(os.homedir(), "~") : "~/.claude";
  const login = loginCommand(configDir);
  if (platform === "darwin")
    return `Claude Code (${shown}) isn't signed in as this machine's background service sees it. On a Mac its login lives in the login keychain, which a background service can read only while someone is logged in at the screen: log in at the Mac, or run ${login} there.`;
  return `Claude Code (${shown}) isn't signed in on this machine: run ${login} there.`;
}

export function detectCaps(bin: string): Caps {
  let help = "";
  try {
    help = execFileSync(bin, ["--help"], {
      encoding: "utf8",
      timeout: 30_000,
      env: claudeEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (e) {
    help = String((e as { stdout?: string })?.stdout || "");
  }
  return parseCaps(help);
}

export interface Transcript {
  file: string;
  configDir: string;
  project: string;
}

/** <config dir>/projects/<folder>/<session>.jsonl in any Claude Code config dir. */
export function findTranscript(session: string, dirs: string[]): Transcript | null {
  if (!UUID_RE.test(session)) return null;
  for (const dir of dirs) {
    let projects: import("node:fs").Dirent[] = [];
    try {
      projects = readdirSync(path.join(dir, "projects"), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const p of projects) {
      if (!p.isDirectory()) continue;
      const file = path.join(dir, "projects", p.name, `${session}.jsonl`);
      try {
        if (statSync(file).isFile()) return { file, configDir: dir, project: p.name };
      } catch {}
    }
  }
  return null;
}

const projectName = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

/** The folder a session runs in, from its transcript's own records (never from a
 *  command): the `cwd` whose project name is the folder the transcript is filed
 *  under, else the first `cwd`. Streams; a line over 2 MB is skipped. */
export function sessionFolder(t: Transcript, cap = 8 * 1024 * 1024): string | null {
  let first: string | null = null;
  let count = 0;
  let fd: number | undefined;
  const look = (line: Buffer): string | null => {
    if (line.indexOf('"cwd"') < 0) return null;
    let j: { cwd?: unknown };
    try {
      j = JSON.parse(line.toString("utf8"));
    } catch {
      return null;
    }
    if (!j || typeof j.cwd !== "string" || !path.isAbsolute(j.cwd)) return null;
    if (projectName(j.cwd) === t.project) return j.cwd;
    first ??= j.cwd;
    count++;
    return null;
  };
  try {
    fd = openSync(t.file, "r");
    const buf = Buffer.alloc(256 * 1024);
    let pos = 0;
    let rest = Buffer.alloc(0);
    let skipping = false;
    while (pos < cap && count < 50) {
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (!n) {
        if (!skipping && rest.length) {
          const hit = look(rest);
          if (hit) return hit;
        }
        break;
      }
      pos += n;
      let chunk = rest.length ? Buffer.concat([rest, buf.subarray(0, n)]) : buf.subarray(0, n);
      let nl = chunk.indexOf(10);
      while (nl >= 0) {
        const line = chunk.subarray(0, nl);
        chunk = chunk.subarray(nl + 1);
        if (skipping) skipping = false;
        else {
          const hit = look(line);
          if (hit) return hit;
        }
        nl = chunk.indexOf(10);
      }
      if (chunk.length > 2 * 1024 * 1024) {
        skipping = true;
        rest = Buffer.alloc(0);
      } else rest = skipping ? Buffer.alloc(0) : Buffer.from(chunk);
    }
  } catch {
  } finally {
    if (fd !== undefined)
      try {
        closeSync(fd);
      } catch {}
  }
  return first;
}

function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === "EPERM";
  }
}

/** A Claude Code process holds this session right now: its registry file,
 *  <config>/sessions/<pid>.json, names it and the pid is alive (interactive and
 *  Agent SDK sessions both file one). */
export function liveProcess(session: string, configDir: string): boolean {
  let names: string[] = [];
  try {
    names = readdirSync(path.join(configDir, "sessions")).filter((n) => /^\d+\.json$/.test(n));
  } catch {
    return false;
  }
  for (const n of names) {
    try {
      const j = JSON.parse(readFileSync(path.join(configDir, "sessions", n), "utf8")) as {
        sessionId?: unknown;
        pid?: unknown;
      };
      if (String(j.sessionId) !== session) continue;
      if (pidAlive(Number(j.pid ?? n.slice(0, -5)))) return true;
    } catch {}
  }
  return false;
}

/** Written in the last 90 s, and not by a job of ours. */
export function recentlyWritten(file: string, ourLastEnd?: number, now = Date.now()): boolean {
  let m: number;
  try {
    m = statSync(file).mtimeMs;
  } catch {
    return false;
  }
  if (now - m > LIVE_WRITE_MS) return false;
  return !(ourLastEnd && m <= ourLastEnd + 2000);
}

/** Run one headless turn (headless.ts). Streaming (`--output-format stream-json`), only
 *  the `result` line is kept for the RunResult unless the caller says otherwise. */
export function runClaude(bin: string, args: string[], o: RunOptions): Promise<RunResult> {
  return runHeadless(bin, args, { ...o, keep: o.keep ?? ((line) => line.includes('"type":"result"')) });
}

export interface ClaudeResult {
  type?: string;
  result?: unknown;
  is_error?: boolean;
  subtype?: string;
  session_id?: unknown;
  permission_denials?: { tool_name?: unknown }[];
}

/** `--output-format json`: one result object, or an array whose last `result` entry it is. */
export function parseResult(stdout: string | null | undefined): ClaudeResult | null {
  const s = String(stdout || "").trim();
  if (!s) return null;
  const pick = (j: unknown): ClaudeResult | null => {
    if (Array.isArray(j)) {
      for (let i = j.length - 1; i >= 0; i--) if (j[i]?.type === "result") return j[i];
      return null;
    }
    return j && typeof j === "object" ? (j as ClaudeResult) : null;
  };
  try {
    return pick(JSON.parse(s));
  } catch {}
  const lines = s.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const j = pick(JSON.parse(lines[i] as string));
      if (j && (j.type === "result" || "result" in j)) return j;
    } catch {}
  }
  return null;
}

export const isUuid = (s: unknown): s is string => typeof s === "string" && UUID_RE.test(s);
