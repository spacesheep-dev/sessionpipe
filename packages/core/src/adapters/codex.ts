// SPDX-License-Identifier: Apache-2.0
// Codex CLI (OpenAI) — docs: https://learn.chatgpt.com/docs/hooks
// Config: ~/.codex/hooks.json (Claude-shaped, 12 events, timeouts in seconds) AND
// `notify` at the top level of config.toml as the fallback when hooks are off or
// not yet trusted (non-managed hooks need a /hooks review in the CLI). An existing
// notify (Codex Computer Use) is chained through --previous-notify, never replaced.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { homeDir } from "../paths.js";
import { ends, parseLines, recentFiles, scanLines } from "../readers/files.js";
import { codexInjected, codexWords, readCodex } from "../readers/transcripts.js";
import type { DataOf, HarnessAccount } from "../types.js";
import { installClaudeShaped, installedClaudeShaped, uninstallClaudeShaped, writeBack } from "./claude-shaped.js";
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
  InstallReport,
  SessionFacts,
  TurnEnd,
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

const idPart = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
/** A ChatGPT account as `account_id` names it: the account's id (a workspace's, on a team
 *  plan) and, where Codex knows it, the person's own id within it, `<account>.<user>`.
 *  Both, because a workspace is shared: its id alone would file every colleague's sessions
 *  and limits under one account. It is the pair Codex itself keeps a thread's creator by.
 *  Opaque ids, never an email. */
function accountOf(account: unknown, user: unknown): string | null {
  if (!idPart(account)) return null;
  return idPart(user) && account.length + user.length < 128 ? `${account}.${user}` : account;
}
/** An address to label an account by. Nothing a board could be made to draw as anything
 *  else: no spaces, control or direction characters, or angle brackets. */
const EMAIL_RE = /^[^@\s<>\p{Cc}\p{Cf}]{1,64}@[^@\s<>\p{Cc}\p{Cf}]{1,189}$/u;
/** A sign-in file is a few kilobytes; nothing larger, and nothing that is not a file, is read. */
const AUTH_MAX = 1024 * 1024;

/** The claims of a sign-in token (a JWT's middle part), unverified: read for a label, and
 *  nothing is trusted on their word. */
