// SPDX-License-Identifier: Apache-2.0
// The control daemon (spec/CONTROL.md): one process per computer. It holds one
// long-poll per paired receiver, verifies every command itself against the keys
// enrolled at this terminal, and delivers each one the cheapest way the session
// allows — to a parked waiter, at the session's next Stop, to a session it holds
// through the Agent SDK, or by a headless resume or fork — then acks how. Claude Code,
// Codex (`codex exec`) and Antigravity (`agy`) sessions can be resumed and started
// headlessly, and so can any agent that speaks ACP (held like an SDK session, `api`
// mode); the Agent SDK, waiters, Stop blocks and forks are Claude Code's.
//
// The same runs serve a session here that asks another agent (`sessionpipe ask`, on the
// local socket, §13) and a handoff whose reply goes into another session (`reply_to`,
// §6): the start, prompt and headless paths ack to a Caller, which is a paired receiver
// or a sink of the daemon's own, and what those runs did goes out as events on the
// asking session, the way a hook's do.
//
// A receiver can queue a message; it can never make this process run one.
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  acpControl,
  antigravityControl,
  claudeAccountDirs,
  claudeAccounts,
  claudeControl,
  codexControl,
  configFile,
  DELEGATED_BY_ENV,
  deniedNote,
  type HarnessAccount,
  HELLO_HARNESSES_MAX,
  JOB_TIMEOUT_MS,
  jobEnv,
  type Login,
  machineName,
  makeEvent,
  Outbox,
  type Reading,
  type RunOptions,
  type RunResult,
  readConfig,
  redactDeep,
  redactSecrets,
  type Session,
  safeId,
  takeLock,
  tilde,
  ulid,
  untilde,
} from "@sessionpipe/core";
import {
  type ControlCommand,
  KEY_TYPES,
  levelRank,
  MODEL_MAX,
  MODEL_RE,
  narrower,
  parseSessionRef,
  type RunLevel,
  type StartPermission,
  TEXT_MAX,
  verifyCommand,
} from "@sessionpipe/core/control";
import type { Pool } from "../pool/index.js";
import { drain, factsState } from "../run.js";
import { type Alias, type Aliases, aliasFile, readAliases, receiverIdOf, writeAliases } from "./aliases.js";
import { fetchFiles, withFiles, writeFiles } from "./files.js";
import * as inbox from "./inbox.js";
import { Lines, type Turn } from "./line.js";
import { type AskRequest, ask, type LocalReply, type LocalRequest } from "./local.js";
import { poolRequestOf, runPoolRequest } from "./pool.js";
import { type Following, firstAsk, follow, ranInMode, transcriptEnd } from "./reply.js";
import {
  CANCEL,
  CLAUDE_NOT_FOUND,
  COPY_AGAIN,
  COPY_AGAIN_BARE,
  COPY_RAN,
  channelMark,
  copyNote,
  type DeliveryMode,
  earlier,
  frame,
  frameAsk,
  frameHandoff,
  frameMarked,
  frameStart,
  HEADLESS,
  HELD,
  type Holder,
  holderOf,
  IN_PLACE_ANSWER,
  kindPath,
  messageMark,
  routeCancel,
  routePrompt,
} from "./route.js";
import {
  type Ack,
  AckOutbox,
  askOn,
  type ControlConfig,
  type ControlMode,
  type DaemonState,
  HOLD_TTL_MS,
  NonceStore,
  type PairedReceiver,
  type Parked,
  readState,
  type StartOptions,
  startOptionsOf,
  writeControl,
  writeState,
} from "./store.js";
import { AnswerStream } from "./stream.js";

const {
  claudeArgs,
  claudeEnv,
  findTranscript,
  initSession,
  isUuid,
  loginHint,
  homeSettings,
  liveRecord,
  liveRecords,
  parseResult,
  peerClass,
  recentlyWritten,
  relaunchMode,
  resolveHome,
  sessionFolder,
} = claudeControl;
type Caps = claudeControl.Caps;
type Transcript = claudeControl.Transcript;
type LiveRecord = claudeControl.LiveRecord;

/** Where a session lives: its folder, and how the harness names it. */
interface Placed {
  folder: string;
  /** Claude Code's transcript. */
  transcript: Transcript | null;
  /** Codex / Antigravity: the harness's own id to resume (an alias's, else the command's). */
  target?: string;
  /** Codex: the session's rollout file, whose writes say whether it is in use. */
  file?: string | null;
}

/** A harness the daemon runs headlessly besides Claude Code (codex-control.ts,
 *  antigravity-control.ts). */
interface Driver {
  label: string;
  cmd: string;
  bin: () => string | null;
  args: (o: { permission: RunLevel; prompt: string; cwd: string; resume?: string; model?: string }) => string[];
  /** The levels a start may ask for here, and the one it gets by default (CONTROL.md §2). */
  levels: (mode: ControlMode) => StartPermission[];
  defaultLevel: (mode: ControlMode) => RunLevel;
  /** Model ids to suggest, when the harness takes a model at all. */
  models?: () => string[];
  reading: () => Reading & { warnings?: string[] };
  login?: (bin: string) => Promise<Login>;
  loginHint?: string;
}

/** One harness's entry in the hello's `start` (CONTROL.md §2). */
export interface StartEntry {
  permissions: StartPermission[];
  /** What a start that names none gets: a level, or `inherit` on an inherit machine. */
  permission: RunLevel;
  models?: string[];
  any_model?: boolean;
}

/** The modes the Agent SDK takes for every level: a start through it is not limited by
 *  what `claude --help` lists (sdk.ts maps each level to its `permissionMode`). */
const SDK_CAPS: Caps = {
  hasMode: true,
  modes: ["plan", "dontAsk", "acceptEdits", "auto"],
  promptsNone: false,
  fork: true,
};

/** Pool actions that change what every session on the machine runs through, or
 *  delete a credential: a fresh confirm (CONTROL.md §3.2, §6 `pool`), never a day
 *  grant alone — a stolen receiver session must not be able to put its own account
 *  first or take the person's out. */
const POOL_CONFIRM = new Set(["on", "off", "remove", "order", "disable", "login.complete"]);

/** A failure the harness puts down to the model it was asked to run. */
const MODEL_FAILURE_RE = /\bmodel\b/i;

/** A start, read from the command before it is verified: only ever used to order a
 *  prompt behind it, never to run anything. Read as the verifier reads it, from the
 *  parsed command: the kind's own bytes say nothing, since JSON lets "start" be written
 *  with an escape. */
function startNamed(cmd: unknown): string | null {
  if (typeof cmd !== "string" || cmd.length > 64 * 1024) return null;
  try {
    const c = JSON.parse(cmd) as { kind?: unknown; session?: unknown };
    return c?.kind === "start" && typeof c.session === "string" ? c.session : null;
  } catch {
    return null;
  }
}

/** A prompt's session and the time it was signed, read from the command before it is
 *  verified: only ever used to give it its place in that session's line (line.ts), never
 *  to run anything. The bytes are the ones the verifier then reads, and they are read
 *  the way it reads them (parsed; a command longer than this is refused there), so a
 *  prompt that verifies is one this found. Looking for the bytes `"prompt"` first found
 *  none in a kind written `"\u0070rompt"`: that prompt verified with no place in line. */
function promptNamed(cmd: unknown): { session: string; iat: number } | null {
  if (typeof cmd !== "string" || cmd.length > 64 * 1024) return null;
  try {
    const c = JSON.parse(cmd) as { kind?: unknown; session?: unknown; iat?: unknown };
    return c?.kind === "prompt" && typeof c.session === "string" && typeof c.iat === "number" && Number.isFinite(c.iat)
      ? { session: c.session, iat: c.iat }
      : null;
  } catch {
    return null;
  }
}

declare const __SESSIONPIPE_VERSION__: string;
const VERSION = typeof __SESSIONPIPE_VERSION__ === "string" ? __SESSIONPIPE_VERSION__ : "0.0.0";

const MAX_REPLY = 20_000;
const HELLO_EVERY_MS = 10 * 60_000;
/** A message waiting for a Stop that never comes goes another way after this. */
const TURN_FALLBACK_MS = 30 * 60_000;
/** How long the daemon follows a session's turn for the answer to an in-place
 *  message before acking it delivered without one. */
const ANSWER_WAIT_MS = 30 * 60_000;
/** How long a Stop hook may take to be answered. */
const RECENT_ACKS_MS = 25 * 3600_000;
/** How many sessions' recorded permission modes are kept (CONTROL.md §6, The session's
 *  mode). One entry is a session ref and a word; the oldest go first. */
const MODES_KEPT = 500;
/** A message written into a live session has to be fresh: a job queued while the person
 *  sat in front of that session must not be written into it an hour later, when they may
 *  have moved on or changed its mode (CONTROL.md §6.3). Measured from the SIGNED time
 *  (`cmd.iat`), never from the envelope the receiver stamped — the party that does the
 *  queuing must not also choose the clock. Too old is not a failure: the lane simply
 *  doesn't apply and the message takes the next rung. */
const INBOX_FRESH_MS = 120_000;
/** After the session's own `UserPromptSubmit`, how long and how often its transcript is
 *  read for the row that says which message the turn is for (`firstAsk`). The hook fires
 *  before the harness has written the row; this is the gap between the two. */
const PEER_ROW_TRIES = 6;
const PEER_ROW_WAIT_MS = 250;
/** One message at a time waits on a session's next turn: two would both be settled by
 *  one turn, and one answer would be acked as the answer to both. */
const PARKED_ACK = {
  outcome: "failed" as const,
  code: "parked",
  detail: "another message for that session is still waiting for it to answer; send this one again in a moment",
};
/** A start whose Stop came before its process began (CONTROL.md §6 `cancel`): nothing
 *  was started, so it is not called delivered, and a receiver that shows a new session
 *  as working until it hears otherwise hears it here. */
const UNSTARTED_ACK = { outcome: "failed" as const, code: "cancelled", detail: CANCEL.unstarted };
/** Why a message is not written into a live session's inbox when its id is not a ULID
 *  (CONTROL.md §6.3): said in the log and, where the message then ran in a copy, in its
 *  ack's `detail` after "it could not be reached in place:". */
const UNMARKED =
  "the receiver gave this message an id that is not a ULID, so the turn it would cause there could not be told from any other";
/** A channel took the message and the session began no turn for it (CONTROL.md §8). */
const CHANNEL_HELD_ACK = {
  outcome: "failed" as const,
  code: "held",
  detail:
    "handed to the session's sessionpipe channel on this computer; it didn't begin a turn for it, so Claude Code may have dropped the message or be holding it. Nothing was duplicated and nothing else was tried; the next message to it goes another way.",
};
/** Events that prove a pending permission prompt was resolved some other way. */
const CLOSES_ATTENTION = new Set([
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "StopFailure",
  "UserPromptSubmit",
  "SessionEnd",
]);

/** The message as the receiver carried it (control.json). */
export interface Carried {
  id: string;
  cmd: string;
  csig?: string | null;
  grant?: { str: string; cred: string; ad: string; cd: string; sig: string } | null;
  confirm?: { cred: string; ad: string; cd: string; sig: string } | null;
  at: string;
  expires_at: string;
}

/** A session the daemon holds: through the Agent SDK (sdk.ts; a fake in tests), or an
 *  ACP agent it runs (core's acp-control.ts), which says so in `mode`. */
export interface SdkSession {
  /** Deliver one message; resolves with the agent's reply when the turn ends. */
  send(text: string): Promise<{ reply: string; error?: string }>;
  interrupt(): Promise<void>;
  close(): void;
  readonly busy: boolean;
  readonly lastUsed: number;
  /** How a message through it is acked; `sdk` when unsaid. */
  readonly mode?: DeliveryMode;
  /** Gone for good (the process left): drop it, a later message reopens the session. */
  readonly closed?: boolean;
}
export interface SdkHost {
  start(o: {
    session: string;
    cwd: string;
    /** The level the session runs at (CONTROL.md §3.1), as its `permissionMode`; none in inherit. */
    permission: RunLevel;
    /** The model, when the start asked for one. */
    model?: string;
    configDir?: string;
    allowedTools?: string[];
    /** Over the process's own: an ask's lineage for the session's hooks (CONTROL.md §13). */
    env?: Record<string, string>;
  }): SdkSession;
}

/** Where a command's acks go, besides a paired receiver (store.ts PairedReceiver: the ack
 *  outbox, then `POST /ack`): an asker on the local socket (CONTROL.md §13) or a handoff's
 *  relay (§6 `reply_to`), each a sink of the daemon's own. The start, prompt and headless
 *  paths are written once, against a Caller, so a run acks the same way wherever it came
 *  from and there is no second copy of any of them. */
export interface AckSink {
  /** Names it in the log and the acks' `receiver`. */
  label: string;
  /** The text as the session gets it: a new session's first message, or a later one.
   *  `mark` when it is handed to a live session in place: the frame names the message,
   *  so its answer can be found in that session's transcript (reply.ts). */
  frame(text: string, first: boolean, mark?: string | null): string;
  /** What a child the run starts gets in its environment, over the job's own. */
  env?: Record<string, string>;
  /** The answer so far (§10 `progress`), redacted and capped like an ack's reply. */
  progress(text: string, seq: number): void;
  /** `taken`, then exactly one final outcome: the acks a receiver would get. */
  ack(a: Omit<Ack, "receiver">): void;
  /** False when the message reaching the session is the whole job and its reply isn't
   *  waited for (a relay). */
  wantsReply: boolean;
}
type Caller = PairedReceiver | AckSink;
const isSink = (r: Caller): r is AckSink => "ack" in r;

/** A command that carried `reply_to` (CONTROL.md §6, a handoff): remembered until its
 *  final ack, when the reply goes into that session. */
interface Handoff {
  receiver: PairedReceiver;
  askId: string;
  to: { harness: string; id: string };
  /** The session the command named (the ack may name the copy it ran in). */
  from: string;
  sent: number;
}

/** How deep an ask may already be: A asks B, B may ask C, C may not ask (§13). */
const ASK_DEPTH = 2;
const ASK_CHAIN_MAX = 8;
/** Asks one session may have in hand at once, as the asker or as the session asked
 *  (§13 `start_limit`): an ask into a session that already exists takes no start, so
 *  nothing else bounds how many a looping model queues on one. */
const ASKS_IN_HAND = 3;
const ASK_HARNESS_RE = /^[a-z][a-z0-9-]{0,39}$/;

/** An ask's fields as the wire has them (local.ts), checked before any rule: what is
 *  wrong, in words, or null. The CLI builds them, but the socket takes any process of
 *  the person's own, so nothing here is trusted by shape. */
export function askProblem(req: AskRequest): string | null {
  const r = req as Partial<AskRequest>;
  if (typeof r.harness !== "string" || !ASK_HARNESS_RE.test(r.harness)) return "which agent?";
  if (r.session !== undefined) {
    const ref = parseSessionRef(r.session);
    if (!ref) return "a session is <harness>:<id>";
    if (ref.harness !== r.harness) return `${r.session.slice(0, 24)} isn't a ${r.harness} session`;
  }
  if (r.from !== undefined && !parseSessionRef(r.from)) return "from is the asking session, <harness>:<id>";
  if (typeof r.text !== "string" || !r.text.trim() || r.text.length > TEXT_MAX)
    return `an ask needs text, at most ${TEXT_MAX} characters`;
  if (typeof r.cwd !== "string" || !path.isAbsolute(r.cwd) || r.cwd.length > 1024) return "cwd is an absolute folder";
  if (!Array.isArray(r.chain) || r.chain.length > ASK_CHAIN_MAX || r.chain.some((c) => !parseSessionRef(c)))
    return "chain is a list of sessions, <harness>:<id>, outermost first: the asks this one is nested in";
  if (r.permission !== undefined && r.permission !== "read" && r.permission !== "safe")
    return "a permission is read or safe: an ask runs narrower than the machine's mode, never wider";
  if (r.model !== undefined && (typeof r.model !== "string" || r.model.length > MODEL_MAX || !MODEL_RE.test(r.model)))
    return `a model is 1 to ${MODEL_MAX} letters, digits and ._:/@[]-, not starting with a dash`;
  if (r.pid !== undefined && !Number.isInteger(r.pid)) return "pid is a number";
  return null;
}

/** A run's refusal (CONTROL.md §5, §6) in the ask's own words (§13): a session the daemon
 *  can't deliver to falls under the `harness` rule, a level or model it won't run with is
 *  the request's own fault; the start caps keep their name. */
export const askCode = (code: string | undefined): string =>
  code === "no_session" || code === "bad_session"
    ? "harness"
    : code === "permission" || code === "model"
      ? "bad_fields"
      : (code ?? "failed");

/** A session as the person knows it, for a sentence they will read: the start of its own
 *  id, which is what a receiver's page and address show and what `claude --resume` takes.
 *  Not the protocol's short id (PROTOCOL.md §3), a hash no page of theirs has ever shown:
 *  "No Claude Code session 66a04e0a on this machine" named a session that was 88749ed7
 *  everywhere else (2026-11-10). */
const known = (id: string): string => id.slice(0, 8);

/** A session place() refused, as the ack says it. */
const refusal = (p: { refused: string; why: string }): Omit<Ack, "receiver" | "id" | "at"> => ({
  outcome: "refused",
  code: p.refused,
  detail: p.why,
});

export interface DaemonDeps {
  now: () => number;
  fetch: typeof fetch;
  log: (line: string) => void;
  claudeDirs: () => string[];
  claude: () => { bin: string; caps: Caps } | null;
  /** Codex CLI's `codex` and Antigravity's `agy` on this machine (null: not installed).
   *  Absent: this daemon doesn't drive that harness. */
  codex?: () => string | null;
  agy?: () => string | null;
  /** Is Codex signed in as this process sees it? Asked before a run. */
  codexLogin?: (bin: string) => Promise<Login>;
  /** An ACP agent's CLI on this machine, by harness name (core's findAcpAgent; null:
   *  not installed). Absent: this daemon drives none of them. */
  acp?: (harness: string) => { bin: string; args: string[] } | null;
  /** The harnesses every hello advertises (core's drivableHarnesses); by default, the
   *  ones the finders above find. */
  harnesses?: () => string[];
  /** The harness accounts every hello names; by default, those signed in across
   *  `claudeDirs`, read again for each hello. */
  accounts?: () => HarnessAccount[];
  /** The models a hello suggests for Codex; by default, its own models cache. */
  codexModels?: () => string[];
  run: (bin: string, args: string[], o: RunOptions) => Promise<RunResult>;
  sdk?: SdkHost | null;
  /** How a message is written into a live session's own inbox (inbox.ts). A test passes
   *  its own, to drive the one refusal that can only happen between the look and the
   *  first byte: the session ending in between. */
  writeInbox?: typeof inbox.writeInbox;
  /** How long to follow a live session's turn for an in-place answer (tests shorten it). */
  answerWaitMs?: number;
  /** After a session's hooks say its turn ended, how long its last rows may take to
   *  reach the transcript (reply.ts; tests shorten it). */
  answerGraceMs?: number;
  /** Close an SDK session idle this long (a held session costs ~300 MB). */
  sdkIdleMs?: number;
  /** How long one of a start's files may take to download (tests shorten it). */
  fileTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Is Claude Code signed in for this account, as this process sees it? Asked before
   *  a headless run, so a login the daemon can't read (a macOS keychain with nobody at
   *  the screen) fails with what to do, not with Claude Code's "please run /login". */
  login?: (configDir?: string) => Promise<Login>;
  /** Read a receiver's machine token again: it may live in a keychain that was
   *  locked when the daemon started and has unlocked since. */
  token?: (r: PairedReceiver) => string | null;
  platform?: NodeJS.Platform;
  /** `sessionpipe update` installed a new copy: restart onto it once idle. True when
   *  accepted (autoupdate.ts). */
  onRestart?: () => boolean;
  /** The updater's view, for `control status`. */
  updateStatus?: () => unknown;
  /** Another daemon took the socket path: this one has stopped and should exit. */
  onLostSocket?: () => void;
  /** The machine's account pool (pool/index.ts): its listener runs in this process,
   *  every hello carries its state, and `pool` commands and socket ops go to it.
   *  Absent: this daemon can't pool (a `pool` command is `unsupported`). */
  pool?: Pool;
}

/** Another daemon already answers on the socket: this one must not start. */
export class DaemonRunning extends Error {
  constructor(readonly other: { pid?: number; version?: string }) {
    super(
      `another control daemon already serves this machine (${other.pid ? `pid ${other.pid}, ` : ""}sessionpipe ${other.version ?? "?"})`,
    );
  }
}

/** A turn the daemon has in hand as its own: from the moment its message's turn comes,
 *  through everything that has to happen before it can start (the wait for its session's
 *  start, a login check, its files, a free slot), to the end of the child process it
 *  runs as. A `cancel` stops it at any of those points (CONTROL.md §6 `cancel`); it is let
 *  go of when its message is handed to a live session instead, which is not the
 *  daemon's to stop. */
interface OwnRun {
  /** Aborted: whatever it is waiting on is given up and it never starts, or the child
   *  it runs as is ended (core's runHeadless). */
  ctl: AbortController;
  /** The message the turn is for. */
  id: string;
  /** The sessions it is a turn of, by every id a `cancel` may name it by: the one its
   *  command named and the copy that session's messages go to (both from the moment it
   *  is in hand, `namesOf`), and the copy it is making, once that has named itself. The
   *  ack and the board send a person to the copy, so that is where they press Stop. */
  sessions: string[];
  /** How that message is acked, once it is known which way it goes: what a `cancel`
   *  that stops it says it stopped. */
  mode: "resume" | "fork" | null;
  /** The child process was started. */
  began: boolean;
  /** The stop is what ended it. */
  stopped: boolean;
  /** Resolves when it is stopped, for whatever is waiting on something else meanwhile. */
  stoppedSoon: Promise<typeof STOPPED>;
  /** Settles when it is over or handed on: true when it was stopped, false otherwise. */
  done: Promise<boolean>;
  settle: (stopped: boolean) => void;
}
/** What `orStopped` answers when the stop came first. */
const STOPPED = Symbol("stopped");

