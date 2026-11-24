// What a session is told about its copies (CONTROL.md §6 `fork`). A message the daemon
// could not hand to a session in place runs in a copy of it; nothing the copy does shows
// in the session's own conversation, so the session went on working beside edits it never
// saw (2026-11-24: a deck's comments were answered by a copy while the session itself kept
// rebuilding the deck). The session's next prompt carries what each copy was asked and
// what it answered, as context: a note, never a request.

import type { CopyNote } from "./store.js";

/** How much later than a copy's last run the session must have been written for the copy
 *  to be out of date. None: a filesystem that keeps mtimes coarsely rounds them down, which
 *  only ever makes a write look older, and a write the copy did see costs no more than one
 *  copy too many. A write while the copy ran is one it never saw (2026-11-24 review). */
export const COPY_STALE_SLACK_MS = 0;

/** Whether a session's copy is out of date (CONTROL.md §6 `fork`; conformance/
 *  control-copy-current.json): the session's transcript was written after a message last
 *  ran in the copy. `lastRan` is the copy record's `used`, else its `at`; a record that
 *  never said when is not out of date, since there is nothing to tell its age by. */
export function copyIsStale(lastRan: string | undefined, sessionWrittenMs: number): boolean {
  const since = Date.parse(lastRan || "");
  if (!Number.isFinite(since)) return false;
  return sessionWrittenMs > since + COPY_STALE_SLACK_MS;
}

/** How much of each message and each answer a note keeps. */
export const COPY_NOTE_ASK_CHARS = 600;
export const COPY_NOTE_REPLY_CHARS = 900;
/** Notes are kept for at most this many sessions; the session noted longest ago drops out. */
export const COPY_NOTE_SESSIONS_KEPT = 50;

/** `s` cut to `n` characters at most, marked where it was cut. */
export function clip(s: string, n: number): string {
  const t = s.trim();
  return t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}…`;
}

/** The context a session's next prompt carries: what its copies were asked and answered
 *  since it was last told, oldest first. */
export function copyNotesText(notes: readonly CopyNote[]): string {
  const n = notes.length;
  const lines = notes.map((x, i) => {
    const when = x.at ? ` (${x.at.slice(0, 16).replace("T", " ")} UTC)` : "";
    return `${i + 1}.${when}\nAsked: ${x.ask || "(nothing readable)"}\nThe copy answered: ${x.reply || "(no answer recorded)"}`;
  });
  return [
    `While this session couldn't be reached in place, sessionpipe ran ${n === 1 ? "a message" : `${n} messages`} for it in a copy of this session. The copy started from an earlier point of this conversation, and what it did (edits, deploys, replies) took effect for real, but none of it is in this conversation. Take it into account; nothing here asks for an answer.`,
    ...lines,
  ].join("\n\n");
}
