// SPDX-License-Identifier: Apache-2.0
// GENERATED from proto/sessionpipe/v1/*.proto by tools/doors; do not edit. `npm run schemas` rewrites it.
// The wire's shapes as TypeScript: snake_case keys, numbers for every integer, enums as their words.

/**
 * The harnesses in the registry (spec/ADAPTERS.md). A name outside it is allowed on the wire
 * (`Harness.name` is a pattern), so a harness can report before it is listed here.
 */
export type HarnessName = "claude-code" | "codex" | "gemini-cli" | "antigravity" | "devin" | "cursor" | "copilot-cli" | "droid" | "kiro" | "opencode";

/** Where a session's title came from. */
export type TitleSource = "custom" | "harness" | "first-ask";

/** How a session began. */
export type SessionSource = "startup" | "resume" | "clear" | "compact" | "fork" | "unknown";

/** Why a session ended. */
export type SessionEndReason = "clear" | "logout" | "exit" | "other";

/** Why a turn ended. */
export type TurnEndReason = "stop" | "interrupt" | "error";

/** What a session waits on when it needs the person. */
export type AttentionKind = "permission" | "question" | "elicitation" | "idle" | "error";

/** How an attention was cleared. */
export type AttentionClearance = "answered" | "cancelled" | "timeout" | "unknown";

/** What started a compaction. */
export type CompactionTrigger = "manual" | "auto";

/** How a delegation reached the other agent. */
export type DelegationVia = "ask" | "handoff";

/** Whether a handoff's answer reached `reply_to`. */
export type RelayOutcome = "delivered" | "unsupported" | "failed";

/** The harness that produced an event. */
export interface Harness {
  /** From the registry in ADAPTERS.md; a name outside it is allowed ([a-z0-9-]). */
  name: string;
  /** The harness's version. */
  version?: string | undefined;
  /** The harness's own event name (`PostToolUse`, `agentStop`). */
  event?: string | undefined;
}

/** The session an event belongs to, with the facts every event repeats. */
export interface Session {
  /** The harness's own session id. */
  id: string;
  /** Monotonic per session per sender; the dedup key with harness.name and id. */
  seq: number;
  /** The computer, as the person named it or as its hostname. */
  machine?: string | undefined;
  /** The working directory. Home is written `~`. */
  cwd?: string | undefined;
  /** A remote URL with credentials stripped. */
  repo?: string | undefined;
  /** The git branch. */
  branch?: string | undefined;
  /** The model id, as the harness names it. */
  model?: string | undefined;
  /** The session's title. */
  title?: string | undefined;
  /** Where the title came from. */
  title_source?: TitleSource | undefined;
  /** A link that opens the session. */
  url?: string | undefined;
  /** An id, never an email. */
  account_id?: string | undefined;
  /** Whether a person attends the session, in the harness's own word. Absent = unknown, never false. */
  attended?: boolean | undefined;
  /** The session this one is a subagent of, within the same harness. */
  parent_id?: string | null | undefined;
  /**
   * `<harness>:<id>` of the session that started this one on purpose (a script running
   * `claude -p` for it), from the launcher's environment. Absent for a subagent, whose
   * launcher is its parent, and when nothing says.
   */
  launched_by?: string | undefined;
  /**
   * `<harness>:<id>` of the session this one answers: the machine's daemon started or
   * resumed it for that session's ask, or for a handoff (CONTROL.md §6, §13), and the
   * child's environment says so. On every event of the child. Lineage across
   * harnesses, as `parent_id` is within one; never authority, never a subagent.
   */
  delegated_by?: string | undefined;
}

/** What ran on the event before it left the machine. */
export interface Privacy {
  /** The redaction rulesets that ran; `secrets@1` always above tier 0. */
  rulesets: string[];
  /** Whether the PII ruleset ran. */
  pii: boolean;
}

/** One event, as it travels to a receiver. */
export interface Event {
  /** The protocol integer: 1. */
  protocol: 1;
  /** A ULID: unique, time-ordered. */
  id: string;
  /** Dotted, lowercase (`tool.ended`), or `native`. Unknown types MUST be accepted and stored. */
  type: string;
  /** When it happened, RFC 3339 UTC with milliseconds. */
  time: string;
  /** The privacy tier the event was filtered to (spec/PRIVACY.md). */
  tier: number;
  /** The harness. */
  harness: Harness;
  /** The session. */
  session: Session;
  /** What ran on it. */
  privacy: Privacy;
  /** Per type (see EventData); extra keys allowed and kept. */
  data: Record<string, unknown>;
}

/** `session.started`: a session began. */
export interface SessionStarted {
  /** How it began. */
  source: SessionSource;
  /** Extra keys a sender added are kept. */
  [key: string]: unknown;
}

/** `session.heartbeat`: the session is still there. */
export interface SessionHeartbeat {
  /** Extra keys a sender added are kept. */
  [key: string]: unknown;
}

/** `session.ended`: the session is over. */
export interface SessionEnded {
  /** Why. */
  reason: SessionEndReason;
  /** Extra keys a sender added are kept. */
  [key: string]: unknown;
}

