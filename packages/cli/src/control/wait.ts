// SPDX-License-Identifier: Apache-2.0
// `sessionpipe wait` (spec/CONTROL.md §8): run by a session as a BACKGROUND command.
// It blocks on the daemon's local socket — no network, no polling, no output — until
// a verified message for this session arrives, prints it and exits 0; the harness
// then wakes the session with it. If the daemon restarts, it reconnects in silence.
import { stateDir } from "@sessionpipe/core";
import { parseSessionRef, RE_ARM } from "@sessionpipe/core/control";
import { ask, socketPath } from "./local.js";

// Said after the message, so the session starts the waiter again: defined with the other
// words around a delivered message, in core.
export { RE_ARM };

/** The session to wait for: --session, else the harness's own env. */
export function waitSession(flag: string | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  if (flag) return parseSessionRef(flag) ? flag : null;
  if (env.CLAUDE_CODE_SESSION_ID) return `claude-code:${env.CLAUDE_CODE_SESSION_ID}`;
  if (env.CODEX_SESSION_ID) return `codex:${env.CODEX_SESSION_ID}`;
  return null;
}

export async function waitForMessage(
  session: string,
  o: { env?: NodeJS.ProcessEnv; retryMs?: number } = {},
): Promise<string> {
  const sock = socketPath(stateDir(o.env), o.env);
  for (;;) {
    // No timeout of our own: the harness's background deadline is the only clock.
    const r = await ask(sock, { op: "wait", session, pid: process.pid }, 2 ** 31 - 1);
    if (r?.op === "message") return `${r.text}\n\n${RE_ARM}`;
    if (r?.op === "replaced")
      return "(Another `sessionpipe wait` for this session took over; this one stopped. Nothing to do.)";
    await new Promise((res) => setTimeout(res, o.retryMs ?? 1000));
  }
}
