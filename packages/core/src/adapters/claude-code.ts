// SPDX-License-Identifier: Apache-2.0
// Claude Code (Anthropic) — docs: https://code.claude.com/docs/en/hooks
// Config: settings.json in EVERY config dir (~/.claude, $CLAUDE_CONFIG_DIR, ~/.claude-*):
// one per account; hooks written to one never fire for the others. Reads only the
// hook's stdin, the transcript it names, the per-pid session registry and the config
// dir's .claude.json account (its id; its email only for control's pair and hello) —
// or, with no login there, the API its settings.json names (that one key, no token).
// The one exception is the person's to make: with `remote_titles` on, the sign-in
// token is read to ask claude.ai for a session's name, and sent nowhere else.
// Ported from spacesheep-cli lib/sessions.js.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";
import { homeDir } from "../paths.js";
import { ends, parseLines, recentFiles, scanLines } from "../readers/files.js";
import { gitFacts } from "../readers/git.js";
import { isInjected, readClaude } from "../readers/transcripts.js";
import type { DataOf, HarnessAccount } from "../types.js";
import {
  formatJson,
  installClaudeShaped,
  installedClaudeShaped,
  OURS,
  readJson,
  readJsonFile,
  uninstallClaudeShaped,
} from "./claude-shaped.js";
import type {
  Adapter,
  BackfillRow,
  FactsState,
  HookCommand,
  HookInput,
  HookResult,
  InstallOptions,
  InstallReport,
  SessionFacts,
} from "./types.js";

const NAME = "claude-code";
export const CLAUDE_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "Notification",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "SessionEnd",
  "StopFailure",
] as const;
/** With no sink above tier 0 only the heartbeat needs a tool event: one, not three (issue #12). */
const LEAN_SKIP = new Set(["PreToolUse", "PostToolUseFailure"]);
const eventsFor = (lean?: boolean) => (lean ? CLAUDE_EVENTS.filter((e) => !LEAN_SKIP.has(e)) : [...CLAUDE_EVENTS]);
const OPTS = {
  matcherFor: (e: string) => (/Tool|Permission/.test(e) ? "" : undefined),
  timeout: 5,
  // The hook waits up to 125 s for a verified control answer, and only when control
  // is paired on this machine; everywhere else it exits in milliseconds as before.
  timeoutFor: (e: string) => (e === "PermissionRequest" ? 130 : undefined),
};
const DESKTOP_ID = /^local_[A-Za-z0-9-]{1,64}$/;

/** Every Claude Code config dir on this machine. `home` follows the env's HOME, so a
 *  caller with its own env (a test) never reaches the real ~/.claude: the install test
 *  once rewrote a real settings.json with its fake hook paths on every run. */
export function claudeDirs(env: NodeJS.ProcessEnv = process.env, home = env.HOME || homeDir()): string[] {
  const out: string[] = [];
  const add = (d?: string) => {
    if (!d) return;
    const r = path.resolve(d);
    if (!out.includes(r)) out.push(r);
  };
  add(path.join(home, ".claude"));
  add(env.CLAUDE_CONFIG_DIR);
  try {
    for (const e of readdirSync(home, { withFileTypes: true })) {
      if (!e.isDirectory() || !/^\.claude[-_.]/.test(e.name)) continue;
      const d = path.join(home, e.name);
      if (existsSync(path.join(d, "projects")) || existsSync(path.join(d, "settings.json"))) add(d);
    }
  } catch {}
  return out.filter((d, i) => i === 0 || existsSync(d));
}
const settingsIn = (dir: string) => path.join(dir, "settings.json");
const configDirOf = (transcript: string) => path.dirname(path.dirname(path.dirname(transcript)));

const validTool = (n: unknown): n is string => typeof n === "string" && /^[A-Za-z0-9_.:-]{1,120}$/.test(n);
const endReason = (r: unknown): "clear" | "logout" | "exit" | "other" =>
  r === "clear" || r === "logout" || r === "exit" ? r : r === "prompt_input_exit" ? "exit" : "other";
const notifKind = (t: unknown): "permission" | "question" | "elicitation" | "idle" | "error" =>
  t === "permission_prompt"
    ? "permission"
    : t === "idle_prompt"
      ? "idle"
      : t === "elicitation_dialog"
        ? "elicitation"
        : "question";