/** `session.backfill`: a session from before the hooks were installed, read from the harness's files. */
export interface SessionBackfill {
  /** When it began. */
  started_at: string;
  /** Its last activity. */
  last_at: string;
  /** How many turns it had. */
  turns?: number | undefined;
  /** Extra keys a sender added are kept. */
  [key: string]: unknown;
}

/** `session.forgotten`: the person asked every receiver to forget the session. */
export interface SessionForgotten {
  /** Extra keys a sender added are kept. */
  [key: string]: unknown;
}

/** `turn.started`: a prompt was submitted. */
export interface TurnStarted {
  /** The harness's id for the turn. */
  turn_id?: string | undefined;
  /** How long the prompt was. */
  prompt_chars?: number | undefined;
  /**
   * The harness's OWN word for who submitted the prompt, forwarded verbatim; not an enum
   * of this spec (Claude Code: user, sdk, system, loop_wakeup, schedule_wakeup,
   * poll_event), and a different vocabulary from session.started.source. A bare word:
   * tier 0 is not redacted, so the shape is the only guard.
   */
  submitted_by?: string | undefined;
  /**
   * True when the prompt text is a block the harness wrote rather than words a person
   * typed; never a claim that no person caused the turn. `injected` on
   * turn.transcript says the same of a turn's ask, for the other way an ask arrives
   * from somewhere other than this session's own keyboard (CONTROL.md §6.3).
   */
  injected?: boolean | undefined;
  /** Extra keys a sender added are kept. */
  [key: string]: unknown;
}

/** `turn.ended`: the model stopped, was interrupted, or failed. */
export interface TurnEnded {
  /** The harness's id for the turn. */
  turn_id?: string | undefined;
  /** Why it ended. */
  reason: TurnEndReason;
  /** The harness's error class when reason is error (rate_limit, overloaded, authentication_failed, server_error …). */
  error?: string | undefined;
  /** How long the turn took. */
  ms?: number | undefined;
  /** Background work the harness reports still in flight as the turn ends, each of which wakes the session when it finishes (Claude Code: shell commands, monitors, subagents, workflows). Absent when the harness doesn't say. */
  background?: number | undefined;
  /** Extra keys a sender added are kept. */
  [key: string]: unknown;
}

/** `turn.transcript`: what the person asked and what the assistant answered (tier 2). */
export interface TurnTranscript {
  /** The turn's number within the session. */
  turn: number;
  /** The person's words, redacted. */
  user: string;
  /** The assistant's words, redacted. */
  assistant: string;
  /** When the turn ended. */
  at: string;
  /**
   * The ask reached the session from somewhere other than its own keyboard: another
   * local session handed it over or a channel pushed it, the two ways a control
   * daemon reaches a session in place (CONTROL.md §6.3, §8). The words are the
   * person's; the arrival was not. Absent means a turn asked for where the session
   * runs. Like turn.started's `injected`, and never a claim that no person is behind
   * the ask.
   */
  injected?: true | undefined;
  /** Extra keys a sender added are kept. */
  [key: string]: unknown;
}

/**
 * `turn.progress`: the turn still running: its prompt and what the assistant has said so far. A
 * later turn.progress for the same turn replaces it; the turn.transcript with the
 * same number supersedes it. Over 20 000 chars, the assistant side keeps its END.
 */
export interface TurnProgress {
  /** The turn's number within the session. */
  turn: number;
  /** The person's words, redacted. */
  user: string;
  /** The assistant's words so far, redacted. */
  assistant: string;
  /** When this snapshot was taken. */
  at: string;
  /**
   * As on turn.transcript: the ask reached the session from somewhere other than its
   * own keyboard. A running turn says it too, or a board would show the person's
   * relayed words as typed there until the turn ends.
   */
  injected?: true | undefined;
  /** Extra keys a sender added are kept. */
  [key: string]: unknown;
}

/** `tool.started`: a tool call began (tier 1; its input at tier 3). */
export interface ToolStarted {
  /** The tool's name. */
  tool: string;
  /** The harness's id for the call. */
  call_id?: string | undefined;
  /** The harness's id for the turn. */
  turn_id?: string | undefined;
  /** Set when a subagent made the call. */
  agent_id?: string | undefined;
  /** The tool's input (tier 3). */
  input?: unknown | undefined;
  /** Extra keys a sender added are kept. */
  [key: string]: unknown;
}

/** `tool.ended`: a tool call finished (tier 1; its input and output at tier 3). */
export interface ToolEnded {
  /** The tool's name. */
  tool: string;
  /** The harness's id for the call. */
  call_id?: string | undefined;
  /** The harness's id for the turn. */
  turn_id?: string | undefined;
  /** Set when a subagent made the call. */
  agent_id?: string | undefined;
  /** How long it took. */
  ms?: number | undefined;
  /** Whether it succeeded. */
  ok: boolean;
  /** The error, when it didn't. */
  error?: string | undefined;
  /** The tool's input (tier 3). */
  input?: unknown | undefined;
  /** The tool's output (tier 3). */
  output?: unknown | undefined;
  /** Extra keys a sender added are kept. */
  [key: string]: unknown;
}

