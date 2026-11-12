// SPDX-License-Identifier: Apache-2.0
/** @sessionpipe/conformance — runs the fixtures against an adapter (here) or a receiver URL (M3). */
import { readFileSync } from "node:fs";
import { adapterByName, readHook } from "@sessionpipe/core";

export interface FixtureResult {
  file: string;
  ok: boolean;
  why?: string;
}

/** No control character reaches a terminal from a fixture's name or its words: each is shown
 *  as `\xNN`. The table is one row per line, so a line break in a name is escaped too. */
export function printable(s: string): string {
  return s.replace(/\p{Cc}/gu, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

/** The first difference, or null. `"*"` matches anything. With `exact`, an object the adapter
 *  made may hold no field the fixture does not name (an event's `data`: an extra field there is
 *  content leaving the machine that no fixture vouched for); without it the fixture's fields
 *  are the ones compared (a session's facts, which a harness's environment adds to). */
function matches(expect: unknown, got: unknown, pathStr: string, exact: boolean): string | null {
  if (expect === "*") return null;
  if (Array.isArray(expect)) {
    if (!Array.isArray(got) || got.length !== expect.length) return `${pathStr}: expected ${expect.length} items`;
    for (let i = 0; i < expect.length; i++) {
      const r = matches(expect[i], got[i], `${pathStr}[${i}]`, exact);
      if (r) return r;
    }
    return null;
  }
  if (expect && typeof expect === "object") {
    if (!got || typeof got !== "object") return `${pathStr}: expected an object`;
    for (const [k, v] of Object.entries(expect as Record<string, unknown>)) {
      const r = matches(v, (got as Record<string, unknown>)[k], `${pathStr}.${k}`, exact);
      if (r) return r;
    }
    const extra = exact ? Object.keys(got).find((k) => !Object.hasOwn(expect, k)) : undefined;
    return extra === undefined ? null : `${pathStr}.${extra}: not in the fixture`;
  }
  return expect === got ? null : `${pathStr}: expected ${JSON.stringify(expect)}, got ${JSON.stringify(got)}`;
}

interface Fixture {
  harness: string;
  input: { argv: string[]; stdin: string; env?: Record<string, string>; cwd?: string };
  expect: { type: string; harness: { event: string }; session?: Record<string, unknown>; data: unknown }[];
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isStrings = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === "string");

/** What keeps a parsed file from being run as an adapter fixture, or null. Every field the
 *  runner reads is checked here, so a malformed fixture is a FAIL row and never a throw. */
function malformed(fx: unknown): string | null {
  // A redaction, delivery or control-vector fixture in the same tree is not one of these.
  if (!isObject(fx) || typeof fx.harness !== "string" || !fx.input || !Array.isArray(fx.expect))
    return "not an adapter fixture: it needs harness, input and expect";
  const input = fx.input;
  if (!isObject(input) || !isStrings(input.argv) || typeof input.stdin !== "string")
    return "malformed fixture: input needs argv (strings) and stdin (a string)";
  if (input.env !== undefined && !(isObject(input.env) && isStrings(Object.values(input.env))))
    return "malformed fixture: input.env is a map of strings";
  if (input.cwd !== undefined && typeof input.cwd !== "string") return "malformed fixture: input.cwd is a string";
  const bad = fx.expect.findIndex((e) => !isObject(e) || !isObject(e.harness));
  return bad === -1 ? null : `malformed fixture: expect[${bad}] needs type, harness.event, session and data`;
}

/** Run adapter fixtures ({input:{argv,stdin,env,cwd}, expect:[events]}) through core's adapters. */
export async function runAdapterFixtures(
  files: string[],
): Promise<{ results: FixtureResult[]; failed: number; table: string }> {
  const results: FixtureResult[] = [];
  for (const file of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      // A read error has a code (EISDIR, EACCES); a parse error has none.
      const code = (e as NodeJS.ErrnoException).code;
      results.push({ file, ok: false, why: code ? `not readable: ${code}` : `not JSON: ${(e as Error).message}` });
      continue;
    }
    const bad = malformed(parsed);
    if (bad) {
      results.push({ file, ok: false, why: bad });
      continue;
    }
    const fx = parsed as Fixture;
    const adapter = adapterByName(fx.harness);
    if (!adapter) {
      results.push({ file, ok: false, why: `no adapter ${fx.harness}` });
      continue;
    }
    const r = readHook(adapter, {
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
      false,
    );
    if (!why)
      for (const [i, e] of fx.expect.entries()) {
        const got = r.events[i] as (typeof r.events)[number]; // one per expected type: the count matched above
        why =
          matches(e.harness.event, got.harnessEvent, `[${i}].harness.event`, false) ??
          matches(e.data, got.data, `[${i}].data`, true) ??
          matches({ ...e.session, seq: "*" }, r.session, `[${i}].session`, false);
        if (why) break;
      }
    results.push(why ? { file, ok: false, why } : { file, ok: true });
  }
  const failed = results.filter((r) => !r.ok).length;
  const table = results
    .map((r) => `${r.ok ? "ok  " : "FAIL"} ${printable(r.file)}${r.why ? ` — ${printable(r.why)}` : ""}`)
    .join("\n");
  return { results, failed, table };
}