export const claudeCode: Adapter = {
  name: NAME,
  events: CLAUDE_EVENTS,
  detect: (env = process.env) => claudeDirs(env).some((d) => existsSync(d)),
  configFiles: (env = process.env) => claudeDirs(env).map(settingsIn),
  install: (cmd, env = process.env, opts: InstallOptions = {}) =>
    claudeDirs(env).flatMap((d) => {
      const hooks = installClaudeShaped(settingsIn(d), NAME, eventsFor(opts.lean), cmd, OPTS);
      const line = opts.statusLine === undefined ? null : statusLine(settingsIn(d), opts.statusLine, cmd);
      return line ? [hooks, line] : [hooks];
    }),
  uninstall: (env = process.env, opts: InstallOptions = {}) =>
    claudeDirs(env).map((d) => {
      const line = statusLine(settingsIn(d), false);
      const hooks = uninstallClaudeShaped(settingsIn(d), CLAUDE_EVENTS, {
        created: opts.created?.includes(settingsIn(d)),
      });
      return line && !hooks.changed ? line : hooks;
    }),
  installed: (cmd, env = process.env, opts: InstallOptions = {}) =>
    claudeDirs(env).map((d) => ({
      file: settingsIn(d),
      state: installedClaudeShaped(settingsIn(d), NAME, eventsFor(opts.lean), cmd, OPTS),
    })),

  fromHook(input: HookInput): HookResult | null {
    const event = input.argv[1] ?? "";
    let s: Record<string, unknown> = {};
    try {
      // A stdin that is JSON but not an object (`null`, a number) is no payload.
      const j: unknown = input.stdin ? JSON.parse(input.stdin) : {};
      if (j && typeof j === "object" && !Array.isArray(j)) s = j as Record<string, unknown>;
    } catch {}
    const id = (s.session_id ?? s.sessionId) as string | undefined;
    if (!id) return null;
    if (notClaudeCode(String(id), s)) return null;
    const session: HookResult["session"] = { id: String(id), cwd: typeof s.cwd === "string" ? s.cwd : input.cwd };
    if (typeof s.model === "string") session.model = s.model;
    if (typeof s.agent_id === "string" && event.startsWith("Subagent") === false && s.agent_id)
      session.parent_id = null;
    const turn_id = typeof s.prompt_id === "string" ? s.prompt_id : undefined;
    const tool = validTool(s.tool_name) ? s.tool_name : undefined;
    const call_id = typeof s.tool_use_id === "string" ? s.tool_use_id : undefined;
    const ms = typeof s.duration_ms === "number" ? Math.round(s.duration_ms) : undefined;
    const agent_id = typeof s.agent_id === "string" ? s.agent_id : undefined;
    // PermissionRequest carries no tool_use_id (recorded 2026-09-28): the id is a hash
    // of the prompt, the tool and its input, so the same prompt yields the same id and
    // a later control answer can name it.
    const permissionId = () =>
      `perm-${createHash("sha256")
        .update(`${turn_id ?? ""}|${tool ?? ""}|${JSON.stringify(s.tool_input ?? null)}`)
        .digest("hex")
        .slice(0, 16)}`;
    const ev = (type: string, data: Record<string, unknown>) => ({ type, data: prune(data), harnessEvent: event });
    const events: HookResult["events"] = [];
    switch (event) {
      case "SessionStart":
        events.push(ev("session.started", { source: pickSource(s.source ?? s.trigger) }));
        break;
      case "UserPromptSubmit": {
        // Only a string prompt is read; anything else is left unread rather than guessed at.
        const prompt = typeof s.prompt === "string" ? s.prompt : undefined;
        events.push(
          ev("turn.started", {
            turn_id,
            prompt_chars: prompt === undefined ? undefined : [...prompt].length,
            // Claude Code's hook schema documents `source`
            // (user | sdk | system | loop_wakeup | schedule_wakeup | poll_event) and says a
            // payload may omit it while the field rolls out; 2.1.304's payload has no such
            // key at all. Forwarded verbatim, shape-guarded only: the list is the harness's
            // to extend.
            submitted_by: harnessWord(s.source),
            // One of Claude Code's own prompt wrappers: the prompt is a block the harness
            // wrote, so it is not the person's words. Absent is unknown, never "the person" —
            // and `true` is never "no person caused this turn", because a Talk or
            // `sessionpipe wait` delivery hands the person's own message over inside a
            // <task-notification> (PROTOCOL.md §4).
            injected: prompt !== undefined && injectedBlock(prompt) ? true : undefined,
          }),
        );
        break;
      }
      case "PreToolUse":
        if (tool) events.push(ev("tool.started", { tool, call_id, turn_id, agent_id, input: s.tool_input }));
        break;
      case "PostToolUse":
        if (tool)
          events.push(
            ev("tool.ended", {
              tool,
              call_id,
              turn_id,
              agent_id,
              ms,
              ok: true,
              input: s.tool_input,
              output: s.tool_response,
            }),
          );
        break;
      case "PostToolUseFailure":
        if (tool)
          events.push(
            ev("tool.ended", {
              tool,
              call_id,
              turn_id,
              agent_id,
              ms,
              ok: false,
              error: errText(s.error ?? s.tool_response),
              input: s.tool_input,
              output: s.tool_response,
            }),
          );
        break;
      case "PermissionRequest":
        events.push(
          ev("attention.needed", {
            attention_id: call_id ?? permissionId(),
            kind: "permission",
            tool,
            message: tool ? `${tool}${describe(s.tool_input)}` : undefined,
          }),
        );
        break;
      case "Notification":
        events.push(
          ev("attention.needed", {
            attention_id: `notif-${Date.now()}`,
            kind: notifKind(s.notification_type),
            message: typeof s.message === "string" ? s.message.slice(0, 200) : undefined,
          }),
        );
        break;
      case "Stop":
        // In-flight background work (shell commands, monitors, subagents, workflows)
        // that will wake the session when it finishes: a paused session, not a done one
        // (Claude Code's `background_tasks`, in every Stop recorded since 2.1.258). A count, never what they run.
        events.push(
          ev("turn.ended", {
            turn_id,
            reason: "stop",
            background: Array.isArray(s.background_tasks) ? s.background_tasks.length : undefined,
          }),
        );
        break;
      case "StopFailure":
        // The turn ended on an API error (rate_limit, overloaded, authentication_failed,
        // server_error …); the payload key is `error` (issue #10, recorded 2026-09-28).
        events.push(
          ev("turn.ended", {
            turn_id,
            reason: "error",
            error: typeof s.error === "string" ? s.error.slice(0, 200) : undefined,
          }),
        );
        break;
      case "SubagentStart":
        events.push(
          ev("subagent.started", {
            agent_id: String(s.agent_id ?? ""),
            agent_type: typeof s.agent_type === "string" ? s.agent_type : undefined,
          }),
        );
        break;
      case "SubagentStop":
        events.push(
          ev("subagent.ended", {
            agent_id: String(s.agent_id ?? ""),
            agent_type: typeof s.agent_type === "string" ? s.agent_type : undefined,
          }),
        );
        break;
      case "PreCompact":
        events.push(ev("context.compacted", { trigger: s.trigger === "manual" ? "manual" : "auto" }));
        break;
      case "PostCompact":
        break; // PreCompact already said it; a second event would double-count
      case "SessionEnd":
        events.push(ev("session.ended", { reason: endReason(s.reason) }));
        break;
      case "StatusLine": {
        // Not a hook: our status line command (install --status-line), which hook.ts
        // hands on only when the limits changed.
        const limits = claudeLimits(s.rate_limits);
        if (!limits) return null;
        events.push(ev("limits.observed", limits));
        break;
      }
      default:
        return null;
    }
    const hints: Record<string, unknown> = {};
    // The prompt, for the turn's first turn.progress: the transcript may not hold it
    // yet when the worker runs. Never an event field of its own (tier 2 carries it).
    if (event === "UserPromptSubmit" && typeof s.prompt === "string") hints.prompt = s.prompt;
    const host = input.env.CLAUDE_CODE_HOST_SESSION_ID;
    if (host && DESKTOP_ID.test(host)) hints.desktop_id = host;
    // Whether a person attends the session, in Claude Code's own word ("1" or "0" in a hook's
    // environment); a turn the control daemon runs on the person's signed message is theirs.
    // facts() turns it into session.attended once it knows whether the session has a link.
    const attended = input.env.CLAUDE_CODE_SESSION_ATTENDED;
    if (attended === "1" || attended === "0") hints.attended = attended === "1" || !!input.env.SESSIONPIPE_CONTROL_JOB;
    // The registry file is found while the process tree stands (the detached
    // worker's parent is gone by the time it runs). Heartbeat-class events skip it.
    if (event !== "PreToolUse" && event !== "PostToolUse") hints.claude_pid = claudePid(input.env);
    const r: HookResult = { session, events, hints };
    if (typeof s.transcript_path === "string") r.transcript = s.transcript_path;
    return r;
  },

  readTranscript(file, fromLine) {
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return { turns: [], line: fromLine };
    }
    return readClaude(text.split("\n"), fromLine);
  },

  facts(session, transcript, hints, state): SessionFacts {
    const out: SessionFacts = {};
    if (transcript) Object.assign(out, claudeFacts(transcript, session.id, hints, state));
    const cwd = out.cwd ?? session.cwd;
    Object.assign(out, gitFacts(cwd), out.branch ? { branch: out.branch } : {});
    if (!out.url && typeof hints.desktop_id === "string") out.url = `claude://code/continue/${hints.desktop_id}`;
    // A Remote Control session says "0" though a person drives it from claude.ai: it runs as a
    // headless child of `claude remote-control`. Its link is what tells it from a `claude -p`;
    // CLAUDE_CODE_ENVIRONMENT_KIND cannot, since a `claude -p` started inside a Remote Control
    // session inherits "bridge", while the registry entry it writes has no bridge id of its own.
    if (typeof hints.attended === "boolean") out.attended = hints.attended || !!out.url;
    return out;
  },

  remoteFacts: (session, local, transcript, state, env = process.env) =>
    claudeRemoteFacts(session.id, local, transcript, state, env),

  backfill(sinceMs, env = process.env): BackfillRow[] {
    const rows: BackfillRow[] = [];
    const files: string[] = [];
    for (const d of claudeDirs(env))
      files.push(...recentFiles(path.join(d, "projects"), 1, sinceMs, (n) => /^[0-9a-f-]{36}\.jsonl$/.test(n)));
    const noState: FactsState = { get: () => ({}), save: () => {} };
    for (const f of files) {
      const id = path.basename(f, ".jsonl");
      const facts = claudeFacts(f, id, {}, noState);
      if (!facts.started_at || !facts.last_at) continue;
      const { started_at, last_at, first_ask: _fa, harness_version: _hv, ...rest } = facts;
      const cwd = rest.cwd;
      rows.push({
        session: { id, ...rest, ...gitFacts(cwd), ...(rest.branch ? { branch: rest.branch } : {}) },
        started_at,
        last_at,
        transcript: f,
      });
    }
    return rows;
  },
};