function claims(jwt: unknown): Record<string, unknown> {
  try {
    const part = typeof jwt === "string" ? jwt.split(".")[1] : undefined;
    const j: unknown = part ? JSON.parse(Buffer.from(part, "base64url").toString("utf8")) : null;
    return j && typeof j === "object" ? (j as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Who this machine's Codex is signed in as: the account as a session's `account_id`
 *  names it (accountOf), and the email it signs in with, which travels only to a receiver
 *  the person paired with (control's hello). From Codex's own sign-in file
 *  (`$CODEX_HOME/auth.json`): its `tokens.account_id`, and from its id token's claims the
 *  person's id and email. Nothing else of the file is used, and its tokens are never
 *  kept, logged or sent. Nobody for an API key, for a sign-in Codex keeps in the system's
 *  keyring (there is no file then), and for a file that cannot be read. */
export function codexAccounts(env: NodeJS.ProcessEnv = process.env): HarnessAccount[] {
  try {
    const file = path.join(codexHome(env), "auth.json");
    const st = statSync(file);
    if (!st.isFile() || st.size > AUTH_MAX) return [];
    const tokens = (JSON.parse(readFileSync(file, "utf8")) as { tokens?: { account_id?: unknown; id_token?: unknown } })
      .tokens;
    const c = claims(tokens?.id_token);
    const auth = (c["https://api.openai.com/auth"] ?? {}) as { chatgpt_user_id?: unknown; user_id?: unknown };
    const id = accountOf(tokens?.account_id, auth.chatgpt_user_id ?? auth.user_id);
    if (!id) return [];
    const profile = c["https://api.openai.com/profile"] as { email?: unknown } | undefined;
    const email = [c.email, profile?.email].find((e): e is string => typeof e === "string" && EMAIL_RE.test(e));
    return [{ harness: NAME, id, ...(email ? { email } : {}) }];
  } catch {
    return [];
  }
}

/** How much of a rollout's end is read for a command's result. Codex cuts a command's
 *  output before it writes it, but an output of control characters still made a line of
 *  240 KB, and other records can follow it before the worker looks. */
const TOOL_RESULT_TAIL = 1024 * 1024;
const EXITED = /^(?:Chunk ID: [^\n]*\n)?Wall time: [^\n]*\nProcess exited with code (-?\d{1,10})\n/;

/** How much of a rollout's end is read for a turn's end record. */
const TURN_END_TAIL = 4 * 1024 * 1024;

/** One line of a rollout, or null for one that is not JSON. */
function rolloutLine(line: string): { type?: unknown; payload?: Record<string, unknown> } | null {
  try {
    return JSON.parse(line) as { type?: unknown; payload?: Record<string, unknown> } | null;
  } catch {
    return null;
  }
}

/** Codex's class for an error (`codex_error_info`): a name (`usage_limit_exceeded`,
 *  `unauthorized`, `other`), or an object whose one key is the name
 *  (`{"response_too_many_failed_attempts": {"http_status_code": 500}}`). The name alone:
 *  the error's message can hold an address or the service's own words. */
function errorClass(info: unknown): string | undefined {
  const name = typeof info === "string" ? info : info && typeof info === "object" ? Object.keys(info)[0] : undefined;
  return name && /^[a-z][a-z0-9_]{0,63}$/.test(name) ? name : undefined;
}

const validTool = (n: unknown): n is string => typeof n === "string" && /^[A-Za-z0-9_.:-]{1,120}$/.test(n);
const endReason = (r: unknown): "clear" | "logout" | "exit" | "other" =>
  r === "clear" || r === "logout" || r === "exit" ? r : "other";

/** What config.toml without our notify line means, said with every refusal of it. */
const UNTIL_APPROVED =
  "Codex will report nothing until you approve the hooks: start `codex` and accept the hook review";

function installNotify(cmd: HookCommand, env: NodeJS.ProcessEnv) {
  const file = configFile(env);
  let text = "";
  let existed = true;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    // Absent only when the system says so: a file that is there but can't be read (0200,
    // root's) is still the person's, never `created` for uninstall to delete.
    existed = (e as NodeJS.ErrnoException).code !== "ENOENT";
  }
  const argv = cmd([NAME, "notify"]).argv;
  const line = `notify = ${JSON.stringify(argv)}`;
  const n = toml.readNotify(text);
  /** The file written, with this note; or the refusal's report in its place. */
  const write = (next: string, note: string): InstallReport => {
    const bad = writeBack(file, next, existed);
    return bad ? { ...bad, note: `${bad.note}. ${UNTIL_APPROVED}` } : { file, changed: true, note };
  };
  if (n && !n.other) {
    if (!n.misplaced && JSON.stringify(n.argv) === JSON.stringify(argv))
      return { file, changed: false, note: "notify current" };
    return write(
      toml.withNotify(text, line),
      n.misplaced
        ? "notify moved to the top level (it sat inside a [table], where Codex never reads it)"
        : "notify updated",
    );
  }
  if (n?.other) {
    const prev = toml.previousNotify(n.argv);
    if (toml.isComputerUse(n.argv)) {
      if (prev && toml.OURS.test(JSON.stringify(prev))) {
        if (JSON.stringify(prev) === JSON.stringify(argv))
          return { file, changed: false, note: "notify current (after Codex Computer Use)" };
      }
      if (!prev || toml.OURS.test(JSON.stringify(prev)))
        return write(
          toml.replaceNotify(text, n, `notify = ${toml.withPreviousRaw(n.raw, argv)}`),
          "chained after Codex Computer Use (--previous-notify)",
        );
    }
    return {
      file,
      changed: false,
      skipped: true,
      note: `notify belongs to ${(n.argv?.[0] ?? n.raw).replace(/^.*\//, "").slice(0, 40)}; left alone. ${UNTIL_APPROVED}`,
    };
  }
  return write(toml.withNotify(text, line), "notify set at the top level");
}

function uninstallNotify(env: NodeJS.ProcessEnv): InstallReport {
  const file = configFile(env);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { file, changed: false };
  }
  const n = toml.readNotify(text);
  if (!n) return { file, changed: false };
  if (!n.other) return writeBack(file, toml.withoutNotify(text)) ?? { file, changed: true };
  const prev = toml.previousNotify(n.argv);
  if (toml.isComputerUse(n.argv) && prev && toml.OURS.test(JSON.stringify(prev)))
    return (
      writeBack(file, toml.replaceNotify(text, n, `notify = ${toml.stripPreviousRaw(n.raw)}`)) ?? {
        file,
        changed: true,
      }
    );
  return { file, changed: false };
}

/** Whether a Codex that locks its threads has this one's lock file: `<CODEX_HOME>/
 *  thread-writer-locks/<thread>.lock`, made by the process that opens the thread and
 *  removed when it lets go in the ordinary way (0.171.0). A holder that is killed leaves
 *  the file behind with nothing locking it, so the file is no proof that the thread is
 *  held; that it is absent says no Codex of that kind has it. Codex's own answer to a
 *  second writer is the proof (codex-control's `heldElsewhere`). */
export function threadLocked(thread: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    /^[A-Za-z0-9-]{8,128}$/.test(thread) &&
    existsSync(path.join(codexHome(env), "thread-writer-locks", `${thread.toLowerCase()}.lock`))
  );
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
  const other = threadOf(file);
  return !!other && other !== id.toLowerCase();
}
/** The thread a rollout is named for, lowercased; null for a name of any other shape. */
function threadOf(file: string): string | null {
  const m = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/i.exec(file);
  return m?.[1] ? m[1].toLowerCase() : null;
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
      // Notify is Codex's word for more than one thing in principle, and a turn's end is
      // the only one it has (`agent-turn-complete`, codex-rs hooks/src/legacy_notify.rs at
      // 0.171.0): any other `type` is not a turn's end.
      if (typeof s.type === "string" && s.type !== "agent-turn-complete") return null;
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
        // With its hooks on as well, Codex says this turn's end twice: the Stop hook, then
        // this, under one turn id (measured on 0.171.0). `fallback` tells the worker which
        // road an end came by, so that the second of the two is dropped (cli/src/run.ts).
        hints: { fallback: true },
        transcript: file,
      };
      return r;
    }
    try {
      // A stdin that is JSON but not an object (`null`, a number) is no payload.
      const j: unknown = input.stdin ? JSON.parse(input.stdin) : {};
      if (j && typeof j === "object" && !Array.isArray(j)) s = j as Record<string, unknown>;
    } catch {}
    const id = (s.session_id ?? s.thread_id ?? s.conversation_id ?? s["thread-id"] ?? s["session-id"]) as
      | string
      | undefined;
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
    // A subagent's hooks carry the parent's session_id (ADAPTERS.md, Threads): its own
    // id where the payload names it, else the thread its rollout is named for. Without
    // it a subagent's tool calls read as the main thread's (issue #208: a sink that
    // thins subagents' tool events would be sent every one).
    const thread = typeof s.transcript_path === "string" ? threadOf(s.transcript_path) : null;
    const agent_id =
      typeof s.agent_id === "string" && s.agent_id
        ? s.agent_id
        : typeof s.subagent_id === "string" && s.subagent_id
          ? s.subagent_id
          : thread && thread !== String(id).toLowerCase()
            ? thread
            : undefined;
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
              ok: true,
              input: s.tool_input,
              output: s.tool_response,
            }),
          );
        break;
      case "PermissionRequest":
        events.push(
          ev("attention.needed", {
            attention_id: call_id ?? `perm-${Date.now()}`,
            kind: "permission",
            tool,
            agent_id,
          }),
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
    const r: HookResult = { session, events, hints: event === "SessionStart" ? { started: true } : {} };
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

  /** A command's result as its rollout says it: the call's `function_call_output`, whose
   *  `call_id` is the hook's `tool_use_id` and whose `output` starts with what Codex adds
   *  before the command's own output, `Wall time: … seconds` and `Process exited with
   *  code N` (0.171.0; conformance/transcripts/codex/command-exits.jsonl). Codex writes
   *  it some 10 ms after its PostToolUse hook, which carries the output alone. Null only
   *  where the result may still come: the call is in the file and its result is not. A
   *  call the file does not hold (an older Codex names its calls otherwise), an edit
   *  (`custom_tool_call_output`) and a result in another form (a command still running, a
   *  tool that is no command) have nothing to read and nothing to wait for. */
  toolResult(transcript, callId) {
    const lines = ends(transcript, 0, TOOL_RESULT_TAIL).tail;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i] as string;
      if (!line.includes(callId)) continue;
      const j = rolloutLine(line);
      const p = j?.payload;
      if (j?.type !== "response_item" || !p || p.call_id !== callId) continue;
      // Read from the end: the call itself, met before any result of it, has none yet.
      if (p.type === "function_call") return null;
      if (p.type !== "function_call_output") continue;
      // Only the lines Codex itself puts first: the command's own output comes after them
      // and may say anything.
      const code = typeof p.output === "string" ? EXITED.exec(p.output)?.[1] : undefined;
      if (code === undefined) return {};
      return code === "0" ? { ok: true } : { ok: false, error: `exit ${code}` };
    }
    return {};
  },

  /** A turn's end as its rollout says it: `task_complete` (with an `error` when the turn
   *  failed, whose `codex_error_info` is the error's class) or `turn_aborted`, each
   *  naming its `turn_id`, the id the hooks give (0.171.0). */
  turnEnd(transcript, turnId): TurnEnd | null {
    // From the end, and no further back than TURN_END_TAIL: the turn asked about is the
    // last one or the one before it, and a rollout runs to hundreds of megabytes.
    const lines = ends(transcript, 0, TURN_END_TAIL).tail;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i] as string;
      if (!line.includes(turnId) || !/"(task_complete|turn_aborted)"/.test(line)) continue;
      const j = rolloutLine(line);
      const p = j?.payload;
      if (j?.type !== "event_msg" || !p || p.turn_id !== turnId) continue;
      if (p.type === "turn_aborted") return { reason: "interrupt" };
      if (p.type !== "task_complete") continue;
      if (!p.error) return { reason: "stop" };
      const cls = errorClass((p.error as { codex_error_info?: unknown }).codex_error_info);
      return { reason: "error", ...(cls ? { error: cls } : {}) };
    }
    return null;
  },

  facts(session, transcript, hints, state, env = process.env): SessionFacts {
    // A Codex process holds the sign-in it started with: who that was is kept for the
    // limits its turns will leave (`limits`), and asked again at each start.
    if (hints.started === true) state.save(NAME, session.id, { signed_in_as: codexAccounts(env)[0]?.id ?? null });
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
      rows.push({ session: { id: m[1], ...rest }, started_at, last_at, transcript: f });
    }
    return rows;
  },

  /** The limits a turn left in the rollout, with the account they are: the one this
   *  Codex process started under (`facts`, at its SessionStart). A thread keeps its
   *  creator's account for good, and one resumed after the person changed account runs on
   *  the new one's limits; a window left open while the person signs in elsewhere keeps
   *  running on the account it started with. With no start seen (hooks not yet approved),
   *  the numbers go unstamped and are the session's account's. */
  limits(transcript, about) {
    const limits = codexLimits(transcript);
    const as = limits && about ? about.state.get(NAME, about.session).signed_in_as : undefined;
    return limits && typeof as === "string" ? { ...limits, account_id: as } : limits;
  },
};

