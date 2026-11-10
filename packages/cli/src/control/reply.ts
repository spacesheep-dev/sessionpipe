// SPDX-License-Identifier: Apache-2.0
// The answer to a message delivered in place (spec/CONTROL.md §6 `prompt`). A waiter, a
// Stop block or the session's own inbox hands the message to the live session, which
// answers in its own turn; the daemon reads that turn from the session's own transcript
// and sends it back as the ack's `reply`, so the person sees the answer where they asked.
//
// Which text is the answer is decided by the message's own mark, never by where the
// transcript happened to end when the message was handed over: the answer is what the
// session wrote AFTER the row that carries the mark (the Stop hook's feedback row, the
// waiter's output, the inbox or channel row), up to the end of the turn that row began.
// A transcript's size at hand-over is only where the search starts. It is not where the
// answer starts: Claude Code writes its rows a moment after the fact, so the last words
// of the turn that was ending land after its Stop hook has already asked, and they were
// sent back as the answer to a message they were written before (2026-11-10).
import { closeSync, openSync, readSync, statSync } from "node:fs";

/** The transcript's size now: where its answer will start. */
export function transcriptEnd(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/** A mark the daemon may recognise a message by: the whole of one, as core's
 *  `messageMark` and route.ts's `channelMark` make them from a ULID — `message` and the
 *  id's last twelve characters, or a channel tag's `message_id` with all twenty-six. The
 *  id is the receiver's and nobody signed it, so a mark is made only from a whole ULID
 *  (the builders answer null for anything else) and is checked again here, where it is
 *  read: a mark made from a shorter id ("message 42") would be found in words anybody
 *  typed. No mark, or one that is not whole, proves nothing and no answer is put down to
 *  it. */
const WHOLE_MARK = /^(?:message [0-9A-HJKMNP-TV-Z]{12}|message_id="[0-9A-HJKMNP-TV-Z]{26}")$/;
const whole = (mark: string | null): mark is string => mark !== null && WHOLE_MARK.test(mark);

/** Who asked for the first turn the transcript gained after a delivery: `ours` — the
 *  message this daemon handed the session in place, recognised by its own mark in the row
 *  the session wrote for it: a peer row for the inbox (the mark is in the text it was
 *  written with), a channel row for `sessionpipe channel` (the tag names the message's
 *  id); `other` — any other turn, the person typing in the same second above all, or
 *  another local process's message. Null while nothing has been written yet.
 *
 *  This is the second half of a delivery's proof. The hook's own `UserPromptSubmit` says
 *  a turn began and carries no text, so on its own it cannot tell this message's turn
 *  from the person's: confirming on it alone acked a delivery that was really a hold,
 *  and then sent the answer to THEIR prompt back to the receiver as the answer to this
 *  message. */
export function firstAsk(file: string, from: number, mark: string | null): "ours" | "other" | null {
  const size = transcriptEnd(file);
  if (size <= from) return null;
  let text: string;
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(Math.min(size - from, 1024 * 1024));
    const n = readSync(fd, buf, 0, buf.length, from);
    text = buf.subarray(0, n).toString("utf8");
  } catch {
    /* v8 ignore next 2 -- readSync throws only on a file that vanished mid-read */
    return null;
  } finally {
    closeSync(fd);
  }
  const cut = text.lastIndexOf("\n");
  if (cut < 0) return null;
  for (const line of text.slice(0, cut).split("\n")) {
    if (!line) continue;
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!promptRow(j)) continue;
    const c = (j.message as { content?: unknown } | undefined)?.content;
    const origin = j.origin as { kind?: unknown; body?: unknown } | undefined;
    const said = `${typeof origin?.body === "string" ? origin.body : ""}\n${rowText(c)}`;
    return (origin?.kind === "peer" || origin?.kind === "channel") && whole(mark) && said.includes(mark)
      ? "ours"
      : "other";
  }
  return null;
}

/** The permission mode the rows written after `from` record — what the turn a relaunch
 *  just ran ACTUALLY ran in, rather than what was asked for (spec/CONTROL.md §6
 *  `prompt`). The last word wins; null when no row says. */
export function ranInMode(file: string, from: number): string | null {
  const size = transcriptEnd(file);
  if (size <= from) return null;
  let text: string;
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(Math.min(size - from, 4 * 1024 * 1024));
    const n = readSync(fd, buf, 0, buf.length, from);
    text = buf.subarray(0, n).toString("utf8");
  } catch {
    /* v8 ignore next 2 -- readSync throws only on a file that vanished mid-read */
    return null;
  } finally {
    closeSync(fd);
  }
  let mode: string | null = null;
  for (const line of text.split("\n")) {
    if (!line.includes('"permissionMode"')) continue;
    try {
      const j = JSON.parse(line) as { permissionMode?: unknown; isSidechain?: unknown };
      if (!j.isSidechain && typeof j.permissionMode === "string" && /^[A-Za-z]{1,40}$/.test(j.permissionMode))
        mode = j.permissionMode;
    } catch {}
  }
  return mode;
}

