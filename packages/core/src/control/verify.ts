// SPDX-License-Identifier: Apache-2.0
// The one verifier for signed control commands (spec/CONTROL.md §4–§5). A machine
// runs a command only when this says yes; a receiver MAY run it too, as an early
// word, so a bad command is refused where the person can see why.
//
// WebCrypto only (globalThis.crypto.subtle), no node: imports, no clock of its own
// (`now` is passed in): the same file runs in a Cloudflare Worker, in a browser and
// in Node ≥ 20, and conformance/control-vectors/ pins its answers.
//
// Every signature covers the EXACT bytes as transmitted (`cmd`, `grant.str`): the
// strings are parsed to read their fields and never re-serialized to verify.

/** One passkey tap vouches for a day key for at most this long. */
export const GRANT_MAX_MS = 24 * 3600_000;
/** Clock slack between the signing device, the receiver and the machine. */
export const SKEW_MS = 5 * 60_000;
/** The machine judges a command by when it was SIGNED: a message sent while the lid
 *  was shut still runs when the machine wakes, up to a day later. */
export const MACHINE_MAX_AGE_MS = 24 * 3600_000;
/** A receiver's early check is stricter: a command is carried within ten minutes of
 *  being signed, or not at all. */
export const RECEIVER_MAX_AGE_MS = 10 * 60_000;
/** How long a machine remembers a nonce: longer than MACHINE_MAX_AGE_MS + SKEW_MS. */
export const NONCE_TTL_MS = 25 * 3600_000;
/** The whole command string, in UTF-16 code units (what JSON.parse sees). */
export const CMD_MAX = 48_000;
/** A prompt's text, in characters. */
export const TEXT_MAX = 20_000;
/** A permission answer's note. */
export const NOTE_MAX = 2_000;
/** A grant string. */
export const GRANT_STR_MAX = 2_000;
/** Attachments on a `start` or a `prompt` (CONTROL.md §3.1): at most this many files, */
export const FILES_MAX = 10;
/** each at most this many bytes, */
export const FILE_SIZE_MAX = 26_214_400;
/** together at most this many, */
export const FILES_TOTAL_MAX = 52_428_800;
/** with a name of at most this many characters (after NFC) */
export const FILE_NAME_MAX = 200;
/** and a media type of at most this many. */
export const FILE_TYPE_MAX = 100;
/** A start's `model` (CONTROL.md §3.1): at most this many characters, */
export const MODEL_MAX = 100;
/** in this alphabet, never starting with a dash, so it can never read as a flag. */
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]*$/;
/** The levels a start may ask for (CONTROL.md §3.1), narrowest first. Closed: no level
 *  is wider than `auto`, and none turns a harness's approval off. */
export const START_PERMISSIONS = ["read", "safe", "edits", "auto"] as const;
export type StartPermission = (typeof START_PERMISSIONS)[number];
/** What a run is started with: a level, or `inherit` (CONTROL.md §2) — no permission
 *  flag at all, so the harness starts in its own default on the machine. Only a machine
 *  the person put in inherit mode runs that way; a command never names it. */
export type RunLevel = StartPermission | "inherit";

/** Where a level sits, narrowest (0) to widest; -1 for anything that isn't one. */
export const levelRank = (l: unknown): number => START_PERMISSIONS.indexOf(l as StartPermission);
/** The narrower of two levels: what a later run of a session gets, its recorded level
 *  against what the machine's mode allows now. */
export const narrower = (a: StartPermission, b: StartPermission): StartPermission =>
  levelRank(a) <= levelRank(b) ? a : b;

export const COMMAND_TYPE = "sessionpipe.control";
export const GRANT_TYPE = "sessionpipe.grant";
export const CONTROL_KINDS = ["prompt", "permission.answer", "cancel", "start", "key.add"] as const;
/** The session a `key.add` names: the machine's own key store, not a coding session. */
export const KEY_STORE_SESSION = "sessionpipe:keys";
export type ControlKind = (typeof CONTROL_KINDS)[number];

/** COSE algorithm ids a trusted key may use. */
export const ES256 = -7;
export const RS256 = -257;

