// SPDX-License-Identifier: Apache-2.0
// Codex CLI (OpenAI) — docs: https://learn.chatgpt.com/docs/hooks
// Config: ~/.codex/hooks.json (Claude-shaped, 12 events, timeouts in seconds) AND
// `notify` at the top level of config.toml as the fallback when hooks are off or
// not yet trusted (non-managed hooks need a /hooks review in the CLI). An existing
// notify (Codex Computer Use) is chained through --previous-notify, never replaced.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { homeDir } from "../paths.js";
import { ends, parseLines, recentFiles, scanLines } from "../readers/files.js";
import { codexInjected, readCodex } from "../readers/transcripts.js";
import { installClaudeShaped, installedClaudeShaped, uninstallClaudeShaped } from "./claude-shaped.js";
import * as toml from "./codex-config.js";
import { codexReplayBoundary, codexSubagent } from "./codex-rollout.js";
import type {
  Adapter,
  BackfillRow,
  HookCommand,
  HookInput,
  HookResult,
  InstalledReport,
  InstallOptions,
  SessionFacts,
} from "./types.js";

const NAME = "codex";
export const CODEX_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PermissionRequest",
  "Stop",
  "Interrupt",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "SessionEnd",
] as const;
const OPTS = { matcherFor: (e: string) => (/Tool|Permission/.test(e) ? "" : undefined), timeout: 5 };
const eventsFor = (lean?: boolean) => (lean ? CODEX_EVENTS.filter((e) => e !== "PreToolUse") : [...CODEX_EVENTS]);

const codexHome = (env: NodeJS.ProcessEnv) => env.CODEX_HOME || path.join(homeDir(), ".codex");
const hooksFile = (env: NodeJS.ProcessEnv) => path.join(codexHome(env), "hooks.json");
const configFile = (env: NodeJS.ProcessEnv) => path.join(codexHome(env), "config.toml");
const sessionsDir = (env: NodeJS.ProcessEnv) => path.join(codexHome(env), "sessions");

const validTool = (n: unknown): n is string => typeof n === "string" && /^[A-Za-z0-9_.:-]{1,120}$/.test(n);
const endReason = (r: unknown): "clear" | "logout" | "exit" | "other" =>
  r === "clear" || r === "logout" || r === "exit" ? r : "other";

function installNotify(cmd: HookCommand, env: NodeJS.ProcessEnv) {
  const file = configFile(env);
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {}
  const argv = cmd([NAME, "notify"]).argv;
  const line = `notify = ${JSON.stringify(argv)}`;
  const n = toml.readNotify(text);
  const write = (next: string) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, next);
  };
  if (n && !n.other) {
    if (!n.misplaced && JSON.stringify(n.argv) === JSON.stringify(argv))
      return { file, changed: false, note: "notify current" };
    write(toml.withNotify(text, line));
    return {
      file,
      changed: true,
      note: n.misplaced
        ? "notify moved to the top level (it sat inside a [table], where Codex never reads it)"
        : "notify updated",
    };
  }
  if (n?.other) {
    const prev = toml.previousNotify(n.argv);
    if (toml.isComputerUse(n.argv)) {
      if (prev && toml.OURS.test(JSON.stringify(prev))) {
        if (JSON.stringify(prev) === JSON.stringify(argv))
          return { file, changed: false, note: "notify current (after Codex Computer Use)" };
      }
      if (!prev || toml.OURS.test(JSON.stringify(prev))) {
        write(toml.replaceNotify(text, n, `notify = ${toml.withPreviousRaw(n.raw, argv)}`));
        return { file, changed: true, note: "chained after Codex Computer Use (--previous-notify)" };
      }
    }
    return {
      file,
      changed: false,
      skipped: true,
      note: `notify belongs to ${(n.argv?.[0] ?? n.raw).replace(/^.*\//, "").slice(0, 40)}; left alone. Codex will report nothing until you approve the hooks: start \`codex\` and accept the hook review`,
    };
  }
  write(toml.withNotify(text, line));
  return { file, changed: true, note: "notify set at the top level" };
}

