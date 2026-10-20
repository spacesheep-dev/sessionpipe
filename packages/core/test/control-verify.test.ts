// SPDX-License-Identifier: Apache-2.0
// The verifier's own rules beyond the shared vectors, and the fuzz that backs the
// measure "unsigned commands executed: 0": thousands of mutations of a valid signed
// command, none of which may verify.
import { describe, expect, it } from "vitest";
import {
  type Assertion,
  b64url,
  derToRaw,
  fromB64url,
  KEY_STORE_SESSION,
  keyUsable,
  originAllowed,
  parseCommand,
  parseGrant,
  parseSessionRef,
  RS256,
  type SignedCommand,
  sameBytes,
  sha256,
  verifyAssertion,
  verifyCommand,
  verifyEnrollment,
} from "../src/control/verify.js";
import { commandStr, DayKey, MACHINE, Passkey, signed } from "./helpers/authenticator.js";

const RP = "receiver.example";
const T = 1_790_800_000_000;

describe("verifyCommand", () => {
  it("records the nonce only after every signature verified, and refuses what it couldn't record", async () => {
    const pk = await Passkey.create({ rpId: RP });
    const day = await DayKey.create();
    const c = commandStr({});
    const s = await signed(pk, day, c);
    const calls: string[] = [];
    const o = { machine: MACHINE, rpId: RP, trusted: [pk.key], now: T + 1000 };
    const forged = { ...s, csig: await (await DayKey.create()).sign(c) };
    expect(
      (
        await verifyCommand(forged, {
          ...o,
          seenNonce: (n) => {
            calls.push(n);
            return false;
          },
        })
      ).ok,
    ).toBe(false);
    expect(calls).toEqual([]); // a forged command can't burn the real one's nonce
    const r = await verifyCommand(s, {
      ...o,
      seenNonce: () => {
        throw new Error("disk full");
      },
    });
    expect(r).toMatchObject({ ok: false, code: "nonce_store" });
    const seen = new Set<string>();
    const once = (n: string) => {
      if (seen.has(n)) return true;
      seen.add(n);
      return false;
    };
    expect((await verifyCommand(s, { ...o, seenNonce: once })).ok).toBe(true);
    expect(await verifyCommand(s, { ...o, seenNonce: once })).toMatchObject({ ok: false, code: "replay" });
  });

  it("reads session references per harness", () => {
    expect(parseSessionRef("claude-code:8c132906-8c3f-4814-870a-afc3d05e1d2e")).toEqual({
      harness: "claude-code",
      id: "8c132906-8c3f-4814-870a-afc3d05e1d2e",
    });
    expect(parseSessionRef("claude-code:abc")).toBeNull();
    expect(parseSessionRef("codex:01999a7c-1f2e")).toEqual({ harness: "codex", id: "01999a7c-1f2e" });
    expect(parseSessionRef("Claude:x")).toBeNull();
    expect(parseSessionRef(":x")).toBeNull();
  });

  it("decodes base64url strictly", () => {
    expect(fromB64url("AQID")).toEqual(new Uint8Array([1, 2, 3]));
    expect(fromB64url("AQI")).toEqual(new Uint8Array([1, 2]));
    expect(fromB64url("AQ+D")).toBeNull();
    expect(fromB64url("AQ==")).toBeNull();
    expect(fromB64url("A")).toBeNull();
  });

  it("nothing, or not an object, is malformed; a valid command needs no nonce store", async () => {
    const o = { machine: MACHINE, rpId: RP, trusted: [] as never[], now: T + 1000 };
    expect(await verifyCommand(null, o)).toMatchObject({ ok: false, code: "malformed" });
    expect(await verifyCommand(undefined, o)).toMatchObject({ ok: false, code: "malformed" });
    expect(await verifyCommand(5 as unknown as SignedCommand, o)).toMatchObject({ ok: false, code: "malformed" });
    const pk = await Passkey.create({ rpId: RP });
    const day = await DayKey.create();
    const s = await signed(pk, day, commandStr({}));
    expect(await verifyCommand(s, { ...o, trusted: [pk.key] })).toMatchObject({
      ok: true,
      via: "grant",
      key: pk.key.id,
    });
  });

  it("a grant whose day key is not a key at all fails the command's signature", async () => {
    const pk = await Passkey.create({ rpId: RP });
    const day = await DayKey.create();
    const cmd = commandStr({});
    const iat = T - 60_000;
    const exp = iat + 3600_000;
    const grant = await day.grant(pk, { iat, exp, str: day.grantStr({ iat, exp, rp: RP, pub: "AAAA" }) });
    const r = await verifyCommand(
      { cmd, csig: await day.sign(cmd), grant },
      { machine: MACHINE, rpId: RP, trusted: [pk.key], now: T + 1000 },
    );
    expect(r).toMatchObject({ ok: false, code: "bad_csig" });
  });
});