/** `files.changed`: files a turn wrote. */
export interface FilesChanged {
  /** The paths, home written `~`. */
  paths: string[];
  /** Extra keys a sender added are kept. */
  [key: string]: unknown;
}

/** `attention.needed`: the session waits on the person. */
export interface AttentionNeeded {
  /** The id a `permission.answer` names. */
  attention_id: string;
  /** What it waits on. */
  kind: AttentionKind;
  /** The tool asking, for a permission. */
  tool?: string | undefined;
  /** What it asks, in at most 200 characters (tier 1). */
  message?: string | undefined;
  /** Set when a subagent asked. */
  agent_id?: string | undefined;
  /** Extra keys a sender added are kept. */
  [key: string]: unknown;
}

/** `attention.cleared`: the session no longer waits. */
export interface AttentionCleared {
  /** The attention that was cleared. */
  attention_id: string;
  /** How. */
  how: AttentionClearance;
  /** Extra keys a sender added are kept. */
  [key: string]: unknown;
}

/** `subagent.started`: the session started a subagent. */
export interface SubagentStarted {
  /** The subagent's id. */
  agent_id: string;
  /** Its kind, as the harness names it. */
  agent_type?: string | undefined;
  /** Extra keys a sender added are kept. */
  [key: string]: unknown;
}

/** `subagent.ended`: a subagent finished. */
export interface SubagentEnded {
  /** The subagent's id. */
  agent_id: string;
  /** Its kind, as the harness names it. */
  agent_type?: string | undefined;
  /** Background work still in flight once this subagent is out of it, counted as `turn.ended.background` is. Absent when the harness doesn't say. */
  background?: number | undefined;
  /** Extra keys a sender added are kept. */
  [key: string]: unknown;
}

/** `context.compacted`: the harness compacted the context. */
export interface ContextCompacted {
  /** What started it. */
  trigger: CompactionTrigger;
  /** Extra keys a sender added are kept. */
  [key: string]: unknown;
}

/**
 * One usage window of an account: `id` is the harness's own name for it (`five_hour`,
 * `seven_day`, `primary` …); `used_percent` passes 100 once a spend limit is exceeded.
 */
export interface LimitWindow {
  /** The harness's name for the window. */
  id: string;
  /** How much of it is used. */
  used_percent: number;
  /** When it resets. */
  resets_at?: string | undefined;
  /** How long the window is. */
  window_minutes?: number | undefined;
  /** Extra keys a sender added are kept. */
  [key: string]: unknown;
}

/** `limits.observed`: the account's usage limits as the harness last reported them: one per window. */
export interface LimitsObserved {
  /** The windows. */
  windows: LimitWindow[];
  /** The account's plan, as the harness names it. */
  plan?: string | undefined;
  /**
   * The account the numbers belong to, as `session.account_id` spells it, when the
   * session was served by another account than its own (the pool, CONTROL.md §2).
   */
  account_id?: string | undefined;
  /** Extra keys a sender added are kept. */
  [key: string]: unknown;
}

/**
 * `delegation.started`: the daemon on this machine took an ask from this session (CONTROL.md §13), or a
 * command with `reply_to` naming it (§6). On the asking session, with its own seq.
 */
export interface DelegationStarted {
  /** The ask's id. */
  ask_id: string;
  /** How it was asked. */
  via: DelegationVia;
  /** The agent asked. */
  harness: string;
  /**
   * The session that answers, once known: at once for a handoff or an ask to an
   * existing session; for a new session, when the harness reveals its id.
   */
  to?: string | undefined;
  /** Tier 1: what was asked, cut to 200 characters, redacted. */
  text?: string | undefined;
  /** Extra keys a sender added are kept. */
  [key: string]: unknown;
}

/** `delegation.ended`: the asked agent's turn ended, or the ask failed before one. */
export interface DelegationEnded {
  /** The ask's id. */
  ask_id: string;
  /** The session that answered. */
  to?: string | undefined;
  /** Whether it answered. */
  ok: boolean;
  /** How long it took. */
  ms: number;
  /** When not ok: why, in at most 200 characters. */
  error?: string | undefined;
  /** A handoff only: whether the answer reached `reply_to`. */
  relayed?: RelayOutcome | undefined;
  /** Tier 2: the answer, redacted. */
  reply?: string | undefined;
  /** Extra keys a sender added are kept. */
  [key: string]: unknown;
}

/** `native`: a harness's raw hook line, tier 3 only. */
export interface Native {
  /** Extra keys a sender added are kept. */
  [key: string]: unknown;
}

