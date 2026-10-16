// SPDX-License-Identifier: Apache-2.0
// A future harness version cannot crash the hook: every fixture under
// conformance/harness/<name>/ is run through its adapter again with its stdin bent in
// every deterministic way below (a key dropped, an unknown key added, a string turned
// into a number and back, an empty string, a null, malformed JSON, no stdin at all,
// an event name the adapter has never heard of), and fromHook must never throw. What
// it still emits must fit the protocol: the Event envelope and the per-type data
// schema from packages/core/schema/v1.ts. Antigravity's stdout stays a JSON answer,
// since anything else there is a deny.
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { Event, EventData, TYPE_TIER } from "../schema/v1.js";
import { ADAPTERS, AG_STALE_PRETOOL } from "../src/adapters/index.js";
import type { HookInput } from "../src/adapters/types.js";

// Claude Code's hook looks for its parent process in the registry through `ps`: a
// process table per mutation is seconds of nothing. The lookup is its own test.
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFileSync: () => "",
}));

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const harnessDir = path.join(root, "conformance/harness");
// Nothing here may read the real home: the facts hints look there for a registry.
const home = mkdtempSync(path.join(os.tmpdir(), "sp-robust-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));
const ISOLATED = { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), CODEX_HOME: path.join(home, ".codex") };

interface Fixture {
  harness: string;
  input: { argv: string[]; stdin: string; env?: Record<string, string>; cwd?: string };
}
const fixturesOf = (harness: string): { file: string; fx: Fixture }[] => {
  const d = path.join(harnessDir, harness);
  let names: string[] = [];
  try {
    names = statSync(d).isDirectory() ? readdirSync(d).filter((f) => f.endsWith(".json")) : [];
  } catch {}
  return names.map((f) => ({ file: f, fx: JSON.parse(readFileSync(path.join(d, f), "utf8")) as Fixture }));
};

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
interface Mutation {
  name: string;
  stdin: string;
  argv?: string[];
}

/** Every mutation of one stdin, in a fixed order; a key path is `a.b`. */
function mutations(stdin: string, argv: string[]): Mutation[] {
  const [harness = "", event = ""] = argv;
  const out: Mutation[] = [{ name: "as recorded", stdin }];
  let parsed: Json = null;
  try {
    parsed = JSON.parse(stdin) as Json;
  } catch {}
  const isObj = (v: Json): v is { [k: string]: Json } => !!v && typeof v === "object" && !Array.isArray(v);
  if (isObj(parsed)) {
    const o = parsed;
    const at = (patch: (copy: { [k: string]: Json }) => void): string => {
      const copy = JSON.parse(JSON.stringify(o)) as { [k: string]: Json };
      patch(copy);
      return JSON.stringify(copy);
    };
    for (const k of Object.keys(o)) out.push({ name: `drop ${k}`, stdin: at((c) => delete c[k]) });
    out.push({
      name: "an unknown key",
      stdin: at((c) => {
        c.x_future_field = { nested: [1, "two", null, { deep: true }] };
      }),
    });
    // Leaves down to two levels: top-level keys and the fields of tool_input & co.
    const leaves: { path: string[]; value: Json }[] = [];
    const walk = (v: { [k: string]: Json }, prefix: string[], depth: number) => {
      for (const [k, x] of Object.entries(v)) {
        leaves.push({ path: [...prefix, k], value: x });
        if (depth < 2 && isObj(x)) walk(x, [...prefix, k], depth + 1);
      }
    };
    walk(o, [], 1);
    const set = (p: string[], value: Json): string =>
      at((c) => {
        let cur: { [k: string]: Json } = c;
        for (const k of p.slice(0, -1)) cur = cur[k] as { [k: string]: Json };
        cur[p[p.length - 1] as string] = value;
      });
    for (const { path: p, value } of leaves) {
      const name = p.join(".");
      if (typeof value === "string") {
        out.push({ name: `${name} as a number`, stdin: set(p, 42) });
        out.push({ name: `${name} empty`, stdin: set(p, "") });
      } else if (typeof value === "number") out.push({ name: `${name} as a string`, stdin: set(p, "42") });
      else if (typeof value === "boolean") out.push({ name: `${name} as a string`, stdin: set(p, "true") });
      else if (Array.isArray(value)) out.push({ name: `${name} as a string`, stdin: set(p, "[]") });
      else if (isObj(value)) out.push({ name: `${name} as a string`, stdin: set(p, "{}") });
      out.push({ name: `${name} null`, stdin: set(p, null) });
    }
  }
  const half = stdin.slice(0, Math.floor(stdin.length / 2));
  out.push({ name: "cut in half", stdin: half });
  out.push({ name: "an open brace", stdin: "{" });
  out.push({ name: "not JSON", stdin: "not json at all" });
  out.push({ name: "no stdin", stdin: "" });
  out.push({ name: "a JSON array", stdin: "[]" });
  out.push({ name: "a JSON null", stdin: "null" });
  out.push({ name: "a JSON number", stdin: "42" });
  out.push({ name: "a JSON string", stdin: '"hello"' });
  out.push({ name: "an event nobody knows", stdin, argv: [harness, "FutureEventNobodyKnows"] });
  out.push({ name: "no event at all", stdin, argv: [harness] });
  out.push({ name: `${event} spelt in lower case`, stdin, argv: [harness, event.toLowerCase()] });
  return out;
}

const WILD = { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", time: "2026-09-28T00:00:00.000Z" };
const why = (r: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) =>
  r.success ? "" : (r.error?.issues ?? []).map((x) => `${x.path.join(".")} ${x.message}`).join("; ");

describe("adapter robustness: a bent payload never throws, and what comes out still fits the schema", () => {
  for (const adapter of ADAPTERS) {
    const fixtures = fixturesOf(adapter.name);
    describe(adapter.name, () => {
      it("has fixtures to bend", () => expect(fixtures.length).toBeGreaterThan(0));
      for (const { file, fx } of fixtures) {
        it(file, () => {
          const base: HookInput = {
            argv: fx.input.argv,
            stdin: fx.input.stdin,
            env: { ...(fx.input.env ?? {}), ...ISOLATED },
            cwd: fx.input.cwd ?? "/",
          };
          const all = mutations(base.stdin, base.argv);
          expect(all.length).toBeGreaterThan(10);
          for (const m of all) {
            const input: HookInput = { ...base, stdin: m.stdin, argv: m.argv ?? base.argv };
            let r: ReturnType<typeof adapter.fromHook>;
            try {
              r = adapter.fromHook(input);
            } catch (e) {
              throw new Error(`${file} [${m.name}]: fromHook threw ${(e as Error).message}`);
            }
            if (adapter.name === "antigravity") {
              expect(r, `${file} [${m.name}]: antigravity always answers`).not.toBeNull();
              const out = r!.stdout ?? "";
              expect(out === "{}\n" || out === AG_STALE_PRETOOL, `${file} [${m.name}]: stdout ${out}`).toBe(true);
            }
            if (!r) continue;
            expect(Array.isArray(r.events), `${file} [${m.name}]: events`).toBe(true);
            if (!r.events.length) continue;
            for (const e of r.events) {
              const ev = {
                protocol: 1,
                id: WILD.id,
                time: WILD.time,
                type: e.type,
                tier: TYPE_TIER[e.type as keyof typeof TYPE_TIER] ?? 0,
                harness: { name: adapter.name, event: e.harnessEvent },
                session: { ...r.session, seq: 0 },
                privacy: { rulesets: ["secrets@1"], pii: false },
                data: e.data,
              };
              const env = Event.safeParse(ev);
              expect(env.success, `${file} [${m.name}] ${e.type} envelope: ${why(env)}`).toBe(true);
              const dataSchema = EventData.shape[e.type as keyof typeof EventData.shape];
              expect(dataSchema, `${file} [${m.name}]: unknown type ${e.type}`).toBeDefined();
              const d = dataSchema.safeParse(e.data);
              expect(d.success, `${file} [${m.name}] ${e.type} data: ${why(d)}`).toBe(true);
            }
          }
        });
      }
    });
  }
});
