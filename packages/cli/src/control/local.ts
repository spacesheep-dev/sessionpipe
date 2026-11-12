// SPDX-License-Identifier: Apache-2.0
// The daemon's local socket (spec/CONTROL.md §8, §13): how the waiter, the Stop and
// PermissionRequest hooks, the worker and `sessionpipe ask` talk to the one daemon on
// this machine. Line-delimited JSON, one request per connection; every request but an
// ask gets one reply, an ask gets a few in order on the same connection. A Unix socket
// in the state directory (0600, in a 0700 dir); a per-user named pipe on Windows. Only
// node: builtins — the hook bundle imports this.
import net from "node:net";
import os from "node:os";
import path from "node:path";

export type LocalRequest =
  /** A waiter parks until a message for its session arrives. `channel`: the waiter is
   *  `sessionpipe channel`, which pushes the message into the session rather than handing
   *  it to a turn that asked for it (CONTROL.md §8). */
  | { op: "wait"; session: string; pid?: number; channel?: boolean }
  /** A Stop hook asks for a queued message (turn mode). `mode` is the session's own
   *  permission mode, as its payload reports it (CONTROL.md §6, The session's mode). */
  | { op: "stop"; session: string; active: boolean; mode?: string }
  /** A PermissionRequest hook parks until a verified answer, or until it's released:
   *  by a later event of its session that says this question is over (attention.ts).
   *  `agent` is the thread that asked, a subagent's id or "" for the main thread, and
   *  `at` when the hook fired, by its own clock. A hook older than those two sends
   *  neither, and is released as it always was: by the session's next closing event. */
  | { op: "permission"; session: string; attention: string; tool?: string; agent?: string; at?: number }
  /** The worker reports a hook event: turn state, attention closure, and the session's
   *  own permission mode where its payload named one. For a Claude Code session, also
   *  what a held prompt is let go by: the thread the event is about (`agent`, as above),
   *  a tool event's own call id (`call`), when its hook fired (`at`), and how much work
   *  a Stop says is still in flight (`background`). An older worker sends none of them,
   *  and its events end every held prompt of the session, as they did. */
  | {
      op: "event";
      session: string;
      event: string;
      transcript?: string;
      cwd?: string;
      mode?: string;
      agent?: string;
      call?: string;
      at?: number;
      background?: number;
    }
  /** `sessionpipe control status`. */
  | { op: "status" }
  /** `sessionpipe update` installed a new copy: restart onto it once nothing is in hand. */
  | { op: "restart" }
  /** `sessionpipe update`, just before it replaces the service: stop taking messages if,
   *  and only if, nothing is held right now. `ok`: intake is paused and nothing is held
   *  (the daemon lets go by itself after a minute if it is not stopped); `none`: something
   *  is held, and nothing was paused. A daemon from before this closes the connection. */
  | { op: "quiesce" }
  /** `sessionpipe doctor`: what the daemon can see that the shell asking may not (a
   *  sign-in kept in a Mac's login keychain, which an ssh shell can't read). */
  | { op: "health" }
  /** `sessionpipe pool …` while the daemon runs: the daemon holds the pool's engine
   *  (pins, credentials, the listener), so a change goes through it. `status` reads;
   *  the rest are CONTROL.md §6's actions, plus `import` (reads this machine's own
   *  Claude Code logins, which no receiver may ask for). */
  | { op: "pool"; action: PoolOp; account?: string; order?: string[]; code?: string }
  /** `sessionpipe ask` (CONTROL.md §13): a session here hands a task to another agent on
   *  this machine and gets the answer back on this connection. */
  | AskRequest;

export type PoolOp =
  | "status"
  | "on"
  | "off"
  | "enable"
  | "disable"
  | "remove"
  | "order"
  | "refresh"
  | "login.begin"
  | "login.complete"
  | "import";

export interface AskRequest {
  op: "ask";
  /** `<harness>:<id>` of the asking session, when known: the events go on it. */
  from?: string;
  /** The agent to ask. */
  harness: string;
  /** An existing `<harness>:<id>` to continue instead of a new session. */
  session?: string;
  /** 1–20 000 characters, not all whitespace. */
  text: string;
  /** Absolute; the caller's folder by default. */
  cwd: string;
  /** Every ancestor ref, outermost first (from env SESSIONPIPE_ASK_CHAIN). */
  chain: string[];
  /** Narrower than the machine's mode, never wider. */
  permission?: "read" | "safe";
  model?: string;
  pid?: number;
}