describe("parseCommand", () => {
  const code = (fields: Record<string, unknown>) => {
    const p = parseCommand(commandStr(fields));
    return p.ok ? "ok" : `${p.code}: ${p.why}`;
  };
  it("the string itself", () => {
    expect(parseCommand("")).toMatchObject({ ok: false, code: "malformed" });
    expect(parseCommand(undefined)).toMatchObject({ ok: false, code: "malformed" });
    expect(parseCommand("x".repeat(48_001))).toMatchObject({ ok: false, code: "malformed" });
    expect(parseCommand("{")).toMatchObject({ ok: false, code: "malformed", why: "the command is not JSON" });
    for (const s of ["null", "[]", '"s"', "1"])
      expect(parseCommand(s), s).toMatchObject({ ok: false, code: "malformed", why: "the command is not an object" });
  });
  it("start: text and an absolute folder, nothing else", () => {
    expect(code({ kind: "start", cwd: "/x" })).toBe("ok");
    expect(code({ kind: "start", cwd: "C:\\x" })).toBe("ok");
    expect(code({ kind: "start", text: undefined, cwd: "/x" })).toMatch(/^bad_fields: a new session needs text/);
    expect(code({ kind: "start", cwd: "rel" })).toMatch(/^bad_fields: .*absolute folder/);
    expect(code({ kind: "start" })).toMatch(/^bad_fields: .*absolute folder/);
    expect(code({ kind: "start", cwd: "/x", for: "a" })).toBe("bad_fields: a start carries text and cwd");
  });
  it("permission.answer: for and decision, no text", () => {
    expect(code({ kind: "permission.answer", text: undefined, for: "a", decision: "deny" })).toBe("ok");
    expect(code({ kind: "permission.answer", for: "a", decision: "allow" })).toMatch(
      /^bad_fields: a permission answer/,
    );
    expect(code({ kind: "permission.answer", text: undefined, decision: "allow" })).toBe(
      "bad_fields: which attention?",
    );
    expect(code({ kind: "permission.answer", text: undefined, for: "a", decision: "maybe" })).toBe(
      "bad_fields: allow or deny?",
    );
  });
  it("cancel carries nothing; a note is short text", () => {
    expect(code({ kind: "cancel", text: undefined })).toBe("ok");
    expect(code({ kind: "cancel", text: undefined, note: "why" })).toBe("ok");
    expect(code({ kind: "cancel" })).toBe("bad_fields: a cancel carries nothing");
    expect(code({ kind: "cancel", text: undefined, note: "n".repeat(2001) })).toMatch(/^bad_fields: a note is text/);
    expect(code({ kind: "cancel", text: undefined, note: 5 })).toMatch(/^bad_fields: a note is text/);
  });
  it("key.add: the key store session, the key, an optional short name", () => {
    const key = { id: "a".repeat(20), alg: -7, spki: "b".repeat(50) };
    const add = (f: Record<string, unknown>) =>
      code({ kind: "key.add", session: KEY_STORE_SESSION, text: undefined, key, ...f });
    expect(add({})).toBe("ok");
    expect(add({ name: "iPhone" })).toBe("ok");
    expect(add({ name: "  " })).toBe("bad_fields: a device name is text, at most 80 characters");
    expect(add({ name: "n".repeat(81) })).toBe("bad_fields: a device name is text, at most 80 characters");
    expect(add({ text: "x" })).toBe("bad_fields: a key.add carries the key and a name");
    expect(add({ cwd: "/x" })).toBe("bad_fields: a key.add carries the key and a name");
    expect(add({ key: { ...key, alg: -8 } })).toMatch(/^bad_fields: a key.add carries the key/);
    expect(add({ key: undefined })).toMatch(/^bad_fields: a key.add carries the key/);
    expect(code({ kind: "key.add", text: undefined, key })).toMatch(/^bad_session: a key.add names/);
    expect(code({ key })).toBe("bad_fields: only a key.add carries a key");
    expect(code({ name: "x" })).toBe("bad_fields: only a key.add carries a key");
  });
});