/** The known event types and the shape of each one's `data`. A field's JSON name is the type. */
export interface EventData {
  /** `session.started`. */
  "session.started": SessionStarted;
  /** `session.heartbeat`. */
  "session.heartbeat": SessionHeartbeat;
  /** `session.ended`. */
  "session.ended": SessionEnded;
  /** `session.backfill`. */
  "session.backfill": SessionBackfill;
  /** `session.forgotten`. */
  "session.forgotten": SessionForgotten;
  /** `turn.started`. */
  "turn.started": TurnStarted;
  /** `turn.ended`. */
  "turn.ended": TurnEnded;
  /** `turn.transcript`. */
  "turn.transcript": TurnTranscript;
  /** `turn.progress`. */
  "turn.progress": TurnProgress;
  /** `tool.started`. */
  "tool.started": ToolStarted;
  /** `tool.ended`. */
  "tool.ended": ToolEnded;
  /** `files.changed`. */
  "files.changed": FilesChanged;
  /** `attention.needed`. */
  "attention.needed": AttentionNeeded;
  /** `attention.cleared`. */
  "attention.cleared": AttentionCleared;
  /** `subagent.started`. */
  "subagent.started": SubagentStarted;
  /** `subagent.ended`. */
  "subagent.ended": SubagentEnded;
  /** `context.compacted`. */
  "context.compacted": ContextCompacted;
  /** `limits.observed`. */
  "limits.observed": LimitsObserved;
  /** `delegation.started`. */
  "delegation.started": DelegationStarted;
  /** `delegation.ended`. */
  "delegation.ended": DelegationEnded;
  /** `native`. */
  native: Native;
}

/**
 * The capabilities this spec names. A receiver may announce others (`WellKnown.capabilities` is a
 * pattern), which a sender it predates ignores.
 */
export type Capability = "events" | "backfill" | "forget" | "control" | "native";

/** How a sender signs in to a receiver. */
export type Auth = "bearer";

/** Which tool events a receiver would rather be sent (PROTOCOL.md §4, *Thinned tool events*). */
export type ToolEvents = "all" | "main" | "beat";

/** The kinds of key a machine or a receiver handles (CONTROL.md §2). Absent: passkeys only. */
export type KeyType = "passkey" | "device";

/** `POST {events}`: 1 to `batch.max_events` events, at most `batch.max_bytes` bytes. */
export interface Batch {
  /** The events, in order. */
  events: Event[];
}

/** One event the receiver will never store. */
export interface Rejected {
  /** The event's id. */
  id: string;
  /** Why, in the receiver's words. */
  reason: string;
}

/** The 202 answer to a batch. `accepted + duplicates + rejected.length` equals the number sent. */
export interface BatchResponse {
  /** Stored. */
  accepted: number;
  /** Already had. */
  duplicates: number;
  /** Never to be stored, each with its reason. */
  rejected: Rejected[];
  /** The well-known value again, so a sender learns a lowered cap without a discovery round trip. */
  max_tier: number;
}

/** A 4xx body: why the receiver refused. */
export interface ErrorResponse {
  /** A word a sender branches on (`unsupported_protocol`, `tier_above_max`). */
  reason: string;
  /** `unsupported_protocol`: the protocol integers the receiver accepts. */
  supported?: number[] | undefined;
  /** `tier_above_max`: the receiver's maximum. */
  max_tier?: number | undefined;
}

/** Where the receiver's endpoints are: paths relative to the origin, or absolute URLs. */
export interface Endpoints {
  /** The events endpoint. */
  events: string;
  /** The control endpoint, when `capabilities` lists `control`. */
  control?: string | undefined;
  /** The native lane, when `capabilities` lists `native`. */
  native?: string | undefined;
}

/** The largest request the receiver takes. */
export interface BatchLimits {
  /** Events per batch; 50 when absent. */
  max_events: number;
  /** Bytes per batch; 262 144 when absent. */
  max_bytes: number;
}

/** How commands are signed: the WebAuthn rp id keys are enrolled for, and the algorithms. */
export interface Signing {
  /** The rp id. */
  rp_id: string;
  /** The COSE algorithms accepted: -7 (ES256), -257 (RS256). */
  algs: (-7 | -257)[];
  /** The kinds of key the receiver stores and carries whole (CONTROL.md §2). Absent means `["passkey"]`. */
  key_types?: KeyType[] | undefined;
}

/** The receiver's control channel, required when `capabilities` lists `control`. */
export interface ControlInfo {
  /** The longest long-poll it will hold. */
  wait_max_s: number;
  /** Pairing may start with no token: the person approves the link signed in. */
  open_pairing?: boolean | undefined;
  /**
   * MCP servers (`mcp__<server>`) a session answering this receiver's message may
   * use without asking. MCP servers only: a daemon ignores anything else.
   */
  session_tools?: string[] | undefined;
  /** How commands are signed. */
  signing: Signing;
  /** Informational: the receiver accepts `files` on a start and serves `GET {control}/files/{sha256}`. */
  files?: boolean | undefined;
  /**
   * The receiver shows a machine in `inherit` mode as that, never as safe or auto.
   * A daemon pairs in, or switches to, `inherit` only with receivers that say so.
   */
  inherit?: boolean | undefined;
}

/** `GET /.well-known/sessionpipe`: what the receiver takes. */
export interface WellKnown {
  /** The protocol integers the receiver accepts. */
  protocol: number[];
  /** The highest tier it will store. A sender caps its sink's tier at this value. */
  max_tier: number;
  /** `events` is required; the rest are Capability's words, or a receiver's own. */
  capabilities: string[];
  /** The schemes it takes; `["bearer"]` when absent. */
  auth: Auth[];
  /** Where its endpoints are. */
  endpoints: Endpoints;
  /** The largest request it takes. */
  batch: BatchLimits;
  /**
   * The tool events the receiver would rather be sent (PROTOCOL.md §4, *Thinned tool
   * events*): `all`, every one (what an absent field means); `main`, a subagent's thinned
   * to at most one `tool.ended` per session per minute; `beat`, every session's thinned
   * so. A sender honours it unless the sink's owner chose otherwise; a sender that
   * predates the field sends every tool event.
   */
  tools?: ToolEvents | undefined;
  /** Its control channel. */
  control?: ControlInfo | undefined;
}

