# 003 · The tier goldens are recorded once, from the published 0.13.3

- **Status:** Accepted
- **Decided:** 2026-11-09, RFC 0001 step 1

## Context

RFC 0001 §6 gate 2 asks for goldens: what the released client emits, recorded before the proto
touches anything, so every later change is held to it. The adapter fixtures, redaction vectors
and control vectors already are such goldens. What no fixture recorded was `filterEvent`'s
output per tier, and step 2 makes the `tier` options in the proto drive that function.

## Decision

`conformance/tiers/<harness>.json` holds, for every expected event in `conformance/harness/**`,
what `filterEvent` returns at tiers 0 to 3, with and without the PII ruleset: eight cases per
event, 66 events across the five harnesses, from `sessionpipe-core@0.13.3` installed from npm, not from this tree.
`scripts/tier-goldens.mjs` records them and refuses to overwrite a file that exists.
`packages/core/test/tier-goldens.test.ts` holds the core in this tree equal to them.

The files say `recorded_from` so a reader knows the reference. Re-recording is a deliberate
deletion in a PR that explains why the filter's output may change, which is a protocol change
and carries its own fixture.

## What follows

- Step 2 can move `TYPE_TIER` and the per-field allow lists into the proto with a mechanical
  proof that nothing a receiver sees changed.
- A new event type adds its fixture and, with it, its rows in the goldens; the recorder appends
  for a fixture that has no golden yet (a later change to the script, when first needed).
