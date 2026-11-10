// SPDX-License-Identifier: Apache-2.0
// The answer to an in-place message, read from the session's own transcript.
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readClaude } from "@sessionpipe/core";
import { describe, expect, it } from "vitest";
import { Answer, answerIn, firstAsk, follow, ranInMode, transcriptEnd } from "../src/control/reply.js";
import { channelMark, frameAsk, kindPath, messageMark, routePrompt } from "../src/control/route.js";

const rec = (o: Record<string, unknown>) => JSON.stringify(o);
const asst = (stop: string, content: unknown[], extra: Record<string, unknown> = {}) =>
  rec({ type: "assistant", message: { stop_reason: stop, content }, ...extra });

describe("firstAsk: which message the turn that just began is for", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "sp-firstask-"));
  const file = path.join(tmp, "t.jsonl");
  const MARK = "message 01K6ABCDEF12";
  /** The rows a delivery's turn gains, written after `from`. */
  const after = (...lines: string[]) => {
    writeFileSync(file, "head\n");
    const from = transcriptEnd(file);
    appendFileSync(file, lines.map((l) => `${l}\n`).join(""));
    return from;
  };
  const peerRow = (o: Record<string, unknown> = {}, text = `… ${MARK} …`) =>
    rec({ type: "user", isMeta: true, origin: { kind: "peer", ...o }, message: { content: [{ type: "text", text }] } });

  it("is the peer row carrying this message's own mark", () => {
    expect(firstAsk(file, after(peerRow()), MARK)).toBe("ours");
    // The parsed body the harness records counts too, and a string content.
    expect(firstAsk(file, after(peerRow({ body: `… ${MARK} …` }, "nothing here")), MARK)).toBe("ours");
    expect(
      firstAsk(file, after(rec({ type: "user", origin: { kind: "peer" }, message: { content: `… ${MARK} …` } })), MARK),
    ).toBe("ours");
    // A block with no text of its own is not where the mark is.
    expect(
      firstAsk(
        file,
        after(
          rec({
            type: "user",
            origin: { kind: "peer" },
            message: { content: [{ type: "image" }, { type: "text", text: `… ${MARK} …` }] },
          }),
        ),
        MARK,
      ),
    ).toBe("ours");
  });

  it("is the channel row whose tag names this message's id", () => {
    const ID = "01K6ABCDEF1234567890ABCDEF";
    const channelRow = (id: string) =>
      rec({
        type: "user",
        isMeta: true,
        origin: { kind: "channel", server: "sessionpipe" },
        message: { content: `<channel source="sessionpipe" via="spacesheep.dev" message_id="${id}">\nhi\n</channel>` },
      });
    expect(firstAsk(file, after(channelRow(ID)), channelMark(ID))).toBe("ours");
    // Another message's row, or a typed one quoting the tag, is not this message's.
    expect(firstAsk(file, after(channelRow("01K6OTHER")), channelMark(ID))).toBe("other");
    expect(firstAsk(file, after(rec({ type: "user", message: { content: channelMark(ID) } })), channelMark(ID))).toBe(
      "other",
    );
  });

  it("is never `ours` on a mark that is not the whole of one, or with no mark at all", () => {
    const short = "message 42";
    expect(firstAsk(file, after(peerRow({}, `… ${short} …`)), short)).toBe("other");
    expect(firstAsk(file, after(peerRow({}, "… null …")), null)).toBe("other");
    expect(
      firstAsk(
        file,
        after(
          rec({
            type: "user",
            isMeta: true,
            origin: { kind: "channel" },
            message: { content: '<channel message_id="7">\nhi\n</channel>' },
          }),
        ),
        'message_id="7"',
      ),
    ).toBe("other");
  });

  it("is `other` for any turn this message did not cause", () => {
    expect(firstAsk(file, after(rec({ type: "user", origin: { kind: "human" } })), MARK)).toBe("other");
    // Another local process's message: a peer row without this message's mark.
    expect(firstAsk(file, after(peerRow({}, "someone else's words")), MARK)).toBe("other");
    expect(firstAsk(file, after(rec({ type: "user" })), MARK)).toBe("other");
  });

  it("is nothing yet while no row says: an unfinished line, no rows at all, only rows that aren't asks", () => {
    writeFileSync(file, "head\n");
    expect(firstAsk(file, transcriptEnd(file), MARK)).toBeNull();
    expect(firstAsk(file, 0, MARK)).toBeNull();
    // A line still being written has no newline yet, so there is no row to read.
    const from = after();
    appendFileSync(file, '{"type":"user"');
    expect(firstAsk(file, from, MARK)).toBeNull();
    expect(
      firstAsk(
        file,
        after(
          "",
          "not json",
          rec({ type: "assistant", message: { content: [] } }),
          rec({ type: "user", isSidechain: true, origin: { kind: "peer" } }),
          rec({ type: "user", isCompactSummary: true }),
          rec({ type: "user", repeatsCompactSummary: true }),
          rec({ type: "user", toolUseResult: {}, origin: { kind: "human" } }),
          rec({ type: "user", message: { content: [{ type: "tool_result" }] } }),
        ),
        MARK,
      ),
    ).toBeNull();
  });
});