function uninstallNotify(env: NodeJS.ProcessEnv) {
  const file = configFile(env);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { file, changed: false };
  }
  const n = toml.readNotify(text);
  if (!n) return { file, changed: false };
  if (!n.other) {
    writeFileSync(file, toml.withoutNotify(text));
    return { file, changed: true };
  }
  const prev = toml.previousNotify(n.argv);
  if (toml.isComputerUse(n.argv) && prev && toml.OURS.test(JSON.stringify(prev))) {
    writeFileSync(file, toml.replaceNotify(text, n, `notify = ${toml.stripPreviousRaw(n.raw)}`));
    return { file, changed: true };
  }
  return { file, changed: false };
}

/** The rollout file of one thread: `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<time>-<thread
 *  id>.jsonl`, newest day first. Null for an id that isn't a thread id's shape, so a
 *  short or odd one never matches some other session's file. */
export function findRollout(threadId: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!/^[A-Za-z0-9-]{8,128}$/.test(threadId)) return null;
  let best: string | null = null;
  const walk = (dir: string, depth: number) => {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names.sort().reverse()) {
      const p = path.join(dir, n);
      if (n.endsWith(`-${threadId}.jsonl`)) {
        best = p;
        return;
      }
      if (depth < 3) {
        walk(p, depth + 1);
        if (best) return;
      }
    }
  };
  walk(sessionsDir(env), 0);
  return best;
}

/** A rollout's first record, its own session_meta. About 50 KB (it carries the base
 *  instructions), so it is read on its own rather than from a sampled head. */
function rolloutMeta(file: string): Record<string, unknown> | null {
  return scanLines(file, (line) => parseLines([line])[0] ?? {});
}

/** A rollout named for a thread other than `id` (`rollout-<time>-<thread id>.jsonl`).
 *  A name of any other shape says nothing, so it is not taken for another thread's. */
function ofAnotherThread(file: string, id: string): boolean {
  const m = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/i.exec(file);
  return !!m?.[1] && m[1].toLowerCase() !== id.toLowerCase();
}

