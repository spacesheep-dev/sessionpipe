// SPDX-License-Identifier: Apache-2.0
// Devin CLI (Cognition) — docs: https://docs.devin.ai/cli/extensibility/hooks/overview
// Config: the `hooks` key of the user config file — `~/.config/devin/config.json`
// (`$XDG_CONFIG_HOME/devin/config.json` when that is set), `%APPDATA%\devin\config.json`
// on Windows. Claude-shaped, matcher a REGEX on the tool name, timeouts in SECONDS.
// That file is the only user-level location Devin reads hooks from; `hooks.v1.json` is
// project-level only.
//
// Devin accepts exactly eight event names and rejects the WHOLE file on one it does not
// know ("unknown variant `Notification`, expected one of …"), which silently disables
// every hook in it. DEVIN_EVENTS is that set, and nothing else may be added to it.
//
// The payload carries no `cwd`, no `transcript_path` and no `model`: the folder comes
// from DEVIN_PROJECT_DIR in the hook's environment, and the transcript, the model, the
// title and the times come from Devin's own session store — one SQLite file under the
// data directory, read only, through readers/sqlite.ts. A session's transcript is
// addressed as "<database>#<session id>", because readTranscript is given a file.
//
// stdout stays empty for every event: Devin reads a decision from stdout, and silence
// plus exit 0 is "carry on" (printing nothing, printing `{}`, exiting 1 and blowing the
// timeout were all measured as non-blocking; only exit 2 or an explicit
// {"decision":"block"} blocks a tool).
import { createHash } from "node:crypto";
import { existsSync, readlinkSync } from "node:fs";
import path from "node:path";
import { homeDir } from "../paths.js";
import { querySqlite } from "../readers/sqlite.js";
import { pairTurns } from "../readers/transcripts.js";
import { installClaudeShaped, installedClaudeShaped, readJson, uninstallClaudeShaped } from "./claude-shaped.js";
import type {
  Adapter,
  BackfillRow,
  HookInput,
  HookResult,
  InstallOptions,
  SessionFacts,
  TranscriptRead,
} from "./types.js";

const NAME = "devin";
/** The eight event names Devin accepts. One it does not know makes it drop the whole
 *  hooks file, so this list is exact, not a superset — see devin.test.ts. */
export const DEVIN_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PermissionRequest",
  "Stop",
  "PostCompaction",
  "SessionEnd",
] as const;
const OPTS = { matcherFor: (e: string) => (/Tool|Permission/.test(e) ? "" : undefined), timeout: 5 };
const eventsFor = (lean?: boolean) => (lean ? DEVIN_EVENTS.filter((e) => e !== "PreToolUse") : [...DEVIN_EVENTS]);
const INSTALL_NOTE =
  "Devin drops a whole hooks file on one event name it doesn't know; `/hooks` in `devin` lists what loaded";
const CLAUDE_NOTE =
  "Devin also reads ~/.claude/settings.json hooks (read_config_from.claude); a Claude-only event name there makes it ignore that file whole";

const deadFileNote = (bad: string) =>
  `Devin loads NO hooks from this file: "${bad}" is not one of its event names and it rejects the file whole — remove that key (\`/hooks\` in \`devin\` lists what loaded)`;

/** The first `hooks` key in the file that Devin does not accept, if there is one.
 *  One such key disables every hook in the file, ours and any other tool's. */
export function foreignEvent(file: string): string | undefined {
  const hooks = readJson(file).hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return undefined;
  const ok = DEVIN_EVENTS as readonly string[];
  return Object.keys(hooks).find((k) => !ok.includes(k));
}

const homeOf = (env: NodeJS.ProcessEnv) => env.HOME || homeDir();
const appData = (env: NodeJS.ProcessEnv) => env.APPDATA || path.join(homeOf(env), "AppData", "Roaming");
/** `~/.config/devin`, `$XDG_CONFIG_HOME/devin`, or `%APPDATA%\devin`. */
export const devinConfigDir = (env: NodeJS.ProcessEnv = process.env): string =>
  process.platform === "win32"
    ? path.join(appData(env), "devin")
    : path.join(env.XDG_CONFIG_HOME || path.join(homeOf(env), ".config"), "devin");
const configFile = (env: NodeJS.ProcessEnv) => path.join(devinConfigDir(env), "config.json");
/** `~/.local/share/devin/cli`, `$XDG_DATA_HOME/devin/cli`, or `%APPDATA%\devin\cli`. */
export const devinDataDir = (env: NodeJS.ProcessEnv = process.env): string =>
  process.platform === "win32"
    ? path.join(appData(env), "devin", "cli")
    : path.join(env.XDG_DATA_HOME || path.join(homeOf(env), ".local", "share"), "devin", "cli");
const sessionsDb = (env: NodeJS.ProcessEnv) => path.join(devinDataDir(env), "sessions.db");

