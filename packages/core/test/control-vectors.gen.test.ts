// SPDX-License-Identifier: Apache-2.0
// Writes conformance/control-vectors/*.json: signed control commands, valid and
// broken, with the verdict every verifier must reach (CONTROL.md §5). Signatures are
// random, so the files are generated once and committed; `npm run vectors` rewrites
// them (SESSIONPIPE_WRITE_VECTORS=1), and control-vectors.test.ts checks them on
// every run. Test keys only: made fresh here, only their public halves are written.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import {
  type Assertion,
  b64url,
  CMD_MAX,
  FILE_NAME_MAX,
  FILE_SIZE_MAX,
  FILES_MAX,
  fromB64url,
  RECEIVER_MAX_AGE_MS,
  RS256,
  type SignedCommand,
  sha256,
  TEXT_MAX,
  type TrustedKey,
} from "../src/control/verify.js";
import { commandStr, DayKey, MACHINE, nonce, Passkey, signed } from "./helpers/authenticator.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dir = path.join(root, "conformance/control-vectors");
const WRITE = process.env.SESSIONPIPE_WRITE_VECTORS === "1";

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
  input: { machine: string; code: string; key: TrustedKey; proof: Assertion; rp_id: string };
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
    await fileShape("files-on-prompt", "Only a start may carry files.", commandStr({ files: [png] }));
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

    mkdirSync(dir, { recursive: true });
    for (const f of readdirSync(dir)) if (f.endsWith(".json")) rmSync(path.join(dir, f));
    let n = 0;
    for (const v of [...out.slice(0, split), ...enroll, ...out.slice(split)])
      writeFileSync(
        path.join(dir, `${String(++n).padStart(2, "0")}-${v.name}.json`),
        `${JSON.stringify(v, null, 2)}\n`,
      );
    console.log(`wrote ${n} control vectors to ${path.relative(root, dir)}`);
  }, 60_000);
});
