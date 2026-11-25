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

/** A character a person can't see as itself, where it is in the text (1 for the first character,
 *  counted in characters, not code units), as `U+XXXX` and as `visible` writes it. */
export interface Hidden {
  code: string;
  escape: string;
  at: number;
}

const codeOf = (c: string): string => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
const escapeOf = (c: string): string =>
  c === "\n" ? "\\n" : c === "\t" ? "\\t" : c === "\r" ? "\\r" : `\\u{${c.codePointAt(0)!.toString(16)}}`;

/** Each character of `text` with whether a person can't see it as itself: the fifth and later
 *  combining marks in a row are hidden. */
function* walk(text: string): Generator<{ c: string; hidden: boolean }> {
  let marks = 0;
  for (const c of text) {
    marks = MARK.test(c) ? marks + 1 : 0;
    yield { c, hidden: HIDDEN.test(c) || marks > MARKS_MAX };
  }
}

/** The first character of `text` a person can't see as itself, other than those `allowed` lets
 *  through (`"\t\n"` for a rule's words); null when there is none. */
export function hiddenIn(text: string, allowed = ""): Hidden | null {
  let at = 0;
  for (const { c, hidden } of walk(text)) {
    at++;
    if (hidden && !allowed.includes(c)) return { code: codeOf(c), escape: escapeOf(c), at };
  }
  return null;
}

/** Whether a backslash before `next` could be read as the start of an escape `visible` writes. */
const startsEscape = (next: { c: string; hidden: boolean } | undefined): boolean =>
  !!next && (next.hidden || /^[ntru\\]$/.test(next.c));

/** `text` with every character a person can't see as itself written out (`\n`, `\t`, `\r`, and
 *  `\u{…}` for the rest), and a backslash written as two wherever it could start one of those
 *  (before `n`, `t`, `r`, `u`, another backslash, or a character written out), so a typed `\n` never reads as a line break
 *  written out, while a pattern's `\d` or a folder's `C:\work` still reads as typed. For anything
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
  return `${what} ${h.code} at character ${h.at} (shown as ${h.escape}), which does not show as itself, so what you confirm would not be what runs: retype that character (a space pasted from a web page or a document is often one)`;
}