const SESSION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const validTool = (n: unknown): n is string => typeof n === "string" && /^[A-Za-z0-9_.:-]{1,120}$/.test(n);
const endReason = (r: unknown): "clear" | "logout" | "exit" | "other" =>
  r === "clear" || r === "logout" || r === "exit" ? r : "other";
const pickSource = (v: unknown): string =>
  typeof v === "string" && ["startup", "resume", "clear", "compact", "fork"].includes(v) ? v : "unknown";
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

export const devin: Adapter = {
  name: NAME,
  events: DEVIN_EVENTS,
  detect: (env = process.env) => existsSync(devinConfigDir(env)) || existsSync(devinDataDir(env)),
  configFiles: (env = process.env) => [configFile(env)],
  install: (cmd, env = process.env, opts: InstallOptions = {}) => {
    const file = configFile(env);
    const r = installClaudeShaped(file, NAME, eventsFor(opts.lean), cmd, OPTS);
    if (r.skipped) return [r];
    const bad = foreignEvent(file);
    return [{ ...r, note: bad ? deadFileNote(bad) : INSTALL_NOTE }];
  },
  uninstall: (env = process.env, opts: InstallOptions = {}) => [
    uninstallClaudeShaped(configFile(env), DEVIN_EVENTS, { created: opts.created?.includes(configFile(env)) }),
  ],
  installed: (cmd, env = process.env, opts: InstallOptions = {}) => {
    const file = configFile(env);
    const state = installedClaudeShaped(file, NAME, eventsFor(opts.lean), cmd, OPTS);
    // Our entries can be present and current and still report nothing: one event name
    // Devin does not know makes it drop the whole file, ours with it. `status` has to
    // say so, or it tells the person reporting is on while it is dead.
    const bad = state === "missing" ? undefined : foreignEvent(file);
    return [{ file, state: bad ? "inactive" : state, note: bad ? deadFileNote(bad) : CLAUDE_NOTE }];
  },

  fromHook(input: HookInput): HookResult | null {
    const event = input.argv[1] ?? "";
    let s: Record<string, unknown> = {};
    try {
      // A stdin that is JSON but not an object (`null`, a number) is no payload.
      const j: unknown = input.stdin ? JSON.parse(input.stdin) : {};
      if (j && typeof j === "object" && !Array.isArray(j)) s = j as Record<string, unknown>;
    } catch {}
    const id = typeof s.session_id === "string" ? s.session_id : "";
    if (!id) return null;
    // Nothing in the payload names the folder; DEVIN_PROJECT_DIR is the only thing that does.
    const session: HookResult["session"] = { id, cwd: input.env.DEVIN_PROJECT_DIR ?? input.cwd };
    const turn_id = typeof s.prompt_id === "string" ? s.prompt_id : undefined;
    const tool = validTool(s.tool_name) ? s.tool_name : undefined;
    const call_id = typeof s.tool_use_id === "string" ? s.tool_use_id : undefined;
    // Every recorded payload has an object here, but the field is free-form: a Devin
    // version or an MCP-style tool could send a bare string, and then there is no
    // `success` and no `output` to read — the whole value IS the output.
    const response =
      s.tool_response && typeof s.tool_response === "object" && !Array.isArray(s.tool_response)
        ? (s.tool_response as { success?: unknown; output?: unknown; error?: unknown })
        : undefined;
    // The same prompt must always name the same attention (CONTROL.md §6). Devin's
    // PermissionRequest does carry tool_use_id; the hash is the fallback for one that
    // doesn't, and is the bytes ADAPTERS.md's common conventions prescribe.
    const permissionId = () =>
      `perm-${createHash("sha256")
        .update(`${turn_id ?? ""}|${tool ?? ""}|${JSON.stringify(s.tool_input ?? null)}`)
        .digest("hex")
        .slice(0, 16)}`;
    const ev = (type: string, data: Record<string, unknown>) => ({ type, data: prune(data), harnessEvent: event });
    const events: HookResult["events"] = [];
    switch (event) {
      case "SessionStart":
        events.push(ev("session.started", { source: pickSource(s.source) }));
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
        // Devin is the one harness that says so outright: tool_response.success.
        if (tool)
          events.push(
            ev("tool.ended", {
              tool,
              call_id,
              turn_id,
              // `ok` is required on tool.ended (PROTOCOL.md §events), so a response
              // that carries no success flag at all reads as "nothing said it failed".
              ok: response?.success !== false,
              error: errText(response?.error),
              input: s.tool_input,
              output: response ? response.output : s.tool_response,
            }),
          );
        break;
      case "PermissionRequest":
        events.push(ev("attention.needed", { attention_id: call_id ?? permissionId(), kind: "permission", tool }));
        break;
      case "Stop":
        events.push(ev("turn.ended", { turn_id, reason: "stop" }));
        break;
      case "PostCompaction":
        // Devin has no pre-compaction event; the payload carries only the summary.
        events.push(ev("context.compacted", { trigger: "auto" }));
        break;
      case "SessionEnd":
        events.push(ev("session.ended", { reason: endReason(s.reason) }));
        break;
      default:
        return null;
    }
    return {
      session,
      events,
      hints: {},
      transcript: transcriptRef(sessionsDb(input.env as NodeJS.ProcessEnv), id),
    };
  },

  readTranscript(file, fromLine) {
    const ref = splitRef(file);
    if (!ref) return { turns: [], line: fromLine };
    return readDevinChain(ref.db, ref.session, fromLine);
  },

  facts(session, transcript, _hints, _state, env = process.env): SessionFacts {
    const out: SessionFacts = {};
    const version = devinVersion(env);
    if (version) out.harness_version = version;
    const account = devinAccount(env);
    if (account) out.account_id = account;
    const ref = splitRef(transcript) ?? { db: sessionsDb(env), session: session.id };
    if (!SESSION_ID.test(ref.session)) return out;
    const rows = querySqlite(ref.db, SESSION_SQL, [ref.session]);
    const row = rows?.[0];
    if (!row) return out;
    Object.assign(out, sessionFacts(row));
    return out;
  },

  backfill(sinceMs, env = process.env): BackfillRow[] {
    const rows = querySqlite(sessionsDb(env), BACKFILL_SQL, ["text", Math.floor(sinceMs / 1000)]);
    if (!rows) return [];
    const out: BackfillRow[] = [];
    for (const row of rows) {
      const id = String(row.id); // text, the query says
      if (!SESSION_ID.test(id)) continue;
      const { started_at, last_at, ...rest } = sessionFacts(row);
      if (!started_at || !last_at) continue;
      out.push({ session: { id, ...rest }, started_at, last_at });
    }
    return out;
  },
};

