// SPDX-License-Identifier: Apache-2.0
// Autopilot (Directionally Local) — docs: https://github.com/directionally-local/autopilot#hooks
// (the "Hooks" section of its README, and docs/beacon.md for the payload fields).
// Config: the global hook settings file, `$XDG_CONFIG_HOME/autopilot/settings.json`
// (default `~/.config/autopilot/settings.json`, on every platform). Its shape is
// Autopilot's own, not Claude Code's: `{"hooks":{"<Event>":[{"id","command","timeoutMs"}]}}`,
// one flat entry per hook, timeouts in MILLISECONDS, no `matcher` meaning every tool.
// Every entry of ours has the id `sessionpipe`, so `/hooks disable sessionpipe` in
// Autopilot turns all of them off at once and `/hooks enable sessionpipe` back on.
//
// The payload is Claude Code's shape (`hook_event_name`, `session_id`, `cwd`, `tool_name`,
// `tool_input`, `tool_response`, `tool_use_id`, `transcript_path`) beside Autopilot's own
// fields, and every one carries `client: "autopilot"`, `autopilot_version` and
// `hook_payload_version`, the version of the payload contract.
//
// stdout stays empty for every event: Autopilot reads a decision only from a veto event's
// stdout (PreToolUse, UserPromptSubmit, PermissionRequest), and silence with exit 0 is
// "carry on".
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { homeDir } from "../paths.js";
import { ends, parseLines } from "../readers/files.js";
import { readClaude } from "../readers/transcripts.js";
import { editJson, OURS, readJsonFile, removeEmptied, writeBack } from "./claude-shaped.js";
import type {
  Adapter,
  HookCommand,
  HookInput,
  HookResult,
  InstallOptions,
  InstallReport,
  SessionFacts,
} from "./types.js";

const NAME = "autopilot";
const HOOK_ID = "sessionpipe";
// PostToolUseFailure is left out on purpose: Autopilot fires it alongside PostToolUse for
// the same failed call, and PostToolUse already says whether the call failed.
export const AUTOPILOT_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PermissionRequest",
  "Stop",
  "StopFailure",
  "PreCompact",
  "SessionEnd",
] as const;
const TIMEOUT_MS = 5000;
const eventsFor = (lean?: boolean) =>
  lean ? AUTOPILOT_EVENTS.filter((e) => e !== "PreToolUse") : [...AUTOPILOT_EVENTS];

/** `~/.config/autopilot`, or `$XDG_CONFIG_HOME/autopilot`. */
export const autopilotConfigDir = (env: NodeJS.ProcessEnv = process.env): string =>
  path.join(env.XDG_CONFIG_HOME?.trim() || path.join(env.HOME || homeDir(), ".config"), "autopilot");
const settingsFile = (env: NodeJS.ProcessEnv) => path.join(autopilotConfigDir(env), "settings.json");

/** A hook payload Autopilot wrote: it names itself in `client` on every one. */
export const isAutopilotPayload = (s: Record<string, unknown>): boolean => s.client === NAME;

/** Autopilot names a session `<ISO time with - for : and .>_<slug of the first prompt>`
 *  (its `makeSessionId`), and the protocol's id has no `_` (PROTOCOL.md §3:
 *  `[A-Za-z0-9._:-]`). Neither part of Autopilot's id ever holds a `.`, so the `_` is
 *  written `.`, the one change that keeps the id whole and reversible. Issue #279 proposes
 *  allowing `_`; this goes once it does. */
export const protocolId = (id: string): string => id.replace(/_/g, ".");
const SESSION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const validTool = (n: unknown): n is string => typeof n === "string" && /^[A-Za-z0-9_.:-]{1,120}$/.test(n);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
/** What the call was about, for a permission prompt's message: the command, file, url or pattern. */
function describe(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  const v = i.command ?? i.file_path ?? i.path ?? i.url ?? i.pattern ?? i.query;
  return typeof v === "string" ? ` ${v.slice(0, 120)}` : "";
}

