// SPDX-License-Identifier: Apache-2.0
// The transcript readers: complete turns out of each harness's file format, the line
// the cursor may advance to, and the edges a worker meets — resuming from a cursor,
// a line still being written, an empty file, a file that shrank, a prompt with no
// reply yet.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { openTurn } from "../../cli/src/run.js";
import {
  isInjected,
  pairTurns,
  peerAsk,
  readAntigravity,
  readClaude,
  readCodex,
  readGemini,
} from "../src/readers/transcripts.js";

const T0 = "2026-10-01T00:00:00.000Z";
const T1 = "2026-10-01T00:00:05.000Z";
const at = (s: string) => Date.parse(s);

/** A Claude Code / Droid transcript line. */
const cl = (type: string, content: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type, message: { content }, timestamp: T0, ...extra });
const user = (text: string, extra: Record<string, unknown> = {}) => cl("user", [{ type: "text", text }], extra);
const assistant = (text: string, extra: Record<string, unknown> = {}) =>
  cl("assistant", [{ type: "text", text }], { timestamp: T1, ...extra });

const COMPACTION = readFileSync(new URL("./fixtures/claude-mid-turn-compaction.jsonl", import.meta.url), "utf8")
  .trimEnd()
  .split("\n");
// A message the person sends while a turn is running is not a `user` record. Claude Code
// (2.1.293, 2026-10-07) writes it as a `queued_command` attachment that the running turn
// absorbs, so a reader of `user` records alone drops the person's words. The same record
// carries task notifications and other sessions' messages (`origin.kind`
// task-notification / peer); older versions wrote it with no origin.
const QUEUED = readFileSync(
  new URL("../../../conformance/transcripts/claude-code/queued-command.jsonl", import.meta.url),
  "utf8",
)
  .trimEnd()
  .split("\n");
const atQ = (s: number) => Date.UTC(2026, 9, 7, 22, 0, s);
const COMPACTED_TURN = {
  user: "Run experiment 3 and report back.",
  assistant: "Starting experiment 3.\n\nThe plan is ready; writing the scheduler.\n\nWriting the evaluation app now.",
  at: Date.parse("2026-10-20T16:13:30.000Z"),
  endLine: 7,
};
const SUMMARIES = [
  { flag: "isCompactSummary", lines: COMPACTION },
  {
    flag: "repeatsCompactSummary",
    lines: COMPACTION.map((l) => l.replace('"isCompactSummary":true', '"repeatsCompactSummary":true')),
  },
];

