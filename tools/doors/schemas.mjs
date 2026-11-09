#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// `npm run schemas [-- --check]`: runs tools/doors/src/main.ts. The generator is TypeScript under
// the repository's strict config and its 100 % coverage rule; node 20 can't run that directly, so
// esbuild bundles it into .tmp first, as the schema script did for the Zod source before.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const out = path.join(root, ".tmp", "doors-main.mjs");
await build({
  entryPoints: [path.join(root, "tools/doors/src/main.ts")],
  outfile: out,
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node20",
  logLevel: "silent",
});
const { run } = await import(`${pathToFileURL(out).href}?t=${Date.now()}`);
process.exit(run({ root, check: process.argv.includes("--check") }));
