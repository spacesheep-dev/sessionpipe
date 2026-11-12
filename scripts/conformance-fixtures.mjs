// SPDX-License-Identifier: Apache-2.0
// Conformance fixtures, two checks:
//  1. Shape: every expected event in conformance/harness/** validates against the
//     Zod source (wildcards "*" substituted), and every delivery scenario parses.
//     This runs from M1 on, so a fixture can never contradict the schema.
//  2. Behaviour: when @sessionpipe/conformance is built (M2+), every adapter fixture
//     is run through core's adapter and the events compared.
// Exits non-zero on any miss.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { envelope } from "./lib/envelope.mjs";
import { walkFiles as walk } from "./lib/walk.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// A symbolic link under conformance/ is an error (scripts/lib/walk.mjs): nothing outside is read.
const harness = walk(path.join(root, "conformance/harness")).filter((f) => f.endsWith(".json"));
const delivery = walk(path.join(root, "conformance/delivery")).filter((f) => f.endsWith(".json"));
if (!harness.length && !delivery.length) {
  console.log("conformance: no fixtures yet");
  process.exit(0);
}

const schemaMod = path.join(root, "packages/core/dist/schema.js");
if (!existsSync(schemaMod)) {
  console.error("conformance: build @sessionpipe/core first (npm run build)");
  process.exit(1);
}
const S = await import(pathToFileURL(schemaMod).href);

let failed = 0;
const rows = [];
for (const f of harness) {
  const rel = path.relative(root, f);
  const problems = [];
  // A fixture that is not JSON, or not the shape below, is a FAIL row, never a crash.
  let fx = null;
  try {
    fx = JSON.parse(readFileSync(f, "utf8"));
  } catch (e) {
    problems.push(`not JSON: ${e.message}`);
  }
  if (fx === null || typeof fx !== "object") {
    if (!problems.length) problems.push("not an object");
    failed++;
    rows.push([rel, "FAIL", problems.join(" | ")]);
    continue;
  }
  if (!fx.input || typeof fx.input.stdin !== "string" || !Array.isArray(fx.input.argv))
    problems.push("input.{argv,stdin} missing");
  // An empty `expect` is a payload the adapter must report nothing for; check 2 holds it to that.
  if (!Array.isArray(fx.expect)) problems.push("expect missing");
  for (const [i, e] of (Array.isArray(fx.expect) ? fx.expect : []).entries()) {
    if (e === null || typeof e !== "object") {
      problems.push(`expect[${i}] is not an object`);
      continue;
    }
    let ev;
    try {
      ev = envelope(e, S.TYPE_TIER);
    } catch (err) {
      problems.push(`expect[${i}] envelope: ${err.message}`);
      continue;
    }
    const r = S.Event.safeParse(ev);
    if (!r.success)
      problems.push(
        `expect[${i}] envelope: ${r.error.issues.map((x) => `${x.path.join(".")} ${x.message}`).join("; ")}`,
      );
    // Own keys only: "constructor" and "toString" are on every object, and are not schemas.
    const dataSchema = Object.hasOwn(S.EventData.shape, e.type) ? S.EventData.shape[e.type] : null;
    if (dataSchema) {
      const d = dataSchema.safeParse(e.data);
      if (!d.success)
        problems.push(
          `expect[${i}] data for ${e.type}: ${d.error.issues.map((x) => `${x.path.join(".")} ${x.message}`).join("; ")}`,
        );
    }
  }
  if (problems.length) failed++;
  rows.push([rel, problems.length ? "FAIL" : "ok", problems.join(" | ")]);
}
for (const f of delivery) {
  const rel = path.relative(root, f);
  try {
    const j = JSON.parse(readFileSync(f, "utf8"));
    if (!j.name || !Array.isArray(j.steps) || !j.steps.length) throw new Error("needs name and steps[]");
    rows.push([rel, "ok", ""]);
  } catch (e) {
    failed++;
    rows.push([rel, "FAIL", String(e.message)]);
  }
}

// Control vectors: every signed message fits control.json (the receiver's envelope
// fields aside), and every command a vector expects to verify fits control-command.json,
// as every key a vector expects to enroll fits control-key.json.
const vectors = walk(path.join(root, "conformance/control-vectors")).filter((f) => f.endsWith(".json"));
const Carried = S.ControlMessage.omit({ id: true, at: true, expires_at: true });
for (const f of vectors) {
  const rel = path.relative(root, f);
  const problems = [];
  try {
    const v = JSON.parse(readFileSync(f, "utf8"));
    if (!v.name || !v.input || !v.expect || typeof v.expect.ok !== "boolean")
      problems.push("needs name, input, expect.ok");
    if (v.input?.signed) {
      const shape = Carried.safeParse(v.input.signed);
      // Broken vectors may break the command, never the envelope's own types.
      if (!shape.success && typeof v.input.signed.cmd === "string" && v.input.signed.cmd.length <= 12_000)
        problems.push(`signed: ${shape.error.issues.map((x) => `${x.path.join(".")} ${x.message}`).join("; ")}`);
      if (v.expect.ok) {
        const c = S.ControlCommand.safeParse(JSON.parse(v.input.signed.cmd));
        if (!c.success)
          problems.push(`cmd: ${c.error.issues.map((x) => `${x.path.join(".")} ${x.message}`).join("; ")}`);
      }
    } else if (v.input?.proof) {
      // Like a command: a broken vector may bring a key no machine takes, but a key a
      // vector expects to enroll fits control-key.json.
      if (v.expect.ok && !S.ControlKey.safeParse(v.input.key).success)
        problems.push("key does not fit control-key.json");
    } else problems.push("input needs signed or proof");
  } catch (e) {
    problems.push(String(e.message));
  }
  if (problems.length) failed++;
  rows.push([rel, problems.length ? "FAIL" : "ok", problems.join(" | ")]);
}

// Behaviour, once the runner exists.
const runner = path.join(root, "packages/conformance/dist/index.js");
let ran = false;
if (existsSync(runner)) {
  const mod = await import(pathToFileURL(runner).href);
  if (typeof mod.runAdapterFixtures === "function") {
    ran = true;
    const result = await mod.runAdapterFixtures(harness);
    console.log(result.table);
    if (result.failed) failed += result.failed;
  }
}

// A fixture's name and its error are a contributor's words: no control character reaches the terminal.
const shown = (s) => s.replace(/\p{Cc}/gu, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
const w = Math.max(...rows.map((r) => r[0].length));
for (const [f, s, why] of rows) console.log(`${s.padEnd(4)} ${shown(f).padEnd(w)} ${shown(why)}`);
console.log(
  `conformance: ${rows.length} fixture(s) checked against the schema${ran ? " and the adapters" : " (adapters land in M2)"}, ${failed} failed`,
);
process.exit(failed ? 1 : 0);
