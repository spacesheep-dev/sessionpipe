// SPDX-License-Identifier: Apache-2.0
// The answer to an in-place message, read from the session's own transcript.
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { answerIn, awaitAnswer, firstAsk, ranInMode, transcriptEnd } from "../src/control/reply.js";
import { kindPath, routePrompt } from "../src/control/route.js";

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
    expect(firstAsk(file, after(peerRow()), MARK)).toBe("peer");
    // The parsed body the harness records counts too, and a string content.
    expect(firstAsk(file, after(peerRow({ body: `… ${MARK} …` }, "nothing here")), MARK)).toBe("peer");
    expect(
      firstAsk(file, after(rec({ type: "user", origin: { kind: "peer" }, message: { content: `… ${MARK} …` } })), MARK),
    ).toBe("peer");
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
    ).toBe("peer");
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

describe("answerIn", () => {
  it("is the turn's text once it ends; tool steps and subagents are not the answer", () => {
    const lines = [
      asst("tool_use", [
        { type: "text", text: "Looking." },
        { type: "tool_use", name: "Read" },
      ]),
      rec({ type: "user", message: { content: [{ type: "tool_result" }] } }),
      asst("end_turn", [{ type: "text", text: "inner" }], { isSidechain: true }),
      asst("end_turn", [{ type: "text", text: "It has one line." }]),
    ];
    expect(answerIn(lines.slice(0, 3))).toEqual({ done: false, text: "Looking." });
    expect(answerIn(lines)).toEqual({ done: true, text: "Looking.\n\nIt has one line." });
  });
  it("skips lines that aren't JSON", () => {
    expect(answerIn(["{", asst("end_turn", [{ type: "text", text: "ok" }])])).toEqual({ done: true, text: "ok" });
  });
});

describe("awaitAnswer", () => {
  it("reads only what the transcript gained after delivery, across partial writes", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "sp-reply-"));
    const f = path.join(dir, "t.jsonl");
    // An earlier turn's end_turn must never be taken for this message's answer.
    writeFileSync(f, `${asst("end_turn", [{ type: "text", text: "old answer" }])}\n`);
    const from = transcriptEnd(f);
    const done = awaitAnswer(f, from, { timeoutMs: 3000, pollMs: 20 });
    const line = `${asst("end_turn", [{ type: "text", text: "new answer" }])}\n`;
    appendFileSync(f, line.slice(0, 10));
    await new Promise((r) => setTimeout(r, 60));
    appendFileSync(f, line.slice(10));
    expect(await done).toBe("new answer");
  });
  it("a turn that ended without a word is no answer", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "sp-reply-"));
    const f = path.join(dir, "t.jsonl");
    writeFileSync(f, "");
    appendFileSync(f, `${asst("end_turn", [{ type: "tool_use", name: "Edit" }])}\n`);
    expect(await awaitAnswer(f, 0, { timeoutMs: 3000, pollMs: 20 })).toBeNull();
  });
  it("gives up after its timeout when the turn never ends", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "sp-reply-"));
    const f = path.join(dir, "t.jsonl");
    writeFileSync(f, "");
    appendFileSync(f, `${asst("tool_use", [{ type: "text", text: "working" }])}\n`);
    expect(await awaitAnswer(f, 0, { timeoutMs: 150, pollMs: 20 })).toBeNull();
  });
});

describe("kinds and modes the ladder names (CONTROL.md §6)", () => {
  it("a harness with an input API gets `api` before any cold start; a kind nobody knows is unsupported", () => {
    const view = {
      harness: "kiro",
      sdk: false,
      waiter: false,
      midTurn: false,
      inbox: false,
      live: false,
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