/** Claude Code runs a status line only on events (a new assistant message, a window's
 *  reset), and the hook sends at most one change a minute, so a turn's last numbers
 *  would wait for the next prompt. The timer runs it again while the session is idle. */
const LINE_REFRESH_S = 60;

/** Claude Code hands an account's limits only to its status line command
 *  (https://code.claude.com/docs/en/statusline), so with `--status-line` ours is that
 *  command. Someone else's status line is never replaced. Null: nothing to report. */
function statusLine(file: string, want: boolean, cmd?: HookCommand): InstallReport | null {
  const f = readJsonFile(file);
  if (!f.ok) return null; // the hooks' report already says why
  const cur = f.value.statusLine as { command?: unknown; refreshInterval?: unknown } | undefined;
  const ours = typeof cur?.command === "string" && OURS.test(cur.command);
  const command = cmd?.([NAME, "StatusLine"]).command;
  if (want && cur && !ours)
    return { file, changed: false, skipped: true, note: "a status line of your own is set; limits are not read" };
  if (want ? ours && cur?.command === command && cur?.refreshInterval === LINE_REFRESH_S : !ours) return null;
  if (want) f.value.statusLine = { type: "command", command, refreshInterval: LINE_REFRESH_S };
  else delete f.value.statusLine;
  writeFileSync(file, formatJson(f.value, f));
  return { file, changed: true, note: want ? "status line written (account limits)" : "status line removed" };
}

