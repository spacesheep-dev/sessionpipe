// SPDX-License-Identifier: Apache-2.0
// PROTOCOL.md §3 `triggered_by`: the person's rule a run was started or resumed for, from the
// variable the control daemon sets on the run (SESSIONPIPE_TRIGGERED_BY, CONTROL.md §14),
// stamped by readHook on every harness's reading, the way launched_by and delegated_by are.
// Lineage, never authority: a name to show.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { adapterByName } from "../src/adapters/index.js";
import type { Adapter, HookInput } from "../src/adapters/types.js";
import {
  DELEGATED_BY_ENV,
  LAUNCHED_BY_ENV,
  RULE_NAME_RE,
  readHook,
  TRIGGERED_BY_ENV,
  triggeredBy,
} from "../src/launched-by.js";
import { problems, SCHEMAS } from "../src/schema/index.js";

const input = (env: Record<string, string> = {}): HookInput => ({ argv: ["x", "Start"], stdin: "{}", env, cwd: "/" });
const adapter = (session: Record<string, unknown> | null): Adapter =>
  ({
    name: "x",
    fromHook: () => (session ? { session: { id: "s", ...session }, events: [] } : null),
  }) as unknown as Adapter;
const SAMPLES = [
  "card-todo",
  "monday-report",
  "a",
  "0",
  "x_1",
  "a".repeat(40),
  "a".repeat(41),
  "-lead",
  "_lead",
  "Card-Todo",
  "card todo",
  "card.todo",
  "claude-code:8c132906-8c3f-4814-870a-afc3d05e1d2e",
  "card`todo",
  "card\ntodo",
  "",
];

describe("triggeredBy (PROTOCOL.md §3)", () => {
  it("reads the rule's name from the daemon's variable", () => {
    expect(TRIGGERED_BY_ENV).toBe("SESSIONPIPE_TRIGGERED_BY");
    expect(triggeredBy({ [TRIGGERED_BY_ENV]: "card-todo" })).toBe("card-todo");
    expect(triggeredBy({ [TRIGGERED_BY_ENV]: " monday-report\n" })).toBe("monday-report");
  });
  it("agrees with the schema's pattern, which is the one pattern a rule is named by", () => {
    const field = (SCHEMAS.event.properties.session.properties as Record<string, Record<string, unknown>>)
      .triggered_by!;
    expect(field.pattern).toBe(RULE_NAME_RE.source);
    for (const v of SAMPLES)
      expect(triggeredBy({ [TRIGGERED_BY_ENV]: v }) !== undefined, JSON.stringify(v)).toBe(
        v !== "" && problems(field, v).length === 0,
      );
  });
  it("is nothing when the variable is absent, blank or malformed: never a session ref, never two lines", () => {
    expect(triggeredBy({})).toBeUndefined();
    expect(triggeredBy({ [TRIGGERED_BY_ENV]: "  " })).toBeUndefined();
    for (const bad of ["Card-Todo", "-x", "a".repeat(41), "claude-code:abc", "card`todo", "card\ntodo"])
      expect(triggeredBy({ [TRIGGERED_BY_ENV]: bad }), bad).toBeUndefined();
  });
});

describe("readHook stamps triggered_by", () => {
  it("on the adapter's reading of the session, beside the other lineage", () => {
    expect(readHook(adapter({}), input({ [TRIGGERED_BY_ENV]: "card-todo" }))?.session).toEqual({
      id: "s",
      triggered_by: "card-todo",
    });
    const all = readHook(
      adapter({}),
      input({ [TRIGGERED_BY_ENV]: "card-todo", [DELEGATED_BY_ENV]: "codex:a", [LAUNCHED_BY_ENV]: "codex:l" }),
    );
    expect(all?.session).toEqual({
      id: "s",
      launched_by: "codex:l",
      delegated_by: "codex:a",
      triggered_by: "card-todo",
    });
  });
  it("leaves a subagent to its parent, and passes a null reading through", () => {
    const r = readHook(adapter({ parent_id: "p" }), input({ [TRIGGERED_BY_ENV]: "card-todo" }));
    expect(r?.session).toEqual({ id: "s", parent_id: "p" });
    expect(readHook(adapter(null), input({ [TRIGGERED_BY_ENV]: "card-todo" }))).toBeNull();
    expect(readHook(adapter({}), input())?.session).toEqual({ id: "s" });
  });
});

describe("the rule comes with every harness's reading", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const dir = path.join(root, "conformance/harness");
  const first = readdirSync(dir).flatMap((h) => {
    const d = path.join(dir, h);
    if (!statSync(d).isDirectory()) return [];
    for (const f of readdirSync(d)
      .filter((f) => f.endsWith(".json"))
      .sort()) {
      const fx = JSON.parse(readFileSync(path.join(d, f), "utf8"));
      if (fx.expect.length) return [{ file: path.join(h, f), fx }];
    }
    return [];
  });
  it("a recorded hook of each harness, run with SESSIONPIPE_TRIGGERED_BY set, reports triggered_by", () => {
    const seen = new Set<string>();
    for (const { file, fx } of first) {
      const r = readHook(adapterByName(fx.harness)!, {
        argv: fx.input.argv,
        stdin: fx.input.stdin,
        env: { ...fx.input.env, [TRIGGERED_BY_ENV]: "card-todo" },
        cwd: fx.input.cwd ?? "/",
      });
      expect(r?.session.triggered_by, file).toBe("card-todo");
      seen.add(fx.harness);
    }
    for (const h of ["claude-code", "codex", "gemini-cli", "antigravity", "devin"]) expect(seen.has(h), h).toBe(true);
  });
});
