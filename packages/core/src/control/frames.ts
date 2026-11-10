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

/** What held a session when a copy of it was made instead (CONTROL.md §6, What counts as
 *  held), as the machine found it: a window the person has it open in, another process's
 *  run of it, or only a write to its transcript too recent to account for. */
export const COPY_WHYS = ["open", "running", "recent"] as const;
export type CopyWhy = (typeof COPY_WHYS)[number];

/** Said with a message a copy of a session is answering, so the model knows its reply is
 *  the only part the person sees, while its work is as real as the original's. The first
 *  note said "nothing you do here appears in it … don't carry on the original's work", and
 *  a copy asked to change a page answered that a copy can't publish (2026-11-05). Why
 *  there is a copy is said as the machine found it: an original that is open in a
 *  window, or one that something else is using. */
export const copyNote = (why: CopyWhy): string =>
  `You are a copy of that session, started because the original is ${why === "open" ? "open in a window" : "in use by another process"}, and you have its conversation, folder and tools. Do what the message asks the way the original would: edits, commands and publishing all take effect for real. Only this conversation stays here, so the person reads your reply and not the original's${why === "open" ? " window" : ""}: say what you did, then stop.`;

/** Said after a message `sessionpipe wait` prints (CONTROL.md §8), so the session starts
 *  the waiter again. */
export const RE_ARM =
  "(Answer it right here, as you would answer the person at the keyboard: your reply is sent back to them automatically, so don't run a command or call a tool just to send it. Then, without mentioning it, start `sessionpipe wait` again as a background command, with the longest timeout your harness allows, to keep receiving messages.)";

/** The framed text a session receives (CONTROL.md §6): the model and the person can tell
 *  where it came from. */
export function frame(text: string, receiver: string): string {
  return `Message via ${hostOf(receiver)} (sessionpipe control, signed on the sender's device):\n\n${text}`;
}

/** What the daemon looks for in the row the session's transcript records for a message
 *  handed to it in place (§6 `prompt`, §6.3): a turn is only proof of delivery when it is
 *  THIS message's turn, and only what the session wrote after that row is its answer. */
export const messageMark = (id: string): string => `message ${id.slice(-12)}`;

/** The framed text for a message handed to a live session in place — at its Stop, to
 *  its waiter, into its inbox: `frame()` with that mark in it, since the session answers
 *  in a turn of its own and the daemon has to recognise the message again in the
 *  transcript to know which words are its answer. */
export function frameMarked(text: string, receiver: string, id: string): string {
  return `Message via ${hostOf(receiver)} (sessionpipe control, signed on the sender's device; ${messageMark(id)}):\n\n${text}`;
}

/** A new session's first message: the person's words first, where they come from after
 *  (Claude Code names a session from the start of its first message). */
export function frameStart(text: string, receiver: string): string {
  return `${text}\n\n(Sent via ${hostOf(receiver)} with sessionpipe control, signed on the sender's device.)`;
}

/** What a session another session asked receives (CONTROL.md §13), new or not: the task
 *  first, then who asked and that the answer travels by itself. Handed to a live session
 *  in place it names the message too (`mark`), which is how the daemon finds the answer
 *  in that session's transcript. */
export function frameAsk(text: string, from: string | undefined, mark?: string): string {
  return `${text}\n\n(Asked by ${from ?? "another session"} on this machine with sessionpipe ask${mark ? `, ${mark}` : ""}. Answer here in full: your reply is returned to that session automatically. Don't run a command or call a tool just to send it.)`;
}

/** A handoff's answer as it lands in `reply_to` (CONTROL.md §6). `from` is the session
 *  that answered, as a person reads it (`<harness>:<short id>`). */
export function frameHandoff(from: string, receiver: string, reply: string): string {
  return `Answer from ${from} (sessionpipe handoff, asked via ${hostOf(receiver)}):\n\n${reply}`;
}

/** A line a builder above writes, as a test for it: the builder is run with a mark where
 *  the host, the id or the asker goes, and the mark becomes `hole`. */
const HOLE = "\u0000";
/** Where a message's own mark goes (`messageMark`), in a line that has another hole too. */
const MARK = "\u0001";
const lineOf = (built: string, hole = "(\\S+)"): RegExp =>
  new RegExp(
    `^${built
      .trim()
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replaceAll(HOLE, hole)
      .replaceAll(MARK, "message \\S+")}$`,
  );

