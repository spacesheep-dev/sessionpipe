// SPDX-License-Identifier: Apache-2.0
// The answer to a message delivered in place (spec/CONTROL.md §6 `prompt`). A waiter or
// a Stop block hands the message to the live session, which answers in its own turn;
// the daemon reads that turn from the session's own transcript and sends it back as the
// ack's `reply`, so the person sees the answer where they asked. Only the bytes the
// transcript gained after the delivery are read: a long session's file is never parsed
// whole, and nothing from before the message can be mistaken for its answer.
import { closeSync, openSync, readSync, statSync } from "node:fs";

/** The transcript's size now: where its answer will start. */
export function transcriptEnd(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/** Who asked for the first turn the transcript gained after a delivery: `peer` — the
 *  message this daemon wrote into the session's own inbox, recognised by the mark in the
 *  text it was written with; `other` — any other turn, the person typing in the same
 *  second above all, or another local process's peer message. Null while nothing has
 *  been written yet.
 *
 *  This is the second half of a delivery's proof. The hook's own `UserPromptSubmit` says
 *  a turn began and carries no text, so on its own it cannot tell this message's turn
 *  from the person's: confirming on it alone acked a delivery that was really a hold,
 *  and then sent the answer to THEIR prompt back to the receiver as the answer to this
 *  message. */
export function firstAsk(file: string, from: number, mark: string): "peer" | "other" | null {
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
    if (j.type !== "user" || j.isSidechain || j.isCompactSummary || j.repeatsCompactSummary) continue;
    // A turn's own tool traffic is recorded as `user` records too; they are not asks.
    if (j.toolUseResult !== undefined) continue;
    const c = (j.message as { content?: unknown } | undefined)?.content;
    if (Array.isArray(c) && c.some((b) => (b as { type?: unknown } | null)?.type === "tool_result")) continue;
    const origin = j.origin as { kind?: unknown; body?: unknown } | undefined;
    const said = `${typeof origin?.body === "string" ? origin.body : ""}\n${rowText(c)}`;
    return origin?.kind === "peer" && said.includes(mark) ? "peer" : "other";
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

/** Claude Code records after the delivery → the turn's answer once the turn ended
 *  (an assistant record with `stop_reason: "end_turn"`), else null. The answer is the
 *  turn's assistant text, in order; sidechains (subagents) are not the session's words.
 *
 *  One model message can be written as several records, and every one carries the
 *  message's stop reason: when the model thinks before it answers, Claude Code 2.1.314
 *  writes a thinking record and then the text, both `end_turn`. A record with no text is
 *  not where the answer ends — taking it for the end acked every such answer with no
 *  reply. The turn is over at the `end_turn` record that has text, or at whatever follows
 *  a textless one (a turn that ended with nothing said). */
export function answerIn(lines: string[]): { done: boolean; text: string } {
  const parts: string[] = [];
  let ended = false;
  for (const line of lines) {
    let j: {
      type?: string;
      isSidechain?: boolean;
      message?: { stop_reason?: string; content?: unknown };
    };
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (j.type !== "assistant" || j.isSidechain) {
      if (ended) return { done: true, text: parts.join("\n\n") };
      continue;
    }
    let said = false;
    const content = j.message?.content;
    if (Array.isArray(content))
      for (const c of content as { type?: string; text?: unknown }[])
        if (c?.type === "text" && typeof c.text === "string" && c.text.trim()) {
          parts.push(c.text.trim());
          said = true;
        }
    if (j.message?.stop_reason === "end_turn") {
      if (said) return { done: true, text: parts.join("\n\n") };
      ended = true;
    }
  }
  return { done: false, text: parts.join("\n\n") };
}

/** Wait for the turn that follows a delivery to end, reading the transcript from
 *  `from` (its size at delivery). Resolves the answer, or null when the turn doesn't
 *  end within `timeoutMs` (an interrupted turn, a session closed mid-answer). */
export async function awaitAnswer(
  file: string,
  from: number,
  o: {
    timeoutMs: number;
    pollMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    /** The turn's text so far, each time it grows (for the progress ack). */
    onText?: (text: string) => void;
  },
): Promise<string | null> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.()));
  const until = now() + o.timeoutMs;
  let offset = from;
  let partial = "";
  const lines: string[] = [];
  while (now() < until) {
    const size = transcriptEnd(file);
    if (size < offset) return null; // rewritten under us: nothing we can trust
    if (size > offset) {
      const fd = openSync(file, "r");
      try {
        const buf = Buffer.alloc(Math.min(size - offset, 4 * 1024 * 1024));
        const n = readSync(fd, buf, 0, buf.length, offset);
        offset += n;
        const chunk = partial + buf.subarray(0, n).toString("utf8");
        const cut = chunk.lastIndexOf("\n");
        partial = cut < 0 ? chunk : chunk.slice(cut + 1);
        if (cut >= 0) lines.push(...chunk.slice(0, cut).split("\n").filter(Boolean));
      } finally {
        closeSync(fd);
      }
      const a = answerIn(lines);
      if (a.done) return a.text || null;
      if (a.text) o.onText?.(a.text);
    }
    await sleep(o.pollMs ?? 500);
  }
  return null;
}
