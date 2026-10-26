// SPDX-License-Identifier: Apache-2.0
// The verifier's own rules beyond the shared vectors, and the fuzz that backs the
// measure "unsigned commands executed: 0": thousands of mutations of a valid signed
// command, none of which may verify.
import { describe, expect, it } from "vitest";
import {
  type Assertion,
  b64url,
  DEVICE_CONTEXT,
  derToRaw,
  deviceKeyId,
  deviceMessage,
  filesProblem,
  fromB64url,
  type GrantBundle,
  KEY_STORE_SESSION,
  KEY_TYPES,
  keyUsable,
  levelRank,
  MODEL_MAX,
  MODEL_RE,
  narrower,
  originAllowed,
  parseCommand,
  parseGrant,
  parseSessionRef,
  RS256,
  type SignedCommand,
  START_PERMISSIONS,
  sameBytes,
  sha256,
  verifyAssertion,
  verifyCommand,
  verifyEnrollment,
} from "../src/control/verify.js";
import {
  commandStr,
  DayKey,
  DeviceKeySim,
  deviceSigned,
  MACHINE,
  nonce,
  Passkey,
  signed,
} from "./helpers/authenticator.js";

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

  it("checks a start's files: lengths after NFC, names unique across case and form, only on a start or a prompt", () => {
    const f = { name: "a.png", type: "image/png", size: 10, sha256: "A".repeat(43) };
    expect(filesProblem([f])).toBeNull();
    // 201 code units as sent, 200 characters after NFC: allowed.
    expect(filesProblem([{ ...f, name: `${"n".repeat(195)}e\u0301.bin` }])).toBeNull();
    expect(filesProblem([{ ...f, name: `${"n".repeat(196)}e\u0301.bin` }])).toMatch(/1 to 200/);
    // The same name in NFC and NFD is the same file on a Mac.
    expect(
      filesProblem([
        { ...f, name: "caf\u00e9.png" },
        { ...f, name: "CAFE\u0301.png" },
      ]),
    ).toMatch(/same name/);
    expect(filesProblem([{ ...f, name: 5 }])).toMatch(/no name/);
    expect(filesProblem([{ ...f, type: 5 }])).toMatch(/media type/);
    expect(filesProblem([{ ...f, type: `${"x".repeat(100)}/y` }])).toMatch(/media type/);
    expect(filesProblem([{ ...f, type: "image/png; charset=x" }])).toMatch(/media type/);
    expect(filesProblem([{ ...f, sha256: 5 }])).toMatch(/sha256/);
    expect(filesProblem([null])).toMatch(/object/);
    // Only a start or a prompt carries files: every other kind is refused for them alone.
    const key = { id: "A".repeat(16), alg: -7, spki: "A".repeat(40) };
    for (const fields of [
      { kind: "permission.answer", text: undefined, for: "perm-1", decision: "deny" },
      { kind: "cancel", text: undefined },
      { kind: "key.add", text: undefined, session: KEY_STORE_SESSION, key },
    ])
      expect(parseCommand(commandStr({ ...fields, files: [f] }))).toMatchObject({
        ok: false,
        code: "bad_fields",
        why: "only a start or a prompt carries files",
      });
    const st = (files: unknown) => parseCommand(commandStr({ kind: "start", cwd: "/tmp", files }));
    expect(st([f]).ok).toBe(true);
    expect(st(null)).toMatchObject({ ok: false, code: "bad_fields" });
    // A prompt's files follow the same rules.
    const pr = (files: unknown) => parseCommand(commandStr({ files }));
    expect(pr([f]).ok).toBe(true);
    expect(pr([])).toMatchObject({ ok: false, code: "bad_fields", why: "files is a list of 1 to 10 files" });
    expect(pr([f, { ...f, name: "A.PNG" }])).toMatchObject({ ok: false, why: "two files have the same name" });
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
    // Under the machine's home, as events write a folder: never another user's.
    for (const cwd of ["~", "~/x", "~\\x"]) expect(code({ kind: "start", cwd }), cwd).toBe("ok");
    for (const cwd of ["~root/x", "~x", "x/~"])
      expect(code({ kind: "start", cwd }), cwd).toMatch(/^bad_fields: .*under ~/);
    expect(code({ kind: "start", text: undefined, cwd: "/x" })).toMatch(/^bad_fields: a new session needs text/);
    expect(code({ kind: "start", cwd: "rel" })).toMatch(/^bad_fields: .*absolute folder/);
    expect(code({ kind: "start" })).toMatch(/^bad_fields: .*absolute folder/);
    expect(code({ kind: "start", cwd: "/x", for: "a" })).toBe(
      "bad_fields: a start carries text, cwd, files, a permission and a model",
    );
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

  const START = { kind: "start", session: "codex:0199a", cwd: "/w" };
  it("start options: a permission of the four levels, a model as one safe argument", () => {
    for (const permission of START_PERMISSIONS) expect(code({ ...START, permission })).toBe("ok");
    for (const permission of ["full", "bypassPermissions", "default", "", null, 3, ["auto"]])
      expect(code({ ...START, permission })).toBe("bad_fields: a permission is one of read, safe, edits, auto");
    for (const model of ["sonnet", "gpt-5.6-sol", "claude-opus-4-1@20250805", "opus[1m]", "us.anthropic/x:1", "a"])
      expect(code({ ...START, model })).toBe("ok");
    expect(code({ ...START, model: "m".repeat(MODEL_MAX) })).toBe("ok");
    for (const model of [
      "",
      "-m",
      "--dangerously-skip-permissions",
      "a b",
      "a;b",
      "a\nb",
      "m".repeat(MODEL_MAX + 1),
      7,
    ])
      expect(code({ ...START, model })).toMatch(/^bad_fields: a model is 1 to 100 /);
    expect(MODEL_RE.test(".hidden")).toBe(false);
  });

  it("levels rank narrowest first, and nothing ranks above auto", () => {
    expect(START_PERMISSIONS.map(levelRank)).toEqual([0, 1, 2, 3]);
    expect(levelRank("bypassPermissions")).toBe(-1);
    expect(narrower("auto", "safe")).toBe("safe");
    expect(narrower("read", "auto")).toBe("read");
    expect(narrower("edits", "edits")).toBe("edits");
  });

  // Each kind's own fields, beside the common ones (CONTROL.md §3.1). Adding a field to
  // a kind later is one entry here, and every other kind is checked to refuse it.
  const KINDS: Record<string, { base: Record<string, unknown>; own: Record<string, unknown> }> = {
    prompt: {
      base: {},
      own: { text: "hi", files: [{ name: "a.png", type: "image/png", size: 1, sha256: "A".repeat(43) }] },
    },
    "permission.answer": {
      base: { text: undefined, for: "a", decision: "deny" },
      own: { for: "a", decision: "allow" },
    },
    cancel: { base: { text: undefined }, own: {} },
    start: {
      base: START,
      own: {
        text: "hi",
        cwd: "/w",
        files: [{ name: "a.png", type: "image/png", size: 1, sha256: "A".repeat(43) }],
        permission: "read",
        model: "sonnet",
      },
    },
    "key.add": {
      base: { session: KEY_STORE_SESSION, text: undefined, key: { id: "a".repeat(20), alg: -7, spki: "b".repeat(50) } },
      own: { name: "iPhone" },
    },
  };
  const OPTIONAL_ELSEWHERE = { files: [], permission: "safe", model: "sonnet", key: {}, name: "x", cwd: "/w" };
  it("each kind carries its own fields, the common ones and nothing else", () => {
    for (const [kind, { base, own }] of Object.entries(KINDS)) {
      expect(code({ kind, ...base, ...own, note: "why" }), kind).toBe("ok");
      // Any field the spec doesn't list, on every kind.
      for (const stray of ["sandbox", "permissions", "Model", "__proto__", "x".repeat(60)])
        expect(code({ kind, ...base, [stray]: "off" }), `${kind} ${stray}`).toMatch(
          /^bad_fields: (the command carries a field its kind doesn't have: |a |only )/,
        );
      // Another kind's field.
      for (const [f, v] of Object.entries(OPTIONAL_ELSEWHERE))
        if (!(f in own) && !(f in base)) expect(code({ kind, ...base, [f]: v }), `${kind} ${f}`).toMatch(/^bad_fields/);
    }
    expect(code({ ...START, sandbox: "off" })).toBe(
      "bad_fields: the command carries a field its kind doesn't have: sandbox",
    );
    expect(code({ ...START, ["y".repeat(60)]: 1 })).toBe(
      `bad_fields: the command carries a field its kind doesn't have: ${"y".repeat(40)}`,
    );
    expect(code({ permission: "safe" })).toBe("bad_fields: only a start carries a model or a permission");
    expect(code({ kind: "cancel", text: undefined, model: "sonnet" })).toBe(
      "bad_fields: only a start carries a model or a permission",
    );
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
    expect(await verifyAssertion(challenge, good, pk.key, RP, "confirm")).toEqual({ ok: true });
    expect(await verifyAssertion(challenge, null, pk.key, RP, "confirm")).toMatchObject({
      ok: false,
      why: "no passkey signature",
    });
    const enc = new TextEncoder();
    for (const cd of ["null", '"s"', "7"])
      expect(
        await verifyAssertion(challenge, { ...good, cd: b64url(enc.encode(cd)) }, pk.key, RP, "confirm"),
      ).toMatchObject({
        ok: false,
        why: "the passkey signature is malformed",
      });
    expect(
      await verifyAssertion(challenge, { ...good, ad: b64url(new Uint8Array(10)) }, pk.key, RP, "confirm"),
    ).toMatchObject({
      ok: false,
      why: "the passkey signature is malformed",
    });
    expect(await verifyAssertion(challenge, good, { ...pk.key, alg: 0 }, RP, "confirm")).toMatchObject({
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

describe("device keys (CONTROL.md §2, §3.2)", () => {
  const dec = new TextDecoder();
  const ch = new Uint8Array(32).map((_, i) => i * 7 + 1);

  it("deviceMessage: the exact bytes, four lines, no trailing newline, base64url without padding", () => {
    const m = deviceMessage("grant", "studio-mac.local", ch);
    expect(dec.decode(m)).toBe(`sessionpipe.device.v1\ngrant\nstudio-mac.local\n${b64url(ch)}`);
    expect(DEVICE_CONTEXT).toBe("sessionpipe.device.v1");
    expect(b64url(ch)).toHaveLength(43);
    expect(dec.decode(m).endsWith("\n")).toBe(false);
    expect(dec.decode(m)).not.toMatch(/[=+/]/);
    // A pinned challenge, so another implementation can compare bytes.
    expect(Array.from(deviceMessage("pair", "localhost", new Uint8Array(32)))).toEqual(
      Array.from(
        new TextEncoder().encode("sessionpipe.device.v1\npair\nlocalhost\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
      ),
    );
    expect(KEY_TYPES).toEqual(["passkey", "device"]);
  });

  it("deviceKeyId: the SPKI bytes' SHA-256, base64url, 43 characters", async () => {
    const d = await DeviceKeySim.create();
    const spki = fromB64url(d.key.spki)!;
    expect(await deviceKeyId(d.key.spki)).toBe(b64url(await sha256(spki)));
    expect(d.key.id).toHaveLength(43);
    expect(d.key.id).toBe(await deviceKeyId(d.key.spki));
    // An SPKI that isn't base64url is no bytes: its id is the empty hash, which no key has.
    expect(await deviceKeyId("not base64url!")).toBe(b64url(await sha256(new Uint8Array())));
    expect(await keyUsable({ ...d.key, spki: "not base64url!", id: await deviceKeyId("not base64url!") })).toBe(false);
  });

  it("keyUsable: a device key's exact rules, and closed fields for both kinds", async () => {
    const d = await DeviceKeySim.create();
    const pk = await Passkey.create();
    const rsa = await Passkey.create({ alg: RS256 });
    expect(await keyUsable(d.key)).toBe(true);
    expect(await keyUsable(pk.key)).toBe(true);
    const bad = (k: object) => keyUsable(k as never);
    expect(await bad({ ...d.key, store: "software" })).toBe(false);
    expect(await bad({ ...d.key, uv: "once" })).toBe(false);
    expect(await bad({ ...d.key, type: "tpm" })).toBe(false);
    expect(await bad({ ...d.key, alg: RS256 })).toBe(false);
    expect(await bad({ ...d.key, id: pk.key.id })).toBe(false); // not its SPKI's hash
    expect(await bad({ ...d.key, id: await deviceKeyId(pk.key.spki), spki: pk.key.spki })).toBe(true); // any P-256
    expect(
      await bad({ ...rsa.key, id: await deviceKeyId(rsa.key.spki), type: "device", store: "hardware", uv: "each-use" }),
    ).toBe(false);
    expect(await bad({ ...d.key, name: "Mac" })).toBe(false); // closed
    const { store: _s, ...noStore } = d.key;
    expect(await bad(noStore)).toBe(false);
    expect(await bad({ ...pk.key, store: "hardware" })).toBe(false); // a passkey carries none of them
    expect(await bad({ ...pk.key, uv: "each-use" })).toBe(false);
    expect(await bad({ ...pk.key, extra: 1 })).toBe(false);
    expect(await bad({ ...pk.key, type: undefined })).toBe(true); // absent is absent
    expect(await bad([])).toBe(false);
  });

  it("verifyAssertion dispatches on the machine's record of the key, for each purpose", async () => {
    const d = await DeviceKeySim.create({ rpId: RP });
    for (const purpose of ["grant", "confirm", "pair"] as const) {
      const s = await d.sign(purpose, ch);
      expect(await verifyAssertion(ch, s, d.key, RP, purpose)).toEqual({ ok: true });
      for (const other of ["grant", "confirm", "pair"] as const)
        if (other !== purpose) expect((await verifyAssertion(ch, s, d.key, RP, other)).ok).toBe(false);
      // The same signature counts through no other rp id.
      expect((await verifyAssertion(ch, s, d.key, "evil.example", purpose)).ok).toBe(false);
    }
    const g = { ...(await d.sign("grant", ch)), str: "{}" };
    expect(await verifyAssertion(ch, g, d.key, RP, "grant")).toEqual({ ok: true });
    expect(await verifyAssertion(ch, g, d.key, RP, "confirm")).toMatchObject({
      why: "a device key's signature carries no str",
    });
    const s = await d.sign("confirm", ch);
    expect(await verifyAssertion(ch, { ...s, ad: "AAAA", cd: "AAAA" } as never, d.key, RP, "confirm")).toMatchObject({
      why: "a device key's signature carries no ad",
    });
    expect(await verifyAssertion(ch, { ...s, cred: "x" }, d.key, RP, "confirm")).toMatchObject({
      why: "signed with a key this machine doesn't trust",
    });
    expect(await verifyAssertion(ch, await d.sign("confirm", ch, { der: true }), d.key, RP, "confirm")).toMatchObject({
      why: "a device key's signature is 64 bytes, r‖s",
    });
    expect(await verifyAssertion(ch, await d.sign("confirm", ch, { raw: ch }), d.key, RP, "confirm")).toMatchObject({
      why: "the device key's signature doesn't verify",
    });
    // A record that says device but breaks a rule verifies nothing.
    expect(await verifyAssertion(ch, s, { ...d.key, store: "software" } as never, RP, "confirm")).toMatchObject({
      why: "a trusted key is unusable",
    });
    expect(await verifyAssertion(ch, s, { ...d.key, type: "tpm" } as never, RP, "confirm")).toMatchObject({
      why: "a trusted key is unusable",
    });
    // Bookkeeping beside a stored record (a name, when it was added) doesn't matter.
    expect(await verifyAssertion(ch, s, { ...d.key, name: "Mac", added_at: "x" } as never, RP, "confirm")).toEqual({
      ok: true,
    });
    // The same key stored without its type (an old daemon's record): a passkey, so no.
    const { type: _t, store: _s, uv: _u, ...asPasskey } = d.key;
    expect(await verifyAssertion(ch, s, asPasskey, RP, "confirm")).toMatchObject({
      why: "the passkey signature is malformed",
    });
    // A passkey assertion is never read as a device signature, nor the other way round.
    const pk = await Passkey.create({ rpId: RP });
    expect((await verifyAssertion(ch, { cred: pk.key.id, sig: s.sig }, pk.key, RP, "confirm")).ok).toBe(false);
  });

  it("verifyCommand: a device key's grant and confirm, and the key.add gate", async () => {
    const d = await DeviceKeySim.create({ rpId: RP });
    const pk = await Passkey.create({ rpId: RP });
    const day = await DayKey.create();
    const o = { machine: MACHINE, rpId: RP, trusted: [d.key, pk.key], now: T + 60_000 };
    expect(await verifyCommand(await deviceSigned(d, day, commandStr({})), o)).toMatchObject({
      ok: true,
      via: "grant",
      key: d.key.id,
    });
    expect(await verifyCommand(await deviceSigned(d, day, commandStr({}), { confirm: true }), o)).toMatchObject({
      ok: true,
      via: "confirm",
    });
    const addCmd = (key: object) =>
      commandStr({ kind: "key.add", session: KEY_STORE_SESSION, text: undefined, key, name: "iPhone" });
    const phone = await DeviceKeySim.create({ rpId: RP });
    expect(await verifyCommand(await signed(pk, day, addCmd(phone.key)), o)).toMatchObject({ ok: true });
    // An SPKI nobody can import, signed by a trusted key: refused, nothing to store.
    const junk = { id: "AAAAAAAAAAAAAAAAAAAAAA", alg: -7, spki: "A".repeat(91) };
    expect(await verifyCommand(await signed(pk, day, addCmd(junk)), o)).toMatchObject({
      ok: false,
      code: "bad_fields",
      why: "the key a key.add brings is in a shape this machine can't use",
    });
    // A device key whose id isn't its SPKI's hash passes the shape and fails the gate.
    expect(
      await verifyCommand(await signed(pk, day, addCmd({ ...phone.key, id: b64url(new Uint8Array(32)) })), o),
    ).toMatchObject({
      ok: false,
      code: "bad_fields",
    });
    // The gate runs only after the signature: an unsigned one is still unsigned.
    expect(await verifyCommand({ cmd: addCmd(junk) }, o)).toMatchObject({ ok: false, code: "unsigned" });
  });

  it("parseCommand: the device key shape in a key.add", async () => {
    const d = await DeviceKeySim.create();
    const add = (key: object) =>
      parseCommand(commandStr({ kind: "key.add", session: KEY_STORE_SESSION, text: undefined, key, nonce: nonce() }));
    const why = (key: object) => {
      const p = add(key);
      return p.ok ? "ok" : `${p.code}: ${p.why}`;
    };
    expect(why(d.key)).toBe("ok");
    expect(why({ ...d.key, type: "tpm" })).toBe("bad_fields: a key's type is device, or absent for a passkey");
    expect(why({ ...d.key, store: "software" })).toMatch(/^bad_fields: a device key is ES256/);
    expect(why({ ...d.key, uv: "once" })).toMatch(/^bad_fields: a device key is ES256/);
    expect(why({ ...d.key, alg: -257 })).toMatch(/^bad_fields: a device key is ES256/);
    expect(why({ ...d.key, id: "AAAAAAAAAAAAAAAAAAAAAA" })).toMatch(/^bad_fields: a device key is ES256/);
    expect(why({ ...d.key, name: "x" })).toBe("bad_fields: a device key carries id, alg, spki, type, store and uv");
    const { type: _t, ...noType } = d.key;
    expect(why(noType)).toBe("bad_fields: a passkey carries id, alg and spki: store and uv belong to a device key");
    expect(why([])).toMatch(/^bad_fields: a key.add carries the key/);
  });

  it("verifyEnrollment: a device key proves itself for purpose pair, bound to machine, code and rp id", async () => {
    const d = await DeviceKeySim.create({ rpId: RP });
    const e = (proof: object, key = d.key, rpId = RP) =>
      verifyEnrollment({ machine: MACHINE, code: "123456", key, proof: proof as never, rpId });
    expect(await e(await d.enroll(MACHINE, "123456"))).toEqual({ ok: true });
    expect((await e(await d.enroll(MACHINE, "654321"))).ok).toBe(false);
    expect((await e(await d.enroll("m_anothermachine00000001", "123456"))).ok).toBe(false);
    expect((await e(await d.enroll(MACHINE, "123456"), d.key, "other.example")).ok).toBe(false);
    expect((await e(await d.enroll(MACHINE, "123456", { purpose: "confirm" }))).ok).toBe(false);
    expect((await e({ ...(await d.enroll(MACHINE, "123456")), ad: "AAAA" })).ok).toBe(false);
    expect((await e(await d.enroll(MACHINE, "123456"), { ...d.key, store: "software" } as never)).ok).toBe(false);
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
          m.grant = { ...m.grant!, ...mutateAssertion(m.grant as GrantBundle) };
          break;
        case "confirm":
          m.confirm = mutateAssertion(m.confirm as Assertion);
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
  return {
    csig: d(s.csig),
    grant: s.grant ? { str: s.grant.str, ...a(s.grant as GrantBundle) } : null,
    confirm: a(s.confirm as Assertion | null),
  };
}
