// SPDX-License-Identifier: Apache-2.0
// Writing a JSON config back. The file is the person's: install puts sessionpipe's entries
// into its text and uninstall takes them out again, and every other byte stays as it was
// (#205), a list on one line, a tab indent and CRLF line ends included. `editJson` compares
// the value to write with the one the text holds and rewrites only the members that differ;
// a member it adds takes the layout of the members beside it. A file that did not exist is
// laid out the way JSON.stringify lays it out, in two spaces.

/** The file's own shape, as `readJsonFile` found it. */
export interface JsonShape {
  indent: string;
  eol: string;
  finalNewline: boolean;
  bom?: boolean;
}

/** Serialise in the file's own shape: the whole file, every member laid out one per line. */
export function formatJson(value: unknown, f: JsonShape): string {
  const text = JSON.stringify(value, null, f.indent).replace(/\n/g, f.eol);
  return (f.bom ? "\uFEFF" : "") + (f.finalNewline ? text + f.eol : text);
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Where a value sits in the text, end exclusive; an object's or array's members with it. */
interface Span {
  start: number;
  end: number;
  obj: boolean;
  kids: Kid[] | null;
}
/** A member: where it begins (its key, in an object), and for an object the key and the
 *  text between the key and the value (the colon and its spaces). */
interface Kid {
  key: string;
  at: number;
  colon: string;
  span: Span;
}

const LITERAL = /[^\s,:\]}]+/y;
/** The index past the number, `true`, `false` or `null` that starts at `i`. */
const pastLiteral = (t: string, i: number): number => {
  LITERAL.lastIndex = i;
  LITERAL.test(t);
  return LITERAL.lastIndex;
};
/** The index past the string that opens at `i`: a backslash takes the next character with
 *  it. Read a character at a time, and it ends because JSON.parse found the string whole. */
const pastString = (t: string, i: number): number => {
  let j = i + 1;
  while (t[j] !== '"') j += t[j] === "\\" ? 2 : 1;
  return j + 1;
};

/** Every value's span in a text, in one pass over it. The text must be one JSON.parse has
 *  accepted: that is what lets this read a token by its first character. */
export function scan(t: string): Span {
  const open: Span[] = [];
  let root: Span | undefined;
  let key: string | undefined;
  let at = 0;
  let keyEnd = 0;
  for (let i = 0; i < t.length; ) {
    const c = t[i]!;
    const parent = open[open.length - 1];
    if (" \t\r\n,:".includes(c)) i++;
    else if (c === "}" || c === "]") open.pop()!.end = ++i;
    else if (parent?.obj && key === undefined) {
      at = i;
      i = keyEnd = pastString(t, i);
      key = JSON.parse(t.slice(at, i)) as string;
    } else {
      const span: Span = { start: i, end: i, obj: c === "{", kids: c === "{" || c === "[" ? [] : null };
      if (!parent) root = span;
      else if (key === undefined) parent.kids!.push({ key: "", at: i, colon: "", span });
      else parent.kids!.push({ key, at, colon: t.slice(keyEnd, i), span });
      key = undefined;
      if (span.kids) {
        open.push(span);
        i++;
      } else i = span.end = c === '"' ? pastString(t, i) : pastLiteral(t, i);
    }
  }
  return root!;
}

interface Layout {
  raw: string;
  unit: string;
  eol: string;
}

/** The indent of the line a value starts on. */
function indentAt(raw: string, i: number): string {
  const line = raw.slice(raw.lastIndexOf("\n", i) + 1, i);
  return line.slice(0, line.length - line.trimStart().length);
}

/** A value of our own, laid out on one line, or over several from `pad`. */
function render(v: Json, pad: string, inline: boolean, L: Layout): string {
  const text = JSON.stringify(v, null, inline ? 1 : L.unit);
  return inline ? text.replace(/\n */g, " ") : text.replace(/\n/g, L.eol + pad);
}

/** The text of `span` once it holds `now` instead of `was`: what is the same keeps its
 *  bytes, an array keeps the elements that are still there in order, and a member taken
 *  out goes with the comma and space after it (before it, for the last), so taking out
 *  what was added gives back the text it was added to. */
