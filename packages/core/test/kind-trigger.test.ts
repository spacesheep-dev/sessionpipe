// SPDX-License-Identifier: Apache-2.0
// "No command and no notice makes, changes, pauses, resumes or removes a rule" (CONTROL.md §14,
// principle 2 of §1: a receiver "can never forge" a command). The vector
// conformance/control-vectors/171-kind-trigger.json is a trigger.add whose signatures all hold,
// and the verifier still refuses it `unknown_kind`; so does every other trigger.* kind.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CONTROL_KINDS,
  fromB64url,
  parseCommand,
  parseGrant,
  sha256,
  verifyAssertion,
  verifyCommand,
} from "../src/control/verify.js";
import { commandStr } from "./helpers/authenticator.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const v = JSON.parse(readFileSync(path.join(root, "conformance/control-vectors/171-kind-trigger.json"), "utf8"));

describe("no command makes a rule", () => {
  it("171-kind-trigger is signed correctly: the grant verifies against the trusted key, and csig over cmd", async () => {
    const { cmd, csig, grant } = v.input.signed;
    const g = parseGrant(grant.str, v.input.rp_id);
    expect(g.ok).toBe(true);
    const tap = await verifyAssertion(await sha256(grant.str), grant, v.input.trusted[0], v.input.rp_id, "grant");
    expect(tap).toEqual({ ok: true });
    const pub = await crypto.subtle.importKey(
      "spki",
      fromB64url((g as { grant: { pub: string } }).grant.pub)!.slice(),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const good = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      pub,
      fromB64url(csig)!.slice(),
      new TextEncoder().encode(cmd),
    );
    expect(good).toBe(true);
    expect(JSON.parse(cmd).kind).toBe("trigger.add");
  });
  it("and still verifies as unknown_kind", async () => {
    const r = await verifyCommand(v.input.signed, {
      machine: v.input.machine,
      rpId: v.input.rp_id,
      trusted: v.input.trusted,
      now: v.input.now,
    });
    expect(r).toMatchObject({ ok: false, code: "unknown_kind" });
    expect(v.expect).toEqual({ ok: false, code: "unknown_kind" });
  });
  it("every trigger.* kind, and the plain word, is unknown: no kind names a rule", () => {
    expect(CONTROL_KINDS.some((k) => k.startsWith("trigger"))).toBe(false);
    for (const kind of ["trigger", "trigger.add", "trigger.pause", "trigger.resume", "trigger.remove", "triggers.on"])
      expect(parseCommand(commandStr({ kind, session: "sessionpipe:triggers" })), kind).toMatchObject({
        ok: false,
        code: "unknown_kind",
      });
  });
});