describe("ranInMode: what the turn a relaunch ran actually ran in", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "sp-ranin-"));
  const file = path.join(tmp, "t.jsonl");
  it("is the last mode a row after `from` records, and nothing from before it", () => {
    writeFileSync(file, `${rec({ type: "user", permissionMode: "plan" })}\n`);
    const from = transcriptEnd(file);
    expect(ranInMode(file, from)).toBeNull();
    appendFileSync(
      file,
      [
        "not json",
        rec({ type: "user", permissionMode: "acceptEdits" }),
        rec({ type: "user", permissionMode: "bypassPermissions", isSidechain: true }),
        rec({ type: "user", permissionMode: 7 }),
        rec({ type: "user", permissionMode: "not a mode at all!" }),
        rec({ type: "assistant", message: { content: [] } }),
      ]
        .map((l) => `${l}\n`)
        .join(""),
    );
    expect(ranInMode(file, from)).toBe("acceptEdits");
    expect(ranInMode(path.join(tmp, "none.jsonl"), 0)).toBeNull();
  });
});

const MARK = "message 01K6ABCDEF12";
/** The row a session's transcript records for a message handed to it at a Stop
 *  (Claude Code 2.1.322): the hook's words, as a meta `user` row. */
const taken = (mark: string | null = MARK) =>
  rec({ type: "user", isMeta: true, message: { content: `Stop hook feedback:\nMessage via x (…; ${mark}):\n\nhi` } });
const says = (text: string, extra: Record<string, unknown> = {}) => asst("end_turn", [{ type: "text", text }], extra);

describe("a channel's mark (conformance/control-marks.json)", () => {
  const vectors = JSON.parse(
    readFileSync(new URL("../../../conformance/control-marks.json", import.meta.url), "utf8"),
  ) as { cases: { name: string; id: string; mark: string | null; channel: string | null }[] };
  it.each(vectors.cases)("$name", (c) => {
    expect(channelMark(c.id)).toBe(c.channel);
    expect(messageMark(c.id)).toBe(c.mark);
    // What the builders make, the reader takes; what they refuse, it has no row for.
    const tagged = rec({
      type: "user",
      isMeta: true,
      origin: { kind: "channel" },
      message: { content: `<channel message_id=${JSON.stringify(c.id)}>\nhi\n</channel>` },
    });
    expect(answerIn([tagged, says("x")], channelMark(c.id)).anchored).toBe(c.channel !== null);
  });
});

