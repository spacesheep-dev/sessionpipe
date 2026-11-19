// SPDX-License-Identifier: Apache-2.0
// The ruleset against its own vectors (conformance/redaction/secrets.json): every
// case, the templated credential recipes, and the adversarial recipes with a time
// budget. Any other copy of the rules (a server-side re-check) runs this file's
// fixture, never a copy of these expectations.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hasSecret, isSecretName, REDACTED, redactDeep, redactSecrets } from "../src/privacy/secrets.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const fx = JSON.parse(readFileSync(path.join(root, "conformance/redaction/secrets.json"), "utf8"));
const rnd = (n: number, abc: string = fx.rnd_default_abc) =>
  Array.from({ length: n }, (_, i) => abc[(i * 7 + 3) % abc.length]).join("");
const build = (parts: { prefix: string; len: number; abc?: string }[]) =>
  parts.map((p) => p.prefix + rnd(p.len, p.abc)).join("");
const materialise = (c: { in?: string; template?: string; t?: { prefix: string; len: number; abc?: string }[] }) =>
  c.in ?? (c.template as string).replace(/\{t\}/g, build(c.t ?? []));

describe("secrets@1 vectors", () => {
  expect(fx.redacted).toBe(REDACTED);
  for (const c of fx.cases as { name: string; in?: string; template?: string; t?: never[]; out: string }[]) {
    it(`${c.name}: ${(c.in ?? c.template ?? "").slice(0, 50)}`, () => {
      const input = materialise(c);
      expect(redactSecrets(input)).toBe(c.out);
      expect(redactSecrets(c.out)).toBe(c.out);
      if (c.template)
        for (const part of c.t as unknown as { prefix: string; len: number; abc?: string }[])
          expect(redactSecrets(input)).not.toContain(rnd(part.len, part.abc).slice(-10));
      if (c.name === "untouched") expect(hasSecret(input)).toBe(false);
    });
  }
});

describe("secrets@1 structured vectors", () => {
  for (const c of fx.deep as { name: string; in: unknown; out: unknown }[]) {
    it(`${c.name}: ${JSON.stringify(c.in).slice(0, 50)}`, () => {
      expect(redactDeep(c.in)).toEqual(c.out);
      expect(redactDeep(c.out)).toEqual(c.out);
    });
  }
});

describe("secrets@1 adversarial (linear time)", () => {
  const grow = (r: {
    prefix?: string;
    repeat: string;
    times: number;
    then?: string;
    then_repeat?: string;
    then_times?: number;
    suffix?: string;
  }) =>
    (r.prefix ?? "") +
    r.repeat.repeat(r.times) +
    (r.then ?? "") +
    (r.then_repeat ? r.then_repeat.repeat(r.then_times ?? 0) : "") +
    (r.suffix ?? "");
  for (const a of fx.adversarial as { name: string; recipe: never; under?: string; max_ms: number }[]) {
    it(`stays fast on ${a.name}`, () => {
      const s = grow(a.recipe);
      const t0 = Date.now();
      if (a.under === undefined) redactSecrets(s);
      else redactDeep({ [a.under]: s });
      expect(Date.now() - t0).toBeLessThan(a.max_ms);
    });
  }
});

describe("redactDeep", () => {
  it("a header's stand-in that the text rules would change goes whole, and stays so on a second pass", () => {
    const once = redactDeep({ Authorization: `<ghp_${rnd(36)}>`, cookie: "<token>" });
    expect(once).toEqual({ Authorization: REDACTED, cookie: "<token>" });
    expect(redactDeep(once)).toEqual(once);
  });
  it("redacts every string in a value, leaving keys and numbers", () => {
    const out = redactDeep({
      session: { id: "019a-77", seq: 3 },
      data: { user: "use DB_PASSWORD=hunter2", assistant: "done" },
    });
    expect(out.data.user).toBe(`use DB_PASSWORD=${REDACTED}`);
    expect(out.session.seq).toBe(3);
    expect(out.session.id).toBe("019a-77");
  });
  it("walks arrays, leaves numbers, booleans and nulls", () => {
    expect(redactDeep(["password: hunter2!", 1, true, null, [`ghp_${"a".repeat(36)}`]])).toEqual([
      `password: ${REDACTED}`,
      1,
      true,
      null,
      [REDACTED],
    ]);
    expect(redactDeep(7)).toBe(7);
    expect(hasSecret("")).toBe(false);
  });
});

describe("secrets@1 is idempotent", () => {
  for (const c of fx.cases as { name: string; in?: string; template?: string; out: string }[]) {
    it(c.name, () => {
      const once = redactSecrets(materialise(c));
      expect(redactSecrets(once)).toBe(once);
      expect(redactSecrets(c.out)).toBe(c.out);
    });
  }
});