describe("pairTurns", () => {
  const m = (role: "user" | "assistant", text: string, line: number) => ({ role, text, at: line, line });
  it("a second prompt before any reply joins the first; a prompt after a reply starts a new turn", () => {
    const r = pairTurns([m("user", "a", 0), m("user", "b", 1), m("assistant", "x", 2), m("user", "c", 3)], 4);
    expect(r.turns).toEqual([{ user: "a\n\nb", assistant: "x", at: 0, endLine: 2 }]);
    expect(r.open).toEqual({ user: "c", at: 3 });
    expect(r.line).toBe(3);
  });
  it("two complete turns in a row", () => {
    const r = pairTurns([m("user", "a", 0), m("assistant", "x", 1), m("user", "b", 2), m("assistant", "y", 3)], 4);
    expect(r.turns.map((t) => [t.user, t.assistant, t.endLine])).toEqual([
      ["a", "x", 1],
      ["b", "y", 3],
    ]);
    expect(r.line).toBe(4);
    expect(r.open).toBeUndefined();
  });
  it("a reply with no prompt before it is a turn with an empty user side", () => {
    const r = pairTurns([m("assistant", "x", 0), m("assistant", "y", 1)], 2);
    expect(r.turns).toEqual([{ user: "", assistant: "x\n\ny", at: 0, endLine: 1 }]);
  });
  it("nothing in, nothing out", () => {
    expect(pairTurns([], 0)).toEqual({ turns: [], line: 0 });
    expect(pairTurns([], 0, true)).toEqual({ turns: [], line: 0 });
  });

  // No hook fires when the person stops a turn, so the transcript's marker is the only
  // thing that ends it: the turn is whole as it stands, and the next prompt is a new one
  // (it used to join the prompt nobody answered).
  const stop = (line: number) => ({ role: "interrupt" as const, text: "", at: line, line });
  it("an interruption ends the turn as it stands, with or without a reply", () => {
    const r = pairTurns(
      [m("user", "a", 0), stop(1), m("user", "b", 2), m("assistant", "x", 3), stop(4), m("user", "c", 5)],
      6,
    );
    expect(r.turns).toEqual([
      { user: "a", assistant: "", at: 0, endLine: 1, interrupted: true },
      { user: "b", assistant: "x", at: 2, endLine: 4, interrupted: true },
    ]);
    expect(r.open).toEqual({ user: "c", at: 5 });
    expect(r.line).toBe(5);
  });
  it("an interruption with no turn before it is nothing, and after one the cursor may pass", () => {
    expect(pairTurns([stop(0)], 1)).toEqual({ turns: [], line: 1 });
    expect(pairTurns([m("user", "a", 0), stop(1)], 2).line).toBe(2);
  });
  it("says where the last turn starts and what it said last, only when asked", () => {
    const msgs = [
      m("user", "a", 0),
      m("assistant", "x", 1),
      m("user", "b", 2),
      m("assistant", "y", 3),
      m("assistant", "z", 4),
    ];
    expect(pairTurns(msgs, 5).tail).toBeUndefined();
    expect(pairTurns(msgs, 5, true).tail).toEqual({ start: 2, said: "z" });
    // A prompt after it closes the turn; its last words are still its last words.
    expect(pairTurns([...msgs, m("user", "c", 5)], 6, true).tail).toEqual({ start: 2, said: "z" });
    // An interrupted turn has said all it will; one that said nothing has no last words.
    expect(pairTurns([...msgs, stop(5)], 6, true).tail).toEqual({ start: 2 });
    expect(pairTurns([m("user", "a", 0), stop(1)], 2, true).tail).toEqual({ start: 0 });
  });
  it("a turn carries its prompt's id, the latest when a second prompt joined the first", () => {
    const u = (text: string, line: number, id?: string) => ({ ...m("user", text, line), ...(id ? { id } : {}) });
    const r = pairTurns([u("a", 0, "p1"), u("b", 1, "p2"), u("c", 2), m("assistant", "x", 3), u("d", 4)], 5);
    expect(r.turns).toEqual([{ user: "a\n\nb\n\nc", assistant: "x", at: 0, endLine: 3, id: "p2" }]);
  });
});

describe("isInjected", () => {
  it("knows wrappers, comments and command expansions from a person's words", () => {
    expect(isInjected("<system-reminder>x</system-reminder>")).toBe(true);
    expect(isInjected("<local-command-stdout>x</local-command-stdout>\n")).toBe(true);
    expect(isInjected("<!-- a comment -->")).toBe(true);
    expect(isInjected("<command-name>/clear</command-name>")).toBe(true);
    expect(isInjected("<b>bold</b> and then more")).toBe(false);
    expect(isInjected("fix <the> thing")).toBe(false);
    expect(isInjected("plain words")).toBe(false);
  });

  it("a wrapper whose tag carries attributes is injected too: another session's message", () => {
    const peer =
      '<cross-session-message from="uds:/tmp/cc-socks/76094.sock" from-name="gyroscope-b4" from-mode="bypass">\n' +
      "Agreed.\n</cross-session-message>";
    expect(isInjected(peer)).toBe(true);
    expect(isInjected("<task-notification>\n<task-id>w0wdh6zft</task-id>\n</task-notification>")).toBe(true);
    // The person's own words that merely contain or start with markup are kept.
    expect(isInjected("Use <b>bold</b> for the title")).toBe(false);
    expect(isInjected('<a href="https://x.test">this link</a> is broken, fix it')).toBe(false);
    expect(isInjected("Fix the bug")).toBe(false);
  });

  it("readClaude skips another session's message written as a user record", () => {
    const peer = JSON.stringify({
      type: "user",
      timestamp: T0,
      message: { content: '<cross-session-message from="uds:/x.sock" from-name="b4">Done.</cross-session-message>' },
    });
    // Not an unanswered ask either: no `open`, and the cursor may pass it.
    expect(readClaude([user("hello"), assistant("hi"), peer, ""], 0)).toEqual({
      turns: [{ user: "hello", assistant: "hi", at: Date.parse(T0), endLine: 1 }],
      line: 3,
      tail: { start: 0, said: "hi" },
    });
  });
});

