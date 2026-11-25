// SPDX-License-Identifier: Apache-2.0
// Text a person reads before saying `yes` (spec/CONTROL.md §14.1): what they confirm must be what
// runs. A rule's words and folder may hold no character that does not show as itself, and anything
// shown to a person writes such a character out as an escape all the same.
//
// The rule is split in two, once: config.proto's patterns refuse every control character (C0,
// DEL, C1), which a pattern every reader runs can say; this file refuses the rest, which only a
// reader with Unicode's tables can:
//   - Unicode's format, line and paragraph separator, private use, unassigned and surrogate
//     categories (`Cf Zl Zp Co Cn Cs`, with `Cc` again): bidi controls, zero-width characters,
//     tag characters;
//   - every Default_Ignorable_Code_Point: the combining grapheme joiner, the variation selectors
//     (U+FE00–FE0F, and U+E0100–E01EF, each of which can carry a hidden byte), the Hangul fillers,
//     the Mongolian and Khmer invisible marks, the soft hyphen;
//   - U+2800 (the braille blank) and U+FFFC (the object replacement character);
//   - every space separator but U+0020 (`Zs`: no-break, em, narrow and ideographic spaces);
//   - more than four combining marks in a row (`\p{M}`), which stack into a smear that hides
//     what is under it.

/** The most combining marks one character may carry before the rest count as hidden. */
export const MARKS_MAX = 4;
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}\p{Cs}\p{Default_Ignorable_Code_Point}⠀￼]|(?! )\p{Zs}/u;
const MARK = /\p{M}/u;
/** A mark that takes no column of its own (non-spacing or enclosing); a spacing mark takes one. */
const ZERO = /[\p{Mn}\p{Me}]/u;

/** A character a person can't see as itself: as `U+XXXX`, as `visible` writes it, and where it
 *  is. `at` counts what a person counts, characters as they show (grapheme clusters, by
 *  `Intl.Segmenter` where the runtime has it, else code points), 1 for the first; `codePoint` is
 *  its index among the text's code points, from 0, for tools. */
export interface Hidden {
  code: string;
  escape: string;
  at: number;
  codePoint: number;
  /** Why: a character that never shows as itself (`hidden`), or a combining mark past the
   *  fourth on one character (`stacked`). */
  why: "hidden" | "stacked";
}

const codeOf = (c: string): string => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
const escapeOf = (c: string): string =>
  c === "\n" ? "\\n" : c === "\t" ? "\\t" : c === "\r" ? "\\r" : `\\u{${c.codePointAt(0)!.toString(16)}}`;

/** Each character of `text` with whether a person can't see it as itself: the fifth and later
 *  combining marks in a row are hidden. */
function* walk(text: string): Generator<{ c: string; hidden: boolean; stacked: boolean }> {
  let marks = 0;
  for (const c of text) {
    marks = MARK.test(c) ? marks + 1 : 0;
    const hidden = HIDDEN.test(c);
    const stacked = !hidden && marks > MARKS_MAX;
    yield { c, hidden: hidden || stacked, stacked };
  }
}

/** The first character of `text` a person can't see as itself, other than those `allowed` lets
 *  through (`"\t\n"` for a rule's words); null when there is none. */
export function hiddenIn(text: string, allowed = ""): Hidden | null {
  let index = 0;
  for (const { c, hidden, stacked } of walk(text)) {
    if (hidden && !allowed.includes(c)) {
      // The character as it shows that holds it: a mark or a joiner hides inside the one before.
      const upTo = [...text].slice(0, index + 1).join("");
      return {
        code: codeOf(c),
        escape: escapeOf(c),
        at: graphemes(upTo).length,
        codePoint: index,
        why: stacked ? "stacked" : "hidden",
      };
    }
    index++;
  }
  return null;
}

/** `text` split into what a person counts as characters: grapheme clusters where the runtime
 *  has `Intl.Segmenter`, else code points with each combining mark kept on its base. */
export function graphemes(text: string): string[] {
  if (typeof Intl.Segmenter === "function")
    return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((g) => g.segment);
  const out: string[] = [];
  for (const c of text)
    if (MARK.test(c) && out.length) out[out.length - 1] += c;
    else out.push(c);
  return out;
}

/** Columns one character takes at a terminal, counted high so a line never wraps where this says
 *  it fits: 0 for a non-spacing or enclosing mark, 2 for an East Asian wide or full-width
 *  character (Unicode 16's table) or a pictograph, 1 for the rest, a spacing mark included. (The CLI's own `cols` counts code points; text a person confirms
 *  is measured here, since wide padding would otherwise push a line past the edge.) */