export type LocalReply =
  | { op: "message"; text: string; id: string }
  | { op: "block"; reason: string; id: string }
  | { op: "decision"; behavior: "allow" | "deny"; message?: string; id: string }
  | { op: "none" }
  /** A newer waiter for the same session took over; this one stops. */
  | { op: "replaced" }
  | { op: "ok" }
  | { op: "status"; status: unknown }
  | { op: "health"; health: Health }
  /** A pool op's answer: the ack it would earn (CONTROL.md §6) and the pool as it now
   *  stands (`status`: the façade's PoolStatus; `detail`: the summary line, or a
   *  login.begin's "<pending id> <URL>"). */
  | {
      op: "pool";
      outcome: "delivered" | "refused" | "failed" | "unsupported";
      code?: string;
      detail: string;
      status?: unknown;
      /** `import`: what was added and what was left out (control/pool.ts Imported). */
      imported?: unknown;
    }
  // An ask's replies, in order (askMany): `asked`, any `progress`, then exactly one of
  // `answer`, `refused` and `failed`, after which the daemon closes the connection.
  /** The run began; `session` once it is known. */
  | { op: "asked"; ask_id: string; session?: string }
  /** The answer so far, whole, with a rising seq. */
  | { op: "progress"; text: string; seq: number }
  | { op: "answer"; ask_id: string; session: string; text: string; ms: number }
  /** ask_off · harness · folder · depth · loop · start_limit · bad_fields */
  | { op: "refused"; code: string; detail: string }
  | { op: "failed"; detail: string };

/** What the daemon sees from where it runs (`health`). */
export interface Health {
  /** Each Claude Code account on this machine: its config dir, and whether Claude Code
   *  says it is signed in as the daemon sees it (null: it couldn't say). */
  accounts: { dir: string; signed_in: boolean | null }[];
  /** The copy the daemon runs: its cli.js by real path, and who starts it again when it
   *  exits to restart (null: nobody, it supervises its own successor). */
  copy?: { cli: string; via: "launchd" | "systemd" | "supervisor" | null };
}

/** The replies that end an ask. */
export type AskEnd = Extract<LocalReply, { op: "answer" | "refused" | "failed" }>;

/** The thread a Claude Code hook fired in, and the tool call it is about, as its payload
 *  names them: `agent_id` where a subagent's (none on the main thread, said here as ""),
 *  and `tool_use_id` on a tool's hooks. The PermissionRequest hook and the worker both
 *  tell the daemon with this, so a question and the events that end it are named alike. */
export function threadOf(payload: Record<string, unknown>): { agent: string; call?: string } {
  const agent = typeof payload.agent_id === "string" ? payload.agent_id : "";
  const call = typeof payload.tool_use_id === "string" && payload.tool_use_id ? payload.tool_use_id : undefined;
  return { agent, ...(call ? { call } : {}) };
}

/** Where the daemon listens. `SESSIONPIPE_SOCKET` overrides (tests). */
export function socketPath(state: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.SESSIONPIPE_SOCKET) return env.SESSIONPIPE_SOCKET;
  if (process.platform === "win32") return `\\\\.\\pipe\\sessionpipe-control-${os.userInfo().username}`;
  return path.join(state, "control.sock");
}

/** One request, one reply. `timeoutMs` bounds the whole exchange; null on any
 *  failure (no daemon, a timeout, a garbled reply) — callers treat that as "none". */
export function ask(sock: string, req: LocalRequest, timeoutMs: number): Promise<LocalReply | null> {
  return new Promise((resolve) => {
    let buf = "";
    let done = false;
    const s = net.connect(sock);
    const finish = (r: LocalReply | null) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      s.destroy();
      resolve(r);
    };
    const t = setTimeout(() => finish(null), timeoutMs);
    s.on("connect", () => s.write(`${JSON.stringify(req)}\n`));
    s.on("data", (d) => {
      buf += d.toString("utf8");
      const i = buf.indexOf("\n");
      if (i < 0) return;
      try {
        finish(JSON.parse(buf.slice(0, i)) as LocalReply);
      } catch {
        finish(null);
      }
    });
    s.on("error", () => finish(null));
    s.on("close", () => finish(null));
  });
}

/** One request, several replies on the same connection (an ask): `onReply` sees each one
 *  in order, the promise settles with the one that ends the exchange. `timeoutMs` bounds
 *  the whole exchange; null when it ends without an end — no daemon, a timeout, a garbled
 *  line, a connection that closed mid-run. */
export function askMany(
  sock: string,
  req: LocalRequest,
  onReply: (r: LocalReply) => void,
  timeoutMs: number,
): Promise<AskEnd | null> {
  return new Promise((resolve) => {
    let buf = "";
    let done = false;
    const s = net.connect(sock);
    const finish = (r: AskEnd | null) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      s.destroy();
      resolve(r);
    };
    const t = setTimeout(() => finish(null), timeoutMs);
    s.on("connect", () => s.write(`${JSON.stringify(req)}\n`));
    s.on("data", (d) => {
      buf += d.toString("utf8");
      for (let i = buf.indexOf("\n"); i >= 0 && !done; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let r: LocalReply;
        try {
          r = JSON.parse(line) as LocalReply;
        } catch {
          finish(null);
          return;
        }
        onReply(r);
        if (r.op === "answer" || r.op === "refused" || r.op === "failed") finish(r);
      }
    });
    s.on("error", () => finish(null));
    s.on("close", () => finish(null));
  });
}
