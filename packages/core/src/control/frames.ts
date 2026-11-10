// SPDX-License-Identifier: Apache-2.0
// The words sessionpipe puts around a message it delivers to a session (spec/CONTROL.md
// §6, §8, §13), in one place: whoever delivers a message builds them here, and the
// transcript readers take them off again with `deliveredWords`, so the `user` side of a
// turn is what the person wrote and never what the machine wrote around it. The shapes
// `deliveredWords` knows are made from the builders themselves, so a sentence changed
// here is recognised in the same edit. No `node:` imports: this is part of
// sessionpipe-core/control, which a Worker or a browser may import.

/** The receiver's own host, for a line a person reads; the whole string when it is not
 *  a URL. */
export function hostOf(receiver: string): string {
  try {
    return new URL(receiver).host;
  } catch {
    return receiver;
  }
}

/** Said with every message that reaches a live session: the answer goes back by itself
 *  (the daemon reads it from the transcript), so the model never invents a command to
 *  reply with (a real session tried `sessionpipe send`, 2026-10-01). */
export const IN_PLACE_ANSWER =
  "Answer it right here, as you would answer the person at the keyboard: your reply is sent back to them automatically. Don't run a command or call a tool just to send it.";

/** Said with a message a copy of a session is answering, so the model knows its reply is
 *  the only part the person sees, while its work is as real as the original's. */
export const COPY_NOTE =
  "You are a copy of that session, started because the original is open in a window, and you have its conversation, folder and tools. Do what the message asks the way the original would: edits, commands and publishing all take effect for real. Only this conversation stays here, so the person reads your reply and not the original's window: say what you did, then stop.";

/** Said after a message `sessionpipe wait` prints (CONTROL.md §8), so the session starts
 *  the waiter again. */
export const RE_ARM =
  "(Answer it right here, as you would answer the person at the keyboard: your reply is sent back to them automatically, so don't run a command or call a tool just to send it. Then, without mentioning it, start `sessionpipe wait` again as a background command, with the longest timeout your harness allows, to keep receiving messages.)";

/** The framed text a session receives (CONTROL.md §6): the model and the person can tell
 *  where it came from. */
export function frame(text: string, receiver: string): string {
  return `Message via ${hostOf(receiver)} (sessionpipe control, signed on the sender's device):\n\n${text}`;
}

/** What the daemon looks for in the row a session writes for the turn an inbox message
 *  caused (§6.3): a turn is only proof of delivery when it is THIS message's turn. */
export const inboxMark = (id: string): string => `message ${id.slice(-12)}`;

/** The framed text for the `inbox` lane: `frame()` with that mark in it. */
export function frameInbox(text: string, receiver: string, id: string): string {
  return `Message via ${hostOf(receiver)} (sessionpipe control, signed on the sender's device; ${inboxMark(id)}):\n\n${text}`;
}

/** A new session's first message: the person's words first, where they come from after
 *  (Claude Code names a session from the start of its first message). */
export function frameStart(text: string, receiver: string): string {
  return `${text}\n\n(Sent via ${hostOf(receiver)} with sessionpipe control, signed on the sender's device.)`;
}

/** What a session another session asked receives (CONTROL.md §13): the task first, then
 *  who asked and that the answer travels by itself. */
export function frameAsk(text: string, from: string | undefined): string {
  return `${text}\n\n(Asked by ${from ?? "another session"} on this machine with sessionpipe ask. Answer here in full: your reply is returned to that session automatically. Don't run a command or call a tool just to send it.)`;
}

/** A handoff's answer as it lands in `reply_to` (CONTROL.md §6). `from` is the session
 *  that answered, as a person reads it (`<harness>:<short id>`). */
export function frameHandoff(from: string, receiver: string, reply: string): string {
  return `Answer from ${from} (sessionpipe handoff, asked via ${hostOf(receiver)}):\n\n${reply}`;
}

/** A line a builder above writes, as a test for it: the builder is run with a mark where
 *  the host, the id or the asker goes, and the mark becomes `hole`. */
const HOLE = "\u0000";
const lineOf = (built: string, hole = "(\\S+)"): RegExp =>
  new RegExp(
    `^${built
      .trim()
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replaceAll(HOLE, hole)}$`,
  );
const FRAME_LINE = lineOf(frame("", HOLE));
const INBOX_LINE = lineOf(frameInbox("", HOLE, HOLE));
const START_LINE = lineOf(frameStart("", HOLE));
/** Whoever asked is named as it gave itself: a session reference, or "another session". */
const ASK_LINE = lineOf(frameAsk("", HOLE), "[^\\n]{1,300}");
const HANDOFF_LINE = lineOf(frameHandoff(HOLE, HOLE, ""));

/** A delivered message with sessionpipe's own words taken off, wherever they sit: the
 *  line that says where it came from (before the words for a message into a running
 *  session, after them for a new session's first), and the notes to the model that follow
 *  it (how the answer travels, that the session is a copy, to start the waiter again, who
 *  asked). Each is a paragraph of its own, as the builders above write it, so the words
 *  between them are untouched. `via` is the receiver's host when a line named one, and
 *  `delivered` is whether sessionpipe wrote anything at all here: text it did not touch
 *  comes back as it was.
 *
 *  Kept, because they are what the message says and not how it travelled: the list of
 *  attached files, and the first line of a handoff's answer, which is the only thing that
 *  says the words after it are another agent's and not the person's. */
export function deliveredWords(text: string): { text: string; via: string | null; delivered: boolean } {
  let via: string | null = null;
  let delivered = false;
  const words = text.split("\n\n").filter((paragraph) => {
    const line = paragraph.trim();
    const from = FRAME_LINE.exec(line) ?? INBOX_LINE.exec(line) ?? START_LINE.exec(line);
    if (from) via ??= from[1] as string;
    const ours = !!from || line === IN_PLACE_ANSWER || line === COPY_NOTE || line === RE_ARM || ASK_LINE.test(line);
    if (ours || HANDOFF_LINE.test(line)) delivered = true;
    return !ours;
  });
  return delivered ? { text: words.join("\n\n").trim(), via, delivered } : { text, via, delivered };
}
