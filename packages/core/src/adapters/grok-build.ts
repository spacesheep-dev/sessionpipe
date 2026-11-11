// SPDX-License-Identifier: Apache-2.0
// Grok Build (xAI) — docs: the user guide the CLI installs at ~/.grok/docs/user-guide
// (10-hooks.md, 17-sessions.md), read on 1.0.77.
// Config: a hooks file of our own, `~/.grok/hooks/sessionpipe.json` (`$GROK_HOME/hooks/…`
// when that is set). Grok merges every `*.json` in that folder, so nobody else's file is
// touched. Claude-shaped; an omitted matcher matches everything; timeouts in SECONDS.
// Grok skips an event name it does not know, so the list may hold more than it fires.
//
// Grok also runs the hooks in `~/.claude/settings.json` (Claude Code compatibility, on by
// default), with a payload that carries Claude Code's own keys beside Grok's: our
// claude-code entry there fires inside every Grok session and would report it as a
// Claude Code session. `isGrokPayload` is how that entry tells, and stays out.
//
// The payload names the session, the folder and the transcript (`transcript_path`, the
// session's `updates.jsonl`) but no model; the model, the title and the times come from
// `summary.json` beside the transcript.
//
// stdout stays empty for every event: Grok reads a decision from a blocking hook's
// stdout, and silence with exit 0 is "carry on".
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { homeDir } from "../paths.js";
import { readGrok } from "../readers/transcripts.js";
import { installClaudeShaped, installedClaudeShaped, readJson, uninstallClaudeShaped } from "./claude-shaped.js";
import type { Adapter, BackfillRow, HookInput, HookResult, InstallOptions, SessionFacts } from "./types.js";

const NAME = "grok-build";
export const GROK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Notification",
  "Stop",
  "StopFailure",
  "StopCancelled",
  "PreCompact",
  "SessionEnd",
] as const;
// Only a prompt that is waiting on the person is attention; `idle_prompt` and
// `task_complete` fire on every turn end and say nothing a Stop has not said.
const OPTS = { matcherFor: (e: string) => (e === "Notification" ? "permission_prompt" : undefined), timeout: 5 };
const eventsFor = (lean?: boolean) => (lean ? GROK_EVENTS.filter((e) => e !== "PreToolUse") : [...GROK_EVENTS]);

/** `~/.grok`, or `$GROK_HOME`. */
export const grokHome = (env: NodeJS.ProcessEnv = process.env): string =>
  env.GROK_HOME || path.join(env.HOME || homeDir(), ".grok");
const hooksFile = (env: NodeJS.ProcessEnv) => path.join(grokHome(env), "hooks", "sessionpipe.json");
const sessionsDir = (env: NodeJS.ProcessEnv) => path.join(grokHome(env), "sessions");

/** A hook payload Grok Build wrote. Its payloads carry Claude Code's keys for the hooks
 *  it imports from Claude's settings, and its own beside them: `hookEventName` (the event
 *  in snake_case) and `workspaceRoot` are in every one recorded, and in none of Claude
 *  Code's. */
export const isGrokPayload = (s: Record<string, unknown>): boolean =>
  typeof s.hookEventName === "string" && typeof s.workspaceRoot === "string";

const SESSION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const validTool = (n: unknown): n is string => typeof n === "string" && /^[A-Za-z0-9_.:-]{1,120}$/.test(n);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
/** Grok's two start sources, in the protocol's words: `new` is a fresh session (also
 *  after `/new` and `/clear`), `load` a saved one reopened. */
const startSource = (v: unknown): string => (v === "new" ? "startup" : v === "load" ? "resume" : "unknown");
/** `shutdown` is the process ending, which is the only reason recorded. */
const endReason = (r: unknown): "clear" | "logout" | "exit" | "other" =>
  r === "clear" || r === "logout" || r === "exit" ? r : r === "shutdown" ? "exit" : "other";
