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
import { levelRank, type RunLevel, START_PERMISSIONS, type StartPermission } from "../control/verify.js";
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

/** The `--permission-mode` each level (CONTROL.md §3.1) is, where it is one mode. */
const LEVEL_MODE: Record<Exclude<StartPermission, "safe">, string> = {
  read: "plan",
  edits: "acceptEdits",
  auto: "auto",
};

/** Permission flags for a level (a machine's mode is one: safe, auto, inherit). Read:
 *  plan mode. Safe: `dontAsk` (nothing that needs approval runs). Edits: acceptEdits.
 *  Auto: Claude Code's own auto mode. Inherit: none, so the turn starts in the mode
 *  Claude Code picks by itself here, its settings' `permissions.defaultMode` (a resume
 *  too: Claude Code never restores a session's earlier mode). A level this Claude Code
 *  has no mode for is a refusal, never another level. Never bypassPermissions — no path
 *  here writes it. */
export function modeFlags(level: RunLevel, caps: Caps): { args: string[] } | { error: string } {
  if (level === "inherit") return { args: [] };
  if (level === "auto" && !caps.modes.includes("auto"))
    return { error: "this machine is in auto mode, but its Claude Code has no auto permission mode" };
  if (level !== "safe") {
    const m = LEVEL_MODE[level];
    if (!caps.modes.includes(m)) return { error: `this machine's Claude Code has no ${m} permission mode` };
    return { args: ["--permission-mode", m] };
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

/** The widest level a start may name on a machine in `mode`: the mode itself, and safe
 *  on an inherit machine, whose own default sessionpipe can't rank, so a message there may
 *  only narrow to a level that never runs anything needing approval. */
export const ceilingLevel = (mode: Mode): StartPermission => (mode === "inherit" ? "safe" : mode);

/** The levels a start may ask Claude Code for on a machine in `mode`: never above its
 *  ceiling, and each only where `claude --help` lists the mode it maps to (safe always). */
export function offeredLevels(mode: Mode, caps: Caps): StartPermission[] {
  return START_PERMISSIONS.filter(
    (l) => levelRank(l) <= levelRank(ceilingLevel(mode)) && (l === "safe" || caps.modes.includes(LEVEL_MODE[l])),
  );
}

/** What a start that names no level gets: what the machine's mode means for Claude Code. */
export const defaultLevel = (mode: Mode): RunLevel => mode;

/** How a headless run prints: streamed where this Claude Code can, else one JSON at the end. */
export function outputArgs(caps: { stream?: boolean }): string[] {
  return caps.stream
    ? ["--output-format", "stream-json", "--verbose", "--include-partial-messages"]
    : ["--output-format", "json"];
}

/** One headless `claude -p` run: a new session (`session`), or the next message of one
 *  (`resume`, optionally as a fork). The model is its own argument after `--model`, and
 *  a prompt that starts with a dash gets a leading space, so it is never read as a flag. */
export function claudeArgs(o: {
  caps: Caps;
  level: RunLevel;
  prompt: string;
  session?: string;
  resume?: string;
  fork?: boolean;
  model?: string;
  allowedTools?: string[];
}): { args: string[] } | { error: string } {
  const mf = modeFlags(o.level, o.caps);
  if ("error" in mf) return mf;
  const where = o.resume
    ? ["--resume", o.resume, ...(o.fork ? ["--fork-session"] : [])]
    : ["--session-id", o.session as string];
  return {
    args: [
      "-p",
      ...outputArgs(o.caps),
      ...mf.args,
      ...(o.model ? ["--model", o.model] : []),
      ...(o.allowedTools?.length ? [`--allowedTools=${o.allowedTools.join(",")}`] : []),
      ...where,
      o.prompt.startsWith("-") ? ` ${o.prompt}` : o.prompt,
    ],
  };
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

/** <config dir>/projects/<folder>/<session>.jsonl in one Claude Code config dir. */
function transcriptIn(session: string, dir: string): Transcript | null {
  let projects: import("node:fs").Dirent[] = [];
  try {
    projects = readdirSync(path.join(dir, "projects"), { withFileTypes: true });
  } catch {
    return null;
  }
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const file = path.join(dir, "projects", p.name, `${session}.jsonl`);
    try {
      if (statSync(file).isFile()) return { file, configDir: dir, project: p.name };
    } catch {}
  }
  return null;
}

/** <config dir>/projects/<folder>/<session>.jsonl in any Claude Code config dir. */
export function findTranscript(session: string, dirs: readonly string[]): Transcript | null {
  if (!UUID_RE.test(session)) return null;
  for (const dir of dirs) {
    const t = transcriptIn(session, dir);
    if (t) return t;
  }
  return null;
}

/** Every config dir that holds this session's transcript, in the order given. One
 *  session id can be filed in several accounts: a transcript copied between homes, the
 *  same id resumed under another account. There were six such ids on one Mac in
 *  October 2026, and picking the first — which is what reading one home does — put a
 *  message into an account that was signed out. */
export function findTranscripts(session: string, dirs: readonly string[]): Transcript[] {
  if (!UUID_RE.test(session)) return [];
  const out: Transcript[] = [];
  for (const dir of dirs) {
    const t = transcriptIn(session, dir);
    if (t) out.push(t);
  }
  return out;
}

/** Which Claude Code account a session belongs to, when more than one has its
 *  transcript: the one whose own `sessions/` says a live process holds it. `ambiguous`
 *  — nothing live, or two homes live — is a refusal rather than a guess, and names the
 *  homes by their directory name alone, since an ack travels to the receiver. Null when
 *  no home holds the session at all. */
export type HomeChoice = { transcript: Transcript } | { ambiguous: string[] };

export function resolveHome(session: string, dirs: readonly string[]): HomeChoice | null {
  const all = findTranscripts(session, dirs);
  if (!all.length) return null;
  if (all.length === 1) return { transcript: all[0] as Transcript };
  const live = all.filter((t) => liveRecords(session, t.configDir).length > 0);
  if (live.length === 1) return { transcript: live[0] as Transcript };
  return { ambiguous: [...new Set(all.map((t) => path.basename(t.configDir)))].sort() };
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

/** One live Claude Code process's registry row, `<config>/sessions/<pid>.json`, as the
 *  in-place `inbox` lane needs it (spec/CONTROL.md §6.3). Every session that registers
 *  files one — a terminal window, the desktop app and a claude.ai bridge worker alike,
 *  all of them `kind: "interactive"`; a `-p` one-shot's row is not one of those. */
export interface LiveRecord {
  /** The config dir this row was read from: the lane never crosses accounts. */
  configDir: string;
  file: string;
  pid: number;
  /** Claude Code's own local inbox for this process, or null when it published none. */
  socket: string | null;
  /** 1 is the only inbox protocol this code speaks; anything else is refused. */
  peerProtocol: number | null;
  /** The process's start time as the registry spells it (UTC), so a recycled pid can be
   *  told from the process that filed the row. */
  procStart: string | null;
  status: string | null;
  /** `interactive` for a session the harness holds open for the person. */
  kind: string | null;
  entrypoint: string | null;
  /** `<pid>.<sha>.key`, 0600: where the inbox's auth token lives (needed off macOS). */
  keyFile: string | null;
}

const registryRow = (file: string, configDir: string, j: Record<string, unknown>): LiveRecord => {
  const pid = Number(j.pid ?? path.basename(file).slice(0, -5));
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  let keyFile: string | null = null;
  try {
    // Claude Code's own spelling: `<pid>.<64 hex>.key`, 0600, beside the registry row.
    const want = new RegExp(`^${pid}\\.[0-9a-f]{64}\\.key$`);
    const hit = readdirSync(path.dirname(file)).find((n) => want.test(n));
    if (hit) keyFile = path.join(path.dirname(file), hit);
  } catch {}
  return {
    configDir,
    file,
    pid,
    socket: str(j.messagingSocketPath),
    peerProtocol: typeof j.peerProtocol === "number" ? j.peerProtocol : null,
    procStart: str(j.procStart),
    status: str(j.status),
    kind: str(j.kind),
    entrypoint: str(j.entrypoint),
    keyFile,
  };
};

/** Every live registry row for this session, across the config dirs given. A row whose
 *  pid is gone is not one: the file outlives the process. */
export function liveRecords(session: string, dirs: string | readonly string[]): LiveRecord[] {
  const out: LiveRecord[] = [];
  for (const dir of typeof dirs === "string" ? [dirs] : dirs) {
    let names: string[] = [];
    try {
      names = readdirSync(path.join(dir, "sessions")).filter((n) => /^\d+\.json$/.test(n));
    } catch {
      continue;
    }
    for (const n of names) {
      const file = path.join(dir, "sessions", n);
      let j: Record<string, unknown>;
      try {
        j = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (String(j.sessionId) !== session) continue;
      const row = registryRow(file, dir, j);
      if (pidAlive(row.pid)) out.push(row);
    }
  }
  return out;
}

/** The ONE live process that holds this session, or null. Two rows — two accounts, or
 *  two processes in one — is a refusal rather than a guess: a lane that writes into a
 *  live session has to know which process it is writing to (spec/CONTROL.md §6.3). */
export function liveRecord(session: string, dirs: string | readonly string[]): LiveRecord | null {
  const all = liveRecords(session, dirs);
  return all.length === 1 ? (all[0] as LiveRecord) : null;
}

/** A Claude Code process holds this session right now: its registry file,
 *  <config>/sessions/<pid>.json, names it and the pid is alive (interactive and
 *  Agent SDK sessions both file one). */
export function liveProcess(session: string, configDir: string): boolean {
  return liveRecords(session, configDir).length > 0;
}

/** Claude Code's own permission modes, narrowest first (its own order, 2.1.310).
 *  `plan` asks for everything and writes nothing; `bypassPermissions` asks for nothing.
 *  Used to tell one mode from another and to compare two, never to pick one. */
export const CLAUDE_MODES = ["plan", "default", "manual", "dontAsk", "acceptEdits", "auto", "bypassPermissions"];
export const modeRank = (m: string | null | undefined): number => (m ? CLAUDE_MODES.indexOf(m) : -1);

/** The permission mode a hook payload reports for its own session, or null. Claude Code
 *  writes `permission_mode` on every hook payload; `permissionMode` is the spelling its
 *  transcript records use, and is read too so one reader serves both.
 *
 *  This is the only place a mode the person chose at the keyboard can be read from: a
 *  session's registry row doesn't carry it, and the transcript names it only on turns
 *  that happen to record one. hook.ts repeats the shape test, because it imports nothing
 *  but node builtins. */
export function hookMode(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as { permission_mode?: unknown; permissionMode?: unknown };
  const v = typeof p.permission_mode === "string" ? p.permission_mode : p.permissionMode;
  return typeof v === "string" && CLAUDE_MODES.includes(v) ? v : null;
}

/** The permission class Claude Code's own inbox checks a sender's declared class
 *  against (2.1.310): `bypassPermissions` is `bypass`; a mode that prompts before it
 *  acts is `prompting`. `plan` is neither — its class there depends on a capability and
 *  a TTY this code cannot see — and nor is `auto`, nor a mode nothing has recorded, so
 *  those get no in-place lane at all (spec/CONTROL.md §6.3). */
export function peerClass(mode: string | null | undefined): "bypass" | "prompting" | null {
  if (mode === "bypassPermissions") return "bypass";
  if (mode === "default" || mode === "manual" || mode === "dontAsk" || mode === "acceptEdits") return "prompting";
  return null;
}

/** One Claude Code account's permission settings, user scope only
 *  (`<config dir>/settings.json`): a folder's own settings may tighten these but never
 *  loosen them, and a managed policy may tighten them further. Only the three keys
 *  something here acts on.
 *
 *  Reading user scope alone can overstate how wide a home is, never understate it, and
 *  everything that reads this treats a wider answer as a reason NOT to act (the inbox
 *  lane needs the machine's class to equal the session's own; a narrowing is re-asserted
 *  only where the home's default is at least as wide). */
export interface HomeSettings {
  /** `permissions.defaultMode`: what a session with no flag starts in. Null: not said,
   *  or the file could not be read. */
  defaultMode: string | null;
  /** `disableAutoMode: "disable"`: asking for auto mode quietly gives Manual instead. */
  disableAutoMode: boolean;
  /** `disableBypassPermissionsMode: "disable"`: this home cannot be in bypass at all. */
  disableBypass: boolean;
}

export const NO_HOME_SETTINGS: HomeSettings = { defaultMode: null, disableAutoMode: false, disableBypass: false };

export function homeSettings(configDir: string | undefined, home = os.homedir()): HomeSettings {
  const file = path.join(configDir ?? path.join(home, ".claude"), "settings.json");
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return { ...NO_HOME_SETTINGS };
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) return { ...NO_HOME_SETTINGS };
  const p = (j.permissions && typeof j.permissions === "object" ? j.permissions : {}) as Record<string, unknown>;
  // Both spellings: Claude Code reads these two under `permissions`, and settings
  // written by hand (and its own older docs) put them at the top level.
  const off = (k: string) => j[k] === "disable" || p[k] === "disable";
  return {
    defaultMode: typeof p.defaultMode === "string" && CLAUDE_MODES.includes(p.defaultMode) ? p.defaultMode : null,
    disableAutoMode: off("disableAutoMode"),
    disableBypass: off("disableBypassPermissionsMode"),
  };
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
