// SPDX-License-Identifier: Apache-2.0
// Reading the ends of large files, JSON lines, and recent files under a root.
import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import path from "node:path";

/** The first and last bytes of a file, as lines — a transcript can be tens of MB. */
export function ends(file: string, headBytes: number, tailBytes: number): { head: string[]; tail: string[] } {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    const read = (pos: number, len: number) => {
      const b = Buffer.alloc(len);
      const n = readSync(fd as number, b, 0, len, pos);
      return b.subarray(0, n).toString("utf8");
    };
    const head = read(0, Math.min(size, headBytes));
    const tail = size > headBytes ? read(Math.max(0, size - tailBytes), Math.min(size, tailBytes)) : head;
    return { head: head.split("\n").slice(0, -1), tail: tail.split("\n").slice(size > headBytes ? 1 : 0) };
  } catch {
    return { head: [], tail: [] };
  } finally {
    if (fd !== undefined)
      try {
        closeSync(fd);
      } catch {}
  }
}

/** A file's whole lines, last first, read from its end a piece at a time: for the last
 *  record of a kind in a transcript that can be tens of MB, where a fixed tail may not
 *  reach it. A line may be longer than a piece (it is put together once, when its start
 *  is found). Nothing for a file that can't be read. */
export function* linesFromEnd(file: string, pieceBytes = 1024 * 1024): Generator<string> {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    let pos = fstatSync(fd).size;
    // The later parts, in the file's order, of a line whose start is in an earlier piece.
    let rest: Buffer[] = [];
    while (pos > 0) {
      const len = Math.min(pieceBytes, pos);
      pos -= len;
      const piece = Buffer.alloc(len);
      readSync(fd, piece, 0, len, pos);
      const nl = pos === 0 ? -1 : piece.indexOf(10);
      if (pos > 0 && nl < 0) {
        rest.unshift(piece);
        continue;
      }
      const lines = Buffer.concat([piece.subarray(nl + 1), ...rest])
        .toString("utf8")
        .split("\n");
      rest = [piece.subarray(0, nl + 1)];
      for (let i = lines.length - 1; i >= 0; i--) if (lines[i]) yield lines[i] as string;
    }
  } catch {
    // Unreadable from here on: what was read stands.
  } finally {
    if (fd !== undefined)
      try {
        closeSync(fd);
      } catch {}
  }
}

export const parseLines = (lines: string[]): Record<string, unknown>[] =>
  lines
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((x): x is Record<string, unknown> => !!x);

/** Read line by line up to `cap` bytes, stopping when `visit` returns a value. */
export function scanLines<T>(file: string, visit: (line: string) => T | null, cap = 16 * 1024 * 1024): T | null {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(1024 * 1024);
    let pos = 0;
    let rest: Buffer = Buffer.alloc(0);
    while (pos < cap) {
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (!n) break;
      pos += n;
      let chunk = Buffer.concat([rest, buf.subarray(0, n)]);
      let nl = chunk.indexOf(10);
      while (nl >= 0) {
        const r = visit(chunk.subarray(0, nl).toString("utf8"));
        if (r !== null) return r;
        chunk = chunk.subarray(nl + 1);
        nl = chunk.indexOf(10);
      }
      rest = chunk;
    }
  } catch {
  } finally {
    if (fd !== undefined)
      try {
        closeSync(fd);
      } catch {}
  }
  return null;
}

export function recentFiles(root: string, depth: number, sinceMs: number, match: (name: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (dir: string, d: number) => {
    let names: import("node:fs").Dirent[] = [];
    try {
      names = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of names) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (d < depth) walk(p, d + 1);
        continue;
      }
      if (!match(e.name)) continue;
      try {
        if (statSync(p).mtimeMs >= sinceMs) out.push(p);
      } catch {}
    }
  };
  walk(root, 0);
  return out;
}
