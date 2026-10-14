// SPDX-License-Identifier: Apache-2.0
// Conformance fixtures, two checks:
//  1. Shape: every expected event in conformance/harness/** validates against the
//     Zod source (wildcards "*" substituted), and every delivery scenario parses.
//     This runs from M1 on, so a fixture can never contradict the schema.
//  2. Behaviour: when @sessionpipe/conformance is built (M2+), every adapter fixture
//     is run through core's adapter and the events compared.
// Exits non-zero on any miss.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const walk = (d) =>
  existsSync(d)
    ? readdirSync(d).flatMap((n) => {
        const p = path.join(d, n);
        return statSync(p).isDirectory() ? walk(p) : [p];
      })
    : [];
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

const WILD = { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", time: "2026-09-28T00:00:00.000Z", tier: 0, seq: 0 };
let failed = 0;
const rows = [];
for (const f of harness) {
  const fx = JSON.parse(readFileSync(f, "utf8"));
  const rel = path.relative(root, f);
  const problems = [];
  if (!fx.input || typeof fx.input.stdin !== "string" || !Array.isArray(fx.input.argv))
    problems.push("input.{argv,stdin} missing");
  if (!Array.isArray(fx.expect) || !fx.expect.length) problems.push("expect empty");
  for (const [i, e] of (fx.expect ?? []).entries()) {
    const ev = {
      protocol: 1,
      ...e,
      id: e.id === "*" ? WILD.id : e.id,
      time: e.time === "*" ? WILD.time : e.time,
      tier: e.tier === "*" ? (S.TYPE_TIER[e.type] ?? 0) : e.tier,
      session: { ...e.session, seq: e.session?.seq === "*" ? WILD.seq : e.session?.seq },
      privacy: e.privacy ?? { rulesets: ["secrets@1"], pii: false },
    };
    const r = S.Event.safeParse(ev);
    if (!r.success)
      problems.push(
        `expect[${i}] envelope: ${r.error.issues.map((x) => `${x.path.join(".")} ${x.message}`).join("; ")}`,
      );
    const dataSchema = S.EventData.shape[e.type];
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
// fields aside), and every command a vector expects to verify fits control-command.json.
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
      const k = S.ControlKey.safeParse(v.input.key);
      if (!k.success) problems.push("key does not fit control-key.json");
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

// Worker fixtures cover decisions that need local history, beyond adapter mapping.
for (const file of walk(path.join(root, "conformance/worker")).filter((f) => f.endsWith(".json"))) {
  const state = mkdtempSync(path.join(os.tmpdir(), "sp-conformance-worker-"));
  const previousConfig = process.env.SESSIONPIPE_CONFIG;
  const problems = [];
  try {
    const { runJob } = await import(pathToFileURL(path.join(root, "packages/cli/dist/index.js")).href);
    const fx = JSON.parse(readFileSync(file, "utf8"));
    const payload = JSON.parse(fx.input.stdin);
    process.env.SESSIONPIPE_CONFIG = path.join(state, "config.json");
    writeFileSync(process.env.SESSIONPIPE_CONFIG, JSON.stringify({ sinks: [], harnesses: {} }));
    const result = await runJob(
      {
        harness: fx.harness,
        event: fx.event,
        argv: fx.input.argv,
        stdin: JSON.stringify({ ...payload, cwd: state, transcript_path: path.join(state, payload.transcript_path) }),
        cwd: state,
        env: { ...fx.input.env, HOME: state },
        at: Date.now(),
      },
      { state },
    );
    if (JSON.stringify(result.events.map((e) => e.type)) !== JSON.stringify(fx.expect))
      problems.push("worker emitted unexpected events");
    if (!fx.expect.length && (existsSync(path.join(state, "outbox")) || existsSync(path.join(state, "facts"))))
      problems.push("ignored hook created session state");
  } catch (e) {
    problems.push(String(e.message));
  } finally {
    if (previousConfig === undefined) delete process.env.SESSIONPIPE_CONFIG;
    else process.env.SESSIONPIPE_CONFIG = previousConfig;
    rmSync(state, { recursive: true, force: true });
  }
  if (problems.length) failed++;
  rows.push([path.relative(root, file), problems.length ? "FAIL" : "ok", problems.join(" | ")]);
}

const w = Math.max(...rows.map((r) => r[0].length));
for (const [f, s, why] of rows) console.log(`${s.padEnd(4)} ${f.padEnd(w)} ${why}`);
console.log(
  `conformance: ${rows.length} fixture(s) checked against the schema${ran ? " and the adapters" : " (adapters land in M2)"}, ${failed} failed`,
);
process.exit(failed ? 1 : 0);
