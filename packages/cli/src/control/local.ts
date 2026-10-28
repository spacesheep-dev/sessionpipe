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
  /** A waiter parks until a message for its session arrives. */
  | { op: "wait"; session: string; pid?: number }
  /** A Stop hook asks for a queued message (turn mode). */
  | { op: "stop"; session: string; active: boolean }
  /** A PermissionRequest hook parks until a verified answer, or until it's released. */
  | { op: "permission"; session: string; attention: string; tool?: string }
  /** The worker reports a hook event: turn state and attention closure. */
  | { op: "event"; session: string; event: string; transcript?: string; cwd?: string }
  /** `sessionpipe control status`. */
  | { op: "status" }
  /** `sessionpipe update` installed a new copy: restart onto it once nothing is in hand. */
  | { op: "restart" }
  /** `sessionpipe ask` (CONTROL.md §13): a session here hands a task to another agent on
   *  this machine and gets the answer back on this connection. */
  | AskRequest;

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

/** The replies that end an ask. */
export type AskEnd = Extract<LocalReply, { op: "answer" | "refused" | "failed" }>;

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
