// SPDX-License-Identifier: Apache-2.0
// A stand-in authenticator and signing device, so every control check runs on real
// signatures: a passkey (ES256 or RS256) that answers WebAuthn assertions the way a
// platform authenticator does, a browser day key (P-256) that signs commands, and an
// app's device key (DeviceKeySim) that signs the device message (CONTROL.md §3.2).
// Test keys only; they are made fresh per run and never leave the test. A software
// key can't be honest about `store: "hardware"`: DeviceKeySim only claims it for tests.
import {
  type Assertion,
  b64url,
  COMMAND_TYPE,
  type DeviceGrant,
  type DevicePurpose,
  type DeviceSignature,
  deviceKeyId,
  deviceMessage,
  GRANT_TYPE,
  type GrantBundle,
  pairChallenge,
  RS256,
  type SignedCommand,
  sha256,
  type TrustedKey,
} from "../../src/control/verify.js";

const enc = new TextEncoder();
type CryptoKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;
type Bytes = Uint8Array<ArrayBuffer>;

export function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (v: Uint8Array) => {
    let i = 0;
    while (i < v.length - 1 && v[i] === 0) i++;
    let b = v.slice(i);
    if ((b[0] as number) & 0x80) b = new Uint8Array([0, ...b]);
    return new Uint8Array([0x02, b.length, ...b]);
  };
  const r = int(raw.slice(0, 32));
  const s = int(raw.slice(32));
  return new Uint8Array([0x30, r.length + s.length, ...r, ...s]);
}

export interface AssertOptions {
  rpId?: string;
  origin?: string;
  flags?: number;
  type?: string;
  crossOrigin?: boolean;
  /** Sign with this rp id's hash in authenticatorData instead of `rpId`'s. */
  adRpId?: string;
}

export class Passkey {
  constructor(
    readonly key: TrustedKey,
    private readonly priv: CryptoKey,
    readonly rpId: string,
    readonly origin: string,
  ) {}

  static async create(o: { rpId?: string; origin?: string; alg?: number } = {}): Promise<Passkey> {
    const rpId = o.rpId ?? "receiver.example";
    const origin = o.origin ?? `https://${rpId}`;
    const rsa = o.alg === RS256;
    const pair = rsa
      ? await crypto.subtle.generateKey(
          {
            name: "RSASSA-PKCS1-v1_5",
            modulusLength: 2048,
            publicExponent: new Uint8Array([1, 0, 1]),
            hash: "SHA-256",
          },
          true,
          ["sign", "verify"],
        )
      : await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const spki = b64url(await crypto.subtle.exportKey("spki", pair.publicKey));
    const id = b64url(crypto.getRandomValues(new Uint8Array(24)));
    return new Passkey({ id, alg: rsa ? RS256 : -7, spki }, pair.privateKey, rpId, origin);
  }

  async assert(challenge: Uint8Array, o: AssertOptions = {}): Promise<Assertion> {
    const rpId = o.rpId ?? this.rpId;
    const cd = enc.encode(
      JSON.stringify({
        type: o.type ?? "webauthn.get",
        challenge: b64url(challenge),
        origin: o.origin ?? this.origin,
        crossOrigin: o.crossOrigin ?? false,
      }),
    );
    const ad = new Uint8Array(37);
    ad.set(await sha256(o.adRpId ?? rpId), 0);
    ad[32] = o.flags ?? 0x05;
    ad.set([0, 0, 0, 7], 33);
    const signed = new Uint8Array(ad.length + 32);
    signed.set(ad, 0);
    signed.set(await sha256(cd), ad.length);
    let sig: Uint8Array;
    if (this.key.alg === RS256) {
      sig = new Uint8Array(await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, this.priv, signed as Bytes));
    } else {
      const raw = new Uint8Array(
        await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.priv, signed as Bytes),
      );
      sig = rawToDer(raw);
    }
    return { cred: this.key.id, ad: b64url(ad), cd: b64url(cd), sig: b64url(sig) };
  }

  /** The enrollment proof for a machine's pairing code. */
  async enroll(machine: string, code: string, o: AssertOptions = {}): Promise<Assertion> {
    return this.assert(await pairChallenge(machine, code), o);
  }
}

/** A browser's non-extractable day key, vouched for by a passkey's grant. */
export class DayKey {
  constructor(
    private readonly priv: CryptoKey,
    readonly pub: string,
  ) {}

  static async create(): Promise<DayKey> {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    return new DayKey(pair.privateKey, b64url(await crypto.subtle.exportKey("spki", pair.publicKey)));
  }

  /** The grant string (exact bytes the passkey signs) for this key. */
  grantStr(o: { iat: number; exp: number; rp: string; t?: string; pub?: string }): string {
    return JSON.stringify({ v: 1, t: o.t ?? GRANT_TYPE, pub: o.pub ?? this.pub, iat: o.iat, exp: o.exp, rp: o.rp });
  }

