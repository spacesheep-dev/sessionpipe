#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// What `filterEvent` lets through at each tier, with and without the PII ruleset, for every
// expected event in conformance/harness/**: conformance/tiers/<harness>.json, RECORDED ONCE
// from the published sessionpipe-core 0.13.3 (RFC 0001 §6 gate 2) and never regenerated from
// this tree. packages/core/test/tier-goldens.test.ts holds the core in this tree to it.
//
//   node scripts/tier-goldens.mjs <path to a sessionpipe-core module>   # record from THAT core
//
// The envelope around a fixture's expected event is scripts/lib/envelope.mjs, shared with the
// conformance check and the golden test.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { envelope } from "./lib/envelope.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const coreArg = process.argv[2];
if (!coreArg) {
  console.error("usage: node scripts/tier-goldens.mjs <path to sessionpipe-core>");
  process.exit(2);
}
const coreDir = path.resolve(coreArg);
const pkg = JSON.parse(readFileSync(path.join(coreDir, "package.json"), "utf8"));
const entry = pkg.exports?.["."]?.import ?? pkg.main;
const { filterEvent, TYPE_TIER } = await import(pathToFileURL(path.join(coreDir, entry)).href);
const version = pkg.version;

export const CASES = [0, 1, 2, 3].flatMap((t) => [`${t}`, `${t}+pii`]);

const harnessDir = path.join(root, "conformance/harness");
const outDir = path.join(root, "conformance/tiers");
mkdirSync(outDir, { recursive: true });
let n = 0;
for (const harness of readdirSync(harnessDir).filter((h) => statSync(path.join(harnessDir, h)).isDirectory())) {
  const golden = { recorded_from: `sessionpipe-core ${version}`, cases: {} };
  for (const f of readdirSync(path.join(harnessDir, harness))
    .filter((x) => x.endsWith(".json"))
    .sort()) {
    const fx = JSON.parse(readFileSync(path.join(harnessDir, harness, f), "utf8"));
    (fx.expect ?? []).forEach((e, i) => {
      const ev = envelope(e, TYPE_TIER);
      const out = {};
      for (const c of CASES) {
        const [tier, pii] = c.split("+");
        out[c] = filterEvent(ev, Number(tier), pii === "pii");
      }
      golden.cases[`${f}#${i}`] = out;
      n++;
    });
  }
  const file = path.join(outDir, `${harness}.json`);
  if (existsSync(file)) {
    console.error(
      `${path.relative(root, file)} exists; the goldens are recorded once. Delete it on purpose to re-record.`,
    );
    process.exit(1);
  }
  writeFileSync(file, `${JSON.stringify(golden, null, 2)}\n`);
}
console.log(`recorded ${n} events × ${CASES.length} cases from sessionpipe-core ${version} into conformance/tiers/`);
