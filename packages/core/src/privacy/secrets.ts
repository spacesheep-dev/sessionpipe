// SPDX-License-Identifier: Apache-2.0
// secrets@1 — credentials out of every string, on the person's machine, before an
// event reaches the outbox. Ported from spacesheep-cli lib/redact.js (Michael
// Makarov, MIT → Apache-2.0, see NOTICE). The ruleset is defined in
// spec/PRIVACY.md §2 and pinned by conformance/redaction/secrets.json.
//
// Every pattern is linear: bounded repetition, no nested quantifiers. The
// adversarial vectors (password_ × 5000, a 50 000-space run) pin that.

export const RULESET_SECRETS = "secrets@1";
export const REDACTED = "[redacted]";

/** Token formats that are a credential by their shape alone. Each is anchored on a
 *  vendor prefix, so a commit sha or a UUID never matches. */
const TOKEN_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g, // GitLab
  /\bxox[abposre]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bhttps:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g,
  /\bhttps:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]+/g,
  /\bsk-(?:ant-|proj-|svcacct-|admin-|or-v1-)?[A-Za-z0-9_-]{20,}\b/g, // Anthropic, OpenAI, DeepSeek, OpenRouter
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, // Stripe secret / restricted
  /\bwhsec_[A-Za-z0-9+/=]{20,}/g, // Stripe / Svix / Standard Webhooks secret
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\bya29\.[0-9A-Za-z_-]{20,}/g, // Google OAuth access token
  /\b1\/\/0[0-9A-Za-z_-]{30,}/g, // Google OAuth refresh token
  /\bGOCSPX-[0-9A-Za-z_-]{20,}/g, // Google OAuth client secret
  /\bxai-[A-Za-z0-9]{30,}\b/g,
  /\bgsk_[A-Za-z0-9]{30,}\b/g, // Groq
  /\bpplx-[A-Za-z0-9]{30,}\b/g, // Perplexity
  /\bhf_[A-Za-z0-9]{30,}\b/g, // Hugging Face
  /\bpcsk_[A-Za-z0-9_]{30,}\b/g, // Pinecone
  /\bnpm_[A-Za-z0-9]{30,}\b/g,
  /\bpypi-[A-Za-z0-9_-]{50,}/g,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, // SendGrid
  /\bshp(?:at|ss|ca|pa)_[a-fA-F0-9]{32}\b/g, // Shopify
  /\bdop_v1_[a-f0-9]{64}\b/g, // DigitalOcean
  /\b(?:lin_api|lin_oauth)_[A-Za-z0-9]{30,}\b/g, // Linear
  /\b(?:ntn|secret)_[A-Za-z0-9]{40,}\b/g, // Notion
  /\bsbp_[a-f0-9]{40}\b/g, // Supabase
  /\bfigd_[A-Za-z0-9_-]{30,}/g, // Figma
  /\bdp\.(?:pt|st|sa|ct)\.[A-Za-z0-9]{30,}/g, // Doppler
  /\bgrn_[A-Za-z0-9_-]{20,}/g, // Granola
  /\bss_[a-f0-9]{32,}\b/g, // spacesheep API keys
  /\b[0-9]{8,10}:AA[A-Za-z0-9_-]{33}\b/g, // Telegram bot token
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
];
/** `scheme://user:password@host` — the password goes, the user and host stay. */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@'"`<>]{1,100}:)([^\s@/'"`<>]{1,200})(@)/gi;
/** `Authorization: Bearer …` / `Basic …`, and a bare `Bearer <token>` in a curl line. */
const AUTH_HEADER = /\b((?:Bearer|Basic|Token)\s+)([A-Za-z0-9._~+/=-]{16,})/g;
// The words that name a secret, in prose. `key` alone is too common ("the key
// point"), so it only counts with a qualifier.
const SECRET_WORD =
  "(?:pass(?:word|wd|phrase|code)?s?|pwd|secret(?:[ _-]?key)?s?|client[ _-]?secret|api[ _-]?keys?|apikeys?|access[ _-]?keys?|access[ _-]?tokens?|auth[ _-]?tokens?|refresh[ _-]?tokens?|private[ _-]?keys?|tokens?|credentials?|creds)";
