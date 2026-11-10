// SPDX-License-Identifier: Apache-2.0
// The routing rule (spec/CONTROL.md §6): the first delivery mode that fits, top to
// bottom. Pure, so every branch is a unit test.
import { acpControl, shortId } from "@sessionpipe/core";
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
  /** The harness's binary was found at all (Claude Code only; absent means yes). A
   *  missing binary reads as no capabilities, which used to be blamed on `--fork-session`. */
  installed?: boolean;
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
/** Said when no `claude` can be found: at daemon start, in a failed ack, and where a
 *  missing binary would otherwise read as a Claude Code without `--fork-session`. */
export const CLAUDE_NOT_FOUND =
  "Claude Code not found on this computer: no `claude` on the daemon's PATH or in the usual folders (nvm, fnm, volta, asdf, Homebrew, ~/.local/bin, the desktop app). Run `sessionpipe connect` again from a shell where `claude` works, or set SESSIONPIPE_CLAUDE to its path in the daemon's service file";

export function routePrompt(s: SessionView): Route {
  for (const mode of DELIVERY_LADDER) if (FITS[mode](s)) return { mode };
  if (!HEADLESS.has(s.harness)) return { unsupported: `no idle delivery for ${s.harness} yet` };
  if (!s.known) return { refused: "no_session" };
  if (s.harness === "claude-code" && s.installed === false) return { unsupported: CLAUDE_NOT_FOUND };
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
): "prompt" | "permission" | "cancel" | "start" | "pool" | { unsupported: string } {
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
    // No session at all (`sessionpipe:pool`): the machine's pool, whatever harness is asked.
    case "pool":
      return "pool";
    default:
      return { unsupported: `unknown kind ${String(kind)}` };
  }
}

/** What a `cancel` finds when it looks at the session (CONTROL.md §6 `cancel`). */
export interface CancelView {
  harness: string;
  /** The daemon holds the session (the Agent SDK, an ACP agent): its own interrupt. */
  held: boolean;
  /** The daemon is running a headless turn for it as its own child process. */
  own: boolean;
  /** A live interactive Claude Code process holds it: a terminal window, the Claude app. */
  open: boolean;
  /** A live Claude Code process of another kind holds it (a `claude -p` someone else
   *  started): its pid. */
  foreign: number | null;
  /** The session's own hooks say a turn is running. */
  midTurn: boolean;
}

/** A `cancel`'s `detail`, case by case: what was stopped, or why nothing could be, in
 *  words the person who pressed Stop can act on. A receiver shows them as they are. */
export const CANCEL = {
  stopped: "stopped the turn this computer was running for that session",
  finished: "the turn this computer was running for that session finished before it could be stopped",
  open: "that session is open in Claude Code on this computer (a terminal window or the Claude app), and a turn there can only be stopped in its own window: press Esc there",
  foreign: (pid: number) =>
    `a Claude Code process this computer's daemon didn't start is running that session (pid ${pid}), and the daemon only stops turns it runs itself: stop it where it was started`,
  unseen:
    "a turn is running in that session, in a process this computer's daemon didn't start and can't find: stop it where it runs",
  nothing: "nothing is running in that session as far as this computer can tell, so there was nothing to stop",
  other: (harness: string) =>
    `this computer's daemon isn't running that ${harness} session, and it has no way to stop a turn it didn't start: stop it in ${harness} itself`,
} as const;

export type CancelRoute = { stop: "held" | "own" } | { outcome: "unsupported" | "expired"; detail: string };

/** What a `cancel` does (CONTROL.md §6 `cancel`). The daemon stops what is its own to
 *  stop — a session it holds, through that session's interrupt; a headless turn it runs,
 *  by ending the child process it spawned — and nothing else: a turn in a process it did
 *  not start is that process's own, and is never signalled. There the ack says who has
 *  it, which is what the person needs to stop it themselves; and a session nothing is
 *  running in is `expired`: the turn ended before the Stop arrived. Only Claude Code
 *  files a registry this can be read from, so any other harness's session is
 *  `unsupported` whatever its hooks last said. */
