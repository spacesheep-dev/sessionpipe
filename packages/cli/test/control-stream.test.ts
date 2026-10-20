// SPDX-License-Identifier: Apache-2.0
// The answer as it is written: stream-json lines (shapes recorded from Claude Code
// 2.1.286, haiku) through the parser and the throttled progress sender.
import { describe, expect, it } from "vitest";
import { AnswerStream, streamJsonPiece } from "../src/control/stream.js";

const ev = (event: Record<string, unknown>) => JSON.stringify({ type: "stream_event", event });
const delta = (text: string) => ev({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text } });
const thinking = ev({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hm" } });

describe("streamJsonPiece", () => {
  it("takes text deltas and message starts, ignores thinking and the rest", () => {
    expect(streamJsonPiece(delta("1\n2"))).toEqual({ text: "1\n2" });
    expect(streamJsonPiece(ev({ type: "message_start", message: {} }))).toEqual({ boundary: true });
    expect(streamJsonPiece(thinking)).toBeNull();
    expect(streamJsonPiece(JSON.stringify({ type: "result", result: "x" }))).toBeNull();
    expect(streamJsonPiece("{")).toBeNull();
    const sub = JSON.stringify({ ...JSON.parse(delta("inner")), parent_tool_use_id: "toolu_1" });
    expect(streamJsonPiece(sub)).toBeNull();
  });
});

describe("AnswerStream", () => {
  const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
  it("sends the whole answer so far, seq rising, a new paragraph per message", async () => {
    const sent: [number, string][] = [];
    const s = new AnswerStream(async (t, q) => {
      sent.push([q, t]);
    }, 10);
    s.feed(ev({ type: "message_start" }));
    s.feed(thinking);
    s.feed(delta("Reading "));
    s.feed(delta("the file."));
    await settle();
    s.feed(ev({ type: "message_start" }));
    s.feed(delta("It has one line."));
    await settle();
    s.close();
    expect(sent.at(-1)).toEqual([2, "Reading the file.\n\nIt has one line."]);
    expect(sent.map(([q]) => q)).toEqual([1, 2]);
  });
  it("one in flight: a slow receiver gets the latest text next, not a backlog", async () => {
    const sent: string[] = [];
    let release: () => void = () => {};
    const s = new AnswerStream(async (t) => {
      sent.push(t);
      await new Promise<void>((r) => {
        release = r;
      });
    }, 5);
    s.set("a");
    await settle(20);
    s.set("ab");
    s.set("abc");
    await settle(20);
    expect(sent).toEqual(["a"]);
    release();
    await settle(30);
    release();
    expect(sent).toEqual(["a", "abc"]);
    s.close();
  });
  it("nothing to say is nothing sent: an empty delta, the same text again, only whitespace", async () => {
    const sent: string[] = [];
    const s = new AnswerStream(async (t) => {
      sent.push(t);
    }, 5);
    s.feed(delta(""));
    s.set("   ");
    await settle(20);
    expect(sent).toEqual([]);
    s.set("a");
    s.set("a");
    await settle(20);
    // Trailing whitespace is no new answer.
    s.set("a ");
    await settle(20);
    expect(sent).toEqual(["a"]);
    s.close();
  });
  it("a failed send is not fatal and nothing is sent after close", async () => {
    let n = 0;
    const s = new AnswerStream(async () => {
      n++;
      throw new Error("offline");
    }, 5);
    s.set("x");
    await settle(20);
    s.close();
    s.set("xy");
    await settle(20);
    expect(n).toBe(1);
  });
});
