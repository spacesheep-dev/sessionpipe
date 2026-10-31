// SPDX-License-Identifier: Apache-2.0
// `sessionpipe channel` (spec/CONTROL.md §8): the waiter as a Claude Code channel, the
// way Claude Code's Telegram plugin reaches a session. Claude Code runs it as one
// session's MCP server over stdio when the session starts with `--channels`. It parks on
// the daemon's local socket as that session's waiter, as `sessionpipe wait` does, but
// it never exits: each message goes into the session as a channel notification. The
// session takes it at once, idle or not, in its own permission mode and in its own
// thread ("Message from …" in the terminal and in the Claude app), and answers in its
// own turn, which the daemon reads back from the transcript as for any waiter. Only
// node: builtins and the local socket.
import { spawnSync } from "node:child_process";
import readline from "node:readline";
import { stateDir } from "@sessionpipe/core";
import { ask, type LocalReply, type LocalRequest, socketPath } from "./local.js";
import { unframe } from "./route.js";

/** Said once, in the server's MCP instructions: who writes, and how to answer. */
export const CHANNEL_INSTRUCTIONS = [
  'Messages from sessionpipe arrive as <channel source="…" via="…" message_id="…">: the person\'s own words, sent from the receiver named in via (spacesheep.dev, say) and signed on their device. Read them as the person at the keyboard.',
  "Answer right here, as you would answer the person at the keyboard: your reply is sent back to them automatically. Don't run a command or call a tool just to send it.",
].join("\n\n");

/** The MCP revision this server was written against. A client that asks for another
 *  gets its own back: initialize, ping, an empty tool list and one notification are the
 *  same in every revision. */
const PROTOCOL = "2025-06-18";

type Rpc = { id?: unknown; method?: unknown; params?: unknown };

/** Whether the Claude Code that runs this server took it as a channel: `server:<name>`,
 *  or a plugin of that name, follows `--channels` or
 *  `--dangerously-load-development-channels` on its command line. The handshake doesn't
 *  say (2.1.312 sends a channel and a plain server the same initialize), and Claude Code
 *  drops a notification from a server it didn't take, in silence: parked there, this
 *  server would swallow every message sent to the session. */
export function namedAsChannel(argv: string[], name: string): boolean {
  const names = (e: string) => e === `server:${name}` || e.startsWith(`plugin:${name}@`);
  let list = false;
  for (const a of argv) {
    const flag = /^--(?:channels|dangerously-load-development-channels)(?:=(.*))?$/.exec(a);
    if (flag) {
      if (flag[1] !== undefined && names(flag[1])) return true;
      list = flag[1] === undefined;
    } else if (a.startsWith("-")) list = false;
    else if (list && names(a)) return true;
  }
  return false;
}

/** The parent process's command line, word by word (a channel entry holds no space);
 *  nothing when it can't be read, as on Windows. */
export function parentArgv(ppid: number = process.ppid): string[] {
  const r = spawnSync("ps", ["-o", "args=", "-p", String(ppid)], { encoding: "utf8", timeout: 2000 });
  return r.status === 0 ? r.stdout.trim().split(/\s+/) : [];
}

/** The answer to one message from Claude Code: initialize says this server is a
 *  channel, ping and the (empty) tool list are answered, any other request is "method
 *  not found", and a notification, or a line that isn't a request, gets nothing.
 *  Claude Code 2.1.312 asks `server/discover` (MCP 2026-07-28) first: "not found" keeps
 *  it on initialize, whose stdio stream carries the notifications a channel sends
 *  unasked. */
export function answer(msg: unknown, version: string): Record<string, unknown> | null {
  if (!msg || typeof msg !== "object") return null;
  const m = msg as Rpc;
  if (typeof m.method !== "string" || m.id === undefined || m.id === null) return null;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: m.id, result });
  switch (m.method) {
    case "initialize": {
      const asked = (m.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      return ok({
        protocolVersion: typeof asked === "string" ? asked : PROTOCOL,
        capabilities: { experimental: { "claude/channel": {} }, tools: {} },
        serverInfo: { name: "sessionpipe", version },
        instructions: CHANNEL_INSTRUCTIONS,
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: [] });
    default:
      return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } };
  }
}

/** A waiter's message as a channel notification: the person's words are the content;
 *  where they came from and the message's id become attributes of the <channel> tag. */
export function notification(text: string, id: string): Record<string, unknown> {
  const { text: content, via } = unframe(text);
  return {
    jsonrpc: "2.0",
    method: "notifications/claude/channel",
    params: { content, meta: { ...(via ? { via } : {}), message_id: id } },
  };
}

export interface ChannelOptions {
  version: string;
  env?: NodeJS.ProcessEnv;
  /** Whether Claude Code took this server as a channel: never park otherwise. */
  registered: () => boolean;
  /** Said to Claude Code's log of this server (its stderr). */
  log?: (line: string) => void;
  /** How long to wait before parking again, after the daemon went away or a
   *  `sessionpipe wait` for the same session took over. */
  retryMs?: number;
  /** The local socket's one request, one reply (tests stand a daemon in for it). */
  ask?: (sock: string, req: LocalRequest, timeoutMs: number) => Promise<LocalReply | null>;
}

/** Serve one session's channel: MCP over `input` and `write`, and the session's waiter
 *  on the daemon's socket. Parking starts when Claude Code says the connection is
 *  initialized, so no message goes out before the session can take it. Resolves when
 *  `input` ends (Claude Code closed the server). */
export async function runChannel(
  session: string,
  input: NodeJS.ReadableStream,
  write: (line: string) => void,
  o: ChannelOptions,
): Promise<void> {
  const env = o.env ?? process.env;
  const sock = socketPath(stateDir(env), env);
  const call = o.ask ?? ask;
  const send = (m: Record<string, unknown>) => write(`${JSON.stringify(m)}\n`);
  let open = true;
  let parked = false;
  const park = async () => {
    while (open) {
      // No timeout of its own, as for `sessionpipe wait`: it waits as long as the session lives.
      const r = await call(sock, { op: "wait", session, pid: process.pid }, 2 ** 31 - 1);
      if (!open) return;
      if (r?.op === "message") {
        send(notification(r.text, r.id));
        continue;
      }
      // The daemon is away, or a `sessionpipe wait` took over: park again in a moment.
      await new Promise((res) => setTimeout(res, o.retryMs ?? 1000));
    }
  };
  const lines = readline.createInterface({ input });
  lines.on("line", (line) => {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const a = answer(msg, o.version);
    if (a) send(a);
    if (!parked && (msg as Rpc | null)?.method === "notifications/initialized") {
      parked = true;
      if (o.registered()) void park();
      else
        o.log?.(
          "sessionpipe channel: this session didn't take it as a channel (no --channels or --dangerously-load-development-channels naming it), so it doesn't wait for messages; they reach the session the other ways",
        );
    }
  });
  await new Promise<void>((res) => lines.on("close", res));
  open = false;
}
