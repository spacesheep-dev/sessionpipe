# 004 · The filter reads the proto; the Zod file goes; `sessionpipe-core/schema` is the schemas and a checker

- **Status:** Accepted
- **Decided:** 2026-11-18, RFC 0001 step 2

## Context

After step 1 the proto generated the schemas and the types, but core still read its own copies
of the type registry: `TYPE_TIER` and the per-tier data allow lists in `filter.ts`, the session
keys, the harness list, and the Zod file for its types. Step 2 is where those become the
proto's. The Zod file had no runtime caller left in any package (the receiver and the GUI
validate by hand); it was imported by `types.ts` for inference, by the conformance script to
check fixtures, and by a few tests. `packages/receiver` and `packages/conformance` declared
`zod` as a dependency and never imported it.

## Decisions

- **Field tiers live in the proto.** A data field first carried above its message's tier says
  so with `(sessionpipe.v1.at_tier)`; `native` says `unfiltered`, since its data is carried whole.
  The generator writes `packages/core/gen/registry.ts`: `PROTOCOL`, `KNOWN_TYPES`, `TYPE_TIER`,
  `DATA_ALLOW` (the keys per tier, in the definition's order, which is the order the filter
  wrote them before), `SESSION_KEYS`, `HARNESS_NAMES`. `filter.ts` reads those and keeps no
  table of its own. The tier goldens (decision 003) hold the output byte for byte.
- **Core's types are the generated ones.** `types.ts` re-exports `gen/v1.ts`; `EventType` is
  `keyof EventData`, `Tier` and `DataOf` stay. Every name the GUI imports is unchanged.
- **The Zod file is deleted, and `zod` with it**, from every package. `sessionpipe-core/schema`
  now exports the JSON Schemas as objects (`SCHEMAS`, generated into `gen/schemas.ts`, the same
  bytes as `schemas/v1`), a checker for exactly the keywords the generator writes
  (`problems(schema, value)`, `validate(name, value)`, `dataSchema(type)`; a page of code, no
  library, a keyword it doesn't know is a problem and never a pass), and the registry. The
  conformance script and the tests that validated with Zod use these.
- **`TYPE_TIER` keeps its public type**, `Readonly<Record<string, Tier>>`, so a receiver that
  indexes it with a string (the GUI does) compiles unchanged.

## What follows

- Both parity tests from step 1 are gone with the Zod file; `npm run schemas -- --check` and
  the goldens are the gate now.
- A receiver in TypeScript can validate with `validate("event", e)` instead of writing its own
  envelope check. The GUI's hand-written one stays until its owner chooses.
- `sessionpipe-core/schema` is a changed public surface: a minor bump, named in the changeset.