describe("parseGrant", () => {
  const str = (g: Record<string, unknown>) =>
    JSON.stringify({ v: 1, t: "sessionpipe.grant", pub: "AAAA", iat: T, exp: T + 3600_000, rp: RP, ...g });
  it("the string itself", () => {
    expect(parseGrant(undefined, RP)).toEqual({ ok: false, why: "the grant is missing or too long" });
    expect(parseGrant("", RP)).toEqual({ ok: false, why: "the grant is missing or too long" });
    expect(parseGrant("x".repeat(2001), RP)).toEqual({ ok: false, why: "the grant is missing or too long" });
    expect(parseGrant("{", RP)).toEqual({ ok: false, why: "the grant is not JSON" });
    for (const s of ["null", "[]", "7"])
      expect(parseGrant(s, RP), s).toEqual({ ok: false, why: "the grant is not an object" });
  });
  it("the fields", () => {
    expect(parseGrant(str({}), RP)).toMatchObject({ ok: true });
    expect(parseGrant(str({ t: "x" }), RP)).toEqual({ ok: false, why: "not a sessionpipe grant" });
    expect(parseGrant(str({ rp: "other" }), RP)).toEqual({
      ok: false,
      why: `the grant is for another site, not ${RP}`,
    });
    expect(parseGrant(str({ pub: "" }), RP)).toEqual({ ok: false, why: "the grant is missing parts" });
    expect(parseGrant(str({ iat: "t" }), RP)).toEqual({ ok: false, why: "the grant is missing parts" });
    expect(parseGrant(str({ exp: T }), RP)).toEqual({ ok: false, why: "the grant ends before it starts" });
    expect(parseGrant(str({ exp: T + 2 * 86_400_000 }), RP)).toEqual({
      ok: false,
      why: "the grant lasts longer than a day",
    });
  });
});

describe("sameBytes", () => {
  it("compares the whole of equal lengths; a different length is never equal", () => {
    expect(sameBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(sameBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(sameBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2]))).toBe(false);
    expect(sameBytes(new Uint8Array(0), new Uint8Array(0))).toBe(true);
  });
});

describe("derToRaw", () => {
  const der = (ints: number[][]) => {
    const body = ints.flatMap((v) => [0x02, v.length, ...v]);
    return new Uint8Array([0x30, body.length, ...body]);
  };
  const n32 = Array.from({ length: 32 }, (_, i) => i + 1);
  it("accepts only one encoding of a signature", () => {
    expect(derToRaw(der([n32, n32]))).toEqual(new Uint8Array([...n32, ...n32]));
    expect(derToRaw(der([[5], [7]]))).toEqual(
      new Uint8Array([...new Array(31).fill(0), 5, ...new Array(31).fill(0), 7]),
    );
    expect(derToRaw(der([[0, 0x80, ...n32.slice(0, 31)], n32]))).toEqual(
      new Uint8Array([0x80, ...n32.slice(0, 31), ...n32]),
    );
    expect(derToRaw(der([[0, ...n32], n32]))).toBeNull(); // a needless leading zero
    expect(derToRaw(der([[0x81, ...n32.slice(0, 31)], n32]))).toBeNull(); // negative
    expect(derToRaw(der([[], n32]))).toBeNull(); // an empty integer
    expect(derToRaw(der([[1, ...n32, 1], n32]))).toBeNull(); // 34 bytes
    expect(derToRaw(der([[1, ...n32], n32]))).toBeNull(); // 33 bytes with no zero to drop
    expect(derToRaw(new Uint8Array([0x31, ...der([n32, n32]).slice(1)]))).toBeNull(); // not a sequence
    expect(derToRaw(new Uint8Array([0x30, 6, 0x03, 1, 1, 0x02, 1, 1]))).toBeNull(); // r is not an INTEGER
    expect(derToRaw(new Uint8Array([...der([n32, n32]), 0]))).toBeNull(); // a trailing byte
    expect(derToRaw(new Uint8Array([0x30, 6, 0x02, 1, 1, 0x02, 1, 1]))).toEqual(
      new Uint8Array([...new Array(31).fill(0), 1, ...new Array(31).fill(0), 1]),
    );
    expect(derToRaw(new Uint8Array([0x30, 5, 0x02, 1, 1, 0x02, 1]))).toBeNull(); // short
    expect(derToRaw(new Uint8Array([0x30, 6, 0x02, 10, 1, 2, 3, 4]))).toBeNull(); // an integer longer than the bytes
    expect(derToRaw(new Uint8Array([0x30, 8, 0x02, 1, 1, 0x02, 1, 1, 5, 0]))).toBeNull(); // junk after s
  });
});

