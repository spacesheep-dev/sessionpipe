// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { Session } from "../schema/v1.js";
import type { Adapter, HookInput } from "../src/adapters/types.js";
import { LAUNCHED_BY_ENV, launchedBy, readHook } from "../src/launched-by.js";

const LAUNCHER = "claude-code:ed6c7665-589f-40c7-b7b4-e38ee662b7bc";
const input = (env: Record<string, string> = {}): HookInput => ({ argv: ["x", "Start"], stdin: "{}", env, cwd: "/" });
const adapter = (session: Record<string, unknown> | null): Adapter =>
  ({
    name: "x",
    fromHook: () => (session ? { session: { id: "s", ...session }, events: [] } : null),
  }) as unknown as Adapter;

describe("launchedBy (PROTOCOL.md §3)", () => {
  it("reads <harness>:<id> from the launcher's variable", () => {
    expect(launchedBy({ [LAUNCHED_BY_ENV]: LAUNCHER })).toBe(LAUNCHER);
    expect(launchedBy({ [LAUNCHED_BY_ENV]: " codex:019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b " })).toBe(
      "codex:019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b",
    );
  });
  it("agrees with the schema's pattern", () => {
    const field = Session.shape.launched_by;
    for (const v of [
      LAUNCHER,
      "a:b",
      "no-colon",
      "Claude:abc",
      ":abc",
      "codex:",
      "codex:bad id",
      `codex:${"a".repeat(129)}`,
      `${"h".repeat(41)}:x`,
    ])
      expect(launchedBy({ [LAUNCHED_BY_ENV]: v }) !== undefined, v).toBe(field.safeParse(v).success);
  });
  it("is nothing when the variable is absent, blank or malformed", () => {
    expect(launchedBy({})).toBeUndefined();
    expect(launchedBy({ [LAUNCHED_BY_ENV]: "  " })).toBeUndefined();
    for (const bad of ["no-colon", "Claude:abc", ":abc", "codex:", "codex:bad id", `codex:${"a".repeat(129)}`])
      expect(launchedBy({ [LAUNCHED_BY_ENV]: bad }), bad).toBeUndefined();
  });
});

describe("readHook", () => {
  it("adds the launcher to the adapter's reading of the session", () => {
    expect(readHook(adapter({}), input({ [LAUNCHED_BY_ENV]: LAUNCHER }))?.session.launched_by).toBe(LAUNCHER);
  });
  it("ignores a value that names the session itself", () => {
    expect(readHook(adapter({}), input({ [LAUNCHED_BY_ENV]: "x:s" }))?.session).toEqual({ id: "s" });
  });
  it("leaves a subagent to its parent", () => {
    const r = readHook(adapter({ parent_id: "p" }), input({ [LAUNCHED_BY_ENV]: LAUNCHER }));
    expect(r?.session).toEqual({ id: "s", parent_id: "p" });
  });
  it("changes nothing without the variable, and passes a null reading through", () => {
    expect(readHook(adapter({}), input())?.session).toEqual({ id: "s" });
    expect(readHook(adapter(null), input({ [LAUNCHED_BY_ENV]: LAUNCHER }))).toBeNull();
  });
});
