// SPDX-License-Identifier: Apache-2.0
// The JSON lines a stand-in program has written to its log so far. A test polls such a file
// while the program is still writing it, so this reads only what is whole: a file that
// exists but is still empty is no lines (it used to be `JSON.parse("")`, which threw on a
// busy runner), and a last line with no newline yet is left for the next read.
import { existsSync, readFileSync } from "node:fs";

export function jsonLines<T = unknown>(file: string): T[] {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8");
  return text
    .slice(0, text.lastIndexOf("\n") + 1)
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);
}
