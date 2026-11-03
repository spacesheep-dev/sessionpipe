// SPDX-License-Identifier: Apache-2.0
// PROTOCOL.md §3 `delegated_by`: the session an asked agent answers, from the variable
// the control daemon sets on the child (SESSIONPIPE_ASKED_BY), stamped by readHook on
// every harness's reading, the way launched_by is.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Session } from "../schema/v1.js";
import { adapterByName } from "../src/adapters/index.js";
import type { Adapter, HookInput } from "../src/adapters/types.js";
import { DELEGATED_BY_ENV, delegatedBy, LAUNCHED_BY_ENV, readHook } from "../src/launched-by.js";

const ASKER = "claude-code:ed6c7665-589f-40c7-b7b4-e38ee662b7bc";
const input = (env: Record<string, string> = {}): HookInput => ({ argv: ["x", "Start"], stdin: "{}", env, cwd: "/" });
const adapter = (session: Record<string, unknown> | null): Adapter =>
  ({
    name: "x",
    fromHook: () => (session ? { session: { id: "s", ...session }, events: [] } : null),
  }) as unknown as Adapter;

describe("delegatedBy (PROTOCOL.md §3)", () => {
  it("reads <harness>:<id> from the daemon's variable", () => {
    expect(DELEGATED_BY_ENV).toBe("SESSIONPIPE_ASKED_BY");
    expect(delegatedBy({ [DELEGATED_BY_ENV]: ASKER })).toBe(ASKER);
    expect(delegatedBy({ [DELEGATED_BY_ENV]: " codex:019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b " })).toBe(
      "codex:019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b",
    );
  });
  it("agrees with the schema's pattern", () => {
    const field = Session.shape.delegated_by;
    for (const v of [
      ASKER,
      "a:b",
      "no-colon",
      "Claude:abc",
      ":abc",
      "codex:",
      "codex:bad id",
      `codex:${"a".repeat(129)}`,
      `${"h".repeat(41)}:x`,
    ])
      expect(delegatedBy({ [DELEGATED_BY_ENV]: v }) !== undefined, v).toBe(field.safeParse(v).success);
  });
  it("is nothing when the variable is absent, blank or malformed", () => {
    expect(delegatedBy({})).toBeUndefined();
    expect(delegatedBy({ [DELEGATED_BY_ENV]: "  " })).toBeUndefined();
    for (const bad of ["no-colon", "Claude:abc", ":abc", "codex:", "codex:bad id"])
      expect(delegatedBy({ [DELEGATED_BY_ENV]: bad }), bad).toBeUndefined();
  });
});

describe("readHook stamps delegated_by", () => {
  it("on the adapter's reading of the session, beside launched_by when both are set", () => {
    expect(readHook(adapter({}), input({ [DELEGATED_BY_ENV]: ASKER }))?.session).toEqual({
      id: "s",
      delegated_by: ASKER,
    });
    const both = readHook(adapter({}), input({ [DELEGATED_BY_ENV]: ASKER, [LAUNCHED_BY_ENV]: "codex:t1" }));
    expect(both?.session).toEqual({ id: "s", delegated_by: ASKER, launched_by: "codex:t1" });
  });
  it("ignores a value that names the session itself", () => {
    expect(readHook(adapter({}), input({ [DELEGATED_BY_ENV]: "x:s" }))?.session).toEqual({ id: "s" });
  });
  it("leaves a subagent to its parent", () => {
    const r = readHook(adapter({ parent_id: "p" }), input({ [DELEGATED_BY_ENV]: ASKER }));
    expect(r?.session).toEqual({ id: "s", parent_id: "p" });
  });
  it("changes nothing without the variable, and passes a null reading through", () => {
    expect(readHook(adapter({}), input())?.session).toEqual({ id: "s" });
    expect(readHook(adapter(null), input({ [DELEGATED_BY_ENV]: ASKER }))).toBeNull();
  });
});

describe("the asker comes with every harness's reading", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const dir = path.join(root, "conformance/harness");
  // One recorded hook per harness directory, the first its adapter reports on: readHook is
  // the one path for every adapter (fixtures.test.ts runs every fixture through it).
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
  it("a recorded hook of each harness, run with SESSIONPIPE_ASKED_BY set, reports delegated_by", () => {
    const seen = new Set<string>();
    for (const { file, fx } of first) {
      const asker = `${fx.harness}:asker-${seen.size}`;
      const r = readHook(adapterByName(fx.harness)!, {
        argv: fx.input.argv,
        stdin: fx.input.stdin,
        env: { ...fx.input.env, [DELEGATED_BY_ENV]: asker },
        cwd: fx.input.cwd ?? "/",
      });
      expect(r?.session.delegated_by, file).toBe(asker);
      seen.add(fx.harness);
    }
    // Every adapter in the registry has a fixture (registry.test.ts), so every one was checked.
    for (const h of ["claude-code", "codex", "gemini-cli", "antigravity", "devin"]) expect(seen.has(h), h).toBe(true);
  });
});