describe("keys", () => {
  it("keyUsable: a well-formed id, a known algorithm, a key WebCrypto can import, RSA of 2048 bits", async () => {
    const pk = await Passkey.create({ rpId: RP });
    expect(await keyUsable(pk.key)).toBe(true);
    expect(await keyUsable(null as never)).toBe(false);
    expect(await keyUsable({ ...pk.key, id: 5 as unknown as string })).toBe(false);
    expect(await keyUsable({ ...pk.key, id: "short" })).toBe(false);
    expect(await keyUsable({ ...pk.key, alg: 1 })).toBe(false);
    expect(await keyUsable({ ...pk.key, spki: "" })).toBe(false);
    expect(await keyUsable({ ...pk.key, spki: "AAAA" })).toBe(false);
    const rsa = await Passkey.create({ rpId: RP, alg: RS256 });
    expect(await keyUsable(rsa.key)).toBe(true);
    const weak = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    );
    const spki = b64url(await crypto.subtle.exportKey("spki", weak.publicKey));
    expect(await keyUsable({ id: rsa.key.id, alg: RS256, spki })).toBe(false);
  });
  it("originAllowed", () => {
    expect(originAllowed(`https://${RP}`, RP)).toBe(true);
    expect(originAllowed(`https://app.${RP}`, RP)).toBe(true);
    expect(originAllowed("http://localhost:3000", "localhost")).toBe(true);
    expect(originAllowed(`http://${RP}`, RP)).toBe(false);
    expect(originAllowed("https://evil.example", RP)).toBe(false);
    expect(originAllowed(`https://${RP}/path`, RP)).toBe(false);
    expect(originAllowed("not a url", RP)).toBe(false);
    expect(originAllowed(5, RP)).toBe(false);
    expect(originAllowed(`https://${RP}`, "")).toBe(false);
  });
  it("verifyAssertion: the shapes it refuses before any crypto", async () => {
    const pk = await Passkey.create({ rpId: RP });
    const challenge = await sha256("c");
    const good = await pk.assert(challenge);
    expect(await verifyAssertion(challenge, good, pk.key, RP)).toEqual({ ok: true });
    expect(await verifyAssertion(challenge, null, pk.key, RP)).toMatchObject({
      ok: false,
      why: "no passkey signature",
    });
    const enc = new TextEncoder();
    for (const cd of ["null", '"s"', "7"])
      expect(await verifyAssertion(challenge, { ...good, cd: b64url(enc.encode(cd)) }, pk.key, RP)).toMatchObject({
        ok: false,
        why: "the passkey signature is malformed",
      });
    expect(await verifyAssertion(challenge, { ...good, ad: b64url(new Uint8Array(10)) }, pk.key, RP)).toMatchObject({
      ok: false,
      why: "the passkey signature is malformed",
    });
    expect(await verifyAssertion(challenge, good, { ...pk.key, alg: 0 }, RP)).toMatchObject({
      ok: false,
      why: "a trusted key is unusable",
    });
  });
  it("verifyEnrollment refuses a key the machine could never use", async () => {
    const pk = await Passkey.create({ rpId: RP });
    const proof = await pk.enroll(MACHINE, "123456");
    expect(await verifyEnrollment({ machine: MACHINE, code: "123456", key: pk.key, proof, rpId: RP })).toEqual({
      ok: true,
    });
    expect(
      await verifyEnrollment({ machine: MACHINE, code: "123456", key: { ...pk.key, alg: 0 }, proof, rpId: RP }),
    ).toMatchObject({ ok: false, why: "the key is in a shape this machine can't use" });
  });
});

