#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { PROTOCOL_VERSION } from "./index.js";

/** The command, for now: which protocol this is and that the receiver is still to come. */
export function main(io: { stdout: { write(s: string): unknown } } = process): void {
  io.stdout.write(
    `sessionpipe protocol ${PROTOCOL_VERSION}: this command lands in a later milestone (see ROADMAP.md)\n`,
  );
}

/** Is this file the script node was started with (through a bin symlink too)? Never on import. */
function isMain(): boolean {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}
if (isMain()) main();
