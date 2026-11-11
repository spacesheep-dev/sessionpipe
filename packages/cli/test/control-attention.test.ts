// SPDX-License-Identifier: Apache-2.0
// When a permission question is over (CONTROL.md §7): the rule on its own, held to
// conformance/control-attention.json, which a receiver's implementation runs too, and
// what it does with hooks older than the rule, which name no thread.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Asked, CLOSERS, type Closer, closerOf, questionOver, type Said } from "../src/control/attention.js";

interface Case {
  name: string;
  asked: { attention_id: string; agent_id?: string };
  event: { type: Closer; agent_id?: string; call_id?: string; background?: number; after_ms: number };
  closes: boolean;
}
const vectors = JSON.parse(
  readFileSync(new URL("../../../conformance/control-attention.json", import.meta.url), "utf8"),
) as { cases: Case[] };
const T0 = Date.parse("2026-11-11T04:29:17.643Z");

describe("conformance/control-attention.json", () => {
  it("has each kind of event for each kind of asker, closing and not", () => {
    expect(vectors.cases).toHaveLength(22);
    const seen = new Set(
      vectors.cases.map((c) => `${c.asked.agent_id ? "subagent" : "main"} ${c.event.type} ${c.closes}`),
    );
    for (const asker of ["main", "subagent"])
      for (const type of ["tool.ended", "turn.ended", "subagent.ended"])
        for (const closes of [true, false])
          if (!(asker === "main" && type === "subagent.ended" && closes))
            expect(seen, `${asker} ${type} ${closes}`).toContain(`${asker} ${type} ${closes}`);
    expect(seen).toContain("main turn.started true");
    expect(seen).toContain("subagent turn.started false");
    expect(seen).toContain("main session.ended true");
    expect(seen).toContain("subagent session.ended true");
  });
  it.each(vectors.cases)("$name", (c) => {
    // In an event, no `agent_id` is the main thread.
    const asked: Asked = { id: c.asked.attention_id, agent: c.asked.agent_id ?? "", at: T0 };
    const said: Said = {
      type: c.event.type,
      agent: c.event.agent_id ?? "",
      call: c.event.call_id ?? null,
      at: T0 + c.event.after_ms,
      background: c.event.background ?? null,
    };
    expect(questionOver(asked, said)).toBe(c.closes);
  });
});

describe("hooks older than the rule", () => {
  const types: Closer[] = ["tool.ended", "turn.ended", "turn.started", "subagent.ended", "session.ended"];
  const said = (type: Closer, over: Partial<Said> = {}): Said => ({
    type,
    agent: "",
    call: null,
    at: T0 + 1000,
    background: null,
    ...over,
  });
  it("a question whose hook named no thread is let go as it was: by any of these, whoever fired it, but a subagent's stop", () => {
    const old: Asked = { id: "perm-5f1c0e9a2b7d4c31", agent: null, at: null };
    for (const type of types)
      for (const agent of ["", "a42867b781ec114cb", null])
        expect(questionOver(old, said(type, { agent })), `${type} ${agent}`).toBe(type !== "subagent.ended");
  });
  it("and an event whose worker named no thread ends every question, as it did", () => {
    for (const agent of ["", "a42867b781ec114cb"])
      for (const type of types)
        expect(
          questionOver({ id: "perm-5f1c0e9a2b7d4c31", agent, at: T0 }, said(type, { agent: null, at: null })),
          `${type} ${agent}`,
        ).toBe(type !== "subagent.ended");
  });
  it("with no time on either side, the order they arrive in is all there is", () => {
    const q: Asked = { id: "perm-5f1c0e9a2b7d4c31", agent: "", at: T0 };
    expect(questionOver(q, said("tool.ended", { at: null }))).toBe(true);
    expect(questionOver({ ...q, at: null }, said("tool.ended", { at: T0 - 5000 }))).toBe(true);
    expect(questionOver(q, said("tool.ended", { at: T0 - 5000 }))).toBe(false);
    // The session's end, timed before the question, is another process's end.
    expect(questionOver(q, said("session.ended", { at: T0 - 5000 }))).toBe(false);
  });
  it("names Claude Code's hook events by what each says", () => {
    expect(CLOSERS).toEqual({
      PostToolUse: "tool.ended",
      PostToolUseFailure: "tool.ended",
      Stop: "turn.ended",
      StopFailure: "turn.ended",
      UserPromptSubmit: "turn.started",
      SubagentStop: "subagent.ended",
      SessionEnd: "session.ended",
    });
    expect(CLOSERS.PreToolUse).toBeUndefined();
    // By its own name only: an event named after something every object inherits is no closer.
    expect(closerOf("PostToolUse")).toBe("tool.ended");
    expect(closerOf("SubagentStop")).toBe("subagent.ended");
    for (const name of ["PreToolUse", "constructor", "toString", "hasOwnProperty", "__proto__", ""])
      expect(closerOf(name), name).toBeNull();
  });
});