export const codex: Adapter = {
  name: NAME,
  events: CODEX_EVENTS,
  detect: (env = process.env) => existsSync(codexHome(env)),
  configFiles: (env = process.env) => [hooksFile(env), configFile(env)],
  install: (cmd, env = process.env, opts: InstallOptions = {}) => [
    installClaudeShaped(hooksFile(env), NAME, eventsFor(opts.lean), cmd, OPTS),
    installNotify(cmd, env),
  ],
  uninstall: (env = process.env, opts: InstallOptions = {}) => [
    uninstallClaudeShaped(hooksFile(env), CODEX_EVENTS, { created: opts.created?.includes(hooksFile(env)) }),
    uninstallNotify(env),
  ],
  installed: (cmd, env = process.env, opts: InstallOptions = {}) => {
    const out: InstalledReport[] = [
      {
        file: hooksFile(env),
        state: installedClaudeShaped(hooksFile(env), NAME, eventsFor(opts.lean), cmd, OPTS),
        note: "Codex runs non-managed hooks only after the review in `codex` (/hooks); until then nothing is reported unless the notify fallback is ours",
      },
    ];
    let text = "";
    try {
      text = readFileSync(configFile(env), "utf8");
    } catch {}
    const n = toml.readNotify(text);
    const argv = cmd([NAME, "notify"]).argv;
    const prev = n ? toml.previousNotify(n.argv) : null;
    const ours = n && (!n.other || (prev && JSON.stringify(prev) === JSON.stringify(argv)));
    out.push({
      file: configFile(env),
      state:
        !n || (n.other && !ours)
          ? "missing"
          : n.misplaced
            ? "misplaced"
            : JSON.stringify(n.argv) === JSON.stringify(argv) || (prev && JSON.stringify(prev) === JSON.stringify(argv))
              ? "current"
              : "stale",
    });
    return out;
  },

  fromHook(input: HookInput): HookResult | null {
    const event = input.argv[1] ?? "";
    let s: Record<string, unknown> = {};
    if (event === "notify") {
      // Codex's notify passes one JSON argument: {"type":"agent-turn-complete","thread-id":…,"turn-id":…,"cwd":…}
      const raw = input.argv.find((a) => a.startsWith("{")) ?? input.stdin;
      try {
        const j: unknown = raw ? JSON.parse(raw) : {};
        if (j && typeof j === "object" && !Array.isArray(j)) s = j as Record<string, unknown>;
      } catch {}
      const id = (s["thread-id"] ?? s.thread_id ?? s["session-id"] ?? s.session_id) as string | undefined;
      if (!id) return null;
      // Notify names the thread whose turn ended. Without a rollout it is an ephemeral
      // thread, kept nowhere (the hooks' `transcript_path: null` below). A subagent's
      // thread belongs to its parent, whose hooks already report it: SubagentStart and
      // SubagentStop name it as `agent_id`. Neither is a session of its own.
      const file = findRollout(String(id), input.env as NodeJS.ProcessEnv);
      if (!file || codexSubagent(rolloutMeta(file))) return null;
      const r: HookResult = {
        session: { id: String(id), cwd: typeof s.cwd === "string" ? s.cwd : input.cwd },
        events: [
          {
            type: "turn.ended",
            data: { reason: "stop", ...(typeof s["turn-id"] === "string" ? { turn_id: s["turn-id"] } : {}) },
            harnessEvent: "notify",
          },
        ],
        hints: {},
        transcript: file,
      };
      return r;
    }
    try {
      // A stdin that is JSON but not an object (`null`, a number) is no payload.
      const j: unknown = input.stdin ? JSON.parse(input.stdin) : {};
      if (j && typeof j === "object" && !Array.isArray(j)) s = j as Record<string, unknown>;
    } catch {}
    const id = s.session_id as string | undefined;
    if (!id) return null;
    // `transcript_path: null` is an ephemeral thread (recorded on codex-cli 0.160.0):
    // Codex Desktop's own background threads (ambient suggestions and their safety
    // review) and `codex exec --ephemeral`. Codex keeps nothing of one, so there is no
    // session to name, read or resume.
    if (s.transcript_path === null) return null;
    const session: HookResult["session"] = { id: String(id), cwd: typeof s.cwd === "string" ? s.cwd : input.cwd };
    if (typeof s.model === "string") session.model = s.model;
    const turn_id = typeof s.turn_id === "string" ? s.turn_id : undefined;
    const tool = validTool(s.tool_name) ? s.tool_name : undefined;
    const call_id = typeof s.tool_use_id === "string" ? s.tool_use_id : undefined;
    const ev = (type: string, data: Record<string, unknown>) => ({ type, data: prune(data), harnessEvent: event });
    const events: HookResult["events"] = [];
    switch (event) {
      case "SessionStart":
        events.push(
          ev("session.started", {
            source:
              typeof s.source === "string" && ["startup", "resume", "clear", "compact", "fork"].includes(s.source)
                ? s.source
                : "unknown",
          }),
        );
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
        if (tool) events.push(ev("tool.started", { tool, call_id, turn_id, input: s.tool_input }));
        break;
      case "PostToolUse":
        if (tool)
          events.push(
            ev("tool.ended", { tool, call_id, turn_id, ok: true, input: s.tool_input, output: s.tool_response }),
          );
        break;
      case "PermissionRequest":
        events.push(
          ev("attention.needed", { attention_id: call_id ?? `perm-${Date.now()}`, kind: "permission", tool }),
        );
        break;
      case "Stop":
        events.push(ev("turn.ended", { turn_id, reason: "stop" }));
        break;
      case "Interrupt":
        events.push(ev("turn.ended", { turn_id, reason: "interrupt" }));
        break;
      case "SubagentStart":
        events.push(
          ev("subagent.started", {
            agent_id: String(s.agent_id ?? s.subagent_id ?? ""),
            agent_type: typeof s.agent_type === "string" ? s.agent_type : undefined,
          }),
        );
        break;
      case "SubagentStop":
        events.push(
          ev("subagent.ended", {
            agent_id: String(s.agent_id ?? s.subagent_id ?? ""),
            agent_type: typeof s.agent_type === "string" ? s.agent_type : undefined,
          }),
        );
        break;
      case "PreCompact":
        events.push(ev("context.compacted", { trigger: s.trigger === "manual" ? "manual" : "auto" }));
        break;
      case "PostCompact":
        break;
      case "SessionEnd":
        events.push(ev("session.ended", { reason: endReason(s.reason) }));
        break;
      default:
        return null;
    }
    const r: HookResult = { session, events, hints: {} };
    // Inside a subagent Codex sends the parent's session_id with the subagent's own
    // rollout (its SubagentStart, its tool calls): that file is not this session's.
    if (typeof s.transcript_path === "string" && !ofAnotherThread(s.transcript_path, String(id)))
      r.transcript = s.transcript_path;
    return r;
  },

  readTranscript(file, fromLine) {
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return { turns: [], line: fromLine };
    }
    return readCodex(text.split("\n"), fromLine);
  },

  facts(session, transcript): SessionFacts {
    const out: SessionFacts = {};
    if (transcript) Object.assign(out, codexFacts(transcript));
    return out;
  },

  backfill(sinceMs, env = process.env): BackfillRow[] {
    const rows: BackfillRow[] = [];
    for (const f of recentFiles(sessionsDir(env), 3, sinceMs, (n) => /^rollout-.*\.jsonl$/.test(n))) {
      const m = /([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i.exec(path.basename(f));
      if (!m?.[1]) continue;
      // A subagent's rollout is part of its parent's session, as in fromHook's notify.
      if (codexSubagent(rolloutMeta(f))) continue;
      const facts = codexFacts(f);
      if (!facts.started_at || !facts.last_at) continue;
      const { started_at, last_at, first_ask: _fa, harness_version: _hv, ...rest } = facts;
      rows.push({ session: { id: m[1], ...rest }, started_at, last_at });
    }
    return rows;
  },
};

function prune<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

/** Codex keeps no title; its first real ask stands in. A fork's replay is not its ask. */
export function codexFacts(file: string): SessionFacts {
  const { head, tail } = ends(file, 128 * 1024, 64 * 1024);
  let H = parseLines(head);
  let T = parseLines(tail);
  const out: SessionFacts = {};
  const meta = H.find((j) => j.type === "session_meta" && j.payload);
  const boundary = codexReplayBoundary(meta);
  if (meta?.payload) {
    const p = meta.payload as {
      cwd?: string;
      cli_version?: string;
      git?: { branch?: string; repository_url?: string };
    };
    if (p.cwd) out.cwd = p.cwd;
    if (p.cli_version) out.harness_version = String(p.cli_version);
    if (p.git?.branch) out.branch = p.git.branch;
    if (p.git?.repository_url) out.repo = String(p.git.repository_url).replace(/\/\/[^/@]*@/, "//");
  }
  if (boundary) {
    const h = H.findIndex(boundary);
    const t = T.findIndex(boundary);
    H = h < 0 ? [] : H.slice(h);
    // The samples can overlap, so trim each one at the boundary independently.
    // If both miss it, scan the gap before trusting the tail: it could still be
    // parent replay. Stop as soon as the boundary is found, without loading the file.
    const found =
      h >= 0 ||
      t >= 0 ||
      scanLines(file, (line) => (boundary(parseLines([line])[0] ?? null) ? true : null), Number.POSITIVE_INFINITY);
    T = t >= 0 ? T.slice(t) : found ? T : [];
  }
  const ctx = H.concat(T)
    .reverse()
    .find((j) => j.type === "turn_context" && (j.payload as { model?: string } | undefined)?.model) as
    | { payload?: { model?: string } }
    | undefined;
  if (ctx?.payload?.model) out.model = ctx.payload.model;
  for (const j of H) {
    const p = j.payload as { type?: string; role?: string; content?: { type?: string; text?: string }[] } | undefined;
    if (j.type !== "response_item" || !p || p.type !== "message" || p.role !== "user") continue;
    const text = (p.content ?? [])
      .filter((b) => b && b.type === "input_text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n")
      .trim();
    if (!text || codexInjected(text)) continue;
    const line = text.split("\n")[0] as string; // trimmed, so its first line is its first non-blank one
    out.title = line.length > 80 ? `${line.slice(0, 80).replace(/\s+\S*$/, "")}…` : line;
    out.title_source = "first-ask";
    break;
  }
  const times = (boundary && meta ? [meta, ...H, ...T] : H.concat(T))
    .map((j) => Date.parse(String(j.timestamp ?? "")))
    .filter((n) => n > 0);
  if (times.length) {
    out.started_at = Math.min(...times);
    out.last_at = Math.max(...times);
  }
  return out;
}