/** What a command asks the machine to do. */
export type ControlKind = "prompt" | "permission.answer" | "cancel" | "start" | "key.add" | "pool";

/** What a `pool` command asks of the machine's account pool (CONTROL.md §6 `pool`). */
export type PoolAction = "on" | "off" | "enable" | "disable" | "remove" | "order" | "refresh" | "login.begin" | "login.complete";

/** How a delivered message reached the session. */
export type DeliveryMode = "sdk" | "waiter" | "turn" | "inbox" | "api" | "resume" | "fork";

/**
 * How much a started session may do without anyone approving it (CONTROL.md §3.1),
 * narrowest first. Closed: nothing is wider than `auto`.
 */
export type StartPermission = "read" | "safe" | "edits" | "auto";

/**
 * What a start ran with, or gets by default: a level, or `inherit` (no permission flag,
 * the harness's own default) on a machine the person put in inherit mode. Never a
 * command's `permission`.
 */
export type RunLevel = "read" | "safe" | "edits" | "auto" | "inherit";

/** The machine's mode: what a messaged session may do. */
export type MachineMode = "safe" | "auto" | "inherit";

/** A permission's answer. */
export type Decision = "allow" | "deny";

/** Where a pairing stands. */
export type PairStatus = "pending" | "paired" | "expired";

/**
 * What became of a message. `progress` (not final): the answer so far, whole, in `reply`, with a
 * rising `seq`. `taken` (not final): verified and being delivered. Every other outcome is final.
 */
export type ControlOutcome = "progress" | "taken" | "delivered" | "expired" | "unsupported" | "failed" | "refused";

/** Where a pooled account stands. */
export type PoolAccountStatus = "ready" | "limited" | "error" | "disabled";

/**
 * A file attached to a `start` (CONTROL.md §3.1). The bytes wait on the receiver
 * (`GET {control}/files/{sha256}`); the signed hash is what the machine checks.
 * Beyond this shape the verifier also checks: the name's length after NFC, names
 * unique case-insensitively, and the sizes adding up to at most 50 MiB.
 */
export interface ControlFile {
  /**
   * Written as is (NFC) into the session's folder: no slash, backslash or control
   * character, not starting with a dot.
   */
  name: string;
  /** Media type, `type/subtype` (case-insensitive). */
  type: string;
  /** Bytes: 1 to 25 MiB. */
  size: number;
  /** SHA-256 of the bytes, base64url without padding. */
  sha256: string;
}

/** A passkey enrolled on a machine: credential id, COSE alg, SPKI. */
export interface PasskeyKey {
  /** The credential id, base64url. */
  id: string;
  /** The COSE algorithm: -7 (ES256) or -257 (RS256). */
  alg: -7 | -257;
  /** The public key, SPKI base64url. */
  spki: string;
}

/**
 * A device key an app holds in hardware (CONTROL.md §2 "Device keys"), which names
 * itself by its SPKI's SHA-256 and says how it is held.
 */
export interface DeviceKey {
  /** SHA-256 of the SPKI bytes, base64url without padding. */
  id: string;
  /** Always -7 (ES256). */
  alg: -7;
  /** The public key, SPKI base64url. */
  spki: string;
  /** Always `device`. */
  type: "device";
  /** The private key was made in a hardware key store and never leaves it. */
  store: "hardware";
  /** The store will not sign without verifying the person, every time. */
  uv: "each-use";
}

/**
 * A key enrolled on a machine, closed: a passkey, or a device key. A machine refuses any other
 * field or value, so a kind added later is refused by every machine that predates it.
 */
export type ControlKey = PasskeyKey | DeviceKey;

/**
 * The signed command, as the device writes it. The machine verifies the EXACT string
 * it received (control.json `cmd`) and never re-serializes it.
 */
