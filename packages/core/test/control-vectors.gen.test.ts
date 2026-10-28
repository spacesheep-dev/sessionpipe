// SPDX-License-Identifier: Apache-2.0
// Writes conformance/control-vectors/*.json: signed control commands, valid and
// broken, with the verdict every verifier must reach (CONTROL.md §5). Signatures are
// random, so the files are generated once and committed; `npm run vectors`
// (SESSIONPIPE_WRITE_VECTORS=1) writes the ones that aren't there yet and keeps every
// file already written, so a new vector never churns the others' signatures;
// SESSIONPIPE_WRITE_VECTORS=all rewrites them all. control-vectors.test.ts checks them
// on every run. Test keys only: made fresh here, only their public halves are written.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import {
  type Assertion,
  b64url,
  CMD_MAX,
  type DeviceSignature,
  FILE_NAME_MAX,
  FILE_SIZE_MAX,
  FILES_MAX,
  fromB64url,
  MODEL_MAX,
  POOL_CODE_MAX,
  POOL_ORDER_MAX,
  POOL_SESSION,
  RECEIVER_MAX_AGE_MS,
  RS256,
  type SignedCommand,
  sha256,
  TEXT_MAX,
  type TrustedKey,
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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dir = path.join(root, "conformance/control-vectors");
const WRITE = process.env.SESSIONPIPE_WRITE_VECTORS === "1" || process.env.SESSIONPIPE_WRITE_VECTORS === "all";
const REWRITE = process.env.SESSIONPIPE_WRITE_VECTORS === "all";
/** Numbers another open change holds, skipped here so the two never collide: none now
 *  (90, `start-acp-harness`, landed with ACP control). */
const RESERVED = new Set<number>();

const RP = "receiver.example";
const T = 1_790_800_000_000; // the command's iat in every vector unless it says otherwise
const H = 3600_000;

interface Vector {
  name: string;
  description: string;
  input: {
    signed: SignedCommand;
    machine: string;
    rp_id: string;
    trusted: TrustedKey[];
    now: number;
    max_age_ms?: number;
    seen_nonces?: string[];
  };
  expect: { ok: true; via: "grant" | "confirm"; kind: string } | { ok: false; code: string };
}
interface EnrollVector {
  name: string;
  description: string;
  input: { machine: string; code: string; key: TrustedKey; proof: Assertion | DeviceSignature; rp_id: string };
  expect: { ok: boolean };
}

