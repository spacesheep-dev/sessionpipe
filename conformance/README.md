# Conformance

- `harness/<name>/*.json` — `{ input: { argv, stdin, env, files }, expect: [events] }`,
  recorded from **real** hook payloads (secrets scrubbed; `npm run fixture-scan` gates it).
  `"*"` in an expected event is a wildcard for `id` and `time`.
- `redaction/secrets.json`, `redaction/pii.json` — `[{ in, out }]` vectors for the rulesets.
- `short-id.json` — `{ harness, id, short_id }` vectors for a session's short id (spec/PROTOCOL.md §3):
  what a receiver shows and searches by must reach these.
- `delivery/*.json` — receiver scenarios: dedup, 413 split, 403 tier, retry, forget, control, pairing renewal.
  A control scenario's `enqueue` step is the receiver's own test door: the runner signs
  the message with a test key it enrolled there, and `{run}` / `{run12}` are the run id.
- `control-vectors/*.json` — signed control commands, valid and broken, and enrollment
  proofs, each with the verdict every verifier must reach (spec/CONTROL.md §5). Run by
  `packages/core/test/control-vectors.test.ts`; regenerate with `npm run vectors`.

Filled in M1. Run with `npm run conformance`, or against a live receiver with
`npx @sessionpipe/conformance https://host`.
