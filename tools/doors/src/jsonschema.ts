// SPDX-License-Identifier: Apache-2.0
// JSON Schema (draft 2020-12) from the descriptors: what schemas/v1/*.json holds. The shapes and
// key order are those the Zod source produced before the proto was the source, so the committed
// files did not change by a byte when the source did (RFC 0001 §6, gate 1; decision 001).
//
//   a message                      {type: object, properties, required?}   (`strict`: additionalProperties false;
//                                                                            `open`: additionalProperties {})
//   an `either` message            {oneOf: [its fields' messages]}
//   a field marked REQUIRED        its name in `required`, in field order
//   `nullable`                     {anyOf: [the schema, {type: null}]}
//   `default_json`                 `default` first
//   string + rules                 type, minLength, maxLength, pattern, then `format` (and a date-time's pattern)
//   an integer + rules             {type: integer, minimum, maximum} (±2^53-1 when a bound is not given)
//   double/float + rules           {type: number, minimum?, maximum?}
//   a numeric `const` or `in`      {type: number, const} or anyOf of those (a literal, never an integer)
//   a string/bool `const`          {type, const}
//   an enum                        {type: string, enum: [words]}
//   repeated                       minItems, maxItems, type: array, items, uniqueItems
//   map<string, V>                 {type: object, propertyNames, additionalProperties: V, maxProperties?}
//   google.protobuf.Struct         {type: object, propertyNames: {type: string}, additionalProperties: {}}
//   google.protobuf.Value          {}
import { type DescField, type DescMessage, ScalarType } from "@bufbuild/protobuf";
import {
  DATE_TIME,
  type Descriptors,
  enumWords,
  type FieldRules,
  INT_CASES,
  type Kind,
  kindOf,
  type NumberRules,
  URI,
  wireName,
} from "./read.js";

export const SCHEMA_BASE = "https://sessionpipe.org/schema/v1/";
const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
/** RFC 3339, UTC, three decimals: what FORMAT_DATE_TIME means (the pattern Zod's `iso.datetime` wrote). */
export const DATE_TIME_PATTERN =
  "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d\\.\\d{3}(?:Z))$";

/** The schema files and the message each one is: schemas/v1/<name>.json. */
export const SCHEMA_FILES: Readonly<Record<string, string>> = {
  event: "Event",
  "event-data": "EventData",
  batch: "Batch",
  "batch-response": "BatchResponse",
  error: "ErrorResponse",
  "well-known": "WellKnown",
  control: "ControlMessage",
  "control-command": "ControlCommand",
  "control-grant": "ControlGrant",
  "control-key": "ControlKey",
  "control-poll": "ControlPoll",
  "control-ack": "ControlAck",
  "control-pair": "ControlPairStart",
  "control-pair-started": "ControlPairStarted",
  "control-paired": "ControlPaired",
  "control-hello": "ControlHello",
};

type Schema = Record<string, unknown>;

/** The JSON Schema of one message, inlined whole (no $ref), as the committed files have it. */
export function messageSchema(d: Descriptors, desc: DescMessage): Schema {
  if (d.either(desc))
    return { oneOf: desc.fields.map((f) => messageSchema(d, (kindOf(f) as { message: DescMessage }).message)) };
  const properties: Schema = {};
  const required: string[] = [];
  for (const f of desc.fields) {
    properties[wireName(f)] = fieldSchema(d, f);
    if (d.required(f)) required.push(wireName(f));
  }
  const out: Schema = { type: "object", properties };
  if (required.length) out.required = required;
  if (d.strict(desc)) out.additionalProperties = false;
  else if (d.open(desc)) out.additionalProperties = {};
  return out;
}