describe("readClaude", () => {
  it.each(SUMMARIES)("keeps replies before and after $flag in the person's original turn", ({ lines }) => {
    expect(readClaude(lines, 0)).toEqual({
      turns: [COMPACTED_TURN],
      line: 8,
      tail: { start: 0, said: "Writing the evaluation app now." },
    });
  });

  it.each(SUMMARIES)("keeps turn.progress on turn 107 and the person's ask across $flag", ({ lines }) => {
    for (const end of [5, 6, 7, 8]) {
      const read = readClaude(lines.slice(0, end), 0);
      expect(openTurn(read, { base: 107, at: Date.parse("2026-10-20T16:20:30.000Z") })).toEqual({
        turn: 107,
        user: COMPACTED_TURN.user,
        assistant:
          end === 8 ? COMPACTED_TURN.assistant : "Starting experiment 3.\n\nThe plan is ready; writing the scheduler.",
        at: COMPACTED_TURN.at,
      });
    }
  });

  const lines = [user("hello"), assistant("hi"), user("more?"), assistant("yes"), assistant("and more"), ""];
  it("pairs prompts with everything the assistant said before the next prompt", () => {
    const r = readClaude(lines, 0);
    expect(r.turns).toEqual([
      { user: "hello", assistant: "hi", at: at(T0), endLine: 1 },
      { user: "more?", assistant: "yes\n\nand more", at: at(T0), endLine: 4 },
    ]);
    expect(r.line).toBe(5);
    expect(r.open).toBeUndefined();
  });
  it("resumes from a cursor with absolute line numbers", () => {
    const first = readClaude(lines.slice(0, 2), 0);
    expect(first.line).toBe(2);
    const r = readClaude(lines, first.line);
    expect(r.turns).toEqual([{ user: "more?", assistant: "yes\n\nand more", at: at(T0), endLine: 4 }]);
    expect(r.line).toBe(5);
  });
  it("an open turn: the prompt with no reply yet is reported, the cursor stops before it", () => {
    const r = readClaude([user("hello"), assistant("hi"), user("and now?"), ""], 0);
    expect(r.turns).toHaveLength(1);
    expect(r.open).toEqual({ user: "and now?", at: at(T0) });
    expect(r.line).toBe(2);
    const later = readClaude([user("hello"), assistant("hi"), user("and now?"), assistant("this"), ""], r.line);
    expect(later.turns).toEqual([{ user: "and now?", assistant: "this", at: at(T0), endLine: 3 }]);
    expect(later.line).toBe(4);
  });
  it("a partial last line (a write in progress) is not read and not skipped over", () => {
    const partial = user("second ask").slice(0, 20);
    const r = readClaude([user("hello"), assistant("hi"), partial], 0);
    expect(r.turns).toHaveLength(1);
    expect(r.line).toBe(2);
    const done = readClaude([user("hello"), assistant("hi"), user("second ask"), assistant("ok"), ""], r.line);
    expect(done.turns).toEqual([{ user: "second ask", assistant: "ok", at: at(T0), endLine: 3 }]);
  });
  it("a complete last line without its newline is read and counted", () => {
    const r = readClaude([user("hello"), assistant("hi")], 0);
    expect(r.turns).toHaveLength(1);
    expect(r.line).toBe(2);
  });
  it("an empty file", () => {
    expect(readClaude([""], 0)).toEqual({ turns: [], line: 0 });
    expect(readClaude([], 0)).toEqual({ turns: [], line: 0 });
  });
  it("a file that shrank below the cursor yields nothing and reports its real end", () => {
    const r = readClaude(lines, 50);
    expect(r.turns).toEqual([]);
    expect(r.line).toBe(5);
  });
  it("skips sidechains, meta and non-human prompts, injected context, empty text, junk lines", () => {
    const r = readClaude(
      [
        "not json",
        user("side", { isSidechain: true }),
        user("meta", { isMeta: true }),
        user("agent", { origin: { kind: "agent" } }),
        user("<system-reminder>x</system-reminder>"),
        cl("user", [{ type: "tool_result", content: "x" }]),
        cl("user", [{ type: "text", text: "   " }]),
        user("human", { origin: { kind: "human" } }),
        cl("assistant", "a string, not blocks"),
        cl("assistant", [{ type: "tool_use", name: "Bash" }]),
        cl("assistant", [{ type: "text", text: 5 }, { text: "no type" }, null]),
        assistant("reply"),
        cl("system", "ignored"),
      ],
      0,
    );
    expect(r.turns).toEqual([{ user: "human", assistant: "reply", at: at(T0), endLine: 11 }]);
  });
  it("a prompt as a plain string, a missing timestamp, a one-of-each origin", () => {
    const before = Date.now();
    const r = readClaude([JSON.stringify({ type: "user", message: { content: "typed" } }), assistant("ok")], 0);
    expect(r.turns[0]?.user).toBe("typed");
    expect(r.turns[0]?.at).toBeGreaterThanOrEqual(before);
    expect(readClaude([user("x", { origin: {} }), assistant("y")], 0).turns[0]?.user).toBe("x");
    expect(readClaude([JSON.stringify({ type: "user" }), assistant("y")], 0).turns[0]?.user).toBe("");
  });
});