/** Epoch seconds as RFC 3339; anything that is not a plausible time is no time. */
const epochIso = (t: unknown): string | undefined =>
  typeof t === "number" && t > 0 && t < 1e11 ? new Date(t * 1000).toISOString() : undefined;

function prune<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

/** The account's limits from the last `token_count` that carries them (recorded
 *  2026-10-21, codex-cli 0.163): `rate_limits.primary` / `secondary`, each with
 *  `used_percent`, `window_minutes` and `resets_at` in epoch seconds, and `plan_type`.
 *  Every turn writes one, so the tail is enough. Codex keeps one snapshot and overwrites
 *  it with whichever bucket the server named last (`limit_id`: `codex`, or a model's own
 *  such as `codex_other`), so only the account's `codex` bucket is read, never another's
 *  windows under its names. */
export function codexLimits(file: string): DataOf<"limits.observed"> | null {
  const { tail } = ends(file, 0, 256 * 1024);
  for (const r of parseLines(tail).reverse()) {
    const p = r.payload as { type?: unknown; rate_limits?: unknown } | undefined;
    if (r.type !== "event_msg" || p?.type !== "token_count") continue;
    if (!p.rate_limits || typeof p.rate_limits !== "object") continue;
    const rl = p.rate_limits as Record<string, unknown>;
    if (rl.limit_id != null && rl.limit_id !== "codex") continue;
    const windows: DataOf<"limits.observed">["windows"] = [];
    for (const id of ["primary", "secondary"]) {
      const w = rl[id] as { used_percent?: unknown; window_minutes?: unknown; resets_at?: unknown } | null;
      if (typeof w?.used_percent !== "number" || w.used_percent < 0) continue;
      windows.push(
        prune({
          id,
          used_percent: w.used_percent,
          window_minutes:
            Number.isInteger(w.window_minutes) && Number(w.window_minutes) > 0 ? Number(w.window_minutes) : undefined,
          resets_at: epochIso(w.resets_at),
        }),
      );
    }
    if (!windows.length) return null;
    return prune({ windows, plan: typeof rl.plan_type === "string" ? rl.plan_type.slice(0, 64) : undefined });
  }
  return null;
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
      creator_account_id?: unknown;
      creator_user_id?: unknown;
    };
    // Whose thread it is, as Codex itself wrote it down when the thread was made (0.171.0;
    // absent for an API key, another provider, or a thread from before Codex kept it).
    // Never the email: events go to every sink.
    const account = accountOf(p.creator_account_id, p.creator_user_id);
    if (account) out.account_id = account;
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
    const p = j.payload as { type?: string; role?: string; content?: unknown } | undefined;
    if (j.type !== "response_item" || !p || p.type !== "message" || p.role !== "user") continue;
    // A picture's wrapper lines are Codex's, not the ask (codexWords).
    const text = codexWords(p.content);
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
