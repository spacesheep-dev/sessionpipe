// SPDX-License-Identifier: Apache-2.0
// The daemon's local socket (spec/CONTROL.md §8): how the waiter, the Stop and
// PermissionRequest hooks and the worker talk to the one daemon on this machine.
// Line-delimited JSON, one request per connection. A Unix socket in the state
// directory (0600, in a 0700 dir); a per-user named pipe on Windows. Only node:
// builtins — the hook bundle imports this.
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
  /** `sessionpipe pool …` while the daemon runs: the daemon holds the pool's engine
   *  (pins, credentials, the listener), so a change goes through it. `status` reads;
   *  the rest are CONTROL.md §6's actions, plus `import` (reads this machine's own
   *  Claude Code logins, which no receiver may ask for). */
  | { op: "pool"; action: PoolOp; account?: string; order?: string[]; code?: string };

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

export type LocalReply =
  | { op: "message"; text: string; id: string }
  | { op: "block"; reason: string; id: string }
  | { op: "decision"; behavior: "allow" | "deny"; message?: string; id: string }
  | { op: "none" }
  /** A newer waiter for the same session took over; this one stops. */
  | { op: "replaced" }
  | { op: "ok" }
  | { op: "status"; status: unknown }
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
    };

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