describe("readClaude: an ask another session handed over", () => {
  // A control daemon reaches a live session by writing into its own inbox (CONTROL.md
  // §6.3). The row Claude Code writes for that turn is `isMeta` with `origin.kind:
  // "peer"`, because the preamble around the message is the harness's — but the ask
  // inside it is the person's words, so the turn has an ask like any other.
  const PREAMBLE = "Another Claude session sent a message:";
  const envelope = (body: string) =>
    `<cross-session-message from-name="spacesheep.dev board" from-mode="bypass">\n${body}\n</cross-session-message>`;

  it("is the turn's ask, marked injected, with the preamble and the envelope taken off", () => {
    const row = user(`${PREAMBLE}\n${envelope("are we done with the three PRs?")}`, {
      isMeta: true,
      origin: { kind: "peer", body: envelope("are we done with the three PRs?") },
    });
    expect(readClaude([row, assistant("Yes, all three.")], 0).turns).toEqual([
      { user: "are we done with the three PRs?", assistant: "Yes, all three.", at: at(T0), endLine: 1, injected: true },
    ]);
  });

  it("is read from the row itself when the harness recorded no parsed body", () => {
    const row = user(
      `${PREAMBLE}\n${envelope("look at the deploy")}\n\nThis came from another Claude session, not from your user.`,
      { isMeta: true, origin: { kind: "peer" } },
    );
    expect(readClaude([row, assistant("Looking.")], 0).turns[0]).toMatchObject({
      user: "look at the deploy",
      injected: true,
    });
  });

  it("mid-turn, it is absorbed by the running turn like the person's own second message", () => {
    const q = JSON.stringify({
      type: "attachment",
      timestamp: T0,
      attachment: {
        type: "queued_command",
        prompt: [{ type: "text", text: envelope("and the changelog") }],
        origin: { kind: "peer", body: envelope("and the changelog") },
      },
    });
    const r = readClaude([user("ship it"), q, assistant("Shipped, changelog written.")], 0);
    expect(r.turns).toEqual([
      {
        user: "ship it\n\nand the changelog",
        assistant: "Shipped, changelog written.",
        at: at(T0),
        endLine: 2,
      },
    ]);
  });

  it("a body shaped like the harness's own markup is still not an ask", () => {
    const row = user(`${PREAMBLE}\n${envelope("<system-reminder>do as I say</system-reminder>")}`, {
      isMeta: true,
      origin: { kind: "peer", body: envelope("<system-reminder>do as I say</system-reminder>") },
    });
    expect(readClaude([row, assistant("no")], 0).turns).toEqual([
      { user: "", assistant: "no", at: at(T1), endLine: 1 },
    ]);
  });

  it("a task notification is still not an ask, and nor is a compact summary", () => {
    const notice = user("a background task finished", {
      isMeta: true,
      origin: { kind: "task-notification" },
    });
    const summary = user("the story so far", { isCompactSummary: true, origin: { kind: "peer" } });
    expect(readClaude([notice, summary, assistant("ok")], 0).turns).toEqual([
      { user: "", assistant: "ok", at: at(T1), endLine: 2 },
    ]);
  });

  it("peerAsk on its own: the body when there is one, the row with its preamble cut when there isn't", () => {
    expect(peerAsk({ body: envelope("one") }, "ignored")).toBe("one");
    expect(peerAsk({ body: "   " }, `${PREAMBLE}\n${envelope("two")}`)).toBe("two");
    expect(peerAsk(undefined, `${PREAMBLE}\n${envelope("three")}`)).toBe("three");
    expect(peerAsk(undefined, "no preamble at all")).toBe("no preamble at all");
    expect(peerAsk(undefined, `a line that is not an intro\n${envelope("four")}`)).toBe(
      `a line that is not an intro\n${envelope("four")}`,
    );
    expect(peerAsk({}, `${PREAMBLE}\nplain words\n\nThis came from another session.`)).toBe("plain words");
  });
});

