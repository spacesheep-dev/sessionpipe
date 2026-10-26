// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { capTail, filterEvent, TYPE_TIER } from "../src/privacy/filter.js";
import { hashMachine } from "../src/privacy/pii.js";
import { REDACTED, redactSecrets } from "../src/privacy/secrets.js";
import type { Event, Tier } from "../src/types.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

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

/** PROTOCOL.md §4: the data keys each type carries, per tier (cumulative). */
const SPEC: Record<string, Partial<Record<Tier, string[]>>> = {
  "session.started": { 0: ["source"] },
  "session.heartbeat": {},
  "session.ended": { 0: ["reason"] },
  "session.backfill": { 0: ["started_at", "last_at", "turns"] },
  "session.forgotten": {},
  "turn.started": { 0: ["turn_id", "submitted_by", "injected"], 1: ["prompt_chars"] },
  "turn.ended": { 0: ["turn_id", "reason", "ms"], 1: ["error"] },
  "turn.transcript": { 2: ["turn", "user", "assistant", "at"] },
  "turn.progress": { 2: ["turn", "user", "assistant", "at"] },
  "tool.started": { 1: ["tool", "call_id", "turn_id", "agent_id"], 3: ["input"] },
  "tool.ended": { 1: ["tool", "call_id", "turn_id", "agent_id", "ms", "ok", "error"], 3: ["input", "output"] },
  "files.changed": { 1: ["paths"] },
  "attention.needed": { 0: ["attention_id", "kind"], 1: ["tool", "message"] },
  "attention.cleared": { 0: ["attention_id", "how"] },
  "subagent.started": { 1: ["agent_id", "agent_type"] },
  "subagent.ended": { 1: ["agent_id", "agent_type"] },
  "context.compacted": { 1: ["trigger"] },
};
/** Every key any type carries, plus one the spec never names. */
const EVERY_KEY: Record<string, unknown> = {
  source: "startup",
  reason: "stop",
  started_at: "2026-09-28T00:00:00.000Z",
  last_at: "2026-09-28T00:00:00.000Z",
  turns: 3,
  turn_id: "t1",
  prompt_chars: 12,
  ms: 5,
  error: "boom",
  turn: 1,
  user: "u",
  assistant: "a",
  at: "2026-09-28T00:00:00.000Z",
  tool: "Bash",
  call_id: "c1",
  agent_id: "ag",
  input: { x: 1 },
  output: "o",
  ok: true,
  paths: ["a.ts"],
  attention_id: "at1",
  kind: "permission",
  message: "m",
  how: "answered",
  agent_type: "x",
  trigger: "auto",
  submitted_by: "loop_wakeup",
  injected: true,
  extra: "never sent",
};
const TIERS: Tier[] = [0, 1, 2, 3];

describe("filterEvent: the allowlist is the spec's table (PRIVACY.md §1)", () => {
  it("knows exactly the spec's types", () => {
    expect(Object.keys(TYPE_TIER).sort()).toEqual([...Object.keys(SPEC), "native"].sort());
  });
  for (const type of Object.keys(SPEC)) {
    it(`${type}: dropped below its tier, then exactly the named keys, never one the spec omits`, () => {
      for (const tier of TIERS) {
        const out = filterEvent(base({ type, data: EVERY_KEY }), tier, false);
        if ((TYPE_TIER[type] as Tier) > tier) {
          expect(out, `${type} at ${tier}`).toBeNull();
          continue;
        }
        const want = TIERS.filter((t) => t <= tier).flatMap((t) => SPEC[type]?.[t] ?? []);
        expect(out, `${type} at ${tier}`).not.toBeNull();
        expect(Object.keys(out!.data).sort(), `${type} at ${tier}`).toEqual(want.sort());
        expect(out!.tier).toBe(tier);
        expect(out!.type).toBe(type);
      }
    });
  }
  it("a higher tier only adds keys, never removes one", () => {
    for (const type of Object.keys(SPEC))
      for (let t = 0; t < 3; t++) {
        const lo = filterEvent(base({ type, data: EVERY_KEY }), t as Tier, false);
        const hi = filterEvent(base({ type, data: EVERY_KEY }), (t + 1) as Tier, false)!;
        if (lo) for (const k of Object.keys(lo.data)) expect(hi.data).toHaveProperty(k);
      }
  });
  it("native is tier 3 only and goes through whole", () => {
    for (const tier of [0, 1, 2] as Tier[])
      expect(filterEvent(base({ type: "native", data: EVERY_KEY }), tier, false)).toBeNull();
    expect(filterEvent(base({ type: "native", data: EVERY_KEY }), 3, false)!.data).toEqual(EVERY_KEY);
  });
  it("never answers above the sink's tier, whatever the event claimed", () => {
    for (const tier of TIERS)
      for (const claimed of TIERS) {
        const out = filterEvent(
          base({ type: "session.started", tier: claimed, data: { source: "startup" } }),
          tier,
          false,
        )!;
        expect(out.tier).toBe(tier);
      }
  });
  it("only the session fields the spec names survive", () => {
    const out = filterEvent(
      base({
        session: {
          id: "s",
          seq: 1,
          machine: "m",
          email: "x@y.z",
          attended: false,
          parent_id: null,
        } as Event["session"],
      }),
      3,
      false,
    )!;
    expect(out.session).toEqual({ id: "s", seq: 1, machine: "m", attended: false, parent_id: null });
  });
  it("is idempotent without pii", () => {
    for (const type of Object.keys(SPEC))
      for (const tier of TIERS) {
        const once = filterEvent(base({ type, data: EVERY_KEY }), tier, false);
        if (once) expect(filterEvent(once, tier, false)).toEqual(once);
      }
  });
});

