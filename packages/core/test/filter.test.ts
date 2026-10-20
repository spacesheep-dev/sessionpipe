// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { filterEvent } from "../src/privacy/filter.js";
import { REDACTED } from "../src/privacy/secrets.js";
import type { Event } from "../src/types.js";

const base = (over: Partial<Event> & { data?: Record<string, unknown> }): Event => ({
  protocol: 1,
  id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  type: "tool.ended",
  time: "2026-09-28T00:00:00.000Z",
  tier: 3,
  harness: { name: "codex", event: "PostToolUse" },
  session: { id: "s1", seq: 4, machine: "misha-air", cwd: "~/x", account_id: "acct-1" },
  privacy: { rulesets: [], pii: false },
  data: { tool: "Bash", call_id: "c1", ok: true, input: { command: "export DB_PASSWORD=hunter2" }, output: "ok" },
  ...over,
});

describe("filterEvent", () => {
  it("drops a type above the tier", () => {
    expect(filterEvent(base({}), 0, false)).toBeNull();
    expect(
      filterEvent(
        base({ type: "turn.transcript", data: { turn: 1, user: "u", assistant: "a", at: "2026-09-28T00:00:00.000Z" } }),
        1,
        false,
      ),
    ).toBeNull();
  });
  it("keeps only the allowlisted data keys per tier", () => {
    const t1 = filterEvent(base({}), 1, false)!;
    expect(Object.keys(t1.data).sort()).toEqual(["call_id", "ok", "tool"]);
    const t3 = filterEvent(base({}), 3, false)!;
    expect(Object.keys(t3.data).sort()).toEqual(["call_id", "input", "ok", "output", "tool"]);
  });
  it("a turn's end keeps its background count at tier 0, and its error only from tier 1", () => {
    const end = base({
      type: "turn.ended",
      harness: { name: "claude-code", event: "Stop" },
      data: { turn_id: "p1", reason: "stop", background: 2, error: "overloaded" },
    });
    expect(filterEvent(end, 0, false)!.data).toEqual({ turn_id: "p1", reason: "stop", background: 2 });
    expect(filterEvent(end, 1, false)!.data).toEqual({
      turn_id: "p1",
      reason: "stop",
      background: 2,
      error: "overloaded",
    });
  });
  it("redacts above tier 0 and records the ruleset", () => {
    const t3 = filterEvent(base({}), 3, false)!;
    expect((t3.data.input as { command: string }).command).toBe(`export DB_PASSWORD=${REDACTED}`);
    expect(t3.privacy).toEqual({ rulesets: ["secrets@1"], pii: false });
    const t0 = filterEvent(base({ type: "session.started", data: { source: "startup" } }), 0, false)!;
    expect(t0.privacy.rulesets).toEqual([]);
  });
  it("pii@1 hashes the machine, drops account_id, rewrites home", () => {
    const e = filterEvent(
      base({
        type: "attention.needed",
        data: { attention_id: "a", kind: "permission", message: "mail bob@example.com at /Users/misha/x" },
      }),
      1,
      true,
      { home: "/Users/misha" },
    )!;
    expect(e.session.machine).toHaveLength(8);
    expect(e.session.account_id).toBeUndefined();
    expect(e.data.message).toBe("mail [email] at ~/x");
    expect(e.privacy).toEqual({ rulesets: ["secrets@1", "pii@1"], pii: true });
  });
  it("keeps an unknown type whole", () => {
    const e = filterEvent(base({ type: "x.y", data: { anything: 1 } }), 0, false)!;
    expect(e.data).toEqual({ anything: 1 });
  });
  it("caps transcript sides", () => {
    const e = filterEvent(
      base({
        type: "turn.transcript",
        data: { turn: 1, user: "u".repeat(30_000), assistant: "a", at: "2026-09-28T00:00:00.000Z" },
      }),
      2,
      false,
    )!;
    expect((e.data.user as string).length).toBe(20_001);
  });
});
