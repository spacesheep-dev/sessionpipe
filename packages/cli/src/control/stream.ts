// SPDX-License-Identifier: Apache-2.0
// The answer as it is written (spec/CONTROL.md §10, the `progress` ack). A headless run
// streams Claude Code's output (`--output-format stream-json --include-partial-
// messages`) and a live session's transcript grows message by message; either way the
// daemon sends the receiver the answer SO FAR, whole, with a rising seq. Reliability
// comes from that shape, not from delivery: a progress ack is fire-and-forget, a lost
// one is covered by the next, and the final `delivered` ack always carries the full
// answer. At most one is in flight, at most one every `everyMs`.

/** One stream-json line → text to append, or a message boundary (a new assistant
 *  message after a tool step: its text starts a new paragraph). */
export function streamJsonPiece(line: string): { text?: string; boundary?: boolean } | null {
  let j: {
    type?: string;
    parent_tool_use_id?: unknown;
    event?: { type?: string; delta?: { type?: string; text?: unknown } };
  };
  try {
    j = JSON.parse(line);
  } catch {
    return null;
  }
  if (j.type !== "stream_event" || !j.event) return null;
  // A subagent's stream (a Task tool's) is not the session's answer.
  if (j.parent_tool_use_id) return null;
  const e = j.event;
  if (e.type === "content_block_delta" && e.delta?.type === "text_delta" && typeof e.delta.text === "string")
    return { text: e.delta.text };
  if (e.type === "message_start") return { boundary: true };
  return null;
}

export class AnswerStream {
  private text = "";
  private sent = "";
  private seq = 0;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private closed = false;

  constructor(
    private readonly send: (text: string, seq: number) => Promise<void>,
    private readonly everyMs = 400,
  ) {}

  /** A stream-json line from a headless run. */
  feed(line: string): void {
    const p = streamJsonPiece(line);
    if (!p) return;
    if (p.boundary) {
      if (this.text && !this.text.endsWith("\n\n")) this.text += "\n\n";
      return;
    }
    if (p.text) {
      this.text += p.text;
      this.schedule();
    }
  }

  /** The whole answer so far (a live session's transcript). */
  set(text: string): void {
    if (text === this.text) return;
    this.text = text;
    this.schedule();
  }

  /** The answer as far as it has been written: what a turn stopped midway had said. */
  get soFar(): string {
    return this.text.trim();
  }

  /** No more progress: the final ack follows. */
  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (this.closed || this.timer || this.inFlight) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.everyMs);
    this.timer.unref?.();
  }

  private async flush(): Promise<void> {
    const t = this.text.trim();
    if (this.closed || !t || t === this.sent) return;
    this.inFlight = true;
    this.sent = t;
    try {
      await this.send(t, ++this.seq);
    } catch {
      // Best effort: the next one, or the final ack, carries everything.
    } finally {
      this.inFlight = false;
    }
    if (this.text.trim() !== this.sent) this.schedule();
  }
}