/** A key enrolled on the machine: a passkey's credential id, COSE alg and SPKI (base64url). */
export interface TrustedKey {
  id: string;
  alg: number;
  spki: string;
}
/** A WebAuthn assertion: credential id, authenticatorData, clientDataJSON, signature (base64url). */
export interface Assertion {
  cred: string;
  ad: string;
  cd: string;
  sig: string;
}
/** The day's grant: a passkey's assertion over sha256(str), where str names the day key. */
export interface GrantBundle extends Assertion {
  str: string;
}
/** What a receiver carries for one command (control.json minus the receiver's envelope). */
export interface SignedCommand {
  cmd: string;
  csig?: string | null;
  grant?: GrantBundle | null;
  confirm?: Assertion | null;
}
export interface Grant {
  v: 1;
  t: typeof GRANT_TYPE;
  pub: string;
  iat: number;
  exp: number;
  rp: string;
}
/** One file attached to a `start`: the bytes live on the receiver, named by their hash. */
export interface ControlFile {
  /** The file name the machine writes (NFC). */
  name: string;
  /** Media type, `type/subtype`. */
  type: string;
  /** Bytes. */
  size: number;
  /** SHA-256 of the bytes, base64url without padding (43 characters). */
  sha256: string;
}
export interface ControlCommand {
  v: 1;
  t: typeof COMMAND_TYPE;
  machine: string;
  kind: ControlKind;
  /** `<harness>:<id>`, e.g. `claude-code:8c132906-…`. */
  session: string;
  text?: string;
  for?: string;
  decision?: "allow" | "deny";
  note?: string;
  cwd?: string;
  /** key.add only: the passkey to trust from now on, as the receiver holds it. */
  key?: { id: string; alg: -7 | -257; spki: string };
  /** key.add only: what the person calls the device ("iPhone"), for `control keys`. */
  name?: string;
  /** start, prompt: files to download, verify and write into the session's folder. */
  files?: ControlFile[];
  /** start only: the level the new session runs at (never above the machine's mode). */
  permission?: StartPermission;
  /** start only: the model the harness runs, as the harness names it. */
  model?: string;
  nonce: string;
  iat: number;
}

/** Why a command was refused. Stable: conformance vectors and acks name these. */
export type RefusalCode =
  | "malformed"
  | "not_a_command"
  | "wrong_machine"
  | "unknown_kind"
  | "bad_session"
  | "bad_fields"
  | "bad_nonce"
  | "too_old"
  | "future"
  | "unsigned"
  | "untrusted_key"
  | "bad_assertion"
  | "bad_grant"
  | "outside_grant"
  | "bad_csig"
  | "replay"
  | "nonce_store";

export type Verdict =
  | { ok: true; cmd: ControlCommand; via: "grant" | "confirm"; key: string }
  | { ok: false; code: RefusalCode; why: string };

export interface VerifyOptions {
  /** This machine's id; a command for another machine is refused. */
  machine: string;
  /** The receiver's WebAuthn rp id the keys were enrolled for (well-known control.signing.rp_id). */
  rpId: string;
  /** The keys enrolled on this machine (or, for a receiver's early check, the account's). */
  trusted: TrustedKey[];
  /** Epoch ms. */
  now: number;
  /** MACHINE_MAX_AGE_MS on a machine (default), RECEIVER_MAX_AGE_MS on a receiver. */
  maxAgeMs?: number;
  /** Called once, last, only for a command whose signatures all verified: answer
   *  true when the nonce was seen before, otherwise record it (durably) and answer
   *  false. A throw refuses the command (`nonce_store`): never run what could not
   *  be remembered. Omit it on a receiver's early check. */
  seenNonce?: (nonce: string) => boolean | Promise<boolean>;
}

const NONCE_RE = /^[A-Za-z0-9_-]{22,64}$/;
const MACHINE_RE = /^m_[A-Za-z0-9_-]{16,40}$/;
const HARNESS_RE = /^[a-z][a-z0-9-]{0,39}$/;
const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const B64URL_RE = /^[A-Za-z0-9_-]*$/;
const SHA256_RE = /^[A-Za-z0-9_-]{43}$/;
const MEDIA_TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what it rejects
const BAD_NAME_CHAR_RE = /[/\\\x00-\x1f\x7f]/;
const UP = 0x01;
const UV = 0x04;

