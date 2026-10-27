// SPDX-License-Identifier: Apache-2.0
// The routing rule (spec/CONTROL.md §6): the first delivery mode that fits, top to
// bottom. Pure, so every branch is a unit test.
import { acpControl } from "@sessionpipe/core";
import type { ControlKind } from "@sessionpipe/core/control";

export type DeliveryMode = "sdk" | "waiter" | "turn" | "inbox" | "api" | "resume" | "fork";

export interface SessionView {
  harness: string;
  /** The daemon holds this session through the Agent SDK right now. */
  sdk: boolean;
  /** A `sessionpipe wait` for it is parked on the socket. */
  waiter: boolean;
  /** Between a turn's start and its Stop (the Stop hook will ask). */
  midTurn: boolean;
  /** A live, idle, vetted session whose own permission class is this machine's: its own
   *  local inbox takes the message (§6.3). */
  inbox: boolean;
  /** A live process holds the session (registry entry or a fresh transcript write). */
  live: boolean;
  /** The transcript exists on this machine (Codex, Antigravity: the session was placed). */
  known: boolean;
  /** This Claude Code can copy a session (`--fork-session`); no other harness can. */
  canFork: boolean;
  /** It already has a copy, which is where its messages go: a copy is a leaf and is
   *  never itself copied (§6 `prompt`). */
  copied: boolean;
  /** The harness has an input API (OpenCode, Codex app-server) — none is wired yet. */
  api: boolean;
}

export type Route = { mode: DeliveryMode } | { unsupported: string } | { refused: "no_session" };

/** The harnesses the daemon can run a turn of by itself: resume an idle session, start a
 *  new one (`claude -p`, `codex exec`, `agy -p`, or any ACP agent as its client). */
export const HEADLESS = new Set(["claude-code", "codex", "antigravity", ...acpControl.ACP_HARNESSES]);

/** The ladder in one place, so its order is a fact and not a shape of the code: the
 *  first rung that fits wins (spec/CONTROL.md §6). The in-place rungs come first,
 *  because the session answers in the person's own window or thread, in its own
 *  permission mode, with nothing started and nothing replayed. Among those, the ones
 *  the session itself opened — a parked waiter, a running turn — come before the one
 *  where the daemon writes to it unasked. */
export const DELIVERY_LADDER = ["sdk", "waiter", "turn", "inbox", "api", "resume", "fork"] as const;

/** Does `a` sit above `b` on the ladder? The rungs above `inbox` are all free to test,
 *  so a message that takes one of them never pays for the inbox's own look. */
export const earlier = (a: DeliveryMode, b: DeliveryMode): boolean =>
  DELIVERY_LADDER.indexOf(a) < DELIVERY_LADDER.indexOf(b);

/** Whether each rung fits this session, as the ladder walks it. */
const FITS: Record<DeliveryMode, (s: SessionView) => boolean> = {
  sdk: (s) => s.sdk,
  waiter: (s) => s.waiter,
  turn: (s) => s.midTurn,
  inbox: (s) => s.inbox,
  api: (s) => s.api,
  resume: (s) => HEADLESS.has(s.harness) && s.known && !s.live,
  fork: (s) => HEADLESS.has(s.harness) && s.known && s.live && s.canFork && !s.copied,
};

/** Where a prompt (or a start) goes. Never two writers on one transcript: a live
 *  session gets an in-place lane or a fork, never a resume. */
export function routePrompt(s: SessionView): Route {
  for (const mode of DELIVERY_LADDER) if (FITS[mode](s)) return { mode };
  if (!HEADLESS.has(s.harness)) return { unsupported: `no idle delivery for ${s.harness} yet` };
  if (!s.known) return { refused: "no_session" };
  return {
    unsupported:
      s.harness === "claude-code"
        ? s.copied
          ? "the session is open, and so is the copy its messages already go to; a copy is never itself copied"
          : "the session is open and this Claude Code can't copy it (no --fork-session)"
        : `the session is open in ${s.harness} right now, and a ${s.harness} session can't be copied: send it again once it has been idle a couple of minutes`,
  };
}

/** How each kind is delivered, before the session's state is looked at. */
export function kindPath(
  kind: ControlKind,
  harness: string,
): "prompt" | "permission" | "cancel" | "start" | { unsupported: string } {
  switch (kind) {
    case "prompt":
      return "prompt";
    case "permission.answer":
      return harness === "gemini-cli"
        ? { unsupported: "Gemini CLI has no permission answer channel" }
        : harness === "devin"
          ? { unsupported: "Devin has no permission answer channel" }
          : "permission";
    case "cancel":
      return "cancel";
    case "start":
      return HEADLESS.has(harness) ? "start" : { unsupported: `can't start a ${harness} session` };
    default:
      return { unsupported: `unknown kind ${String(kind)}` };
  }
}

/** The framed text a session receives (CONTROL.md §6): the model and the person can
 *  tell where it came from. */
/** Said with every message that reaches a live session: the answer goes back by
 *  itself (the daemon reads it from the transcript), so the model never invents a
 *  command to reply with (a real session tried \`sessionpipe send\`, 2026-10-01). */
export const IN_PLACE_ANSWER =
  "Answer it right here, as you would answer the person at the keyboard: your reply is sent back to them automatically. Don't run a command or call a tool just to send it.";

export function frame(text: string, receiver: string): string {
  return `Message via ${hostOf(receiver)} (sessionpipe control, signed on the sender's device):\n\n${text}`;
}

/** What the daemon looks for in the row the session writes for the turn this message
 *  caused (§6.3): a turn is only proof of delivery when it is THIS message's turn. */
export const inboxMark = (id: string): string => `message ${id.slice(-12)}`;

/** The framed text for the `inbox` lane: `frame()` with that mark in it, since the
 *  message becomes a prompt of the session's own and the daemon has to recognise it
 *  again in the transcript. */
export function frameInbox(text: string, receiver: string, id: string): string {
  return `Message via ${hostOf(receiver)} (sessionpipe control, signed on the sender's device; ${inboxMark(id)}):\n\n${text}`;
}

/** Said with a message a copy of a session is answering, so the model knows the person
 *  is not reading this conversation: a copy is not the thread they are looking at. */
export const COPY_NOTE =
  "You are a copy of that session, started to answer this message: the conversation above is a replay, the original session is somewhere else, and nothing you do here appears in it. Answer the message and stop; don't carry on the original's work.";

/** A new session's first message: the person's words first, where they come from after.
 *  Claude Code names a session from the start of its first message, so a header in front
 *  named every started session "Message via spacesheep.dev (sessionpipe control, s…"
 *  (2026-10-02). In a new session there is no one else's conversation to tell it apart
 *  from, so the source line can follow the ask. */
export function frameStart(text: string, receiver: string): string {
  return `${text}\n\n(Sent via ${hostOf(receiver)} with sessionpipe control, signed on the sender's device.)`;
}

/** The receiver's own host, for a line a person reads; the whole string when it is not
 *  a URL. */
export function hostOf(receiver: string): string {
  try {
    return new URL(receiver).host;
  } catch {
    return receiver;
  }
}