/** Epoch seconds as RFC 3339; anything that is not a plausible time is no time. */
const epochIso = (t: unknown): string | undefined =>
  typeof t === "number" && t > 0 && t < 1e11 ? new Date(t * 1000).toISOString() : undefined;

const WINDOW_MINUTES: Record<string, number> = { five_hour: 300, seven_day: 10_080 };

/** The status line's `rate_limits`: `five_hour`, `seven_day` and, behind a gateway,
 *  `spend_limit`, each with `used_percentage` and `resets_at` in epoch seconds. Only
 *  Pro and Max accounts (or a gateway) have them, and only after a session's first
 *  response; a window drops out once it resets. */
export function claudeLimits(rl: unknown): DataOf<"limits.observed"> | null {
  if (!rl || typeof rl !== "object" || Array.isArray(rl)) return null;
  const windows: DataOf<"limits.observed">["windows"] = [];
  for (const [id, w] of Object.entries(rl as Record<string, { used_percentage?: unknown; resets_at?: unknown }>)) {
    if (!/^[a-z0-9_]{1,64}$/.test(id) || typeof w?.used_percentage !== "number" || w.used_percentage < 0) continue;
    windows.push(
      prune({
        id,
        used_percent: w.used_percentage,
        window_minutes: WINDOW_MINUTES[id],
        resets_at: epochIso(w.resets_at),
      }),
    );
  }
  return windows.length ? { windows: windows.slice(0, 8) } : null;
}

function prune<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Another harness reading this settings file, not Claude Code. Several harnesses
 *  import `~/.claude/settings.json` hooks, so our entries there can be run by a tool
 *  that has its own adapter: it would arrive under the wrong name, with ids that mean
 *  nothing to a Claude Code reader. Every Claude Code payload names a transcript and a
 *  UUID session (all 21 recorded fixtures do); a payload with neither is somebody else's. */
export function notClaudeCode(id: string, s: Record<string, unknown>): boolean {
  return typeof s.transcript_path !== "string" && !UUID.test(id);
}
function pickSource(v: unknown): string {
  return typeof v === "string" && ["startup", "resume", "clear", "compact", "fork"].includes(v) ? v : "unknown";
}
/** One of the harness's own words for who submitted a prompt, forwarded as is (PROTOCOL.md
 *  §4, `turn.started.submitted_by`). Not an enum of ours: a value we have never seen is
 *  still carried, so the guard is the shape the spec allows — a bare word of at most 40
 *  characters, which is all a receiver may show or group by. Tier 0 is not redacted
 *  (PRIVACY.md §2), so that shape is the only guard there is. */
const harnessWord = (v: unknown): string | undefined =>
  typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/.test(v) ? v : undefined;
/** Claude Code's own prompt wrappers, as a CLOSED list: a task notification, a peer message,
 *  a system reminder, a local command's output, a slash command's expansion — with or
 *  without a closing tag, after trimming. Narrower than the reader's `isInjected` on
 *  purpose, because the two directions do not cost the same. A wrapper we have not recorded
 *  yet reads as unknown and a receiver keeps the turn, which is what it does today; a shape
 *  test wide enough to catch every wrapper also fires on a person who pasted nothing but an
 *  SVG, an HTML page or a JSX element, and a recency board acting on that would drop one of
 *  the person's own turns. Dropping one record from a transcript costs little, which is why
 *  the reader's test stays wide; ADAPTERS.md (Claude Code · Quirks) says why they differ. */
const WRAPPER =
  /^<(?:task-notification|cross-session-message|system-reminder|local-command-stdout|command-[a-z-]+)[\s/>]/i;
const injectedBlock = (prompt: string): boolean => WRAPPER.test(prompt.trim());
function errText(v: unknown): string | undefined {
  if (typeof v === "string") return v.slice(0, 2000);
  if (v && typeof v === "object") {
    const e = v as { error?: unknown; message?: unknown };
    if (typeof e.error === "string") return e.error.slice(0, 2000);
    if (typeof e.message === "string") return e.message.slice(0, 2000);
  }
  return undefined;
}
function describe(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  const v = i.command ?? i.file_path ?? i.path ?? i.url ?? i.pattern;
  return typeof v === "string" ? ` ${v.slice(0, 120)}` : "";
}

// --- facts: title, url, model, account, from Claude Code's own files ------------------