/** The fields each kind carries besides the common ones (CONTROL.md §3.1). The set is
 *  closed: a field it doesn't list is `bad_fields`, so a field added later fails closed
 *  on a machine that predates it instead of being ignored. */
const COMMON_FIELDS: readonly string[] = ["v", "t", "machine", "kind", "session", "nonce", "iat", "note"];
const FIELDS: Record<ControlKind, readonly string[]> = {
  prompt: ["text", "files"],
  "permission.answer": ["for", "decision"],
  cancel: [],
  start: ["text", "cwd", "files", "permission", "model"],
  "key.add": ["key", "name"],
};

// --- encodings ------------------------------------------------------------------

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64url(bytes: Uint8Array | ArrayBuffer): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url without padding, strictly; null for anything else. */
export function fromB64url(s: unknown): Uint8Array | null {
  if (typeof s !== "string" || !B64URL_RE.test(s) || s.length % 4 === 1) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export async function sha256(data: string | Uint8Array): Promise<Uint8Array> {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Equal, compared whole: a mismatch costs the same as a match. */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= (a[i] as number) ^ (b[i] as number);
  return d === 0;
}

/** A DER ECDSA signature (what WebAuthn returns) as the 64-byte r‖s WebCrypto verifies.
 *  Strict: every length must match the bytes, so one signature has one encoding (a
 *  P-256 signature is at most 72 bytes, so the short length form is the only one). */
export function derToRaw(der: Uint8Array): Uint8Array | null {
  if (der[0] !== 0x30 || der.length < 8 || der[1] !== der.length - 2) return null;
  let i = 2;
  const part = (): Uint8Array | null => {
    if (der[i] !== 0x02) return null;
    const len = der[i + 1] as number;
    if (len < 1 || len > 33) return null;
    let v = der.slice(i + 2, i + 2 + len);
    if (v.length !== len) return null;
    // Minimal integers only: no needless leading zero, and never negative.
    if ((v[0] as number) & 0x80) return null;
    if (len > 1 && v[0] === 0 && !((v[1] as number) & 0x80)) return null;
    i += 2 + len;
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    if (v.length > 32) return null;
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };
  const r = part();
  const s = part();
  return r && s && i === der.length ? concat(r, s) : null;
}

const u8 = (b: Uint8Array) => b as Uint8Array<ArrayBuffer>;
/** WebCrypto's key type, named without the DOM lib (Workers, Node and browsers all have it). */
type CryptoKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

async function importKey(key: TrustedKey): Promise<CryptoKey | null> {
  const spki = fromB64url(key.spki);
  if (!spki?.length) return null;
  try {
    if (key.alg === ES256)
      return await crypto.subtle.importKey("spki", u8(spki), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    if (key.alg === RS256) {
      const k = await crypto.subtle.importKey("spki", u8(spki), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
        "verify",
      ]);
      const bits = (k.algorithm as { modulusLength?: number }).modulusLength as number; // every RSA key has one
      return bits >= 2048 ? k : null;
    }
  } catch {}
  return null;
}

/** Can this key be enrolled at all? A machine refuses to trust a key it could never verify with. */
export async function keyUsable(key: TrustedKey): Promise<boolean> {
  return (
    !!key &&
    typeof key.id === "string" &&
    /^[A-Za-z0-9_-]{16,1400}$/.test(key.id) &&
    (key.alg === ES256 || key.alg === RS256) &&
    !!(await importKey(key))
  );
}

// --- WebAuthn -------------------------------------------------------------------

/** A WebAuthn origin a key may have been used from: https on the rp id or a subdomain;
 *  for rp id `localhost`, plain http on any port too. A bare origin, as a browser writes it. */
export function originAllowed(origin: unknown, rpId: string): boolean {
  if (typeof origin !== "string" || !rpId) return false;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.origin !== origin) return false;
  if (u.hostname !== rpId && !u.hostname.endsWith(`.${rpId}`)) return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && rpId === "localhost";
}

type Check = { ok: true } | { ok: false; why: string };
const no = (why: string): Check => ({ ok: false, why });