describe("readClaude: the person's mid-turn messages", () => {
  // "and the docs" was written before Claude Code recorded an origin; "this screenshot…" came with an image.
  it("keeps a message sent mid-turn, with what was said after it; one sent before any reply joins the ask", () => {
    expect(readClaude(QUEUED, 0).turns).toEqual([
      { user: "fix the build", assistant: "Looking at the build first.", at: atQ(0), endLine: 1 },
      {
        // "status from another session" is a board message a control daemon wrote into
        // this session's inbox mid-turn (CONTROL.md §6.3): the person's words, so the
        // running turn absorbs it like their own second message.
        user: "also run the tests\n\nstatus from another session\n\nand the docs",
        assistant: "The build is fixed, the tests pass, and the docs are updated.",
        at: atQ(3),
        endLine: 8,
      },
      {
        user: "ship it\n\nthis screenshot shows the bug",
        assistant: "Shipped, with the fix from the screenshot.",
        at: atQ(9),
        endLine: 15,
      },
    ]);
  });

  it("skips task notifications, an origin that is nobody's words, wrappers sent as a queued command", () => {
    const all = readClaude(QUEUED, 0);
    const words = [...all.turns.flatMap((t) => [t.user, t.assistant]), all.open?.user ?? ""].join("\n");
    expect(words).not.toMatch(/task-notification|cross-session-message|hello/);
  });

  it("holds the cursor before a mid-turn message that has no reply yet, and numbers it as the transcript will", () => {
    const read = readClaude(QUEUED, 0);
    expect(read.open).toEqual({ user: "one more thing", at: atQ(16) });
    expect(read.line).toBe(16);
    // turn.progress shows it as turn 3, and turn.transcript delivers turn 3 once the reply lands.
    expect(openTurn(read, { base: 0, at: atQ(17) })).toEqual({
      turn: 3,
      user: "one more thing",
      assistant: "",
      at: atQ(16),
    });
    const later = readClaude([...QUEUED, assistant("Also done.")], read.line);
    expect(later.turns).toEqual([{ user: "one more thing", assistant: "Also done.", at: atQ(16), endLine: 17 }]);
    expect(later.line).toBe(18);
    expect(later.open).toBeUndefined();
  });

  it("an attachment with no body, a body that is not an object, a blank prompt, a sidechain", () => {
    const q = (attachment: unknown, extra: Record<string, unknown> = {}) =>
      JSON.stringify({ type: "attachment", attachment, timestamp: T0, ...extra });
    const r = readClaude(
      [
        user("hello"),
        JSON.stringify({ type: "attachment", timestamp: T0 }),
        q("queued_command"),
        q({ type: "queued_command", prompt: "   " }),
        q({ type: "queued_command", prompt: "side", origin: { kind: "human" } }, { isSidechain: true }),
        q({ type: "queued_command", prompt: [{ type: "image" }] }),
        // No origin key at all, which older Claude Code wrote: the person's.
        q({ type: "queued_command", prompt: "" }),
        // An origin that is nobody's words: not the person, not another session.
        q({ type: "queued_command", prompt: "from the harness", origin: { kind: "agent" } }),
        assistant("hi"),
        "",
      ],
      0,
    );
    expect(r).toEqual({
      turns: [{ user: "hello", assistant: "hi", at: at(T0), endLine: 8 }],
      line: 9,
      tail: { start: 0, said: "hi" },
    });
  });
});

