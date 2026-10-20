// SPDX-License-Identifier: Apache-2.0
// The answer to an in-place message, read from the session's own transcript.
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { answerIn, awaitAnswer, transcriptEnd } from "../src/control/reply.js";
import { kindPath, routePrompt } from "../src/control/route.js";

const rec = (o: Record<string, unknown>) => JSON.stringify(o);
const asst = (stop: string, content: unknown[], extra: Record<string, unknown> = {}) =>
  rec({ type: "assistant", message: { stop_reason: stop, content }, ...extra });

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
      harness: "opencode",
      sdk: false,
      waiter: false,
      midTurn: false,
      live: false,
      known: true,
      canFork: false,
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