interface TurnPending {
  receiver: Caller;
  msgId: string;
  text: string;
  session: string;
  queuedAt: number;
  /** When the person signed it: carried through a reroute, because an in-place lane's
   *  freshness window is measured from that and never from the receiver's envelope. */
  iat: number;
}

interface Live {
  midTurn: boolean;
  /** The Stop hook just delivered a block: the next Stop event continues the turn. */
  continued: boolean;
  waiter: net.Socket | null;
  /** The parked waiter is `sessionpipe channel`, and this is its process: a channel's
   *  message has to be proven by the turn it causes (CONTROL.md §8). Null: a
   *  `sessionpipe wait`, or no waiter. */
  channel: number | null;
  turnQueue: TurnPending[];
  attentions: Map<string, net.Socket>;
  cwd?: string;
  transcript?: string;
  lastEvent: number;
  /** When the session's own hooks last reported its end (`SessionEnd`): the process that
   *  held it has let go of it, so what its transcript gained up to then was written by a
   *  process that is done (view()). */
  ended?: number;
}

interface PollState {
  started: number;
  last: number | null;
  error: string | null;
  on: boolean;
  unauthorized: boolean;
  authBackoff: number;
  wake: (() => void) | null;
}

export interface Status {
  version: string;
  pid: number;
  name: string;
  receivers: {
    url: string;
    machine: string;
    keys: number;
    polling: boolean;
    /** Last successful poll; failed responses must not conceal a control outage. */
    last_poll: number | null;
    /** Time since success, or since this loop started if it has never succeeded. */
    last_poll_age_ms: number;
    last_error: string | null;
  }[];
  waiting: string[];
  mid_turn: string[];
  attentions: { session: string; id: string }[];
  sdk: string[];
  nonces: number;
  acks_pending: number;
  delivered: Record<string, number>;
  /** What a start may carry per harness, as the last hello said (CONTROL.md §2). */
  start: Record<string, StartEntry>;
  /** Whether a session here may ask another agent, and which agents (CONTROL.md §13). */
  ask: { on: boolean; harnesses: string[] };
  /** Null when the daemon could restart now (nothing in hand); otherwise what it holds. */
  busy: string | null;
  update?: unknown;
  /** The account pool, when this daemon has one (`sessionpipe pool` has the whole picture). */
  pool?: {
    on: boolean;
    port: number;
    listening: boolean;
    accounts: number;
    with_room: number;
    in_flight: number;
    /** Another daemon answers on the pool's port; this one doesn't listen. */
    another_daemon?: true;
  };
}

/** The machine's own caps (CONTROL.md §6 `start`): every command is the owner's,
 *  signed, but a burst of them must not start a crowd of agents. A start beyond the
 *  caps is refused `start_limit`; a headless run beyond `headless` waits its turn. */
/** What a receiver may let its sessions use without asking (CONTROL.md §6): its own MCP
 *  servers, by name — never a built-in tool. The receiver is where the message came
 *  from, so answering it there (publishing a page, replying) is the job; anything else
 *  still needs the person's approval rule. */
export function sessionToolsFrom(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [
    ...new Set(v.filter((t): t is string => typeof t === "string" && /^mcp__[A-Za-z0-9_-]{1,64}$/.test(t))),
  ].slice(0, 8);
}

export const LIMITS = { startConcurrent: 2, startPerHour: 10, headless: 3, copiesPerDay: 10 } as const;

export class ControlDaemon {
  private server: net.Server | null = null;
  private readonly live = new Map<string, Live>();
  private readonly sdkSessions = new Map<string, SdkSession>();
  private readonly nonces: NonceStore;
  private readonly acks: AckOutbox;
  private readonly recentAcks = new Map<string, { ack: Ack; at: number }>();
  private readonly inflight = new Set<string>();
  private readonly queues = new Map<string, Promise<unknown>>();
  /** Each session's messages, one at a time and in the order they were sent (line.ts). */
  private readonly lines = new Lines();
  private readonly lastEnd = new Map<string, number>();
  /** Per session: who is waiting for its next `UserPromptSubmit` — the first half of an
   *  in-place delivery's proof. At most ONE per session: two waiters would both be
   *  settled by one turn, and that turn's answer acked as the answer to both. */
  private readonly prompted = new Map<string, (ok: boolean) => void>();
  /** Per session, as its hooks name it: the answers being read from its transcript. They
   *  hear when its hooks report the end of a turn. */
  private readonly following = new Map<string, Set<Following>>();
  /** Per session: a message written into its own inbox that it has not taken yet. The
   *  receiving inbox parks one whose class it can't match and drops it after five
   *  minutes, and a hold can be RELEASED later (a mode change does it), so for that long
   *  another write would mean the person's words arriving twice (CONTROL.md §6.3). */
  private readonly parked = new Map<string, { at: number; id: string }>();
  /** `sessionpipe channel` processes that took a message and no turn began for it:
   *  Claude Code drops a channel's notification in silence when it didn't register the
   *  channel (a `--print` session, an organization that turns channels off), so this one
   *  would swallow every message after it too. A new channel process starts trusted. */
  private readonly mutedChannels = new Set<number>();
  /** Things said once in the log however many acks carry them (a mode the settings turn
   *  off): the person reads the ack, the machine's log doesn't need it every time. */
  private readonly warned = new Set<string>();
  private state: DaemonState;
  private running = false;
  private readonly polling = new Map<string, PollState>();
  private readonly delivered: Record<string, number> = {};
  private helloTimer: NodeJS.Timeout | null = null;
  private helloSoon: NodeJS.Timeout | null = null;
  private readonly aborts = new Set<AbortController>();
  /** Per receiver: the MCP servers its sessions may use unattended (its well-known). */
  private readonly sessionTools = new Map<string, string[]>();
  /** Sessions a run of the daemon's own is working on right now (a start, a resume):
   *  a message for one waits for that run and resumes it — never a copy, which would
   *  set two agents on one task (2026-10-02: a "just merge when ready" sent while the
   *  start still ran forked a second agent that raced the first toward main). */
  private readonly ownRuns = new Map<string, number>();
  /** The turns the daemon has in hand as its own, in the order it took them (`OwnRun`):
   *  what a `cancel` ends is the first of them for the session it names — a start that is
   *  running, not the message that waits for it. A message still waiting in its session's
   *  line is not in here, so a Stop never takes it with it. */
  private readonly runs: OwnRun[] = [];
  private startsRunning = 0;
  private startTimes: number[] = [];
  private procs = 0;
  private readonly procWaiters: (() => void)[] = [];
  /** configDir → the last login answer and when (a yes is kept 10 minutes, a no 30 s). */
  private readonly logins = new Map<string, { at: number; login: Login }>();
  /** account id → the `signed_in` the log last said, so a change is said once. */
  private readonly signedInSaid = new Map<string, boolean>();
  /** Intake paused for an update: the long-polls end and wait for this. */
  private paused: { until: Promise<void>; go: () => void } | null = null;
  /** Poll answers whose messages are being read and handed out. */
  private receiving = 0;
  /** The socket file this daemon created (dev:ino): stop() removes only that one, and a
   *  different file at the path means another daemon took over. */
  private sockId: string | null = null;
  private ownTimer: NodeJS.Timeout | null = null;
  /** Every open local connection: stop() ends them, or the server's close would wait
   *  on a client that never says anything. */
  private readonly conns = new Set<net.Socket>();
  /** Codex and Antigravity sessions the daemon started, under the start's id (aliases.ts). */
  private aliases: Aliases;
  /** Starts in hand, by the session they name, from the moment they arrive: a prompt
   *  for that session that came in the same poll waits for its start rather than
   *  finding no session (2026-10-04: a start and a prompt queued back to back). */
  private readonly startsPending = new Map<string, Promise<void>>();
  /** Commands with `reply_to` in hand, by message id: their reply follows into that
   *  session after their own final ack (CONTROL.md §6). */
  private readonly handoffs = new Map<string, Handoff>();
  /** Asks in hand, by ask id: who asked whom. The depth and loop rules (§13) count from
   *  here as well as from the chain the caller reports, which is the caller's own to
   *  clear: B, asked by A, can't ask A back from a clean environment, and C, asked by B
   *  under A, can't ask on by forgetting its chain. */
  private readonly asks = new Map<string, { from: string | null; to: string }>();

  constructor(
    private cfg: ControlConfig,
    private readonly dir: string,
    private readonly sock: string,
    private readonly deps: DaemonDeps,
  ) {
    this.nonces = new NonceStore(path.join(dir, "nonces.jsonl"), deps.now);
    this.acks = new AckOutbox(path.join(dir, "acks.jsonl"));
    this.state = readState(path.join(dir, "state.json"), deps.now());
    this.aliases = readAliases(aliasFile(dir));
  }

  // --- lifecycle ------------------------------------------------------------------

  async start(): Promise<void> {
    this.running = true;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    await this.listen();
    // The pool's listener comes up before anything that could take time: while the
    // pool is on, every Claude Code request on this machine goes through it.
    await this.syncPool();
    for (const r of this.cfg.receivers) void this.pollLoop(r);
    this.helloTimer = setInterval(() => void this.helloAll(), HELLO_EVERY_MS);
    this.helloTimer.unref();
    void this.helloAll();
    void this.flushAcks();
    const idle = setInterval(() => this.closeIdleSdk(), Math.min(60_000, this.deps.sdkIdleMs ?? 60_000));
    idle.unref();
    if (this.sockId) {
      this.ownTimer = setInterval(() => void this.checkSocket(), 10_000);
      this.ownTimer.unref();
    }
    this.deps.log(
      `control daemon ${VERSION} up · pid ${process.pid} · ${this.cfg.receivers.length} receiver(s) · socket ${this.sock}`,
    );
  }

  /** `leaveSocket`: the socket path is another daemon's now. Closing a Unix-socket
   *  server makes Node unlink its path whoever holds it, so this one's server is left
   *  open for the process's exit to drop. */
  async stop(o: { leaveSocket?: boolean } = {}): Promise<void> {
    this.running = false;
    this.paused?.go();
    for (const a of this.aborts) a.abort();
    for (const st of this.polling.values()) st.wake?.();
    if (this.helloTimer) clearInterval(this.helloTimer);
    if (this.helloSoon) clearTimeout(this.helloSoon);
    if (this.ownTimer) clearInterval(this.ownTimer);
    for (const s of this.sdkSessions.values()) s.close();
    for (const l of this.live.values()) {
      l.waiter?.destroy();
      for (const a of l.attentions.values()) a.destroy();
    }
    for (const c of this.conns) c.destroy();
    if (o.leaveSocket) {
      this.sockId = null;
      return;
    }
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server = null;
    // Only the socket file this daemon made: after a hand-over the path is someone else's.
    /* v8 ignore next -- Node unlinks a listening Unix socket's path in server.close(), so the file is gone by here; kept for a runtime that doesn't */
    if (process.platform !== "win32" && this.sockId && socketId(this.sock) === this.sockId)
      try {
        unlinkSync(this.sock);
      } catch {}
    this.sockId = null;
    // Last: a request mid-stream finishes while the rest shuts down.
    await this.deps.pool?.stop();
  }

  /** The pool's listener and its idle usage poll run exactly while the pool is on
   *  (PRIVACY.md §3: the vendor is called only for a pool the person turned on):
   *  up after `on`, down after `off`, whatever accounts exist. Idempotent either way. */
  private async syncPool(): Promise<void> {
    const p = this.deps.pool;
    if (!p) return;
    const s = p.status();
    if (!s.on) {
      if (s.listening) await p.stop();
      return;
    }
    try {
      const r = await p.start();
      // Another daemon already answers on the pool's port: the pool is its, as the
      // socket would be. This one keeps only what else it was started for.
      if (r.other)
        this.deps.log(`another daemon already serves the pool on 127.0.0.1:${r.port}; this one leaves it to that one`);
    } catch (e) {
      this.deps.log(`the pool's listener did not start: ${String((e as Error)?.message || e)}`);
    }
  }

  /** The pool changed what a hello says (pool/index.ts `onChange`): say it now, as a
   *  folder change does. */
  poolChanged(): void {
    if (this.running) void this.helloAll();
  }

  /** Null when nothing is in hand, so a restart would interrupt nothing; otherwise what
   *  is. Parked waiters don't count: a waiter reconnects in silence (CONTROL.md §8). A
   *  session someone is working in mid-turn does (a restart forgets it is mid-turn, so a
   *  message to it would fork rather than wait for its Stop), unless it has been silent
   *  for ten minutes: a session killed mid-turn never sends its Stop. */
  busy(): string | null {
    const pooled = this.deps.pool?.status().in_flight ?? 0;
    if (pooled) return `${pooled} pooled request(s) being answered`;
    if (this.inflight.size) return `${this.inflight.size} message(s) in hand`;
    if (this.procs || this.ownRuns.size) return "a headless agent run";
    if (this.startsRunning) return "a session starting";
    for (const s of this.sdkSessions.values()) if (s.busy) return "an Agent SDK session mid-turn";
    for (const l of this.live.values()) if (l.attentions.size) return "a permission prompt waiting for an answer";
    const now = this.deps.now();
    for (const l of this.live.values())
      if (l.midTurn && now - l.lastEvent < 10 * 60_000) return "a session on this machine mid-turn";
    if (this.receiving) return "messages just received";
    if (this.flushing) return "acks being sent";
    return null;
  }

  /** Stop taking messages: every long-poll ends now and waits for resumeIntake(). The
   *  receiver keeps what arrives meanwhile; the local socket keeps answering. */
  pauseIntake(): void {
    if (this.paused) return;
    let go!: () => void;
    const until = new Promise<void>((r) => {
      go = r;
    });
    this.paused = { until, go };
    for (const a of this.aborts) a.abort();
  }

  resumeIntake(): void {
    const p = this.paused;
    this.paused = null;
    p?.go();
  }

  /** The socket path still holds this daemon's file. Gone: listen again. Replaced:
   *  another daemon took over (two started at once), so this one steps aside. */
  private async checkSocket(): Promise<void> {
    if (!this.running || !this.sockId) return;
    const now = socketId(this.sock);
    if (now === this.sockId) return;
    if (now === null) {
      // Someone deleted the file. The old server keeps the connections it has (closing
      // it would wait on parked waiters, and unlink the path again); a new one takes it.
      this.deps.log(`the socket ${this.sock} vanished; listening again`);
      this.server?.unref();
      this.server = null;
      try {
        await this.listen();
      } catch (e) {
        this.deps.log(
          `couldn't listen again: ${String(/* v8 ignore next -- listen() throws Errors (net, DaemonRunning) */ (e as Error)?.message || e)}`,
        );
      }
      return;
    }
    this.deps.log("another control daemon took over the socket; this one stops");
    await this.stop({ leaveSocket: true });
    this.deps.onLostSocket?.();
  }

  reload(cfg: ControlConfig): void {
    const known = new Set(this.cfg.receivers.map((r) => r.control + r.machine));
    const told = JSON.stringify([this.cfg.folders, this.cfg.mode, this.cfg.name, askOn(this.cfg)]);
    this.cfg = cfg;
    for (const r of cfg.receivers) if (!known.has(r.control + r.machine)) void this.pollLoop(r);
    // `control folders`, `control mode`, `ask on|off` or a `--rename-machine` changed what a
    // hello says: say it now, so the receiver doesn't wait up to ten minutes for the next one.
    if (this.running && JSON.stringify([cfg.folders, cfg.mode, cfg.name, askOn(cfg)]) !== told) void this.helloAll();
  }

  status(): Status {
    return {
      version: VERSION,
      pid: process.pid,
      name: this.cfg.name,
      receivers: this.cfg.receivers.map((r) => {
        const p = this.polling.get(r.control + r.machine);
        return {
          url: r.url,
          machine: r.machine,
          keys: r.keys.length,
          polling: !!p?.on,
          last_poll: p?.last ?? null,
          last_poll_age_ms: p ? Math.max(0, this.deps.now() - (p.last ?? p.started)) : 0,
          last_error: p?.error ?? null,
        };
      }),
      waiting: [...this.live].filter(([, l]) => l.waiter).map(([k]) => k),
      mid_turn: [...this.live].filter(([, l]) => l.midTurn).map(([k]) => k),
      attentions: [...this.live].flatMap(([k, l]) => [...l.attentions.keys()].map((id) => ({ session: k, id }))),
      sdk: [...this.sdkSessions.keys()],
      nonces: this.nonces.size,
      acks_pending: this.acks.all().length,
      delivered: { ...this.delivered },
      start: this.startOptions(),
      ask: { on: askOn(this.cfg), harnesses: this.askable() },
      busy: this.busy(),
      ...(this.deps.updateStatus ? { update: this.deps.updateStatus() } : {}),
      ...(this.deps.pool ? { pool: this.poolSummary() } : {}),
    };
  }

  private poolSummary(): NonNullable<Status["pool"]> {
    const s = (this.deps.pool as Pool).status();
    return {
      on: s.on,
      port: s.port,
      listening: s.listening,
      accounts: s.accounts.length,
      with_room: s.accounts.filter((a) => a.status === "ready").length,
      in_flight: s.in_flight,
      ...(s.another_daemon ? { another_daemon: true } : {}),
    };
  }

  // --- the local socket -----------------------------------------------------------

