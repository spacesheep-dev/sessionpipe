// SPDX-License-Identifier: Apache-2.0
// pii@1 — an opt-in second pass that reduces identifiers (spec/PRIVACY.md §2). It
// does not promise anonymity; it removes the obvious.
import { createHash } from "node:crypto";

export const RULESET_PII = "pii@1";

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
/** E.164 and common national forms: an optional +, 7–15 digits with separators,
 *  optional area-code parentheses. A version number (22.23.1) or an IP never matches:
 *  the run must not sit between dots, and needs ≥ 7 digits. An ISO date (2026-10-31)
 *  has a phone's shape, so it is tried first (group 1) and kept, but only when nothing
 *  after it could carry the run on: no letter or digit, and no separator then two digits
 *  (a phone's group is two to four; one digit, as in "2026-10-31 5 files", never is),
 *  unless that is a time's hour (" 12:", 00–23), and not right after a ")" or a "+"
 *  with a country code: a phone's prefix this pass could not take ("x(415) 2026-10-31",
 *  "[phone]+1 2026-10-31") would take the date on the next one. Any other date is read
 *  as before. The date may follow a `+` (a diff's added line), so a second pass over
 *  "[phone]+2026-10-31" keeps it too. */
const PHONE =
  /(?<![\w.])(?:(?<!\)[ .-]?|\+\d{1,3}[ .-]?)(\+?(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))(?:(?= (?:[01]?\d|2[0-3]):)|(?!\w|[ .-]\d\d))|(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)[ .-]?)?\d{2,4}(?:[ .-]?\d{2,4}){1,3}(?!\w))/g;

function looksPhone(s: string): boolean {
  const digits = s.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return false;
  // "port 8891, pr 12345": a bare run with no separator or + is a number, not a phone.
  if (!/[+() .-]/.test(s)) return false;
  // "22.23.1", "185.199.108.153": dots alone are a version or an address.
  if (!/[+() -]/.test(s)) return false;
  return true;
}

/** Replace emails and phone numbers, and write `home` as `~`. */
export function reducePii(text: string, home?: string): string {
  if (!text) return text;
  let out = text.replace(EMAIL, "[email]");
  out = out.replace(PHONE, (m, date?: string) => (!date && looksPhone(m) ? "[phone]" : m));
  if (home) {
    const h = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(?<![A-Za-z0-9_])${h}(?=/|$|\\s|["'\`])`, "g"), "~");
  }
  return out;
}

/** The machine's name under pii@1: the first 8 hex of its SHA-256. */
export function hashMachine(name: string): string {
  return createHash("sha256").update(name).digest("hex").slice(0, 8);
}

/** Apply pii@1 to every string in a value; `home` becomes `~`. */
export function reducePiiDeep<T>(v: T, home?: string): T {
  if (typeof v === "string") return reducePii(v, home) as T;
  if (Array.isArray(v)) return v.map((x) => reducePiiDeep(x, home)) as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = reducePiiDeep(x, home);
    return out as T;
  }
  return v;
}
