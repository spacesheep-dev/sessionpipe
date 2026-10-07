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
    });
  });
});

describe("readClaude", () => {
  it.each(SUMMARIES)("keeps replies before and after $flag in the person's original turn", ({ lines }) => {
    expect(readClaude(lines, 0)).toEqual({ turns: [COMPACTED_TURN], line: 8 });
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

describe("readClaude: the person's mid-turn messages", () => {
  // "and the docs" was written before Claude Code recorded an origin; "this screenshot…" came with an image.
  it("keeps a message sent mid-turn, with what was said after it; one sent before any reply joins the ask", () => {
    expect(readClaude(QUEUED, 0).turns).toEqual([
      { user: "fix the build", assistant: "Looking at the build first.", at: atQ(0), endLine: 1 },
      {
        user: "also run the tests\n\nand the docs",
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

  it("skips task notifications, other sessions' messages, wrappers sent as a queued command, other attachments", () => {
    const all = readClaude(QUEUED, 0);
    const words = [...all.turns.flatMap((t) => [t.user, t.assistant]), all.open?.user ?? ""].join("\n");
    expect(words).not.toMatch(/task-notification|another session|cross-session-message|hello/);
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
        assistant("hi"),
        "",
      ],
      0,
    );
    expect(r).toEqual({ turns: [{ user: "hello", assistant: "hi", at: at(T0), endLine: 6 }], line: 7 });
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