const NAME_RANK: Record<string, "custom" | "harness"> = {
  user: "custom",
  auto: "harness",
  hook: "harness",
  peer: "harness",
};
interface Registry {
  sessionId: string | null;
  name: string | null;
  name_source: "custom" | "harness" | null;
  bridge: string | null;
}
function registryEntry(j: unknown): Registry | null {
  if (!j || typeof j !== "object") return null;
  const r = j as { sessionId?: unknown; name?: unknown; nameSource?: string; bridgeSessionId?: unknown };
  const source = r.nameSource ? NAME_RANK[r.nameSource] : undefined;
  return {
    sessionId: r.sessionId ? String(r.sessionId) : null,
    name: source && typeof r.name === "string" && r.name.trim() ? r.name.trim() : null,
    name_source: source ?? null,
    bridge: typeof r.bridgeSessionId === "string" ? r.bridgeSessionId : null,
  };
}
const liveCache = new Map<string, Map<string, Registry>>();
function claudeLive(dir: string): Map<string, Registry> {
  const hit = liveCache.get(dir);
  if (hit) return hit;
  const map = new Map<string, Registry>();
  let names: string[] = [];
  try {
    names = readdirSync(path.join(dir, "sessions")).filter((n) => n.endsWith(".json"));
  } catch {}
  for (const n of names) {
    try {
      const e = registryEntry(JSON.parse(readFileSync(path.join(dir, "sessions", n), "utf8")));
      if (e?.sessionId) map.set(e.sessionId, e);
    } catch {}
  }
  liveCache.set(dir, map);
  return map;
}
function claudeLiveByPid(dir: string, pid: unknown): Registry | null {
  if (!pid) return null;
  try {
    return registryEntry(JSON.parse(readFileSync(path.join(dir, "sessions", `${pid}.json`), "utf8")));
  } catch {
    return null;
  }
}
/** The Claude Code process that ran this hook: the nearest ancestor with a registry
 *  file (hooks run under a shell, so usually the parent's parent). */
export function claudePid(env: NodeJS.ProcessEnv = process.env): number | null {
  try {
    const dirs = claudeDirs(env);
    const has = (pid: number) => dirs.some((d) => existsSync(path.join(d, "sessions", `${pid}.json`)));
    let pid = process.ppid;
    if (has(pid)) return pid;
    const parent = parentOf();
    for (let hop = 0; hop < 6 && pid > 1; hop++) {
      pid = parent(pid);
      if (pid > 1 && has(pid)) return pid;
    }
  } catch {}
  return null;
}
function parentOf(): (pid: number) => number {
  if (process.platform === "linux") {
    return (pid) => {
      try {
        const st = readFileSync(`/proc/${pid}/stat`, "utf8");
        return Number(st.slice(st.lastIndexOf(")") + 2).split(" ")[1]) || 0;
      } catch {
        return 0;
      }
    };
  }
  const table = new Map<number, number>();
  try {
    const out = execFileSync("ps", ["-axo", "pid=,ppid="], {
      encoding: "utf8",
      timeout: 2000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    for (const l of out.split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)/.exec(l);
      if (m) table.set(Number(m[1]), Number(m[2]));
    }
  } catch {}
  return (pid) => table.get(pid) || 0;
}
const EMAIL_RE = /^[^@\s]{1,64}@[^@\s]{1,189}$/;
/** Who a config dir is signed in as, from its .claude.json (the default dir keeps it
 *  at ~/.claude.json): the account id, and the email it signs in with. A dir with no
 *  claude.ai login that runs on another API is that API's account (apiAccount). */
function claudeLogin(dir: string, home = homeDir()): { id: string; email?: string; name?: string } | null {
  const files = [path.join(dir, ".claude.json")];
  if (path.resolve(dir) === path.join(home, ".claude")) files.unshift(path.join(home, ".claude.json"));
  for (const f of files) {
    try {
      const a = (
        JSON.parse(readFileSync(f, "utf8")) as { oauthAccount?: { accountUuid?: unknown; emailAddress?: unknown } }
      ).oauthAccount;
      if (typeof a?.accountUuid === "string" && a.accountUuid) {
        const email = typeof a.emailAddress === "string" && EMAIL_RE.test(a.emailAddress) ? a.emailAddress : undefined;
        return { id: a.accountUuid.slice(0, 128), ...(email ? { email } : {}) };
      }
    } catch {}
  }
  return apiAccount(dir);
}
/** Anthropic's own API: a key for it is an Anthropic account no local file names. */
const ANTHROPIC_HOST = /(^|\.)anthropic\.com$/i;
/** A config dir whose settings send Claude Code to another API (`env.ANTHROPIC_BASE_URL`:
 *  Kimi on a Modal endpoint, GLM on Z.ai) has no claude.ai login, so its account is the
 *  endpoint: `api-` and 16 hex of the SHA-256 of its origin for events (the same on every
 *  machine that uses it), and its host as the name control's pair and hello give it.
 *  Only that one key is read; the tokens and headers beside it never are. */
function apiAccount(dir: string): { id: string; name: string } | null {
  const base = (readJson(settingsIn(dir)) as { env?: { ANTHROPIC_BASE_URL?: unknown } }).env?.ANTHROPIC_BASE_URL;
  if (typeof base !== "string") return null;
  let u: URL;
  try {
    u = new URL(base.trim());
  } catch {
    return null;
  }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || !u.hostname || ANTHROPIC_HOST.test(u.hostname))
    return null;
  // The origin alone: a path or a user:password@ can carry a key.
  const origin = `${u.protocol}//${u.host}`;
  return { id: `api-${createHash("sha256").update(origin).digest("hex").slice(0, 16)}`, name: u.host };
}
const accountCache = new Map<string, string | null>();
/** The account id for `session.account_id`: never the email. Events go to every sink,
 *  a team board included; the email (or an API's host) reaches only a receiver the
 *  person paired with, in control's pair and hello (claudeAccounts). */