describe("filterEvent: pii@1 runs only when opted in", () => {
  const fx = JSON.parse(readFileSync(path.join(root, "conformance/redaction/pii.json"), "utf8")) as {
    cases: { name: string; in: string; out: string; home?: string }[];
  };
  const transcript = (user: string) =>
    base({ type: "turn.transcript", data: { turn: 1, user, assistant: "a", at: "2026-09-28T00:00:00.000Z" } });
  for (const c of fx.cases) {
    it(c.name, () => {
      expect(redactSecrets(c.in), "the vector carries no secret").toBe(c.in);
      const opts = c.home === undefined ? {} : { home: c.home };
      const off = filterEvent(transcript(c.in), 2, false, opts)!;
      expect(off.data.user).toBe(c.in);
      expect(off.session.account_id).toBe("acct-1");
      expect(off.privacy).toEqual({ rulesets: ["secrets@1"], pii: false });
      const on = filterEvent(transcript(c.in), 2, true, opts)!;
      expect(on.data.user).toBe(c.out);
      expect(on.privacy).toEqual({ rulesets: ["secrets@1", "pii@1"], pii: true });
    });
  }
  it("at tier 0 pii@1 still reduces the session block, and secrets@1 does not run", () => {
    const e = filterEvent(base({ type: "session.started", data: { source: "startup" } }), 0, true)!;
    expect(e.session.machine).toBe(hashMachine("misha-air"));
    expect(e.session.account_id).toBeUndefined();
    expect(e.privacy).toEqual({ rulesets: ["pii@1"], pii: true });
    const bare = filterEvent(base({ type: "session.started", session: { id: "s", seq: 0 }, data: {} }), 0, true)!;
    expect(bare.session).toEqual({ id: "s", seq: 0 });
    // Who attends a session is tier 0, and pii@1 leaves it alone.
    const att = filterEvent(
      base({ type: "session.started", session: { id: "s", seq: 0, attended: false }, data: {} }),
      0,
      true,
    )!;
    expect(att.session).toEqual({ id: "s", seq: 0, attended: false });
  });
});

describe("filterEvent: caps", () => {
  it("tool input and output: a string or an object over 64 KB is cut, anything else passes as is", () => {
    const big = { blob: "x".repeat(70_000) };
    const e = filterEvent(base({ data: { tool: "Bash", input: big, output: "y".repeat(70_000) } }), 3, false)!;
    expect(typeof e.data.input).toBe("string");
    expect((e.data.input as string).length).toBe(64 * 1024 + 1);
    expect((e.data.input as string).startsWith('{"blob":"xxx')).toBe(true);
    expect((e.data.output as string).length).toBe(64 * 1024 + 1);
    const small = filterEvent(base({ data: { tool: "Bash", input: { a: 1 }, output: 5 } }), 3, false)!;
    expect(small.data.input).toEqual({ a: 1 });
    expect(small.data.output).toBe(5);
  });
  it("a running turn's reply keeps its end; an attention message is cut at 200", () => {
    const reply = `${"a".repeat(10)}${"b".repeat(30_000)}`;
    const p = filterEvent(
      base({ type: "turn.progress", data: { turn: 1, user: "u", assistant: reply, at: "2026-09-28T00:00:00.000Z" } }),
      2,
      false,
    )!;
    expect(p.data.assistant).toBe(`…${"b".repeat(19_999)}`);
    const t = filterEvent(
      base({ type: "turn.transcript", data: { turn: 1, user: "u", assistant: reply, at: "2026-09-28T00:00:00.000Z" } }),
      2,
      false,
    )!;
    expect(t.data.assistant).toBe(`${"a".repeat(10)}${"b".repeat(19_990)}…`);
    const a = filterEvent(
      base({ type: "attention.needed", data: { attention_id: "a", kind: "permission", message: "m".repeat(300) } }),
      1,
      false,
    )!;
    expect(a.data.message).toBe(`${"m".repeat(200)}…`);
  });
  it("capTail", () => {
    expect(capTail("abc", 5)).toBe("abc");
    expect(capTail("abcdef", 4)).toBe("…def");
  });
});