  /** One daemon per machine: a daemon that answers on the socket keeps it, and this
   *  one doesn't start. A socket file nobody answers on is a dead daemon's; it goes. */
  private async listen(): Promise<void> {
    const other = await ask(this.sock, { op: "status" }, 1500);
    if (other?.op === "status") throw new DaemonRunning((other.status ?? {}) as { pid?: number; version?: string });
    if (process.platform !== "win32") {
      try {
        if (existsSync(this.sock)) unlinkSync(this.sock);
      } catch {}
    }
    this.server = net.createServer((s) => this.onConn(s));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.sock, () => resolve());
    });
    if (process.platform !== "win32") {
      // The socket is this user's alone (CONTROL.md §8: mode 0600), whatever the umask.
      chmodSync(this.sock, 0o600);
      this.sockId = socketId(this.sock);
    }
  }

  private onConn(s: net.Socket): void {
    let buf = "";
    let handled = false;
    this.conns.add(s);
    s.on("close", () => this.conns.delete(s));
    s.on("error", () => {});
    s.on("data", (d) => {
      if (handled) return;
      buf += d.toString("utf8");
      if (buf.length > 64 * 1024) return s.destroy();
      const i = buf.indexOf("\n");
      if (i < 0) return;
      handled = true;
      let req: LocalRequest;
      try {
        req = JSON.parse(buf.slice(0, i)) as LocalRequest;
      } catch {
        return s.destroy();
      }
      this.onRequest(req, s);
    });
  }

  private reply(s: net.Socket, r: LocalReply): void {
    try {
      s.end(`${JSON.stringify(r)}\n`);
    } catch {}
  }

  private liveOf(session: string): Live {
    let l = this.live.get(session);
    if (!l) {
      l = {
        midTurn: false,
        continued: false,
        waiter: null,
        channel: null,
        turnQueue: [],
        attentions: new Map(),
        lastEvent: this.deps.now(),
      };
      this.live.set(session, l);
    }
    return l;
  }

  private onRequest(req: LocalRequest, s: net.Socket): void {
    switch (req.op) {
      case "status":
        this.reply(s, { op: "status", status: this.status() });
        return;
      case "wait": {
        if (!parseSessionRef(req.session)) {
          this.reply(s, { op: "none" });
          return;
        }
        const l = this.liveOf(req.session);
        if (l.waiter && l.waiter !== s) this.reply(l.waiter, { op: "replaced" });
        l.waiter = s;
        l.channel = req.channel ? (req.pid ?? 0) : null;
        s.on("close", () => {
          if (l.waiter === s) {
            l.waiter = null;
            l.channel = null;
            this.scheduleHello();
          }
        });
        this.scheduleHello();
        return;
      }
      case "stop": {
        const l = this.liveOf(req.session);
        l.lastEvent = this.deps.now();
        this.recordMode(req.session, req.mode);
        // A Stop: the turn, or the continuation the message before this one caused, is
        // over. Said before the next message is handed over, so each answer ends where
        // the next one's turn begins.
        this.turnEnded(req.session);
        const p = this.takeTurn(l);
        if (!p) {
          this.reply(s, { op: "none" });
          return;
        }
        l.continued = true;
        // The transcript of the session whose Stop this is. Its last words may not be in
        // it yet, so this is only where the search for the answer starts (reply.ts).
        const from = this.answerFrom(req.session);
        // An ask's framing says how the answer travels already; a receiver's gets the note.
        const body = this.inPlace(p.receiver, p.text, p.msgId);
        this.reply(s, {
          op: "block",
          reason: isSink(p.receiver) ? body : `${body}\n\n${IN_PLACE_ANSWER}`,
          id: p.msgId,
        });
        this.followAnswer(p.receiver, p.msgId, "turn", req.session, from, p.queuedAt, {
          mark: messageMark(p.msgId),
          end: "next",
        });
        return;
      }
      case "ask":
        void this.onAsk(req, s);
        return;
      case "permission": {
        const l = this.liveOf(req.session);
        const prev = l.attentions.get(req.attention);
        if (prev && prev !== s) this.reply(prev, { op: "none" });
        l.attentions.set(req.attention, s);
        s.on("close", () => {
          if (l.attentions.get(req.attention) === s) l.attentions.delete(req.attention);
        });
        return;
      }
      case "event":
        this.onEvent(req);
        this.reply(s, { op: "ok" });
        return;
      case "restart":
        this.reply(s, this.deps.onRestart?.() ? { op: "ok" } : { op: "none" });
        return;
      case "pool":
        void runPoolRequest(this.deps.pool, req, { terminal: true }).then(async (r) => {
          if (r.outcome === "delivered") await this.syncPool();
          const { status, ...rest } = r;
          this.reply(s, { op: "pool", ...rest, ...(status ? { status } : {}) });
        });
        return;
      default:
        s.destroy();
    }
  }

  /** A queued turn message that hasn't expired. */
  private takeTurn(l: Live): TurnPending | null {
    while (l.turnQueue.length) {
      const p = l.turnQueue.shift()!;
      if (!this.inflight.has(p.msgId)) continue;
      return p;
    }
    return null;
  }

  private onEvent(e: Extract<LocalRequest, { op: "event" }>): void {
    // A worker that read the aliases a moment before a start recorded its session still
    // names the harness's own id; this daemon knows the start's.
    const named = this.named(e.session);
    const l = this.liveOf(named);
    l.lastEvent = this.deps.now();
    this.recordMode(named, e.mode);
    if (e.cwd) l.cwd = e.cwd;
    if (e.transcript) l.transcript = e.transcript;
    if (CLOSES_ATTENTION.has(e.event) && l.attentions.size) {
      for (const s of l.attentions.values()) this.reply(s, { op: "none" });
      l.attentions.clear();
    }
    if (e.event === "UserPromptSubmit" || e.event === "SessionStart") {
      if (e.event === "UserPromptSubmit") {
        l.midTurn = true;
        // A turn began. Whether it is the turn a written message caused is the next
        // question (`tookIt`); this is only the signal that there is one to look at.
        const waiting = this.prompted.get(named);
        if (typeof waiting === "function") {
          this.prompted.delete(named);
          waiting(true);
        }
      }
      return;
    }
    if (e.event === "Stop" && l.continued) {
      l.continued = false;
      return;
    }
    if (e.event === "SessionEnd") {
      // The session is gone: a message written into its inbox will never be taken, so
      // the lane is not kept shut for a window that has closed.
      this.unpark(named);
      l.ended = this.deps.now();
    }
    if (e.event === "Stop" || e.event === "StopFailure" || e.event === "SessionEnd") {
      // A failed turn and a session's end are told here alone. A Stop was already told by
      // the hook's own question (`stop`, which comes before this event), and is not told
      // twice: an event that arrives late would end the continuation that followed it.
      if (e.event !== "Stop") this.turnEnded(named);
      this.notMidTurn(l);
    }
  }

  /** The session's turn is over. A message queued for a Stop that came and went without
   *  taking it (it arrived after the hook asked, or the turn failed), or for one that
   *  will never come (the turn's process was killed), goes another way. */
  private notMidTurn(l: Live): void {
    l.midTurn = false;
    l.continued = false;
    const left = l.turnQueue.splice(0);
    for (const p of left) if (this.inflight.has(p.msgId)) void this.reroute(p);
  }

  // --- receivers ------------------------------------------------------------------

  private async pollLoop(first: PairedReceiver): Promise<void> {
    const key = first.control + first.machine;
    const st: PollState = {
      started: this.deps.now(),
      last: null,
      error: null,
      on: true,
      unauthorized: false,
      authBackoff: 0,
      wake: null,
    };
    this.polling.set(key, st);
    // Unlike a bare sleep, this wait can end as soon as a hello proves the token
    // works, or the daemon stops. Keep exactly one poll loop per receiver.
    const retry = (ms: number) =>
      new Promise<void>((resolve) => {
        st.on = false;
        if (!this.running) {
          resolve();
          return;
        }
        const timer = setTimeout(() => st.wake?.(), ms);
        timer.unref();
        st.wake = () => {
          clearTimeout(timer);
          st.wake = null;
          resolve();
        };
      });
    let backoff = 0;
    let downSince = 0;
    // A deploy takes the receiver away for seconds, not minutes: retry soon, capped at
    // 15 s (one request per machine), with jitter so every machine a deploy dropped
    // doesn't come back in the same instant. The old 60 s / 5 min steps left a
    // machine blind for minutes after a 30-second outage.
    const steps = [1000, 2000, 5000, 10_000, 15_000];
    const pause = (n: number) => (steps[Math.min(n, steps.length - 1)] as number) * (0.75 + Math.random() * 0.5);
    for (;;) {
      // The current record every round: `control pair` may have added a key since.
      const r = this.cfg.receivers.find((x) => x.control + x.machine === key);
      if (!this.running || !r) break;
      if (this.paused) {
        st.on = false;
        await this.paused.until;
        continue;
      }
      if (!r.token) {
        // Its token lives in a keychain this process can't read yet (locked, or nobody
        // logged in): ask again every 30 s rather than poll with no bearer.
        const t = this.deps.token?.(r) ?? null;
        if (t) {
          r.token = t;
          this.deps.log(`${r.url}: machine token readable again`);
        } else {
          if (!st.error?.startsWith("can't read"))
            this.deps.log(`${r.url}: can't read this machine's token from ${r.token_in ?? "its store"}; retrying`);
          st.error = `can't read this machine's token from ${r.token_in ?? "its store"} (locked?); retrying every 30 s`;
          await retry(30_000);
          continue;
        }
      }
      const ctl = new AbortController();
      st.on = true;
      this.aborts.add(ctl);
      // A poll held past wait + 10 s is a dead connection (a laptop that slept, a
      // network that changed): give up on it and ask again.
      const t = setTimeout(() => ctl.abort(), 35_000);
      try {
        const u = new URL(r.control);
        u.searchParams.set("machine", r.machine);
        u.searchParams.set("wait", "25");
        const asked = this.deps.now();
        const res = await this.deps.fetch(u, { headers: { authorization: `Bearer ${r.token}` }, signal: ctl.signal });
        // The request deadline applies to reading the response, never to a retry
        // delay (which can be much longer than a long-poll).
        if (res.status !== 200) clearTimeout(t);
        st.unauthorized = res.status === 401;
        if (downSince && (res.status === 200 || res.status === 204)) {
          // Timed to when this poll was sent: a long-poll that reconnected is then held
          // up to `wait` before it answers.
          this.deps.log(`${r.url}: back after ${Math.round((asked - downSince) / 1000)} s (${backoff} failed tries)`);
          downSince = 0;
        }
        if (res.status === 401) {
          st.error = "the receiver no longer knows this machine (401); run `sessionpipe control pair` again";
          this.deps.log(`${r.url}: ${st.error}`);
          downSince ||= this.deps.now();
          backoff++;
          const delay = Math.min(60_000 * 2 ** st.authBackoff, 30 * 60_000);
          st.authBackoff = Math.min(st.authBackoff + 1, 5);
          await retry(delay);
          continue;
        }
        if (res.status === 200) {
          let fresh = 0;
          this.receiving++;
          try {
            const body = (await res.json()) as { messages?: Carried[] };
            // Looked up again: a key may have been added while this poll was parked.
            const cur = this.cfg.receivers.find((x) => x.control + x.machine === key) ?? r;
            // Not awaited: a headless turn can run for half an hour, and the next
            // message (for another session, or a permission answer) must not wait
            // behind it. handle() orders what must be ordered (one session's prompts).
            for (const m of body.messages ?? []) {
              if (m && !this.inflight.has(m.id)) fresh++;
              void this.handle(cur, m).catch((e) =>
                this.deps.log(
                  `handle ${String(m?.id).slice(-8)}: ${String(/* v8 ignore next -- handle() rejects with an Error (the ack file) */ (e as Error)?.message || e)}`,
                ),
              );
            }
          } finally {
            this.receiving--;
          }
          clearTimeout(t);
          st.last = this.deps.now();
          st.error = null;
          st.authBackoff = 0;
          backoff = 0;
          // Only messages already in hand (a receiver that ignores `taken`): don't
          // turn the long-poll into a spin.
          if (!fresh) await sleep(2000);
        } else if (res.status === 204) {
          st.last = this.deps.now();
          st.error = null;
          st.authBackoff = 0;
          backoff = 0;
        } else {
          st.error = `HTTP ${res.status}`;
          downSince ||= this.deps.now();
          let delay = pause(backoff++);
          if (res.status === 503) {
            const after = res.headers.get("retry-after");
            const ms = after && /^\d+$/.test(after) ? Number(after) * 1000 : Date.parse(after ?? "") - this.deps.now();
            if (Number.isFinite(ms)) delay = Math.max(delay, ms);
          }
          // Node treats an overflowing timeout as 1 ms; a long Retry-After must
          // not accidentally become a tight loop.
          await retry(Math.min(delay, 2_147_483_647));
        }
      } catch (e) {
        if (!this.running) break;
        // Paused for an update: the abort was ours, not the network's.
        if (this.paused) continue;
        st.error = String((e as Error)?.message || e).slice(0, 120);
        st.unauthorized = false;
        downSince ||= this.deps.now();
        clearTimeout(t);
        await retry(pause(backoff++));
      } finally {
        clearTimeout(t);
        this.aborts.delete(ctl);
      }
    }
    st.on = false;
  }

  private scheduleHello(): void {
    if (this.helloSoon) return;
    this.helloSoon = setTimeout(() => {
      this.helloSoon = null;
      void this.helloAll();
    }, 1500);
    this.helloSoon.unref();
  }

  /** Read each receiver's well-known for its session tools (at start, then with every hello). */
  private async refreshSessionTools(): Promise<void> {
    for (const r of this.cfg.receivers) {
      try {
        const res = await this.deps.fetch(`${r.url.replace(/\/$/, "")}/.well-known/sessionpipe`, {
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) continue;
        const wk = (await res.json()) as { control?: { session_tools?: unknown } };
        const tools = sessionToolsFrom(wk.control?.session_tools);
        const key = r.control + r.machine;
        if (JSON.stringify(tools) !== JSON.stringify(this.sessionTools.get(key) ?? []))
          this.deps.log(
            `${r.url}: sessions it messages may use ${tools.length ? tools.join(", ") : "nothing extra"} without asking`,
          );
        this.sessionTools.set(key, tools);
      } catch {}
    }
  }

  /** A receiver's own MCP servers; an ask or a relay brings none. */
  private allowedFor(r: Caller): string[] {
    return isSink(r) ? [] : (this.sessionTools.get(r.control + r.machine) ?? []);
  }

  private async helloAll(): Promise<void> {
    void this.refreshSessionTools();
    const waiting = [...this.live].filter(([, l]) => l.waiter).map(([k]) => k);
    const harnesses = this.harnesses();
    const modes: DeliveryMode[] = [
      "waiter",
      "turn",
      "resume",
      "fork",
      // A live session's own inbox is Claude Code's; it is checked again, in full, for
      // every message, so this says the lane exists here and nothing more.
      ...(this.deps.claude() ? (["inbox"] as const) : []),
      ...(this.deps.sdk ? (["sdk"] as const) : []),
      // Every ACP agent's turn is acked `api` (§6).
      ...(harnesses.some((h) => acpControl.acpAgent(h)) ? (["api"] as const) : []),
    ];
    const accounts = await this.signedInMarked(this.accounts());
    const start = this.startOptions(harnesses);
    for (const r of this.cfg.receivers) {
      const body = {
        name: this.cfg.name,
        harnesses,
        modes,
        keys: r.keys.map((k) => k.id),
        version: VERSION,
        waiting,
        folders: this.cfg.folders,
        mode: this.cfg.mode,
        ...(accounts.length ? { accounts } : {}),
        // This daemon takes `files` on a start (an older one would start without them).
        files: true,
        // …and on a prompt (CONTROL.md §6 `prompt`): an older daemon refuses those.
        prompt_files: true,
        start,
        // And device keys (CONTROL.md §2): an app offers one only to a machine that says so.
        key_types: [...KEY_TYPES],
        // The account pool, in every hello of a daemon that has one (§2 `pool`).
        ...(this.deps.pool ? { pool: this.deps.pool.helloPool() } : {}),
        // Whether sessions here may ask each other (§13), and that a start or a prompt may
        // carry `reply_to` (§6): a receiver that sees neither treats this daemon as 0.10.
        ask: askOn(this.cfg),
        handoff: true,
      };
      const res = await this.post(r, "/hello", body).catch(() => null);
      const st = this.polling.get(r.control + r.machine);
      if (res?.ok && st?.unauthorized) {
        st.unauthorized = false;
        st.authBackoff = 0;
        st.error = null;
        this.deps.log(`${r.url}: hello accepted; retrying control poll now`);
        st.wake?.();
      }
    }
  }

  private async post(r: PairedReceiver, sub: string, body: unknown): Promise<Response> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15_000);
    try {
      return await this.deps.fetch(`${r.control.replace(/\/$/, "")}${sub}`, {
        method: "POST",
        headers: { authorization: `Bearer ${r.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
    } finally {
      clearTimeout(t);
    }
  }

  // --- acks -----------------------------------------------------------------------

  private finish(r: Caller, id: string, a: Omit<Ack, "receiver" | "id" | "at">, since?: number): void {
    const receiver = isSink(r) ? r.label : r.control + r.machine;
    const ack: Ack = { receiver, id, at: new Date(this.deps.now()).toISOString(), ...a };
    if (ack.reply) ack.reply = redactSecrets(ack.reply).slice(0, MAX_REPLY);
    if (ack.detail) ack.detail = redactSecrets(ack.detail).slice(0, 500);
    if (a.outcome !== "taken") {
      this.inflight.delete(id);
      // A receiver may hand the message over again: it gets this ack back. A sink never does.
      if (!isSink(r)) this.recentAcks.set(id, { ack, at: this.deps.now() });
      this.delivered[a.mode ?? a.outcome] = (this.delivered[a.mode ?? a.outcome] ?? 0) + 1;
      this.deps.log(
        `ack ${id.slice(-8)} ${a.outcome}${a.mode ? ` via ${a.mode}` : ""}${a.code ? ` (${a.code})` : ""}${since ? ` send→${a.outcome} ${this.deps.now() - since} ms` : ""}`,
      );
    }
    if (isSink(r)) {
      const { receiver: _r, ...own } = ack;
      r.ack(own);
      return;
    }
    this.acks.add(ack);
    void this.flushAcks();
    // A handoff: this command's own final ack is out, exactly one; the reply follows into
    // `reply_to` now, and how that goes lives in the events, never in another ack.
    const h = a.outcome === "taken" ? undefined : this.handoffs.get(id);
    if (h) {
      this.handoffs.delete(id);
      void this.relay(h, ack);
    }
  }

  private flushing = false;
  private async flushAcks(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      for (let round = 0; round < 5; round++) {
        const all = this.acks.all();
        if (!all.length) return;
        const left: Ack[] = [];
        for (const r of this.cfg.receivers) {
          const mine = all.filter((a) => a.receiver === r.control + r.machine);
          if (!mine.length) continue;
          const acks = mine.map(({ receiver: _r, ...a }) => a);
          const ok = await this.post(r, "/ack", { acks })
            .then((res) => res.status >= 200 && res.status < 300)
            .catch(() => false);
          if (!ok) left.push(...mine);
        }
        // Acks for a receiver no longer paired are dropped.
        const now = this.acks.all();
        const added = now.slice(all.length);
        this.acks.keep([...left, ...added]);
        if (!left.length && !added.length) return;
        if (left.length) await sleep(2000 * (round + 1));
      }
    } finally {
      this.flushing = false;
    }
  }

  // --- one message ----------------------------------------------------------------

  async handle(r: PairedReceiver, m: Carried): Promise<void> {
    if (!m || typeof m.id !== "string") return;
    if (this.inflight.has(m.id)) return; // redelivered while we work on it
    const prior = this.recentAcks.get(m.id);
    if (prior && this.deps.now() - prior.at < RECENT_ACKS_MS) {
      this.acks.add(prior.ack);
      void this.flushAcks();
      return;
    }
    // In hand from here, before anything is awaited: a redelivery that arrives while
    // this one verifies must not verify too and come back `replay`. Every path below
    // ends in finish(), which lets go of it.
    this.inflight.add(m.id);
    // A start is marked now too, before its verification: messages of one poll are
    // handled side by side, and a prompt queued right behind its start may finish
    // verifying first. Marked unverified, it only ever makes such a prompt wait.
    const starting = startNamed(m.cmd);
    let done = (): void => {};
    if (starting) {
      const mine = new Promise<void>((res) => {
        done = res;
      });
      const before = this.startsPending.get(starting);
      const all = before ? Promise.all([before, mine]).then(() => undefined) : mine;
      this.startsPending.set(starting, all);
      void all.then(() => {
        if (this.startsPending.get(starting) === all) this.startsPending.delete(starting);
      });
    }
    // A prompt takes its place in its session's line now too, for the same reason and one
    // more: the order two messages finish verifying in is not the order they were sent
    // in, and the line is the order they run in (CONTROL.md §6 `prompt`). Held until its
    // delivery is over, or it turns out to have none.
    const named = promptNamed(m.cmd);
    const turn = named ? this.lines.enter(named.session, named.iat) : null;
    try {
      await this.handleVerified(r, m, turn);
    } finally {
      done();
      turn?.leave();
    }
  }

  private async handleVerified(r: PairedReceiver, m: Carried, turn: Turn | null): Promise<void> {
    const sent = Date.parse(m.at) || this.deps.now();
    if (Date.parse(m.expires_at) <= this.deps.now()) return this.finish(r, m.id, { outcome: "expired" });
    const v = await verifyCommand(
      { cmd: m.cmd, csig: m.csig ?? null, grant: m.grant ?? null, confirm: m.confirm ?? null },
      { machine: r.machine, rpId: r.rpId, trusted: r.keys, now: this.deps.now(), seenNonce: this.nonces.seen },
    );
    if (!v.ok) {
      this.deps.log(`refused ${m.id.slice(-8)}: ${v.code} — ${v.why}`);
      return this.finish(r, m.id, { outcome: "refused", code: v.code, detail: v.why });
    }
    const cmd = v.cmd;
    // A device this machine already trusts vouched for a new one (CONTROL.md §2): the
    // signature just verified against an enrolled key, so the new key joins the store.
    if (cmd.kind === "key.add") return this.addKey(r, m.id, cmd, sent);
    // The machine's account pool (CONTROL.md §6 `pool`): no coding session either; the
    // façade decides and the ack says what the pool now is. Nothing of an account but
    // what the asker named reaches the ack.
    if (cmd.kind === "pool") {
      if (POOL_CONFIRM.has(cmd.pool_action as string) && v.via !== "confirm")
        return this.finish(r, m.id, {
          outcome: "refused",
          code: "confirm_required",
          detail: `pool ${cmd.pool_action} needs a fresh confirm, not a day grant`,
        });
      const out = await runPoolRequest(this.deps.pool, poolRequestOf(cmd));
      if (out.outcome === "delivered") await this.syncPool();
      this.deps.log(
        `pool ${String(cmd.pool_action)}: ${out.outcome}${out.outcome === "delivered" ? "" : ` — ${out.detail}`}`,
      );
      return this.finish(
        r,
        m.id,
        {
          outcome: out.outcome,
          ...(out.outcome !== "delivered" && out.code ? { code: out.code } : {}),
          detail: out.detail,
        },
        sent,
      );
    }
    const ref = parseSessionRef(cmd.session)!;
    const kp = kindPath(cmd.kind, ref.harness);
    // A handoff (CONTROL.md §6): the verifier took `reply_to` on a start or a prompt only,
    // as a session ref. Remembered now, so whatever this command's final ack is, the
    // session that asked hears how it went.
    if (cmd.reply_to) this.handoff(r, m.id, cmd, ref.harness, sent);
    if (typeof kp === "object") return this.finish(r, m.id, { outcome: "unsupported", detail: kp.unsupported });
    try {
      if (kp === "start") return await this.startSession(r, m.id, cmd, sent);
      // A Stop for a turn the daemon has in hand: that turn was placed when it was taken,
      // and a start's session may have no transcript to place yet.
      if (kp === "cancel" && this.runFor(this.namesOf(ref))) return await this.cancel(r, m.id, cmd, sent);
      const place = this.place(cmd.session);
      // A session the daemon is still starting may have no transcript (or, for Codex and
      // Antigravity, no name) yet: wait for that start, then place it again. Never a Stop:
      // one that waited for the start to end would find nothing left to stop.
      const starting = kp === "prompt" ? this.startsPending.get(cmd.session) : undefined;
      const forStart = kp !== "cancel" && "refused" in place && (!!starting || this.ownRuns.has(ref.id));
      // No such session, and no start of it to wait for: said now, not when its turn comes.
      if ("refused" in place && !forStart) return this.finish(r, m.id, refusal(place));
      if (forStart) this.finish(r, m.id, { outcome: "taken" });
      const started = async (): Promise<void> => {
        if (!forStart) return;
        await starting;
        await this.serial(ref.id, async () => {});
      };
      const deliver = async (run: OwnRun | null): Promise<void> => {
        // Read again: the start has ended, or the message before this one may have moved
        // the session (a fork).
        const now = this.place(cmd.session);
        if ("refused" in now) return this.finish(r, m.id, refusal(now));
        if (kp === "permission") return this.permission(r, m.id, cmd, sent);
        if (kp === "cancel") return await this.cancel(r, m.id, cmd, sent);
        // A prompt's files are on disk, and listed in its text, before any mode hands it over.
        if (cmd.files) {
          this.finish(r, m.id, { outcome: "taken" });
          const mine = run as OwnRun;
          const text = await this.orStopped(
            mine,
            this.attached(r, m.id, cmd, ref, now.folder, { message: cmd.nonce, signal: mine.ctl.signal }),
          );
          if (text === STOPPED) return this.finish(r, m.id, this.stoppedAck(null), sent);
          if (text === null) return;
          return await this.prompt(r, m.id, { ...cmd, text }, now, sent);
        }
        return await this.prompt(r, m.id, cmd, now, sent);
      };
      // A permission answer and a Stop are not in the session's line: they act now.
      if (kp !== "prompt") {
        await started();
        return await deliver(null);
      }
      // One session's prompts one at a time, in the order they were sent, each routed
      // only once the one before it has landed (a second message to a session the first
      // one forked goes to the copy). Other sessions don't wait. Its place in that line
      // was taken when it arrived (handle()): a verified prompt is one promptNamed() read.
      await (turn as Turn).ready;
      // The wait for the session's start is part of a prompt's turn (a message that came
      // after it, when the start's transcript was already there, stays behind it), and it
      // is not yet a turn in hand: while the session is being started, the start is what
      // a Stop for it stops. In hand first, this message was what a Stop found whenever it
      // got through its checks before its start did, and the start ran on to its end.
      await started();
      // Its turn: in hand from here, and a Stop for its session stops it wherever it is.
      return await this.inHand(m.id, this.namesOf(ref), deliver);
    } catch (e) {
      this.finish(r, m.id, { outcome: "failed", detail: String((e as Error)?.message || e) });
    }
  }

  /** Where the session lives, and whether its folder is allowed — read from the
   *  session's own transcript (Claude Code, Codex), the folder its start recorded, or
   *  the hooks' cwd, never the command. */
  private place(session: string): { refused: string; why: string } | Placed {
    const ref = parseSessionRef(session)!;
    if (ref.harness === "codex" || ref.harness === "antigravity" || acpControl.acpAgent(ref.harness))
      return this.placeDriven(session, ref);
    if (ref.harness === "claude-code") {
      const target = this.state.copies[ref.id]?.id ?? ref.id;
      const dirs = this.deps.claudeDirs();
      // The account the session belongs to, not the first one that has its transcript:
      // one id can be filed in several (CONTROL.md §6, Homes), and the home that holds
      // it open is the one a message is for.
      const home = resolveHome(target, dirs) ?? resolveHome(ref.id, dirs);
      if (!home) return { refused: "no_session", why: `no Claude Code session ${known(ref.id)} on this machine` };
      if ("ambiguous" in home)
        return {
          refused: "ambiguous_home",
          why: `that session is filed in more than one Claude Code account on this machine (${home.ambiguous.join(", ")}) and ${home.live.length ? `more than one of them holds it open (${home.live.join(", ")})` : "none of them holds it open"}, so this machine can't tell which one the message is for`,
        };
      const t = home.transcript;
      const folder = sessionFolder(t);
      const ok = folder && this.allowed(folder);
      if (!ok) return { refused: "folder", why: "that session's folder isn't one this machine allows" };
      return { folder: ok, transcript: t };
    }
    const cwd = this.live.get(session)?.cwd;
    const ok = cwd && this.allowed(cwd);
    if (!ok) return { refused: cwd ? "folder" : "no_session", why: "no allowed folder known for that session" };
    return { folder: ok, transcript: null };
  }

  /** A Codex, Antigravity or ACP-driven session: one the daemon started is its alias
   *  (the harness's id and the start's folder); one the hooks reported is Codex's
   *  rollout (its `session_meta` cwd) or, for the others, the folder its hooks gave. */
  private placeDriven(
    session: string,
    ref: { harness: string; id: string },
  ): { refused: string; why: string } | Placed {
    const a = this.aliasOf(ref.harness, ref.id);
    const target = a?.id ?? ref.id;
    let cwd: string | undefined = a?.cwd || undefined;
    let file: string | null = null;
    if (ref.harness === "codex") {
      file = isUuid(target) ? codexControl.findRollout(target, this.deps.env ?? process.env) : null;
      if (!a && !file) return { refused: "no_session", why: `no Codex session ${known(ref.id)} on this machine` };
      cwd ||= file ? codexControl.codexFacts(file).cwd : undefined;
    } else cwd ||= this.live.get(session)?.cwd || this.factsCwd(ref.harness, ref.id);
    if (!cwd)
      return {
        refused: "no_session",
        why: `no folder known for ${this.label(ref.harness)} session ${known(ref.id)}`,
      };
    const ok = this.allowed(cwd);
    if (!ok) return { refused: "folder", why: "that session's folder isn't one this machine allows" };
    return { folder: ok, transcript: null, target, file };
  }

  /** Keep what a session's own hooks said its permission mode is (CONTROL.md §6, The
   *  session's mode). The latest word wins, and a mode this daemon has no meaning for
   *  is not kept at all.
   *
   *  The compare and the write are one step of this process's own event loop — one
   *  daemon serves a machine, and it is the one holding the socket — so a burst of hook
   *  events cannot interleave a read with a write; and an unchanged mode writes nothing,
   *  which matters because a hook fires for every tool call of every session. */
  private recordMode(session: string, mode: string | undefined): void {
    if (!mode || !claudeControl.CLAUDE_MODES.includes(mode)) return;
    if (this.state.modes[session] === mode) return;
    this.state.modes[session] = mode;
    // Oldest first: a machine that has run thousands of sessions keeps the recent ones.
    const over = Object.keys(this.state.modes).length - MODES_KEPT;
    for (const k of Object.keys(this.state.modes).slice(0, Math.max(0, over))) delete this.state.modes[k];
    this.saveState(`${session.slice(0, 24)}'s permission mode`);
  }

  /** The folder the worker recorded for a session from its hooks (run.ts, facts). */
  private factsCwd(harness: string, id: string): string | undefined {
    try {
      const f = path.join(path.dirname(this.dir), "facts", safeId(harness), `${safeId(id)}.json`);
      const cwd = (JSON.parse(readFileSync(f, "utf8")) as { cwd?: unknown }).cwd;
      return typeof cwd === "string" && path.isAbsolute(cwd) ? cwd : undefined;
    } catch {
      return undefined;
    }
  }

  /** A driven harness, as the person knows it. */
  private label(harness: string): string {
    const agent = acpControl.acpAgent(harness);
    return agent ? agent.label : harness === "codex" ? "Codex" : "Antigravity";
  }

  private aliasOf(harness: string, id: string): Alias | null {
    return this.aliases[`${harness}:${id}`] ?? null;
  }

  /** The harness revealed its own id for a session the command named: from now on that
   *  is where the command's id leads (aliases.ts). Written before anything else reads it. */
  private setAlias(harness: string, id: string, real: string, cwd: string, o: StartOptions | null): void {
    this.aliases = {
      ...this.aliases,
      [`${harness}:${id}`]: { id: real, cwd, at: new Date(this.deps.now()).toISOString(), ...o },
    };
    try {
      writeAliases(aliasFile(this.dir), this.aliases);
    } catch (e) {
      this.deps.log(
        `couldn't record ${harness}:${id.slice(0, 8)} → ${real.slice(0, 8)}: ${String(/* v8 ignore next -- writeAliases throws fs Errors */ (e as Error)?.message || e)}`,
      );
    }
  }

  /** `<harness>:<harness's id>` → `<harness>:<the start's id>` for a session the daemon named. */
  private named(session: string): string {
    const i = session.indexOf(":");
    if (i <= 0) return session;
    const harness = session.slice(0, i);
    const as = receiverIdOf(this.aliases, harness, session.slice(i + 1));
    return as ? `${harness}:${as}` : session;
  }

  private driver(harness: string): Driver | null {
    if (harness === "codex")
      return {
        label: "Codex",
        cmd: "codex",
        bin: () => this.deps.codex?.() ?? null,
        args: ({ cwd, resume, ...o }) => codexControl.codexArgs(resume ? { ...o, resume } : { ...o, cwd }),
        levels: codexControl.offeredLevels,
        defaultLevel: codexControl.defaultLevel,
        models: () => this.deps.codexModels?.() ?? codexControl.codexModels(this.deps.env ?? process.env),
        reading: () => codexControl.reading(),
        ...(this.deps.codexLogin ? { login: this.deps.codexLogin } : {}),
        loginHint: codexControl.LOGIN_HINT,
      };
    /* v8 ignore else -- only a HEADLESS harness gets here (route.ts): Claude Code never asks for a driver */
    if (harness === "antigravity")
      return {
        label: "Antigravity",
        cmd: "agy",
        bin: () => this.deps.agy?.() ?? null,
        args: ({ permission, prompt, resume }) =>
          antigravityControl.agyArgs(resume ? { permission, prompt, resume } : { permission, prompt }),
        levels: antigravityControl.offeredLevels,
        defaultLevel: antigravityControl.defaultLevel,
        reading: () => antigravityControl.reading(),
      };
    /* v8 ignore next -- see above */
    return null;
  }

  /** Who is signed in here, for hello. A bad .claude.json names nobody, never fails a hello. */
  private accounts(): HarnessAccount[] {
    try {
      return this.deps.accounts ? this.deps.accounts() : claudeAccounts(this.deps.claudeDirs());
    } catch {
      return [];
    }
  }

  /** Each Claude Code account's `signed_in` for hello: what `claude auth status` says
   *  for its config dir (the answer a resume would get, cached as `signedIn` caches it),
   *  so a receiver can say "run claude auth login on <machine>" before a message is
   *  sent, not in its failed ack. An account signed in from any of its dirs is signed in;
   *  one the daemon can't ask (no claude, no answer) is left unsaid. A change is logged.
   *  (2026-11-05: sessions in the Claude app sign in through the app, and the command
   *  line the daemon resumes with had no login of its own; the first message found out.) */
  private async signedInMarked(accounts: HarnessAccount[]): Promise<HarnessAccount[]> {
    const login = this.deps.login;
    if (!login || !accounts.length || !this.deps.claude()) return accounts;
    const states = new Map<string, boolean | null>();
    for (const { id, dir } of claudeAccountDirs(this.deps.claudeDirs())) {
      const was = states.get(id);
      if (was === true) continue;
      const is = await this.loginState(dir, () => login(dir));
      if (is !== null || was === undefined) states.set(id, is);
    }
    return accounts.map((a) => {
      const is = a.harness === "claude-code" ? states.get(a.id) : undefined;
      if (is === undefined || is === null) return a;
      const who = a.email ?? a.name ?? a.id;
      if (this.signedInSaid.get(a.id) !== is) {
        this.signedInSaid.set(a.id, is);
        this.deps.log(
          is
            ? `claude is signed in as ${who}`
            : `claude isn't signed in as ${who} as the daemon sees it: a message to a session of that account would fail until \`claude auth login\` is run here`,
        );
      }
      return { ...a, signed_in: is };
    });
  }

  /** One harness account's login as `signedIn` reads it, with the answer itself. */
  private async loginState(key: string, ask: () => Promise<Login>): Promise<boolean | null> {
    const now = this.deps.now();
    const hit = this.logins.get(key);
    let login = hit && now - hit.at < (hit.login.loggedIn === false ? 30_000 : 600_000) ? hit.login : null;
    if (!login) {
      login = await ask().catch((): Login => ({ loggedIn: null }));
      this.logins.set(key, { at: now, login });
    }
    return login.loggedIn;
  }

  /** The harnesses this machine can run a message in, for hello: at most
   *  HELLO_HARNESSES_MAX, the three with their own drivers first. */
  private harnesses(): string[] {
    if (this.deps.harnesses) return this.deps.harnesses().slice(0, HELLO_HARNESSES_MAX);
    const acp = this.deps.acp;
    return [
      ...(this.deps.claude() ? ["claude-code"] : []),
      ...(this.deps.codex?.() ? ["codex"] : []),
      ...(this.deps.agy?.() ? ["antigravity"] : []),
      ...(acp ? acpControl.ACP_HARNESSES.filter((h) => acp(h)) : []),
    ].slice(0, HELLO_HARNESSES_MAX);
  }

  /** The caps a new Claude Code session is started with: the Agent SDK's when the
   *  daemon has it, else what this machine's `claude --help` lists. */
  private startCaps(): Caps | null {
    return this.deps.sdk ? SDK_CAPS : (this.deps.claude()?.caps ?? null);
  }

  /** What a start may carry for one harness here (CONTROL.md §2 `start`), capped by the
   *  machine's mode; null when it takes neither option, or when a start without one
   *  would be refused (an auto machine whose Claude Code has no auto mode). */
  private startEntry(harness: string): StartEntry | null {
    const mode = this.cfg.mode;
    if (harness === "claude-code") {
      const caps = this.startCaps();
      if (!caps) return null;
      const permissions = claudeControl.offeredLevels(mode, caps);
      const permission = claudeControl.defaultLevel(mode);
      return permission === "inherit" || permissions.includes(permission)
        ? { permissions, permission, any_model: true }
        : null;
    }
    if (harness !== "codex" && harness !== "antigravity") return null;
    const drv = this.driver(harness)!;
    const models = drv.models?.() ?? null;
    return {
      permissions: drv.levels(mode),
      permission: drv.defaultLevel(mode),
      ...(models ? { any_model: true, ...(models.length ? { models } : {}) } : {}),
    };
  }

  /** The hello's `start`: an entry for each harness it lists that takes options. */
  private startOptions(harnesses = this.harnesses()): Record<string, StartEntry> {
    const out: Record<string, StartEntry> = {};
    for (const h of harnesses) {
      const e = this.startEntry(h);
      if (e) out[h] = e;
    }
    return out;
  }

  /** The options a start runs with, or the refusal (CONTROL.md §5 step 8): a level the
   *  machine offers for that harness, never above its mode, and a model only where the
   *  harness takes one. Never another level or model than the one asked for. */
  private startChoice(
    harness: string,
    cmd: ControlCommand,
  ): { options: StartOptions } | { code: "permission" | "model"; detail: string } {
    const mode = this.cfg.mode;
    const claude = harness === "claude-code";
    // An ACP agent takes neither option here: it runs as the machine's mode says (§6).
    if (acpControl.acpAgent(harness)) {
      if (cmd.permission !== undefined || cmd.model !== undefined)
        return {
          code: cmd.permission !== undefined ? "permission" : "model",
          detail: `${this.label(harness)} takes no permission level or model choice on this machine`,
        };
      return { options: { permission: mode } };
    }
    const level: RunLevel =
      cmd.permission ?? (claude ? claudeControl.defaultLevel(mode) : this.driver(harness)!.defaultLevel(mode));
    const ask = { permission: level, ...(cmd.model !== undefined ? { model: cmd.model } : {}) };
    // No Claude Code here at all: the start fails on that, in words, a step later.
    if (claude && !this.startCaps()) return { options: ask };
    const entry = this.startEntry(harness);
    // `inherit` is never asked for, only a default: the person chose it at the machine.
    if (level !== "inherit" && !entry?.permissions.includes(level)) {
      if (levelRank(level) > levelRank(claudeControl.ceilingLevel(mode)))
        return {
          code: "permission",
          detail:
            mode === "inherit"
              ? `this machine runs in inherit mode, where a message may only name read or safe; ${level} needs \`sessionpipe control mode auto\` at the machine`
              : `this machine runs in ${mode} mode; ${level} needs \`sessionpipe control mode auto\` at the machine`,
        };
      return { code: "permission", detail: this.levelMissing(harness, level) };
    }
    // Every harness that takes a model here takes any well-formed one (`any_model`); the
    // models it lists are suggestions, so no list here is closed.
    if (cmd.model !== undefined && !entry?.any_model)
      return {
        code: "model",
        detail: `${claude ? /* v8 ignore next -- Claude Code always takes a model */ "Claude Code" : this.driver(harness)!.label} takes no model choice on this machine`,
      };
    return { options: ask };
  }

  /** Why a harness has no such level here, though the machine's mode would allow it. */
  private levelMissing(harness: string, level: StartPermission): string {
    if (harness === "codex") return "Codex has no edits level: its safe level, the workspace sandbox, already edits";
    if (harness === "antigravity")
      return level === "read" ? "Antigravity has no read-only mode" : "Antigravity's widest level is edits";
    // startChoice() returned before this for a Claude Code with no caps at all.
    const mf = claudeControl.modeFlags(level, this.startCaps()!);
    /* v8 ignore next -- only a level its caps lack is ever missing */
    return "error" in mf ? mf.error : `this machine's Claude Code can't start at ${level}`;
  }

  /** The options a later run of a session gets: the narrower of what its start recorded
   *  and what the machine's mode means now, with the recorded model. A session with no
   *  record (the hooks reported it, or it predates 0.10.0) runs at the machine's mode. */
  private laterOptions(harness: string, recorded: StartOptions | null | undefined): StartOptions {
    const mode = this.cfg.mode;
    const now = harness === "claude-code" ? claudeControl.defaultLevel(mode) : this.driver(harness)!.defaultLevel(mode);
    const model = recorded?.model ? { model: recorded.model } : {};
    // No level of its own (none recorded, or the start inherited): the machine's mode now.
    if (!recorded || recorded.permission === "inherit") return { permission: now, ...model };
    // A level of its own, on an inherit machine now: at most what a start there may name.
    const cap = now === "inherit" ? claudeControl.ceilingLevel(mode) : now;
    return { permission: narrower(recorded.permission, cap), ...model };
  }

  /** What the acks carry as `applied`: the model only when one was asked for. */
  private applied(o: StartOptions): StartOptions {
    return { permission: o.permission, ...(o.model ? { model: o.model } : {}) };
  }

  /** A failed run that asked for a model, put down to the model: acked with code `model`. */
  private failedRun(why: string, o: StartOptions): Omit<Ack, "receiver" | "id" | "at"> {
    return { outcome: "failed", ...(o.model && MODEL_FAILURE_RE.test(why) ? { code: "model" } : {}), detail: why };
  }

  /** The real folder a command or a session names, when it is one this machine allows:
   *  absolute, or under this user's home as `~/…` (a start's `cwd` may say either). */
  private allowed(folder: string): string | null {
    const dir = untilde(folder);
    if (!path.isAbsolute(dir)) return null;
    let r: string;
    try {
      r = realpathSync.native(dir);
      if (!statSync(r).isDirectory()) return null;
    } catch {
      return null;
    }
    for (const f of this.cfg.folders) {
      let rf = f;
      try {
        rf = realpathSync.native(f);
      } catch {}
      if (r === rf || r.startsWith(rf.endsWith(path.sep) ? rf : rf + path.sep)) return r;
    }
    return null;
  }

  private permission(r: PairedReceiver, id: string, cmd: ControlCommand, sent: number) {
    const l = this.live.get(cmd.session);
    const hook = l?.attentions.get(cmd.for as string);
    if (!hook) {
      // Nothing is ever auto-allowed: an allow needs a prompt open right now.
      if (cmd.decision === "allow")
        return this.finish(r, id, {
          outcome: "refused",
          code: "no_attention",
          detail: "no permission prompt open for that id",
        });
      this.finish(r, id, { outcome: "expired", detail: "the prompt was already answered or closed" });
      return;
    }
    l!.attentions.delete(cmd.for as string);
    this.reply(hook, {
      op: "decision",
      behavior: cmd.decision as "allow" | "deny",
      ...(cmd.note ? { message: cmd.note } : {}),
      id,
    });
    this.finish(r, id, { outcome: "delivered", mode: "turn" }, sent);
  }

  /** A `cancel` (CONTROL.md §6): stops what is the daemon's own to stop. A session it
   *  holds, through that session's interrupt; a headless turn it is running, by ending
   *  the child process it spawned for it, which is acked once that process is gone. A
   *  turn in any other process is never signalled: the ack says who has the session, so
   *  the person can stop it there. */
  private async cancel(r: PairedReceiver, id: string, cmd: ControlCommand, sent: number): Promise<void> {
    const ref = parseSessionRef(cmd.session)!;
    const held = this.sdkSessions.get(ref.id);
    // The session and, for Claude Code, the copy its messages go to: either may be the
    // one a process holds, and a turn of the daemon's own may be in hand under either.
    const ids = this.namesOf(ref);
    const run = this.runFor(ids);
    const rows = ref.harness === "claude-code" ? ids.flatMap((s) => liveRecords(s, this.deps.claudeDirs())) : [];
    const route = routeCancel({
      harness: ref.harness,
      held: !!held,
      own: !!run,
      open: rows.some((x) => x.kind === "interactive"),
      foreign: rows.find((x) => x.kind !== "interactive")?.pid ?? null,
      midTurn: ids.some((s) => this.midTurnNow(this.live.get(`${ref.harness}:${s}`))),
    });
    if ("outcome" in route) {
      this.deps.log(`${id.slice(-8)}: nothing stopped in ${cmd.session.slice(0, 24)} — ${route.detail}`);
      return this.finish(r, id, route, sent);
    }
    if (route.stop === "held") {
      const s = held as SdkSession;
      await s.interrupt();
      return this.finish(r, id, { outcome: "delivered", mode: s.mode ?? "sdk" }, sent);
    }
    const mine = run as OwnRun;
    // Ending a process takes a moment (ten seconds at most, core's runHeadless): the
    // receiver must not hand the Stop back meanwhile.
    this.finish(r, id, { outcome: "taken" });
    this.deps.log(
      `${id.slice(-8)}: stopping ${mine.id.slice(-8)}, the turn this daemon ${mine.began ? "is running" : "was about to run"} for ${cmd.session.slice(0, 24)}`,
    );
    mine.ctl.abort();
    this.finish(
      r,
      id,
      (await mine.done)
        ? { outcome: "delivered", ...(mine.mode ? { mode: mine.mode } : {}), detail: CANCEL.stopped }
        : { outcome: "expired", detail: CANCEL.finished },
      sent,
    );
  }

  /** The names a session's turns go by on this machine: its own id and, for Claude
   *  Code, the copy its messages go to. A message sent to either runs in the copy, and
   *  a Stop pressed on either page is a Stop for whatever runs there. */
  private namesOf(ref: { harness: string; id: string }): string[] {
    const copy = ref.harness === "claude-code" ? this.state.copies[ref.id]?.id : undefined;
    return copy ? [ref.id, copy] : [ref.id];
  }

  /** The turn a `cancel` for a session ends, among those the daemon has in hand under
   *  any of the session's names (`namesOf`; a turn's own are `OwnRun.sessions`): the one
   *  whose process is running, else the first taken in hand. The running one first: with
   *  a message for the session waiting behind a turn in its copy, the first in hand was
   *  whichever arrived first, and a Stop that picked the waiting one stopped nothing. */
  private runFor(ids: string[]): OwnRun | undefined {
    const mine = this.runs.filter((x) => x.sessions.some((s) => ids.includes(s)));
    return mine.find((x) => x.began) ?? mine[0];
  }

  /** The turn in hand for this message. Every path that delivers one took it in hand
   *  first (`inHand`), so there is one. */
  private runOf(id: string): OwnRun {
    return this.runs.find((x) => x.id === id) as OwnRun;
  }

  /** Take a message's turn in hand for as long as `work` lasts: a Stop for its session,
   *  by any of `sessions` (`namesOf`), stops it from now on, whatever it is doing. */
  private async inHand(id: string, sessions: string[], work: (run: OwnRun) => Promise<void>): Promise<void> {
    const ctl = new AbortController();
    let settle!: (stopped: boolean) => void;
    const done = new Promise<boolean>((res) => {
      settle = res;
    });
    const stoppedSoon = new Promise<typeof STOPPED>((res) => {
      ctl.signal.addEventListener("abort", () => res(STOPPED));
    });
    const run: OwnRun = {
      ctl,
      id,
      sessions: [...sessions],
      mode: null,
      began: false,
      stopped: false,
      stoppedSoon,
      done,
      settle,
    };
    this.runs.push(run);
    try {
      await work(run);
    } finally {
      this.letGo(run);
    }
  }

  /** The turn is over, or its message went to a live session, which is not the daemon's
   *  to stop: a Stop no longer finds it. Doing it again does nothing. */
  private letGo(run: OwnRun): void {
    const i = this.runs.indexOf(run);
    if (i < 0) return;
    this.runs.splice(i, 1);
    run.settle(run.stopped);
  }

  /** `p`, unless the turn is stopped first: then `STOPPED` at once, whatever `p` is still
   *  doing (a login check, a download), and the turn is recorded as stopped. */
  private async orStopped<T>(run: OwnRun, p: Promise<T>): Promise<T | typeof STOPPED> {
    const v = await Promise.race([p, run.stoppedSoon]);
    if (v === STOPPED) run.stopped = true;
    return v;
  }

  /** The final ack of a message whose turn was stopped (CONTROL.md §6 `cancel`): what it
   *  had written, if it ever ran, and that it was cancelled. */
  private stoppedAck(mode: "resume" | "fork" | null, soFar = ""): Omit<Ack, "receiver" | "id" | "at"> {
    return { outcome: "delivered", ...(mode ? { mode } : {}), reply: this.stoppedReply(soFar) };
  }

  /** The session's own hooks say a turn is running, and said something in the last ten
   *  minutes: a session killed mid-turn never sends its Stop. */
  private midTurnNow(l: Live | undefined): boolean {
    return !!l?.midTurn && this.deps.now() - l.lastEvent < 10 * 60_000;
  }

  /** One headless turn as a child process of the daemon's own: in a slot, and stoppable
   *  while it waits for one (CONTROL.md §6 `cancel`), so a Stop that arrives before its
   *  slot does means it never starts. */
  private async ownRun(run: OwnRun, bin: string, args: string[], o: RunOptions): Promise<RunResult> {
    const slotted = this.slot<RunResult>(async () => {
      if (run.ctl.signal.aborted) return { stopped: true };
      run.began = true;
      return this.deps.run(bin, args, { ...o, signal: run.ctl.signal });
    });
    // Stopped while it waits: it is over now, not when a slot comes free, which could be
    // half an hour away. The slot, when its turn comes, is given straight back.
    const res = await Promise.race([
      slotted,
      run.stoppedSoon.then((): RunResult | Promise<RunResult> => (run.began ? slotted : { stopped: true })),
    ]);
    run.stopped = !!res.stopped;
    return res;
  }

  /** A run of the daemon's own in this session is over: its child process has closed,
   *  however it ended. What it wrote was written by a process that is gone (view()), and
   *  the session is not mid-turn, whatever its hooks last said. The child's own
   *  UserPromptSubmit marked it so, and only its Stop, StopFailure or SessionEnd unmarks
   *  it: a child that is killed (a `cancel`, the 30-minute cap, any kill on Windows)
   *  reports none of them, and the next message then waited up to half an hour for a
   *  Stop that was never coming. */
  private runOver(harness: string, id: string): void {
    this.lastEnd.set(id, this.deps.now());
    const l = this.live.get(`${harness}:${id}`);
    if (l) this.notMidTurn(l);
  }

  /** What a turn the person stopped answers with (CONTROL.md §6 `cancel`): the words it
   *  had written, and that it was cancelled — as an ACP agent's cancelled turn does. */
  private stoppedReply(soFar: string): string {
    return soFar ? `${soFar}\n\n${acpControl.CANCELLED_NOTE}` : acpControl.CANCELLED_NOTE;
  }

  /** The permission mode a session's own hooks last reported, or null. Keyed by the
   *  session ref the hooks report under, which for a copy is the copy's own. */
  private modeOf(ref: string): string | null {
    return this.state.modes[ref] ?? null;
  }

  /** The permission class THIS MACHINE would declare to a session in `configDir`
   *  (CONTROL.md §6.3) — never the target's own, which it would then be echoing back,
   *  leaving the receiver's own check with nothing to compare.
   *
   *  `bypass` only where the person set this machine to `inherit`, so nothing here picks
   *  a mode at all, and that account's own default is bypass and is allowed to be. Every
   *  other machine is `prompting`: on `safe` and `auto` the daemon names a mode of its
   *  own for the runs it starts, so it is not a machine that leaves sessions as it finds
   *  them. */
  private machineClass(configDir: string | undefined): inbox.PeerClass {
    if (this.cfg.mode !== "inherit") return "prompting";
    const h = homeSettings(configDir);
    return h.defaultMode === "bypassPermissions" && !h.disableBypass ? "bypass" : "prompting";
  }

  /** What the `inbox` lane found when it looked at this session, BEFORE anything was
   *  written (CONTROL.md §6.3): the one process that holds it and the class to declare,
   *  or why not. `null` means the lane does not apply at all.
   *
   *  EVERY reason not to write belongs here rather than at the write site: a refusal
   *  found here leaves `inbox` out of the ladder, so the message takes the next rung,
   *  while one found after the lane was chosen would end the message. */
  private inboxLook(
    session: string,
    place: Placed,
    o: { iat: number; body: string; id: string },
  ):
    | { rec: LiveRecord; declare: inbox.PeerClass; key: string; cls: inbox.PeerClass | null }
    | { code: string; detail: string }
    | null {
    const ref = parseSessionRef(session);
    if (ref?.harness !== "claude-code" || !place.transcript) return null;
    // Claude Code publishes no local inbox on Windows, so there is nothing here to look
    // at: said before a registry read, a settings read or a `ps`, so a Windows machine
    // pays nothing for a mode it can never use. The writer refuses it too (inbox.ts).
    if ((this.deps.platform ?? process.platform) === "win32")
      return {
        code: "platform",
        detail: "Claude Code publishes no local inbox on Windows, so a message there is delivered by a cold run",
      };
    const target = this.state.copies[ref.id]?.id ?? ref.id;
    // The session this lane would write to, which is the copy where there is one: the
    // hold, the watcher and the confirming row are all ITS (the copy's hooks report
    // under its own id, and `answerFrom` already follows it). Keyed on the command's
    // session instead, a copy's own answer was acked `held` and its words thrown away.
    const key = `claude-code:${target}`;
    // A run of the daemon's own holding it is not a session to write into: the message
    // queues behind that run and resumes it.
    if (this.ownRuns.has(target)) return null;
    // The proof that the session took a message written here is the row its turn begins
    // with, found by the message's mark, and only a whole ULID makes one (core's
    // `messageMark`). A message with none could be written and never told from the
    // person's own next prompt: it was acked `held`, and the lane shut for five minutes,
    // whatever the session did with it.
    if (messageMark(o.id) === null) return { code: "unmarked", detail: UNMARKED };
    const held = this.parkedFor(key);
    if (held)
      return {
        code: "parked",
        detail: `a message sent ${Math.round(this.heldFor(held) / 1000)} s ago is still waiting in that session, so this one is not written in beside it`,
      };
    // An ABSOLUTE age: the verifier admits a command dated up to five minutes ahead
    // (a clock running fast is not an attack), and that would otherwise stretch this
    // window to seven.
    const age = Math.abs(this.deps.now() - o.iat);
    if (age > INBOX_FRESH_MS)
      return {
        code: "stale",
        detail: `a message written into a live session must arrive within ${INBOX_FRESH_MS / 1000} s of being signed, and this one is dated ${Math.round(age / 1000)} s from now`,
      };
    const rec = liveRecord(target, this.deps.claudeDirs());
    const cls = peerClass(this.modeOf(key));
    const why = inbox.vetInbox(rec, {
      sessionClass: cls,
      machineClass: this.machineClass(place.transcript.configDir),
      configDir: place.transcript.configDir,
      platform: this.deps.platform ?? process.platform,
      ...(rec ? { procStart: inbox.procStartOf(rec.pid), token: () => inbox.peerToken(rec) } : {}),
    });
    if (why) return why;
    const r = rec as LiveRecord;
    // The envelope is built and read back before the lane is chosen, so a body it can't
    // carry costs the message a rung rather than its delivery.
    const declare = this.machineClass(place.transcript.configDir);
    if (!inbox.envelope({ fromMode: declare, body: o.body }))
      return { code: "unsendable", detail: "that message can't be put in an envelope this lane can be sure of" };
    return { rec: r, declare, key, cls };
  }

  /** A write into this session's inbox that it has not taken, inside the receiving
   *  inbox's own hold window. Kept in the daemon's state, not in memory: an update
   *  restarts the daemon, and a resend inside the window would otherwise put a second
   *  copy of the person's words in the same inbox (CONTROL.md §6.3). */
  private parkedFor(session: string): Parked | null {
    const p = this.state.parked[session];
    if (!p) return null;
    if (this.heldFor(p) <= HOLD_TTL_MS) return p;
    this.unpark(session);
    return null;
  }

  /** How long ago that message was written. `park` writes the stamp and `readState`
   *  admits only one that parses, so there is no third answer. */
  private heldFor(p: Parked): number {
    return this.deps.now() - Date.parse(p.at);
  }

  private park(session: string, id: string): void {
    this.state.parked[session] = { at: new Date(this.deps.now()).toISOString(), id };
    this.saveState(`the message waiting in ${session.slice(0, 24)}`);
  }

  private unpark(session: string): void {
    // Called for every session that ends, most of which were never written to.
    if (!this.state.parked[session]) return;
    delete this.state.parked[session];
    this.saveState(`that ${session.slice(0, 24)} has taken its message`);
  }

  /** The daemon's own state, written where a restart will read it again. A failure is
   *  logged and nothing else: it costs a record, never a delivery. */
  private saveState(what: string): void {
    try {
      writeState(path.join(this.dir, "state.json"), this.state);
    } catch (e) {
      this.deps.log(
        `couldn't record ${what}: ${String(/* v8 ignore next -- writeState throws fs Errors */ (e as Error)?.message || e)}`,
      );
    }
  }

  /** Resolves true when this session begins a turn of its own within `ms` — the first
   *  half of the proof that a message written to its inbox became a prompt (§6.3). Null
   *  when one message is already waiting on this session's next turn. */
  private awaitPrompted(session: string, ms: number): { ok: Promise<boolean>; cancel: () => void } | null {
    /* v8 ignore next -- the per-session delivery queue admits one at a time; this is the backstop */
    if (this.prompted.has(session)) return null;
    let settle!: (v: boolean) => void;
    const ok = new Promise<boolean>((res) => {
      settle = res;
    });
    this.prompted.set(session, settle);
    const drop = () => {
      if (this.prompted.get(session) === settle) this.prompted.delete(session);
    };
    const t = setTimeout(() => {
      drop();
      settle(false);
    }, ms);
    t.unref?.();
    return {
      ok: ok.then((v) => {
        clearTimeout(t);
        drop();
        return v;
      }),
      cancel: () => {
        clearTimeout(t);
        drop();
        settle(false);
      },
    };
  }

  /** Did the session take the message that was just handed over, or only begin some
   *  other turn? `UserPromptSubmit` says a turn began; it carries no text, so the proof
   *  that it is OUR turn is the row the harness wrote for it — a `user` row whose origin
   *  is a peer (the inbox) or a channel (`sessionpipe channel`), carrying this message's
   *  own mark. Anything else (the person typing in the same second, another local
   *  process's message) means the message is still parked, and the answer to THEIR
   *  prompt must not be sent back as the answer to this one. */
  private async tookIt(
    started: { ok: Promise<boolean> },
    session: string,
    from: { file: string; offset: number } | null,
    mark: string | null,
  ): Promise<boolean> {
    if (!(await started.ok)) return false;
    /* v8 ignore next -- answerFrom is null only off Claude Code, which has no inbox lane */
    if (!from) return true;
    for (let i = 0; i < PEER_ROW_TRIES; i++) {
      const row = firstAsk(from.file, from.offset, mark);
      if (row === "ours") return true;
      if (row !== null) {
        this.deps.log(`${session.slice(0, 24)}: the turn that began was asked for by something else`);
        return false;
      }
      await new Promise<void>((res) => {
        const t = setTimeout(res, PEER_ROW_WAIT_MS);
        t.unref?.();
      });
    }
    this.deps.log(`${session.slice(0, 24)}: a turn began and nothing was written for it yet`);
    return false;
  }

  /** A parked waiter that may take a message now. `sessionpipe wait` always may: the
   *  session asked for it. A channel only while the session is idle, and never one that
   *  already swallowed a message (CONTROL.md §8): Claude Code folds a channel message that
   *  arrives during a turn into that turn as a queued command, which the model need not
   *  answer (on 2.1.314 it didn't), so a running turn takes the message at its Stop. */
  private waiterFits(l: Live | undefined, marked: boolean): boolean {
    if (!l?.waiter || l.waiter.destroyed) return false;
    // …and only a message that can be proven taken: its id goes on the channel's tag, and
    // the tag is what the turn it causes is recognised by (`channelMark`). One whose id
    // makes no mark was handed over, acked `held` whatever the session did, and the
    // channel shut.
    return l.channel === null || (marked && !l.midTurn && !this.mutedChannels.has(l.channel));
  }

  private view(
    session: string,
    place: Placed,
    look?: ReturnType<ControlDaemon["inboxLook"]>,
    /** The message has a mark its turn can be recognised by (`waiterFits`). An ask and a
     *  relay always have: their ids are the daemon's own. */
    marked = true,
  ) {
    const ref = parseSessionRef(session)!;
    const l = this.live.get(session);
    if (ref.harness !== "claude-code") {
      // Codex: a rollout written in the last 90 s by something that isn't known to have
      // finished is a session in use. Antigravity keeps no file that says so: only the
      // daemon's own run (whose messages wait in line behind it) holds one.
      const held: Holder | null =
        !this.ownRuns.has(ref.id) &&
        place.file &&
        recentlyWritten(place.file, this.endedAt(session, ref.id), this.deps.now())
          ? "recent"
          : null;
      return {
        harness: ref.harness,
        sdk: this.sdkSessions.has(ref.id),
        waiter: this.waiterFits(l, marked),
        midTurn: !!l?.midTurn,
        // The inbox is Claude Code's own local socket; no other harness has one.
        inbox: false,
        held,
        known: true,
        canFork: false,
        copied: false,
        api: false,
      };
    }
    const transcript = place.transcript;
    const claude =
      ref.harness === "claude-code"
        ? this.deps.claude()
        : /* v8 ignore next -- every other harness returned above */ null;
    const target = this.state.copies[ref.id]?.id ?? ref.id;
    const t = transcript;
    // The daemon's own run holding it is not "someone else's live process": the message
    // queues behind that run (serial per session) and resumes it.
    const held = !this.ownRuns.has(target) && t ? this.heldBy(target, t) : null;
    return {
      harness: ref.harness,
      sdk: this.sdkSessions.has(ref.id),
      waiter: this.waiterFits(l, marked),
      midTurn: !!l?.midTurn,
      inbox: !!look && "rec" in look,
      held,
      known: !!t,
      canFork: !!claude?.caps.fork,
      installed: !!claude,
      // A message for a session that already has a copy goes to that copy; when the copy
      // is live too the person is told, rather than handed a copy of a copy.
      copied: !!this.state.copies[ref.id],
      api: false,
    };
  }

  /** What holds a Claude Code session's transcript right now, as far as this machine can
   *  tell (CONTROL.md §6, What counts as held), or null: nothing does, and it may be
   *  resumed in place.
   *
   *  A live process in Claude Code's own session registry holds it: a window (`open`) or
   *  another kind of run (`running`). With no row naming it, a transcript written in the
   *  last 90 seconds may still have a writer the registry doesn't show under that id
   *  (`recent`) — unless the write is accounted for: no later than the end of a run of
   *  the daemon's own, or than the session's own end as its hooks reported it. A headless
   *  run someone started at a terminal that exited seven seconds ago is that last case:
   *  it was copied for 90 seconds as "open in a window" (2026-11-10), and is resumed now. */
  private heldBy(target: string, t: Transcript): Holder | null {
    return holderOf(
      liveRecords(target, t.configDir),
      recentlyWritten(t.file, this.endedAt(`claude-code:${target}`, target), this.deps.now()),
    );
  }

  /** The last time a run of this session is known to have finished: one of the daemon's
   *  own (its child process closed), or the session's own end as its hooks reported it. */
  private endedAt(session: string, id: string): number | undefined {
    return Math.max(this.lastEnd.get(id) ?? 0, this.live.get(session)?.ended ?? 0) || undefined;
  }

  private async prompt(
    r: Caller,
    id: string,
    cmd: ControlCommand,
    place: Placed,
    sent: number,
    o: { noInbox?: boolean } = {},
  ): Promise<void> {
    const text = cmd.text as string;
    // An ask (a sink caller) never takes the inbox rung: its cap holds only where the
    // daemon runs the turn, and the inbox needs a receiver's host in its frame.
    const framed = isSink(r) ? "" : `${frameMarked(text, r.url, id)}\n\n${IN_PLACE_ANSWER}`;
    // The ladder is walked once without the inbox first: its look reads a registry, a
    // settings file and a process's start time (a `ps`, on this one thread), and a
    // message that a rung above it takes — a held session, a parked waiter, a running
    // turn — was never going to use it.
    // What a session writes for a message handed to it in place is found by the message's
    // mark, which is made of its id and only of a whole ULID (core's `messageMark`).
    const marked = messageMark(id) !== null;
    const bare = this.view(cmd.session, place, null, marked);
    const first = routePrompt(bare);
    const over = o.noInbox || isSink(r) || ("mode" in first && earlier(first.mode, "inbox"));
    const look = over ? null : this.inboxLook(cmd.session, place, { iat: cmd.iat, body: framed, id });
    const seen = over ? bare : this.view(cmd.session, place, look, marked);
    const route = over ? first : routePrompt(seen);
    // Said before the message's own outcome: why the session was not reached in place is
    // the machine's own business, and it is the same fact whether the rung below it
    // delivered, refused, or wasn't there either.
    if (look && !("rec" in look))
      this.deps.log(`${id.slice(-8)}: not in place via its own inbox (${look.code}: ${look.detail})`);
    if ("unsupported" in route) return this.finish(r, id, { outcome: "unsupported", detail: route.unsupported });
    /* v8 ignore next -- place() already refused a session with no transcript (`known` is never false here) */
    if ("refused" in route) return this.finish(r, id, { outcome: "refused", code: route.refused });
    const ref = parseSessionRef(cmd.session)!;
    switch (route.mode) {
      case "waiter": {
        const l = this.live.get(cmd.session)!;
        const w = l.waiter!;
        const channel = l.channel;
        // A channel pushes the message into the session, and Claude Code acknowledges
        // nothing: the proof is the turn the session begins for it, as for the inbox
        // (§8). Watch before handing it over, or a turn that begins at once is missed.
        const started = channel === null ? null : this.awaitPrompted(cmd.session, inbox.CONFIRM_MS);
        /* v8 ignore next -- one in-place delivery per session at a time (`serial`); this is the backstop */
        if (channel !== null && !started) return this.finish(r, id, PARKED_ACK);
        // Handed to the live session from here: no longer a turn of the daemon's own.
        this.letGo(this.runOf(id));
        l.waiter = null;
        l.channel = null;
        const from = this.answerFrom(cmd.session);
        // A channel names the message on its own tag; a `sessionpipe wait` prints the
        // text, so the text itself has to name it.
        this.reply(w, {
          op: "message",
          text: channel === null ? this.inPlace(r, text, id) : this.framed(r, text, false),
          id,
        });
        this.scheduleHello();
        if (channel !== null && !(await this.tookIt(started!, cmd.session, from, channelMark(id)))) {
          this.mutedChannels.add(channel);
          this.deps.log(
            `${id.slice(-8)}: the channel in ${cmd.session.slice(0, 24)} took it and no turn began for it; that channel takes no more messages`,
          );
          return this.finish(r, id, CHANNEL_HELD_ACK, sent);
        }
        // A waiter may be handed a message while the session is mid-turn: only the turn
        // that reads it is its answer's.
        return this.followAnswer(r, id, "waiter", cmd.session, from, sent, {
          mark: channel === null ? messageMark(id) : channelMark(id),
          end: "marked",
        });
      }
      case "turn": {
        const l = this.liveOf(cmd.session);
        const p: TurnPending = { receiver: r, msgId: id, text, session: cmd.session, queuedAt: sent, iat: cmd.iat };
        this.letGo(this.runOf(id));
        l.turnQueue.push(p);
        // In the order they were sent, whenever each got here: a later poll can bring a
        // message signed before one that is already waiting for this session's Stop.
        l.turnQueue.sort((a, b) => a.iat - b.iat);
        // It waits for the session's Stop: the receiver must not keep handing it back.
        this.finish(r, id, { outcome: "taken" });
        const t = setTimeout(() => {
          if (this.inflight.has(id) && l.turnQueue.includes(p)) {
            l.turnQueue.splice(l.turnQueue.indexOf(p), 1);
            void this.reroute(p);
          }
        }, TURN_FALLBACK_MS);
        t.unref();
        return;
      }
      case "sdk": {
        const s = this.sdkSessions.get(ref.id)!;
        // A session the daemon holds: a Stop is its own interrupt, not the end of a run.
        this.letGo(this.runOf(id));
        this.finish(r, id, { outcome: "taken" });
        const out = await this.sendHeld(ref.id, s, this.framed(r, text, false));
        return this.finish(
          r,
          id,
          out.error
            ? { outcome: "failed", detail: out.error }
            : { outcome: "delivered", mode: s.mode ?? "sdk", reply: out.reply },
          sent,
        );
      }
      case "inbox": {
        const { rec, declare, key } = look as {
          rec: LiveRecord;
          declare: inbox.PeerClass;
          key: string;
          cls: inbox.PeerClass | null;
        };
        // The transcript the message is written into, which is the copy's where there is one.
        const from = this.answerFrom(key);
        // Watch for the session's own next turn BEFORE the write, or a session that
        // begins one in milliseconds would be missed. One watcher per session, so one
        // turn can never confirm two messages: inboxLook keeps the lane shut while
        // another write is unconfirmed, and this is the backstop.
        const started = this.awaitPrompted(key, inbox.CONFIRM_MS);
        /* v8 ignore next 2 -- one in-place delivery per session at a time (`serial`); this is the backstop */
        if (!started) return this.finish(r, id, PARKED_ACK);
        const out = await (this.deps.writeInbox ?? inbox.writeInbox)(rec, {
          body: framed,
          // A receiver's url: prompt() keeps a sink (an ask) off the inbox rung, so this is
          // never a sink here.
          fromName: inbox.senderName((r as PairedReceiver).url),
          // Read again here, not carried from the look: a mode changed between the two
          // (§6.2 calls that the ordinary case) is caught before the socket is opened.
          sessionClass: peerClass(this.modeOf(key)),
          machineClass: declare,
          configDir: rec.configDir,
          platform: this.deps.platform ?? process.platform,
          token: inbox.peerToken(rec),
        });
        if (!("written" in out)) {
          started.cancel();
          // Nothing was written, so the lane simply does not apply (§6.3): the message
          // takes the next rung — a resume, a copy — rather than dying on a lane it
          // never used. The vetting happened a moment ago; what changes here is the
          // session ending between the look and the first byte.
          this.deps.log(`${id.slice(-8)}: the inbox lane refused before writing (${out.code}: ${out.detail})`);
          return this.prompt(r, id, cmd, place, sent, { noInbox: true });
        }
        this.deps.log(`${id.slice(-8)}: into ${key.slice(0, 24)}'s own inbox (${declare}), pid ${rec.pid}`);
        this.letGo(this.runOf(id));
        this.park(key, id);
        if (!(await this.tookIt(started, key, from, messageMark(id))))
          // The bytes went out, and they are not sent again on any lane: the session may
          // be holding the message (its inbox parks one whose class doesn't match, and
          // drops it after five minutes). Say exactly that, and nothing that invites the
          // same words to be sent twice into one place.
          return this.finish(
            r,
            id,
            {
              outcome: "failed",
              code: "held",
              detail:
                "written into the live session on this computer; it didn't begin a turn for it, so it may be holding the message. Nothing was duplicated, and nothing else was tried.",
            },
            sent,
          );
        this.unpark(key);
        return this.followAnswer(r, id, "inbox", key, from, sent, { mark: messageMark(id), end: "marked" });
      }
      case "resume":
        return this.headless(r, id, cmd, place, "resume", sent);
      case "fork":
        // Why a copy and not the session: what holds it (the ladder only gets here for a
        // held session), and why its own inbox was no way in, where that was looked at.
        return this.headless(r, id, cmd, place, "fork", sent, {
          held: seen.held as Holder,
          ...(look && !("rec" in look) ? { inPlace: look.detail } : {}),
        });
      /* v8 ignore next -- no harness has an input API wired yet (view() says api: false) */
      case "api":
        return this.finish(r, id, { outcome: "unsupported", detail: "no input API wired for this harness" });
    }
  }

  /** One message through a held session; one whose process left is let go of, so the
   *  next message reopens the session instead of finding it closed. */
  private async sendHeld(id: string, s: SdkSession, text: string): Promise<{ reply: string; error?: string }> {
    const out = await s.send(text);
    if (s.closed) {
      s.close();
      this.sdkSessions.delete(id);
    }
    return out;
  }

  /** A turn message whose Stop never took it: route again, now that it isn't mid-turn.
   *  In the session's own line, like every other prompt, at the place its signing time
   *  gives it — two messages rerouted at one Stop would otherwise both take an in-place
   *  lane at once, and one turn's answer would be acked as the answer to both. */
  private async reroute(p: TurnPending): Promise<void> {
    await this.inLine(p.session, p.iat, async () => {
      const l = this.liveOf(p.session);
      l.midTurn = false;
      const place = this.place(p.session);
      if ("refused" in place) return this.finish(p.receiver, p.msgId, refusal(place));
      const cmd = { kind: "prompt", session: p.session, text: p.text, iat: p.iat } as ControlCommand;
      this.inflight.delete(p.msgId);
      this.inflight.add(p.msgId);
      await this.inHand(p.msgId, this.namesOf(parseSessionRef(p.session)!), () =>
        this.prompt(p.receiver, p.msgId, cmd, place, p.queuedAt),
      ).catch((e) =>
        this.finish(p.receiver, p.msgId, { outcome: "failed", detail: String((e as Error)?.message || e) }),
      );
    });
  }

  /** A delivery that takes its place in its session's line now (line.ts), runs when its
   *  turn comes and gives the turn up when it is over, however it ends: a message
   *  rerouted from a Stop, an ask, a handoff's relay. A receiver's prompt takes its place
   *  earlier, as it arrives (handle()). */
  private async inLine(session: string, iat: number, task: () => Promise<void>): Promise<void> {
    const turn = this.lines.enter(session, iat);
    try {
      await turn.ready;
      await task();
    } finally {
      turn.leave();
    }
  }

  /** Jobs for one session (and its copy) run one at a time, in order. */
  private serial<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev.then(task, task);
    this.queues.set(
      key,
      next.catch(() => {}),
    );
    return next;
  }

  /** Null when Claude Code is signed in for this account (or can't say); otherwise what
   *  to tell the person. */
  private async loginProblem(configDir?: string): Promise<string | null> {
    const login = this.deps.login;
    if (!login) return null;
    if (await this.signedIn(configDir ?? "", () => login(configDir))) return null;
    this.deps.log(`claude isn't signed in for ${configDir ?? "the default account"} as the daemon sees it`);
    return loginHint(configDir, this.deps.platform ?? process.platform);
  }

  /** One harness account's login, asked at most every 10 minutes (30 s after a no). */
  private async signedIn(key: string, ask: () => Promise<Login>): Promise<boolean> {
    return (await this.loginState(key, ask)) !== false;
  }

  /** Null when a Codex or Antigravity run may go ahead; otherwise what to tell the person. */
  private async drivenProblem(drv: Driver): Promise<{ bin: string } | { failed: string }> {
    const bin = drv.bin();
    if (!bin) return { failed: `${drv.label} isn't installed on this machine` };
    const login = drv.login;
    if (login && !(await this.signedIn(`${drv.cmd}:`, () => login(bin)))) {
      this.deps.log(`${drv.cmd} isn't signed in as the daemon sees it`);
      return {
        failed:
          /* v8 ignore next -- only Codex has a login check, and it has a hint */ drv.loginHint ??
          `${drv.label} isn't signed in on this machine`,
      };
    }
    return { bin };
  }

  /** A Codex or Antigravity session's next message: a headless turn resumed under the
   *  harness's own id, after any run of the daemon's own that holds it. */
  private async resumeDriven(r: Caller, id: string, cmd: ControlCommand, place: Placed, sent: number) {
    const ref = parseSessionRef(cmd.session)!;
    const drv = this.driver(ref.harness)!;
    const run = this.runOf(id);
    run.mode = "resume";
    const ready = await this.orStopped(run, this.drivenProblem(drv));
    if (ready === STOPPED) return this.finish(r, id, this.stoppedAck("resume"), sent);
    if ("failed" in ready) return this.finish(r, id, { outcome: "failed", detail: ready.failed });
    this.finish(r, id, { outcome: "taken" });
    await this.serial(ref.id, async () => {
      // Read again: the start this waited for may have named the session meanwhile.
      const alias = this.aliasOf(ref.harness, ref.id);
      /* v8 ignore next -- placeDriven() always names a target; the last fallback is for the type */
      const target = alias?.id ?? place.target ?? ref.id;
      const recorded = alias ? startOptionsOf(alias) : null;
      const o = this.capped(this.laterOptions(ref.harness, recorded), cmd);
      const args = drv.args({
        permission: o.permission,
        prompt: this.framed(r, cmd.text as string, false),
        cwd: place.folder,
        resume: target,
        ...(o.model ? { model: o.model } : {}),
      });
      this.deps.log(`${id.slice(-8)}: ${drv.cmd} resume ${target.slice(0, 8)} (${o.permission}) in ${place.folder}`);
      await this.drive(
        r,
        id,
        ref,
        drv,
        ready.bin,
        args,
        place.folder,
        sent,
        target,
        o,
        recorded,
        this.childEnv(r, cmd),
      );
    });
  }

  /** Run one Codex or Antigravity turn and ack it: `progress` as its answer grows, then
   *  `delivered` (mode `resume`) with the reply. The moment the harness names the session
   *  — a start's new one, or a fresh one for an id it didn't know — the command's id
   *  becomes its alias, so the next message resumes it. */
  private async drive(
    r: Caller,
    id: string,
    ref: { harness: string; id: string },
    drv: Driver,
    bin: string,
    args: string[],
    cwd: string,
    sent: number,
    asked: string | null,
    o: StartOptions,
    /** What the session's alias records (a start records `o`): kept when it is renamed. */
    record: StartOptions | null,
    /** The child's lineage, when the run is for another session (childEnv()). */
    extra: Record<string, string>,
  ): Promise<void> {
    const stream = this.answerStream(r, id);
    const reading = drv.reading();
    let named: string | null = null;
    const name = () => {
      const s = reading.session;
      if (!s || s === named) return;
      named = s;
      if (s !== asked) this.setAlias(ref.harness, ref.id, s, cwd, record);
    };
    const onLine = (l: string) => {
      if (reading.feed(l)) stream.set(reading.text);
      name();
    };
    const run = this.runOf(id);
    const res = await this.owning(ref.id, () =>
      this.ownRun(run, bin, args, {
        cwd,
        env: { ...jobEnv(this.deps.env), ...extra },
        timeoutMs: JOB_TIMEOUT_MS,
        onLine,
        keep: () => false,
      }),
    );
    // A runner that doesn't stream hands the whole output over at the end.
    if (!reading.lines && res.stdout) for (const l of res.stdout.split("\n")) if (l.trim()) onLine(l);
    stream.close();
    this.runOver(ref.harness, ref.id);
    if (reading.warnings?.length)
      this.deps.log(`${id.slice(-8)}: ${drv.cmd} warned: ${reading.warnings.join(" · ").slice(0, 400)}`);
    // A start stopped before its process began started nothing.
    if (!asked && res.stopped && !run.began) return this.finish(r, id, UNSTARTED_ACK, sent);
    // Stopped on the person's request: what it had said, and that it was cancelled.
    const out = res.stopped ? { reply: this.stoppedReply(reading.text) } : reading.outcome(res);
    if ("failed" in out) return this.finish(r, id, this.failedRun(out.failed, o));
    const moved =
      asked && named && named !== asked
        ? `\n\n(${drv.label} didn't find that session on this machine, so this ran in a new one; later messages continue there.)`
        : "";
    this.finish(
      r,
      id,
      {
        outcome: "delivered",
        mode: "resume",
        reply: out.reply + moved,
        ...(asked ? {} : { applied: this.applied(o) }),
      },
      sent,
    );
  }

  private async headless(
    r: Caller,
    id: string,
    cmd: ControlCommand,
    place: Placed,
    mode: "resume" | "fork",
    sent: number,
    /** A fork: what held the session, and what the inbox lane said when it was asked. */
    why?: { held: Holder; inPlace?: string },
  ): Promise<void> {
    const harness = parseSessionRef(cmd.session)?.harness;
    if (acpControl.acpAgent(harness as string)) {
      // An agent the daemon holds once it is open: a Stop is its `session/cancel`.
      this.letGo(this.runOf(id));
      return this.resumeAcp(r, id, cmd, place, sent);
    }
    if (harness !== "claude-code") return this.resumeDriven(r, id, cmd, place, sent);
    const claude = this.deps.claude();
    if (!claude) return this.finish(r, id, { outcome: "failed", detail: CLAUDE_NOT_FOUND });
    const ref = parseSessionRef(cmd.session)!;
    const dir = place.transcript?.configDir;
    const home = homeSettings(dir);
    // The session's own record (its start's level, narrowed to the machine's mode now).
    const recorded = this.state.started[ref.id];
    const o = this.capped(this.laterOptions("claude-code", recorded), cmd);
    const mf = claudeControl.modeFlags(o.permission, claude.caps);
    if ("error" in mf) return this.finish(r, id, { outcome: "refused", code: "permission", detail: mf.error });
    const run = this.runOf(id);
    run.mode = mode;
    // The login check can take seconds: a Stop meanwhile means the turn never starts.
    const signedOut = await this.orStopped(run, this.loginProblem(dir));
    if (signedOut === STOPPED) return this.finish(r, id, this.stoppedAck(mode), sent);
    if (signedOut) return this.finish(r, id, { outcome: "failed", detail: signedOut });
    if (mode === "fork") {
      const refusal = this.copyLimit();
      if (refusal) return this.finish(r, id, { outcome: "refused", code: "copy_limit", detail: refusal });
    }
    this.finish(r, id, { outcome: "taken" });
    // The session the turn runs in: the copy, where the session's messages go to one.
    // (Read here and not after the wait: only a message for this same session could
    // change it, and those take their turns one at a time.)
    const target = this.state.copies[ref.id]?.id ?? ref.id;
    // One run at a time in a transcript, whichever name the message came under: one
    // for the session and one sent to its copy by the copy's own id both run in the
    // copy, and queued under their own ids they ran in it side by side.
    let entered = false;
    const queued = this.serial(target, async () => {
      // Stopped while it waited for the run before it: acked there and then (below), and
      // it never starts.
      if (run.ctl.signal.aborted) return;
      entered = true;
      // A copy is told it is a copy: its conversation is a replay, the original is
      // elsewhere, and nothing it does there appears in it.
      const body = this.framed(r, cmd.text as string, false) + (why ? `\n\n${copyNote(why.held)}` : "");
      const built = claudeArgs({
        caps: claude.caps,
        level: o.permission,
        prompt: body,
        resume: target,
        fork: mode === "fork",
        allowedTools: this.allowedFor(r),
        ...(o.model ? { model: o.model } : {}),
      });
      /* v8 ignore next -- the same caps and level passed modeFlags above */
      const args = "args" in built ? built.args : [];
      // A narrowing the session itself chose, said again (CONTROL.md §6 `prompt`): a
      // session this daemon started is #138's to decide for, and on a machine that
      // names a mode of its own there is nothing to re-assert. Elsewhere `inherit`
      // means no flag, and on this fleet no flag is the account's default, which is
      // wider than what the person set the session to. Beside `-p`, where modeFlags
      // would have put one; the prompt stays last.
      const narrow =
        recorded || this.cfg.mode !== "inherit" ? null : relaunchMode(this.modeOf(`claude-code:${target}`), home);
      if (narrow) args.splice(1, 0, "--permission-mode", narrow);
      this.deps.log(
        `${id.slice(-8)}: claude -p (${narrow ?? o.permission}) --resume ${target}${mode === "fork" ? " --fork-session" : ""} in ${place.folder}`,
      );
      const stream = this.answerStream(r, id);
      // place() refuses a Claude Code session with no transcript, so there is one.
      const own = (place.transcript as Transcript).file;
      const before = transcriptEnd(own);
      // The session the run says it is, as soon as it says so: a copy stopped before its
      // result line is still a copy on disk, and later messages must find it.
      const said: { session: string | null } = { session: null };
      const res = await this.owning(target, () =>
        this.ownRun(run, claude.bin, args, {
          cwd: place.folder,
          env: {
            ...claudeEnv(dir, this.deps.env),
            // The harness's own contract for copying a session something else still
            // holds: without it the resuming process claims the transcript's pointer,
            // so the COPY's end becomes what the person's next window resumes — and
            // the message re-enters their own conversation without them seeing it.
            ...(mode === "fork"
              ? {
                  CLAUDE_CODE_RESUME_SOURCE_ALIVE: `${target}|${new Date(this.deps.now()).toISOString()}|${target}`,
                }
              : {}),
            ...this.childEnv(r, cmd),
          },
          timeoutMs: JOB_TIMEOUT_MS,
          ...(claude.caps.stream
            ? {
                onLine: (l: string) => {
                  stream.feed(l);
                  if (said.session) return;
                  said.session = initSession(l);
                  // A copy being made has a name now: a Stop for it is a Stop for this run.
                  if (said.session && !run.sessions.includes(said.session)) run.sessions.push(said.session);
                },
              }
            : {}),
        }),
      );
      stream.close();
      // A resume ran in `target`. A copy's run did not: it ran in the copy, whose hooks
      // report under the copy's own id, so its end says nothing about the original —
      // not that the turn the person is in there is over, and not that whatever wrote
      // to its transcript a moment ago has finished. Told that it had, the next message
      // was resumed in place in a session its own hooks said was mid-turn.
      const ranIn = mode === "fork" ? (said.session === target ? null : said.session) : target;
      if (ranIn) this.runOver("claude-code", ranIn);
      // Stopped on the person's request (a `cancel`): what it had said, and that it was
      // cancelled. Its mode is not reported: the turn it would describe never finished.
      // A copy it had named counts only if it is on disk: one stopped before it wrote
      // anything is no session, and recording it would send every later message to
      // resume what isn't there.
      const onDisk = said.session && findTranscript(said.session, this.deps.claudeDirs()) ? said.session : null;
      const out = res.stopped
        ? { reply: this.stoppedReply(stream.soFar), ...(onDisk ? { session: onDisk } : {}) }
        : this.outcome(res);
      if ("failed" in out) return this.finish(r, id, this.failedRun(out.failed, o));
      const ran = isUuid(out.session) ? out.session : target;
      // What the ack says about a copy (CONTROL.md §6 `prompt`): that the answer came
      // from one, and why there is one, as the machine found it.
      const notes: string[] = [];
      if (why && ran !== target) {
        const reason = HELD[why.held]("the session");
        this.state.copies[ref.id] = { id: ran, at: new Date(this.deps.now()).toISOString(), reason, why: why.held };
        this.saveState(`the copy of ${known(ref.id)}`);
        this.runOver("claude-code", ran);
        notes.push(`${COPY_RAN} ${reason}${why.inPlace ? `; it could not be reached in place: ${why.inPlace}` : ""}`);
        this.deps.log(`${id.slice(-8)}: ${notes[0]}`);
      } else if (target !== ref.id) {
        // A later message: it resumed the copy made earlier. A record this version
        // wrote says why that was; an older one's reason is not repeated (store.ts).
        const made = this.state.copies[ref.id];
        notes.push(made?.why ? `${COPY_AGAIN} ${made.reason}` : COPY_AGAIN_BARE);
      }
      this.finish(
        r,
        id,
        {
          outcome: "delivered",
          mode,
          reply: out.reply,
          ...(ran !== ref.id ? { session: `claude-code:${ran}` } : {}),
          ...(mode === "fork" && ran !== target ? { copy_of: `claude-code:${target}` } : {}),
          // A copy's turn is in the COPY's transcript, from its first row: the session
          // the command named gained nothing, and reading its file would say what the
          // person is doing in it rather than what this turn ran in.
          ...this.detailOf([
            ...notes,
            ...(res.stopped
              ? []
              : this.ranNotes(
                  ran === target
                    ? { file: own, from: before, narrow, home }
                    : { file: findTranscript(ran, this.deps.claudeDirs())?.file ?? null, from: 0, narrow, home },
                )),
          ]),
        },
        sent,
      );
    });
    // A Stop that finds this turn still waiting for the run before it ends it now, not
    // when that run is over (which a Stop for this turn does nothing to bring nearer).
    // Once it has its place the run itself is what is stopped (ownRun).
    const ran = queued.then(() => null);
    const waited = await Promise.race([ran, run.stoppedSoon.then(() => (entered ? ran : STOPPED))]);
    if (waited !== STOPPED) return;
    run.stopped = true;
    this.finish(r, id, this.stoppedAck(mode), sent);
  }

  /** What the ack says about the mode a cold run turned out to have (CONTROL.md §6
   *  `prompt`): what the new turn's own row recorded, which is what it ran in rather
   *  than what was asked for — and, on a machine set to auto whose Claude Code has auto
   *  turned off, that the turn ran in Manual mode and what fixes it. */
  private ranNotes(o: {
    /** The transcript the new turn is in: the session's own, or the copy's. */
    file: string | null;
    from: number;
    narrow: string | null;
    home: claudeControl.HomeSettings;
  }): string[] {
    const notes: string[] = [];
    if (this.cfg.mode === "auto" && o.home.disableAutoMode) {
      const say =
        "auto mode is turned off in this machine's Claude Code settings, so the turn ran in Manual mode; `sessionpipe control mode inherit` runs it the way your own sessions here run";
      notes.push(say);
      if (!this.warned.has(say)) {
        this.warned.add(say);
        this.deps.log(say);
      }
    }
    const ran = o.file ? ranInMode(o.file, o.from) : null;
    if (ran) notes.push(`the turn ran in ${ran}${o.narrow ? ", the mode the session itself was in" : ""}`);
    return notes;
  }

  /** An ack's `detail` from what there is to say, or none. */
  private detailOf(notes: string[]): { detail?: string } {
    return notes.length ? { detail: notes.join("; ") } : {};
  }

  /** Why no copy may be made right now, or null. A copy replays a whole conversation, so
   *  the machine caps them itself whatever a receiver sends. */
  private copyLimit(): string | null {
    const cap = this.limits().copiesPerDay;
    const cut = this.deps.now() - 24 * 3600_000;
    const today = Object.values(this.state.copies).filter((c) => (Date.parse(c.at) || 0) > cut).length;
    if (today < cap) return null;
    return cap
      ? `this machine has already made ${today} copies of sessions today, which is its limit; a copy replays a whole conversation, so they are capped here`
      : "this machine doesn't make copies of sessions, and that session couldn't be reached in place";
  }

  private outcome(res: RunResult): { failed: string } | { reply: string; session?: string } {
    if (res.error) return { failed: `couldn't start Claude Code: ${res.error}` };
    if (res.timedOut) return { failed: "Claude Code was still working after 30 minutes, so it was stopped" };
    if (res.tooBig) return { failed: "Claude Code's answer was too large to read" };
    const j = parseResult(res.stdout);
    if (!j) {
      const why = String(res.stderr || "")
        .trim()
        .split("\n")
        .slice(-3)
        .join(" ");
      return {
        failed: `Claude Code exited (${res.signal || `code ${res.code}`}) without an answer${why ? `: ${why}` : ""}`,
      };
    }
    if (j.is_error) return { failed: String(j.result || j.subtype || "Claude Code reported an error") };
    const denials = Array.isArray(j.permission_denials) ? j.permission_denials : [];
    const names = [...new Set(denials.map((d) => d?.tool_name).filter((n): n is string => typeof n === "string"))];
    const tail = deniedNote(names, denials.length);
    const text =
      typeof j.result === "string" && j.result.trim() ? j.result : "(Claude Code finished without a written reply.)";
    return { reply: text + tail, ...(typeof j.session_id === "string" ? { session: j.session_id } : {}) };
  }

  private addKey(r: PairedReceiver, id: string, cmd: ControlCommand, sent: number) {
    const k = cmd.key!;
    const name = typeof cmd.name === "string" ? cmd.name.trim().slice(0, 80) : undefined;
    /* v8 ignore next -- the receiver that handed the message over is in cfg, unless `control off` ran mid-flight */
    const rec = this.cfg.receivers.find((x) => x.control === r.control && x.machine === r.machine) ?? r;
    if (rec.keys.some((x) => x.id === k.id))
      return this.finish(r, id, { outcome: "delivered", detail: "that device was already trusted" }, sent);
    // The whole key, as the verifier checked it (keyUsable): a device key keeps its
    // type, store and uv, so its signatures are verified as a device key's.
    const device = k.type === "device";
    rec.keys.push({
      id: k.id,
      alg: k.alg,
      spki: k.spki,
      ...(device ? { type: k.type, store: k.store, uv: k.uv } : {}),
      ...(name ? { name } : {}),
      added_at: new Date(this.deps.now()).toISOString(),
    });
    try {
      writeControl(this.cfg, this.deps.env);
    } catch (e) {
      rec.keys = rec.keys.filter((x) => x.id !== k.id);
      return this.finish(r, id, {
        outcome: "failed",
        detail: `couldn't save the key: ${String(/* v8 ignore next -- writeControl throws fs Errors */ (e as Error)?.message || e)}`,
      });
    }
    this.deps.log(
      `trusted a new ${device ? "device key (hardware, verified each use)" : "device"}${name ? ` (${name})` : ""} on ${r.url}: ${k.id.slice(0, 12)}…, vouched for by a key it already trusted`,
    );
    this.finish(r, id, { outcome: "delivered", detail: `trusted ${name || "a new device"}` }, sent);
  }

  /** Where the transcript of the session a message is handed to ends right now: its
   *  answer is somewhere after this. That session's OWN transcript — the one whose Stop
   *  hook, waiter or inbox takes the message — and never the copy its other messages go
   *  to: a message handed to a session at its Stop was answered there, while the daemon
   *  read the copy, which said nothing for half an hour or said another message's answer
   *  (2026-11-10). */
  private answerFrom(session: string): { file: string; offset: number } | null {
    const ref = parseSessionRef(session);
    if (ref?.harness !== "claude-code") return null;
    const t = findTranscript(ref.id, this.deps.claudeDirs());
    return t ? { file: t.file, offset: transcriptEnd(t.file) } : null;
  }

  /** The session's own hooks reported the end of a turn: whoever reads an answer from
   *  its transcript hears it (reply.ts decides whether that turn was the answer's). */
  private turnEnded(session: string): void {
    for (const f of this.following.get(session) ?? []) f.turnEnded();
  }

  /** A message as a live session is handed it in place, naming itself (route.ts
   *  `messageMark`): a receiver's in its header, an ask's in its own frame. */
  private inPlace(r: Caller, text: string, id: string): string {
    return isSink(r) ? r.frame(text, false, messageMark(id)) : frameMarked(text, r.url, id);
  }

  /** A message handed to a live session (a waiter, a Stop block, its inbox) is `taken`
   *  now; the session answers in its own turn, which the daemon reads from the transcript
   *  and sends back as the final ack's `reply` — so the person sees the answer where they
   *  asked. The reply is the answer to THIS message or nothing (reply.ts): the ack goes
   *  out when the turn the message caused ends, with what the session wrote for it, and
   *  without a reply when nothing can be put down to it. A turn that doesn't end within
   *  ANSWER_WAIT_MS is acked delivered without one. */
  private followAnswer(
    r: Caller,
    id: string,
    mode: "waiter" | "turn" | "inbox",
    session: string,
    from: { file: string; offset: number } | null,
    sent: number,
    how: { mark: string | null; end: "next" | "marked" },
  ): void {
    this.deps.log(`${id.slice(-8)}: in ${session.slice(0, 24)} via ${mode} ${this.deps.now() - sent} ms after send`);
    this.finish(r, id, { outcome: "taken" });
    // A relay: the message is in the session, which is the whole job; nobody waits on a reply.
    if (isSink(r) && !r.wantsReply) {
      this.finish(r, id, { outcome: "delivered", mode }, sent);
      return;
    }
    // No transcript to read (a harness whose answer the daemon cannot follow).
    if (!from) {
      this.finish(r, id, { outcome: "delivered", mode }, sent);
      return;
    }
    const stream = this.answerStream(r, id);
    const f = follow(from.file, from.offset, {
      ...how,
      timeoutMs: this.deps.answerWaitMs ?? ANSWER_WAIT_MS,
      ...(this.deps.answerGraceMs !== undefined ? { graceMs: this.deps.answerGraceMs } : {}),
      now: this.deps.now,
      onText: (t) => stream.set(t),
    });
    const all = this.following.get(session) ?? new Set<Following>();
    this.following.set(session, all.add(f));
    const settled = (): void => {
      stream.close();
      all.delete(f);
      if (!all.size) this.following.delete(session);
    };
    void f.answer
      .then((answer) => {
        settled();
        if (!answer)
          this.deps.log(
            `${id.slice(-8)}: no answer in ${session.slice(0, 24)} that can be put down to it; acked without one`,
          );
        this.finish(r, id, { outcome: "delivered", mode, ...(answer ? { reply: answer } : {}) }, sent);
      })
      // follow() never rejects: this is the ack itself that could not be written.
      .catch((e) =>
        this.deps.log(
          `${id.slice(-8)}: its final ack could not be recorded: ${String(/* v8 ignore next -- finish() throws fs Errors */ (e as Error)?.message || e)}`,
        ),
      );
  }

  /** The answer so far, sent as a `progress` ack: whole, with a rising seq, at most
   *  one in flight. Fire-and-forget — the final ack carries everything. */
  private answerStream(r: Caller, id: string): AnswerStream {
    return new AnswerStream(async (text, seq) => {
      const reply = redactSecrets(text).slice(0, MAX_REPLY);
      if (isSink(r)) return r.progress(reply, seq);
      await this.post(r, "/ack", {
        acks: [{ id, outcome: "progress", at: new Date(this.deps.now()).toISOString(), seq, reply }],
      });
    });
  }

  /** Mark a session as held by one of the daemon's runs while `fn` runs. */
  private async owning<T>(session: string, fn: () => Promise<T>): Promise<T> {
    this.ownRuns.set(session, (this.ownRuns.get(session) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      /* v8 ignore next -- a session being let go of was always held */
      const n = (this.ownRuns.get(session) ?? 1) - 1;
      if (n > 0) this.ownRuns.set(session, n);
      else this.ownRuns.delete(session);
    }
  }

  private limits() {
    const l = this.cfg.limits ?? {};
    const n = (v: unknown, d: number) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : d);
    return {
      startConcurrent: n(l.start_concurrent, LIMITS.startConcurrent),
      startPerHour: n(l.start_per_hour, LIMITS.startPerHour),
      headless: Math.max(1, n(l.headless, LIMITS.headless)),
      copiesPerDay: n(l.copies_per_day, LIMITS.copiesPerDay),
    };
  }

  /** One headless Claude Code process at a time per slot; the rest wait in order. */
  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    while (this.procs >= this.limits().headless) await new Promise<void>((r) => this.procWaiters.push(r));
    this.procs++;
    try {
      return await fn();
    } finally {
      this.procs--;
      this.procWaiters.shift()?.();
    }
  }

  private async startSession(r: Caller, id: string, cmd: ControlCommand, sent: number): Promise<void> {
    const lim = this.limits();
    const now = this.deps.now();
    this.startTimes = this.startTimes.filter((t) => now - t < 3_600_000);
    if (this.startsRunning >= lim.startConcurrent || this.startTimes.length >= lim.startPerHour) {
      // A limit of none is not a crowd: "already starting 0 new session(s); it starts at
      // most 0 at once" sent the person off to wait for sessions that were not starting.
      const detail =
        !lim.startConcurrent || !lim.startPerHour
          ? "this machine is set to start no new sessions (the start limit in its control config is 0)"
          : this.startsRunning >= lim.startConcurrent
            ? `this machine is already starting ${this.startsRunning} new session(s); it starts at most ${lim.startConcurrent} at once`
            : `this machine started ${this.startTimes.length} new sessions in the last hour, its limit`;
      this.deps.log(`refused ${id.slice(-8)}: start_limit — ${detail}`);
      return this.finish(r, id, { outcome: "refused", code: "start_limit", detail });
    }
    this.startsRunning++;
    this.startTimes.push(now);
    const sid = parseSessionRef(cmd.session)!.id;
    try {
      // On the session's own queue, and held as the daemon's own: a message sent while
      // the start still runs waits for it and resumes the session, never forks it.
      await this.serial(sid, () => this.owning(sid, () => this.startOne(r, id, cmd, sent)));
    } finally {
      this.startsRunning--;
    }
  }

  private async startOne(r: Caller, id: string, cmd: ControlCommand, sent: number): Promise<void> {
    const ref = parseSessionRef(cmd.session)!;
    const cwd = this.allowed(cmd.cwd as string);
    if (!cwd)
      return this.finish(r, id, {
        outcome: "refused",
        code: "folder",
        detail: "that folder isn't one this machine allows",
      });
    // The level and model, checked before anything is taken (CONTROL.md §5 step 8).
    const choice = this.startChoice(ref.harness, cmd);
    if ("code" in choice) {
      this.deps.log(`refused ${id.slice(-8)}: ${choice.code} — ${choice.detail}`);
      return this.finish(r, id, { outcome: "refused", code: choice.code, detail: choice.detail });
    }
    const o = choice.options;
    if (acpControl.acpAgent(ref.harness)) return this.startAcp(r, id, cmd, ref, cwd, sent);
    if (ref.harness !== "claude-code") return this.startDriven(r, id, cmd, ref, cwd, sent, o);
    // Taken in any spelling: on a disk that ignores case, a new session whose id differs
    // from a session's only by case would be written into that session's own file.
    if (findTranscript(ref.id, this.deps.claudeDirs(), { anySpelling: true }) || this.sdkSessions.has(ref.id))
      return this.finish(r, id, {
        outcome: "refused",
        code: "bad_session",
        detail: "that new session's id is already taken",
      });
    const claude = this.deps.sdk ? null : this.deps.claude();
    if (!this.deps.sdk && !claude) return this.finish(r, id, { outcome: "failed", detail: CLAUDE_NOT_FOUND });
    // In hand from here: a Stop for the new session stops its start, wherever it has got to.
    return this.inHand(id, [ref.id], async (run) => {
      run.mode = "resume";
      const signedOut = await this.orStopped(run, this.loginProblem(this.deps.env?.CLAUDE_CONFIG_DIR));
      if (signedOut === STOPPED) return this.finish(r, id, UNSTARTED_ACK, sent);
      if (signedOut) return this.finish(r, id, { outcome: "failed", detail: signedOut });
      // The flags this level needs, checked once more before anything is taken: a run with
      // no permission flag at all is never the fallback (#152).
      if (claude) {
        const mf = claudeControl.modeFlags(o.permission, claude.caps);
        /* v8 ignore next 2 -- startChoice() offered this level from these same caps */
        if ("error" in mf) return this.finish(r, id, { outcome: "refused", code: "permission", detail: mf.error });
      }
      this.recordStart(ref.id, o);
      this.finish(r, id, { outcome: "taken", applied: this.applied(o) });
      const text = await this.orStopped(run, this.attached(r, id, cmd, ref, cwd, { signal: run.ctl.signal }));
      if (text === STOPPED) return this.finish(r, id, UNSTARTED_ACK, sent);
      if (text === null) return;
      if (this.deps.sdk) {
        // A session the daemon will hold: from here a Stop is that session's interrupt.
        this.letGo(run);
        const sdk = this.deps.sdk;
        const extra = this.childEnv(r, cmd);
        const out = await this.slot(async () => {
          const s = sdk.start({
            session: ref.id,
            cwd,
            permission: o.permission,
            ...(o.model ? { model: o.model } : {}),
            allowedTools: this.allowedFor(r),
            ...(Object.keys(extra).length ? { env: extra } : {}),
          });
          this.sdkSessions.set(ref.id, s);
          return s.send(this.framed(r, text, true));
        });
        return this.finish(
          r,
          id,
          out.error
            ? this.failedRun(out.error, o)
            : { outcome: "delivered", mode: "sdk", reply: out.reply, applied: this.applied(o) },
          sent,
        );
      }
      const c = claude!;
      const built = claudeArgs({
        caps: c.caps,
        level: o.permission,
        prompt: this.framed(r, text, true),
        session: ref.id,
        allowedTools: this.allowedFor(r),
        ...(o.model ? { model: o.model } : {}),
      });
      /* v8 ignore next -- startChoice() offered this level from these same caps */
      const args = "args" in built ? built.args : [];
      const stream = this.answerStream(r, id);
      const res = await this.ownRun(run, c.bin, args, {
        cwd,
        env: { ...claudeEnv(undefined, this.deps.env), ...this.childEnv(r, cmd) },
        timeoutMs: JOB_TIMEOUT_MS,
        ...(c.caps.stream ? { onLine: (l: string) => stream.feed(l) } : {}),
      });
      stream.close();
      // The transcript this run just wrote is ours: the next message must not read it as a
      // live session (a fork instead of a resume).
      this.runOver("claude-code", ref.id);
      // Stopped before its process began (it was waiting for a slot): nothing started.
      if (res.stopped && !run.began) return this.finish(r, id, UNSTARTED_ACK, sent);
      const out = res.stopped ? { reply: this.stoppedReply(stream.soFar) } : this.outcome(res);
      if ("failed" in out) return this.finish(r, id, this.failedRun(out.failed, o));
      this.finish(r, id, { outcome: "delivered", mode: "resume", reply: out.reply, applied: this.applied(o) }, sent);
    });
  }

  /** A Claude Code session the daemon starts: what it runs with, for its later runs. */
  private recordStart(session: string, o: StartOptions): void {
    this.state.started[session] = o;
    try {
      writeState(path.join(this.dir, "state.json"), this.state);
    } catch (e) {
      this.deps.log(
        `couldn't record what ${session.slice(0, 8)} runs with: ${String(/* v8 ignore next -- writeState throws fs Errors */ (e as Error)?.message || e)}`,
      );
    }
  }

  /** A new Codex or Antigravity session: the harness picks its id, and the start's id
   *  becomes its name (aliases.ts) as soon as the run says what it picked. */
  private async startDriven(
    r: Caller,
    id: string,
    cmd: ControlCommand,
    ref: { harness: string; id: string },
    cwd: string,
    sent: number,
    o: StartOptions,
  ): Promise<void> {
    const drv = this.driver(ref.harness)!;
    const env = this.deps.env ?? process.env;
    if (
      this.aliasOf(ref.harness, ref.id) ||
      this.live.get(cmd.session)?.cwd ||
      (ref.harness === "codex" && isUuid(ref.id) && codexControl.findRollout(ref.id, env))
    )
      return this.finish(r, id, {
        outcome: "refused",
        code: "bad_session",
        detail: "that new session's id is already taken",
      });
    // In hand from here: a Stop for the new session stops its start, wherever it has got to.
    return this.inHand(id, [ref.id], async (run) => {
      run.mode = "resume";
      const ready = await this.orStopped(run, this.drivenProblem(drv));
      if (ready === STOPPED) return this.finish(r, id, UNSTARTED_ACK, sent);
      if ("failed" in ready) return this.finish(r, id, { outcome: "failed", detail: ready.failed });
      this.finish(r, id, { outcome: "taken", applied: this.applied(o) });
      const text = await this.orStopped(run, this.attached(r, id, cmd, ref, cwd, { signal: run.ctl.signal }));
      if (text === STOPPED) return this.finish(r, id, UNSTARTED_ACK, sent);
      if (text === null) return;
      const args = drv.args({
        permission: o.permission,
        prompt: this.framed(r, text, true),
        cwd,
        ...(o.model ? { model: o.model } : {}),
      });
      this.deps.log(`${id.slice(-8)}: ${drv.cmd} new session for ${known(ref.id)} (${o.permission}) in ${cwd}`);
      await this.drive(r, id, ref, drv, ready.bin, args, cwd, sent, null, o, o, this.childEnv(r, cmd));
    });
  }

  /** A new session of an ACP agent (CONTROL.md §6): the agent's CLI as a child the
   *  daemon keeps, the start's id as the session's name the moment the agent names its
   *  own (aliases.ts), and the first turn through it. Acked `delivered` in `api` mode;
   *  later messages go through the same process while it is held. */
  private async startAcp(
    r: Caller,
    id: string,
    cmd: ControlCommand,
    ref: { harness: string; id: string },
    cwd: string,
    sent: number,
  ): Promise<void> {
    const label = this.label(ref.harness);
    if (this.aliasOf(ref.harness, ref.id) || this.live.get(cmd.session)?.cwd || this.sdkSessions.has(ref.id))
      return this.finish(r, id, {
        outcome: "refused",
        code: "bad_session",
        detail: "that new session's id is already taken",
      });
    const found = this.deps.acp?.(ref.harness) ?? null;
    if (!found) return this.finish(r, id, { outcome: "failed", detail: `${label} isn't installed on this machine` });
    this.finish(r, id, { outcome: "taken" });
    const text = await this.attached(r, id, cmd, ref, cwd);
    if (text === null) return;
    this.deps.log(`${id.slice(-8)}: ${found.bin} new session for ${known(ref.id)} (${this.cfg.mode}) in ${cwd}`);
    const stream = this.answerStream(r, id);
    const out = await this.slot(async () => {
      const opened = await this.openAcp(id, found, cwd, label, stream, { env: this.childEnv(r, cmd) });
      if ("failed" in opened) return { reply: "", error: opened.failed };
      /* v8 ignore next -- unsupported only comes of a session/load, which a start never asks for */
      if ("unsupported" in opened) return { reply: "", error: opened.unsupported };
      this.sdkSessions.set(ref.id, opened.held);
      this.setAlias(ref.harness, ref.id, opened.held.session, cwd, null);
      return this.sendHeld(ref.id, opened.held, this.framed(r, text, true));
    });
    stream.close();
    this.finish(
      r,
      id,
      out.error ? { outcome: "failed", detail: out.error } : { outcome: "delivered", mode: "api", reply: out.reply },
      sent,
    );
  }

  /** The next message for an ACP-driven session no process holds: the agent run again
   *  and the session reopened in it (`session/load`), then held like a new one. Acked
   *  `resume`, as any cold start. An agent that can't reopen one is `unsupported`. */
  private async resumeAcp(r: Caller, id: string, cmd: ControlCommand, place: Placed, sent: number) {
    const ref = parseSessionRef(cmd.session)!;
    const label = this.label(ref.harness);
    const found = this.deps.acp?.(ref.harness) ?? null;
    if (!found) return this.finish(r, id, { outcome: "failed", detail: `${label} isn't installed on this machine` });
    this.finish(r, id, { outcome: "taken" });
    await this.serial(ref.id, async () => {
      /* v8 ignore next -- placeDriven() always names a target; the last fallback is for the type */
      const target = this.aliasOf(ref.harness, ref.id)?.id ?? place.target ?? ref.id;
      this.deps.log(
        `${id.slice(-8)}: ${found.bin} reopens ${target.slice(0, 8)} (${this.cfg.mode}) in ${place.folder}`,
      );
      const stream = this.answerStream(r, id);
      const out = await this.owning(ref.id, () =>
        this.slot(async () => {
          const opened = await this.openAcp(id, found, place.folder, label, stream, {
            load: target,
            env: this.childEnv(r, cmd),
          });
          if ("unsupported" in opened) return { reply: "", unsupported: opened.unsupported };
          if ("failed" in opened) return { reply: "", error: opened.failed };
          this.sdkSessions.set(ref.id, opened.held);
          return this.sendHeld(ref.id, opened.held, this.framed(r, cmd.text as string, false));
        }),
      );
      stream.close();
      if ("unsupported" in out) return this.finish(r, id, { outcome: "unsupported", detail: out.unsupported });
      this.finish(
        r,
        id,
        out.error
          ? { outcome: "failed", detail: out.error }
          : { outcome: "delivered", mode: "resume", reply: out.reply },
        sent,
      );
    });
  }

  private openAcp(
    id: string,
    found: { bin: string; args: string[] },
    cwd: string,
    label: string,
    stream: AnswerStream,
    o: { load?: string; env?: Record<string, string> } = {},
  ): Promise<acpControl.AcpStart> {
    return acpControl.startAcp({
      ...found,
      cwd,
      mode: this.cfg.mode,
      label,
      env: { ...jobEnv(this.deps.env), ...o.env },
      ...(o.load ? { load: o.load } : {}),
      onText: (t) => stream.set(t),
      log: (l) => this.deps.log(`${id.slice(-8)}: ${l}`),
      now: this.deps.now,
    });
  }

  /** A start's or a prompt's text, with its files (CONTROL.md §6) fetched, checked and
   *  written under `cwd` first (a prompt's in a folder of its own, named by its signed
   *  nonce) — every check in §5 passed and the nonce is recorded by now, so the `taken`
   *  ack is out and the download may take its time. Null when a file failed: the command
   *  is acked `failed` with code `file`, nothing is kept, no session starts and no
   *  message is delivered.
   *
   *  Null too, and with nothing said or written, when the command is over before its
   *  files are here: its turn was stopped (`signal`, a `cancel`), which drops the
   *  download, and its one final ack is already out. A download that carried on was
   *  acked a second time when it failed (`failed`, code `file`, after `delivered`), and
   *  when it succeeded wrote its files into the folder of a session that was never
   *  created. */
  private async attached(
    r: Caller,
    id: string,
    cmd: ControlCommand,
    ref: { id: string },
    cwd: string,
    o: { message?: string; signal?: AbortSignal } = {},
  ): Promise<string | null> {
    const text = cmd.text as string;
    if (!cmd.files) return text;
    /* v8 ignore next -- an ask or a relay carries no files; the receiver's token is what fetches them */
    if (isSink(r)) return text;
    const over = (): boolean => !!o.signal?.aborted || !this.inflight.has(id);
    try {
      const got = await fetchFiles(cmd.files, {
        control: r.control,
        token: r.token,
        fetch: this.deps.fetch,
        timeoutMs: this.deps.fileTimeoutMs,
        signal: o.signal,
      });
      if (over()) return null;
      const rel = writeFiles(cwd, ref.id, got, o.message);
      this.deps.log(
        `${id.slice(-8)}: ${got.length} file(s) saved in ${cwd}/.sessionpipe/files/${ref.id}${o.message ? `/${o.message}` : ""}`,
      );
      return withFiles(text, got, rel);
    } catch (e) {
      if (over()) return null;
      // fetchFiles and writeFiles throw nothing but a FileProblem, and its message is the detail.
      const detail = (e as Error).message;
      this.deps.log(`${id.slice(-8)}: file — ${detail}`);
      this.finish(r, id, { outcome: "failed", code: "file", detail });
      return null;
    }
  }

  // --- callers: receivers, askers and relays ------------------------------------------

  /** The text as the session gets it: a receiver's framing (route.ts), or the sink's own. */
  private framed(r: Caller, text: string, first: boolean): string {
    if (isSink(r)) return r.frame(text, first);
    return first ? frameStart(text, r.url) : frame(text, r.url);
  }

  /** What a child run gets in its environment beyond the job's: its lineage, for its
   *  hooks to stamp `delegated_by` (§13). An ask's sink says who asked; a receiver's
   *  command with `reply_to` was asked, as far as the child knows, by that session (§6). */
  private childEnv(r: Caller, cmd: ControlCommand): Record<string, string> {
    if (isSink(r)) return r.env ?? {};
    return cmd.reply_to ? { [DELEGATED_BY_ENV]: cmd.reply_to, SESSIONPIPE_ASK_CHAIN: cmd.reply_to } : {};
  }

  /** An ask's `permission` on a prompt (CONTROL.md §13; an ask always names one, safe
   *  unless it says read) caps the run of the session it names: narrower than the
   *  session's own level, never wider. A receiver's prompt carries none (the verifier
   *  refuses it), so this leaves it alone. */
  private capped(o: StartOptions, cmd: ControlCommand): StartOptions {
    if (!cmd.permission) return o;
    return { ...o, permission: o.permission === "inherit" ? cmd.permission : narrower(o.permission, cmd.permission) };
  }

  /** The agents an ask may start here: the hello's harnesses that run headlessly. */
  private askable(): string[] {
    return this.harnesses().filter((h) => HEADLESS.has(h));
  }

  // --- asking another agent (CONTROL.md §13) ----------------------------------------

  /** A session under the name the daemon itself knows it by: the copy a Claude Code
   *  session's later runs moved to, the id a driven harness picked behind the daemon's
   *  alias — so a Codex session asked under its start's name and asking under its own
   *  rollout id is one session to the depth and loop rules. */
  private realRef(session: string): string {
    const ref = parseSessionRef(session);
    /* v8 ignore next -- every ref here passed askProblem or came from the daemon */
    if (!ref) return session;
    if (ref.harness === "claude-code") return `${ref.harness}:${this.state.copies[ref.id]?.id ?? ref.id}`;
    return `${ref.harness}:${this.aliasOf(ref.harness, ref.id)?.id ?? ref.id}`;
  }

  /** How many asks in hand `from` is already answering: the ask that targets it, the
   *  one that targets that ask's asker, and so on up. Nothing for nobody's session. */
  private askDepth(from: string | null): number {
    let depth = 0;
    const seen = new Set<string>();
    for (let at = from ? this.realRef(from) : null; at && !seen.has(at); ) {
      seen.add(at);
      const above = [...this.asks.values()].find((a) => this.realRef(a.to) === at);
      if (!above) break;
      depth++;
      at = above.from ? this.realRef(above.from) : null;
    }
    return depth;
  }

  /** `sessionpipe ask`: a session on this machine hands a task to another agent and gets
   *  the answer back on this connection. The trust boundary is the socket's, the one
   *  `wait` and the hooks cross (a process of the person's own user); nothing a receiver
   *  sends gets here. Every rule in order, each with its own refusal; then the run goes
   *  down the same start and prompt paths a receiver's command takes, acked to the
   *  socket, and its events go on the asking session. */
  private async onAsk(req: AskRequest, s: net.Socket): Promise<void> {
    const refuse = (code: string, detail: string) => {
      this.deps.log(`ask refused: ${code} — ${detail}`);
      this.reply(s, { op: "refused", code, detail });
    };
    const bad = askProblem(req);
    if (bad) return refuse("bad_fields", bad);
    if (!askOn(this.cfg)) return refuse("ask_off", "asking is off on this machine; `sessionpipe ask on` turns it on");
    const target = req.session ? parseSessionRef(req.session)! : null;
    let session: string;
    let cwd: string;
    if (target) {
      // An existing session: one this machine can deliver a prompt to, in an allowed folder.
      const place = this.place(req.session as string);
      if ("refused" in place) return refuse(place.refused === "folder" ? "folder" : "harness", place.why);
      const route = routePrompt(this.view(req.session as string, place));
      if ("unsupported" in route) return refuse("harness", route.unsupported);
      /* v8 ignore next -- place() refused a session with no transcript already */
      if ("refused" in route) return refuse("harness", "no such session on this machine");
      // An ACP agent runs at the machine's mode, with no level or model of its own (§6).
      if ((req.permission || req.model) && acpControl.acpAgent(target.harness))
        return refuse("bad_fields", `${this.label(target.harness)} takes no permission level or model choice here`);
      session = req.session as string;
      cwd = place.folder;
    } else {
      const askable = this.askable();
      if (!askable.includes(req.harness))
        return refuse(
          "harness",
          `this machine can't start a ${req.harness} session; it can ask ${askable.join(", ") || "no agent"}`,
        );
      const ok = this.allowed(req.cwd);
      if (!ok) return refuse("folder", `${req.cwd} isn't a folder this machine allows (sessionpipe control folders)`);
      session = `${req.harness}:${randomUUID()}`;
      cwd = ok;
    }
    // The depth the caller's chain admits, and the one the daemon counts for itself from
    // the asks it has in hand: a session that cleared its environment is still, to the
    // daemon, the session some ask is waiting on.
    const counted = this.askDepth(req.from ?? null);
    if (req.chain.length >= ASK_DEPTH || counted >= ASK_DEPTH)
      return refuse(
        "depth",
        req.chain.length >= ASK_DEPTH
          ? `an ask goes ${ASK_DEPTH} deep at most: ${req.chain[0]} asked ${req.chain[1]}, which asked this session, which can't ask on`
          : `an ask goes ${ASK_DEPTH} deep at most: ${req.from} is answering an ask nested in another one here, so it can't ask on`,
      );
    const inHand = [...this.asks.values()];
    if (target) {
      const real = this.realRef(session);
      if ([req.from, ...req.chain].some((a) => a && this.realRef(a) === real))
        return refuse("loop", `${session.slice(0, 24)} is waiting on this very ask`);
      // Asked under one name, asking under another, from any environment: a session that
      // is itself waiting on an ask can't be asked — its turn only ends when that answer
      // is back, so a message to it waits for the very thing it would be part of.
      if (inHand.some((a) => a.from && this.realRef(a.from) === real))
        return refuse(
          "loop",
          `${session.slice(0, 24)} is waiting on an ask of its own; it can take this one once that answer is back`,
        );
      const asked = inHand.filter((a) => this.realRef(a.to) === real).length;
      if (asked >= ASKS_IN_HAND)
        return refuse(
          "start_limit",
          `${session.slice(0, 24)} has ${asked} asks waiting on it already; a session takes ${ASKS_IN_HAND} at a time`,
        );
    }
    const asking = req.from ? inHand.filter((a) => a.from === req.from).length : 0;
    if (asking >= ASKS_IN_HAND)
      return refuse(
        "start_limit",
        `${req.from} has ${asking} asks in hand already; a session asks ${ASKS_IN_HAND} at a time`,
      );
    const askId = ulid(this.deps.now());
    const sent = this.deps.now();
    const from = req.from ? parseSessionRef(req.from)! : null;
    const sink = this.askSink(s, req, askId, session, sent, from);
    this.deps.log(
      `ask ${askId.slice(-8)}: ${req.from ?? "a session"} asks ${session.slice(0, 24)}${target ? "" : ` (new, in ${cwd})`}`,
    );
    if (from)
      this.emitDelegation(from, "delegation.started", "ask", {
        ask_id: askId,
        via: "ask",
        harness: parseSessionRef(session)!.harness,
        to: session,
        text: req.text.slice(0, 200),
      });
    this.inflight.add(askId);
    this.asks.set(askId, { from: req.from ?? null, to: session });
    // The level the child runs at (§13): read when the ask says so, else safe, and never
    // wider than the machine's mode. An ask is a model's doing, not the person's, so the
    // machine's own edits or auto never carry over to it. An ACP agent takes no level
    // (§6) and runs as the machine's mode says.
    const level = acpControl.acpAgent(parseSessionRef(session)!.harness)
      ? {}
      : { permission: req.permission ?? narrower("safe", claudeControl.ceilingLevel(this.cfg.mode)) };
    try {
      if (!target) {
        const cmd = {
          kind: "start",
          session,
          cwd,
          text: req.text,
          ...level,
          ...(req.model ? { model: req.model } : {}),
        } as ControlCommand;
        await this.startSession(sink, askId, cmd, sent);
      } else {
        // `permission` on a prompt is the cap a run of the session gets (capped()), safe
        // unless the ask said read; the session keeps its own model. It is in the
        // session's line as a message sent now.
        const cmd = { kind: "prompt", session, text: req.text, iat: sent, ...level } as ControlCommand;
        await this.inLine(session, sent, async () => {
          const now = this.place(session);
          /* v8 ignore next -- placed a moment ago, before the queue; a session doesn't go between */
          if ("refused" in now) return this.finish(sink, askId, refusal(now));
          return this.inHand(askId, this.namesOf(target), () => this.prompt(sink, askId, cmd, now, sent));
        });
      }
    } catch (e) {
      this.finish(sink, askId, {
        outcome: "failed",
        detail: String(/* v8 ignore next -- the runs reject with Errors */ (e as Error)?.message || e),
      });
    }
  }

  /** The asker's end of an ask: the run's acks as the wire replies (local.ts), in order
   *  and exactly one final; the child's environment and framing; the events on the
   *  asking session when it is known. The connection is closed after the final reply. */
  private askSink(
    s: net.Socket,
    req: AskRequest,
    askId: string,
    session: string,
    sent: number,
    from: { harness: string; id: string } | null,
  ): AckSink {
    let asked = false;
    const say = (r: LocalReply) => {
      try {
        s.write(`${JSON.stringify(r)}\n`);
      } catch {}
    };
    const begin = () => {
      if (asked) return;
      asked = true;
      say({ op: "asked", ask_id: askId, session });
    };
    // The child's hooks stamp `delegated_by`, and an ask from inside it carries the chain.
    const chain = [...req.chain, req.from ?? "unknown"].join(",");
    return {
      label: `ask ${askId.slice(-8)}`,
      frame: (text, _first, mark) => frameAsk(text, req.from, mark),
      env: { SESSIONPIPE_ASK_CHAIN: chain, ...(req.from ? { [DELEGATED_BY_ENV]: req.from } : {}) },
      wantsReply: true,
      progress: (text, seq) => {
        begin();
        say({ op: "progress", text, seq });
      },
      ack: (a) => {
        if (a.outcome === "taken") return begin();
        // An answer always follows an `asked`; a run refused before it began sends none.
        if (a.outcome === "delivered") begin();
        this.asks.delete(askId);
        const ms = this.deps.now() - sent;
        const to = a.session ?? session;
        const ok = a.outcome === "delivered";
        /* v8 ignore next -- every refusal and failure finish() sends here names its detail */
        const detail = a.detail ?? a.outcome;
        say(
          ok
            ? { op: "answer", ask_id: askId, session: to, text: a.reply ?? "", ms }
            : a.outcome === "refused"
              ? { op: "refused", code: askCode(a.code), detail }
              : { op: "failed", detail },
        );
        try {
          s.end();
        } catch {}
        if (from)
          this.emitDelegation(from, "delegation.ended", "ask", {
            ask_id: askId,
            to,
            ok,
            ms,
            ...(ok ? { reply: a.reply ?? "" } : { error: detail.slice(0, 200) }),
          });
      },
    };
  }

  // --- handoffs (CONTROL.md §6 `reply_to`) ------------------------------------------

  /** A command with `reply_to`: remembered until its final ack (finish()), and announced
   *  on the session that gets the answer, as an ask is on the session that asked. */
  private handoff(r: PairedReceiver, id: string, cmd: ControlCommand, harness: string, sent: number): void {
    const to = parseSessionRef(cmd.reply_to)!;
    // Only a session this machine can place now: one it knows, in a folder it allows.
    // Anything else is no handoff at all — the command runs and is acked as usual, and
    // nothing is written on a session the machine doesn't know, or won't touch, on a
    // signer's say-so (§6): no outbox, no event.
    const place = this.place(cmd.reply_to as string);
    if ("refused" in place) {
      this.deps.log(
        `${id.slice(-8)}: reply_to ${(cmd.reply_to as string).slice(0, 24)} isn't a session this machine can place (${place.why}); the command runs, nothing is relayed`,
      );
      return;
    }
    const askId = ulid(this.deps.now());
    this.handoffs.set(id, { receiver: r, askId, to, from: cmd.session, sent });
    this.deps.log(`${id.slice(-8)}: a handoff; the reply goes to ${(cmd.reply_to as string).slice(0, 24)}`);
    this.emitDelegation(to, "delegation.started", "handoff", {
      ask_id: askId,
      via: "handoff",
      harness,
      to: cmd.session,
      text: (cmd.text as string).slice(0, 200),
    });
  }

  /** The reply into `reply_to`, once the command's own final ack is out: framed as a
   *  handoff's answer and routed like any message (§6 modes, the folder rule, never a
   *  resume of a live session), acked to a sink that only notes how it went. Then
   *  delegation.ended on `reply_to`, `relayed` saying delivered, unsupported or failed. */
  private async relay(h: Handoff, ack: Ack): Promise<void> {
    const ok = ack.outcome === "delivered";
    const ended = (o: { relayed?: "delivered" | "unsupported" | "failed"; error?: string }) => {
      /* v8 ignore next -- a final ack that isn't delivered names its detail; the one route refusal that wouldn't, prompt() can't reach (place() refused that session already) */
      const why = ack.detail ?? ack.outcome;
      const error = o.error ?? (ok ? undefined : why);
      this.emitDelegation(h.to, "delegation.ended", "handoff", {
        ask_id: h.askId,
        to: ack.session ?? h.from,
        ok,
        ms: this.deps.now() - h.sent,
        ...(ok ? { reply: ack.reply ?? "" } : {}),
        ...(error ? { error: error.slice(0, 200) } : {}),
        ...(o.relayed ? { relayed: o.relayed } : {}),
      });
    };
    if (!ok) return ended({});
    if (!ack.reply) return ended({ relayed: "failed", error: "the session finished its turn without a written reply" });
    // An id of its own, and a whole one: handed to a session in place it is what the
    // session's transcript is searched for (a channel puts it on its tag), and only a
    // ULID makes a mark (core's `messageMark`). `relay:<the handoff's id>` made none.
    const id = ulid(this.deps.now());
    const sink: AckSink = {
      label: `relay ${h.askId.slice(-8)}`,
      frame: (text) => text,
      wantsReply: false,
      progress: () => {},
      ack: (a) => {
        if (a.outcome === "taken") return;
        if (a.outcome === "delivered") return ended({ relayed: "delivered" });
        // No mode fits, or the folder isn't allowed: unsupported (§6); anything else failed.
        const unsupported = a.outcome === "unsupported" || (a.outcome === "refused" && a.code === "folder");
        ended({
          relayed: unsupported ? "unsupported" : "failed",
          error: /* v8 ignore next -- as in ended(): every ack here names its detail */ a.detail ?? a.outcome,
        });
      },
    };
    const session = `${h.to.harness}:${h.to.id}`;
    const answered = parseSessionRef(ack.session ?? h.from)!;
    const relayed = this.deps.now();
    const cmd = {
      kind: "prompt",
      session,
      text: frameHandoff(answered, h.receiver.url, ack.reply),
      iat: relayed,
    } as ControlCommand;
    this.inflight.add(id);
    this.deps.log(`${id.slice(-8)}: the reply of ${ack.id.slice(-8)} goes to ${session.slice(0, 24)}`);
    try {
      await this.inLine(session, relayed, async () => {
        const place = this.place(session);
        if ("refused" in place) return this.finish(sink, id, refusal(place));
        return this.inHand(id, this.namesOf(h.to), () => this.prompt(sink, id, cmd, place, this.deps.now()));
      });
    } catch (e) {
      this.finish(sink, id, {
        outcome: "failed",
        detail: String(/* v8 ignore next -- the runs reject with Errors */ (e as Error)?.message || e),
      });
    }
  }

  // --- events of the daemon's own ---------------------------------------------------

  /** delegation.started / delegation.ended (PROTOCOL.md §4) on a session here, the way a
   *  hook's events travel (run.ts runJob): the session block the worker last saved, a seq
   *  of its own from the outbox under the session's lock, redacted at rest, then every
   *  sink drained from its cursor. Best effort: a lock that stays taken or a disk that
   *  won't write is logged, never a reason to hold the ask or the relay. */
  private emitDelegation(
    on: { harness: string; id: string },
    type: "delegation.started" | "delegation.ended",
    via: "ask" | "handoff",
    data: Record<string, unknown>,
  ): void {
    void this.record(on, type, via, data).catch((e) =>
      this.deps.log(
        `couldn't record ${type} on ${on.harness}:${on.id.slice(0, 8)}: ${String(/* v8 ignore next -- record() throws Errors (its own, the fs's) */ (e as Error)?.message || e)}`,
      ),
    );
  }

  private async record(
    on: { harness: string; id: string },
    type: string,
    via: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const state = path.dirname(this.dir);
    const ref = { harness: on.harness, session: on.id };
    // A worker holds the session's lock for the milliseconds its append takes.
    let release = takeLock(state, ref);
    for (let i = 0; !release && i < 40; i++) {
      await sleep(50);
      release = takeLock(state, ref);
    }
    if (!release) throw new Error("the session's outbox stayed locked");
    const cfg = readConfig(configFile(this.deps.env));
    const outbox = new Outbox(state);
    try {
      const known = (factsState(state).get(on.harness, on.id).session as Partial<Session> | undefined) ?? {};
      const e = makeEvent(
        { type, harnessEvent: via, data },
        {
          harness: { name: on.harness },
          session: {
            ...known,
            ...(known.cwd ? { cwd: tilde(known.cwd) } : {}),
            id: on.id,
            seq: outbox.nextSeq(ref),
            machine: machineName(cfg, os.hostname()),
          },
          now: this.deps.now(),
        },
      );
      outbox.append(ref, [{ ...e, session: redactDeep(e.session), data: redactDeep(e.data) }]);
    } finally {
      release();
    }
    await drain(state, cfg.sinks, outbox, ref);
  }

  private closeIdleSdk(): void {
    const idle = this.deps.sdkIdleMs ?? 10 * 60_000;
    for (const [id, s] of this.sdkSessions)
      if (!s.busy && this.deps.now() - s.lastUsed > idle) {
        s.close();
        this.sdkSessions.delete(id);
        this.deps.log(
          `sdk session ${id.slice(0, 8)} closed after ${Math.round(idle / 60_000)} min idle (it resumes on the next message)`,
        );
      }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms).unref?.());

/** dev:ino of the file at `p`, or null when there is none. */
function socketId(p: string): string | null {
  try {
    const st = statSync(p);
    return `${st.dev}:${st.ino}`;
  } catch {
    return null;
  }
}
