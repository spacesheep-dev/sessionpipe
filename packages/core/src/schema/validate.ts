// SPDX-License-Identifier: Apache-2.0
// A checker for the protocol's JSON Schemas: exactly the keywords tools/doors writes into
// schemas/v1 (jsonschema.ts lists them), nothing more, so it stays a page and needs no
// library. It says what is wrong, every problem, as `path: what`; an empty list is a pass.
// A keyword the generator never writes is an error here, not a silent pass: a schema this
// doesn't understand must not read as satisfied.
import type { JsonSchema } from "../../gen/schemas.js";

const KNOWN = new Set([
  "$id",
  "$schema",
  "default",
  "type",
  "properties",
  "required",
  "additionalProperties",
  "propertyNames",
  "maxProperties",
  "items",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "const",
  "enum",
  "anyOf",
  "oneOf",
]);

const typeOf = (v: unknown): string =>
  v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v;
const fits = (want: string, v: unknown): boolean => {
  const t = typeOf(v);
  return want === t || (want === "number" && t === "integer");
};
const str = (v: unknown): string => JSON.stringify(v) ?? String(v);
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Every way `value` fails `schema`, as `path: what`. Empty when it fits. */
export function problems(schema: JsonSchema, value: unknown, path = "$"): string[] {
  const out: string[] = [];
  for (const k of Object.keys(schema))
    if (!KNOWN.has(k)) out.push(`${path}: the schema uses "${k}", which this checker doesn't know`);
  const s = schema as Record<string, unknown>;
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
    if (!types.some((t) => fits(t, value)))
      return [...out, `${path}: expected ${types.join(" or ")}, got ${typeOf(value)}`];
  }
  if (s.const !== undefined && !equal(value, s.const)) out.push(`${path}: expected ${str(s.const)}, got ${str(value)}`);
  if (s.enum !== undefined && !(s.enum as unknown[]).some((e) => equal(e, value)))
    out.push(`${path}: expected one of ${(s.enum as unknown[]).map(str).join(", ")}, got ${str(value)}`);
  if (s.anyOf !== undefined && !(s.anyOf as JsonSchema[]).some((alt) => problems(alt, value, path).length === 0))
    out.push(`${path}: fits none of the ${(s.anyOf as JsonSchema[]).length} alternatives`);
  if (s.oneOf !== undefined) {
    const n = (s.oneOf as JsonSchema[]).filter((alt) => problems(alt, value, path).length === 0).length;
    if (n !== 1)
      out.push(`${path}: fits ${n} of the ${(s.oneOf as JsonSchema[]).length} alternatives, not exactly one`);
  }
  if (typeof value === "string") {
    if (s.minLength !== undefined && value.length < (s.minLength as number))
      out.push(`${path}: shorter than ${s.minLength}`);
    if (s.maxLength !== undefined && value.length > (s.maxLength as number))
      out.push(`${path}: longer than ${s.maxLength}`);
    if (s.pattern !== undefined && !new RegExp(s.pattern as string).test(value))
      out.push(`${path}: does not match ${s.pattern}`);
    if (s.format === "uri" && !URL.canParse(value)) out.push(`${path}: not a URL`);
  }
  if (typeof value === "number") {
    if (s.minimum !== undefined && value < (s.minimum as number)) out.push(`${path}: below ${s.minimum}`);
    if (s.maximum !== undefined && value > (s.maximum as number)) out.push(`${path}: above ${s.maximum}`);
  }
  if (Array.isArray(value)) {
    if (s.minItems !== undefined && value.length < (s.minItems as number))
      out.push(`${path}: fewer than ${s.minItems} items`);
    if (s.maxItems !== undefined && value.length > (s.maxItems as number))
      out.push(`${path}: more than ${s.maxItems} items`);
    if (s.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length)
      out.push(`${path}: repeats an item`);
    if (s.items !== undefined)
      for (const [i, v] of value.entries()) out.push(...problems(s.items as JsonSchema, v, `${path}[${i}]`));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const props = (s.properties ?? {}) as Record<string, JsonSchema>;
    for (const k of (s.required ?? []) as string[]) if (!(k in obj)) out.push(`${path}: missing ${k}`);
    if (s.maxProperties !== undefined && Object.keys(obj).length > (s.maxProperties as number))
      out.push(`${path}: more than ${s.maxProperties} keys`);
    for (const [k, v] of Object.entries(obj)) {
      const at = `${path}.${k}`;
      if (s.propertyNames !== undefined) out.push(...problems(s.propertyNames as JsonSchema, k, `${at} (key)`));
      if (Object.hasOwn(props, k)) out.push(...problems(props[k]!, v, at));
      else if (s.additionalProperties === false) out.push(`${at}: not a key of this object`);
      else if (s.additionalProperties && typeof s.additionalProperties === "object")
        out.push(...problems(s.additionalProperties as JsonSchema, v, at));
    }
  }
  return out;
}