const rowText = (c: unknown): string => {
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c
    .map((b) => (typeof (b as { text?: unknown })?.text === "string" ? (b as { text: string }).text : ""))
    .join("\n");
};

/** A `user` row that is somebody's words to the session, or the harness's own on their
 *  behalf: not a subagent's, not a compaction's summary, and not a turn's own tool
 *  traffic, which is recorded as `user` rows too. */
function promptRow(j: Record<string, unknown>): boolean {
  if (j.type !== "user" || j.isSidechain || j.isCompactSummary || j.repeatsCompactSummary) return false;
  if (j.toolUseResult !== undefined) return false;
  const c = (j.message as { content?: unknown } | undefined)?.content;
  return !(Array.isArray(c) && c.some((b) => (b as { type?: unknown } | null)?.type === "tool_result"));
}

/** How Claude Code opens the meta row it writes when a Stop hook blocks (2.1.322; the
 *  recorded rows are conformance/transcripts/claude-code/stop-block.jsonl). */
const STOP_BLOCK = "Stop hook feedback:";

/** A row that begins something new in the session: a prompt somebody typed, a command, a
 *  wake by a finished background task, another session's or a channel's message, or a
 *  Stop hook's block (the next message handed over at a Stop, or any other hook's
 *  demand: what the session writes for it is not this message's answer). A meta row the
 *  harness slips into a running turn (an image's size note, a skill's text, a reminder)
 *  is not one: the turn it is in carries on. */
const nextAsk = (j: Record<string, unknown>): boolean =>
  promptRow(j) &&
  (!j.isMeta ||
    typeof (j.origin as { kind?: unknown } | undefined)?.kind === "string" ||
    rowText((j.message as { content?: unknown } | undefined)?.content).startsWith(STOP_BLOCK));

/** Does anything this row says hold `mark`? Every string in it, however deep: the
 *  harness records a hook's words in a `user` row, an attachment and a summary, and a
 *  command's output inside a tool result. */
function carries(row: unknown, mark: string): boolean {
  const todo: unknown[] = [row];
  while (todo.length) {
    const x = todo.pop();
    if (typeof x === "string") {
      if (x.includes(mark)) return true;
    } else if (x && typeof x === "object") todo.push(...Object.values(x));
  }
  return false;
}

/** The answer to ONE message, read row by row from what the session's transcript gained
 *  since the message was handed over.
 *
 *  Nothing counts until the row that carries the message's mark: that row is the session
 *  taking the message, and whatever the transcript gained before it was written for
 *  something else (the last words of the turn that was ending, the turn the person was
 *  in). From there the answer is the session's own assistant text, in order; sidechains
 *  (subagents) are not the session's words. It ends where the turn that row began ends:
 *
 *  - at an assistant row with `stop_reason: "end_turn"` that has text. One model message
 *    can be written as several rows, each with the message's stop reason: when the model
 *    thinks before it answers, Claude Code 2.1.314 writes a thinking row and then the
 *    text, both `end_turn`. A row with no text is not where the answer ends (taking it
 *    for the end acked every such answer with no reply), so a textless one ends the turn
 *    only at whatever follows it;
 *  - at a row that begins something new (`nextAsk`): the next message's turn is not this
 *    one's answer. A row that carries this message's own mark is never that: the harness
 *    records a Stop block in several rows, and in whatever order it writes them they are
 *    all this message being taken;
 *  - at a row the model wrote after `until`, once that is set: the session's own hooks
 *    said the turn ended then, so anything later belongs to what came next. */
export class Answer {
  private readonly parts: string[] = [];
  private textless = false;
  /** The row that carries the mark has been read. */
  anchored = false;
  done = false;
  /** When the session's hooks said the turn ended (epoch ms), once they have. */
  until: number | null = null;

  /** The mark, where there is a whole one (`WHOLE_MARK`): nothing else anchors anything. */
  private readonly mark: string | null;

  constructor(mark: string | null) {
    this.mark = whole(mark) ? mark : null;
  }

  /** There is a mark to find the message's row by. Without one no row is ever its row,
   *  and no text is ever put down to it. */
  get usable(): boolean {
    return this.mark !== null;
  }

  get text(): string {
    return this.parts.join("\n\n");
  }

  feed(line: string): void {
    if (this.done) return;
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (!j || typeof j !== "object") return;
    const mark = this.mark;
    if (mark === null) return;
    if (!this.anchored) {
      // Never an assistant row: the model quoting the mark is not the session taking it.
      if (j.type !== "assistant" && !j.isSidechain && carries(j, mark)) this.anchored = true;
      return;
    }
    if (j.type !== "assistant" || j.isSidechain) {
      // Another row of the same hand-over is not the end of its answer.
      if (!j.isSidechain && carries(j, mark)) return;
      if (this.textless || nextAsk(j)) this.done = true;
      return;
    }
    if (this.until !== null && Date.parse(String(j.timestamp)) > this.until) {
      this.done = true;
      return;
    }
    const m = j.message as { stop_reason?: unknown; content?: unknown } | undefined;
    let said = false;
    if (Array.isArray(m?.content))
      for (const c of m.content as { type?: string; text?: unknown }[])
        if (c?.type === "text" && typeof c.text === "string" && c.text.trim()) {
          this.parts.push(c.text.trim());
          said = true;
        }
    if (m?.stop_reason === "end_turn") {
      if (said) this.done = true;
      else this.textless = true;
    }
  }
}

