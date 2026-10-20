// SPDX-License-Identifier: Apache-2.0
// Codex's ~/.codex/config.toml, as far as the notify fallback needs it: its one
// top-level `notify` command. Codex reads `notify` only at the top level — before
// the first [table] — and Codex itself appends a [projects."<path>"] table for every
// folder it trusts, so a line appended at the end lands inside one and never runs.
// Ported from spacesheep-cli lib/codex-config.js. Pure text in, text out.

const NOTIFY_LINE = /^[ \t]*notify[ \t]*=[ \t]*(\[.*\])[ \t]*(?:#.*)?$/m;
const NOTIFY_KEY = /^[ \t]*notify[ \t]*=/m;
/** A notify that runs sessionpipe's hook directly (or through its launcher). */
export const OURS = /(?:hook\.js|sessionpipe-hook)",\s*"codex",\s*"notify"/;

function scan(line: string, st: { depth: number; str: string | null }): void {
  let i = 0;
  while (i < line.length) {
    if (st.str) {
      const j = line.indexOf(st.str, i);
      if (j < 0) return;
      i = j + 3;
      st.str = null;
      continue;
    }
    const ch = line[i];
    if (ch === "#") return;
    if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
      st.str = line.slice(i, i + 3);
      i += 3;
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < line.length && line[i] !== '"') i += line[i] === "\\" ? 2 : 1;
      i++;
      continue;
    }
    if (ch === "'") {
      const j = line.indexOf("'", i + 1);
      i = j < 0 ? line.length : j + 1;
      continue;
    }
    if (ch === "[") st.depth++;
    else if (ch === "]") st.depth = Math.max(0, st.depth - 1);
    i++;
  }
}

/** Offset of the first table header, or -1. */
export function firstTableAt(text: string): number {
  const st = { depth: 0, str: null as string | null };
  let pos = 0;
  for (const line of text.split("\n")) {
    if (!st.str && st.depth === 0 && /^[ \t]*\[/.test(line)) return pos;
    scan(line, st);
    pos += line.length + 1;
  }
  return -1;
}

function split(text: string) {
  const at = firstTableAt(text);
  return at < 0 ? { head: text, tail: "", at: text.length } : { head: text.slice(0, at), tail: text.slice(at), at };
}

export function parseArgv(raw: string): string[] | null {
  try {
    const a = JSON.parse(raw) as unknown;
    return Array.isArray(a) && a.every((x) => typeof x === "string") ? (a as string[]) : null;
  } catch {
    return null;
  }
}

export interface Notify {
  raw: string;
  argv: string[] | null;
  index: number;
  length: number;
  misplaced: boolean;
  other: boolean;
}

/** notify as Codex sees it; `misplaced` for a line of ours inside a table. */
export function readNotify(text: string): Notify | null {
  const { head, tail, at } = split(text);
  const m = NOTIFY_LINE.exec(head);
  if (m) {
    const raw = m[1] as string;
    return { raw, argv: parseArgv(raw), index: m.index, length: m[0].length, misplaced: false, other: !OURS.test(raw) };
  }
  const k = NOTIFY_KEY.exec(head);
  if (k) {
    const rest = head.slice(k.index).split("\n")[0] as string;
    return {
      raw: rest.replace(NOTIFY_KEY, "").trim(),
      argv: null,
      index: k.index,
      length: 0,
      misplaced: false,
      other: true,
    };
  }
  const t = NOTIFY_LINE.exec(tail);
  if (t) {
    const raw = t[1] as string;
    if (OURS.test(raw))
      return { raw, argv: parseArgv(raw), index: at + t.index, length: t[0].length, misplaced: true, other: false };
  }
  return null;
}

function dropLine(text: string, index: number, length: number): string {
  return text.slice(0, index) + text.slice(index + length).replace(/^\r?\n/, "");
}

/** Put `line` at the top level: before the first table, or at the end of a file that has none. */
export function insertTopLevel(text: string, line: string): string {
  const { head, tail } = split(text);
  if (!tail) return (head.trim() ? head.replace(/\s*$/, "\n") : "") + line + "\n";
  return `${(head.trim() ? head.replace(/\s*$/, "\n") : "") + line}\n\n${tail}`;
}

/** The config with `line` as its notify, for a config whose notify is ours or absent. */
export function withNotify(text: string, line: string): string {
  const n = readNotify(text);
  if (n && !n.misplaced && !n.other) return text.slice(0, n.index) + line + text.slice(n.index + n.length);
  if (n?.misplaced) return insertTopLevel(dropLine(text, n.index, n.length), line);
  return insertTopLevel(text, line);
}

/** The config with its notify line `n` (as readNotify found it in `text`) replaced by `line`. */
export function replaceNotify(text: string, n: Notify, line: string): string {
  return text.slice(0, n.index) + line + text.slice(n.index + n.length);
}

/** The config with our top-level or misplaced notify removed. */
export function withoutNotify(text: string): string {
  const n = readNotify(text);
  if (!n || n.other || !n.length) return text;
  return dropLine(text, n.index, n.length);
}

// Codex Computer Use takes the notify slot itself and keeps the command it found in
// its own argv: [client, "turn-ended", "--previous-notify", "<that command as JSON>"].
const PREVIOUS = "--previous-notify";
export function previousNotify(argv: string[] | null): string[] | null {
  if (!Array.isArray(argv)) return null;
  const i = argv.indexOf(PREVIOUS);
  return i >= 0 && typeof argv[i + 1] === "string" ? parseArgv(argv[i + 1] as string) : null;
}
export function withPrevious(argv: string[], prev: string[] | null): string[] {
  const out = argv.slice();
  const i = out.indexOf(PREVIOUS);
  if (i >= 0) out.splice(i, 2);
  if (prev) out.push(PREVIOUS, JSON.stringify(prev));
  return out;
}
/** The raw notify value with its --previous-notify pair removed, formatting kept. */
export function stripPreviousRaw(raw: string): string {
  return raw.replace(/,\s*"--previous-notify",\s*"(?:[^"\\]|\\.)*"\s*(?=\])/, "");
}
/** The raw notify value with `prev` as its --previous-notify, formatting of the rest kept. */
export function withPreviousRaw(raw: string, prev: string[]): string {
  const base = stripPreviousRaw(raw).replace(/\s*\]\s*$/, "");
  return `${base}, "--previous-notify", ${JSON.stringify(JSON.stringify(prev))}]`;
}
export const isComputerUse = (argv: string[] | null): boolean =>
  Array.isArray(argv) && typeof argv[0] === "string" && /(^|\/)SkyComputerUseClient$/.test(argv[0]);