/** One passkey assertion over `challenge`, made with `key`, by a verified person. */
export async function verifyAssertion(
  challenge: Uint8Array,
  a: Assertion | null | undefined,
  key: TrustedKey,
  rpId: string,
): Promise<Check> {
  if (!a || typeof a !== "object") return no("no passkey signature");
  if (a.cred !== key.id) return no("signed with a key this machine doesn't trust");
  const cdBytes = fromB64url(a.cd);
  const ad = fromB64url(a.ad);
  const sig = fromB64url(a.sig);
  if (!cdBytes || !ad || !sig?.length) return no("the passkey signature is malformed");
  let cd: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
  try {
    cd = JSON.parse(dec.decode(cdBytes));
  } catch {
    return no("the passkey signature is malformed");
  }
  if (!cd || typeof cd !== "object") return no("the passkey signature is malformed");
  if (cd.type !== "webauthn.get") return no("the passkey answered a different question");
  if (cd.challenge !== b64url(challenge)) return no("the passkey signed something else");
  if (!originAllowed(cd.origin, rpId)) return no(`the passkey was used on another site, not ${rpId}`);
  if (cd.crossOrigin === true) return no("the passkey was used inside another site's frame");
  if (ad.length < 37) return no("the passkey signature is malformed");
  if (!sameBytes(ad.slice(0, 32), await sha256(rpId))) return no(`the passkey belongs to another site, not ${rpId}`);
  const flags = ad[32] as number;
  if (!(flags & UP) || !(flags & UV)) return no("the passkey signed without verifying the person");
  const pub = await importKey(key);
  if (!pub) return no("a trusted key is unusable");
  const signed = concat(ad, await sha256(cdBytes));
  let good = false;
  try {
    if (key.alg === ES256) {
      const raw = derToRaw(sig);
      good = !!raw && (await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, u8(raw), u8(signed)));
    } else {
      good = await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, pub, u8(sig), u8(signed));
    }
  } catch {
    good = false;
  }
  return good ? { ok: true } : no("the passkey signature doesn't verify");
}

/** What a passkey signs to enroll on a machine: bound to that machine and that pairing code. */
export function pairChallenge(machine: string, code: string): Promise<Uint8Array> {
  return sha256(`sessionpipe.pair:${machine}:${code}`);
}

/** The enrollment proof: the new key's assertion over pairChallenge(machine, code).
 *  Only after this verifies does the key go into the machine's trust store. */
export async function verifyEnrollment(o: {
  machine: string;
  code: string;
  key: TrustedKey;
  proof: Assertion;
  rpId: string;
}): Promise<Check> {
  if (!(await keyUsable(o.key))) return no("the key is in a shape this machine can't use");
  return verifyAssertion(await pairChallenge(o.machine, o.code), o.proof, o.key, o.rpId);
}

// --- the command ------------------------------------------------------------------

type Parsed = { ok: true; cmd: ControlCommand } | { ok: false; code: RefusalCode; why: string };
const bad = (code: RefusalCode, why: string): { ok: false; code: RefusalCode; why: string } => ({
  ok: false,
  code,
  why,
});
const isNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** The session id rule per harness (ADAPTERS.md): Claude Code ids are UUIDs. */
export function sessionIdOk(harness: string, id: string): boolean {
  if (!SESSION_ID_RE.test(id)) return false;
  if (harness === "claude-code") return UUID_RE.test(id);
  return true;
}

/** Split `<harness>:<id>`; null when either half breaks its rule. */
export function parseSessionRef(ref: unknown): { harness: string; id: string } | null {
  if (typeof ref !== "string") return null;
  const i = ref.indexOf(":");
  if (i <= 0) return null;
  const harness = ref.slice(0, i);
  const id = ref.slice(i + 1);
  return HARNESS_RE.test(harness) && sessionIdOk(harness, id) ? { harness, id } : null;
}

