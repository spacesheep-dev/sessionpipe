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
      if (c.template)
        for (const part of c.t as unknown as { prefix: string; len: number; abc?: string }[])
          expect(redactSecrets(input)).not.toContain(rnd(part.len, part.abc).slice(-10));
      if (c.name === "untouched") expect(hasSecret(input)).toBe(false);
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
  for (const a of fx.adversarial as { name: string; recipe: never; max_ms: number }[]) {
    it(`stays fast on ${a.name}`, () => {
      const s = grow(a.recipe);
      const t0 = Date.now();
      redactSecrets(s);
      expect(Date.now() - t0).toBeLessThan(a.max_ms);
    });
  }
});

describe("redactDeep", () => {
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
  it("isSecretName", () => {
    for (const n of ["STRIPE_KEY", "DB_PASSWORD", "apiKey", "client-secret", "creds", "AWS_SECRET_ACCESS_KEY"])
      expect(isSecretName(n), n).toBe(true);
    for (const n of ["sort_key", "password_hash", "tokenizer", "https", "name"]) expect(isSecretName(n), n).toBe(false);
  });
});
