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
    if (isPlaceholder(value) || value.includes(REDACTED)) continue;
    // `max_tokens: 4096`, `input_tokens=12k` — a token COUNT, not a token.
    if (/tokens?$/i.test(name) && /^\d+(?:[.,]\d+)*[km]?$/i.test(value)) continue;
    const q = v[1] != null ? '"' : v[2] != null ? "'" : v[3] != null ? "`" : "";
    out += text.slice(last, v.index) + q + REDACTED + q;
    last = VALUE.lastIndex;
  }
  return last ? out + text.slice(last) : text;
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

/** A value that is plainly not the secret itself: a type, a variable, a template, an
 *  already-redacted marker, an env lookup. */
function isPlaceholder(v: string): boolean {
  const s = v.replace(/[.,;:!?]+$/, "");
  if (!s) return true;
  if (
    /^(?:string|number|boolean|bool|str|int|any|unknown|null|undefined|none|nil|true|false|optional|required|text|varchar|password|secret|token|env|string\[\]|object|bytes)$/i.test(
      s,
    )
  )
    return true;
  if (/^\[?redacted\]?$/i.test(s) || /^\*+$/.test(s) || /^x{3,}$/i.test(s) || /^\.{3}$|^…$/.test(s)) return true;
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
  const s = v.replace(/[.,;:!?)]+$/, "");
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
  return out;
}

/** Did redaction change anything? */
export function hasSecret(text: string): boolean {
  return !!text && redactSecrets(text) !== text;
}

/** Redact every string in a JSON-able value (keys are left alone). */
export function redactDeep<T>(v: T): T {
  if (typeof v === "string") return redactSecrets(v) as T;
  if (Array.isArray(v)) return v.map(redactDeep) as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = redactDeep(x);
    return out as T;
  }
  return v;
}
