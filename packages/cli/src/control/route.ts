// SPDX-License-Identifier: Apache-2.0
// The routing rule (spec/CONTROL.md §6): the first delivery mode that fits, top to
// bottom. Pure, so every branch is a unit test.
import type { ControlKind } from "@sessionpipe/core/control";

export type DeliveryMode = "sdk" | "waiter" | "turn" | "api" | "resume" | "fork";

export interface SessionView {
  harness: string;
  /** The daemon holds this session through the Agent SDK right now. */
  sdk: boolean;
  /** A `sessionpipe wait` for it is parked on the socket. */
  waiter: boolean;
  /** Between a turn's start and its Stop (the Stop hook will ask). */
  midTurn: boolean;
  /** A live process holds the session (registry entry or a fresh transcript write). */
  live: boolean;
  /** The transcript exists on this machine (Codex, Antigravity: the session was placed). */
  known: boolean;
  /** This Claude Code can copy a session (`--fork-session`); no other harness can. */
  canFork: boolean;
  /** The harness has an input API (OpenCode, Codex app-server) — none is wired yet. */
  api: boolean;
}

export type Route = { mode: DeliveryMode } | { unsupported: string } | { refused: "no_session" };

/** The harnesses the daemon can run a turn of by itself: resume an idle session, start a
 *  new one (`claude -p`, `codex exec`, `agy -p`). */
export const HEADLESS = new Set(["claude-code", "codex", "antigravity"]);

/** Where a prompt (or a start) goes. Never two writers on one transcript: a live
 *  session gets a fork, never a resume. */
export function routePrompt(s: SessionView): Route {
  if (s.sdk) return { mode: "sdk" };
  if (s.waiter) return { mode: "waiter" };
  if (s.midTurn) return { mode: "turn" };
  if (s.api) return { mode: "api" };
  if (!HEADLESS.has(s.harness)) return { unsupported: `no idle delivery for ${s.harness} yet` };
  if (!s.known) return { refused: "no_session" };
  if (!s.live) return { mode: "resume" };
  if (s.canFork) return { mode: "fork" };
  return {
    unsupported:
      s.harness === "claude-code"
        ? "the session is open and this Claude Code can't copy it (no --fork-session)"
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
  let host = receiver;
  try {
    host = new URL(receiver).host;
  } catch {}
  return `Message via ${host} (sessionpipe control, signed on the sender's device):\n\n${text}`;
}

/** A new session's first message: the person's words first, where they come from after.
 *  Claude Code names a session from the start of its first message, so a header in front
 *  named every started session "Message via spacesheep.dev (sessionpipe control, s…"
 *  (2026-10-02). In a new session there is no one else's conversation to tell it apart
 *  from, so the source line can follow the ask. */
export function frameStart(text: string, receiver: string): string {
  let host = receiver;
  try {
    host = new URL(receiver).host;
  } catch {}
  return `${text}\n\n(Sent via ${host} with sessionpipe control, signed on the sender's device.)`;
}