// A terminal session, recorded on 2.1.322 (2026-11-10): a turn with a tool call, a turn of
// one word, and a turn the person stopped with Esc while its tool ran. Claude Code fires
// no Stop for the last one; it writes `[Request interrupted by user for tool use]` as a
// `user` record, which nobody typed.
const INTERRUPTED = readFileSync(
  new URL("../../../conformance/transcripts/claude-code/interrupted-turn.jsonl", import.meta.url),
  "utf8",
)
  .trimEnd()
  .split("\n");
const SIX = {
  user: "Run `sleep 6` in bash, then reply with only the word SIX.",
  at: Date.parse("2026-11-10T17:19:24.018Z"),
};
const PING = "Run `ping -c 30 127.0.0.1` in bash, then reply with only the word PINGI.";

describe("readClaude: a turn the person interrupted", () => {
  it("is a turn of its own, with what it had said, and its marker is nobody's words", () => {
    const r = readClaude(INTERRUPTED, 0);
    expect(r.turns).toEqual([
      { ...SIX, assistant: "SIX", endLine: 3, id: "id2" },
      {
        user: "Reply with only the word SEVEN.",
        assistant: "SEVEN",
        at: Date.parse("2026-11-10T17:22:27.052Z"),
        endLine: 7,
        id: "id11",
      },
      {
        user: PING,
        assistant: "",
        at: Date.parse("2026-11-10T17:31:34.318Z"),
        endLine: 13,
        id: "id18",
        interrupted: true,
      },
    ]);
    expect(r.open).toBeUndefined();
    expect(r.line).toBe(14);
    expect(JSON.stringify(r)).not.toContain("Request interrupted");
  });

  it("until the marker is written the prompt is open, and the next prompt is not joined to it after", () => {
    const running = readClaude(INTERRUPTED.slice(0, 13), 10);
    expect(running.turns).toEqual([]);
    expect(running.open).toEqual({ user: PING, at: Date.parse("2026-11-10T17:31:34.318Z") });
    const after = readClaude([...INTERRUPTED, user("try again"), assistant("ok")], 10);
    expect(after.turns.map((t) => [t.user, t.assistant, t.interrupted ?? false])).toEqual([
      [PING, "", true],
      ["try again", "ok", false],
    ]);
    // `[Request interrupted by user]`, the form without a tool, and one with a reply before it.
    const plain = readClaude([user("a"), assistant("so far"), user("[Request interrupted by user]"), user("b")], 0);
    expect(plain.turns).toEqual([{ user: "a", assistant: "so far", at: at(T0), endLine: 2, interrupted: true }]);
    expect(plain.open).toEqual({ user: "b", at: at(T0) });
    // The person quoting the marker inside a sentence is still the person.
    expect(readClaude([user("why does it say [Request interrupted by user]?")], 0).open?.user).toContain("why does");
  });
});