describe.runIf(WRITE)("write control vectors", () => {
  it("writes conformance/control-vectors", async () => {
    const pk = await Passkey.create({ rpId: RP });
    const other = await Passkey.create({ rpId: RP });
    const rsa = await Passkey.create({ rpId: RP, alg: RS256 });
    const local = await Passkey.create({ rpId: "localhost", origin: "http://localhost:8891" });
    const day = await DayKey.create();
    const day2 = await DayKey.create();
    const trusted = [pk.key];
    const base = (extra: Partial<Vector["input"]> = {}) => ({
      machine: MACHINE,
      rp_id: RP,
      trusted,
      now: T + 60_000,
      ...extra,
    });
    const out: Vector[] = [];
    const ok = (
      name: string,
      description: string,
      s: SignedCommand,
      via: "grant" | "confirm",
      kind: string,
      extra = {},
    ) => out.push({ name, description, input: { signed: s, ...base(extra) }, expect: { ok: true, via, kind } });
    const refuse = (name: string, description: string, s: SignedCommand, code: string, extra = {}) =>
      out.push({ name, description, input: { signed: s, ...base(extra) }, expect: { ok: false, code } });

    // --- valid ---
    const c1 = commandStr({});
    ok(
      "valid-grant-prompt",
      "A prompt signed by a day key under a grant from a trusted passkey.",
      await signed(pk, day, c1),
      "grant",
      "prompt",
    );
    ok(
      "valid-confirm-prompt",
      "A prompt confirmed by one passkey assertion over sha256(cmd).",
      await signed(pk, day, commandStr({}), { confirm: true }),
      "confirm",
      "prompt",
    );
    const pa = commandStr({
      kind: "permission.answer",
      text: undefined,
      for: "perm-5f1c0e9a2b7d4c31",
      decision: "allow",
      note: "Fine, it's a test branch.",
    });
    ok(
      "valid-permission-answer",
      "An allow for an open permission attention, with a note.",
      await signed(pk, day, pa),
      "grant",
      "permission.answer",
    );
    const st = commandStr({
      kind: "start",
      session: "claude-code:0b6f2c7e-3d4a-4f1b-9c8e-2a1d5e6f7a8b",
      cwd: "/Users/misha/spacesheep",
      text: "Fix the flaky test",
    });
    ok(
      "valid-start",
      "Start a new Claude Code session with a fresh UUID in an absolute folder.",
      await signed(pk, day, st),
      "grant",
      "start",
    );
    const cc = commandStr({ kind: "cancel", text: undefined });
    ok("valid-cancel", "A cancel carries nothing but the session.", await signed(pk, day, cc), "grant", "cancel");
    // A device the machine trusts vouches for a new one (CONTROL.md §2): key.add.
    const phone = await Passkey.create({ rpId: RP, origin: `https://${RP}` });
    const ka = commandStr({
      kind: "key.add",
      session: "sessionpipe:keys",
      text: undefined,
      key: phone.key,
      name: "iPhone",
    });
    ok(
      "valid-key-add",
      "A trusted passkey vouches for a new device's passkey.",
      { cmd: ka, confirm: await pk.assert(await sha256(ka)) },
      "confirm",
      "key.add",
    );
    const rs = commandStr({});
    out.push({
      name: "valid-rs256-passkey",
      description: "A grant from an RS256 passkey (Windows Hello).",
      input: { signed: await signed(rsa, day, rs), ...base({ trusted: [rsa.key] }) },
      expect: { ok: true, via: "grant", kind: "prompt" },
    });
    const lid = commandStr({});
    ok(
      "valid-lid-shut-23h",
      "Signed 23 hours before the machine woke: the machine judges by signing time.",
      await signed(pk, day, lid),
      "grant",
      "prompt",
      { now: T + 23 * H },
    );
    const t4 = commandStr({ text: "x".repeat(TEXT_MAX) });
    ok("valid-text-at-limit", `Text of exactly ${TEXT_MAX} characters.`, await signed(pk, day, t4), "grant", "prompt");
    const cx = commandStr({ session: "codex:01999a7c-1f2e-7b3a-9c4d-5e6f7a8b9c0d" });
    ok(
      "valid-other-harness",
      "A prompt for a Codex session: the id rule is the adapter's.",
      await signed(pk, day, cx),
      "grant",
      "prompt",
    );
    const lc = commandStr({});
    out.push({
      name: "valid-localhost-http",
      description: "rp id localhost: a plain-http origin on any port is allowed.",
      input: { signed: await signed(local, day, lc), ...base({ rp_id: "localhost", trusted: [local.key] }) },
      expect: { ok: true, via: "grant", kind: "prompt" },
    });
    {
      const c = commandStr({});
      const badGrant = await day.grant(other, { iat: T - 60_000, exp: T + H });
      const s = { cmd: c, csig: await day.sign(c), grant: badGrant, confirm: await pk.assert(await sha256(c)) };
      ok(
        "valid-confirm-beside-bad-grant",
        "The grant path fails (untrusted passkey) but the confirm verifies: either path is enough.",
        s,
        "confirm",
        "prompt",
      );
    }
    {
      const c = commandStr({});
      ok(
        "valid-grant-iat-skew",
        "Signed 4 minutes before its grant began (inside the 5-minute clock skew).",
        await signed(pk, day, c, { grantIat: T + 4 * 60_000 }),
        "grant",
        "prompt",
      );
    }

    // --- signing time ---
    refuse(
      "too-old-machine",
      "Signed 24 h and 1 s before the machine read it.",
      await signed(pk, day, commandStr({})),
      "too_old",
      { now: T + 24 * H + 1000 },
    );
    refuse(
      "too-old-receiver",
      "A receiver's early check allows ten minutes.",
      await signed(pk, day, commandStr({})),
      "too_old",
      { now: T + 11 * 60_000, max_age_ms: RECEIVER_MAX_AGE_MS },
    );
    refuse(
      "future",
      "Dated six minutes ahead of the machine's clock.",
      await signed(pk, day, commandStr({})),
      "future",
      { now: T - 6 * 60_000 },
    );

    // --- who it's for ---
    refuse(
      "wrong-machine",
      "Signed for another machine.",
      await signed(pk, day, commandStr({ machine: "m_anothermachine00000001" })),
      "wrong_machine",
    );

    // --- tampering ---
    {
      const c = commandStr({});
      const s = await signed(pk, day, c);
      refuse(
        "tampered-text",
        "The text was changed after signing.",
        { ...s, cmd: c.replace("Add the Oct 8 row", "rm -rf ~") },
        "bad_csig",
      );
      refuse(
        "reserialized",
        "The same fields re-serialized with other whitespace: signatures cover the exact bytes.",
        { ...s, cmd: JSON.stringify(JSON.parse(c), null, 1) },
        "bad_csig",
      );
      refuse(
        "csig-by-other-key",
        "A grant from a trusted passkey, but the command is signed by another day key.",
        { ...s, csig: await day2.sign(c) },
        "bad_csig",
      );
      refuse("csig-der", "The command signature in DER instead of raw r‖s.", { ...s, csig: `${s.csig}AA` }, "bad_csig");
      refuse(
        "csig-without-grant",
        "A day-key signature with no grant is not a signature anyone vouched for.",
        { cmd: c, csig: s.csig ?? null },
        "unsigned",
      );
      refuse("unsigned", "No grant, no confirm.", { cmd: c }, "unsigned");
    }
    {
      const c = commandStr({});
      const s = await signed(pk, day, c);
      refuse("replay", "The nonce was seen before on this machine.", s, "replay", {
        seen_nonces: [JSON.parse(c).nonce],
      });
    }

    // --- the grant ---
    refuse(
      "untrusted-passkey",
      "The grant comes from a passkey never enrolled on this machine.",
      await signed(other, day, commandStr({})),
      "untrusted_key",
    );
    {
      const c = commandStr({});
      const g = await day.grant(pk, { iat: T - 60_000, exp: T + H, rp: "evil.example" });
      refuse(
        "grant-wrong-rp",
        "The grant names another rp id.",
        { cmd: c, csig: await day.sign(c), grant: g },
        "bad_grant",
      );
    }
    {
      const c = commandStr({});
      const g = await day.grant(pk, { iat: T - 60_000, exp: T - 60_000 + 25 * H });
      refuse(
        "grant-longer-than-a-day",
        "A grant that lasts 25 hours.",
        { cmd: c, csig: await day.sign(c), grant: g },
        "bad_grant",
      );
    }
    {
      const c = commandStr({});
      const str = day.grantStr({ iat: T - 60_000, exp: T + H, rp: RP, t: "ss-machine-grant" });
      const g = await day.grant(pk, { iat: 0, exp: 0, str });
      refuse(
        "grant-old-type",
        "spacesheep's pre-sessionpipe grant type is not a sessionpipe grant.",
        { cmd: c, csig: await day.sign(c), grant: g },
        "bad_grant",
      );
    }
    {
      const c = commandStr({ iat: T + 13 * H });
      refuse(
        "outside-grant",
        "Signed an hour after its 12-hour grant ended.",
        await signed(pk, day, c, { grantIat: T - 60_000, grantExp: T + 12 * H }),
        "outside_grant",
        { now: T + 13 * H + 60_000 },
      );
    }
    {
      const c = commandStr({});
      refuse(
        "grant-before-start",
        "Signed 6 minutes before its grant began.",
        await signed(pk, day, c, { grantIat: T + 6 * 60_000 }),
        "outside_grant",
      );
    }
    const withAssert = async (assert: Parameters<Passkey["assert"]>[1]) => {
      const c = commandStr({});
      const g = await day.grant(pk, { iat: T - 60_000, exp: T + H, assert });
      return { cmd: c, csig: await day.sign(c), grant: g };
    };
    refuse(
      "grant-no-user-verification",
      "The passkey signed with the person present but not verified (no Touch ID / PIN).",
      await withAssert({ flags: 0x01 }),
      "bad_assertion",
    );
    refuse(
      "grant-wrong-origin",
      "The passkey was used on another site.",
      await withAssert({ origin: "https://evil.example" }),
      "bad_assertion",
    );
    refuse(
      "grant-lookalike-origin",
      "An origin that ends in the rp id without being a subdomain.",
      await withAssert({ origin: "https://notreceiver.example" }),
      "bad_assertion",
    );
    refuse(
      "grant-http-origin",
      "Plain http on a non-localhost rp id.",
      await withAssert({ origin: `http://${RP}` }),
      "bad_assertion",
    );
    refuse(
      "grant-rp-hash",
      "authenticatorData carries another rp id's hash.",
      await withAssert({ adRpId: "evil.example" }),
      "bad_assertion",
    );
    refuse(
      "grant-cross-origin",
      "The passkey was used inside another site's frame.",
      await withAssert({ crossOrigin: true }),
      "bad_assertion",
    );
    refuse(
      "grant-create-ceremony",
      "clientData from a registration, not an assertion.",
      await withAssert({ type: "webauthn.create" }),
      "bad_assertion",
    );
    {
      // The same r‖s under a DER wrapper whose length byte lies (found by the fuzz in
      // control-verify.test.ts): one signature has exactly one encoding.
      const s = await withAssert({});
      const der = fromB64url(s.grant.sig)!;
      der[1] = (der[1] as number) + 3;
      refuse(
        "grant-sig-der-length",
        "The passkey signature's DER length byte doesn't match its bytes.",
        { ...s, grant: { ...s.grant, sig: b64url(der) } },
        "bad_assertion",
      );
    }
    {
      const c = commandStr({});
      const s = { cmd: c, confirm: await pk.assert(await sha256(commandStr({}))) };
      refuse("confirm-over-other-command", "A passkey confirm made for a different command.", s, "bad_assertion");
    }

    // --- shape ---
    const shape = async (name: string, description: string, fields: Record<string, unknown>, code: string) =>
      refuse(name, description, await signed(pk, day, commandStr(fields)), code);
    await shape(
      "nonce-too-short",
      "A nonce of 21 characters (under 16 random bytes).",
      { nonce: nonce(15).slice(0, 21) },
      "bad_nonce",
    );
    await shape("nonce-too-long", "A nonce of 65 characters.", { nonce: "a".repeat(65) }, "bad_nonce");
    await shape(
      "nonce-bad-alphabet",
      "A nonce with a character outside base64url.",
      { nonce: `${"a".repeat(21)}+` },
      "bad_nonce",
    );
    await shape(
      "text-too-long",
      `Text of ${TEXT_MAX + 1} characters.`,
      { text: "x".repeat(TEXT_MAX + 1) },
      "bad_fields",
    );
    await shape("text-blank", "A prompt of only whitespace.", { text: "   " }, "bad_fields");
    await shape(
      "claude-session-not-uuid",
      "Claude Code session ids are UUIDs.",
      { session: "claude-code:not-a-uuid" },
      "bad_session",
    );
    await shape(
      "session-no-harness",
      "A bare session id with no harness.",
      { session: "8c132906-8c3f-4814-870a-afc3d05e1d2e" },
      "bad_session",
    );
    await shape("unknown-kind", "A kind the spec does not define.", { kind: "shell" }, "unknown_kind");
    await shape("old-type", "spacesheep's pre-sessionpipe command type.", { t: "ss-machine-cmd" }, "not_a_command");
    await shape(
      "permission-answer-no-for",
      "An answer that names no attention.",
      { kind: "permission.answer", text: undefined, decision: "allow" },
      "bad_fields",
    );
    await shape(
      "permission-answer-maybe",
      "A decision that is neither allow nor deny.",
      { kind: "permission.answer", text: undefined, for: "perm-1", decision: "maybe" },
      "bad_fields",
    );
    await shape("prompt-with-decision", "A prompt carrying a decision.", { decision: "allow" }, "bad_fields");
    await shape(
      "start-relative-cwd",
      "A new session in a relative folder.",
      { kind: "start", cwd: "spacesheep" },
      "bad_fields",
    );
    ok(
      "start-other-harness",
      "A new Codex session: any harness the machine can drive may be started (the harness picks its own id; the machine keeps this one as its name).",
      await signed(pk, day, commandStr({ kind: "start", session: "codex:0199a", cwd: "/tmp" })),
      "grant",
      "start",
    );
    await shape("cancel-with-text", "A cancel carrying text.", { kind: "cancel" }, "bad_fields");
    const someKey = { id: "AAAAAAAAAAAAAAAAAAAAAA", alg: -7, spki: "A".repeat(91) };
    await shape(
      "key-add-no-key",
      "A key.add that names no key.",
      { kind: "key.add", session: "sessionpipe:keys", text: undefined },
      "bad_fields",
    );
    await shape(
      "key-add-coding-session",
      "A key.add must name the key store, not a coding session.",
      { kind: "key.add", text: undefined, key: someKey },
      "bad_session",
    );
    await shape(
      "key-add-bad-alg",
      "A key.add with an algorithm the spec doesn't allow.",
      { kind: "key.add", session: "sessionpipe:keys", text: undefined, key: { ...someKey, alg: -8 } },
      "bad_fields",
    );
    await shape("prompt-with-key", "Only a key.add carries a key.", { key: someKey }, "bad_fields");
    await shape("iat-not-integer", "A signing time that isn't an integer.", { iat: T + 0.5 }, "malformed");
    {
      const c = commandStr({ pad: "x".repeat(CMD_MAX) });
      refuse("command-too-long", `A command string over ${CMD_MAX} characters.`, await signed(pk, day, c), "malformed");
    }
    refuse("not-json", "A command that is not JSON.", { cmd: "{v:1}", csig: "", grant: null }, "malformed");

    // --- enrollment ---
    const code = "K7Q2-9XMV";
    const enroll: EnrollVector[] = [
      {
        name: "enroll-valid",
        description: 'A passkey proves itself over sha256("sessionpipe.pair:<machine>:<code>").',
        input: { machine: MACHINE, code, key: pk.key, proof: await pk.enroll(MACHINE, code), rp_id: RP },
        expect: { ok: true },
      },
      {
        name: "enroll-other-code",
        description: "A proof made for another pairing code.",
        input: { machine: MACHINE, code, key: pk.key, proof: await pk.enroll(MACHINE, "AAAA-BBBB"), rp_id: RP },
        expect: { ok: false },
      },
      {
        name: "enroll-other-machine",
        description: "A proof made for another machine.",
        input: {
          machine: MACHINE,
          code,
          key: pk.key,
          proof: await pk.enroll("m_anothermachine00000001", code),
          rp_id: RP,
        },
        expect: { ok: false },
      },
      {
        name: "enroll-key-swap",
        description: "The receiver hands over one key with another key's proof.",
        input: { machine: MACHINE, code, key: other.key, proof: await pk.enroll(MACHINE, code), rp_id: RP },
        expect: { ok: false },
      },
    ];

    // --- attachments on a start (written after the enrollment vectors, so the
    // numbers of the vectors above never move) ---
    const split = out.length;
    const NEW = "claude-code:0b6f2c7e-3d4a-4f1b-9c8e-2a1d5e6f7a8b";
    const hashOf = async (s: string) => b64url(await sha256(s));
    const png = { name: "screenshot.png", type: "image/png", size: 183_402, sha256: await hashOf("png bytes") };
    const pdf = { name: "notes.pdf", type: "application/pdf", size: 1_258_291, sha256: await hashOf("pdf bytes") };
    const start = (files: unknown, extra: Record<string, unknown> = {}) =>
      commandStr({
        kind: "start",
        session: NEW,
        cwd: "/Users/misha/spacesheep",
        text: "What's wrong here?",
        files,
        ...extra,
      });
    const withFile = (f: Record<string, unknown>) => start([{ ...png, ...f }]);
    ok(
      "valid-start-with-files",
      "A new session with an image and a PDF attached, each named by its SHA-256.",
      await signed(pk, day, start([png, pdf])),
      "grant",
      "start",
    );
    {
      const big = (i: number) => ({
        name: `${String(i)}${"n".repeat(FILE_NAME_MAX - 5)}.bin`,
        type: "application/octet-stream",
        size: FILE_SIZE_MAX,
        sha256: png.sha256,
      });
      ok(
        "valid-files-at-limits",
        `Two files of exactly 25 MiB (50 MiB together), names of exactly ${FILE_NAME_MAX} characters.`,
        await signed(pk, day, start([big(1), big(2)])),
        "grant",
        "start",
      );
    }
    ok(
      "valid-ten-files",
      `${FILES_MAX} small files, a decomposed (NFD) name among them, types in any case.`,
      await signed(
        pk,
        day,
        start(
          Array.from({ length: FILES_MAX }, (_, i) => ({
            ...png,
            name: i === 0 ? "cafe\u0301.txt" : `page-${i}.PNG`,
            type: i === 0 ? "Text/Plain" : "image/png",
            size: 1,
          })),
        ),
      ),
      "grant",
      "start",
    );
    const fileShape = async (name: string, description: string, cmd: string) =>
      refuse(name, description, await signed(pk, day, cmd), "bad_fields");
    await fileShape(
      "files-on-permission-answer",
      "Only a start or a prompt may carry files.",
      commandStr({ kind: "permission.answer", text: undefined, for: "perm-1", decision: "deny", files: [png] }),
    );
    await fileShape("files-empty", "An empty list of files.", start([]));
    await fileShape("files-not-a-list", "files as an object.", start(png));
    await fileShape(
      "files-too-many",
      `${FILES_MAX + 1} files.`,
      start(Array.from({ length: FILES_MAX + 1 }, (_, i) => ({ ...png, name: `f${i}.png`, size: 1 }))),
    );
    await fileShape("file-name-slash", "A name with a slash.", withFile({ name: "img/screenshot.png" }));
    await fileShape("file-name-backslash", "A name with a backslash.", withFile({ name: "img\\screenshot.png" }));
    await fileShape("file-name-dotdot", "The name `..`.", withFile({ name: ".." }));
    await fileShape("file-name-dotfile", "A dotfile (`.env`).", withFile({ name: ".env" }));
    await fileShape("file-name-nul", "A name with a NUL.", withFile({ name: "a\u0000.png" }));
    await fileShape("file-name-control", "A name with a newline.", withFile({ name: "a\n.png" }));
    await fileShape("file-name-empty", "An empty name.", withFile({ name: "" }));
    await fileShape(
      "file-name-too-long",
      `A name of ${FILE_NAME_MAX + 1} characters.`,
      withFile({ name: `${"n".repeat(FILE_NAME_MAX - 3)}.png` }),
    );
    await fileShape("file-type-no-subtype", "A type that isn't type/subtype.", withFile({ type: "image" }));
    await fileShape("file-size-zero", "An empty file.", withFile({ size: 0 }));
    await fileShape("file-size-too-big", "A file of 25 MiB and one byte.", withFile({ size: FILE_SIZE_MAX + 1 }));
    await fileShape("file-size-not-integer", "A size that isn't an integer.", withFile({ size: 10.5 }));
    await fileShape("file-sha256-padded", "A sha256 in padded base64.", withFile({ sha256: `${png.sha256}=` }));
    await fileShape("file-sha256-hex", "A sha256 in hex.", withFile({ sha256: "ab".repeat(32) }));
    await fileShape("file-no-sha256", "A file with no hash.", withFile({ sha256: undefined }));
    await fileShape(
      "files-total-too-big",
      "Three files of 20 MiB: more than 50 MiB together.",
      start([1, 2, 3].map((i) => ({ ...png, name: `f${i}.png`, size: 20 * 1_048_576 }))),
    );
    await fileShape(
      "files-same-name",
      "Two files whose names differ only in case.",
      start([png, { ...pdf, name: "Screenshot.PNG" }]),
    );
    ok(
      "start-acp-harness",
      "A new session of an agent driven through ACP (goose): the harness name is the row in ADAPTERS.md, and whether this machine can start it is the daemon's to say (its hello's `harnesses`), never the verifier's.",
      await signed(pk, day, commandStr({ kind: "start", session: "goose:0199a", cwd: "/tmp" })),
      "grant",
      "start",
    );

    // --- a start's options and the closed field set (CONTROL.md §3.1), after the files ---
    const files = out.length;
    const NEW_CODEX = "codex:0199b6f2-7c1d-7e3a-9b4c-5d6e7f8a9b0c";
    ok(
      "valid-start-with-permission",
      "A new session at the safe level.",
      await signed(pk, day, start(undefined, { permission: "safe" })),
      "grant",
      "start",
    );
    ok(
      "valid-start-with-model",
      "A new session on a model the harness names (Claude Code's alias `sonnet`).",
      await signed(pk, day, start(undefined, { model: "sonnet" })),
      "grant",
      "start",
    );
    ok(
      "valid-start-with-everything",
      "A new Codex session read-only, on a model, with a file.",
      await signed(pk, day, start([png], { session: NEW_CODEX, permission: "read", model: "gpt-5.6-sol" })),
      "grant",
      "start",
    );
    {
      const head = "us.anthropic/claude-opus-4-1@20250805:v1[1m]-";
      ok(
        "valid-model-at-limit",
        `A model id of exactly ${MODEL_MAX} characters, using . / : @ [ ] and -.`,
        await signed(pk, day, start(undefined, { model: head + "x".repeat(MODEL_MAX - head.length) })),
        "grant",
        "start",
      );
    }
    const optionShape = async (name: string, description: string, cmd: string) =>
      refuse(name, description, await signed(pk, day, cmd), "bad_fields");
    await optionShape(
      "permission-unknown",
      "A level the spec doesn't define (`full`).",
      start(undefined, { permission: "full" }),
    );
    await optionShape(
      "permission-harness-name",
      "A harness's own mode name (`bypassPermissions`) instead of a level: there is no level above auto.",
      start(undefined, { permission: "bypassPermissions" }),
    );
    await optionShape("permission-not-string", "A permission of null.", start(undefined, { permission: null }));
    await optionShape("permission-on-prompt", "Only a start carries a permission.", commandStr({ permission: "safe" }));
    await optionShape(
      "permission-on-cancel",
      "Only a start carries a permission.",
      commandStr({ kind: "cancel", text: undefined, permission: "read" }),
    );
    await optionShape(
      "model-on-permission-answer",
      "Only a start carries a model.",
      commandStr({ kind: "permission.answer", text: undefined, for: "perm-1", decision: "deny", model: "sonnet" }),
    );
    await optionShape("model-empty", "An empty model.", start(undefined, { model: "" }));
    await optionShape(
      "model-leading-dash",
      "A model that would read as a flag (`--dangerously-skip-permissions`).",
      start(undefined, { model: "--dangerously-skip-permissions" }),
    );
    await optionShape(
      "model-too-long",
      `A model id of ${MODEL_MAX + 1} characters.`,
      start(undefined, { model: "m".repeat(MODEL_MAX + 1) }),
    );
    await optionShape(
      "model-bad-char",
      "A model id with a space and a semicolon (`sonnet; rm -rf ~`).",
      start(undefined, { model: "sonnet; rm -rf ~" }),
    );
    {
      const safe = start(undefined, { permission: "safe" });
      const s = await signed(pk, day, safe);
      refuse(
        "tampered-permission",
        "Signed at safe, carried at auto: the receiver changed the level after the device signed.",
        { ...s, cmd: safe.replace('"permission":"safe"', '"permission":"auto"') },
        "bad_csig",
      );
    }
    await optionShape(
      "start-unknown-field",
      'A field no kind has (`"sandbox":"off"`): the field set is closed, so a field a machine doesn\'t know is refused, never ignored.',
      start(undefined, { sandbox: "off" }),
    );
    ok(
      "valid-start-tilde-cwd",
      "A new session in `~/spacesheep`: the machine reads `~` under its own user's home, as events write a session's folder, so no receiver needs to know it.",
      await signed(pk, day, start(undefined, { cwd: "~/spacesheep" })),
      "grant",
      "start",
    );
    await shape(
      "start-tilde-user-cwd",
      "A new session in `~root/spacesheep`: only `~` alone or `~/…` is read under the machine's home, never another user's.",
      { kind: "start", cwd: "~root/spacesheep" },
      "bad_fields",
    );

    // --- files on a prompt (CONTROL.md §6 `prompt`) ---
    ok(
      "valid-prompt-with-files",
      "A message for a running session with a screenshot attached (to a machine whose hello says prompt_files).",
      await signed(pk, day, commandStr({ files: [png] })),
      "grant",
      "prompt",
    );
    await optionShape(
      "files-on-cancel",
      "Only a start or a prompt carries files.",
      commandStr({ kind: "cancel", text: undefined, files: [png] }),
    );

    // --- device keys (CONTROL.md §2, §3.2): 111–136, written last so no number moves ---
    const device: (Vector | EnrollVector)[] = [];
    {
      const dev = await DeviceKeySim.create({ rpId: RP });
      const both = [pk.key, dev.key];
      const dv = (
        name: string,
        description: string,
        s: SignedCommand,
        expect: Vector["expect"],
        extra: Partial<Vector["input"]> = {},
      ) => device.push({ name, description, input: { signed: s, ...base({ trusted: both, ...extra }) }, expect });
      const okv = (via: "grant" | "confirm", kind: string) => ({ ok: true as const, via, kind });
      const no = (code: string) => ({ ok: false as const, code });
      const grantWith = async (sign: Parameters<DeviceKeySim["sign"]>[2], extraGrant: object = {}) => {
        const c = commandStr({});
        const g = await day.deviceGrant(dev, { iat: T - 60_000, exp: T + H, sign });
        return { cmd: c, csig: await day.sign(c), grant: { ...g, ...extraGrant } };
      };

      dv(
        "valid-device-grant-prompt",
        "A prompt signed by a day key under a grant from an app's device key: its signature over sessionpipe.device.v1⏎grant⏎<rp id>⏎b64url(sha256(str)).",
        await deviceSigned(dev, day, commandStr({})),
        okv("grant", "prompt"),
      );
      dv(
        "valid-device-confirm-prompt",
        "A prompt confirmed by the device key's signature for purpose confirm over sha256(cmd).",
        await deviceSigned(dev, day, commandStr({}), { confirm: true }),
        okv("confirm", "prompt"),
      );
      {
        const phone = await Passkey.create({ rpId: RP });
        const c = commandStr({
          kind: "key.add",
          session: "sessionpipe:keys",
          text: undefined,
          key: phone.key,
          name: "iPhone",
        });
        dv(
          "valid-device-confirm-key-add",
          "The app's device key vouches for a phone's passkey, with a confirm.",
          await deviceSigned(dev, day, c, { confirm: true }),
          okv("confirm", "key.add"),
        );
      }
      const mac = await DeviceKeySim.create({ rpId: RP });
      const addDevice = (key: object) =>
        commandStr({ kind: "key.add", session: "sessionpipe:keys", text: undefined, key, name: "Mac app" });
      dv(
        "valid-key-add-device-key",
        "A trusted passkey's grant vouches for an app's device key: type, store and uv are inside the signed bytes.",
        await signed(pk, day, addDevice(mac.key)),
        okv("grant", "key.add"),
      );
      dv(
        "device-grant-other-rp",
        "The device key signed the grant with another rp id in its message (evil.example).",
        await grantWith({ rpId: "evil.example" }),
        no("bad_assertion"),
      );
      dv(
        "device-grant-signed-as-confirm",
        "The grant's signature was made for purpose confirm.",
        await grantWith({ purpose: "confirm" }),
        no("bad_assertion"),
      );
      {
        const c = commandStr({});
        dv(
          "device-confirm-signed-as-grant",
          "A confirm whose signature was made for purpose grant.",
          { cmd: c, confirm: await dev.sign("confirm", await sha256(c), { purpose: "grant" }) },
          no("bad_assertion"),
        );
      }
      {
        const c = commandStr({});
        const str = day.grantStr({ iat: T - 60_000, exp: T + H, rp: RP });
        dv(
          "device-grant-no-context",
          "The device key signed the bare sha256(str), with no context, purpose or rp id lines.",
          {
            cmd: c,
            csig: await day.sign(c),
            grant: { ...(await dev.sign("grant", new Uint8Array(), { raw: await sha256(str) })), str },
          },
          no("bad_assertion"),
        );
      }
      dv(
        "device-sig-der",
        "The device key's grant signature in DER instead of raw r‖s.",
        await grantWith({ der: true }),
        no("bad_assertion"),
      );
      {
        const s = await grantWith({});
        const pa = await pk.assert(await sha256(s.grant.str));
        dv(
          "device-assertion-with-ad-cd",
          "WebAuthn authenticatorData and clientDataJSON beside a device key's signature.",
          { ...s, grant: { ...s.grant, ad: pa.ad, cd: pa.cd } },
          no("bad_assertion"),
        );
      }
      {
        const c = commandStr({});
        const g = await day.grant(pk, { iat: T - 60_000, exp: T + H });
        dv(
          "passkey-assertion-without-ad-cd",
          "A device-shaped {cred, sig, str} grant from a key the machine holds as a passkey.",
          { cmd: c, csig: await day.sign(c), grant: { cred: g.cred, sig: g.sig, str: g.str } },
          no("bad_assertion"),
        );
      }
      {
        const { type: _t, store: _s, uv: _u, ...asPasskey } = dev.key;
        dv(
          "device-key-stored-as-passkey",
          "A valid device grant, but the machine's record of the key has no type (an old daemon's store): verified as a passkey, refused.",
          await deviceSigned(dev, day, commandStr({})),
          no("bad_assertion"),
          { trusted: [pk.key, asPasskey] },
        );
      }
      {
        const c = commandStr({});
        dv(
          "device-confirm-other-command",
          "A device confirm made for a different command.",
          { cmd: c, confirm: await dev.sign("confirm", await sha256(commandStr({}))) },
          no("bad_assertion"),
        );
      }
      {
        const c = commandStr({});
        const s = await deviceSigned(dev, day, c);
        dv(
          "device-grant-tampered-cmd",
          "The text was changed after the day key signed it under a device grant.",
          { ...s, cmd: c.replace("Add the Oct 8 row", "rm -rf ~") },
          no("bad_csig"),
        );
      }
      const addBad = async (name: string, description: string, key: object) =>
        dv(name, description, await signed(pk, day, addDevice(key)), no("bad_fields"));
      await addBad(
        "key-add-device-id-not-spki-hash",
        "A device key whose id is 43 base64url characters but not its SPKI's SHA-256.",
        { ...mac.key, id: b64url(crypto.getRandomValues(new Uint8Array(32))) },
      );
      await addBad("key-add-device-store-software", "A device key declaring software storage.", {
        ...mac.key,
        store: "software",
      });
      await addBad("key-add-device-uv-once", "A device key verified once, not each use.", { ...mac.key, uv: "once" });
      await addBad("key-add-device-rs256", "A device key with alg -257.", { ...mac.key, alg: RS256 });
      await addBad("key-add-unknown-type", "A key of a type the spec does not define.", { ...mac.key, type: "tpm" });
      {
        const phone = await Passkey.create({ rpId: RP });
        await addBad("key-add-passkey-with-store", "A passkey carrying a device key's store.", {
          ...phone.key,
          store: "hardware",
        });
      }
      await addBad("key-add-key-extra-field", "A device key with a field the spec does not list.", {
        ...mac.key,
        attestation: "none",
      });

      const ecode = "K7Q2-9XMV";
      const ev = (
        name: string,
        description: string,
        key: TrustedKey,
        proof: Assertion | DeviceSignature,
        ok: boolean,
      ) =>
        device.push({
          name,
          description,
          input: { machine: MACHINE, code: ecode, key, proof, rp_id: RP },
          expect: { ok },
        });
      ev(
        "enroll-device-valid",
        'A device key proves itself with a signature for purpose pair over sha256("sessionpipe.pair:<machine>:<code>").',
        dev.key,
        await dev.enroll(MACHINE, ecode),
        true,
      );
      ev(
        "enroll-device-other-code",
        "A device proof made for another pairing code.",
        dev.key,
        await dev.enroll(MACHINE, "AAAA-BBBB"),
        false,
      );
      ev(
        "enroll-device-other-rp",
        "A device proof made for another rp id.",
        dev.key,
        await dev.enroll(MACHINE, ecode, { rpId: "evil.example" }),
        false,
      );
      {
        const p = await dev.enroll(MACHINE, ecode);
        const pa = await pk.enroll(MACHINE, ecode);
        ev(
          "enroll-device-webauthn-shaped-proof",
          "WebAuthn authenticatorData and clientDataJSON beside a device key's pairing proof.",
          dev.key,
          { ...p, ad: pa.ad, cd: pa.cd } as Assertion,
          false,
        );
      }
      ev(
        "enroll-device-store-software",
        "A valid proof from a key that declares software storage.",
        { ...dev.key, store: "software" } as unknown as TrustedKey,
        await dev.enroll(MACHINE, ecode),
        false,
      );
    }

    // --- the pool (CONTROL.md §6 `pool`): 137–163, after the device keys ---
    const pool: Vector[] = [];
    {
      const ACC = "b3f0c1d2-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
      const ACC2 = "7a1e2f3b-9c4d-4e5f-a6b7-c8d9e0f1a2b3";
      const poolCmd = (fields: Record<string, unknown>) =>
        commandStr({ kind: "pool", session: POOL_SESSION, text: undefined, ...fields });
      const pv = (name: string, description: string, s: SignedCommand, expect: Vector["expect"]) =>
        pool.push({ name, description, input: { signed: s, ...base() }, expect });
      const okp = async (name: string, description: string, fields: Record<string, unknown>) =>
        pv(name, description, await signed(pk, day, poolCmd(fields)), { ok: true, via: "grant", kind: "pool" });
      const badp = async (name: string, description: string, fields: Record<string, unknown>, code = "bad_fields") =>
        pv(name, description, await signed(pk, day, poolCmd(fields)), { ok: false, code });

      await okp("valid-pool-on", "Turn the machine's account pool on: the action alone.", { pool_action: "on" });
      await okp("valid-pool-off", "Turn it off.", { pool_action: "off" });
      await okp("valid-pool-enable", "Put an account back in rotation, by the id its hello lists.", {
        pool_action: "enable",
        pool_account: ACC,
      });
      await okp("valid-pool-disable", "Take an account out of rotation without removing it.", {
        pool_action: "disable",
        pool_account: ACC,
      });
      await okp("valid-pool-remove", "Remove an account and its credentials from the pool.", {
        pool_action: "remove",
        pool_account: ACC,
      });
      await okp("valid-pool-order", "The whole order: every account of the pool, once each.", {
        pool_action: "order",
        pool_order: [ACC2, ACC],
      });
      await okp("valid-pool-refresh", "Read every account's usage now: no account named.", { pool_action: "refresh" });
      await okp("valid-pool-refresh-account", "Read one account's usage now.", {
        pool_action: "refresh",
        pool_account: ACC,
      });
      await okp("valid-pool-login-begin", "Start a sign-in: the ack carries the URL and the pending login id.", {
        pool_action: "login.begin",
      });
      {
        const c = poolCmd({
          pool_action: "login.complete",
          pool_account: "login_7Qm2xK9pLw",
          pool_code: `${"a".repeat(64)}#${"b".repeat(32)}`,
        });
        pv(
          "valid-pool-login-complete",
          "Finish a sign-in with the pasted code#state, for the pending login id login.begin acked; a confirm, as a key.add often is.",
          { cmd: c, confirm: await pk.assert(await sha256(c)) },
          { ok: true, via: "confirm", kind: "pool" },
        );
      }
      await badp(
        "pool-coding-session",
        "A pool command must name the pool (sessionpipe:pool), not a coding session.",
        { session: "claude-code:8c132906-8c3f-4814-870a-afc3d05e1d2e", pool_action: "on" },
        "bad_session",
      );
      await badp("pool-no-action", "A pool command with no action.", {});
      await badp("pool-unknown-action", "An action the spec doesn't define (`add`): the list is closed.", {
        pool_action: "add",
      });
      await badp("pool-enable-no-account", "enable names an account.", { pool_action: "enable" });
      await badp("pool-enable-with-order", "An order beside an enable: each action takes exactly its own fields.", {
        pool_action: "enable",
        pool_account: ACC,
        pool_order: [ACC],
      });
      await badp("pool-on-with-account", "on takes no account.", { pool_action: "on", pool_account: ACC });
      await badp("pool-order-missing", "order carries the whole order.", { pool_action: "order" });
      await badp("pool-order-empty", "An empty order.", { pool_action: "order", pool_order: [] });
      await badp(
        "pool-order-too-long",
        `An order of ${POOL_ORDER_MAX + 1} accounts: the pool holds at most ${POOL_ORDER_MAX}.`,
        {
          pool_action: "order",
          pool_order: Array.from({ length: POOL_ORDER_MAX + 1 }, (_, i) => `acc_${i}`),
        },
      );
      await badp("pool-order-repeats", "An order that names an account twice.", {
        pool_action: "order",
        pool_order: [ACC, ACC2, ACC],
      });
      await badp("pool-account-bad-char", "An account id with a space and a slash.", {
        pool_action: "remove",
        pool_account: "acc 1/2",
      });
      await badp("pool-login-complete-no-code", "login.complete carries the pasted code.", {
        pool_action: "login.complete",
        pool_account: "login_7Qm2xK9pLw",
      });
      await badp("pool-code-newline", "A code with a line feed in it: a code is one line.", {
        pool_action: "login.complete",
        pool_account: "login_7Qm2xK9pLw",
        pool_code: "abc#xyz\nrm -rf ~",
      });
      await badp("pool-code-too-long", `A code of ${POOL_CODE_MAX + 1} characters.`, {
        pool_action: "login.complete",
        pool_account: "login_7Qm2xK9pLw",
        pool_code: "c".repeat(POOL_CODE_MAX + 1),
      });
      await badp("pool-with-text", "A pool command carrying a prompt's text.", { pool_action: "on", text: "hi" });
      pv(
        "prompt-with-pool-action",
        "Only a pool command carries pool fields.",
        await signed(pk, day, commandStr({ pool_action: "off" })),
        { ok: false, code: "bad_fields" },
      );
      {
        const c = poolCmd({ pool_action: "order", pool_order: [ACC, ACC2] });
        const s = await signed(pk, day, c);
        pv(
          "tampered-pool-order",
          "Signed with one order, carried with another: the receiver swapped the accounts after the device signed.",
          { ...s, cmd: c.replace(`["${ACC}","${ACC2}"]`, `["${ACC2}","${ACC}"]`) },
          { ok: false, code: "bad_csig" },
        );
      }
      {
        // 164: the form the machine takes for on, off, remove, order, disable and
        // login.complete (§6 `pool`): a confirm over the command, where the day-grant
        // form (137) is refused `confirm_required` by the machine.
        const c = poolCmd({ pool_action: "on" });
        pv(
          "valid-pool-on-confirmed",
          "Turn the pool on with a fresh confirm: what the machine requires for on, off, remove, order, disable and login.complete; the same command on a day grant alone (137) verifies but the machine refuses it confirm_required.",
          { cmd: c, confirm: await pk.assert(await sha256(c)) },
          { ok: true, via: "confirm", kind: "pool" },
        );
      }
    }

    mkdirSync(dir, { recursive: true });
    const names = new Set<string>();
    let n = 0;
    let wrote = 0;
    const all = [
      ...out.slice(0, split),
      ...enroll,
      ...out.slice(split, files),
      ...out.slice(files),
      ...device,
      ...pool,
    ];
    for (const v of all) {
      do n++;
      while (RESERVED.has(n));
      const name = `${String(n).padStart(2, "0")}-${v.name}.json`;
      names.add(name);
      if (!REWRITE && existsSync(path.join(dir, name))) continue;
      writeFileSync(path.join(dir, name), `${JSON.stringify(v, null, 2)}\n`);
      wrote++;
    }
    // A vector that no longer exists goes; another change's reserved number stays.
    for (const f of readdirSync(dir))
      if (f.endsWith(".json") && !names.has(f) && !RESERVED.has(Number.parseInt(f, 10))) rmSync(path.join(dir, f));
    console.log(`wrote ${wrote} of ${all.length} control vectors to ${path.relative(root, dir)}`);
  }, 60_000);
});
