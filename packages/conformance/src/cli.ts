#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// npx @sessionpipe/conformance <fixture dir | file>   run adapter fixtures
// npx @sessionpipe/conformance https://host [--token] run the receiver scenarios (M3)
import { readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runAdapterFixtures } from "./index.js";

const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) => {
    const p = path.join(d, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".json") ? [p] : [];
  });

/** The command: `argv` is what follows the script; the exit code comes back. */
export async function main(argv: string[], io: { stdout: { write(s: string): unknown } } = process): Promise<number> {
  const target = argv[0];
  if (!target) {
    io.stdout.write("usage: sessionpipe-conformance <conformance/harness dir | fixture file | https://receiver>\n");
    return 2;
  }
  if (/^https?:\/\//i.test(target)) {
    io.stdout.write("receiver scenarios land in M3\n");
    return 2;
  }
  // A folder is walked for .json files; a file is run as the one fixture it is.
  let files: string[];
  try {
    files = statSync(target).isDirectory() ? walk(target) : [target];
  } catch (e) {
    // Node's words name the code and the path that failed: the target, or an entry under
    // it (a broken symlink, a locked folder).
    io.stdout.write(`sessionpipe-conformance: ${(e as Error).message}\n`);
    return 2;
  }
  if (!files.length) {
    io.stdout.write(`sessionpipe-conformance: no .json fixtures under ${target}\n`);
    return 2;
  }
  const r = await runAdapterFixtures(files);
  io.stdout.write(`${r.table}\n${r.results.length - r.failed}/${r.results.length} passed\n`);
  return r.failed ? 1 : 0;
}

/** Is this file the script node was started with (through a bin symlink too)? Never on import. */
function isMain(): boolean {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}
if (isMain()) process.exit(await main(process.argv.slice(2)));