describe("readClaude: the last words of the last turn", () => {
  // Claude Code names a turn's last words in its Stop (`last_assistant_message`) and
  // writes its transcript rows up to 100 ms late, so a reader has to know whether the
  // file already ends with them.
  const toolUse = cl("assistant", [{ type: "tool_use", name: "Bash" }], { timestamp: T1 });
  const toolResult = cl("user", [{ type: "tool_result", content: "x" }]);
  it("are the turn's last text, while no tool call or result of the turn follows it", () => {
    expect(readClaude(INTERRUPTED.slice(0, 4), 0).tail).toEqual({ start: 0, said: "SIX" });
    // The rows a Stop leaves after the words, and a thinking block, are not the turn going on.
    expect(readClaude(INTERRUPTED.slice(0, 6), 0).tail).toEqual({ start: 0, said: "SIX" });
    const thinking = cl("assistant", [{ type: "thinking", thinking: "" }], { timestamp: T1 });
    expect(readClaude([user("a"), assistant("done"), thinking], 0).tail).toEqual({ start: 0, said: "done" });
    // Words before a tool call are not the turn's last, whichever row says so.
    expect(readClaude([user("a"), assistant("let me look"), toolUse], 0).tail).toEqual({ start: 0 });
    expect(readClaude([user("a"), assistant("let me look"), toolUse, toolResult], 0).tail).toEqual({ start: 0 });
    expect(readClaude([user("a"), assistant("let me look"), toolResult], 0).tail).toEqual({ start: 0 });
    expect(
      readClaude([user("a"), assistant("let me look"), toolUse, toolResult, assistant("found it")], 0).tail,
    ).toEqual({ start: 0, said: "found it" });
  });
  it("stay the last words once a later prompt, or a tool of its turn, follows", () => {
    const next = [user("a"), assistant("done"), user("b")];
    expect(readClaude(next, 0).tail).toEqual({ start: 0, said: "done" });
    expect(readClaude([...next, toolUse, toolResult], 0).tail).toEqual({ start: 0, said: "done" });
    expect(readClaude([...next, toolUse, toolResult, assistant("b done")], 0).tail).toEqual({
      start: 2,
      said: "b done",
    });
    // A message sent mid-turn begins the next turn of the reading; so does an interruption.
    const queued = JSON.stringify({
      type: "attachment",
      timestamp: T0,
      attachment: { type: "queued_command", prompt: "and c" },
    });
    expect(readClaude([user("a"), assistant("done"), queued, toolUse], 0).tail).toEqual({ start: 0, said: "done" });
    expect(readClaude([user("a"), assistant("done"), user("[Request interrupted by user]"), toolUse], 0).tail).toEqual({
      start: 0,
    });
  });
  it("there is no tail without a turn", () => {
    expect(readClaude([user("a")], 0).tail).toBeUndefined();
    expect(readClaude([], 0).tail).toBeUndefined();
  });
});

// A message from a channel (Claude Code `--channels`: the Telegram plugin, `sessionpipe
// channel`) is a meta `user` record with `origin.kind: "channel"`, its words wrapped in a
// `<channel source="…">` tag (recorded on 2.1.312, 2026-10-28). The words are the
// person's, sent from elsewhere: a reader that drops meta records loses the turn's ask,
// and the board shows a turn with nothing asked.
const CHANNEL = readFileSync(
  new URL("../../../conformance/transcripts/claude-code/channel-message.jsonl", import.meta.url),
  "utf8",
)
  .trimEnd()
  .split("\n");

describe("readClaude: messages from a channel", () => {
  it("a channel's message is its turn's ask, out of its tag; the turn before it is untouched", () => {
    const r = readClaude(CHANNEL, 0);
    expect(r.turns.map((t) => [t.user, t.assistant])).toEqual([
      ["check the deploy", "The deploy is green."],
      ["and the staging one?", "Staging is green too."],
      ["yes, correct it", "Corrected."],
    ]);
    expect(r.turns[1]?.at).toBe(Date.parse("2026-10-28T22:01:00.500Z"));
    expect(r.line).toBe(6);
    // A channel's ask is the person's words that didn't arrive by the keyboard, as a peer's is.
    expect(r.turns.map((t) => t.injected ?? false)).toEqual([false, true, true]);
  });
  it("a channel record that isn't a tag around words asks nothing; other meta records still don't", () => {
    const ch = (content: unknown) => user("", { isMeta: true, origin: { kind: "channel" }, message: { content } });
    const r = readClaude(
      [
        ch('<channel source="x">\n   \n</channel>'),
        ch("no tag around these words"),
        ch('<channel source="x">unclosed'),
        ch([{ type: "image" }]),
        user("meta", { isMeta: true }),
        user('<channel source="x">typed, not from a channel</channel>'),
        user("the ask"),
        assistant("the answer"),
      ],
      0,
    );
    expect(r.turns).toEqual([{ user: "the ask", assistant: "the answer", at: at(T0), endLine: 7 }]);
  });
});

