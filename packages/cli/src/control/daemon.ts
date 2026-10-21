// SPDX-License-Identifier: Apache-2.0
// The control daemon (spec/CONTROL.md): one process per computer. It holds one
// long-poll per paired receiver, verifies every command itself against the keys
// enrolled at this terminal, and delivers each one the cheapest way the session
// allows — to a parked waiter, at the session's next Stop, to a session it holds
// through the Agent SDK, or by a headless resume or fork — then acks how. Claude Code,
// Codex (`codex exec`) and Antigravity (`agy`) sessions can be resumed and started
// headlessly; the Agent SDK, waiters, Stop blocks and forks are Claude Code's.
//
// A receiver can queue a message; it can never make this process run one.
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  antigravityControl,
  claudeAccounts,
  claudeControl,
  codexControl,
  deniedNote,
  type HarnessAccount,
  JOB_TIMEOUT_MS,
  jobEnv,
  type Login,
  type Reading,
  type RunOptions,
  type RunResult,
  redactSecrets,
  safeId,
  shortId,
} from "@sessionpipe/core";
import { type ControlCommand, parseSessionRef, verifyCommand } from "@sessionpipe/core/control";
import { type Alias, type Aliases, aliasFile, readAliases, receiverIdOf, writeAliases } from "./aliases.js";
import { fetchFiles, withFiles, writeFiles } from "./files.js";
import { ask, type LocalReply, type LocalRequest } from "./local.js";
import { awaitAnswer, transcriptEnd } from "./reply.js";
import { type DeliveryMode, frame, frameStart, IN_PLACE_ANSWER, kindPath, routePrompt } from "./route.js";
import {
  type Ack,
  AckOutbox,
  type ControlConfig,
  type DaemonState,
  NonceStore,
  type PairedReceiver,
  readState,
  writeControl,
  writeState,
} from "./store.js";
import { AnswerStream } from "./stream.js";

const {
  claudeEnv,
  findTranscript,
  isUuid,
  liveProcess,
  loginHint,
  modeFlags,
  parseResult,
  recentlyWritten,
  sessionFolder,
} = claudeControl;
type Caps = claudeControl.Caps;
type Transcript = claudeControl.Transcript;

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
  args: (o: { mode: "safe" | "auto"; prompt: string; cwd: string; resume?: string }) => string[];
  reading: () => Reading & { warnings?: string[] };
  login?: (bin: string) => Promise<Login>;
  loginHint?: string;
}

/** A start, read from the command before it is verified: only ever used to order a
 *  prompt behind it, never to run anything. */
