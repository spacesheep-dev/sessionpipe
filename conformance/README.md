# Conformance

- `harness/<name>/*.json` — `{ input: { argv, stdin, env, files }, expect: [events] }`,
  recorded from **real** hook payloads (secrets scrubbed; `npm run fixture-scan` gates it).
  `"*"` in an expected event is a wildcard for `id` and `time`. An empty `expect` is a
  payload the adapter reports nothing for (Codex's ephemeral threads).
- `redaction/secrets.json`, `redaction/pii.json` — `[{ in, out }]` vectors for the rulesets.
- `short-id.json` — `{ harness, id, short_id }` vectors for a session's short id (spec/PROTOCOL.md §3):
  what a receiver shows and searches by must reach these.
- `delivery/*.json` — receiver scenarios: dedup, 413 split, 403 tier, retry, forget, control, pairing renewal.
  A control scenario's `enqueue` step is the receiver's own test door: the runner signs
  the message with a test key it enrolled there, and `{run}` / `{run12}` are the run id.
  A `hello` step posts its `body` as the machine's hello (`POST {control}/hello`, the
  machine's token), so a scenario can say what the machine advertised before a start.
- `remote/<harness>/*.json` — `{ request, response: { status, body }, expect }`, answers **recorded**
  from a harness's own service (scrubbed), for the facts an adapter may ask it for once the person
  turned `remote_titles` on: claude.ai's name for a Claude Code session (spec/ADAPTERS.md, the Facts
  row). `expect.title` is the name a reader must take, or `null` for none. Read by
  `packages/core/test/claude-code.test.ts`.
- `transcripts/<harness>/*.jsonl` — transcript files as the harness writes them, scrubbed, for what
  a reader must keep and skip (spec/ADAPTERS.md, the Transcript row). Read by
  `packages/core/test/transcripts.test.ts`.
- `control-vectors/*.json` — signed control commands, valid and broken, and enrollment
  proofs, each with the verdict every verifier must reach (spec/CONTROL.md §5). Run by
  `packages/core/test/control-vectors.test.ts`; `npm run vectors` writes the ones not yet
  there and keeps the rest (`SESSIONPIPE_WRITE_VECTORS=all` rewrites every one).

Filled in M1. Run with `npm run conformance`, or against a live receiver with
`npx @sessionpipe/conformance https://host`.
