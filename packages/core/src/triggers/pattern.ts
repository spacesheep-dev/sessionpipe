// SPDX-License-Identifier: Apache-2.0
// The subject pattern of a rule (spec/CONTROL.md §14, *The subject pattern*). The subject is
// chosen by whoever edits the receiver's board, so it is untrusted input matched against the
// person's pattern. A full regular expression engine backtracks: `^(a+)+$` on forty letters
// takes longer than a machine has. So a pattern is a small subset of regular expression
// syntax, with the same meaning a JavaScript RegExp gives it, and matched by stepping through
// the subject once per piece of the pattern, never by backtracking:
//
//   pattern   ^ piece* $             always anchored at both ends: it matches the whole subject
//   piece     atom quantifier?
//   atom      a letter, a digit, `_` or `-`; `.` (any subject character); `\d`; `\w`;
//             a class `[…]` or `[^…]` of those characters and ranges (`A-Z`, `a-z`, `0-9`)
//   quantifier  `?`  `*`  `+`  `{n}`  `{n,}`  `{n,m}`, n and m at most 40
//
// No groups, no alternation, no backreferences, no lookaround, no lazy quantifier: a pattern
// that uses one is refused, never read some other way. A pattern is at most 100 characters
// and a subject at most 40, so a match is at most a few hundred thousand steps.

/** The longest pattern. */
export const SUBJECT_PATTERN_MAX = 100;
/** The largest count a quantifier may name; a subject is never longer. */
const COUNT_MAX = 40;
/** The subject's own alphabet (control.proto `ControlNotice.subject`). */
const SUBJECT_CHAR = /^[A-Za-z0-9_-]$/;

interface Piece {
  /** The characters the atom takes, by code. */
  takes: (code: number) => boolean;
  min: number;
  max: number;
}

/** A compiled pattern: `test` says whether a subject matches it whole. */
export interface SubjectPattern {
  source: string;
  test(subject: string): boolean;
}

const range = (lo: string, hi: string) => (c: number) => c >= lo.charCodeAt(0) && c <= hi.charCodeAt(0);
const DIGIT = range("0", "9");
const WORD = (c: number) => DIGIT(c) || range("A", "Z")(c) || range("a", "z")(c) || c === 95;
const ANY = (c: number) => WORD(c) || c === 45;

/** Two ends of a range in one of A-Z, a-z, 0-9, in order. */
function rangeOk(lo: string, hi: string): boolean {
  return [/[A-Z]/, /[a-z]/, /[0-9]/].some((re) => re.test(lo) && re.test(hi)) && lo <= hi;
}

/** A class's body (between `[` and `]`, after any `^`) as a test, or why it isn't one. */
function classOf(body: string): ((c: number) => boolean) | string {
  if (!body) return "an empty class";
  const parts: ((c: number) => boolean)[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (!SUBJECT_CHAR.test(c)) return `"${c}" in a class: a class holds letters, digits, _ and -`;
    // A `-` between two characters is a range; first or last it is itself.
    if (body[i + 1] === "-" && i + 2 < body.length) {
      const hi = body[i + 2]!;
      if (!rangeOk(c, hi)) return `the range ${c}-${hi}: a range runs up within A-Z, a-z or 0-9`;
      parts.push(range(c, hi));
      i += 2;
    } else parts.push((x) => x === c.charCodeAt(0));
  }
  return (x) => parts.some((p) => p(x));
}

/** Compile a rule's subject pattern, or say why it is refused. */
export function subjectPattern(source: string): SubjectPattern | { error: string } {
  const no = (error: string) => ({ error });
  if (source.length > SUBJECT_PATTERN_MAX) return no(`a pattern is at most ${SUBJECT_PATTERN_MAX} characters`);
  if (!source.startsWith("^") || !source.endsWith("$") || source.length < 2)
    return no("a pattern starts with ^ and ends with $: it matches the whole subject");
  const body = source.slice(1, -1);
  const pieces: Piece[] = [];
  let i = 0;
  while (i < body.length) {
    const c = body[i]!;
    let takes: (code: number) => boolean;
    if (c === ".") {
      takes = ANY;
      i++;
    } else if (c === "\\") {
      const e = body[i + 1];
      if (e === "d") takes = DIGIT;
      else if (e === "w") takes = WORD;
      else return no(`\\${e ?? ""}: the only escapes are \\d and \\w`);
      i += 2;
    } else if (c === "[") {
      const end = body.indexOf("]", i + 1);
      if (end < 0) return no("a class that never closes");
      const negated = body[i + 1] === "^";
      const inner = classOf(body.slice(i + (negated ? 2 : 1), end));
      if (typeof inner === "string") return no(inner);
      takes = negated ? (x) => ANY(x) && !inner(x) : inner;
      i = end + 1;
    } else if (SUBJECT_CHAR.test(c)) {
      const code = c.charCodeAt(0);
      takes = (x) => x === code;
      i++;
    } else return no(`"${c}" is not part of the pattern language: no groups, alternation or anchors inside`);
    // The quantifier, if any.
    let min = 1;
    let max = 1;
    const q = body[i];
    if (q === "?" || q === "*" || q === "+") {
      min = q === "+" ? 1 : 0;
      max = q === "?" ? 1 : COUNT_MAX;
      i++;
    } else if (q === "{") {
      const m = /^\{(\d{1,2})(,(\d{0,2}))?\}/.exec(body.slice(i));
      if (!m) return no("a count is {n}, {n,} or {n,m}");
      min = Number(m[1]);
      max = m[2] === undefined ? min : m[3] ? Number(m[3]) : COUNT_MAX;
      if (min > COUNT_MAX || max > COUNT_MAX || min > max) return no(`a count runs up, at most ${COUNT_MAX}`);
      i += m[0].length;
    }
    const after = body[i];
    if (after === "?" || after === "*" || after === "+" || after === "{")
      return no("one quantifier to a piece: no lazy or stacked quantifiers");
    pieces.push({ takes, min, max });
  }
  return { source, test: (subject) => matches(pieces, subject) };
}

/** Whether `pieces` match all of `s`: the positions each piece can end at, piece by piece. */
function matches(pieces: readonly Piece[], s: string): boolean {
  let at = new Set([0]);
  for (const p of pieces) {
    const next = new Set<number>();
    for (const start of at) {
      let k = 0;
      if (p.min === 0) next.add(start);
      while (k < p.max && start + k < s.length && p.takes(s.charCodeAt(start + k))) {
        k++;
        if (k >= p.min) next.add(start + k);
      }
    }
    if (!next.size) return false;
    at = next;
  }
  return at.has(s.length);
}
