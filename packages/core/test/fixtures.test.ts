// SPDX-License-Identifier: Apache-2.0
// Every recorded fixture under conformance/harness/<name>/ through its adapter:
// the events it emits must match `expect` (wildcards "*" for id, time, tier, seq).
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { adapterByName } from "../src/adapters/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dir = path.join(root, "conformance/harness");
const files = readdirSync(dir).flatMap((h) => {
  const d = path.join(dir, h);
  return statSync(d).isDirectory()
    ? readdirSync(d)
        .filter((f) => f.endsWith(".json"))
        .map((f) => path.join(d, f))
    : [];
});

/** `expect` with each "*" leaf (an id the sender mints) replaced by what the adapter gave. */
const wild = (exp: unknown, got: unknown): unknown => {
  if (exp === "*") return got;
  if (exp && typeof exp === "object" && !Array.isArray(exp))
    return Object.fromEntries(
      Object.entries(exp).map(([k, v]) => [k, wild(v, (got as Record<string, unknown> | undefined)?.[k])]),
    );
  return exp;
};

describe("adapter fixtures", () => {
  for (const f of files) {
    const fx = JSON.parse(readFileSync(f, "utf8"));
    it(path.relative(root, f), () => {
      const adapter = adapterByName(fx.harness);
      expect(adapter, `adapter ${fx.harness}`).toBeDefined();
      const r = adapter!.fromHook({
        argv: fx.input.argv,
        stdin: fx.input.stdin,
        env: fx.input.env ?? {},
        cwd: fx.input.cwd ?? "/",
      });
      // An empty `expect`: a payload the adapter reports nothing for.
      if (!fx.expect.length) {
        expect(r?.events ?? []).toEqual([]);
        return;
      }
      expect(r, "fromHook returned null").not.toBeNull();
      expect(r!.events.map((e) => e.type)).toEqual(fx.expect.map((e: { type: string }) => e.type));
      for (const [i, e] of fx.expect.entries()) {
        const got = r!.events[i]!;
        expect(got.harnessEvent).toBe(e.harness.event);
        expect(got.data).toEqual(wild(e.data, got.data));
        for (const [k, v] of Object.entries(e.session))
          if (v !== "*") expect((r!.session as Record<string, unknown>)[k]).toEqual(v);
      }
    });
  }
});
