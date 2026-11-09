# 001 · The proto says exactly what the Zod source said

- **Status:** Accepted
- **Decided:** 2026-11-08, RFC 0001 step 1

## Context

`schemas/v1/*.json` were generated from `packages/core/schema/v1.ts` (Zod). Receivers,
spacesheep.dev among them, validate against those files. Making the proto the source
must not change a byte of them (RFC 0001 §6 gate 1), so every Zod idiom in the schemas
needs a proto fact that produces the same JSON, and the generator must write keys in
Zod's order.

## Decisions

| Zod wrote | The proto says | Why this and not the natural proto form |
|---|---|---|
| `required` lists | `(google.api.field_behavior) = REQUIRED` | protovalidate's `required` means "non-zero" on proto3 scalars; `pii: false` would be invalid. proto3 `optional` is about presence in generated code, a step-2 concern, and can't mark a repeated field |
| `anyOf: [X, {type: null}]` | `(sessionpipe.v1.nullable) = true` | proto has no null; the wire does (`parent_id`, `csig`) |
| `oneOf` of two object shapes (`ControlKey`, `grant`, `confirm`, `proof`) | a message with `(sessionpipe.v1.either) = true` whose fields are the alternatives | a proto `oneof` names its arm as a JSON key; the wire carries the chosen shape bare. The fields' names (`passkey`, `device`) are for the reader of the proto |
| `additionalProperties: {}` / `false` | `open` / `strict` message options | proto3 JSON has one global unknown-field switch; the wire has three behaviours by message |
| `{type: number, const: 1}` for `z.literal(1)` | `int32` with `(buf.validate.field).int32.const = 1`; the generator writes `number` for any numeric `const` or `in` | Zod's literal is a number, not an integer; keeping the proto type honest and the generator aware beats a double field |
| `{type: string, enum: [...]}` | a proto enum; words from the value names, `word` for `first-ask`, `permission.answer`, `key.add`, `login.begin`, `login.complete` | an enum is the ontology a Rust or Swift reader wants; the exceptions are five |
| `format: date-time` + a 300-character pattern | `(sessionpipe.v1.format) = FORMAT_DATE_TIME`; the pattern is one constant in the generator | the pattern is Zod's rendering of "RFC 3339, UTC, three decimals"; the proto says the meaning, the generator the rendering |
| `default: ["bearer"]` | `(sessionpipe.v1.default_json) = "[\"bearer\"]"` | one field in the protocol has a default; an option beats a convention |
| `integer` with `minimum: -9007199254740991, maximum: 9007199254740991` | `int32`/`int64` with `gte`/`lte` where Zod had `.min`/`.max`; the generator fills ±2^53 − 1 for a missing bound | that is what `z.int()` means on the wire |
| `{}` for `z.unknown()`; `propertyNames` + `additionalProperties: {}` for `z.record(z.string(), z.unknown())` | `google.protobuf.Value`; `google.protobuf.Struct` | the well-known types are what they are |
| snake_case keys | the proto field name; `json_name` only for `EventData`'s dotted types | protobuf's camelCase default would rename every key; the wire is snake_case and stays so |
| key order: `default`, `minItems`, `maxItems`, `type`, `items`, `uniqueItems`; `type`, `minLength`, `maxLength`, `pattern`, `format` | the generator's order, fixed | so the files don't change by a byte; a later PR may re-order once no receiver depends on the text |

## What follows

- `tools/doors/test/parity.test.ts` holds every generated schema byte-identical to Zod's
  output, the tiers equal to `TYPE_TIER`, the harness and capability enums equal to
  their lists, while the Zod file exists.
- `packages/core/schema/v1.ts` follows the proto, in the same commit, until step 2
  replaces it with generated types.
- Comments are not yet written into the schemas (`description`); that is a separate PR,
  reviewed as a change receivers can see.