function startNamed(cmd: unknown): string | null {
  if (typeof cmd !== "string" || cmd.length > 64 * 1024 || !cmd.includes('"start"')) return null;
  try {
    const c = JSON.parse(cmd) as { kind?: unknown; session?: unknown };
    return c?.kind === "start" && typeof c.session === "string" ? c.session : null;
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

/** A session the Agent SDK holds for the daemon (sdk.ts; a fake in tests). */
export interface SdkSession {
  /** Deliver one message; resolves with the agent's reply when the turn ends. */
  send(text: string): Promise<{ reply: string; error?: string }>;
  interrupt(): Promise<void>;
  close(): void;
  readonly busy: boolean;
  readonly lastUsed: number;
}
export interface SdkHost {
  start(o: {
    session: string;
    cwd: string;
    mode: "safe" | "auto";
    configDir?: string;
    allowedTools?: string[];
  }): SdkSession;
}

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
  /** The harnesses every hello advertises (core's drivableHarnesses); by default, the
   *  ones the finders above find. */
  harnesses?: () => string[];
  /** The harness accounts every hello names; by default, those signed in across
   *  `claudeDirs`, read again for each hello. */
  accounts?: () => HarnessAccount[];
  run: (bin: string, args: string[], o: RunOptions) => Promise<RunResult>;
  sdk?: SdkHost | null;
  /** How long to follow a live session's turn for an in-place answer (tests shorten it). */
  answerWaitMs?: number;
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
}

/** Another daemon already answers on the socket: this one must not start. */
export class DaemonRunning extends Error {
  constructor(readonly other: { pid?: number; version?: string }) {
    super(
      `another control daemon already serves this machine (${other.pid ? `pid ${other.pid}, ` : ""}sessionpipe ${other.version ?? "?"})`,
    );
  }
}

interface TurnPending {
  receiver: PairedReceiver;
  msgId: string;
  text: string;
  session: string;
  queuedAt: number;
}

interface Live {
  midTurn: boolean;
  /** The Stop hook just delivered a block: the next Stop event continues the turn. */
  continued: boolean;
  waiter: net.Socket | null;
  turnQueue: TurnPending[];
  attentions: Map<string, net.Socket>;
  cwd?: string;
  transcript?: string;
  lastEvent: number;
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
  /** Null when the daemon could restart now (nothing in hand); otherwise what it holds. */
  busy: string | null;
  update?: unknown;
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

export const LIMITS = { startConcurrent: 2, startPerHour: 10, headless: 3 } as const;

export class ControlDaemon {
  private server: net.Server | null = null;
  private readonly live = new Map<string, Live>();
  private readonly sdkSessions = new Map<string, SdkSession>();
  private readonly nonces: NonceStore;
  private readonly acks: AckOutbox;
  private readonly recentAcks = new Map<string, { ack: Ack; at: number }>();
  private readonly inflight = new Set<string>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly lastEnd = new Map<string, number>();
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
  private startsRunning = 0;
  private startTimes: number[] = [];
  private procs = 0;
  private readonly procWaiters: (() => void)[] = [];
  /** configDir → the last login answer and when (a yes is kept 10 minutes, a no 30 s). */
  private readonly logins = new Map<string, { at: number; login: Login }>();
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

  constructor(
    private cfg: ControlConfig,
    private readonly dir: string,
    private readonly sock: string,
    private readonly deps: DaemonDeps,
  ) {
    this.nonces = new NonceStore(path.join(dir, "nonces.jsonl"), deps.now);
    this.acks = new AckOutbox(path.join(dir, "acks.jsonl"));
    this.state = readState(path.join(dir, "state.json"));
    this.aliases = readAliases(aliasFile(dir));
  }

  // --- lifecycle ------------------------------------------------------------------

  async start(): Promise<void> {
    this.running = true;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    await this.listen();
    for (const r of this.cfg.receivers) void this.pollLoop(r);
    this.helloTimer = setInterval(() => void this.helloAll(), HELLO_EVERY_MS);
    this.helloTimer.unref();
    void this.helloAll();
    void this.flushAcks();
    const idle = setInterval(() => this.closeIdleSdk(), 60_000);
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
  }

  /** Null when nothing is in hand, so a restart would interrupt nothing; otherwise what
   *  is. Parked waiters don't count: a waiter reconnects in silence (CONTROL.md §8). A
   *  session someone is working in mid-turn does (a restart forgets it is mid-turn, so a
   *  message to it would fork rather than wait for its Stop), unless it has been silent
   *  for ten minutes: a session killed mid-turn never sends its Stop. */
  busy(): string | null {
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
    const told = JSON.stringify([this.cfg.folders, this.cfg.mode, this.cfg.name]);
    this.cfg = cfg;
    for (const r of cfg.receivers) if (!known.has(r.control + r.machine)) void this.pollLoop(r);
    // `control folders`, `control mode` or a `--rename-machine` changed what a hello says:
    // say it now, so the receiver doesn't wait up to ten minutes for the next one.
    if (this.running && JSON.stringify([cfg.folders, cfg.mode, cfg.name]) !== told) void this.helloAll();
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
      busy: this.busy(),
      ...(this.deps.updateStatus ? { update: this.deps.updateStatus() } : {}),
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
        s.on("close", () => {
          if (l.waiter === s) {
            l.waiter = null;
            this.scheduleHello();
          }
        });
        this.scheduleHello();
        return;
      }
      case "stop": {
        const l = this.liveOf(req.session);
        l.lastEvent = this.deps.now();
        const p = this.takeTurn(l);
        if (!p) {
          this.reply(s, { op: "none" });
          return;
        }
        l.continued = true;
        const from = this.answerFrom(req.session);
        this.reply(s, { op: "block", reason: `${frame(p.text, p.receiver.url)}\n\n${IN_PLACE_ANSWER}`, id: p.msgId });
        this.followAnswer(p.receiver, p.msgId, "turn", req.session, from, p.queuedAt);
        return;
      }
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
    const l = this.liveOf(this.named(e.session));
    l.lastEvent = this.deps.now();
    if (e.cwd) l.cwd = e.cwd;
    if (e.transcript) l.transcript = e.transcript;
    if (CLOSES_ATTENTION.has(e.event) && l.attentions.size) {
      for (const s of l.attentions.values()) this.reply(s, { op: "none" });
      l.attentions.clear();
    }
    if (e.event === "UserPromptSubmit" || e.event === "SessionStart") {
      if (e.event === "UserPromptSubmit") l.midTurn = true;
      return;
    }
    if (e.event === "Stop" && l.continued) {
      l.continued = false;
      return;
    }
    if (e.event === "Stop" || e.event === "StopFailure" || e.event === "SessionEnd") {
      l.midTurn = false;
      l.continued = false;
      // A message queued for a Stop that came and went without taking it (it
      // arrived after the hook asked, or the turn failed) goes another way.
      const left = l.turnQueue.splice(0);
      for (const p of left) if (this.inflight.has(p.msgId)) void this.reroute(p);
    }
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

  private allowedFor(r: PairedReceiver): string[] {
    return this.sessionTools.get(r.control + r.machine) ?? [];
  }

  private async helloAll(): Promise<void> {
    void this.refreshSessionTools();
    const waiting = [...this.live].filter(([, l]) => l.waiter).map(([k]) => k);
    const modes: DeliveryMode[] = ["waiter", "turn", "resume", "fork", ...(this.deps.sdk ? (["sdk"] as const) : [])];
    const harnesses = this.harnesses();
    const accounts = this.accounts();
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

  private finish(r: PairedReceiver, id: string, a: Omit<Ack, "receiver" | "id" | "at">, since?: number): void {
    const ack: Ack = { receiver: r.control + r.machine, id, at: new Date(this.deps.now()).toISOString(), ...a };
    if (ack.reply) ack.reply = redactSecrets(ack.reply).slice(0, MAX_REPLY);
    if (ack.detail) ack.detail = redactSecrets(ack.detail).slice(0, 500);
    if (a.outcome !== "taken") {
      this.inflight.delete(id);
      this.recentAcks.set(id, { ack, at: this.deps.now() });
      this.delivered[a.mode ?? a.outcome] = (this.delivered[a.mode ?? a.outcome] ?? 0) + 1;
      this.deps.log(
        `ack ${id.slice(-8)} ${a.outcome}${a.mode ? ` via ${a.mode}` : ""}${a.code ? ` (${a.code})` : ""}${since ? ` send→${a.outcome} ${this.deps.now() - since} ms` : ""}`,
      );
    }
    this.acks.add(ack);
    void this.flushAcks();
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
    try {
      await this.handleVerified(r, m);
    } finally {
      done();
    }
  }

  private async handleVerified(r: PairedReceiver, m: Carried): Promise<void> {
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
    const ref = parseSessionRef(cmd.session)!;
    const kp = kindPath(cmd.kind, ref.harness);
    if (typeof kp === "object") return this.finish(r, m.id, { outcome: "unsupported", detail: kp.unsupported });
    try {
      if (kp === "start") return await this.startSession(r, m.id, cmd, sent);
      let place = this.place(cmd.session);
      // A session the daemon is still starting may have no transcript (or, for Codex and
      // Antigravity, no name) yet: wait for that start, then place it again.
      const starting = kp === "prompt" ? this.startsPending.get(cmd.session) : undefined;
      if ("refused" in place && (starting || this.ownRuns.has(ref.id))) {
        this.finish(r, m.id, { outcome: "taken" });
        await starting;
        await this.serial(ref.id, async () => {});
        place = this.place(cmd.session);
      }
      if ("refused" in place)
        return this.finish(r, m.id, { outcome: "refused", code: place.refused, detail: place.why });
      if (kp === "permission") return this.permission(r, m.id, cmd, sent);
      if (kp === "cancel") return await this.cancel(r, m.id, cmd, sent);
      // One session's prompts in the order they came, each routed only once the one
      // before it has landed (a second message to a session the first one forked
      // goes to the copy). Other sessions don't wait.
      return await this.serial(`deliver:${cmd.session}`, async () => {
        // Read again: the message before this one may have moved the session (a fork).
        const now = this.place(cmd.session);
        if ("refused" in now) return this.finish(r, m.id, { outcome: "refused", code: now.refused, detail: now.why });
        return this.prompt(r, m.id, cmd, now, sent);
      });
    } catch (e) {
      this.finish(r, m.id, { outcome: "failed", detail: String((e as Error)?.message || e) });
    }
  }

  /** Where the session lives, and whether its folder is allowed — read from the
   *  session's own transcript (Claude Code, Codex), the folder its start recorded, or
   *  the hooks' cwd, never the command. */
  private place(session: string): { refused: string; why: string } | Placed {
    const ref = parseSessionRef(session)!;
    if (ref.harness === "codex" || ref.harness === "antigravity") return this.placeDriven(session, ref);
    if (ref.harness === "claude-code") {
      const target = this.state.copies[ref.id] ?? ref.id;
      const t = findTranscript(target, this.deps.claudeDirs()) ?? findTranscript(ref.id, this.deps.claudeDirs());
      if (!t)
        return { refused: "no_session", why: `no Claude Code session ${shortId(ref.harness, ref.id)} on this machine` };
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

  /** A Codex or Antigravity session: one the daemon started is its alias (the harness's
   *  id and the start's folder); one the hooks reported is Codex's rollout (its
   *  `session_meta` cwd) or, for Antigravity, the folder its hooks gave. */
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
      if (!a && !file)
        return { refused: "no_session", why: `no Codex session ${shortId(ref.harness, ref.id)} on this machine` };
      cwd ||= file ? codexControl.codexFacts(file).cwd : undefined;
    } else cwd ||= this.live.get(session)?.cwd || this.factsCwd(ref.harness, ref.id);
    if (!cwd)
      return {
        refused: "no_session",
        why: `no folder known for ${ref.harness === "codex" ? "Codex" : "Antigravity"} session ${shortId(ref.harness, ref.id)}`,
      };
    const ok = this.allowed(cwd);
    if (!ok) return { refused: "folder", why: "that session's folder isn't one this machine allows" };
    return { folder: ok, transcript: null, target, file };
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

  private aliasOf(harness: string, id: string): Alias | null {
    return this.aliases[`${harness}:${id}`] ?? null;
  }

  /** The harness revealed its own id for a session the command named: from now on that
   *  is where the command's id leads (aliases.ts). Written before anything else reads it. */
  private setAlias(harness: string, id: string, real: string, cwd: string): void {
    this.aliases = {
      ...this.aliases,
      [`${harness}:${id}`]: { id: real, cwd, at: new Date(this.deps.now()).toISOString() },
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
        args: ({ mode, prompt, cwd, resume }) =>
          resume ? codexControl.codexArgs({ mode, prompt, resume }) : codexControl.codexArgs({ mode, prompt, cwd }),
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
        args: ({ mode, prompt, resume }) =>
          resume ? antigravityControl.agyArgs({ mode, prompt, resume }) : antigravityControl.agyArgs({ mode, prompt }),
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

  /** The harnesses this machine can run a message in, for hello. */
  private harnesses(): string[] {
    if (this.deps.harnesses) return this.deps.harnesses();
    return [
      ...(this.deps.claude() ? ["claude-code"] : []),
      ...(this.deps.codex?.() ? ["codex"] : []),
      ...(this.deps.agy?.() ? ["antigravity"] : []),
    ];
  }

  private allowed(dir: string): string | null {
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

  private async cancel(r: PairedReceiver, id: string, cmd: ControlCommand, sent: number): Promise<void> {
    const ref = parseSessionRef(cmd.session)!;
    const held = this.sdkSessions.get(ref.id);
    if (!held)
      return this.finish(r, id, {
        outcome: "unsupported",
        detail: "no cancel path for a session the daemon doesn't hold",
      });
    await held.interrupt();
    this.finish(r, id, { outcome: "delivered", mode: "sdk" }, sent);
  }

  private view(session: string, place: Placed) {
    const ref = parseSessionRef(session)!;
    const l = this.live.get(session);
    if (ref.harness !== "claude-code") {
      // Codex: a rollout someone else wrote in the last 90 s is a session in use.
      // Antigravity keeps no file that says so: only the daemon's own run (whose
      // messages wait in line behind it) holds one.
      const live =
        !this.ownRuns.has(ref.id) &&
        !!place.file &&
        recentlyWritten(place.file, this.lastEnd.get(ref.id), this.deps.now());
      return {
        harness: ref.harness,
        sdk: false,
        waiter: !!l?.waiter && !l.waiter.destroyed,
        midTurn: !!l?.midTurn,
        live,
        known: true,
        canFork: false,
        api: false,
      };
    }
    const transcript = place.transcript;
    const claude =
      ref.harness === "claude-code"
        ? this.deps.claude()
        : /* v8 ignore next -- every other harness returned above */ null;
    const target = this.state.copies[ref.id] ?? ref.id;
    const t = transcript;
    // The daemon's own run holding it is not "someone else's live process": the message
    // queues behind that run (serial per session) and resumes it.
    const live =
      !this.ownRuns.has(target) &&
      !!t &&
      (liveProcess(target, t.configDir) || recentlyWritten(t.file, this.lastEnd.get(target), this.deps.now()));
    return {
      harness: ref.harness,
      sdk: this.sdkSessions.has(ref.id),
      waiter: !!l?.waiter && !l.waiter.destroyed,
      midTurn: !!l?.midTurn,
      live,
      known: !!t,
      canFork: !!claude?.caps.fork,
      api: false,
    };
  }

  private async prompt(r: PairedReceiver, id: string, cmd: ControlCommand, place: Placed, sent: number): Promise<void> {
    const route = routePrompt(this.view(cmd.session, place));
    if ("unsupported" in route) return this.finish(r, id, { outcome: "unsupported", detail: route.unsupported });
    /* v8 ignore next -- place() already refused a session with no transcript (`known` is never false here) */
    if ("refused" in route) return this.finish(r, id, { outcome: "refused", code: route.refused });
    const ref = parseSessionRef(cmd.session)!;
    const text = cmd.text as string;
    switch (route.mode) {
      case "waiter": {
        const l = this.live.get(cmd.session)!;
        const w = l.waiter!;
        l.waiter = null;
        const from = this.answerFrom(cmd.session);
        this.reply(w, { op: "message", text: frame(text, r.url), id });
        this.scheduleHello();
        return this.followAnswer(r, id, "waiter", cmd.session, from, sent);
      }
      case "turn": {
        const l = this.liveOf(cmd.session);
        const p: TurnPending = { receiver: r, msgId: id, text, session: cmd.session, queuedAt: sent };
        l.turnQueue.push(p);
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
        this.finish(r, id, { outcome: "taken" });
        const out = await s.send(frame(text, r.url));
        return this.finish(
          r,
          id,
          out.error
            ? { outcome: "failed", detail: out.error }
            : { outcome: "delivered", mode: "sdk", reply: out.reply },
          sent,
        );
      }
      case "resume":
      case "fork":
        return this.headless(r, id, cmd, place, route.mode, sent);
      /* v8 ignore next -- no harness has an input API wired yet (view() says api: false) */
      case "api":
        return this.finish(r, id, { outcome: "unsupported", detail: "no input API wired for this harness" });
    }
  }

  /** A turn message whose Stop never took it: route again, now that it isn't mid-turn. */
  private async reroute(p: TurnPending): Promise<void> {
    const l = this.liveOf(p.session);
    l.midTurn = false;
    const place = this.place(p.session);
    if ("refused" in place) return this.finish(p.receiver, p.msgId, { outcome: "refused", code: place.refused });
    const cmd = { kind: "prompt", session: p.session, text: p.text } as ControlCommand;
    this.inflight.delete(p.msgId);
    this.inflight.add(p.msgId);
    await this.prompt(p.receiver, p.msgId, cmd, place, p.queuedAt).catch((e) =>
      this.finish(p.receiver, p.msgId, { outcome: "failed", detail: String((e as Error)?.message || e) }),
    );
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
    const now = this.deps.now();
    const hit = this.logins.get(key);
    let login = hit && now - hit.at < (hit.login.loggedIn === false ? 30_000 : 600_000) ? hit.login : null;
    if (!login) {
      login = await ask().catch((): Login => ({ loggedIn: null }));
      this.logins.set(key, { at: now, login });
    }
    return login.loggedIn !== false;
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
  private async resumeDriven(r: PairedReceiver, id: string, cmd: ControlCommand, place: Placed, sent: number) {
    const ref = parseSessionRef(cmd.session)!;
    const drv = this.driver(ref.harness)!;
    const ready = await this.drivenProblem(drv);
    if ("failed" in ready) return this.finish(r, id, { outcome: "failed", detail: ready.failed });
    this.finish(r, id, { outcome: "taken" });
    await this.serial(ref.id, async () => {
      // Read again: the start this waited for may have named the session meanwhile.
      /* v8 ignore next -- placeDriven() always names a target; the last fallback is for the type */
      const target = this.aliasOf(ref.harness, ref.id)?.id ?? place.target ?? ref.id;
      const args = drv.args({
        mode: this.cfg.mode,
        prompt: frame(cmd.text as string, r.url),
        cwd: place.folder,
        resume: target,
      });
      this.deps.log(`${id.slice(-8)}: ${drv.cmd} resume ${target.slice(0, 8)} (${this.cfg.mode}) in ${place.folder}`);
      await this.drive(r, id, ref, drv, ready.bin, args, place.folder, sent, target);
    });
  }

  /** Run one Codex or Antigravity turn and ack it: `progress` as its answer grows, then
   *  `delivered` (mode `resume`) with the reply. The moment the harness names the session
   *  — a start's new one, or a fresh one for an id it didn't know — the command's id
   *  becomes its alias, so the next message resumes it. */
  private async drive(
    r: PairedReceiver,
    id: string,
    ref: { harness: string; id: string },
    drv: Driver,
    bin: string,
    args: string[],
    cwd: string,
    sent: number,
    asked: string | null,
  ): Promise<void> {
    const stream = this.answerStream(r, id);
    const reading = drv.reading();
    let named: string | null = null;
    const name = () => {
      const s = reading.session;
      if (!s || s === named) return;
      named = s;
      if (s !== asked) this.setAlias(ref.harness, ref.id, s, cwd);
    };
    const onLine = (l: string) => {
      if (reading.feed(l)) stream.set(reading.text);
      name();
    };
    const res = await this.owning(ref.id, () =>
      this.slot(() =>
        this.deps.run(bin, args, {
          cwd,
          env: jobEnv(this.deps.env),
          timeoutMs: JOB_TIMEOUT_MS,
          onLine,
          keep: () => false,
        }),
      ),
    );
    // A runner that doesn't stream hands the whole output over at the end.
    if (!reading.lines && res.stdout) for (const l of res.stdout.split("\n")) if (l.trim()) onLine(l);
    stream.close();
    this.lastEnd.set(ref.id, this.deps.now());
    if (reading.warnings?.length)
      this.deps.log(`${id.slice(-8)}: ${drv.cmd} warned: ${reading.warnings.join(" · ").slice(0, 400)}`);
    const out = reading.outcome(res);
    if ("failed" in out) return this.finish(r, id, { outcome: "failed", detail: out.failed });
    const moved =
      asked && named && named !== asked
        ? `\n\n(${drv.label} didn't find that session on this machine, so this ran in a new one; later messages continue there.)`
        : "";
    this.finish(r, id, { outcome: "delivered", mode: "resume", reply: out.reply + moved }, sent);
  }

  private async headless(
    r: PairedReceiver,
    id: string,
    cmd: ControlCommand,
    place: Placed,
    mode: "resume" | "fork",
    sent: number,
  ): Promise<void> {
    if (parseSessionRef(cmd.session)?.harness !== "claude-code") return this.resumeDriven(r, id, cmd, place, sent);
    const claude = this.deps.claude();
    if (!claude)
      return this.finish(r, id, { outcome: "failed", detail: "Claude Code isn't installed on this machine" });
    const mf = modeFlags(this.cfg.mode, claude.caps);
    if ("error" in mf) return this.finish(r, id, { outcome: "refused", code: "mode", detail: mf.error });
    const signedOut = await this.loginProblem(place.transcript?.configDir);
    if (signedOut) return this.finish(r, id, { outcome: "failed", detail: signedOut });
    const ref = parseSessionRef(cmd.session)!;
    this.finish(r, id, { outcome: "taken" });
    await this.serial(ref.id, async () => {
      const target = this.state.copies[ref.id] ?? ref.id;
      const resume = mode === "fork" ? ["--resume", target, "--fork-session"] : ["--resume", target];
      const allow = this.allowedFor(r);
      const args = [
        "-p",
        ...this.outputArgs(claude.caps),
        ...mf.args,
        ...(allow.length ? [`--allowedTools=${allow.join(",")}`] : []),
        ...resume,
        frame(cmd.text as string, r.url),
      ];
      this.deps.log(`${id.slice(-8)}: claude -p ${[...mf.args, ...resume].join(" ")} in ${place.folder}`);
      const stream = this.answerStream(r, id);
      const res = await this.owning(target, () =>
        this.slot(() =>
          this.deps.run(claude.bin, args, {
            cwd: place.folder,
            env: claudeEnv(place.transcript?.configDir, this.deps.env),
            timeoutMs: JOB_TIMEOUT_MS,
            ...(claude.caps.stream ? { onLine: (l: string) => stream.feed(l) } : {}),
          }),
        ),
      );
      stream.close();
      this.lastEnd.set(target, this.deps.now());
      const out = this.outcome(res);
      if ("failed" in out) return this.finish(r, id, { outcome: "failed", detail: out.failed });
      const ran = isUuid(out.session) ? out.session : target;
      if (mode === "fork" && ran !== target) {
        this.state.copies[ref.id] = ran;
        writeState(path.join(this.dir, "state.json"), this.state);
        this.lastEnd.set(ran, this.deps.now());
      }
      this.finish(
        r,
        id,
        { outcome: "delivered", mode, reply: out.reply, ...(ran !== ref.id ? { session: `claude-code:${ran}` } : {}) },
        sent,
      );
    });
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
    rec.keys.push({
      id: k.id,
      alg: k.alg,
      spki: k.spki,
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
      `trusted a new device${name ? ` (${name})` : ""} on ${r.url}: ${k.id.slice(0, 12)}…, vouched for by a key it already trusted`,
    );
    this.finish(r, id, { outcome: "delivered", detail: `trusted ${name || "a new device"}` }, sent);
  }

  /** Where the session's transcript ends right now: its answer starts after this. */
  private answerFrom(session: string): { file: string; offset: number } | null {
    const ref = parseSessionRef(session);
    if (!ref || ref.harness !== "claude-code") return null;
    const t = findTranscript(this.state.copies[ref.id] ?? ref.id, this.deps.claudeDirs());
    return t ? { file: t.file, offset: transcriptEnd(t.file) } : null;
  }

  /** A message handed to a live session (a waiter, a Stop block) is `taken` now; the
   *  session answers in its own turn, which the daemon reads from the transcript and
   *  sends back as the final ack's `reply` — so the person sees the answer where they
   *  asked. A turn that doesn't end within ANSWER_WAIT_MS is acked delivered without. */
  private followAnswer(
    r: PairedReceiver,
    id: string,
    mode: "waiter" | "turn",
    session: string,
    from: { file: string; offset: number } | null,
    sent: number,
  ): void {
    this.deps.log(`${id.slice(-8)}: in ${session.slice(0, 24)} via ${mode} ${this.deps.now() - sent} ms after send`);
    this.finish(r, id, { outcome: "taken" });
    const stream = this.answerStream(r, id);
    void (async () => {
      const answer = from
        ? await awaitAnswer(from.file, from.offset, {
            timeoutMs: this.deps.answerWaitMs ?? ANSWER_WAIT_MS,
            now: this.deps.now,
            onText: (t) => stream.set(t),
          })
        : null;
      stream.close();
      this.finish(r, id, { outcome: "delivered", mode, ...(answer ? { reply: answer } : {}) }, sent);
    })().catch((e) =>
      this.finish(r, id, {
        outcome: "delivered",
        mode,
        detail: String(/* v8 ignore next -- awaitAnswer throws fs Errors */ (e as Error)?.message || e),
      }),
    );
  }

  /** The answer so far, sent as a `progress` ack: whole, with a rising seq, at most
   *  one in flight. Fire-and-forget — the final ack carries everything. */
  private answerStream(r: PairedReceiver, id: string): AnswerStream {
    return new AnswerStream(async (text, seq) => {
      await this.post(r, "/ack", {
        acks: [
          {
            id,
            outcome: "progress",
            at: new Date(this.deps.now()).toISOString(),
            seq,
            reply: redactSecrets(text).slice(0, MAX_REPLY),
          },
        ],
      });
    });
  }

  /** How a headless run prints: streamed where this Claude Code can, else one JSON at the end. */
  private outputArgs(caps: { stream?: boolean }): string[] {
    return caps.stream
      ? ["--output-format", "stream-json", "--verbose", "--include-partial-messages"]
      : ["--output-format", "json"];
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

  private async startSession(r: PairedReceiver, id: string, cmd: ControlCommand, sent: number): Promise<void> {
    const lim = this.limits();
    const now = this.deps.now();
    this.startTimes = this.startTimes.filter((t) => now - t < 3_600_000);
    if (this.startsRunning >= lim.startConcurrent || this.startTimes.length >= lim.startPerHour) {
      const detail =
        this.startsRunning >= lim.startConcurrent
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

  private async startOne(r: PairedReceiver, id: string, cmd: ControlCommand, sent: number): Promise<void> {
    const ref = parseSessionRef(cmd.session)!;
    const cwd = this.allowed(cmd.cwd as string);
    if (!cwd)
      return this.finish(r, id, {
        outcome: "refused",
        code: "folder",
        detail: "that folder isn't one this machine allows",
      });
    if (ref.harness !== "claude-code") return this.startDriven(r, id, cmd, ref, cwd, sent);
    if (findTranscript(ref.id, this.deps.claudeDirs()) || this.sdkSessions.has(ref.id))
      return this.finish(r, id, {
        outcome: "refused",
        code: "bad_session",
        detail: "that new session's id is already taken",
      });
    const signedOut = await this.loginProblem(this.deps.env?.CLAUDE_CONFIG_DIR);
    if (signedOut) return this.finish(r, id, { outcome: "failed", detail: signedOut });
    this.finish(r, id, { outcome: "taken" });
    const text = await this.attached(r, id, cmd, ref, cwd);
    if (text === null) return;
    if (this.deps.sdk) {
      const sdk = this.deps.sdk;
      const out = await this.slot(async () => {
        const s = sdk.start({ session: ref.id, cwd, mode: this.cfg.mode, allowedTools: this.allowedFor(r) });
        this.sdkSessions.set(ref.id, s);
        return s.send(frameStart(text, r.url));
      });
      return this.finish(
        r,
        id,
        out.error ? { outcome: "failed", detail: out.error } : { outcome: "delivered", mode: "sdk", reply: out.reply },
        sent,
      );
    }
    const claude = this.deps.claude();
    if (!claude)
      return this.finish(r, id, { outcome: "failed", detail: "Claude Code isn't installed on this machine" });
    const mf = modeFlags(this.cfg.mode, claude.caps);
    if ("error" in mf) return this.finish(r, id, { outcome: "refused", code: "mode", detail: mf.error });
    const stream = this.answerStream(r, id);
    const res = await this.slot(() =>
      this.deps.run(
        claude.bin,
        [
          "-p",
          ...this.outputArgs(claude.caps),
          ...mf.args,
          ...(this.allowedFor(r).length ? [`--allowedTools=${this.allowedFor(r).join(",")}`] : []),
          "--session-id",
          ref.id,
          frameStart(text, r.url),
        ],
        {
          cwd,
          env: claudeEnv(undefined, this.deps.env),
          timeoutMs: JOB_TIMEOUT_MS,
          ...(claude.caps.stream ? { onLine: (l: string) => stream.feed(l) } : {}),
        },
      ),
    );
    stream.close();
    // The transcript this run just wrote is ours: the next message must not read it as a
    // live session (a fork instead of a resume).
    this.lastEnd.set(ref.id, this.deps.now());
    const out = this.outcome(res);
    if ("failed" in out) return this.finish(r, id, { outcome: "failed", detail: out.failed });
    this.finish(r, id, { outcome: "delivered", mode: "resume", reply: out.reply }, sent);
  }

  /** A new Codex or Antigravity session: the harness picks its id, and the start's id
   *  becomes its name (aliases.ts) as soon as the run says what it picked. */
  private async startDriven(
    r: PairedReceiver,
    id: string,
    cmd: ControlCommand,
    ref: { harness: string; id: string },
    cwd: string,
    sent: number,
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
    const ready = await this.drivenProblem(drv);
    if ("failed" in ready) return this.finish(r, id, { outcome: "failed", detail: ready.failed });
    this.finish(r, id, { outcome: "taken" });
    const text = await this.attached(r, id, cmd, ref, cwd);
    if (text === null) return;
    const args = drv.args({ mode: this.cfg.mode, prompt: frameStart(text, r.url), cwd });
    this.deps.log(
      `${id.slice(-8)}: ${drv.cmd} new session for ${shortId(ref.harness, ref.id)} (${this.cfg.mode}) in ${cwd}`,
    );
    await this.drive(r, id, ref, drv, ready.bin, args, cwd, sent, null);
  }

  /** A start's text, with its files (CONTROL.md §6) fetched, checked and written under
   *  `cwd` first — every check in §5 passed and the nonce is recorded by now, so the
   *  `taken` ack is out and the download may take its time. Null when a file failed:
   *  the command is acked `failed` with code `file`, nothing is kept, no session starts. */
  private async attached(
    r: PairedReceiver,
    id: string,
    cmd: ControlCommand,
    ref: { id: string },
    cwd: string,
  ): Promise<string | null> {
    const text = cmd.text as string;
    if (!cmd.files) return text;
    try {
      const got = await fetchFiles(cmd.files, {
        control: r.control,
        token: r.token,
        fetch: this.deps.fetch,
        timeoutMs: this.deps.fileTimeoutMs,
      });
      const rel = writeFiles(cwd, ref.id, got);
      this.deps.log(`${id.slice(-8)}: ${got.length} file(s) saved in ${cwd}/.sessionpipe/files/${ref.id}`);
      return withFiles(text, got, rel);
    } catch (e) {
      // fetchFiles and writeFiles throw nothing but a FileProblem, and its message is the detail.
      const detail = (e as Error).message;
      this.deps.log(`${id.slice(-8)}: file — ${detail}`);
      this.finish(r, id, { outcome: "failed", code: "file", detail });
      return null;
    }
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