function entry(cmd: HookCommand, event: string) {
  return { id: HOOK_ID, command: cmd([NAME, event]).command, timeoutMs: TIMEOUT_MS };
}
/** The person's `/hooks disable sessionpipe` is theirs to undo: an entry of ours is compared
 *  without `enabled`, and a rewrite keeps it. */
const switchedOff = (h: unknown): boolean => (h as { enabled?: unknown }).enabled === false;
const same = (h: unknown, e: ReturnType<typeof entry>): boolean => {
  const { enabled: _enabled, ...rest } = h as Record<string, unknown>;
  return JSON.stringify(rest) === JSON.stringify(e);
};
const isOurs = (h: unknown): boolean =>
  !!h &&
  typeof h === "object" &&
  ((h as { id?: unknown }).id === HOOK_ID ||
    (typeof (h as { command?: unknown }).command === "string" && OURS.test((h as { command: string }).command)));

export const autopilot: Adapter = {
  name: NAME,
  events: AUTOPILOT_EVENTS,
  detect: (env = process.env) => existsSync(autopilotConfigDir(env)),
  configFiles: (env = process.env) => [settingsFile(env)],

  install(cmd, env = process.env, opts: InstallOptions = {}): InstallReport[] {
    const file = settingsFile(env);
    const f = readJsonFile(file);
    if (!f.ok) return [{ file, changed: false, skipped: true, note: `${f.reason}; not touched` }];
    const settings = f.value;
    const hooks = (settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {}) as Record<
      string,
      unknown
    >;
    const want = eventsFor(opts.lean);
    let changed = false;
    // Events we no longer hook (a lean install after a full one) lose their entry of ours.
    for (const ev of Object.keys(hooks)) {
      if ((want as string[]).includes(ev)) continue;
      const list = Array.isArray(hooks[ev]) ? (hooks[ev] as unknown[]) : [];
      const kept = list.filter((h) => !isOurs(h));
      if (kept.length === list.length) continue;
      changed = true;
      if (kept.length) hooks[ev] = kept;
      else delete hooks[ev];
    }
    for (const ev of want) {
      const list = Array.isArray(hooks[ev]) ? (hooks[ev] as unknown[]) : [];
      const e = entry(cmd, ev);
      const mine = list.filter(isOurs);
      if (mine.length === 1 && same(mine[0], e)) continue;
      hooks[ev] = list.filter((h) => !isOurs(h)).concat([mine.some(switchedOff) ? { ...e, enabled: false } : e]);
      changed = true;
    }
    if (!changed) return [{ file, changed: false }];
    settings.hooks = hooks;
    return [
      writeBack(file, editJson(settings, f), f.existed) ?? {
        file,
        changed: true,
        created: !f.existed,
        note: "a running Autopilot session picks it up after /hooks reload",
      },
    ];
  },

  uninstall(env = process.env, opts: InstallOptions = {}): InstallReport[] {
    const file = settingsFile(env);
    if (!existsSync(file)) return [{ file, changed: false }];
    const f = readJsonFile(file);
    if (!f.ok) return [{ file, changed: false, skipped: true, note: `${f.reason}; not touched` }];
    const settings = f.value;
    const hooks = settings.hooks as Record<string, unknown> | undefined;
    if (!hooks || typeof hooks !== "object") return [{ file, changed: false }];
    let changed = false;
    for (const ev of Object.keys(hooks)) {
      const list = Array.isArray(hooks[ev]) ? (hooks[ev] as unknown[]) : [];
      const kept = list.filter((h) => !isOurs(h));
      if (kept.length === list.length) continue;
      changed = true;
      if (kept.length) hooks[ev] = kept;
      else delete hooks[ev];
    }
    if (!changed) return [{ file, changed: false }];
    if (!Object.keys(hooks).length) delete settings.hooks;
    if (opts.created?.includes(file) && !Object.keys(settings).length)
      return [removeEmptied(file, editJson(settings, f))];
    return [writeBack(file, editJson(settings, f)) ?? { file, changed: true }];
  },

  installed(cmd, env = process.env, opts: InstallOptions = {}) {
    const file = settingsFile(env);
    const f = readJsonFile(file);
    const hooks = (f.ok && f.value.hooks && typeof f.value.hooks === "object" ? f.value.hooks : {}) as Record<
      string,
      unknown
    >;
    const want: string[] = eventsFor(opts.lean);
    let present = 0;
    let current = 0;
    let stray = false;
    let off = false;
    for (const [ev, raw] of Object.entries(hooks)) {
      const mine = (Array.isArray(raw) ? raw : []).filter(isOurs);
      if (!mine.length) continue;
      if (!want.includes(ev)) stray = true;
      else {
        present++;
        if (mine.length === 1 && same(mine[0], entry(cmd, ev))) current++;
      }
      // A hook of ours that is switched off (`/hooks disable sessionpipe`) runs nothing.
      if (mine.some(switchedOff)) off = true;
    }
    if (!present && !stray) return [{ file, state: "missing" }];
    if (stray || current !== want.length) return [{ file, state: "stale" }];
    if (off) return [{ file, state: "inactive", note: "switched off in Autopilot (/hooks enable sessionpipe)" }];
    return [{ file, state: "current" }];
  },

  fromHook(input: HookInput): HookResult | null {
    const event = input.argv[1] ?? "";
    let s: Record<string, unknown> = {};
    try {
      // A stdin that is JSON but not an object (`null`, a number) is no payload.
      const j: unknown = input.stdin ? JSON.parse(input.stdin) : {};
      if (j && typeof j === "object" && !Array.isArray(j)) s = j as Record<string, unknown>;
    } catch {}
    if (!isAutopilotPayload(s)) return null;
    const id = protocolId(str(s.session_id) ?? "");
    if (!SESSION_ID.test(id)) return null;
    const session: HookResult["session"] = { id, cwd: str(s.cwd) ?? input.cwd };
    if (event === "SessionStart" && str(s.model)) session.model = s.model as string;
    const tool = validTool(s.tool_name) ? s.tool_name : undefined;
    const call_id = str(s.tool_use_id);
    const ev = (type: string, data: Record<string, unknown>) => ({ type, data: prune(data), harnessEvent: event });
    const events: HookResult["events"] = [];
    switch (event) {
      case "SessionStart":
        events.push(ev("session.started", { source: s.source === "resume" ? "resume" : "startup" }));
        break;
      case "UserPromptSubmit":
        events.push(
          ev("turn.started", { prompt_chars: typeof s.prompt === "string" ? [...s.prompt].length : undefined }),
        );
        break;
      case "PreToolUse":
        if (tool) events.push(ev("tool.started", { tool, call_id, input: s.tool_input }));
        break;
      case "PostToolUse": {
        if (!tool) break;
        // Autopilot fires PostToolUse for a failed call too (and PostToolUseFailure beside
        // it, which is not hooked): `tool_response.is_error` says which, and a failure's
        // text is the top-level `error`, as in Claude Code's PostToolUseFailure.
        const response = s.tool_response as { is_error?: unknown } | undefined;
        const failed = response?.is_error === true;
        events.push(
          ev("tool.ended", {
            tool,
            call_id,
            ok: !failed,
            error: failed && typeof s.error === "string" ? s.error.slice(0, 2000) : undefined,
            input: s.tool_input,
            output: s.tool_response,
          }),
        );
        break;
      }
      case "PermissionRequest":
        // Autopilot is about to ask the person to approve the call; the payload carries
        // the call's id, which is the attention's.
        events.push(
          ev("attention.needed", {
            attention_id: call_id ?? `perm-${Date.now()}`,
            kind: "permission",
            tool,
            message: tool ? `${tool}${describe(s.tool_input)}` : undefined,
          }),
        );
        break;
      case "Stop":
        events.push(ev("turn.ended", { reason: "stop" }));
        break;
      case "StopFailure":
        // A turn that ended without reaching Stop: the person stopped it (`is_interrupt`),
        // or it failed. `error` is a kind (model_error, budget_exhausted, …), never text.
        events.push(
          ev(
            "turn.ended",
            s.is_interrupt === true ? { reason: "interrupt" } : { reason: "error", error: str(s.error)?.slice(0, 200) },
          ),
        );
        break;
      case "PreCompact":
        events.push(ev("context.compacted", { trigger: s.trigger === "manual" ? "manual" : "auto" }));
        break;
      case "SessionEnd":
        events.push(
          ev("session.ended", { reason: s.reason === "clear" ? "clear" : s.reason === "exit" ? "exit" : "other" }),
        );
        break;
      default:
        return null;
    }
    // Not mapped: a pull request the session opened. Autopilot opens them (its
    // `github_create_pr` tool) but the protocol has no event for it yet (issue #280), so
    // it reaches a receiver only as that tool's `tool.ended`. Autopilot fires no idle
    // notification of its own; `turn.ended` is when it waits for the person.
    const hints: Record<string, unknown> = {};
    // The prompt and the turn's last words, for the worker (as Claude Code's): never
    // event fields of their own, tier 2 carries them.
    if (event === "UserPromptSubmit" && typeof s.prompt === "string") hints.prompt = s.prompt;
    if (event === "Stop" && typeof s.last_assistant_message === "string" && s.last_assistant_message.trim())
      hints.final = s.last_assistant_message;
    if (typeof s.autopilot_version === "string" && VERSION.test(s.autopilot_version))
      hints.version = s.autopilot_version;
    const r: HookResult = { session, events, hints };
    // Only Claude Code's JSONL is a transcript; with AUTOPILOT_TRANSCRIPT=0 the path names
    // Autopilot's own session file (`transcript_format: "autopilot-json"`), which is not read.
    if (s.transcript_format === "claude-jsonl" && str(s.transcript_path)) r.transcript = s.transcript_path as string;
    return r;
  },

  readTranscript(file, fromLine) {
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return { turns: [], line: fromLine };
    }
    // Autopilot writes Claude Code's JSONL (its docs/beacon.md, "Transcript").
    return readClaude(text.split("\n"), fromLine);
  },

  facts(_session, transcript, hints): SessionFacts {
    const out: SessionFacts = {};
    if (typeof hints.version === "string") out.harness_version = hints.version;
    if (!transcript) return out;
    const { head, tail } = ends(transcript, 64 * 1024, 64 * 1024);
    const H = parseLines(head);
    const T = parseLines(tail);
    const first = H.find((j) => j.type === "user" && typeof (j.message as { content?: unknown })?.content === "string");
    const text = first ? String((first.message as { content: string }).content).trim() : "";
    if (text) {
      const line = text.split("\n")[0] as string;
      out.title = line.length > 80 ? `${line.slice(0, 80).replace(/\s+\S*$/, "")}…` : line;
      out.title_source = "first-ask";
    }
    const model = T.map((j) => (j.type === "assistant" ? (j.message as { model?: unknown })?.model : undefined))
      .filter((m): m is string => typeof m === "string" && !!m)
      .pop();
    if (model) out.model = model;
    const times = H.concat(T)
      .map((j) => Date.parse(String(j.timestamp ?? "")))
      .filter((n) => n > 0);
    if (times.length) {
      out.started_at = Math.min(...times);
      out.last_at = Math.max(...times);
    }
    return out;
  },

  // Not yet: the first hook of a resumed session reports it.
  backfill: () => [],
};

const VERSION = /^[0-9][0-9A-Za-z.+-]{0,63}$/;

function prune<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}