  async grant(
    passkey: Passkey,
    o: { iat: number; exp: number; rp?: string; str?: string; assert?: AssertOptions | undefined },
  ) {
    const str = o.str ?? this.grantStr({ iat: o.iat, exp: o.exp, rp: o.rp ?? passkey.rpId });
    const a = await passkey.assert(await sha256(str), o.assert);
    return { ...a, str } satisfies GrantBundle;
  }

  /** The same grant, signed by an app's device key instead of a passkey. */
  async deviceGrant(
    device: DeviceKeySim,
    o: { iat: number; exp: number; rp?: string; str?: string; sign?: DeviceSignOptions | undefined },
  ): Promise<DeviceGrant> {
    const str = o.str ?? this.grantStr({ iat: o.iat, exp: o.exp, rp: o.rp ?? device.rpId });
    return { ...(await device.sign("grant", await sha256(str), o.sign)), str };
  }

  async sign(cmd: string): Promise<string> {
    return b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.priv, enc.encode(cmd) as Bytes));
  }
}

export interface DeviceSignOptions {
  /** Sign with this purpose line instead of the one asked for. */
  purpose?: DevicePurpose;
  /** Sign with this rp id line instead of the key's. */
  rpId?: string;
  /** Sign these bytes as they are instead of the device message. */
  raw?: Uint8Array;
  /** Write the signature in DER, as WebAuthn would, instead of r‖s. */
  der?: boolean;
}

/** An app's device key (CONTROL.md §2): a P-256 key that names itself by its SPKI's
 *  hash and signs `sessionpipe.device.v1⏎<purpose>⏎<rp id>⏎<challenge>` with raw r‖s. */
export class DeviceKeySim {
  constructor(
    readonly key: TrustedKey,
    private readonly priv: CryptoKey,
    readonly rpId: string,
  ) {}

  static async create(o: { rpId?: string } = {}): Promise<DeviceKeySim> {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const spki = b64url(await crypto.subtle.exportKey("spki", pair.publicKey));
    const key: TrustedKey = {
      id: await deviceKeyId(spki),
      alg: -7,
      spki,
      type: "device",
      store: "hardware",
      uv: "each-use",
    };
    return new DeviceKeySim(key, pair.privateKey, o.rpId ?? "receiver.example");
  }

  async sign(purpose: DevicePurpose, challenge: Uint8Array, o: DeviceSignOptions = {}): Promise<DeviceSignature> {
    const msg = o.raw ?? deviceMessage(o.purpose ?? purpose, o.rpId ?? this.rpId, challenge);
    const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.priv, msg as Bytes));
    return { cred: this.key.id, sig: b64url(o.der ? rawToDer(raw) : raw) };
  }

  /** The enrollment proof for a machine's pairing code. */
  async enroll(machine: string, code: string, o: DeviceSignOptions = {}): Promise<DeviceSignature> {
    return this.sign("pair", await pairChallenge(machine, code), o);
  }
}

/** A command signed by a device key: its day grant plus csig, or a confirm. */
export async function deviceSigned(
  device: DeviceKeySim,
  day: DayKey,
  cmd: string,
  o: { confirm?: boolean; grantIat?: number; grantExp?: number } = {},
): Promise<SignedCommand> {
  if (o.confirm) return { cmd, confirm: await device.sign("confirm", await sha256(cmd)) };
  const iat = o.grantIat ?? (JSON.parse(cmd).iat as number) - 60_000;
  const grant = await day.deviceGrant(device, { iat, exp: o.grantExp ?? iat + 12 * 3600_000 });
  return { cmd, csig: await day.sign(cmd), grant };
}

export const nonce = (n = 16) => b64url(crypto.getRandomValues(new Uint8Array(n)));
export const MACHINE = "m_testmachine0000000001";

/** A command string in the field order a browser would write it. */
export function commandStr(fields: Record<string, unknown>): string {
  return JSON.stringify({
    v: 1,
    t: COMMAND_TYPE,
    machine: MACHINE,
    kind: "prompt",
    session: "claude-code:8c132906-8c3f-4814-870a-afc3d05e1d2e",
    text: "Add the Oct 8 row",
    nonce: nonce(),
    iat: 1_790_800_000_000,
    ...fields,
  });
}

/** A fully signed command: grant path by default, confirm path with `confirm: true`. */
export async function signed(
  passkey: Passkey,
  day: DayKey,
  cmd: string,
  o: { confirm?: boolean; grantIat?: number; grantExp?: number } = {},
): Promise<SignedCommand> {
  if (o.confirm) return { cmd, confirm: await passkey.assert(await sha256(cmd)) };
  const iat = o.grantIat ?? (JSON.parse(cmd).iat as number) - 60_000;
  const grant = await day.grant(passkey, { iat, exp: o.grantExp ?? iat + 12 * 3600_000 });
  return { cmd, csig: await day.sign(cmd), grant };
}