function claudeAccount(dir: string): string | null {
  const hit = accountCache.get(dir);
  if (hit !== undefined) return hit;
  const acct = claudeLogin(dir)?.id ?? null;
  accountCache.set(dir, acct);
  return acct;
}
/** Every account signed in across these config dirs, read fresh (a person signs in to
 *  another account without restarting anything), for control's pair and hello. */
export function claudeAccounts(dirs: string[], home = homeDir()): HarnessAccount[] {
  const out: HarnessAccount[] = [];
  for (const d of dirs) {
    const l = claudeLogin(d, home);
    if (!l) continue;
    const seen = out.find((a) => a.id === l.id);
    if (!seen) out.push({ harness: NAME, ...l });
    else if (!seen.email && l.email) seen.email = l.email;
  }
  return out;
}
const LINK_RE = /^https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+$/;
function transcriptLink(records: Record<string, unknown>[]): string | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const j = records[i] as { type?: string; subtype?: string; url?: unknown; bridgeSessionId?: unknown };
    if (j.type === "system" && j.subtype === "bridge_status" && typeof j.url === "string" && LINK_RE.test(j.url))
      return j.url;
    if (j.type === "bridge-session" && typeof j.bridgeSessionId === "string") {
      const m = /^(?:cse|session)_([A-Za-z0-9]+)$/.exec(j.bridgeSessionId);
      if (m) return `https://claude.ai/code/session_${m[1]}`;
    }
  }
  return null;
}
/** A first ask as the Claude Code app titles an untitled session: whitespace
 *  collapsed, whole up to 50 characters, else its first 50 and "...". */
export function appTitle(text: string): string {
  const t = String(text).replace(/\s+/g, " ").trim();
  return t.length > 50 ? `${t.slice(0, 50)}...` : t;
}
function askText(j: Record<string, unknown> | null): string | null {
  if (!j || j.type !== "user" || j.isMeta || j.isSidechain) return null;
  const origin = j.origin as { kind?: string } | undefined;
  if (origin?.kind && origin.kind !== "human") return null;
  const c = (j.message as { content?: unknown } | undefined)?.content;
  const text = (
    typeof c === "string"
      ? c
      : Array.isArray(c)
        ? c
            .filter((b) => b && b.type === "text" && typeof b.text === "string")
            .map((b) => b.text as string)
            .join("\n")
        : ""
  ).trim();
  if (!text || isInjected(text)) return null;
  return text;
}
function firstAsk(records: Record<string, unknown>[]): string | null {
  for (const j of records) {
    const t = askText(j);
    if (t) return appTitle(t);
  }
  return null;
}
function scanTitles(file: string, from: number, found: { custom?: string | null; ai?: string | null }) {
  const out = { custom: found.custom ?? null, ai: found.ai ?? null, upto: from };
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    return out;
  }
  if (size < from) {
    out.upto = 0;
    out.custom = out.ai = null;
    from = 0;
  }
  // Only lines carrying a title record are parsed; the rest of the new bytes are skipped.
  let pos = 0;
  scanLines<null>(
    file,
    (l) => {
      pos += Buffer.byteLength(l, "utf8") + 1;
      if (pos <= from || l.indexOf('-title"') < 0) return null;
      try {
        const j = JSON.parse(l) as { type?: string; customTitle?: string; aiTitle?: string };
        if (j.type === "custom-title" && j.customTitle) out.custom = j.customTitle;
        if (j.type === "ai-title" && j.aiTitle) out.ai = j.aiTitle;
      } catch {}
      return null;
    },
    512 * 1024 * 1024,
  );
  out.upto = size;
  return out;
}

/** A session's title and where it came from, best first: /rename (registry "user"
 *  name or custom-title) → Claude Code's own title (registry "auto" name or
 *  ai-title) → the first ask, marked first-ask so a real title later replaces it. */
