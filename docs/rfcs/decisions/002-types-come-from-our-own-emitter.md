# 002 · The TypeScript types come from our own emitter, not protobuf-es or ts-proto

- **Status:** Accepted
- **Decided:** 2026-11-09, RFC 0001 step 1

## Context

Step 2 replaces the Zod-inferred types in `sessionpipe-core` with types generated from the
proto. The GUI and every package import those types by name and read fields by their wire
names. Three facts about the wire rule out the standard generators:

| The wire | protobuf-es | ts-proto | Our emitter |
|---|---|---|---|
| keys are snake_case (`title_source`) | camelCase, no switch | `snakeToCamel=false` | the field name |
| every integer is a JSON number up to 2^53 − 1 | `int64` is `bigint` | `forceLong=number` | `number` |
| an enum is its word on the wire (`first-ask`, `permission.answer`) | the value's name | the value's name | the word, from `word` or the name |
| `sessionpipe-core` has zero runtime dependencies | needs `@bufbuild/protobuf` | needs `protobufjs` unless `onlyTypes` | types only, no runtime |
| a `const` rule is a literal type (`protocol: 1`) | no | no | yes |
| an `either` message is a union carried bare | a wrapper object | a wrapper object | `A \| B` |

Two of ts-proto's flags get close, but none of the three generators can say an enum's wire
word or a literal type, and both would change what the GUI imports.

## Decision

`tools/doors/src/types.ts` emits `packages/core/gen/v1.ts` from the same descriptors the schemas
come from: one `interface` per message (`type … & Record<string, unknown>` for an `open` one), a
union of words per enum, a union per `either`, `?: T | undefined` for every field not marked
REQUIRED, `| null` for `nullable`, literal types for `const` and `in` rules, `unknown` for
`google.protobuf.Value`, `Record<string, unknown>` for `Struct`, and every proto comment as a
doc comment. About 120 lines, no runtime, generated and committed beside the schemas by
`npm run schemas`, checked by `--check`.

`tools/doors/test/types.test.ts` holds each generated type equal to the Zod-inferred one with
`expectTypeOf`, so `npm run typecheck` fails on any difference while both exist.

## What follows

- Step 2 switches `packages/core/src/types.ts` to `export type * from "../gen/v1.js"` and deletes
  the Zod file and both parity tests. The GUI sees the same names and shapes.
- A Rust or Swift reader (RFC 0002, the GUI's native apps) uses prost or swift-protobuf on the
  same proto; the wire words for enums come from `word`, which those generators read as an
  option. That is their generator's concern, not this emitter's.
- If protobuf-es ever gains wire-word enums and proto-name keys, this emitter can go.