export interface ControlCommand {
  /** Always 1. */
  v: 1;
  /** Always `sessionpipe.control`. */
  t: "sessionpipe.control";
  /** The machine's id: `m_` and 16 to 40 base64url characters. */
  machine: string;
  /** What it asks. */
  kind: ControlKind;
  /** `<harness>:<id>`; the id follows its adapter's rule (Claude Code: a UUID). */
  session: string;
  /** prompt, start: the message for the model. */
  text?: string | undefined;
  /** permission.answer: the attention_id being answered. */
  for?: string | undefined;
  /** permission.answer: the answer. */
  decision?: Decision | undefined;
  /** Shown to the model beside a decision. */
  note?: string | undefined;
  /**
   * start: the folder the new session runs in: absolute, or `~` / `~/…` under the
   * home of the user the machine's daemon runs as, as events write it.
   */
  cwd?: string | undefined;
  /**
   * key.add (session `sessionpipe:keys`): the new device's key (a passkey or a device
   * key, control-key.json), which the machine trusts once a key it already trusts
   * signed this command.
   */
  key?: ControlKey | undefined;
  /** key.add: what the person calls the device. */
  name?: string | undefined;
  /**
   * start, prompt: 1–10 files, together at most 50 MiB, downloaded and checked by hash
   * before the session starts or the message is delivered. On a prompt, only to a
   * machine whose hello says `prompt_files`.
   */
  files?: ControlFile[] | undefined;
  /**
   * start only: the level the new session runs at, at most the machine's mode. Send
   * it only to a machine whose hello advertises it for the harness (`start`).
   */
  permission?: StartPermission | undefined;
  /**
   * start only: the model the harness runs, passed as one argument: never a leading dash. As
   * `permission`: only when advertised.
   */
  model?: string | undefined;
  /**
   * pool (session `sessionpipe:pool`): what to do with the machine's account pool.
   * Each action takes exactly the fields CONTROL.md §6 `pool` lists for it.
   */
  pool_action?: PoolAction | undefined;
  /** enable, disable, remove, login.complete (the pending sign-in's id); refresh MAY. */
  pool_account?: string | undefined;
  /** order: every account of the pool, once each, in the order wanted. */
  pool_order?: string[] | undefined;
  /** login.complete: what the person pasted back from the sign-in page (`code#state`), one line. */
  pool_code?: string | undefined;
  /**
   * start, prompt: a session on the same machine that gets the answer as a message
   * once the command's turn ends (CONTROL.md §6, a handoff). Never the command's own
   * session. Send it only to a machine whose hello says `handoff`.
   */
  reply_to?: string | undefined;
  /** At least 16 random bytes, base64url. */
  nonce: string;
  /** Epoch ms, the signing device's clock. */
  iat: number;
}

/** A day grant's signed string: a passkey vouches for a device key for ≤ 24 h. */
export interface ControlGrant {
  /** Always 1. */
  v: 1;
  /** Always `sessionpipe.grant`. */
  t: "sessionpipe.grant";
  /** The day key: P-256 SPKI, base64url. */
  pub: string;
  /** Epoch ms when it was signed. */
  iat: number;
  /** Epoch ms when it expires. */
  exp: number;
  /** The receiver's WebAuthn rp id (well-known control.signing.rp_id). */
  rp: string;
}

/** A WebAuthn assertion: credential id, authenticatorData, clientDataJSON, signature. */
export interface ControlAssertion {
  /** The credential id, base64url. */
  cred: string;
  /** authenticatorData, base64url. */
  ad: string;
  /** clientDataJSON, base64url. */
  cd: string;
  /** The signature, base64url. */
  sig: string;
}

/**
 * A device key's signature (CONTROL.md §3.2): its id and 64 bytes r‖s over
 * `sessionpipe.device.v1⏎<purpose>⏎<rp id>⏎<challenge>`. Nothing else. The shape
 * only, like an assertion's: the machine reads the key from its own record and checks
 * the rest (a 43-character id, exactly 64 bytes), so a carrier never decides a kind.
 */
export interface ControlDeviceSignature {
  /** The key's id. */
  cred: string;
  /** 64 bytes r‖s, base64url without padding. */
  sig: string;
}

/** A passkey's assertion over sha256(str), with the grant's string. */
export interface GrantAssertion {
  /** The credential id, base64url. */
  cred: string;
  /** authenticatorData, base64url. */
  ad: string;
  /** clientDataJSON, base64url. */
  cd: string;
  /** The signature, base64url. */
  sig: string;
  /** The grant's string (ControlGrant as signed). */
  str: string;
}

/** A device key's signature over the grant's string, with the string. */
export interface GrantDeviceSignature {
  /** The key's id. */
  cred: string;
  /** 64 bytes r‖s, base64url without padding. */
  sig: string;
  /** The grant's string (ControlGrant as signed). */
  str: string;
}

/**
 * The grant vouching for a day key: its string plus the passkey's assertion over
 * sha256(str), or a device key's signature over it (CONTROL.md §3.2).
 */
export type Grant = GrantAssertion | GrantDeviceSignature;

/** One signature: a passkey assertion, or a device key's signature. */
export type Proof = ControlAssertion | ControlDeviceSignature;

/** One message as a receiver carries it: its own envelope around the signed bytes. */
export interface ControlMessage {
  /** The receiver's id for this message; the ack key. Not signed: the nonce inside cmd is. */
  id: string;
  /** The command string, exactly as signed (≤ 48 000 characters). */
  cmd: string;
  /** The day key's ECDSA P-256 / SHA-256 signature over cmd: raw r‖s, base64url. */
  csig?: string | null | undefined;
  /** The grant vouching for the day key. */
  grant?: Grant | null | undefined;
  /** Instead of csig + grant: one passkey assertion (or device signature) over sha256(cmd). */
  confirm?: Proof | null | undefined;
  /** The receiver's clock. */
  at: string;
  /** After this the machine MUST NOT act and acks `expired`; at most 24 h after `at`. */
  expires_at: string;
}