export function claudeFacts(
  file: string,
  sessionId: string,
  hints: Record<string, unknown>,
  state: FactsState,
): SessionFacts {
  const { head, tail } = ends(file, 64 * 1024, 256 * 1024);
  const H = parseLines(head);
  const T = parseLines(tail);
  const out: SessionFacts = {};
  const id = sessionId || path.basename(file, ".jsonl");
  const mem = state.get(NAME, id);
  let custom: string | null = null;
  let ai: string | null = null;
  for (const j of H.concat(T)) {
    if (j.type === "custom-title" && typeof j.customTitle === "string") custom = j.customTitle;
    if (j.type === "ai-title" && typeof j.aiTitle === "string") ai = j.aiTitle;
  }
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {}
  if (!custom && !ai && size > 64 * 1024 + 256 * 1024) {
    const s = scanTitles(file, Number(mem.scan_upto) || 0, {
      custom: mem.scan_custom as string | null,
      ai: mem.scan_ai as string | null,
    });
    custom = s.custom;
    ai = s.ai;
    state.save(NAME, id, { scan_upto: s.upto, scan_custom: s.custom, scan_ai: s.ai });
  }
  const dir = configDirOf(file);
  const live = claudeLive(dir).get(id) ?? claudeLiveByPid(dir, hints.claude_pid);
  if (live?.name) state.save(NAME, id, { name: live.name, name_source: live.name_source });
  const bridge =
    live?.bridge && /^session_[A-Za-z0-9]+$/.test(live.bridge) ? `https://claude.ai/code/${live.bridge}` : null;
  const url = bridge ?? transcriptLink(T) ?? transcriptLink(H) ?? (typeof mem.url === "string" ? mem.url : null);
  if (url) {
    out.url = url;
    state.save(NAME, id, { url });
  }
  const name = live?.name
    ? { title: live.name, source: live.name_source as "custom" | "harness" }
    : typeof mem.name === "string"
      ? { title: mem.name, source: mem.name_source as "custom" | "harness" }
      : null;
  const pick =
    (name && name.source === "custom" && name) ||
    (custom && { title: custom, source: "custom" as const }) ||
    name ||
    (ai && { title: ai, source: "harness" as const });
  let ask = typeof mem.first_ask === "string" ? mem.first_ask : firstAsk(H);
  if (!ask && size > 64 * 1024 && !mem.first_ask_none) {
    ask = scanLines<string>(file, (l) => {
      try {
        const t = askText(JSON.parse(l) as Record<string, unknown>);
        return t ? appTitle(t) : null;
      } catch {
        return null;
      }
    });
    if (!ask && size > 16 * 1024 * 1024) state.save(NAME, id, { first_ask_none: true });
  }
  if (ask) {
    out.first_ask = ask;
    if (!mem.first_ask) state.save(NAME, id, { first_ask: ask });
  }
  if (pick) {
    out.title = String(pick.title).slice(0, 120);
    out.title_source = pick.source;
  } else if (ask) {
    out.title = ask;
    out.title_source = "first-ask";
  }
  const acct = claudeAccount(dir);
  if (acct) out.account_id = acct;
  for (let i = T.length - 1; i >= 0; i--) {
    const m = (T[i] as { message?: { model?: string } }).message?.model;
    if (T[i]?.type === "assistant" && m && m !== "<synthetic>") {
      out.model = m;
      break;
    }
  }
  const meta = [...T].reverse().find((j) => j.version) ?? H.find((j) => j.version);
  if (meta?.version) out.harness_version = String(meta.version);
  const times = H.concat(T)
    .map((j) => Date.parse(String(j.timestamp ?? "")))
    .filter((n) => n > 0);
  if (times.length) {
    out.started_at = Math.min(...times);
    out.last_at = Math.max(...times);
  }
  const withCwd = H.find((j) => typeof j.cwd === "string");
  if (withCwd) {
    out.cwd = withCwd.cwd as string;
    if (typeof withCwd.gitBranch === "string" && withCwd.gitBranch !== "HEAD") out.branch = withCwd.gitBranch;
  }
  return out;
}

// --- claude.ai's name for a session, only when the person turned it on ------------------

/** claude.ai names a Remote Control session itself, seconds after its first message, and
 *  never tells the machine: no file here holds that name, so the Claude app shows one
 *  and every local reader another. With `remote_titles` on, the worker asks claude.ai the
 *  way Claude Code reads a session. Again after a minute while it has no name yet, then
 *  every half hour: a rename in the Claude app reaches the transcript as a custom-title,
 *  which outranks this anyway. */
const REMOTE_RETRY_MS = 60_000;
const REMOTE_REFRESH_MS = 30 * 60_000;
const CLAUDE_API = "https://api.anthropic.com";
const KEYCHAIN = "Claude Code-credentials";
/** The worker holds the session's lock while it asks, and a sibling hook waits 6 s for it. */
const REMOTE_TIMEOUT_MS = 3000;
const KEYCHAIN_TIMEOUT_MS = 2000;
/** A session is a few kB; anything past this is not one. */
const REMOTE_MAX_BYTES = 1 << 20;
/** A name as Claude Code itself cleans one: control and bidirectional characters become
 *  spaces, runs of space one, the ends trimmed. */