describe("answerIn: which words are the answer to one message", () => {
  it("is what the session wrote after the row that carries the message's mark, and nothing from before it", () => {
    // The last words of the turn that was ending reach the transcript AFTER its Stop
    // hook asked: they are in what the transcript gained, and they are not the answer.
    const lines = [says("`sleep 25` is running in the background."), taken(), says("INTERRUPT1")];
    expect(answerIn(lines.slice(0, 1), MARK)).toEqual({ done: false, text: "", anchored: false });
    expect(answerIn(lines.slice(0, 2), MARK)).toEqual({ done: false, text: "", anchored: true });
    expect(answerIn(lines, MARK)).toEqual({ done: true, text: "INTERRUPT1", anchored: true });
    // Another message's row is not this one's: its answer is never taken.
    expect(answerIn([taken("message 01K6OTHER999"), says("PAGE-B")], MARK)).toEqual({
      done: false,
      text: "",
      anchored: false,
    });
  });
  it("finds the mark wherever the row says it; never in the model's own words or a subagent's", () => {
    const deep = (o: Record<string, unknown>) => answerIn([rec(o), says("ok")], MARK).text;
    // A hook's words as an attachment and as a summary; a command's output in a tool result.
    expect(deep({ type: "attachment", attachment: { blockingError: { blockingError: `… ${MARK}` } } })).toBe("ok");
    expect(deep({ type: "system", subtype: "stop_hook_summary", hookErrors: [`… ${MARK}`] })).toBe("ok");
    expect(
      deep({
        type: "user",
        message: { content: [{ type: "tool_result", content: [{ type: "text", text: `1\t${MARK}` }] }] },
      }),
    ).toBe("ok");
    expect(deep({ type: "user", toolUseResult: { stdout: `x ${MARK} y` }, message: { content: [] } })).toBe("ok");
    // Not a string that holds it, a number, null, or a row that is no object at all.
    expect(deep({ type: "user", n: 7, none: null, list: [1, [2, { k: "message 01K6ABCDEF1" }]] })).toBe("");
    expect(answerIn(["42", "null", '"a string"', says("no")], MARK)).toEqual({
      done: false,
      text: "",
      anchored: false,
    });
    expect(deep({ type: "assistant", message: { content: [{ type: "text", text: `you said ${MARK}` }] } })).toBe("");
    expect(deep({ type: "user", isSidechain: true, message: { content: MARK } })).toBe("");
  });
  it("is not ended by its own mark: the block's other rows, in whatever order the harness writes them", () => {
    // Claude Code 2.1.322 writes the feedback row, then the attachment, then the summary.
    // Written attachment first, the feedback row would read as a new Stop block.
    const attachment = rec({ type: "attachment", attachment: { blockingError: { blockingError: `x (…; ${MARK}):` } } });
    const summary = rec({ type: "system", subtype: "stop_hook_summary", hookErrors: [`x (…; ${MARK}):`] });
    for (const rows of [
      [taken(), attachment, summary],
      [attachment, taken(), summary],
      [summary, attachment, taken()],
    ])
      expect(answerIn([...rows, says("INTERRUPT1")], MARK)).toEqual({ done: true, text: "INTERRUPT1", anchored: true });
    // And after a turn that said nothing: its own rows still don't end it; the next thing does.
    const think = asst("end_turn", [{ type: "thinking", thinking: "" }]);
    expect(answerIn([attachment, think, taken()], MARK).done).toBe(false);
    expect(answerIn([attachment, think, taken(), rec({ type: "system", subtype: "turn_duration" })], MARK).done).toBe(
      true,
    );
  });
  it("a prompt the person typed that quotes the mark is theirs: it ends the answer, and never begins one", () => {
    // The mark is in the header of the message in their own window, so they can type it.
    const quoting = (extra: Record<string, unknown> = {}) =>
      rec({ type: "user", ...extra, message: { content: `what was "${MARK}" about?` } });
    for (const typed of [quoting(), quoting({ origin: { kind: "human" } })]) {
      // After the hand-over it is the next thing asked: what the session says to it was
      // folded into the reply to the message.
      expect(
        answerIn(
          [
            taken(),
            asst("tool_use", [{ type: "text", text: "On it." }]),
            typed,
            says("That was a message from the page."),
          ],
          MARK,
        ),
      ).toEqual({ done: true, text: "On it.", anchored: true });
      // Before any row of the hand-over it is not the session taking the message.
      expect(answerIn([typed, says("their answer")], MARK)).toEqual({ done: false, text: "", anchored: false });
      expect(answerIn([typed, says("their answer"), taken(), says("ours")], MARK).text).toBe("ours");
    }
  });
  it("finds the mark in a row that holds a very long list", () => {
    // Every value of the row is looked at; spread into one call, 120,000 of them were
    // more arguments than a call takes, and the reply was lost with the error.
    const long = rec({
      type: "user",
      isMeta: true,
      message: { content: `Stop hook feedback:\n… ${MARK} …` },
      toolUseIds: Array.from({ length: 300_000 }, () => 0),
    });
    expect(answerIn([long, says("after it")], MARK)).toEqual({ done: true, text: "after it", anchored: true });
    // The same row where it ends nothing: a later row of the same hand-over.
    expect(answerIn([taken(), long, says("after both")], MARK).text).toBe("after both");
  });
  it("a mark that is not the whole of one is no mark: nothing is anchored on it, and nothing is proven by it", () => {
    // The mark is made from the receiver's id for the message, which nobody signed. One
    // that is not a ULID's tail ("42") would be found in words anybody typed.
    const typed = rec({ type: "user", origin: { kind: "human" }, message: { content: "send message 42 times" } });
    // The builders make no mark of such an id; the reader would not take one if they did.
    expect(messageMark("42")).toBeNull();
    expect(channelMark("7")).toBeNull();
    for (const mark of [null, "message 42"])
      expect(answerIn([typed, says("their answer")], mark)).toEqual({ done: false, text: "", anchored: false });
    const peer = rec({
      type: "user",
      isMeta: true,
      origin: { kind: "peer" },
      message: { content: "message 42 for you" },
    });
    expect(answerIn([peer, says("x")], "message 42").anchored).toBe(false);
    // A channel's: the whole id, as the tag carries it.
    const chan = (id: string) =>
      rec({
        type: "user",
        isMeta: true,
        origin: { kind: "channel" },
        message: { content: `<channel message_id="${id}">\nhi\n</channel>` },
      });
    expect(answerIn([chan("7"), says("x")], 'message_id="7"').anchored).toBe(false);
    const whole = "01K6ABCDEF1234567890ABCDEF";
    expect(answerIn([chan(whole), says("x")], channelMark(whole))).toEqual({ done: true, text: "x", anchored: true });
    expect(answerIn([taken(messageMark(whole)), says("y")], messageMark(whole))).toEqual({
      done: true,
      text: "y",
      anchored: true,
    });
    // Anything else handed in as a mark is none.
    expect(answerIn([rec({ type: "user", message: { content: "hello" } }), says("z")], "hello").anchored).toBe(false);
  });
  it("is the turn's text once it ends; tool steps and subagents are not the answer", () => {
    const lines = [
      taken(),
      asst("tool_use", [
        { type: "text", text: "Looking." },
        { type: "tool_use", name: "Read" },
      ]),
      rec({ type: "user", message: { content: [{ type: "tool_result" }] } }),
      asst("end_turn", [{ type: "text", text: "inner" }], { isSidechain: true }),
      asst("end_turn", [{ type: "text", text: "It has one line." }]),
    ];
    expect(answerIn(lines.slice(0, 4), MARK)).toEqual({ done: false, text: "Looking.", anchored: true });
    expect(answerIn(lines, MARK)).toEqual({ done: true, text: "Looking.\n\nIt has one line.", anchored: true });
    // Nothing after the end is read.
    expect(answerIn([...lines, says("another turn")], MARK).text).toBe("Looking.\n\nIt has one line.");
  });
  it("skips lines that aren't JSON, and an assistant row that holds no message", () => {
    expect(answerIn(["{", taken(), "{", rec({ type: "assistant" }), says("ok")], MARK)).toEqual({
      done: true,
      text: "ok",
      anchored: true,
    });
  });
  it("reads past a thinking record that ends the turn to the text written after it", () => {
    // How Claude Code 2.1.314 wrote a turn the model thought about first: one message,
    // two records, both end_turn (a live session on the Intel, 2026-10-30).
    const id = "msg_011CgZPu17RdACuTWfUt8AuK";
    const think = rec({
      type: "assistant",
      message: { id, stop_reason: "end_turn", content: [{ type: "thinking", thinking: "" }] },
    });
    const text = rec({
      type: "assistant",
      message: { id, stop_reason: "end_turn", content: [{ type: "text", text: "BUSY-OK-1" }] },
    });
    expect(answerIn([taken(), think], MARK)).toEqual({ done: false, text: "", anchored: true });
    expect(answerIn([taken(), think, text], MARK)).toEqual({ done: true, text: "BUSY-OK-1", anchored: true });
    // A turn whose last message is all thinking has ended once anything else follows it.
    const after = rec({ type: "system", subtype: "turn_duration" });
    expect(answerIn([taken(), think, after], MARK)).toEqual({ done: true, text: "", anchored: true });
    expect(answerIn([taken(), think, says("a subagent", { isSidechain: true })], MARK).done).toBe(true);
  });
  it("ends where something new begins: the next message's turn is not this one's answer", () => {
    const partial = asst("tool_use", [{ type: "text", text: "On it." }]);
    const ends = (row: Record<string, unknown>) => answerIn([taken(), partial, rec(row), says("NEXT")], MARK);
    // Somebody's prompt, a finished background task's wake, another session's or a channel's message.
    expect(ends({ type: "user", origin: { kind: "human" }, message: { content: "and now this" } })).toEqual({
      done: true,
      text: "On it.",
      anchored: true,
    });
    expect(ends({ type: "user", message: { content: "typed, on an older Claude Code" } }).text).toBe("On it.");
    expect(
      ends({ type: "user", origin: { kind: "task-notification" }, message: { content: "<task-notification>" } }).text,
    ).toBe("On it.");
    expect(ends({ type: "user", isMeta: true, origin: { kind: "peer" }, message: { content: "peer" } }).text).toBe(
      "On it.",
    );
    // The next message handed over at a Stop, or another hook's block: a new demand.
    expect(JSON.parse(taken("message 01K6OTHER999"))).toMatchObject({ isMeta: true });
    expect(answerIn([taken(), partial, taken("message 01K6OTHER999"), says("NEXT")], MARK)).toEqual({
      done: true,
      text: "On it.",
      anchored: true,
    });
    expect(
      ends({
        type: "user",
        isMeta: true,
        message: { content: [{ type: "text", text: "Stop hook feedback:\nrun the linter" }] },
      }).text,
    ).toBe("On it.");
    // What the harness slips into a running turn is part of it: the turn carries on.
    for (const row of [
      { type: "user", isMeta: true, message: { content: "[Image: original 2880x1800, displayed at 2000x1250.]" } },
      { type: "user", isMeta: true, origin: {}, message: { content: "Base directory for this skill: /x" } },
      { type: "user", isCompactSummary: true, message: { content: "summary" } },
      { type: "user", repeatsCompactSummary: true, message: { content: "summary" } },
      { type: "user", toolUseResult: { stdout: "" }, message: { content: "out" } },
      { type: "user", message: { content: [{ type: "tool_result", content: "out" }] } },
      { type: "user", isSidechain: true, message: { content: "a subagent's prompt" } },
      { type: "attachment", attachment: { type: "queued_command", prompt: "also this" } },
      { type: "system", subtype: "stop_hook_summary" },
    ])
      expect(ends(row)).toEqual({ done: true, text: "On it.\n\nNEXT", anchored: true });
  });
  it("ends where the session's hooks said the turn ended: later words belong to what came next", () => {
    const at = Date.parse("2026-11-10T17:03:24.300Z");
    const a = new Answer(MARK);
    a.feed(taken());
    a.feed(asst("tool_use", [{ type: "text", text: "PAGE-A" }], { timestamp: "2026-11-10T17:03:24.240Z" }));
    a.until = at;
    // A row with no time on it can't be told apart, and is taken; a later one ends it.
    a.feed(asst("tool_use", [{ type: "text", text: "(untimed)" }]));
    expect(a.done).toBe(false);
    a.feed(asst("tool_use", [{ type: "text", text: "PAGE-B" }], { timestamp: "2026-11-10T17:03:26.000Z" }));
    expect(a).toMatchObject({ done: true, text: "PAGE-A\n\n(untimed)" });
    a.feed(says("ignored"));
    expect(a.text).toBe("PAGE-A\n\n(untimed)");
  });
});