function errText(v: unknown): string | undefined {
  if (typeof v === "string" && v) return v.slice(0, 2000);
  if (v && typeof v === "object") {
    const e = v as { message?: unknown; error?: unknown };
    if (typeof e.message === "string" && e.message) return e.message.slice(0, 2000);
    if (typeof e.error === "string" && e.error) return e.error.slice(0, 2000);
  }
  return undefined;
}
const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n).replace(/\s+\S*$/, "")}…` : s);

export const grokBuild: Adapter = {
  name: NAME,
  events: GROK_EVENTS,
  detect: (env = process.env) => existsSync(grokHome(env)),
  configFiles: (env = process.env) => [hooksFile(env)],
  install: (cmd, env = process.env, opts: InstallOptions = {}) => [
    installClaudeShaped(hooksFile(env), NAME, eventsFor(opts.lean), cmd, OPTS),
  ],
  uninstall: (env = process.env, opts: InstallOptions = {}) => [
    uninstallClaudeShaped(hooksFile(env), GROK_EVENTS, { created: opts.created?.includes(hooksFile(env)) }),
  ],
  installed: (cmd, env = process.env, opts: InstallOptions = {}) => [
    { file: hooksFile(env), state: installedClaudeShaped(hooksFile(env), NAME, eventsFor(opts.lean), cmd, OPTS) },
  ],

  fromHook(input: HookInput): HookResult | null {
    const event = input.argv[1] ?? "";
    let s: Record<string, unknown> = {};
    try {
      // A stdin that is JSON but not an object (`null`, a number) is no payload.
      const j: unknown = input.stdin ? JSON.parse(input.stdin) : {};
      if (j && typeof j === "object" && !Array.isArray(j)) s = j as Record<string, unknown>;
    } catch {}
    const id = str(s.session_id) ?? str(s.sessionId) ?? "";
    if (!SESSION_ID.test(id)) return null;
    const session: HookResult["session"] = { id, cwd: str(s.cwd) ?? input.env.GROK_WORKSPACE_ROOT ?? input.cwd };
    // The turn's id has no snake_case twin: `promptId` only, and only on turn events.
    const turn_id = str(s.promptId) ?? str(s.prompt_id);
    const tool = validTool(s.tool_name) ? s.tool_name : validTool(s.toolName) ? s.toolName : undefined;
    const call_id = str(s.tool_use_id) ?? str(s.toolUseId);
    const took = s.duration_ms ?? s.durationMs;
    const ms = typeof took === "number" ? Math.round(took) : undefined;
    const tool_input = s.tool_input ?? s.toolInput;
    const tool_response = s.tool_response ?? s.toolResult;
    const ev = (type: string, data: Record<string, unknown>) => ({ type, data: prune(data), harnessEvent: event });
    const events: HookResult["events"] = [];
    switch (event) {
      case "SessionStart":
        events.push(ev("session.started", { source: startSource(s.source) }));
        break;
      case "UserPromptSubmit":
        events.push(
          ev("turn.started", {
            turn_id,
            prompt_chars: typeof s.prompt === "string" ? [...s.prompt].length : undefined,
          }),
        );
        break;
      case "PreToolUse":
        if (tool) events.push(ev("tool.started", { tool, call_id, input: tool_input }));
        break;
      case "PostToolUse":
        if (tool)
          events.push(ev("tool.ended", { tool, call_id, ms, ok: true, input: tool_input, output: tool_response }));
        break;
      case "PostToolUseFailure":
        if (tool)
          events.push(
            ev("tool.ended", {
              tool,
              call_id,
              ms,
              ok: false,
              error: errText(s.error ?? tool_response),
              input: tool_input,
              output: tool_response,
            }),
          );
        break;
      case "Notification":
        events.push(
          ev("attention.needed", {
            attention_id: call_id ?? `notif-${Date.now()}`,
            kind: "permission",
            tool,
            message: typeof s.message === "string" ? s.message.slice(0, 200) : undefined,
          }),
        );
        break;
      case "Stop":
        // Grok fires a second Stop as the process ends, after SessionEnd, with reason
        // `shutdown` and no prompt: no turn ended there.
        if (s.reason === "shutdown") return null;
        events.push(ev("turn.ended", { turn_id, reason: "stop" }));
        break;
      case "StopFailure":
        events.push(
          ev("turn.ended", {
            turn_id,
            reason: "error",
            error: (str(s.error) ?? str(s.errorType) ?? str(s.error_type))?.slice(0, 200),
          }),
        );
        break;
      case "StopCancelled":
        events.push(ev("turn.ended", { turn_id, reason: "interrupt" }));
        break;
      case "PreCompact":
        events.push(ev("context.compacted", { trigger: s.trigger === "manual" ? "manual" : "auto" }));
        break;
      case "SessionEnd":
        events.push(ev("session.ended", { reason: endReason(s.reason) }));
        break;
      default:
        return null;
    }
    const hints: Record<string, unknown> = {};
    // The prompt and the turn's last words, for the worker (as Claude Code's): never
    // event fields of their own, tier 2 carries them.
    if (event === "UserPromptSubmit" && typeof s.prompt === "string") hints.prompt = s.prompt;
    const final = s.last_assistant_message ?? s.lastAssistantMessage;
    if (event === "Stop" && typeof final === "string" && final.trim()) hints.final = final;
    const r: HookResult = { session, events, hints };
    const transcript = str(s.transcript_path) ?? str(s.transcriptPath);
    if (transcript) r.transcript = transcript;
    return r;
  },

  readTranscript(file, fromLine) {
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return { turns: [], line: fromLine };
    }
    return readGrok(text.split("\n"), fromLine);
  },

  facts(session, transcript, _hints, _state, env = process.env): SessionFacts {
    const out: SessionFacts = {};
    const version = grokVersion(env);
    if (version) out.harness_version = version;
    const dir = transcript ? path.dirname(transcript) : findSession(session.id, env);
    if (dir) Object.assign(out, summaryFacts(readJson(path.join(dir, "summary.json"))));
    return out;
  },

  backfill(sinceMs, env = process.env): BackfillRow[] {
    const out: BackfillRow[] = [];
    for (const dir of sessionDirs(env)) {
      const id = path.basename(dir);
      if (!SESSION_ID.test(id)) continue;
      const { started_at, last_at, ...rest } = summaryFacts(readJson(path.join(dir, "summary.json")));
      if (!started_at || !last_at || last_at < sinceMs) continue;
      const transcript = path.join(dir, "updates.jsonl");
      out.push({ session: { id, ...rest }, started_at, last_at, ...(existsSync(transcript) ? { transcript } : {}) });
    }
    return out.sort((a, b) => b.last_at - a.last_at).slice(0, 500);
  },
};

function prune<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

const list = (dir: string): string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
};
/** `sessions/<encoded cwd>/<session id>/`: every session folder on the machine. */
const sessionDirs = (env: NodeJS.ProcessEnv): string[] => list(sessionsDir(env)).flatMap(list);
const findSession = (id: string, env: NodeJS.ProcessEnv): string | undefined =>
  SESSION_ID.test(id) ? sessionDirs(env).find((d) => path.basename(d) === id) : undefined;

/** `summary.json`, the session's index entry: its folder, model, times and the title Grok
 *  generated from the conversation (`generated_title`, which a `/rename` replaces). */
function summaryFacts(j: Record<string, unknown>): SessionFacts {
  const out: SessionFacts = {};
  const info = j.info as { cwd?: unknown } | undefined;
  if (info && typeof info.cwd === "string" && path.isAbsolute(info.cwd)) out.cwd = info.cwd;
  if (typeof j.current_model_id === "string" && j.current_model_id) out.model = j.current_model_id;
  const started = Date.parse(String(j.created_at ?? ""));
  const last = Date.parse(String(j.last_active_at ?? j.updated_at ?? ""));
  if (started > 0) out.started_at = started;
  if (last > 0) out.last_at = last;
  const title =
    typeof j.generated_title === "string" ? (j.generated_title.split("\n").find((l) => l.trim()) ?? "") : "";
  if (title.trim()) {
    out.title = cut(title.trim(), 80);
    out.title_source = "harness";
  }
  if (typeof j.head_branch === "string" && j.head_branch) out.branch = j.head_branch;
  return out;
}

/** `version.json` in Grok's home names the installed version. */
export function grokVersion(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const v = readJson(path.join(grokHome(env), "version.json")).version;
  return typeof v === "string" && /^[0-9][0-9A-Za-z.+-]{0,63}$/.test(v) ? v : undefined;
}
