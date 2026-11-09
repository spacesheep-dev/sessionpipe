# proto/ · the one definition

`sessionpipe/v1/*.proto` is the source for the protocol's shapes (RFC 0001). Today it
generates `schemas/v1/*.json`; the next steps generate the TypeScript types, the CLI's
commands and the documentation from the same files.

| File | Holds | Generates |
|---|---|---|
| `sessionpipe/v1/events.proto` | the envelope (`Event`), `Session`, `Harness`, `Privacy`, one message per event type, `EventData` | `event.json`, `event-data.json` |
| `sessionpipe/v1/http.proto` | the well-known file, the batch and the receiver's answers | `well-known.json`, `batch.json`, `batch-response.json`, `error.json` |
| `sessionpipe/v1/control.proto` | the signed command, its carrier, acks, pairing, hello | `control*.json` |
| `sessionpipe/v1/options.proto` | the few facts a type and its rules can't say (§ below) | |
| `buf/validate/validate.proto`, `google/api/field_behavior.proto` | vendored, Apache-2.0: protovalidate's rules and Google's `REQUIRED` | |

```sh
npm run schemas            # buf lint, then write schemas/v1/ and packages/core/gen/v1.ts from the proto
npm run schemas -- --check # what CI runs: exit 1 when a committed schema differs
```

`tools/doors/src/` is the generator, strict TypeScript under the repository's 100 % coverage
rule: `buf.ts` runs buf, `read.ts` reads the descriptors and our options, `jsonschema.ts`
writes the schemas (the mapping is in its header), `types.ts` writes `packages/core/gen/v1.ts`
(decision 002), `main.ts` is the command; `tools/doors/schemas.mjs` bundles and runs it on
any Node the matrix has. The generated files are committed; a change to the protocol is a
change to a `.proto`, then `npm run schemas`, then one commit with all of it.

## Writing a message

- **Every message, field, enum and value has a comment**, written for the person who
  will read it on the website, in `--help` and in a generated type's doc string
  (`buf lint` fails without one). One sentence, the first standing alone.
- **A field that must be present** carries `(google.api.field_behavior) = REQUIRED`.
  Everything else may be left out. (Not protovalidate's `required`: on a proto3 scalar
  that means "not the zero value", which would make `pii: false` invalid.)
- **Limits are `buf.validate` rules**: `string.min_len`, `max_len`, `pattern`, `const`;
  `int32.gte`, `lte`, `const`, `in`; `repeated.min_items`, `max_items`, `unique`,
  `items`; `map.max_pairs`, `keys`.
- **The key on the wire is the field name** (snake_case), never protobuf's camelCase
  default; `json_name` only where the key isn't a legal field name (`EventData`'s
  dotted types).
- **Enum words** are the value's name in lowercase without its prefix; `word` says
  otherwise (`first-ask`, `permission.answer`). The zero value is never on the wire.
- **Integers**: `int32` where the value provably fits, `int64` for epoch milliseconds,
  durations, sizes and sequence numbers. Both are JSON integers up to 2^53 − 1 on the
  wire.
- **`sessionpipe.v1` options** (`options.proto`): `format` (date-time, uri), `nullable`
  (JSON `null` allowed, same as absent), `default_json` (what absence means), `open` (a
  message keeps extra keys), `strict` (refuses them), `either` (one of its fields'
  shapes, carried bare, for the closed unions a signature or a key is), `tier` (the
  lowest tier that carries an event type), `word` (an enum value's spelling).

## Versioning

`buf breaking` with `WIRE_JSON` runs against the PR's base: a field removed, retyped or
renamed on the wire fails CI, which is `spec/VERSIONING.md`'s "additive only" made
mechanical. The protocol integer stays 1; a v2 would be a new package `sessionpipe.v2`.

Three rules the checker can't fully see, so they are written here (the first two are
spacesheep's SSAPI-2 rules, adopted):

- **Add, don't change.** A field whose type or meaning must change gets a new name and
  a new number; the old field stays, marked `[deprecated = true]` with the date in its
  comment, for the 12 months `VERSIONING.md` gives a deprecation.
- **Never reuse a number or a name.** When a deprecated field is finally removed, its
  number and its name go into a `reserved` statement in the message, so no later field
  can take either and an old reader can never misread a new one.
- **Readers keep what they don't know.** An event's `data` and every `open` message
  carry extra keys through; a receiver stores an unknown event type. Only a `strict`
  message refuses unknown keys, and only where a kind added later must be refused by a
  reader that predates it (a key record, a signature).