/** `Answer` over rows already in hand. */
export function answerIn(lines: string[], mark: string | null): { done: boolean; text: string; anchored: boolean } {
  const a = new Answer(mark);
  for (const line of lines) a.feed(line);
  return { done: a.done, text: a.text, anchored: a.anchored };
}

/** After a session's hooks say its turn ended, how long its last rows may still take to
 *  reach the transcript, and how often to look meanwhile. */
const GRACE_MS = 2000;
const GRACE_POLL_MS = 100;

export interface FollowOptions {
  /** What the row that carries this message says (core's `messageMark`, route.ts
   *  `channelMark`), or null: the message has no mark (its id is not one a mark is made
   *  of), so no row can be found for it and nothing the session writes is its answer. */
  mark: string | null;
  /** Which end of a turn, reported by the session's own hooks, is the end of this
   *  message's: `next` — the message was handed over AS a turn ended and continued it (a
   *  Stop block), so the next end is its own, whether or not its row was ever found;
   *  `marked` — only an end that comes once the row carrying the mark has been written (a
   *  waiter's message can land while another turn is still running). A message with no
   *  mark has no such row to wait for: the next end settles it, with no answer, rather
   *  than leaving its ack to the limit. */
  end: "next" | "marked";
  timeoutMs: number;
  graceMs?: number;
  pollMs?: number;
  now?: () => number;
  /** The answer so far, each time it grows (for the progress ack). */
  onText?: (text: string) => void;
}

export interface Following {
  /** The answer once its turn has ended, or null: nothing was said, the row that carries
   *  the mark never appeared, the transcript was rewritten or can't be read, or the turn
   *  outlasted `timeoutMs`. Never text that cannot be put down to this message, and never
   *  a rejection. */
  answer: Promise<string | null>;
  /** The session's own hooks reported the end of a turn (its Stop, a failed turn, the
   *  session's end). */
  turnEnded(): void;
}

/** Follow the transcript from `from` (its size when the message was handed over) for the
 *  answer to the message that carries `mark`. The answer is complete when its rows say
 *  so (`Answer`); the session's hooks saying the turn ended settle it otherwise, after a
 *  short grace for the rows still on their way, with whatever the turn did say. */
export function follow(file: string, from: number, o: FollowOptions): Following {
  const now = o.now ?? Date.now;
  const poll = o.pollMs ?? 500;
  const grace = o.graceMs ?? GRACE_MS;
  const deadline = now() + o.timeoutMs;
  const a = new Answer(o.mark);
  let offset = from;
  let rest: Buffer = Buffer.alloc(0);
  let gone = false;
  let said = "";
  let overAt: number | null = null;
  let wake = (): void => {};
  /** Read what the transcript has gained, whole rows only. */
  const drain = (): void => {
    const size = transcriptEnd(file);
    // Rewritten under us: nothing in it can be trusted to follow what was read.
    if (size < offset) gone = true;
    if (size <= offset) return;
    let fd: number | null = null;
    try {
      fd = openSync(file, "r");
      const buf = Buffer.alloc(Math.min(size - offset, 4 * 1024 * 1024));
      const n = readSync(fd, buf, 0, buf.length, offset);
      offset += n;
      let chunk: Buffer = rest.length ? Buffer.concat([rest, buf.subarray(0, n)]) : buf.subarray(0, n);
      for (let nl = chunk.indexOf(10); nl >= 0; nl = chunk.indexOf(10)) {
        a.feed(chunk.subarray(0, nl).toString("utf8"));
        chunk = chunk.subarray(nl + 1);
      }
      rest = Buffer.from(chunk);
    } catch {
      // It can no longer be read (gone, unreadable, no longer a file): no answer from it.
      gone = true;
    } finally {
      if (fd !== null) closeSync(fd);
    }
    if (a.text !== said) {
      said = a.text;
      o.onText?.(said);
    }
  };
  const answer = (async (): Promise<string | null> => {
    for (;;) {
      drain();
      if (gone) return null;
      if (a.done) return a.text || null;
      const t = now();
      // The turn is over and its rows have had their time: what it said is the answer.
      if (overAt !== null && t - overAt >= grace) return a.text || null;
      if (t >= deadline) return null;
      await new Promise<void>((res) => {
        const timer = setTimeout(res, overAt === null ? poll : Math.min(poll, GRACE_POLL_MS));
        timer.unref?.();
        wake = () => {
          clearTimeout(timer);
          res();
        };
      });
    }
  })();
  return {
    answer,
    turnEnded(): void {
      if (overAt !== null) return;
      drain();
      // A turn that ended before the session took this message was not this message's.
      if (o.end === "marked" && a.usable && !a.anchored) return;
      overAt = now();
      a.until = overAt;
      wake();
    },
  };
}