export function routeCancel(s: CancelView): CancelRoute {
  if (s.held) return { stop: "held" };
  if (s.own) return { stop: "own" };
  if (s.harness !== "claude-code") return { outcome: "unsupported", detail: CANCEL.other(s.harness) };
  if (s.open) return { outcome: "unsupported", detail: CANCEL.open };
  if (s.foreign !== null) return { outcome: "unsupported", detail: CANCEL.foreign(s.foreign) };
  if (s.midTurn) return { outcome: "unsupported", detail: CANCEL.unseen };
  return { outcome: "expired", detail: CANCEL.nothing };
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

/** frame() undone: the person's words, and the host they were sent from. A channel shows
 *  the words as the message and says where they came from beside it. Text that frame()
 *  didn't make comes back whole, from nowhere. */
export function unframe(text: string): { text: string; via: string | null } {
  const m = /^Message via (\S+) \(sessionpipe control, signed on the sender's device\):\n\n/.exec(text);
  return m ? { text: text.slice(m[0].length), via: m[1] as string } : { text, via: null };
}

/** What the daemon looks for in the row the session writes for the turn this message
 *  caused (§6.3): a turn is only proof of delivery when it is THIS message's turn. */
export const inboxMark = (id: string): string => `message ${id.slice(-12)}`;

/** The same for a channel's message (§8): `sessionpipe channel` names the message's id on
 *  its `<channel>` tag, and Claude Code writes the tag into the row of the turn it causes. */
export const channelMark = (id: string): string => `message_id="${id}"`;

/** The framed text for the `inbox` lane: `frame()` with that mark in it, since the
 *  message becomes a prompt of the session's own and the daemon has to recognise it
 *  again in the transcript. */
export function frameInbox(text: string, receiver: string, id: string): string {
  return `Message via ${hostOf(receiver)} (sessionpipe control, signed on the sender's device; ${inboxMark(id)}):\n\n${text}`;
}

/** Said with a message a copy of a session is answering, so the model knows its reply is
 *  the only part the person sees, while its work is as real as the original's. The first
 *  note said "nothing you do here appears in it … don't carry on the original's work", and
 *  a copy asked to change a page answered that a copy can't publish (2026-11-05). */
export const COPY_NOTE =
  "You are a copy of that session, started because the original is open in a window, and you have its conversation, folder and tools. Do what the message asks the way the original would: edits, commands and publishing all take effect for real. Only this conversation stays here, so the person reads your reply and not the original's window: say what you did, then stop.";

/** A new session's first message: the person's words first, where they come from after.
 *  Claude Code names a session from the start of its first message, so a header in front
 *  named every started session "Message via spacesheep.dev (sessionpipe control, s…"
 *  (2026-10-02). In a new session there is no one else's conversation to tell it apart
 *  from, so the source line can follow the ask. */
export function frameStart(text: string, receiver: string): string {
  return `${text}\n\n(Sent via ${hostOf(receiver)} with sessionpipe control, signed on the sender's device.)`;
}

/** What a session another session asked receives (CONTROL.md §13), new or not: the task
 *  first, as frameStart puts it, then who asked and that the answer travels by itself. */
export function frameAsk(text: string, from: string | undefined): string {
  return `${text}\n\n(Asked by ${from ?? "another session"} on this machine with sessionpipe ask. Answer here in full: your reply is returned to that session automatically. Don't run a command or call a tool just to send it.)`;
}

/** A handoff's answer as it lands in `reply_to` (CONTROL.md §6): who answered, in the
 *  short form the receivers label sessions by, and which receiver the person asked through. */
export function frameHandoff(from: { harness: string; id: string }, receiver: string, reply: string): string {
  return `Answer from ${from.harness}:${shortId(from.harness, from.id)} (sessionpipe handoff, asked via ${hostOf(receiver)}):\n\n${reply}`;
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