describe("secrets@1 edges", () => {
  const same = (s: string) => expect(redactSecrets(s)).toBe(s);
  it("an empty string is itself; a prose value already redacted in part is not redacted twice", () => {
    same("");
    expect(redactSecrets(`password is A1:ghp_${"a".repeat(36)}`)).toBe(`password is A1:${REDACTED}`);
  });
  it("a token count is a number, not a token", () => {
    same("max_tokens: 4096");
    same("input_tokens=12k");
    same("output_tokens: 1,234.5");
    expect(redactSecrets("token: 4096abc")).toBe(`token: ${REDACTED}`);
  });
  it("a secret name with nothing after it is left alone", () => {
    same("password=");
    same("password=,");
    same('password: ""');
    same("DB_PASSWORD: ");
  });
  it("placeholders stay", () => {
    for (const v of [
      "string",
      "***",
      "xxxx",
      "...",
      "…",
      "<your-key>",
      "$PW",
      `\${PW}`,
      "{{pw}}",
      "process.env.PW",
      "form.password",
      "hash(pw)",
      "your-password",
      "[redacted]",
      "redacted",
      "!!!",
    ])
      same(`password: ${v}`);
  });
  it("assignments in every quoting", () => {
    expect(redactSecrets('"password": "s3cr3t"')).toBe(`"password": "${REDACTED}"`);
    expect(redactSecrets("apiKey => 'abc123xyz'")).toBe(`apiKey => '${REDACTED}'`);
    expect(redactSecrets("client-secret := `abc123xyz`")).toBe(`client-secret := \`${REDACTED}\``);
    expect(redactSecrets("STRIPE_KEY=sk_test_abc")).toBe(`STRIPE_KEY=${REDACTED}`);
    expect(redactSecrets("password: hunter2!")).toBe(`password: ${REDACTED}`);
  });
  it("prose: only a value that looks generated goes", () => {
    same("the password is wrong");
    same("the password is Hunter");
    same("the password is https://example.com/login");
    same("the token is 128k");
    same("the token is 128000");
    same("the token is 1,280.5%");
    same("the password is MY_SECRET_VAR");
    same("the password is ab-cd!");
    same("pass is ab12");
    expect(redactSecrets("password is Hunter2!")).toBe(`password is ${REDACTED}`);
    expect(redactSecrets("the token was abc123")).toBe(`the token was ${REDACTED}`);
    expect(redactSecrets("set the password to Tr0ub4dor&3")).toBe(`set the password to ${REDACTED}`);
    expect(redactSecrets("password for admin is Tr0ub4dor&3")).toBe(`password for admin is ${REDACTED}`);
    expect(redactSecrets(`password is "Tr0ub4dor&3"`)).toBe(`password is "${REDACTED}"`);
  });
  it("Authorization headers and URL credentials", () => {
    expect(redactSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123")).toBe(
      `Authorization: Bearer ${REDACTED}`,
    );
    expect(redactSecrets("Basic dXNlcjpwYXNzd29yZA==")).toBe(`Basic ${REDACTED}`);
    same("Bearer short");
    expect(redactSecrets("postgres://admin:s3cret@db.example:5432/app")).toBe(
      `postgres://admin:${REDACTED}@db.example:5432/app`,
    );
  });
  it("URL query credentials: only the value goes, from a listed name, 16 characters or more", () => {
    const v = "AbCdEfGhIjKlMnOp";
    for (const name of ["k", "key", "sig", "signature", "X-Amz-Signature", "X-Goog-Signature", "KEY"])
      expect(redactSecrets(`https://example.com/a?${name}=${v}#top`), name).toBe(
        `https://example.com/a?${name}=${REDACTED}#top`,
      );
    expect(redactSecrets(`https://example.com/a?x=1&k=${v}/+=%2F~-._`)).toBe(`https://example.com/a?x=1&k=${REDACTED}`);
    expect(redactSecrets(`(https://example.com/a?sig=${"a".repeat(600)})`)).toBe(
      `(https://example.com/a?sig=${REDACTED})`,
    );
    same(`https://example.com/a?k=${v.slice(1)}`);
    same(`https://example.com/a?kid=${v}&monkey=${v}&sk=${v}`);
    same(`https://example.com/a#k=${v}`);
    expect(redactSecrets(`?k=${v}&e=1`)).toBe(`?k=${REDACTED}&e=1`);
    same(`a lone & k=${v}`);
    // A secret's name in a query is an assignment's: its value goes at any length.
    for (const name of ["token", "access_token", "api_key", "apikey"])
      expect(redactSecrets(`https://example.com/a?${name}=short&n=1`), name).toBe(
        `https://example.com/a?${name}=${REDACTED}&n=1`,
      );
  });
  it("URL query credentials: read last, in what the other rules leave", () => {
    const v = "c838de6c19464815fe85fa9831196c35";
    // A value the other rules take whole goes with the link in it, in either form.
    expect(redactSecrets(`API_KEY=https://example.com/f?k=${v}`)).toBe(`API_KEY=${REDACTED}`);
    expect(redactSecrets(`{"name":"api_key","value":"https://example.com/f?k=${v}"}`)).toBe(
      `{"name":"api_key","value":"${REDACTED}"}`,
    );
    expect(redactSecrets(`Cookie: next=/f?k=${v}; theme=dark`)).toBe(`Cookie: ${REDACTED}`);
    // A link the other rules leave keeps everything but its key.
    expect(redactSecrets(`the token was https://example.com/f?k=${v}`)).toBe(
      `the token was https://example.com/f?k=${REDACTED}`,
    );
    expect(redactSecrets(`{"cookies":{"next":"https://example.com/f?k=${v}"}}`)).toBe(
      `{"cookies":{"next":"https://example.com/f?k=${REDACTED}"}}`,
    );
  });
  it("URL query credentials: a k or key value that reads as words stays, anything else goes", () => {
    const words = [
      "wireless+bluetooth+headphones",
      "open-source-dashboard-libraries",
      "value_of_the_long_param_name",
      "Wireless%20Bluetooth%20Headphones",
      "top-10-dashboards-2026",
      "internationalization",
      "release.notes.for.version.2026",
      "a".repeat(600),
    ];
    for (const w of words) {
      same(`https://example.com/s?k=${w}`);
      same(`https://example.com/s?x=1&KEY=${w}#top`);
      // The other names keep the plain rule: a word value of 16 or more goes.
      expect(redactSecrets(`https://example.com/s?sig=${w}`), w).toBe(`https://example.com/s?sig=${REDACTED}`);
    }
    // The punctuation at a value's end is taken off before it is read: a sentence's full
    // stop leaves words as words, and a key with one still goes, with it.
    same("see https://example.com/s?key=open-source-dashboard-libraries.");
    same("https://example.com/s?k=wireless+bluetooth+headphones...");
    expect(redactSecrets("see https://example.com/s?k=c838de6c19464815fe85fa9831196c35.")).toBe(
      `see https://example.com/s?k=${REDACTED}`,
    );
    expect(redactSecrets(`https://example.com/s?k=${".".repeat(20)}`)).toBe(`https://example.com/s?k=${REDACTED}`);
    const keys = [
      "c838de6c19464815fe85fa9831196c35", // hex: letters and digits in one piece
      "KO2Kk4KVUuuyKfN0AbCdEf", // base64url: mixed case in one piece
      "550e8400-e29b-41d4-a716-446655440000", // a UUID
      "1795139368424000000", // a number of more than four digits
      "AbCdEfGhIjKlMnOp",
      "iphone15-pro-max-case", // unclear: redacted
      "wireless+bluetooth+headphoneS", // words until the last character
      "wireless++bluetooth+headphones", // an empty piece
      "open-source-dashboard-libraries-", // an empty last piece
      "%20wireless%20bluetooth", // an empty first piece
      "wireless%2Bbluetooth%2Bheadphones", // %2B is no separator
      "top-10000-dashboards", // five digits
      "WIRELESS-BLUETOOTH", // capitals only
      "wireless/bluetooth/headphones", // `/` is no separator
    ];
    for (const v of keys) {
      expect(redactSecrets(`https://example.com/s?k=${v}`), v).toBe(`https://example.com/s?k=${REDACTED}`);
      expect(redactSecrets(`https://example.com/s?e=1&amp;Key=${v}&n=2`), v).toBe(
        `https://example.com/s?e=1&amp;Key=${REDACTED}&n=2`,
      );
    }
    expect(redactSecrets("https://example.com/f.png?e=1795139368424&k=c838de6c19464815fe85fa9831196c35")).toBe(
      `https://example.com/f.png?e=1795139368424&k=${REDACTED}`,
    );
    for (const w of [...words, ...keys]) {
      const once = redactSecrets(`https://example.com/s?k=${w}&key=${w}`);
      expect(redactSecrets(once), w).toBe(once);
    }
  });
  it("isSecretName", () => {
    for (const n of ["STRIPE_KEY", "DB_PASSWORD", "apiKey", "client-secret", "creds", "AWS_SECRET_ACCESS_KEY"])
      expect(isSecretName(n), n).toBe(true);
    for (const n of ["sort_key", "password_hash", "tokenizer", "https", "name"]) expect(isSecretName(n), n).toBe(false);
  });
});
