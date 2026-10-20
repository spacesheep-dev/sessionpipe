// SPDX-License-Identifier: Apache-2.0
// Gemini CLI (Google) — docs: https://geminicli.com/docs/hooks/reference
// Config: ~/.gemini/settings.json `hooks` key, same array-of-groups shape as Claude
// Code but timeouts in MILLISECONDS and a `name` per handler. stdout must be JSON or
// empty. Its own telemetry defaults logPrompts on; the installer says so once.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { HOME } from "../paths.js";
import { ends, parseLines } from "../readers/files.js";
import { readGemini } from "../readers/transcripts.js";
import { installClaudeShaped, installedClaudeShaped, uninstallClaudeShaped } from "./claude-shaped.js";
import type { Adapter, HookInput, HookResult, InstallOptions, SessionFacts } from "./types.js";

const NAME = "gemini-cli";
export const GEMINI_EVENTS = [
  "SessionStart",
  "BeforeAgent",
  "BeforeTool",
  "AfterTool",
  "Notification",
  "AfterAgent",
  "PreCompress",
  "SessionEnd",
] as const;
const OPTS = { matcherFor: (e: string) => (/Tool/.test(e) ? ".*" : undefined), timeout: 5000 };
const geminiDir = (env: NodeJS.ProcessEnv) => env.GEMINI_CLI_HOME || path.join(HOME, ".gemini");
const settings = (env: NodeJS.ProcessEnv) => path.join(geminiDir(env), "settings.json");
const validTool = (n: unknown): n is string => typeof n === "string" && /^[A-Za-z0-9_.:-]{1,120}$/.test(n);
const eventsFor = (lean?: boolean) => (lean ? GEMINI_EVENTS.filter((e) => e !== "BeforeTool") : [...GEMINI_EVENTS]);