/** Strict form: a NAME, an explicit separator (`=`, `:`, `=>`), a value. The name is
 *  one flat run of identifier characters judged in code (isSecretName), never by a
 *  nested pattern. Only a secret name goes on to consume its value — otherwise
 *  `https:` would swallow the `?token=…` behind it. */
const NAME_SEP = /(?<![A-Za-z0-9_])([A-Za-z][A-Za-z0-9_-]{1,79})(["']?\s{0,3}(?::=|=>|=|:)\s{0,3})/g;
const VALUE = /"([^"\n]{1,300})"|'([^'\n]{1,300})'|`([^`\n]{1,300})`|([^\s"'`,;&)}\]]{1,300})/y;

function redactAssignments(text: string): string {
  let out = "";
  let last = 0;
  NAME_SEP.lastIndex = 0;
  for (let m = NAME_SEP.exec(text); m; m = NAME_SEP.exec(text)) {
    const name = m[1] as string;
    if (!isSecretName(name)) continue;
    VALUE.lastIndex = NAME_SEP.lastIndex;
    const v = VALUE.exec(text);
    if (!v) continue;
    const value = (v[1] ?? v[2] ?? v[3] ?? v[4]) as string;
    NAME_SEP.lastIndex = VALUE.lastIndex;
    if (keepsValue(name, value)) continue;
    const q = v[1] != null ? '"' : v[2] != null ? "'" : v[3] != null ? "`" : "";
    out += text.slice(last, v.index) + q + REDACTED + q;
    last = VALUE.lastIndex;
  }
  return last ? out + text.slice(last) : text;
}

/** Does a value assigned to the secret name `name` stay? A placeholder, a value
 *  already redacted, and a count under a `*token(s)` name are not the secret. */
function keepsValue(name: string, value: string): boolean {
  if (isPlaceholder(value) || value.includes(REDACTED)) return true;
  // `max_tokens: 4096`, `input_tokens=12k` — a token COUNT, not a token.
  return /tokens?$/i.test(name) && /^\d+(?:[.,]\d+)*[km]?$/i.test(value);
}

/** Is this identifier the name of a secret? `DB_PASSWORD`, `apiKey`, `client-secret`,
 *  `AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`; an env-style `STRIPE_KEY` too. Not
 *  `password_hash`, `tokenizer`, `sort_key`. */
export function isSecretName(name: string): boolean {
  if (/^[A-Z0-9_]+_KEY$/.test(name)) return true;
  const flat = name.toLowerCase().replace(/[_-]/g, "");
  return /(?:pass(?:word|wd|phrase|code)|pwd|secret|secretkey|secretaccesskey|clientsecret|apikey|accesskey|accesstoken|authtoken|refreshtoken|privatekey|token|credential|creds)s?$/.test(
    flat,
  );
}

/** Loose form: prose. "password is Hunter2!", "the token was ghx…". Only a value
 *  that looks generated counts, so "the password is wrong" passes untouched.
 *  Whitespace runs are bounded so a long run can't make the match quadratic. */
const PROSE = new RegExp(
  `(\\b${SECRET_WORD}(?:[ \\t]{1,3}(?:is|was|=|:|to|as|of|for[ \\t]{1,3}\\S{1,40}[ \\t]{1,3}is))?[ \\t]{1,3})(["'\`]?)([^\\s"'\`]{6,200})\\2`,
  "gi",
);

/** `s` without the `marks` at its end. A loop from the end, not `/[.,;:!?]+$/`: that is
 *  tried from every one of them in the string, and a value under a key is as long as a
 *  tool's output. */
function untrailed(s: string, marks: string): string {
  let end = s.length;
  while (end > 0 && marks.includes(s.charAt(end - 1))) end--;
  return s.slice(0, end);
}