/** Read the command's fields from the exact string. Structure only; no clock, no keys. */
export function parseCommand(str: unknown): Parsed {
  if (typeof str !== "string" || !str || str.length > CMD_MAX)
    return bad("malformed", "the command is missing or too long");
  let c: Record<string, unknown>;
  try {
    c = JSON.parse(str);
  } catch {
    return bad("malformed", "the command is not JSON");
  }
  if (!c || typeof c !== "object" || Array.isArray(c)) return bad("malformed", "the command is not an object");
  if (c.v !== 1 || c.t !== COMMAND_TYPE) return bad("not_a_command", "not a sessionpipe control command");
  if (typeof c.machine !== "string" || !MACHINE_RE.test(c.machine)) return bad("malformed", "which machine?");
  if (!CONTROL_KINDS.includes(c.kind as ControlKind))
    return bad("unknown_kind", "the command asks for something unknown");
  const ref = parseSessionRef(c.session);
  if (!ref) return bad("bad_session", "which session?");
  if (typeof c.nonce !== "string" || !NONCE_RE.test(c.nonce))
    return bad("bad_nonce", "the nonce is missing or malformed");
  if (!isNum(c.iat) || !Number.isInteger(c.iat) || c.iat <= 0)
    return bad("malformed", "the command has no signing time");
  const has = (k: string) => c[k] !== undefined;
  const text = () => typeof c.text === "string" && c.text.trim().length > 0 && c.text.length <= TEXT_MAX;
  switch (c.kind as ControlKind) {
    case "prompt":
      if (!text()) return bad("bad_fields", `a prompt needs text, at most ${TEXT_MAX} characters`);
      if (has("for") || has("decision") || has("cwd")) return bad("bad_fields", "a prompt carries text and files");
      if (has("files")) {
        const why = filesProblem(c.files);
        if (why) return bad("bad_fields", why);
      }
      break;
    case "start":
      if (!text()) return bad("bad_fields", `a new session needs text, at most ${TEXT_MAX} characters`);
      if (typeof c.cwd !== "string" || !(isAbsolute(c.cwd) || HOME_RELATIVE_RE.test(c.cwd)) || c.cwd.length > 1024)
        return bad("bad_fields", "a new session needs an absolute folder, or one under ~");
      if (has("for") || has("decision"))
        return bad("bad_fields", "a start carries text, cwd, files, a permission and a model");
      if (has("files")) {
        const why = filesProblem(c.files);
        if (why) return bad("bad_fields", why);
      }
      if (has("permission") && levelRank(c.permission) < 0)
        return bad("bad_fields", `a permission is one of ${START_PERMISSIONS.join(", ")}`);
      if (has("model") && (typeof c.model !== "string" || c.model.length > MODEL_MAX || !MODEL_RE.test(c.model)))
        return bad("bad_fields", `a model is 1 to ${MODEL_MAX} letters, digits and ._:/@[]-, not starting with a dash`);
      break;
    case "permission.answer":
      if (typeof c.for !== "string" || !c.for || c.for.length > 128) return bad("bad_fields", "which attention?");
      if (c.decision !== "allow" && c.decision !== "deny") return bad("bad_fields", "allow or deny?");
      if (has("text") || has("cwd")) return bad("bad_fields", "a permission answer carries for, decision and note");
      break;
    case "cancel":
      if (has("text") || has("for") || has("decision") || has("cwd"))
        return bad("bad_fields", "a cancel carries nothing");
      break;
    case "key.add": {
      // A device the machine already trusts vouches for a new one (CONTROL.md §2): the
      // new passkey's id, algorithm and public key are inside the signed bytes.
      if (c.session !== KEY_STORE_SESSION) return bad("bad_session", `a key.add names ${KEY_STORE_SESSION}`);
      const k = c.key as { id?: unknown; alg?: unknown; spki?: unknown } | undefined;
      const b64 = (v: unknown, min: number, max: number) =>
        typeof v === "string" && v.length >= min && v.length <= max && /^[A-Za-z0-9_-]+$/.test(v);
      if (
        !k ||
        typeof k !== "object" ||
        !b64(k.id, 16, 1400) ||
        (k.alg !== -7 && k.alg !== -257) ||
        !b64(k.spki, 40, 2000)
      )
        return bad("bad_fields", "a key.add carries the key: id, alg (-7 or -257) and spki");
      if (has("name") && (typeof c.name !== "string" || !c.name.trim() || c.name.length > 80))
        return bad("bad_fields", "a device name is text, at most 80 characters");
      if (has("text") || has("for") || has("decision") || has("cwd"))
        return bad("bad_fields", "a key.add carries the key and a name");
      break;
    }
  }
  if (c.kind !== "key.add" && (has("key") || has("name"))) return bad("bad_fields", "only a key.add carries a key");
  if (c.kind !== "start" && c.kind !== "prompt" && has("files"))
    return bad("bad_fields", "only a start or a prompt carries files");
  if (c.kind !== "start" && (has("permission") || has("model")))
    return bad("bad_fields", "only a start carries a model or a permission");
  const allowed = FIELDS[c.kind as ControlKind];
  for (const k of Object.keys(c))
    if (!COMMON_FIELDS.includes(k) && !allowed.includes(k))
      return bad("bad_fields", `the command carries a field its kind doesn't have: ${k.slice(0, 40)}`);
  if (has("note") && (typeof c.note !== "string" || c.note.length > NOTE_MAX))
    return bad("bad_fields", `a note is text, at most ${NOTE_MAX} characters`);
  return { ok: true, cmd: c as unknown as ControlCommand };
}