/** Before 0.46 the hooks system is off unless tools.enableHooks is true (issue #11). */
export function geminiHooksActive(settingsFile: string): { active: boolean; note?: string } {
  let tools: { enableHooks?: unknown } | undefined;
  try {
    tools = (JSON.parse(readFileSync(settingsFile, "utf8")) as { tools?: { enableHooks?: unknown } }).tools;
  } catch {}
  if (tools?.enableHooks === true) return { active: true };
  if (tools?.enableHooks === false)
    return { active: false, note: "inactive: tools.enableHooks is false in settings.json" };
  let version = "";
  try {
    version = execFileSync("gemini", ["--version"], {
      encoding: "utf8",
      timeout: 4000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return {
      active: true,
      note: "could not run `gemini --version`; hooks need tools.enableHooks on versions before 0.46",
    };
  }
  const m = /(\d+)\.(\d+)/.exec(version);
  if (m && (Number(m[1]) > 0 || Number(m[2]) >= 46)) return { active: true };
  return {
    active: false,
    note: `inactive: Gemini CLI ${version || "?"} runs hooks only with "tools": {"enableHooks": true} in settings.json`,
  };
}

export const geminiCli: Adapter = {
  name: NAME,
  events: GEMINI_EVENTS,
  // ~/.gemini also belongs to Antigravity; Gemini CLI is here when its settings or its chat logs exist.
  detect: (env = process.env) => existsSync(settings(env)) || existsSync(path.join(geminiDir(env), "tmp")),
  configFiles: (env = process.env) => [settings(env)],
  install: (cmd, env = process.env, opts: InstallOptions = {}) => {
    const r = installClaudeShaped(settings(env), NAME, eventsFor(opts.lean), cmd, OPTS);
    const a = geminiHooksActive(settings(env));
    return [a.note && !r.skipped ? { ...r, note: [r.note, a.note].filter(Boolean).join("; ") } : r];
  },
  uninstall: (env = process.env, opts: InstallOptions = {}) => [
    uninstallClaudeShaped(settings(env), GEMINI_EVENTS, { created: opts.created?.includes(settings(env)) }),
  ],
  installed: (cmd, env = process.env, opts: InstallOptions = {}) => {
    const state = installedClaudeShaped(settings(env), NAME, eventsFor(opts.lean), cmd, OPTS);
    const a = geminiHooksActive(settings(env));
    return [
      {
        file: settings(env),
        state: state === "current" && !a.active ? "inactive" : state,
        ...(a.note ? { note: a.note } : {}),
      },
    ];
  },

  fromHook(input: HookInput): HookResult | null {
    const event = input.argv[1] ?? "";
    let s: Record<string, unknown> = {};
    try {
      // A stdin that is JSON but not an object (`null`, a number) is no payload.
      const j: unknown = input.stdin ? JSON.parse(input.stdin) : {};
      if (j && typeof j === "object" && !Array.isArray(j)) s = j as Record<string, unknown>;
    } catch {}
    const id = s.session_id as string | undefined;
    if (!id) return null;
    const session: HookResult["session"] = { id: String(id), cwd: typeof s.cwd === "string" ? s.cwd : input.cwd };
    const tool = validTool(s.tool_name) ? s.tool_name : undefined;
    const ev = (type: string, data: Record<string, unknown>) => ({ type, data: prune(data), harnessEvent: event });
    const events: HookResult["events"] = [];
    switch (event) {
      case "SessionStart":
        events.push(
          ev("session.started", {
            source:
              typeof s.source === "string" && ["startup", "resume", "clear"].includes(s.source) ? s.source : "unknown",
          }),
        );
        break;
      case "BeforeAgent":
        events.push(
          ev("turn.started", { prompt_chars: typeof s.prompt === "string" ? [...s.prompt].length : undefined }),
        );
        break;
      case "BeforeTool":
        if (tool) events.push(ev("tool.started", { tool, input: s.tool_input }));
        break;
      case "AfterTool": {
        const resp = s.tool_response as { error?: unknown; llmContent?: unknown } | undefined;
        const err =
          resp && typeof resp === "object" && resp.error
            ? String(typeof resp.error === "string" ? resp.error : JSON.stringify(resp.error)).slice(0, 2000)
            : undefined;
        if (tool)
          events.push(
            ev("tool.ended", {
              tool,
              ok: !err,
              error: err,
              input: s.tool_input,
              output: resp?.llmContent ?? s.tool_response,
            }),
          );
        break;
      }
      case "Notification":
        events.push(
          ev("attention.needed", {
            attention_id: `notif-${Date.now()}`,
            kind: s.notification_type === "ToolPermission" ? "permission" : "question",
            message: typeof s.message === "string" ? s.message.slice(0, 200) : undefined,
          }),
        );
        break;
      case "AfterAgent":
        events.push(ev("turn.ended", { reason: "stop" }));
        break;
      case "PreCompress":
        events.push(ev("context.compacted", { trigger: s.trigger === "manual" ? "manual" : "auto" }));
        break;
      case "SessionEnd":
        events.push(
          ev("session.ended", {
            reason:
              s.reason === "clear" || s.reason === "logout" || s.reason === "exit"
                ? s.reason
                : s.reason === "prompt_input_exit"
                  ? "exit"
                  : "other",
          }),
        );
        break;
      default:
        return null;
    }
    const r: HookResult = { session, events, hints: {} };
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
    return readGemini(text.split("\n"), fromLine);
  },

  facts(_session, transcript): SessionFacts {
    const out: SessionFacts = {};
    if (!transcript) return out;
    const { head, tail } = ends(transcript, 64 * 1024, 64 * 1024);
    const H = parseLines(head);
    const T = parseLines(tail);
    const first = H.find((j) => j.type === "user");
    const raw = first ? (first.content ?? first.message ?? first.text) : undefined;
    const text = typeof raw === "string" ? raw.trim() : "";
    if (text) {
      const line = text.split("\n")[0] as string; // trimmed, so its first line is its first non-blank one
      out.title = line.length > 80 ? `${line.slice(0, 80).replace(/\s+\S*$/, "")}…` : line;
      out.title_source = "first-ask";
    }
    const times = H.concat(T)
      .map((j) => Date.parse(String(j.timestamp ?? "")))
      .filter((n) => n > 0);
    if (times.length) {
      out.started_at = Math.min(...times);
      out.last_at = Math.max(...times);
    }
    return out;
  },

  backfill: () => [], // chat logs are keyed by a project hash, not a session id we can name; the first hook of a resumed session reports it
};

function prune<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}