// A small deterministic PRNG, so a failure names a reproducible case.
function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("fuzz: no mutation of a signed command verifies", () => {
  it("3,000 mutations across every signed field", async () => {
    const pk = await Passkey.create({ rpId: RP });
    const day = await DayKey.create();
    const base = await signed(pk, day, commandStr({}));
    const conf = await signed(pk, day, commandStr({}), { confirm: true });
    const donor = await signed(pk, day, commandStr({ text: "something else entirely" }));
    const rnd = prng(20260930);
    const pick = <T>(a: readonly T[]) => a[Math.floor(rnd() * a.length)] as T;
    const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const mutateStr = (s: string, alphabet?: string) => {
      if (!s.length) return "x";
      const i = Math.floor(rnd() * s.length);
      const op = rnd();
      if (op < 0.5) {
        const ch = alphabet ? pick([...alphabet]) : String.fromCharCode(32 + Math.floor(rnd() * 95));
        return s.slice(0, i) + ch + s.slice(i + 1);
      }
      if (op < 0.75) return s.slice(0, i) + s.slice(i + 1);
      return s.slice(0, i) + (alphabet ? pick([...alphabet]) : " ") + s.slice(i);
    };
    const mutateAssertion = (a: Assertion): Assertion => {
      const k = pick(["cred", "ad", "cd", "sig"] as const);
      return { ...a, [k]: mutateStr(a[k], B64) };
    };
    let verified = 0;
    let tried = 0;
    for (let i = 0; i < 3000; i++) {
      const useConfirm = rnd() < 0.25;
      const src = useConfirm ? conf : base;
      let m: SignedCommand = JSON.parse(JSON.stringify(src));
      const target = pick(
        useConfirm
          ? (["cmd", "confirm", "drop-confirm", "swap-cmd"] as const)
          : (["cmd", "csig", "grant.str", "grant", "drop-grant", "drop-csig", "swap-cmd", "swap-grant"] as const),
      );
      switch (target) {
        case "cmd":
          m.cmd = mutateStr(m.cmd);
          break;
        case "csig":
          m.csig = mutateStr(m.csig ?? "", B64);
          break;
        case "grant.str":
          m.grant = { ...m.grant!, str: mutateStr(m.grant!.str) };
          break;
        case "grant":
          m.grant = { ...m.grant!, ...mutateAssertion(m.grant!) };
          break;
        case "confirm":
          m.confirm = mutateAssertion(m.confirm!);
          break;
        case "drop-grant":
          m.grant = null;
          break;
        case "drop-csig":
          m.csig = null;
          break;
        case "drop-confirm":
          m.confirm = null;
          break;
        case "swap-cmd":
          m.cmd = donor.cmd;
          break;
        case "swap-grant":
          m = { ...m, csig: donor.csig ?? null };
          break;
      }
      if (JSON.stringify(m) === JSON.stringify(src)) continue; // the mutation changed nothing
      tried++;
      const r = await verifyCommand(m, { machine: MACHINE, rpId: RP, trusted: [pk.key], now: T + 1000 });
      if (r.ok) {
        // Only a mutation that decodes to the very same bytes may verify (a base64
        // character whose change lands in unused trailing bits).
        const sameBytes = m.cmd === src.cmd && JSON.stringify(decodeAll(m)) === JSON.stringify(decodeAll(src));
        if (!sameBytes) verified++;
      }
    }
    expect(tried).toBeGreaterThan(2500);
    expect(verified).toBe(0);
  }, 60_000);
});

function decodeAll(s: SignedCommand) {
  const d = (x?: string | null) => (x ? Array.from(fromB64url(x) ?? []) : null);
  const a = (x?: Assertion | null) => (x ? { cred: x.cred, ad: d(x.ad), cd: d(x.cd), sig: d(x.sig) } : null);
  return { csig: d(s.csig), grant: s.grant ? { str: s.grant.str, ...a(s.grant) } : null, confirm: a(s.confirm) };
}
