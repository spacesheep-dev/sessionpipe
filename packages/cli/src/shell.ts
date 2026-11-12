// SPDX-License-Identifier: Apache-2.0
// Commands sessionpipe prints for a person to paste. A path or a name inside one is a
// word of a shell command: one with a space, a quote or a `$` in it would run as
// something else, so every such word goes through here first.
import { tilde } from "@sessionpipe/core";

/** One word of a command line, quoted when it holds anything a shell would act on. A
 *  plain word (letters, digits and `_@%+=:,./~-`) is left as it is, so `~/x` still means
 *  the home folder. POSIX shells get single quotes; cmd and PowerShell, double. */
export function shq(word: string, platform: NodeJS.Platform = process.platform): string {
  if (/^[A-Za-z0-9_@%+=:,./~-]+$/.test(word) && !word.startsWith("-")) return word;
  if (platform === "win32") return `"${word.replace(/"/g, '""')}"`;
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/** A file or folder as one word of a command: its short `~/…` form where that needs no
 *  quoting, else the whole path in quotes, since a shell leaves a `~` inside quotes as
 *  it is and would look for a folder of that name. */
export function shqPath(file: string, platform: NodeJS.Platform = process.platform): string {
  const short = tilde(file);
  return shq(short, platform) === short ? short : shq(file, platform);
}
