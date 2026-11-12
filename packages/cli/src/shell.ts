// SPDX-License-Identifier: Apache-2.0
// Commands sessionpipe prints for a person to paste. A path or a name inside one is a
// word of a shell command: one with a space, a quote or a `$` in it would run as
// something else, so every such word goes through here first.
import { tilde } from "@sessionpipe/core";

/** One word of a command line, quoted when it holds anything a shell would act on. A
 *  plain word (letters, digits and `_@%+=:,./~-`) is left as it is, unless it starts like
 *  an option (`-`) or with what a shell expands at the start of a word: `~` (`~root` is
 *  root's home) and `=` (zsh reads `=ls` as the path of `ls`). POSIX shells get single
 *  quotes; cmd and PowerShell, double. */
export function shq(word: string, platform: NodeJS.Platform = process.platform): string {
  if (/^[A-Za-z0-9_@%+:,./][A-Za-z0-9_@%+=:,./~-]*$/.test(word)) return word;
  if (platform === "win32") return `"${word.replace(/"/g, '""')}"`;
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/** A file or folder as one word of a command: its short `~/…` form where that needs no
 *  quoting, else the whole path in quotes, since a shell leaves a `~` inside quotes as
 *  it is and would look for a folder of that name. */
export function shqPath(file: string, platform: NodeJS.Platform = process.platform): string {
  const short = tilde(file);
  // `~` and `~/…` are the home folder on purpose; what follows must need no quoting.
  const rest = short === "~" ? "" : short.startsWith("~/") ? short.slice(2) : null;
  if (rest !== null && (rest === "" || shq(rest, platform) === rest)) return short;
  return shq(file, platform);
}