function edit(L: Layout, span: Span, was: Json, now: Json, inline: boolean): string {
  const text = L.raw.slice(span.start, span.end);
  if (JSON.stringify(was) === JSON.stringify(now)) return text;
  const kids = span.kids;
  const pad = indentAt(L.raw, span.start);
  if (!kids || now === null || typeof now !== "object" || Array.isArray(now) === span.obj)
    return render(now, pad, inline, L);
  const n = kids.length;
  const gapAfter = (i: number) => L.raw.slice(kids[i]!.span.end, kids[i + 1]!.at);
  const lead = n ? L.raw.slice(span.start + 1, kids[0]!.at) : inline ? " " : L.eol + pad + L.unit;
  const trail = n ? L.raw.slice(kids[n - 1]!.span.end, span.end - 1) : inline ? " " : L.eol + pad;
  // What goes before a member we add: the gap before the last member, or one like the
  // space after the bracket. A gap with no line break in it puts the member on that line.
  const gap = n > 1 ? gapAfter(n - 2) : `,${lead || " "}`;
  const nl = gap.lastIndexOf("\n");
  const fresh = (v: Json) => render(v, gap.slice(nl + 1), nl < 0, L);
  const parts: { from?: number; text: string }[] = [];
  const keep = (i: number, w: Json, v: Json) => {
    const k = kids[i]!;
    const before = i ? gapAfter(i - 1) : lead;
    parts.push({ from: i, text: L.raw.slice(k.at, k.span.start) + edit(L, k.span, w, v, !before.includes("\n")) });
  };
  if (span.obj) {
    const w = was as Record<string, Json>;
    const o = now as Record<string, Json>;
    // The members that stay keep their place in the text, and new ones go at the end: that
    // is the order JS gives the keys (a key like "1" goes first in both, wherever it is
    // written). A key written twice is the last one to JSON.parse, so the last is the member.
    const index = new Map(kids.map((k, i) => [k.key, i]));
    const colon = n ? kids[0]!.colon : ": ";
    kids.forEach((k, i) => {
      if (index.get(k.key) === i && Object.hasOwn(o, k.key)) keep(i, w[k.key]!, o[k.key]!);
    });
    for (const [key, v] of Object.entries(o))
      if (!index.has(key)) parts.push({ text: JSON.stringify(key) + colon + fresh(v) });
  } else {
    const w = was as Json[];
    const seen = w.map((v) => JSON.stringify(v));
    const texts = (now as Json[]).map((v) => JSON.stringify(v));
    const wanted = new Set(texts);
    let j = 0;
    for (const [x, v] of (now as Json[]).entries()) {
      let i = j;
      while (i < n && seen[i] !== texts[x]) i++;
      // The next element, if it is in the array no more, is this one changed: edited in place.
      if (i === n && j < n && !wanted.has(seen[j]!)) i = j;
      if (i === n) parts.push({ text: fresh(v) });
      else {
        keep(i, w[i]!, v);
        j = i + 1;
      }
    }
  }
  if (!parts.length) return text[0]! + text[text.length - 1]!;
  let out = text[0]! + lead + parts[0]!.text;
  for (let x = 1; x < parts.length; x++) {
    const from = parts[x - 1]!.from;
    out += (from !== undefined && from < n - 1 ? gapAfter(from) : gap) + parts[x]!.text;
  }
  return out + trail + text[text.length - 1]!;
}

/** The text to write for `value` into a file read with its text `raw` (the byte-order mark
 *  taken off): the file's own bytes with only what changed rewritten. A file that did not
 *  exist (`raw` empty), and one this cannot edit for any reason, gets `formatJson`. The
 *  edit is parsed back before it is used, and anything but the value itself means the file
 *  is written whole instead: a mistake here must not reach a person's config. */
export function editJson(value: unknown, f: JsonShape & { raw: string }): string {
  if (f.raw)
    try {
      const was = JSON.parse(f.raw) as Json;
      const now = JSON.parse(JSON.stringify(value)) as Json;
      const root = scan(f.raw);
      const body = edit({ raw: f.raw, unit: f.indent, eol: f.eol }, root, was, now, false);
      const text = f.raw.slice(0, root.start) + body + f.raw.slice(root.end);
      if (JSON.stringify(JSON.parse(text)) === JSON.stringify(now)) return (f.bom ? "\uFEFF" : "") + text;
    } catch {}
  return formatJson(value, f);
}