function fieldSchema(d: Descriptors, f: DescField): Schema {
  const rules = d.rules(f);
  let schema: Schema;
  if (f.fieldKind === "list") {
    const r = rules?.type?.case === "repeated" ? rules.type.value : undefined;
    schema = {};
    if (r?.minItems !== undefined) schema.minItems = r.minItems;
    if (r?.maxItems !== undefined) schema.maxItems = r.maxItems;
    schema.type = "array";
    schema.items = valueSchema(d, kindOf(f), r?.items);
    if (r?.unique) schema.uniqueItems = true;
  } else if (f.fieldKind === "map") {
    const r = rules?.type?.case === "map" ? rules.type.value : undefined;
    schema = { type: "object", propertyNames: valueSchema(d, { scalar: f.mapKey }, r?.keys) };
    schema.additionalProperties = valueSchema(d, kindOf(f), r?.values);
    if (r?.maxPairs !== undefined) schema.maxProperties = r.maxPairs;
  } else schema = valueSchema(d, kindOf(f), rules, d.format(f));
  if (d.nullable(f)) schema = { anyOf: [schema, { type: "null" }] };
  const dflt = d.defaultJson(f);
  return dflt === undefined ? schema : { default: JSON.parse(dflt), ...schema };
}

function bound(r: NumberRules | undefined, side: "greaterThan" | "lessThan", fallback: number): number {
  const b = r?.[side];
  if (!b) return fallback;
  if (b.case === "gte" || b.case === "lte") return b.value;
  throw new Error(`a ${b.case} rule has no JSON Schema here; use gte or lte`);
}

/** One value: a scalar with its rules, an enum, or a message. `format` is a singular string's. */
function valueSchema(d: Descriptors, kind: Kind, rules: FieldRules | undefined, format?: number): Schema {
  if ("message" in kind) {
    if (kind.message.typeName === "google.protobuf.Value") return {};
    if (kind.message.typeName === "google.protobuf.Struct")
      return { type: "object", propertyNames: { type: "string" }, additionalProperties: {} };
    return messageSchema(d, kind.message);
  }
  if ("enum" in kind) return { type: "string", enum: enumWords(kind.enum, d) };
  const r = rules?.type;
  if (kind.scalar === ScalarType.STRING) {
    const s = r?.case === "string" ? r.value : undefined;
    if (s?.const !== undefined) return { type: "string", const: s.const };
    const out: Schema = { type: "string" };
    if (s?.minLen !== undefined) out.minLength = s.minLen;
    if (s?.maxLen !== undefined) out.maxLength = s.maxLen;
    if (s?.pattern !== undefined) out.pattern = s.pattern;
    if (format === DATE_TIME) {
      out.format = "date-time";
      out.pattern = DATE_TIME_PATTERN;
    } else if (format === URI) out.format = "uri";
    return out;
  }
  if (kind.scalar === ScalarType.BOOL) {
    const b = r?.case === "bool" ? r.value : undefined;
    return b?.const !== undefined ? { type: "boolean", const: b.const } : { type: "boolean" };
  }
  if (kind.scalar === ScalarType.DOUBLE || kind.scalar === ScalarType.FLOAT) {
    const n = r?.case === "double" || r?.case === "float" ? r.value : undefined;
    const out: Schema = { type: "number" };
    if (n?.greaterThan) out.minimum = bound(n, "greaterThan", 0);
    if (n?.lessThan) out.maximum = bound(n, "lessThan", 0);
    return out;
  }
  if (INT_CASES.has(ScalarType[kind.scalar].toLowerCase())) {
    const n = r?.value as NumberRules | undefined; // an integer's rules are integer rules

    if (n?.const !== undefined) return { type: "number", const: n.const };
    if (n?.in?.length) return { anyOf: n.in.map((v) => ({ type: "number", const: v })) };
    return { type: "integer", minimum: bound(n, "greaterThan", -MAX_SAFE), maximum: bound(n, "lessThan", MAX_SAFE) };
  }
  throw new Error(`no JSON Schema for a ${ScalarType[kind.scalar]} field`);
}

/** Every schema file's text, by repository path. */
export function schemaFiles(d: Descriptors): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, message] of Object.entries(SCHEMA_FILES)) {
    const json = { $id: `${SCHEMA_BASE}${name}.json`, $schema: DRAFT, ...messageSchema(d, d.message(message)) };
    out[`schemas/v1/${name}.json`] = `${JSON.stringify(json, null, 2)}\n`;
  }
  return out;
}