/** Why a start's or a prompt's `files` breaks the rules (CONTROL.md §3.1), or null when it doesn't. */
export function filesProblem(files: unknown): string | null {
  if (!Array.isArray(files) || files.length < 1 || files.length > FILES_MAX)
    return `files is a list of 1 to ${FILES_MAX} files`;
  const seen = new Set<string>();
  let total = 0;
  for (const f of files as unknown[]) {
    if (!f || typeof f !== "object" || Array.isArray(f)) return "each file is an object";
    const { name, type, size, sha256: hash } = f as Record<string, unknown>;
    const why = fileNameProblem(name);
    if (why) return why;
    const key = (name as string).normalize("NFC").toLowerCase();
    if (seen.has(key)) return "two files have the same name";
    seen.add(key);
    if (typeof type !== "string" || type.length > FILE_TYPE_MAX || !MEDIA_TYPE_RE.test(type))
      return "a file's type isn't a media type";
    if (!isNum(size) || !Number.isInteger(size) || size < 1 || size > FILE_SIZE_MAX)
      return `a file is 1 byte to ${FILE_SIZE_MAX / 1_048_576} MiB`;
    total += size;
    if (typeof hash !== "string" || !SHA256_RE.test(hash)) return "a file's sha256 isn't 43 base64url characters";
  }
  if (total > FILES_TOTAL_MAX) return `the files add up to more than ${FILES_TOTAL_MAX / 1_048_576} MiB`;
  return null;
}

/** A file name the machine can write inside the session's folder and nowhere else. */
function fileNameProblem(name: unknown): string | null {
  if (typeof name !== "string") return "a file has no name";
  const n = name.normalize("NFC");
  if (n.length < 1 || n.length > FILE_NAME_MAX) return `a file name is 1 to ${FILE_NAME_MAX} characters`;
  if (BAD_NAME_CHAR_RE.test(n)) return "a file name has a slash, a backslash or a control character";
  if (n.startsWith(".")) return "a file name can't start with a dot";
  return null;
}

/** A `start`'s `cwd` under the machine's home: `~` alone, or `~/…` (`~\…`). Never `~user`. */
export const HOME_RELATIVE_RE = /^~(?:[\\/]|$)/;

function isAbsolute(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
}

/** The grant's fields, read from its exact string. */
export function parseGrant(str: unknown, rpId: string): { ok: true; grant: Grant } | { ok: false; why: string } {
  if (typeof str !== "string" || !str || str.length > GRANT_STR_MAX)
    return { ok: false, why: "the grant is missing or too long" };
  let g: Record<string, unknown>;
  try {
    g = JSON.parse(str);
  } catch {
    return { ok: false, why: "the grant is not JSON" };
  }
  if (!g || typeof g !== "object" || Array.isArray(g)) return { ok: false, why: "the grant is not an object" };
  if (g.v !== 1 || g.t !== GRANT_TYPE) return { ok: false, why: "not a sessionpipe grant" };
  if (g.rp !== rpId) return { ok: false, why: `the grant is for another site, not ${rpId}` };
  if (typeof g.pub !== "string" || !fromB64url(g.pub)?.length || !isNum(g.iat) || !isNum(g.exp))
    return { ok: false, why: "the grant is missing parts" };
  if (g.exp <= g.iat) return { ok: false, why: "the grant ends before it starts" };
  if (g.exp - g.iat > GRANT_MAX_MS + SKEW_MS) return { ok: false, why: "the grant lasts longer than a day" };
  return { ok: true, grant: g as unknown as Grant };
}

