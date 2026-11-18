---
"sessionpipe-core": minor
---

Core reads the proto (RFC 0001, step 2). Its types are the generated ones (`packages/core/gen/v1.ts`, same names and shapes); the filter's tables, which event types exist, the tier each is first carried at, the data keys each tier carries and the session keys, come from the proto's `tier` and `at_tier` options instead of hand-kept copies. The Zod source is gone, and `zod` with it from every package. `sessionpipe-core/schema` now exports the protocol's JSON Schemas as objects (`SCHEMAS`), a dependency-free checker for them (`validate`, `problems`, `dataSchema`) and the registry (`KNOWN_TYPES`, `TYPE_TIER`, `HARNESS_NAMES`, `PROTOCOL`) instead of Zod schemas. Nothing on the wire changes; the tier goldens hold the filter's output byte for byte.