// Where each builder puts its own line in the text a session gets, which is the only
// place `deliveredWords` looks for it. A new wording (an ask that names its message,
// another note to a copy) is one more entry in the list its builder belongs to.
/** The first paragraph, the words after it: `frame`, `frameMarked`. */
const HEAD_LINES = [lineOf(frame("", HOLE)), lineOf(frameMarked("", HOLE, HOLE))];
/** The last paragraph, the words before it: `frameStart`. */
const START_LINES = [lineOf(frameStart("", HOLE))];
/** The last paragraph, the task before it: `frameAsk`. Whoever asked is named as it gave
 *  itself, a session reference or "another session". */
const ASK_LINES = [lineOf(frameAsk("", HOLE), "[^\\n]{1,300}")];
/** The same paragraph where the ask was handed to a live session in place and names its
 *  message: who asked is captured, so the plain paragraph can be put back. */
const MARKED_ASK_LINES = [lineOf(frameAsk("", HOLE, MARK), "([^\\n]{1,300}?)")];
/** The first paragraph, the answer after it: `frameHandoff`. */
const HANDOFF_LINES = [lineOf(frameHandoff(HOLE, HOLE, ""))];
/** What a copy is told, in each of its forms (two today: an original open in a window,
 *  and one something else is using). */
const COPY_NOTES = [...new Set(COPY_WHYS.map(copyNote))];
/** What the daemon may add, once, after the words of a message a receiver sent
 *  (control/daemon.ts: a Stop hook's block and the inbox, a copy, a waiter). */
const NOTES = [IN_PLACE_ANSWER, ...COPY_NOTES, RE_ARM];
/** And after an ask or a handoff's answer, whose own lines already say how the answer
 *  travels: a copy, a waiter. */
const ASK_NOTES = [...COPY_NOTES, RE_ARM];

const lineIn = (lines: RegExp[], line: string): RegExpExecArray | null => {
  for (const l of lines) {
    const m = l.exec(line);
    if (m) return m;
  }
  return null;
};

/** A delivered message with sessionpipe's own words taken off: the line that says where
 *  it came from (before the words for a message into a session that exists, after them
 *  for a new session's first), and the one note to the model that may follow the words
 *  (how the answer travels, that the session is a copy, to start the waiter again).
 *
 *  Only where sessionpipe puts them. A sentence is taken off in the place and the form
 *  the daemon builds it in, never because a paragraph somewhere reads like one: a person
 *  can type or paste any of these words, and a prompt that is nothing but one of them is
 *  what the person wrote. So a note comes off only after the words of a text that carries
 *  a frame, a frame's line only with words beside it, and text in no shape the daemon
 *  builds comes back exactly as it was, `delivered: false`. `via` is the receiver's host
 *  when the frame names one.
 *
 *  Kept, because they say whose words these are and not how they travelled: the
 *  paragraph `frameAsk` puts after a task (`(Asked by <session> on this machine with
 *  sessionpipe ask. …)`, in that plain form whether or not the ask named its message on
 *  the way), and the first line of a handoff's answer. The task is an
 *  agent's and the answer is an agent's; a receiver tells them from the person's own
 *  words by exactly those lines, so a text without them would be drawn as something the
 *  person wrote. Kept too, because it is what the message says: the list of attached
 *  files. */
export function deliveredWords(text: string): { text: string; via: string | null; delivered: boolean } {
  const paragraphs = text.split("\n\n");
  const at = (i: number): string => (paragraphs[i] as string).trim();
  const n = paragraphs.length;
  // The words end before a note, when the text ends with one and is more than the note.
  const note = n > 1 && NOTES.includes(at(n - 1)) ? at(n - 1) : null;
  const end = note === null ? n : n - 1;
  const words = (from: number, to: number) => paragraphs.slice(from, to).join("\n\n").trim();
  const head = lineIn(HEAD_LINES, at(0));
  if (head && words(1, end)) return { text: words(1, end), via: head[1] as string, delivered: true };
  const start = note === null ? lineIn(START_LINES, at(n - 1)) : null;
  if (start && words(0, n - 1)) return { text: words(0, n - 1), via: start[1] as string, delivered: true };
  // An agent's task and an agent's answer keep the line that says so; a note after it goes.
  const asks = note === null || ASK_NOTES.includes(note);
  const theirs =
    asks && ((lineIn(ASK_LINES, at(end - 1)) && words(0, end - 1)) || (lineIn(HANDOFF_LINES, at(0)) && words(1, end)));
  if (theirs) return { text: note === null ? text : words(0, end), via: null, delivered: true };
  // An ask handed to a live session in place names its message as well. Who asked is
  // kept, in the paragraph every ask has; the mark said how the task travelled, and goes.
  const marked = asks ? lineIn(MARKED_ASK_LINES, at(end - 1)) : null;
  if (marked && words(0, end - 1))
    return { text: `${words(0, end - 1)}${frameAsk("", marked[1] as string)}`, via: null, delivered: true };
  return { text, via: null, delivered: false };
}