function prune<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

// --- the session store ---------------------------------------------------------------

/** `<database>#<session id>`: readTranscript is given a file, and Devin keeps every
 *  session in one database, so the session has to ride in the string. */
export const transcriptRef = (db: string, session: string): string => `${db}#${session}`;
export function splitRef(ref: string | undefined): { db: string; session: string } | null {
  if (!ref) return null;
  const at = ref.lastIndexOf("#");
  if (at <= 0) return null;
  const db = ref.slice(0, at);
  const session = ref.slice(at + 1);
  return db && SESSION_ID.test(session) ? { db, session } : null;
}

/** `message_nodes` is a forest: it keeps abandoned branches too (27 nodes for a
 *  two-turn session). The transcript is the one chain that ends at
 *  `sessions.main_chain_id`, walked up through `parent_node_id` — never every node. */
/** The walk stops at the cursor (`m.node_id >= ?`): everything below it has been read
 *  already, and without that bound every Stop pulled `chat_message` for every ancestor
 *  — the root of a real chain carries a 17 kB system prompt and four more system
 *  blocks, re-read on every event, and past 32 MB the child and CLI engines give up
 *  and return nothing. The cap keeps the NEWEST rows (`DESC`), re-sorted below: an
 *  ascending cap would have kept the oldest and delivered no new turn ever again. */
const CHAIN_LIMIT = 4000;
export const CHAIN_SQL = `WITH RECURSIVE chain(node_id, parent_node_id, chat_message, created_at) AS (
  SELECT node_id, parent_node_id, chat_message, created_at FROM message_nodes
   WHERE session_id = ? AND node_id = (SELECT main_chain_id FROM sessions WHERE id = ?)
  UNION ALL
  SELECT m.node_id, m.parent_node_id, m.chat_message, m.created_at FROM message_nodes m
    JOIN chain c ON m.node_id = c.parent_node_id AND m.session_id = ? AND m.node_id >= ?
)
SELECT node_id, chat_message, created_at FROM chain ORDER BY node_id DESC LIMIT ${CHAIN_LIMIT}`;

/** Times are unix SECONDS in this store. The first ask comes from `prompt_history`,
 *  because `sessions.title` holds whatever the titler last produced — a backticked
 *  command, or a raw `functions.Shell:0{…}` mid-turn. */
const SESSION_FIELDS = `s.model, s.working_directory, s.created_at, s.last_activity_at,
       (SELECT p.content FROM prompt_history p WHERE p.session_id = s.id AND p.is_shell = 0
         ORDER BY p.timestamp ASC, p.id ASC LIMIT 1) AS first_ask`;
