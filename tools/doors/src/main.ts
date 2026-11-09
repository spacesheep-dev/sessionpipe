// SPDX-License-Identifier: Apache-2.0
// One source per fact: schemas/v1/*.json and packages/core/gen/v1.ts are GENERATED from
// proto/sessionpipe/v1/*.proto. `npm run schemas` rewrites them; `--check` exits 1 when a committed
// file differs from what the proto says (CI runs that), and so does `buf lint`.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { build, lint } from "./buf.js";
import { schemaFiles } from "./jsonschema.js";
import { Descriptors } from "./read.js";
import { typesFile } from "./types.js";

export interface RunOptions {
  /** The repository root. */
  root: string;
  /** Compare and report instead of writing. */
  check: boolean;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

const SCHEMAS_DIR = "schemas/v1";
const TYPES_FILE = "packages/core/gen/v1.ts";

/** Lint, generate, then write or check. Returns the exit code. */
export function run(o: RunOptions): number {
  const log = o.log ?? console.log;
  const error = o.error ?? console.error;
  lint({ root: o.root });
  const d = new Descriptors(build({ root: o.root }));
  const generated: Record<string, string> = { ...schemaFiles(d), [TYPES_FILE]: typesFile(d) };

  const schemasDir = path.join(o.root, SCHEMAS_DIR);
  const existing: Record<string, string> = {};
  if (existsSync(schemasDir))
    for (const f of readdirSync(schemasDir).filter((n) => n.endsWith(".json")))
      existing[`${SCHEMAS_DIR}/${f}`] = readFileSync(path.join(schemasDir, f), "utf8");
  if (existsSync(path.join(o.root, TYPES_FILE)))
    existing[TYPES_FILE] = readFileSync(path.join(o.root, TYPES_FILE), "utf8");

  let drift = 0;
  for (const rel of [...new Set([...Object.keys(existing), ...Object.keys(generated)])].sort()) {
    const want = generated[rel];
    const have = existing[rel];
    if (want === have) continue;
    drift++;
    const abs = path.join(o.root, rel);
    if (o.check)
      error(
        `${rel}: ${want === undefined ? "committed but no longer generated" : have === undefined ? "missing" : "out of date"}`,
      );
    else if (want === undefined) rmSync(abs);
    else {
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, want);
    }
  }
  const n = Object.keys(generated).length;
  if (o.check && drift) {
    error(`\n${drift} generated file(s) differ from the proto. Run: npm run schemas`);
    return 1;
  }
  log(
    o.check
      ? `schemas/v1 and ${TYPES_FILE} in sync with proto/ (${n} files)`
      : `wrote ${n} file(s) from proto/: schemas/v1/ and ${TYPES_FILE}`,
  );
  return 0;
}