describe("readCodex", () => {
  const item = (role: string, kind: string, text: unknown, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: "response_item",
      timestamp: T0,
      payload: { type: "message", role, content: [{ type: kind, text }] },
      ...extra,
    });
  it("reads only messages, only with text, only from the two roles, with or without a timestamp", () => {
    const before = Date.now();
    const r = readCodex(
      [
        "",
        JSON.stringify({ type: "session_meta", payload: { id: "x" } }),
        JSON.stringify({ type: "event_msg", payload: {} }),
        JSON.stringify({ type: "response_item", payload: { type: "function_call" } }),
        JSON.stringify({ type: "response_item" }),
        item("user", "input_text", "   "),
        item("system", "input_text", "nope"),
        item("user", "input_text", "ask", { timestamp: undefined }),
        item("assistant", "output_text", "answer"),
        "",
      ],
      0,
    );
    expect(r.turns).toEqual([{ user: "ask", assistant: "answer", at: r.turns[0]?.at, endLine: 8 }]);
    expect(r.turns[0]?.at).toBeGreaterThanOrEqual(before);
    expect(r.line).toBe(9);
  });
  it("an empty file", () => {
    expect(readCodex([""], 0)).toEqual({ turns: [], line: 0 });
  });
  it("a forked session whose replay never ends yields nothing", () => {
    const meta = JSON.stringify({ type: "session_meta", payload: { id: "child", forked_from_id: "parent" } });
    expect(readCodex([meta, item("user", "input_text", "replayed"), item("assistant", "output_text", "x")], 0)).toEqual(
      { turns: [], line: 3 },
    );
  });
});

describe("readGemini", () => {
  const g = (type: string, body: Record<string, unknown>) => JSON.stringify({ type, timestamp: T0, ...body });
  it("reads user and gemini/model lines from content, message or text", () => {
    const r = readGemini(
      [
        g("user", { content: "one" }),
        g("gemini", { content: [{ type: "text", text: "two" }] }),
        g("user", { message: "three" }),
        g("model", { text: "four" }),
        "",
      ],
      0,
    );
    expect(r.turns).toEqual([
      { user: "one", assistant: "two", at: at(T0), endLine: 1 },
      { user: "three", assistant: "four", at: at(T0), endLine: 3 },
    ]);
    expect(r.line).toBe(4);
  });
  it("skips junk, other types, empty text; a missing timestamp is now", () => {
    const before = Date.now();
    const r = readGemini(
      [
        "{",
        g("tool", { content: "x" }),
        g("user", { content: "  " }),
        g("user", { content: "q", timestamp: undefined }),
        g("gemini", { content: 7 }),
      ],
      0,
    );
    expect(r.turns).toEqual([]);
    expect(r.open?.user).toBe("q");
    expect(r.open?.at).toBeGreaterThanOrEqual(before);
    expect(r.line).toBe(3);
  });
  it("resumes from a cursor", () => {
    const lines = [
      g("user", { content: "a" }),
      g("gemini", { content: "b" }),
      g("user", { content: "c" }),
      g("gemini", { content: "d" }),
      "",
    ];
    expect(readGemini(lines, 2).turns).toEqual([{ user: "c", assistant: "d", at: at(T0), endLine: 3 }]);
  });
});

describe("readAntigravity", () => {
  const step = (type: string, content: unknown, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type, content, created_at: T0, ...extra });
  it("unwraps <USER_REQUEST> and pairs it with the planner's response", () => {
    const r = readAntigravity(
      [
        step("USER_INPUT", "<USER_REQUEST>fix it</USER_REQUEST>"),
        step("PLANNER_RESPONSE", "on it"),
        step("USER_INPUT", "<USER_REQUEST>cut off mid"),
        step("PLANNER_RESPONSE", "done", { created_at: undefined, timestamp: T1 }),
        "",
      ],
      0,
    );
    expect(r.turns).toEqual([
      { user: "fix it", assistant: "on it", at: at(T0), endLine: 1 },
      { user: "cut off mid", assistant: "done", at: at(T0), endLine: 3 },
    ]);
    expect(r.line).toBe(4);
  });
  it("skips junk, non-string content, other step types, empty text; a missing time is now", () => {
    const before = Date.now();
    const r = readAntigravity(
      [
        "nope",
        step("USER_INPUT", { not: "a string" }),
        step("TOOL_CALL", "ls"),
        step("USER_INPUT", "<USER_REQUEST>   </USER_REQUEST>"),
        step("PLANNER_RESPONSE", "   "),
        step("USER_INPUT", "bare words", { created_at: undefined }),
      ],
      0,
    );
    expect(r.turns).toEqual([]);
    expect(r.open?.user).toBe("bare words");
    expect(r.open?.at).toBeGreaterThanOrEqual(before);
  });
});