/** A value that is nothing but a stand-in, from its first character to its last: empty, a
 *  type's name, a mask or the marker, or one template holding one name (`<token>`,
 *  `${TOKEN}`, `{{ token }}`, `$TOKEN`, `%TOKEN%`). */
function isStandIn(s: string): boolean {
  if (!s) return true;
  if (
    /^(?:string|number|boolean|bool|str|int|any|unknown|null|undefined|none|nil|true|false|optional|required|text|varchar|password|secret|token|env|string\[\]|object|bytes)$/i.test(
      s,
    )
  )
    return true;
  if (/^\[?redacted\]?$/i.test(s) || /^\*+$/.test(s) || /^x{3,}$/i.test(s) || /^\.{3}$|^…$/.test(s)) return true;
  return /^(?:<[A-Za-z_][\w.-]{0,79}>|\$\{[A-Za-z_][\w.]{0,79}\}|\{\{ ?[A-Za-z_][\w.-]{0,79} ?\}\}|\$[A-Za-z_]\w{0,79}|%[A-Za-z_]\w{0,79}%)$/.test(
    s,
  );
}

/** A value that is plainly not the secret itself: a type, a variable, a template, an
 *  already-redacted marker, an env lookup. */
function isPlaceholder(v: string): boolean {
  const s = untrailed(v, ".,;:!?");
  if (isStandIn(s)) return true;
  if (/^[<{$%]/.test(s)) return true; // <your-key>, ${VAR}, {{var}}, $VAR, %VAR%
  if (
    /^(?:process\.env|env|os\.environ|c\.env|this\.env|import\.meta\.env|getenv|config|settings|secrets|args|opts|options|req|request|body|params|input|data|user|self|this)\b/i.test(
      s,
    )
  )
    return true;
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(s)) return true; // a member path: form.password
  if (/[(]/.test(s)) return true; // a call: hash(pw), getSecret()
  if (/^(?:your|my|the|a|an|some|new|old)[-_ ]/i.test(s)) return true; // your-api-key
  return false;
}

/** Does a prose value look like something generated, rather than an English word? */
function looksSecret(v: string): boolean {
  const s = untrailed(v, ".,;:!?)");
  if (s.length < 6) return false;
  if (isPlaceholder(s)) return false;
  if (/^https?:\/\//i.test(s)) return false; // a link, handled by URL_CREDENTIALS if it carries one
  if (/^[a-z]+(?:[-'][a-z]+)*$/.test(s)) return false; // a lowercase word
  if (/^[A-Z][a-z]+$/.test(s)) return false; // a capitalised word
  if (/^\d+(?:[.,]\d+)*[a-z%]*$/i.test(s)) return false; // a count: 4096, 128k, 3.5, 50%
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(s)) return false; // an env var's NAME
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(s)).length;
  return kinds >= 3 || (/[0-9]/.test(s) && /[A-Za-z]/.test(s));
}

/** Redact every credential in `text`. Returns the same string when there is none. */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const re of TOKEN_PATTERNS) out = out.replace(re, REDACTED);
  out = out.replace(URL_CREDENTIALS, (_m, head: string, _pw: string, at: string) => `${head}${REDACTED}${at}`);
  out = out.replace(AUTH_HEADER, (_m, head: string) => `${head}${REDACTED}`);
  out = redactAssignments(out);
  out = out.replace(PROSE, (m, head: string, q: string, v: string) =>
    !looksSecret(v) || v.includes(REDACTED) ? m : `${head}${q}${REDACTED}${q}`,
  );
  // Last, each on what the rules above it left: a value they changed is no stand-in any
  // more, and a jar's string is judged as it will stand.
  return redactNamed(redactCookies(out));
}

/** Did redaction change anything? */
export function hasSecret(text: string): boolean {
  return !!text && redactSecrets(text) !== text;
}

/** The end of a key that is the name of a header whose whole value is a credential, in
 *  any case: `Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`, a tool's own
 *  spelling of them (`set_cookie`, `HTTP_COOKIE`, `X-Authorization`), and `cookies`. */
const HEADER_KEY = /(?:authorization|cookies?)$/i;
/** The end of a key, or of a function's name, under which an object is a cookie. */
const COOKIE_KEY = /cookies?$/i;
/** What a cookie is written with beside its name and value. Two of them make an object one. */
const COOKIE_MARKS = ["domain", "path", "expires", "httponly", "secure", "samesite"];
/** A name that is one word: `DB_PASSWORD`, `Set-Cookie`, `x-api-key`. Not a label. */
const ONE_WORD = /^[A-Za-z_][\w.-]{0,79}$/;

/** The name a jar's strings go by: no key ends as it does. */
const JAR = "{cookies}";
/** What is kept in a jar and is no cookie's value: words in any language, and a link. */
const JAR_WORDS = /^(?:[\p{L}\p{M}'’.-]+|https?:\/\/.*)$/su;

/** Is this string in a jar a cookie's value: one run of six characters or more that is
 *  neither a stand-in, nor words, nor a link? */
function inJar(v: string): boolean {
  return v.length > 5 && !/\s/.test(v) && !isStandIn(v) && !JAR_WORDS.test(v);
}

/** Does the string `v` stored under `name` go whole? `text` is `v` after the text rules.
 *  Under a secret's name it does, with the exemptions an assignment has. Under a header's it
 *  does unless it is nothing but a stand-in that the text rules leave as it is: a header
 *  begins with whatever its first cookie is called, so how it begins says nothing. In a jar
 *  it does when, as the text rules leave it, it is one run of six characters or more that is
 *  not words: what else is kept under such a key is (`"analytics": "denied"`), and how a
 *  value begins says nothing here either. */
function goesWhole(name: string, v: string, text: string): boolean {
  if (name === JAR) return inJar(text);
  return HEADER_KEY.test(name) ? !isStandIn(v.trim()) || text !== v : isSecretName(name) && !keepsValue(name, v);
}

/** The name what is under each of an object's own keys goes by: the key, but
 *  - under `value`, a cookie's when the object is one (it is stored under a cookie's key, or
 *    has a name and two of a cookie's attributes), else the one word under its `name`, or
 *    its `key`, when it has one;
 *  - under every key, a jar's when the object is a jar of cookies: stored under a cookie's
 *    key with no `name`, no `value` and none of a cookie's attributes of its own.
 *  `own` is the object's own keys in lower case, and the keys asked for are too. */
function childNames(own: Map<string, unknown>, key: string | undefined): (k: string) => string {
  const cookies = key !== undefined && COOKIE_KEY.test(key);
  const marks = COOKIE_MARKS.filter((mark) => own.has(mark)).length;
  if (cookies && !marks && !own.has("name") && !own.has("value")) return () => JAR;
  const name = typeof own.get("name") === "string" ? own.get("name") : own.get("key");
  const named = cookies || (typeof name === "string" && marks > 1) ? "cookie" : name;
  return (k) =>
    k === "value" && typeof named === "string" && (named === "cookie" || ONE_WORD.test(named)) ? named : k;
}

/** Is the character at an index one of a class? */
type Is = (text: string, i: number) => boolean;

/** A class of single characters as a table of the ASCII ones: the readers below look at a
 *  text one character at a time, and a pattern run on each would be most of their time. */
function chars(one: RegExp): Is {
  const ascii = Array.from({ length: 128 }, (_, code) => one.test(String.fromCharCode(code)));
  return (text, i) => {
    const code = text.charCodeAt(i);
    return code < 128 ? ascii[code] === true : one.test(text.charAt(i));
  };
}

/** The first index from `from` whose character is not one of `ok`. */
function run(text: string, from: number, ok: Is): number {
  let i = from;
  while (i < text.length && ok(text, i)) i++;
  return i;
}

const QUOTES = "\"'`";
const BACKSLASH = chars(/\\/);
const NOT_BREAK = chars(/[^\r\n]/);
const SPACE = chars(/\s/);
const BLANK = chars(/[ \t]/);
const WORD = chars(/[\w$]/);

/** Does a string open at `at`? A quote, alone or behind the one, three or seven backslashes
 *  that JSON inside a JSON string, and so on inward, writes it with. Their number, or -1. */
function opens(text: string, at: number): number {
  const n = run(text, at, BACKSLASH) - at;
  return QUOTES.includes(text.charAt(at + n)) && (n === 0 || n === 1 || n === 3 || n === 7) ? n : -1;
}

/** Where the string that opened with `n` backslashes and the quote `q` ends, from `from`:
 *  the index of its closer, which is `q` behind `n` backslashes of its own. The backslashes
 *  before those escape each other in pairs of `n + 1`, so a quote behind any other number is
 *  part of the string. The text's length when it never closes; -1 when a line ends first
 *  and `lines` says a string of this kind does not run over one. */
function stringEnd(text: string, from: number, n: number, q: string, lines: boolean): number {
  let i = from;
  while (i < text.length) {
    const quote = run(text, i, BACKSLASH);
    const c = text.charAt(quote);
    if (c === q && (quote - i) % (2 * (n + 1)) === n) return quote - n;
    if (c === "\n" && !lines) return -1;
    i = quote + 1;
  }
  return text.length;
}

/** A cookie header written out. The end of its name behind its closing quote and bracket,
 *  if it has them, then `:` or `=`; or `,` behind the name's quote
 *  (`"Cookie", "…"`); or a space and a quote; or curl's `--cookie`, `-b` and a quote, or
 *  its own "Added cookie" line.
 *  What follows is read by cookiesEnd: it is one when it begins with `name=value`. */
const Q = "\\\\{0,3}[\"'`]";
const COOKIE_AT = new RegExp(
  `cookies?(?:(?:${Q})?\\]?\\s{0,3}[:=]\\s{0,3}\\$?(?:${Q})?|${Q}\\s{0,3},\\s{0,3}(?:${Q})?|\\s{1,3}\\$?${Q})|(?:added|replaced) cookie\\s{1,3}|(?<![\\w-])(?:--cookie\\s{1,3}\\$?(?:${Q})?|-b\\s{1,3}\\$?${Q})`,
  "gi",
);
const COOKIE_NAME = chars(/[\w!#$*+.^|~\u0080-\uffff-]/);
const COOKIE_VALUE = chars(/[^\s"'`,;\\]/);
const COOKIE_DATE = chars(/[^\r\n"'`;\\]/);

const HEADER_NAME = chars(/[\w-]/);

/** Where the header name that runs up to `end` begins (`Set-Cookie`, `X-My-Cookie`). */
function nameStart(text: string, end: number): number {
  let i = end;
  while (i > 0 && end - i < 64 && HEADER_NAME(text, i - 1)) i--;
  return i;
}

/** The quote, with its backslashes, that ends just before `at`, or "" when none does. */
function quoteBefore(text: string, at: number): string {
  if (!QUOTES.includes(text.charAt(at - 1)) || at < 1) return "";
  let from = at - 1;
  while (from > 0 && at - from < 8 && text.charAt(from - 1) === "\\") from--;
  return text.slice(from, at);
}

/** Where a cookie's value that starts at `from` ends. In quotes, behind its closing quote,
 *  or at the line's end when it has none there; but the quote the header itself is written
 *  in (`within`) closes that, and opens no value (`"sid=" + sid`). Else as far as its
 *  characters go: a comma or a backslash is one of them when the value goes on behind it,
 *  a backslash before `r`, `n` or `t` being a line's end written out. `date` is `Expires=`,
 *  with its comma and spaces. */
function cookieValueEnd(text: string, from: number, date: boolean, within: string): number {
  const n = opens(text, from);
  if (n >= 0 && text.slice(from, from + n + 1) !== within) {
    const q = text.charAt(from + n);
    const close = stringEnd(text, from + n + 1, n, q, false);
    const end = close < 0 ? run(text, from, NOT_BREAK) : Math.min(close + n + 1, text.length);
    // A value opened behind backslashes is inside a string, and that string's own quote,
    // behind fewer of them, ends it: it does not run on into what follows the string.
    for (let i = from + n + 1; n > 0 && i < end; i++) {
      const quote = run(text, i, BACKSLASH);
      if (quote < end && text.charAt(quote) === q && quote - i < n) return i;
      i = quote;
    }
    return end;
  }
  let i = from;
  // A value that is JSON written out bare, `prefs={"theme":"dark"}`: to the bracket that
  // closes it, its strings skipped, or to the line's end, or to the quote that closes the
  // string the header is in. Its quotes would end it early, and taking the line means no
  // later value on it is ever read through the same characters.
  for (let depth = 0; "{[".includes(text.charAt(from)); i++) {
    const c = text.charAt(i);
    if (i >= text.length || c === "\n" || c === "\r") return Math.min(i, text.length);
    const quoted = opens(text, i);
    if (quoted >= 0) {
      if (text.slice(i, i + quoted + 1) === within) return i;
      i = stringEnd(text, i + quoted + 1, quoted, text.charAt(i + quoted), false) + quoted;
      if (i < quoted) return run(text, from, NOT_BREAK);
    } else if (c === "\\") i = run(text, i, BACKSLASH) - 1;
    else if (c === "{" || c === "[") depth++;
    else if ((c === "}" || c === "]") && --depth === 0) return i + 1;
  }
  i = from;
  for (;;) {
    i = run(text, i, date ? COOKIE_DATE : COOKIE_VALUE);
    const c = text.charAt(i);
    if ((c !== "," && c !== "\\") || !COOKIE_VALUE(text, i + 1)) return i;
    if (c === "\\" && "rnt".includes(text.charAt(i + 1))) return i;
    i++;
  }
}

/** Where `name=value` that starts at `from` ends, or -1 when none starts there. With
 *  `bare`, a word alone is taken too: an attribute, `HttpOnly`. */
function cookiePairEnd(text: string, from: number, bare: boolean, within: string): number {
  const eq = run(text, from, COOKIE_NAME);
  if (eq === from) return -1;
  if (text.charAt(eq) !== "=") return bare ? eq : -1;
  return cookieValueEnd(text, eq + 1, text.slice(from, eq).toLowerCase() === "expires", within);
}

/** Where the cookies that start at `from` end, or -1 when none start there: `name=value`,
 *  then `;` and another, or an attribute (`Path=/`, `HttpOnly`), or `,` and the next cookie
 *  of a `Set-Cookie` that holds several. Read one character at a time, so it is linear. */
function cookiesEnd(text: string, from: number, within: string): number {
  let end = cookiePairEnd(text, from, false, within);
  while (end >= 0) {
    const sep = text.charAt(end);
    if (sep !== ";" && sep !== ",") break;
    const more = cookiePairEnd(text, run(text, end + 1, BLANK), sep === ";", within);
    if (more < 0) break;
    end = more;
  }
  return end;
}

function redactCookies(text: string): string {
  let out = "";
  let last = 0;
  COOKIE_AT.lastIndex = 0;
  for (let m = COOKIE_AT.exec(text); m; m = COOKIE_AT.exec(text)) {
    const from = COOKIE_AT.lastIndex;
    // The quote the header is written in: the one it was just opened with, or the one
    // before its name (`"Cookie: sid=" + sid`).
    const within = quoteBefore(text, from) || quoteBefore(text, nameStart(text, m.index));
    const to = cookiesEnd(text, from, within);
    if (to < 0) continue;
    // One pair that holds nothing is none: `name=value` is what a pair is called, and
    // `sid=` or `sid=${sid}` has no value of its own.
    const pair = text.slice(from, to);
    if (/^(?:name|key)=value$/i.test(pair) || isStandIn(pair.slice(pair.indexOf("=") + 1))) continue;
    out += text.slice(last, from) + REDACTED;
    last = to;
    COOKIE_AT.lastIndex = to;
  }
  return last ? out + text.slice(last) : text;
}

/** An object or a list the reading of a text is inside. */
interface Open {
  /** A cookie's: it is under a cookie's key, or in a list that is. */
  cookie: boolean;
  /** An object's own keys in lower case, each with its string, or null for anything else. */
  own?: Map<string, unknown>;
  /** Each of its strings: its key, where it begins and ends in the text, and which of the
   *  cuts were made inside it. */
  at?: [string, number, number, number, number][];
}

/** What a key written bare comes behind. */
const BEFORE_KEY = "{,";
/** A word a single quote opens a string right behind: a Python prefix, or a keyword that a
 *  minifier leaves no space after. Behind any other word it is an apostrophe. */
const BEFORE_QUOTE = /^(?:[rbfu]{1,2}|return|case|typeof|throw|yield|await|else|in|of|new|delete|void|instanceof)$/i;
/** A Python string's prefix: with the quote right behind it, it is part of the string. */
const PREFIX = /^[rbfu]{1,2}$/i;
/** A key right behind a quote: `name":`. The quote before it opened that key, so the string
 *  read up to there was none, and the quote it began with stands alone. */
const KEY_BEHIND = /[\w$-]{1,80}["'`]\s{0,3}:/y;

/** `text` without its `cuts`, each replaced by the marker. One inside another goes with it. */
function cut(text: string, cuts: [number, number][]): string {
  let out = "";
  let last = 0;
  for (const [from, to] of cuts.sort((a, b) => a[0] - b[0])) {
    if (from < last) continue;
    out += text.slice(last, from) + REDACTED;
    last = to;
  }
  return out + text.slice(last);
}

/** Objects written out in text are read as the walk reads objects: JSON, on one line or
 *  many, its keys in any order; a JavaScript or Python literal, its keys bare or in single
 *  quotes or backticks; JSON inside a JSON string, each quote behind its backslashes. Of each object it
 *  keeps the keys it has itself and the strings under them, and whether it is a cookie's:
 *  under a cookie's key, or handed to a function or a name that ends as one does
 *  (`addCookies([…])`, `cookies={…}`). Its strings then go by childName, as in the walk.
 *  What is still open at the text's end is read as closed there. One pass, no step back. */
function redactNamed(text: string): string {
  if (!/value|cookie/i.test(text)) return text;
  const cuts: [number, number][] = [];
  const read = (t: string, offset: number, depth: number): void => {
    const open: Open[] = [];
    const close = (done: Open | undefined): void => {
      if (!done?.own || !done.at) return;
      const key = done.cookie ? "cookie" : undefined;
      const names = childNames(done.own, key);
      for (const [k, from, to, first, end] of done.at) {
        const name = names(k);
        if (name === k) continue;
        const v = t.slice(from, to);
        // As it will stand: with what was cut inside it, when it holds an object of its own.
        const inner = cuts.slice(first, end).map(([a, b]): [number, number] => [a - offset - from, b - offset - from]);
        if (goesWhole(name, v, cut(v, inner))) cuts.push([offset + from, offset + to]);
      }
    };
    // The key just read, or the name just called or assigned to, until what it holds begins.
    let key: string | undefined;
    let word = "";
    let wordEnd = -1;
    let before = "";
    for (let i = 0; i < t.length; i++) {
      if (SPACE(t, i)) continue;
      const c = t.charAt(i);
      const top = open[open.length - 1];
      if (WORD(t, i)) {
        const end = run(t, i, WORD);
        const after = run(t, end, SPACE);
        word = t.slice(i, end);
        wordEnd = end;
        if (PREFIX.test(word) && QUOTES.includes(t.charAt(end))) {
          i = end - 1;
          continue;
        }
        if (t.charAt(after) === ":" && top?.own && BEFORE_KEY.includes(before)) {
          key = word.toLowerCase();
          i = after;
          before = ":";
          continue;
        }
        if (top?.own && key !== undefined) top.own.set(key, null);
        key = undefined;
        i = end - 1;
        before = "w";
        continue;
      }
      // A quote opens a string, but for two that are marks of another kind: `"` right
      // behind a digit (inches), and `'` right behind a word that is no prefix or keyword
      // (an apostrophe). But for a backtick's, a string ends on its line: a quote with no
      // partner there is read as a character, and what follows it as it stands.
      const marks = wordEnd === i && (c === '"' ? /\d$/.test(word) : c === "'" && !BEFORE_QUOTE.test(word));
      const n = c === "\\" || (QUOTES.includes(c) && !marks) ? opens(t, i) : -1;
      let to = n < 0 ? -1 : stringEnd(t, i + n + 1, n, t.charAt(i + n), t.charAt(i + n) === "`");
      KEY_BEHIND.lastIndex = to + n + 1;
      if (to >= 0 && KEY_BEHIND.test(t)) to = -1;
      if (to >= 0) {
        const from = i + n + 1;
        const after = run(t, to + n + 1, SPACE);
        if (t.charAt(after) === ":") {
          key = t.slice(from, to).toLowerCase();
          i = after;
          before = ":";
          continue;
        }
        // What the string holds is read too, as a text of its own: an object written out in
        // it, a code fence, JSON with its quotes behind backslashes.
        const first = cuts.length;
        if (depth < 3 && /[{[]|\\["'`]/.test(t.slice(from, to))) read(t.slice(from, to), offset + from, depth + 1);
        if (top?.own && top.at && key !== undefined) {
          top.own.set(key, t.slice(from, to));
          top.at.push([key, from, to, first, cuts.length]);
        }
        key = undefined;
        i = to + n;
        before = '"';
      } else if (c === "\\") {
        i = run(t, i, BACKSLASH) - 1;
      } else if (c === "{" || c === "[") {
        if (top?.own && key !== undefined) top.own.set(key, null);
        const cookie = key !== undefined ? COOKIE_KEY.test(key) : !!top && !top.own && top.cookie;
        open.push(c === "{" ? { cookie, own: new Map(), at: [] } : { cookie });
        key = undefined;
        before = c;
      } else if (c === "}" || c === "]") {
        close(open.pop());
        key = undefined;
        before = c;
      } else {
        // What `addCookies(` is handed, or `cookies =` is given, is as what `"cookies":` holds.
        key = (c === "(" || c === "=") && before === "w" ? word : undefined;
        before = c;
      }
    }
    while (open.length) close(open.pop());
  };
  read(text, 0, 0);
  return cuts.length ? cut(text, cuts) : text;
}

/** Redact every string in a JSON-able value. Keys stay; a string stored directly
 *  under a key that names a secret goes whole, `{"api_key":"[redacted]"}`, with the
 *  exemptions an assignment has: the key is the name, the string its value. So does a
 *  header's value under its name, and each string of a list of them (`set-cookie`). What
 *  is under `value` goes by the name beside it (`{"name":"Cookie","value":"…"}`), a
 *  cookie's value by the header's, and so does everything in a jar of them. */
export function redactDeep<T>(v: T): T {
  return redactUnder(v, undefined);
}

function redactUnder<T>(v: T, key: string | undefined): T {
  if (typeof v === "string") {
    const text = redactSecrets(v);
    return (key !== undefined && goesWhole(key, v, text) ? REDACTED : text) as T;
  }
  // An element has no key of its own, but a header's list of values is the header's.
  // A loop, not a callback: one stack frame per level.
  if (Array.isArray(v)) {
    const under = key !== undefined && HEADER_KEY.test(key) ? key : undefined;
    const out: unknown[] = [];
    for (const x of v) out.push(redactUnder(x, under));
    return out as T;
  }
  if (v && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>);
    const names = childNames(new Map(entries.map(([k, x]) => [k.toLowerCase(), x])), key);
    const out: Record<string, unknown> = {};
    for (const [k, x] of entries) {
      const low = k.toLowerCase();
      const name = names(low);
      out[k] = redactUnder(x, name === low ? k : name);
    }
    return out as T;
  }
  return v;
}
