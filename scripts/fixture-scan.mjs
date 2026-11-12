// SPDX-License-Identifier: Apache-2.0
// No string that the secrets ruleset would redact may sit unredacted anywhere under
// conformance/. Fixtures are recorded from real sessions; this is the gate that says
// they were scrubbed. Until core's ruleset exists (M1) it scans with a minimal built-in
// set of vendor token shapes so the gate is never absent.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { walkFiles } from "./lib/walk.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "conformance");

let redact = null;
const core = path.join(root, "packages/core/dist/index.js");
if (existsSync(core)) {
  const mod = await import(pathToFileURL(core).href);
  if (typeof mod.redactSecrets === "function") redact = mod.redactSecrets;
}
const FALLBACK = [
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abposre]-[A-Za-z0-9-]{10,}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY/,
  /\bss_[a-f0-9]{32,}\b/,
];

// Every file, whatever its extension: a secret in a .yaml or a .log is as shared as one in a
// .json. A symbolic link under conformance/ is an error (scripts/lib/walk.mjs), so nothing
// outside the tree is read.
const files = walkFiles(dir);
const unredacted = (subject) => (redact ? redact(subject) !== subject : FALLBACK.some((re) => re.test(subject)));

// A vendor's token shape, whole: what no file under conformance/ may hold, a redaction vector's
// input included (conformance/redaction/secrets.json builds those from recipes for this reason).
// The key-block header is left out here: a header alone is no secret, and the vectors carry it.
const LITERAL = FALLBACK.filter((re) => !re.source.includes("PRIVATE KEY"));

/** What is wrong with a redaction vector file, or null. Its inputs MUST look like secrets to the
 *  ruleset (`password: hunter2`), so the ruleset is held to each case's `out`, each on its own
 *  (joining them would manufacture patterns no file holds); the whole file, inputs and every
 *  other field, is held to the vendor token shapes; and a file that is not `{ cases: [...] }` or
 *  `[...]` of objects has no input side to excuse, so it is scanned like any other file. */
function vectorProblem(text) {
  let vec;
  try {
    vec = JSON.parse(text);
  } catch {
    return unredacted(text) ? "unredacted secret-shaped string" : null;
  }
  const cases = Array.isArray(vec) ? vec : vec?.cases;
  if (!Array.isArray(cases) || !cases.every((c) => c && typeof c === "object" && !Array.isArray(c)))
    return unredacted(text) ? "unredacted secret-shaped string (not a redaction vector file: no cases)" : null;
  if (LITERAL.some((re) => re.test(text))) return "vendor-token-shaped literal (write the input as a recipe)";
  const outs = cases.map((c) => (typeof c.out === "string" ? c.out : JSON.stringify(c.out ?? "")));
  return outs.some(unredacted) ? "unredacted secret-shaped string in an `out`" : null;
}

let bad = 0;
for (const f of files) {
  const text = readFileSync(f, "utf8");
  const isVector = f.includes(`${path.sep}redaction${path.sep}`);
  const problem = isVector ? vectorProblem(text) : unredacted(text) ? "unredacted secret-shaped string" : null;
  if (problem) {
    bad++;
    console.error(`${problem} in ${path.relative(root, f)}`);
  }
}
if (bad) process.exit(1);
console.log(
  `fixture scan: ${files.length} file(s) clean${redact ? "" : " (fallback patterns; build core for the full ruleset)"}`,
);
