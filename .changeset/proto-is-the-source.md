---
"sessionpipe-core": patch
---

The protocol's JSON Schemas (`schemas/v1/*.json`) are generated from `proto/sessionpipe/v1/*.proto`, the protocol's one definition (RFC 0001, step 1), byte-identical to what the Zod source produced. The Zod file stays this release and is held equal to the proto by a test; nothing on the wire changes.