const cleanName = (s: string) =>
  s
    .replace(/[\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/** claude.ai's name for a session with a claude.ai link, unless the person named it
 *  here: `{title, title_source: "harness"}`, or nothing. */
export async function claudeRemoteFacts(
  id: string,
  local: SessionFacts,
  transcript: string | undefined,
  state: FactsState,
  env: NodeJS.ProcessEnv,
  now = Date.now(),
): Promise<Partial<SessionFacts>> {
  if (!transcript || !local.url || !LINK_RE.test(local.url) || local.title_source === "custom") return {};
  const mem = state.get(NAME, id);
  let title = typeof mem.remote_title === "string" ? mem.remote_title : null;
  if (now - (Number(mem.remote_at) || 0) >= (title ? REMOTE_REFRESH_MS : REMOTE_RETRY_MS)) {
    // Marked before the call: a claude.ai that doesn't answer isn't asked on every hook.
    state.save(NAME, id, { remote_at: now });
    const token = claudeAiToken(configDirOf(transcript), env, now);
    const got = token ? await claudeAiTitle(local.url.slice(local.url.lastIndexOf("/") + 1), token) : undefined;
    if (got !== undefined) {
      title = got?.slice(0, 200) ?? null;
      state.save(NAME, id, { remote_title: title });
    }
  }
  return title ? { title: title.slice(0, 120), title_source: "harness" } : {};
}

/** The keychain items Claude Code keeps a config dir's sign-in under: `Claude
 *  Code-credentials`, and for a CLAUDE_CONFIG_DIR, `-` and 8 hex of the SHA-256 of that
 *  path as it was set (tried as the hook's env names it, then as the dir itself). */
function keychainServices(dir: string, env: NodeJS.ProcessEnv): string[] {
  const named = (p: string) =>
    `${KEYCHAIN}-${createHash("sha256").update(p.normalize("NFC")).digest("hex").slice(0, 8)}`;
  const out = new Set<string>();
  if (env.CLAUDE_CONFIG_DIR && path.resolve(env.CLAUDE_CONFIG_DIR) === dir) out.add(named(env.CLAUDE_CONFIG_DIR));
  if (dir === path.join(env.HOME || homeDir(), ".claude")) out.add(KEYCHAIN);
  out.add(named(dir));
  return [...out];
}

/** A token this process already read, by config dir, until a minute before it expires:
 *  `sessionpipe titles on` asks about every recent session, one `security` each would be
 *  slow. In memory only, for the life of the process. */
const tokenCache = new Map<string, { token: string; expires: number }>();
/** The access token Claude Code signed in to `dir` with: from the macOS keychain, else
 *  from `<dir>/.credentials.json`. Never written anywhere, never logged. One that has
 *  expired is not refreshed, since that would rotate Claude Code's own login: the lookup
 *  waits for Claude Code to refresh it. */
export function claudeAiToken(dir: string, env: NodeJS.ProcessEnv, now: number): string | null {
  const hit = tokenCache.get(dir);
  if (hit && hit.expires > now + 60_000) return hit.token;
  const raw: string[] = [];
  if (process.platform === "darwin")
    for (const service of keychainServices(dir, env)) {
      try {
        const user = env.USER || userInfo().username;
        const account = /^[\w.-]+$/.test(user) ? user : "claude-code-user";
        raw.push(
          execFileSync("security", ["find-generic-password", "-a", account, "-w", "-s", service], {
            encoding: "utf8",
            timeout: KEYCHAIN_TIMEOUT_MS,
            stdio: ["ignore", "pipe", "ignore"],
          }),
        );
        break;
      } catch {}
    }
  try {
    raw.push(readFileSync(path.join(dir, ".credentials.json"), "utf8"));
  } catch {}
  for (const r of raw) {
    try {
      // Claude Code writes the item as hex (`-X`); `security -w` prints it back as text,
      // or as that hex where it isn't printable.
      const t = r.trim();
      const o = (
        JSON.parse(/^(?:[0-9a-f]{2})+$/i.test(t) ? Buffer.from(t, "hex").toString("utf8") : t) as {
          claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown };
        }
      ).claudeAiOauth;
      if (typeof o?.accessToken !== "string" || !o.accessToken) continue;
      const expires = typeof o.expiresAt === "number" ? o.expiresAt : Number.POSITIVE_INFINITY;
      if (expires <= now + 60_000) continue;
      tokenCache.set(dir, { token: o.accessToken, expires });
      return o.accessToken;
    } catch {}
  }
  return null;
}

interface RemoteSession {
  id?: unknown;
  title?: unknown;
}
/** claude.ai's name for the session `bridge` (`session_…`), from the endpoint Claude Code
 *  reads a session from: a string, null when it has none yet, undefined when it couldn't
 *  be asked or wouldn't say (offline, a 401 or 404, an answer about another session), so
 *  the last answer stands. The token goes to api.anthropic.com alone: a redirect is
 *  refused, never followed. */
export async function claudeAiTitle(bridge: string, token: string): Promise<string | null | undefined> {
  try {
    const r = await fetch(`${CLAUDE_API}/v1/code/sessions/${bridge}`, {
      headers: { Authorization: `Bearer ${token}`, "anthropic-version": "2023-06-01", "User-Agent": "sessionpipe" },
      redirect: "error",
      signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
    });
    if (r.status !== 200 || Number(r.headers.get("content-length")) > REMOTE_MAX_BYTES) return undefined;
    const text = await r.text();
    if (text.length > REMOTE_MAX_BYTES) return undefined;
    // claude.ai answers `{response_shape: {…}}` (conformance/remote/claude-code); Claude Code
    // also reads `session`, and a bare session is taken too. Asked as `session_…`, it names
    // the session `cse_…`: the same one.
    const j = JSON.parse(text) as (RemoteSession & { response_shape?: RemoteSession; session?: RemoteSession }) | null;
    const s = j?.response_shape ?? j?.session ?? j;
    const bare = (x: string) => x.replace(/^(?:session|cse)_/, "");
    if (typeof s?.id !== "string" || bare(s.id) !== bare(bridge)) return undefined;
    return (typeof s.title === "string" && cleanName(s.title)) || null;
  } catch {
    return undefined;
  }
}

/** For tests: each hook runs in a fresh process; a test that edits the registry mid-run clears the cache. */
export const _resetClaudeCaches = (): void => {
  liveCache.clear();
  accountCache.clear();
  tokenCache.clear();
};