describe("a Stop block as Claude Code records it (conformance/transcripts/claude-code/stop-block.jsonl)", () => {
  // Recorded on 2.1.322, 2026-11-10: a turn says its last words, its Stop hook is
  // answered with a block carrying a message, the session answers the message, and a
  // background task then wakes it for a turn of its own.
  const rows = readFileSync(
    new URL("../../../conformance/transcripts/claude-code/stop-block.jsonl", import.meta.url),
    "utf8",
  )
    .split("\n")
    .filter(Boolean);
  const mark = messageMark("01K8ZC3W5Q7RN4XJ1V2B6T9M0D");
  const row = (i: number) =>
    JSON.parse(rows[i] as string) as { type: string; isMeta?: boolean; message?: { content?: unknown } };
  it("the answer is the continuation the block caused: not the words before it, not the next turn's", () => {
    // Row 4 is the turn's last message, which reached the transcript after the hook asked;
    // row 5 is the block.
    expect(row(4)).toMatchObject({
      type: "assistant",
      message: { content: [{ text: expect.stringContaining("sleep 25") }] },
    });
    expect(row(5)).toMatchObject({ type: "user", isMeta: true });
    expect(String(row(5).message?.content)).toContain(`Stop hook feedback:\nMessage via spacesheep.dev (`);
    expect(String(row(5).message?.content)).toContain(mark);
    for (const from of [0, 4, 5])
      expect(answerIn(rows.slice(from), mark)).toEqual({ done: true, text: "INTERRUPT1", anchored: true });
    // Handed over after the block's own row (never the case, but nothing is guessed): no answer.
    expect(answerIn(rows.slice(8), mark)).toEqual({ done: false, text: "", anchored: false });
    // Another message's mark is nowhere in it.
    expect(answerIn(rows, messageMark("01K8ZC3W5Q7RN4XJ1V2B6T9M0E")).anchored).toBe(false);
  });
});