/** `GET {control}`: the messages waiting for the machine. */
export interface ControlPoll {
  /** The messages, oldest first. */
  messages: ControlMessage[];
}

/**
 * taken, delivered of a start: the options it ran with (`model` only when one was
 * asked for). A receiver shows this, never what was asked.
 */
export interface Applied {
  /** The level it ran at. */
  permission?: RunLevel | undefined;
  /** The model it ran. */
  model?: string | undefined;
}

/** What became of one message. */
export interface Ack {
  /** The message's id. */
  id: string;
  /** The outcome. */
  outcome: ControlOutcome;
  /** The machine's clock. */
  at: string;
  /** delivered: how it reached the session. */
  mode?: DeliveryMode | undefined;
  /** The session that took it, when not the one named (a fork's copy, a started session). */
  session?: string | undefined;
  /**
   * The answer came from a COPY of the session the command named, which this
   * names: the person is owed the fact that their words went somewhere else.
   */
  copy_of?: string | undefined;
  /**
   * refused: the verifier's code, or the machine's own (`folder`, `no_attention`, `busy`,
   * `ambiguous_home` when one session id is filed in several of the harness's accounts);
   * failed: `file` when a start's attachment couldn't be fetched, checked or written,
   * `model` when the harness wouldn't run the start's model, `held` when a message was
   * written into a live session's own inbox and that session didn't take it (§6.3).
   */
  code?: string | undefined;
  /** A sentence for the person. */
  detail?: string | undefined;
  /** resume / fork / start: the agent's reply, redacted by the secrets ruleset. */
  reply?: string | undefined;
  /** progress only: rises with every progress ack for this id; a receiver keeps the highest. */
  seq?: number | undefined;
  /** What a start ran with. */
  applied?: Applied | undefined;
}

/** `POST {control}/ack`: what became of the messages. */
export interface ControlAck {
  /** One per message. */
  acks: Ack[];
}

/**
 * A harness account signed in on the machine: the id `session.account_id` carries,
 * and the email it signs in with, so a receiver the person paired with can name the
 * account rather than show an id. Only pair and hello carry it, never an event.
 */
export interface HarnessAccount {
  /** The harness. */
  harness: string;
  /** The account's id. */
  id: string;
  /** The email it signs in with. */
  email?: string | undefined;
  /**
   * What to call an account that has no email: a Claude Code home that runs on
   * another API is named by its endpoint's host (`api.z.ai`).
   */
  name?: string | undefined;
  /**
   * Whether the harness's command line is signed in to this account as the daemon
   * sees it (`claude auth status`): false means a message resumed headlessly would fail
   * with "run claude auth login", so a receiver can say so before anyone sends one.
   * Absent when the daemon can't tell, or predates the field.
   */
  signed_in?: boolean | undefined;
}

/**
 * `POST {control}/pair`, sent with the person's sink token from their own terminal —
 * or, where the receiver declares `control.open_pairing`, with no token and a
 * `poll_key` (CONTROL.md §2).
 */
export interface ControlPairStart {
  /**
   * Open pairing: a random secret only this terminal knows. Status polls present it
   * as their bearer; the receiver keeps only a hash.
   */
  poll_key?: string | undefined;
  /** Set when adding a key to a machine already paired. */
  machine?: string | undefined;
  /** The machine's name. */
  name: string;
  /** The harnesses it can drive. */
  harnesses: string[];
  /** The delivery modes it offers. */
  modes: DeliveryMode[];
  /** sessionpipe's version. */
  version: string;
  /**
   * The folders the machine lets sessions run in, for the receiver's "new session"
   * picker. Informational: the machine checks its own list again.
   */
  folders?: string[] | undefined;
  /**
   * safe: nothing that needs approval runs unattended; auto: the harness's auto mode;
   * inherit: no permission flag, each harness's own default there. Chosen at the machine.
   */
  mode?: MachineMode | undefined;
  /**
   * The harness accounts signed in here, so the receiver's board can name each
   * `session.account_id` (CONTROL.md §2).
   */
  accounts?: HarnessAccount[] | undefined;
  /**
   * The machine takes `files` on a start (downloads, checks and writes them). A
   * machine that doesn't say so may ignore them: a receiver SHOULD NOT send it files.
   */
  files?: boolean | undefined;
  /**
   * The kinds of key this machine takes (unique; absent means `["passkey"]`). A
   * client offers a device key only to a machine that lists `device`.
   */
  key_types?: KeyType[] | undefined;
  /**
   * Sessions on this machine may ask another agent through its daemon (CONTROL.md
   * §13). Informational: a receiver can neither start an ask nor switch it.
   */
  ask?: boolean | undefined;
  /**
   * The machine takes `reply_to` on a prompt or a start (CONTROL.md §6). One that
   * doesn't say so refuses it: a receiver SHOULD NOT send it one.
   */
  handoff?: boolean | undefined;
}

/** The receiver's answer: where the person confirms, and the digits both screens show. */
export interface ControlPairStarted {
  /** The machine's id. */
  machine: string;
  /** The pairing code. */
  code: string;
  /** Where the person confirms. */
  url: string;
  /** Six digits the terminal and the receiver's page both show. */
  check: string;
  /** When the code expires. */
  expires_at: string;
}

