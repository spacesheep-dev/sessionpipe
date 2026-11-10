# Conformance

- `harness/<name>/*.json` — `{ input: { argv, stdin, env, files }, expect: [events] }`,
  recorded from **real** hook payloads (secrets scrubbed; `npm run fixture-scan` gates it).
  `"*"` in an expected event is a wildcard for `id` and `time`. An empty `expect` is a
  payload the adapter reports nothing for (Codex's ephemeral threads).
- `tiers/<harness>.json` — what `filterEvent` returns for every expected event above at tiers 0–3, with and
  without PII, recorded ONCE from the published sessionpipe-core 0.13.3 (`scripts/tier-goldens.mjs`,
  docs/rfcs/decisions/003); `packages/core/test/tier-goldens.test.ts` holds the tree to it.
- `outbox/read.json` — byte-level read cases for the sender's outbox files (spec/OUTBOX.md §3): a partial
  trailing line, a blank line, a corrupt line, multibyte text. Run by `packages/core/test/outbox-vectors.test.ts`;
  a second implementation of the client runs the same file.
- `redaction/secrets.json`, `redaction/pii.json` — `[{ in, out }]` vectors for the rulesets.
- `short-id.json` — `{ harness, id, short_id }` vectors for a session's short id (spec/PROTOCOL.md §3):
  what a receiver shows and searches by must reach these.
- `delivery/*.json` — receiver scenarios: dedup, 413 split, 403 tier, retry, forget, and control
  (spec/CONTROL.md §11 lists each): polls and acks, open pairing, `control.session_tools`,
  `progress` acks, pairing renewal, starts, inherit, the pool, and what a `cancel` is acked
  with (stopped, not ours to stop, nothing to stop).
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
  `packages/core/test/transcripts.test.ts`; `packages/cli/test/turn-settle.test.ts` writes
  `interrupted-turn.jsonl` out a flush at a time, as Claude Code does, for when a turn is whole,
  and `packages/cli/test/delivered-turns.test.ts` replays `stop-hook-delivery.jsonl`,
  `subagent-handback.jsonl` and `copy-of-session.jsonl` a hook at a time, for whose words a
  turn's `user` side is.
- `control-vectors/*.json` — signed control commands, valid and broken, and enrollment
  proofs, each with the verdict every verifier must reach (spec/CONTROL.md §5). Run by
  `packages/core/test/control-vectors.test.ts`; `npm run vectors` writes the ones not yet
  there and keeps the rest (`SESSIONPIPE_WRITE_VECTORS=all` rewrites every one).

Filled in M1. Run with `npm run conformance`, or against a live receiver with
`npx @sessionpipe/conformance https://host`.