export function columnsOf(cluster: string): number {
  let n = 0;
  for (const c of cluster) n += WIDE.test(c) ? 2 : ZERO.test(c) ? 0 : 1;
  return n;
}
const WIDE =
  /[\u1100-\u115f\u231a\u231b\u2329\u232a\u23e9-\u23ec\u23f0\u23f3\u25fd\u25fe\u2614\u2615\u2630-\u2637\u2648-\u2653\u267f\u268a-\u268f\u2693\u26a1\u26aa\u26ab\u26bd\u26be\u26c4\u26c5\u26ce\u26d4\u26ea\u26f2\u26f3\u26f5\u26fa\u26fd\u2705\u270a\u270b\u2728\u274c\u274e\u2753-\u2755\u2757\u2795-\u2797\u27b0\u27bf\u2b1b\u2b1c\u2b50\u2b55\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\ua960-\ua97f\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6\u{16fe0}-\u{1b2ff}\u{1d300}-\u{1d376}\u{1f000}-\u{1faff}\u{20000}-\u{3fffd}]|\p{Extended_Pictographic}/u;

/** `text` cut into pieces of at most `room` columns, never inside a character as a person sees it
 *  (a surrogate pair, a base and its combining marks), at the last space when one falls in the
 *  second half of the piece. Each piece is at least one character, so a character wider than
 *  `room` is a piece of its own. */
export function wrapColumns(text: string, room: number): string[] {
  const out: string[] = [];
  let piece: string[] = [];
  let used = 0;
  for (const g of graphemes(text)) {
    const w = columnsOf(g);
    // At the last space when it is in the piece's second half, else all of it. What a cut at a
    // space leaves is at most the piece's second half, and the first half holds at least two
    // columns, so this character always has room after it.
    if (piece.length && used + w > room) {
      const at = piece.lastIndexOf(" ");
      const cut = at >= piece.length / 2 ? at + 1 : piece.length;
      out.push(piece.slice(0, cut).join(""));
      piece = piece.slice(cut);
      used = piece.reduce((n, x) => n + columnsOf(x), 0);
    }
    piece.push(g);
    used += w;
  }
  out.push(piece.join(""));
  return out;
}

/** Whether a backslash before `next` could be read as the start of an escape `visible` writes. */
const startsEscape = (next: { c: string; hidden: boolean } | undefined): boolean =>
  !!next && (next.hidden || /^[ntru\\]$/.test(next.c));

/** `text` with every character a person can't see as itself written out (`\n`, `\t`, `\r`, and
 *  `\u{…}` for the rest), and a backslash written as two wherever it could start one of those
 *  (before `n`, `t`, `r`, `u`, another backslash, or a character written out), so a typed `\n` never reads as a line break
 *  written out, while a pattern's `\d` or a folder's `C:\work` still reads as typed (a Windows
 *  path does show a doubled backslash before a segment starting `n`, `t`, `r` or `u`: `C:\\new`,
 *  the price of the output being one-to-one with the input). For anything
 *  shown at a terminal: a rule in plain words, a refusal that quotes a value, the words a test
 *  would send. */
export function visible(text: string): string {
  const chars = [...walk(text)];
  let out = "";
  for (const [i, { c, hidden }] of chars.entries())
    out += c === "\\" && startsEscape(chars[i + 1]) ? "\\\\" : hidden ? escapeOf(c) : c;
  return out;
}

/** What a refusal says of a hidden character (`the words hold`, `the folder holds`): which, where,
 *  and what the person can do. A no-break space pasted from a page is the likely honest case. */
export function hiddenProblem(what: string, h: Hidden): string {
  return `${what} ${h.code} at character ${h.at} (shown as ${h.escape}), which does not show as itself, so what you confirm would not be what runs: ${hiddenHint(Number.parseInt(h.code.slice(2), 16), h.why)}`;
}

/** What to do about a hidden character, by why it was refused and its kind: the honest case each
 *  usually is. */
function hiddenHint(cp: number, why: Hidden["why"]): string {
  // A combining mark past the fourth on one character.
  if (why === "stacked") return "take out the marks stacked on that character";
  // A space other than U+0020: pasted from a page or a document.
  if (/\p{Zs}/u.test(String.fromCodePoint(cp)))
    return "retype that space (a space pasted from a web page or a document is often one)";
  // An emoji's own: its presentation selector, the joiner of a family, the tags of a flag.
  if (cp === 0xfe0e || cp === 0xfe0f || cp === 0x200d || (cp >= 0xe0020 && cp <= 0xe007f))
    return "leave the emoji out, or write it in words (an emoji such as a red heart or a flag carries one)";
  // Any other variation selector: a glyph variant of the character before it (a kanji in a name).
  if ((cp >= 0xfe00 && cp <= 0xfe0d) || (cp >= 0xe0100 && cp <= 0xe01ef))
    return "a variation selector: retype the character before it, without the variant";
  return "retype the text around it (text copied from a chat, a web page or a document can carry one)";
}