/**
 * `GET {control}/pair?code=…` once the person confirmed. The machine verifies `proof`
 * over sha256("sessionpipe.pair:<machine>:<code>") before it trusts `key`.
 */
export interface ControlPaired {
  /** Where the pairing stands. */
  status: PairStatus;
  /** The key approved, whole: a device key keeps its type, store and uv. */
  key?: ControlKey | undefined;
  /** The key's proof: a passkey assertion, or a device signature for purpose `pair`. */
  proof?: Proof | undefined;
  /**
   * The machine's own bearer for polls, acks and hello: opens nothing else. Minted
   * once, at the first pairing of a machine.
   */
  token?: string | undefined;
  /**
   * Optional: a key for the events lane (`sink add`), so the receiver's session board
   * shows this machine without a second step. Handed over once.
   */
  sink_token?: string | undefined;
  /**
   * Optional: who approved, in the receiver's words (a @handle), so the terminal can
   * say whose passkey it now trusts.
   */
  account?: string | undefined;
}

/**
 * One account in the machine's pool, as its hello lists it (CONTROL.md §2 `pool`).
 * `id` is the string `session.account_id` and `limits.observed.account_id` carry, so
 * a receiver joins the three without a map. The email travels only here.
 */
export interface PoolAccount {
  /** The account's id. */
  id: string;
  /** The email it signs in with. */
  email?: string | undefined;
  /** What the person calls it, when they named it. */
  label?: string | undefined;
  /** Whether it is on. */
  enabled: boolean;
  /** Where it stands. */
  status: PoolAccountStatus;
  /** Serving new sessions right now. At most one account says so. */
  current?: boolean | undefined;
  /** limited: when it has room again, where the machine knows. */
  until?: string | undefined;
  /**
   * The account's freshest numbers, as limits.observed would carry them: from the
   * idle usage poll when no session asked recently, since an idle account's numbers
   * ride on no session and would reach no receiver otherwise.
   */
  windows?: LimitWindow[] | undefined;
  /**
   * limited or error only: what took the account out. A window's id (`seven_day`), or
   * `rejected` (the vendor's status) or `error` (sign in again) for the non-window causes.
   */
  limited_by?: string | undefined;
}

/**
 * The machine's account pool (CONTROL.md §2 `pool`): present in EVERY hello of a daemon
 * that knows the pool (`on: false`, `accounts: []` when nothing is set up), so a
 * receiver tells "no pool" from "an old daemon"; `accounts` in the machine's order.
 */
export interface ControlHelloPool {
  /** Whether the pool serves sessions. */
  on: boolean;
  /** The harness the pool serves. Only `claude-code` today. */
  harness: string;
  /** The accounts, in the machine's order. */
  accounts: PoolAccount[];
}

/** Per harness: the options a start may carry (CONTROL.md §2). */
export interface StartOptions {
  /** The levels it starts at here, already capped by `mode`. */
  permissions: StartPermission[];
  /**
   * What a start that names none gets: one of `permissions`, or `inherit` on an
   * inherit machine.
   */
  permission: RunLevel;
  /** Model ids the harness offers here: a suggestion, not a promise. */
  models?: string[] | undefined;
  /** Any well-formed model is passed to the harness (which may still reject it). */
  any_model?: boolean | undefined;
}

/** `POST {control}/hello`: what the machine can do right now. */
export interface ControlHello {
  /** The machine's name. */
  name: string;
  /** The harnesses it can drive. */
  harnesses: string[];
  /** The delivery modes it offers. */
  modes: DeliveryMode[];
  /** Credential ids of the keys enrolled on the machine. */
  keys: string[];
  /** sessionpipe's version. */
  version: string;
  /** Live sessions with a waiter parked on the daemon's socket. */
  waiting?: string[] | undefined;
  /** As in control-pair.json: informational, re-checked on the machine. */
  folders?: string[] | undefined;
  /** The machine's mode. */
  mode?: MachineMode | undefined;
  /** As in control-pair.json: read again for every hello, so a new sign-in is named. */
  accounts?: HarnessAccount[] | undefined;
  /** As in control-pair.json. */
  files?: boolean | undefined;
  /**
   * The machine takes `files` on a prompt too (CONTROL.md §6 `prompt`). One that
   * doesn't say so refuses them: a receiver SHOULD NOT send it a prompt with files.
   */
  prompt_files?: boolean | undefined;
  /**
   * Per harness in `harnesses`: the options a start may carry (CONTROL.md §2). No
   * entry: neither `permission` nor `model`.
   */
  start?: Record<string, StartOptions> | undefined;
  /** As in control-pair.json. */
  key_types?: KeyType[] | undefined;
  /**
   * The machine's account pool, when its daemon has one; sent again the moment the
   * pool changes. A hello without it is a daemon that predates the pool.
   */
  pool?: ControlHelloPool | undefined;
  /** As in control-pair.json; read again for every hello, so `sessionpipe ask off` shows. */
  ask?: boolean | undefined;
  /** As in control-pair.json. */
  handoff?: boolean | undefined;
}