describe("an ask handed over at a Stop (conformance/transcripts/claude-code/stop-hook-ask.jsonl)", () => {
  // The rows of stop-block.jsonl, with the block's words being another session's ask: its
  // own paragraph names the message, as a receiver's header does.
  const rows = readFileSync(
    new URL("../../../conformance/transcripts/claude-code/stop-hook-ask.jsonl", import.meta.url),
    "utf8",
  )
    .split("\n")
    .filter(Boolean);
  const ID = "01K8ZC3W5Q7RN4XJ1V2B6T9M0D";
  const FROM = "codex:01a10860-a43f-7ce2-b12f-a7911ae8a880";
  it("the daemon finds its answer by the mark in the ask's own paragraph", () => {
    const fed = (JSON.parse(rows[5] as string) as { message: { content: string } }).message.content;
    expect(fed).toBe(`Stop hook feedback:\n${frameAsk("What is in ci.yml?", FROM, messageMark(ID))}`);
    for (const from of [0, 4, 5])
      expect(answerIn(rows.slice(from), messageMark(ID))).toEqual({
        done: true,
        text: "Three jobs: lint, test and build.",
        anchored: true,
      });
  });
  it("and a reader gives the turn's `user` side as the task and who asked, without the mark", () => {
    const turns = readClaude(rows, 0).turns;
    expect(turns.map((t) => t.assistant)).toEqual([
      "`sleep 25` is running in the background, since this environment blocks foreground sleep. I'll read `docs/api.md` once it finishes.",
      "Three jobs: lint, test and build.",
    ]);
    expect(turns[1]?.user).toBe(frameAsk("What is in ci.yml?", FROM));
    expect(turns[1]?.user).not.toContain("message XJ1V2B6T9M0D");
  });
});

