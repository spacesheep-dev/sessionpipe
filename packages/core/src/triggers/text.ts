// SPDX-License-Identifier: Apache-2.0
// Text a person reads before saying `yes` (spec/CONTROL.md §14.1): what they confirm must be what
// runs. A rule's words and folder may hold no character that does not show, and anything shown to
// a person shows a character that does not as a visible escape all the same.
//
// The rule is split in two, once: config.proto's patterns refuse every control character (C0,
// DEL, C1), which a pattern every reader runs can say; this file refuses the rest by Unicode's
// categories, which only a reader with Unicode's tables can: format characters (bidi controls,
// zero-width characters, tag characters), line and paragraph separators, private use,
// unassigned code points and lone surrogates.

/** Every character a person may not see: Unicode's control, format, line and paragraph separator,
 *  private use, unassigned and surrogate categories. */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}\p{Cs}]/u;
const HIDDEN_ALL = new RegExp(HIDDEN.source, "gu");

/** The code point as `U+XXXX`. */
const codeOf = (c: string): string => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;

/** The first character of `text` a person can't see, other than those `allowed` lets through
 *  (`"\t\n"` for a rule's words), as `U+XXXX`; null when there is none. */
export function hiddenIn(text: string, allowed = ""): string | null {
  for (const c of text) if (HIDDEN.test(c) && !allowed.includes(c)) return codeOf(c);
  return null;
}

/** `text` with every character a person can't see written out: `\n`, `\t`, `\r`, and `\u{…}` for
 *  the rest. For anything shown at a terminal: a rule in plain words, a refusal that quotes a
 *  value, the words a test would send. */
export function visible(text: string): string {
  return text.replace(HIDDEN_ALL, (c) =>
    c === "\n" ? "\\n" : c === "\t" ? "\\t" : c === "\r" ? "\\r" : `\\u{${c.codePointAt(0)!.toString(16)}}`,
  );
}