const SESSION_SQL = `SELECT ${SESSION_FIELDS} FROM sessions s WHERE s.id = ? LIMIT 1`;
// typeof(id) = 'text' (the literal rides as a parameter: the CLI engine takes no quote
// in the SQL): an id a session ref could carry. A blob id comes back from the sqlite3
// CLI as a string shaped by its version, so the database says what it is.
const BACKFILL_SQL = `SELECT s.id, ${SESSION_FIELDS} FROM sessions s
 WHERE s.hidden = 0 AND typeof(s.id) = ? AND s.last_activity_at >= ?
 ORDER BY s.last_activity_at DESC LIMIT 500`;

function sessionFacts(row: Record<string, unknown>): SessionFacts {
  const out: SessionFacts = {};
  if (typeof row.model === "string" && row.model) out.model = row.model;
  if (typeof row.working_directory === "string" && path.isAbsolute(row.working_directory))
    out.cwd = row.working_directory;
  const started = Number(row.created_at);
  const last = Number(row.last_activity_at);
  if (Number.isFinite(started) && started > 0) out.started_at = Math.round(started * 1000);
  if (Number.isFinite(last) && last > 0) out.last_at = Math.round(last * 1000);
  if (typeof row.first_ask === "string") {
    const line = row.first_ask.split("\n").find((l) => l.trim()) ?? "";
    if (line.trim()) {
      out.title = cut(line.trim(), 80);
      out.title_source = "first-ask";
    }
  }
  return out;
}

interface ChatMessage {
  role?: unknown;
  content?: unknown;
  metadata?: { is_user_input?: unknown; created_at?: unknown } | null;
}

/** The canonical chain as turns. `node_id` is the cursor: it rises along the chain and
 *  is stable across a resume, so a later read starts where the last one stopped.
 *  `role: "system"` is Cognition's own prompt (and the skills manifest, and the
 *  generated system_info block), never the person's words — it is skipped at every
 *  tier, as is `role: "tool"`. */
export function readDevinChain(db: string, session: string, fromLine: number): TranscriptRead {
  if (!SESSION_ID.test(session)) return { turns: [], line: fromLine };
  const floor = Number.isFinite(fromLine) && fromLine > 0 ? Math.floor(fromLine) : 0;
  const rows = querySqlite(db, CHAIN_SQL, [session, session, session, floor]);
  if (!rows?.length) return { turns: [], line: fromLine };
  const msgs: { role: "user" | "assistant"; text: string; at: number; line: number }[] = [];
  let end = fromLine;
  for (const row of rows) {
    const node = Number(row.node_id);
    if (!Number.isFinite(node)) continue;
    if (node + 1 > end) end = node + 1;
    if (node < fromLine) continue;
    let j: ChatMessage;
    try {
      j = JSON.parse(String(row.chat_message ?? "")) as ChatMessage;
    } catch {
      continue;
    }
    const text = typeof j.content === "string" ? j.content.trim() : "";
    if (!text) continue;
    // The message's own time, not the row's. `message_nodes.created_at` is when the row
    // batch was last WRITTEN: Devin rewrites it on every save of the chain, so every
    // node of a chain usually carries one identical value, and it is not even monotonic
    // along the chain. Measured on a live store 2026-10-08: a two-turn session had all
    // four of its chain nodes at 23:33:10 while their own `metadata.created_at` read
    // 23:32:29, :34, 23:33:08 and :10 (turn 1 reported 41 s late, both turns at the same
    // instant); one node's row time was rewritten 12 s later between two reads; and a
    // descendant's row time was 27 s EARLIER than its ancestor's. The column is only the
    // fallback for a row whose message has no time of its own.
    const secs = Number(row.created_at);
    const at =
      Date.parse(String(j.metadata?.created_at ?? "")) ||
      (Number.isFinite(secs) && secs > 0 ? Math.round(secs * 1000) : 0) ||
      Date.now();
    if (j.role === "user" && j.metadata?.is_user_input === true) msgs.push({ role: "user", text, at, line: node });
    else if (j.role === "assistant") msgs.push({ role: "assistant", text, at, line: node });
  }
  // The rows come newest first (the cap keeps the newest); a transcript runs the other way.
  msgs.sort((a, b) => a.line - b.line);
  return pairTurns(msgs, end);
}

/** `<data dir>/_versions/current` is a symlink to the running version's folder. */
export function devinVersion(env: NodeJS.ProcessEnv = process.env): string | undefined {
  try {
    const target = readlinkSync(path.join(devinDataDir(env), "_versions", "current"));
    const name = path.basename(target);
    return /^[0-9][0-9A-Za-z.+-]{0,63}$/.test(name) ? name : undefined;
  } catch {
    return undefined;
  }
}

/** The organisation the CLI is signed in to, from the user config — the only account id
 *  Devin keeps in a plain local file. Never the email, and never credentials.toml. */
export function devinAccount(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const d = readJson(configFile(env)).devin as { org_id?: unknown } | undefined;
  const id = d && typeof d === "object" ? d.org_id : undefined;
  return typeof id === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(id) ? id : undefined;
}