describe("follow: the answer as the transcript gains it", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sp-reply-"));
  let n = 0;
  const fresh = (head = "") => {
    const f = path.join(dir, `t${n++}.jsonl`);
    writeFileSync(f, head);
    return f;
  };
  const add = (f: string, ...lines: string[]) => appendFileSync(f, lines.map((l) => `${l}\n`).join(""));
  const opts = { mark: MARK, end: "next" as const, timeoutMs: 3000, pollMs: 20, graceMs: 150 };
  const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("reads only what the transcript gained after the hand-over, across partial writes", async () => {
    // An earlier turn's end_turn must never be taken for this message's answer.
    const f = fresh(`${says("old answer")}\n`);
    const seen: string[] = [];
    const done = follow(f, transcriptEnd(f), { ...opts, onText: (t) => seen.push(t) }).answer;
    // The turn's last words land late, then the block's row, then the answer in two writes
    // that split a multi-byte character.
    add(f, says("late words of the turn that was ending"), taken());
    const line = Buffer.from(`${says("new answer — done")}\n`);
    const cut = line.indexOf(Buffer.from("—")) + 1;
    appendFileSync(f, line.subarray(0, cut));
    await settle(60);
    appendFileSync(f, line.subarray(cut));
    expect(await done).toBe("new answer — done");
    expect(seen).toEqual(["new answer — done"]);
    // An answer that was whole on the first look; a turn end reported after it changes nothing.
    const whole = follow(f, 0, opts);
    expect(await whole.answer).toBe("new answer — done");
    whole.turnEnded();
    expect(await whole.answer).toBe("new answer — done");
  });
  it("a turn that ended without a word is no answer", async () => {
    const f = fresh();
    add(f, taken(), asst("end_turn", [{ type: "tool_use", name: "Edit" }]));
    // What Claude Code writes once a turn is over: the end is seen, not waited out.
    add(f, rec({ type: "system", subtype: "turn_duration" }));
    const t0 = Date.now();
    expect(await follow(f, 0, opts).answer).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1500);
  });
  it("gives up after its timeout when the turn never ends, with or without its row", async () => {
    const f = fresh();
    add(f, taken(), asst("tool_use", [{ type: "text", text: "working" }]));
    expect(await follow(f, 0, { ...opts, timeoutMs: 150 }).answer).toBeNull();
    // Defaults: the real clock, half-second looks.
    expect(await follow(fresh(), 0, { mark: MARK, end: "next", timeoutMs: 20 }).answer).toBeNull();
  });
  it("the hooks say the turn ended: what it said is the answer, once its last rows had their time", async () => {
    const f = fresh();
    const ff = follow(f, 0, opts);
    add(f, taken(), asst("tool_use", [{ type: "text", text: "Half an answer" }]));
    const t0 = Date.now();
    ff.turnEnded();
    ff.turnEnded();
    // Still on its way when the hook fired: within the grace, it is part of the answer.
    setTimeout(() => add(f, asst("tool_use", [{ type: "text", text: "and the rest." }])), 40);
    expect(await ff.answer).toBe("Half an answer\n\nand the rest.");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
    expect(Date.now() - t0).toBeLessThan(1500);
    // Its own end row arriving in the grace settles it at once.
    const g = fresh();
    const fg = follow(g, 0, { ...opts, graceMs: 5000 });
    add(g, taken());
    fg.turnEnded();
    setTimeout(() => add(g, says("PAGE-A")), 30);
    expect(await fg.answer).toBe("PAGE-A");
  });
  it("`next`: the turn after a Stop block is the message's, found or not — an end with no row is no answer", async () => {
    const f = fresh();
    const ff = follow(f, 0, opts);
    add(f, says("words nobody can put down to this message"));
    ff.turnEnded();
    expect(await ff.answer).toBeNull();
  });
  it("`marked`: a turn that ended before the session took the message was not the message's", async () => {
    const f = fresh();
    const ff = follow(f, 0, { ...opts, end: "marked", timeoutMs: 5000 });
    // The session was mid-turn when its waiter was handed the message: that turn ends first.
    add(f, says("the answer to what the person typed"));
    ff.turnEnded();
    await settle(250);
    // Then it reads the waiter's output and answers, and that turn's end is the answer's.
    add(
      f,
      rec({ type: "user", message: { content: [{ type: "tool_result", content: `1\tMessage via x (…; ${MARK}):` }] } }),
    );
    add(f, asst("tool_use", [{ type: "text", text: "WAITED" }]));
    ff.turnEnded();
    expect(await ff.answer).toBe("WAITED");
  });
  it("a message with no mark has no row to wait for: the next end of a turn settles it, with no answer", async () => {
    // Its id was not one a mark is made of, so it was handed over unmarked. Left to
    // `marked`, it was acked when the answer-wait ran out: half an hour.
    for (const mark of [null, "message 42"]) {
      const f = fresh();
      const ff = follow(f, 0, { ...opts, mark, end: "marked", timeoutMs: 5000 });
      add(f, rec({ type: "user", message: { content: [{ type: "tool_result", content: "1\tMessage via x (…):" }] } }));
      add(f, says("whatever the session wrote: none of it can be put down to this message"));
      const t0 = Date.now();
      ff.turnEnded();
      expect(await ff.answer).toBeNull();
      expect(Date.now() - t0).toBeLessThan(1000);
    }
  });
  it("a transcript rewritten, removed, unreadable or no longer a file gives no answer", async () => {
    const f = fresh(`${taken()}\n${says("x")}\n`);
    const cutShort = follow(f, transcriptEnd(f), opts);
    writeFileSync(f, "");
    expect(await cutShort.answer).toBeNull();
    const g = fresh(`${taken()}\n`);
    const removed = follow(g, 5, opts);
    rmSync(g);
    removed.turnEnded();
    expect(await removed.answer).toBeNull();
    // A directory can be opened and not read.
    expect(await follow(dir, 0, opts).answer).toBeNull();
  });
  it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
    "a transcript that can't be opened gives no answer",
    async () => {
      const f = fresh(`${taken()}\n${says("x")}\n`);
      chmodSync(f, 0o000);
      expect(await follow(f, 0, opts).answer).toBeNull();
      chmodSync(f, 0o600);
    },
  );
});

