// SPDX-License-Identifier: Apache-2.0
/** @sessionpipe/conformance — runs the fixtures against an adapter (here) or a receiver URL (M3). */
import { readFileSync } from "node:fs";
import { adapterByName } from "@sessionpipe/core";

export interface FixtureResult {
  file: string;
  ok: boolean;
  why?: string;
}

function matches(expect: unknown, got: unknown, pathStr = ""): string | null {
  if (expect === "*") return null;
  if (Array.isArray(expect)) {
    if (!Array.isArray(got) || got.length !== expect.length) return `${pathStr}: expected ${expect.length} items`;
    for (let i = 0; i < expect.length; i++) {
      const r = matches(expect[i], got[i], `${pathStr}[${i}]`);
      if (r) return r;
    }
    return null;
  }
  if (expect && typeof expect === "object") {
    if (!got || typeof got !== "object") return `${pathStr}: expected an object`;
    for (const [k, v] of Object.entries(expect as Record<string, unknown>)) {
      const r = matches(v, (got as Record<string, unknown>)[k], `${pathStr}.${k}`);
      if (r) return r;
    }
    return null;
  }
  return expect === got ? null : `${pathStr}: expected ${JSON.stringify(expect)}, got ${JSON.stringify(got)}`;
}

/** Run adapter fixtures ({input:{argv,stdin,env,cwd}, expect:[events]}) through core's adapters. */
export async function runAdapterFixtures(
  files: string[],
): Promise<{ results: FixtureResult[]; failed: number; table: string }> {
  const results: FixtureResult[] = [];
  for (const file of files) {
    const fx = JSON.parse(readFileSync(file, "utf8")) as {
      harness: string;
      input: { argv: string[]; stdin: string; env?: Record<string, string>; cwd?: string };
      expect: { type: string; harness: { event: string }; session: Record<string, unknown>; data: unknown }[];
    };
    const adapter = adapterByName(fx.harness);
    if (!adapter) {
      results.push({ file, ok: false, why: `no adapter ${fx.harness}` });
      continue;
    }
    const r = adapter.fromHook({
      argv: fx.input.argv,
      stdin: fx.input.stdin,
      env: fx.input.env ?? {},
      cwd: fx.input.cwd ?? "/",
    });
    // An empty `expect` is a payload the adapter reports nothing for.
    if (!r) {
      results.push(fx.expect.length ? { file, ok: false, why: "fromHook returned null" } : { file, ok: true });
      continue;
    }
    let why: string | null = matches(
      fx.expect.map((e) => e.type),
      r.events.map((e) => e.type),
      "types",
    );
    if (!why)
      for (const [i, e] of fx.expect.entries()) {
        const got = r.events[i] as (typeof r.events)[number]; // one per expected type: the count matched above
        why =
          matches(e.harness.event, got.harnessEvent, `[${i}].harness.event`) ??
          matches(e.data, got.data, `[${i}].data`) ??
          matches({ ...e.session, seq: "*" }, r.session, `[${i}].session`);
        if (why) break;
      }
    results.push(why ? { file, ok: false, why } : { file, ok: true });
  }
  const failed = results.filter((r) => !r.ok).length;
  const table = results.map((r) => `${r.ok ? "ok  " : "FAIL"} ${r.file}${r.why ? ` — ${r.why}` : ""}`).join("\n");
  return { results, failed, table };
}
