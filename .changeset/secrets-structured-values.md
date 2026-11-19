---
"sessionpipe-core": patch
---

secrets@1: a string stored under a key that names a secret is redacted in structured data too

- `redactDeep({ api_key: "…" })` gives `{ api_key: "[redacted]" }`, with the exemptions an assignment has: a placeholder, a value already redacted, and a count such as `max_tokens: "4096"`. The filter walks a tool's structured `input` and `output` before it cuts them to 64 KB, so the rule holds at any size. `spec/PRIVACY.md` §2 has the row, and `conformance/redaction/secrets.json` the cases (#206).