describe("kinds and modes the ladder names (CONTROL.md §6)", () => {
  it("a harness with an input API gets `api` before any cold start; a kind nobody knows is unsupported", () => {
    const view = {
      harness: "kiro",
      sdk: false,
      waiter: false,
      midTurn: false,
      inbox: false,
      held: null,
      known: true,
      canFork: false,
      copied: false,
    };
    expect(routePrompt({ ...view, api: true })).toEqual({ mode: "api" });
    expect(routePrompt({ ...view, api: false })).toHaveProperty("unsupported");
    expect(kindPath("permission.answer", "gemini-cli")).toEqual({
      unsupported: "Gemini CLI has no permission answer channel",
    });
    expect(kindPath("permission.answer", "codex")).toBe("permission");
    expect(kindPath("cancel", "codex")).toBe("cancel");
    expect(kindPath("restart" as never, "codex")).toEqual({ unsupported: "unknown kind restart" });
  });
});

describe("sessionToolsFrom", () => {
  it("keeps MCP server names only — never a built-in tool", async () => {
    const { sessionToolsFrom } = await import("../src/control/daemon.js");
    expect(
      sessionToolsFrom([
        "mcp__spacesheep",
        "Bash",
        "Write",
        "mcp__x__y",
        "Bash(rm -rf *)",
        "mcp__plugin_spacesheep_spacesheep",
        3,
      ]),
    ).toEqual(["mcp__spacesheep", "mcp__x__y", "mcp__plugin_spacesheep_spacesheep"]);
    expect(sessionToolsFrom("mcp__spacesheep")).toEqual([]);
  });
});