async function verifyCsig(cmd: string, csig: unknown, pub: string): Promise<boolean> {
  const sig = fromB64url(csig);
  const spki = fromB64url(pub);
  if (sig?.length !== 64 || !spki) return false;
  try {
    const key = await crypto.subtle.importKey("spki", u8(spki), { name: "ECDSA", namedCurve: "P-256" }, false, [
      "verify",
    ]);
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, u8(sig), u8(enc.encode(cmd)));
  } catch {
    return false;
  }
}

/**
 * Is this a command this machine may run? The checks, in the spec's order
 * (CONTROL.md §5): the exact bytes parse; the command is for this machine; it is
 * signed — a grant from a trusted key plus the day key's signature, or a confirm
 * over sha256(cmd); it was signed within the age window; its nonce is new.
 * The folder and open-attention checks that follow are the daemon's (they read
 * the machine, not the command).
 */
export async function verifyCommand(s: SignedCommand | null | undefined, o: VerifyOptions): Promise<Verdict> {
  if (!s || typeof s !== "object") return bad("malformed", "nothing to verify");
  const p = parseCommand(s.cmd);
  if (!p.ok) return p;
  const c = p.cmd;
  if (c.machine !== o.machine) return bad("wrong_machine", "the command is for another machine");

  let via: "grant" | "confirm" | null = null;
  let keyId = "";
  let refusal: { code: RefusalCode; why: string } | null = null;
  if (s.grant && s.csig) {
    const r = await checkGrantPath(s, c, o);
    if (r.ok) {
      via = "grant";
      keyId = r.key;
    } else refusal = r;
  }
  if (!via && s.confirm) {
    const key = o.trusted.find((k) => k && k.id === s.confirm?.cred);
    if (!key) refusal = { code: "untrusted_key", why: "confirmed with a key this machine doesn't trust" };
    else {
      const a = await verifyAssertion(await sha256(s.cmd), s.confirm, key, o.rpId);
      if (a.ok) {
        via = "confirm";
        keyId = key.id;
      } else refusal = { code: "bad_assertion", why: a.why };
    }
  }
  if (!via) {
    if (refusal) return bad(refusal.code, refusal.why);
    return bad("unsigned", "the command isn't signed");
  }
  if (c.iat > o.now + SKEW_MS) return bad("future", "the command is dated in the future (is this clock right?)");
  if (o.now - c.iat > (o.maxAgeMs ?? MACHINE_MAX_AGE_MS)) return bad("too_old", "the command was signed too long ago");
  if (o.seenNonce) {
    let seen: boolean;
    try {
      seen = await o.seenNonce(c.nonce);
    } catch {
      return bad("nonce_store", "the nonce couldn't be recorded, so the command didn't run");
    }
    if (seen) return bad("replay", "this command was already used once");
  }
  return { ok: true, cmd: c, via, key: keyId };
}

async function checkGrantPath(
  s: SignedCommand,
  c: ControlCommand,
  o: VerifyOptions,
): Promise<{ ok: true; key: string } | { ok: false; code: RefusalCode; why: string }> {
  const bundle = s.grant as GrantBundle;
  const g = parseGrant(bundle.str, o.rpId);
  if (!g.ok) return bad("bad_grant", g.why);
  const key = o.trusted.find((k) => k && k.id === bundle.cred);
  if (!key) return bad("untrusted_key", "the grant was signed with a key this machine doesn't trust");
  const a = await verifyAssertion(await sha256(bundle.str), bundle, key, o.rpId);
  if (!a.ok) return bad("bad_assertion", a.why);
  if (!(await verifyCsig(s.cmd, s.csig, g.grant.pub)))
    return bad("bad_csig", "the command's signature doesn't verify — it was changed after it was signed");
  if (c.iat < g.grant.iat - SKEW_MS || c.iat > g.grant.exp)
    return bad("outside_grant", "the command was signed outside its grant's window");
  return { ok: true, key: key.id };
}
