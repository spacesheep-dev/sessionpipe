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
  `secrets.json` also holds `deep` cases for the structured row (spec/PRIVACY.md §2): `in` and
  `out` are JSON values, and `out` gives itself.
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
- `sender-403.json` — what a sender does with a 403 (spec/HTTP.md §2, the two 403 rows):
  `{ tier, body, expect: { action, max_tier? } }`, the tier the sink sends at, the 403's body,
  and `lower-tier` to a cap below that tier, or `retry` on the 5xx backoff when there is no cap
  or it lowers nothing. Run by `packages/cli/test/sink-contract.test.ts`.
- `remote/<harness>/*.json` — `{ request, response: { status, body }, expect }`, answers **recorded**
  from a harness's own service (scrubbed), for the facts an adapter may ask it for once the person
  turned `remote_titles` on: claude.ai's name for a Claude Code session (spec/ADAPTERS.md, the Facts
  row). `expect.title` is the name a reader must take, or `null` for none. Read by
  `packages/core/test/claude-code.test.ts`.
- `transcripts/<harness>/*.jsonl` — transcript files as the harness writes them, scrubbed, for what
  a reader must keep and skip (spec/ADAPTERS.md, the Transcript row). Read by
  `packages/core/test/transcripts.test.ts`; `codex/picture-attached.jsonl` (a rollout recorded on
  codex-cli 0.171.0 with a picture on its start and on its resume; Codex's own instructions are
  replaced by a note of their length, the folders by neutral ones) by
  `packages/core/test/codex-transcript.test.ts`, for the title and the asks without Codex's picture
  wrapper; `packages/cli/test/turn-settle.test.ts` writes
  `interrupted-turn.jsonl` out a flush at a time, as Claude Code does, for when a turn is whole,
  and `packages/cli/test/delivered-turns.test.ts` replays `stop-hook-delivery.jsonl`,
  `subagent-handback.jsonl` and `copy-of-session.jsonl` a hook at a time, for whose words a
  turn's `user` side is. `stop-block.jsonl` is what Claude Code records around a Stop hook's
  block that carries a control message (spec/CONTROL.md §6 `prompt`): which of its words are
  the reply to that message is held by `packages/cli/test/control-reply.test.ts`, as is
  `stop-hook-ask.jsonl`, the same block carrying another session's ask (§13): the answer is
  found by the mark in the ask's paragraph, and a reader gives that paragraph back plain.
- `control-held.json` — whether a Claude Code session is held, and by what (spec/CONTROL.md §6,
  *What counts as held*): `{ rows, written_ms_ago, ended_ms_ago?, turn_ms_ago?,
  strayed_ms_ago?, expect }`, the registry rows that name it, when its transcript was last
  written, when a run of it is known to have ended, when its own hooks last spoke of a turn
  running in it, and when a run that was asked to copy it and may have run in it ended. Run by
  `packages/cli/test/control-daemon.test.ts`.
- `control-session-ids.json` — which Claude Code session an id names (spec/CONTROL.md §6):
  `{ filed, asked, found, taken }`, the transcripts in a project folder, the id a command
  names, the file that is that session's (its exact name, or none), and whether the id is
  taken for a new session (in any spelling). Run by `packages/core/test/claude-control.test.ts`.
- `control-attention.json` — when an open attention is over without an `attention.cleared`
  (spec/CONTROL.md §7): `{ asked: { attention_id, agent_id? }, event: { type, agent_id?,
  call_id?, background?, after_ms }, closes }`, the question, a later event of its session,
  and whether that event ends it. A receiver runs it to know when to stop showing Allow /
  Deny; the reference daemon lets go of the prompt's hook by the same answers. Run by
  `packages/cli/test/control-attention.test.ts`.
- `control-acp-mode-env.json` — what an ACP agent's process is given for the machine's mode
  (spec/ADAPTERS.md, *Agents driven through ACP*): `{ harness, mode, env }`, the environment added
  for that run only (`{}`: nothing, the agent's own default). Run by
  `packages/core/test/acp-control.test.ts`.
- `turn-end-once.json` — Codex says a turn's end by its `Stop` hook and by its notify when both
  are installed (spec/ADAPTERS.md, *Codex*, Mapping): `{ ends, reported }`, the ends as the
  harness says them, each `[road, turn id]`, and the `turn.ended` events that go out. Run by
  `packages/cli/test/run-turn-end-once.test.ts`.
- `control-busy-window.json` — when a message waits a moment for a window's hooks before it
  is routed (spec/CONTROL.md §6.3): `{ look, hooks_heard, has_copy, asked_before, expect }`, why
  the window's inbox was no way in, whether its hooks report to the machine, whether the window
  is the session's copy's, whether the message has waited already, and `waits` or `routes`. Run
  by `packages/cli/test/control-daemon.test.ts`.
- `control-cancel-waits.json` — when a `cancel` waits before it acts (spec/CONTROL.md §6
  `cancel`): `{ in_hand, coming: [{ kind, session, signed_ms, ready }], expect }`, what is the
  machine's to stop already, what has arrived and is not in hand yet, and `waits` or `acts`.
  Run by `packages/cli/test/control-daemon.test.ts`.
- `control-file-retry.json` — whether a machine tries a command's file again after a try at it
  failed (spec/CONTROL.md §6 `start`, *Files*): `{ failure, status?, expect }`, how the try
  ended and `retries` or `fails`. Run by `packages/cli/test/control-files.test.ts`.
- `control-hello-at-once.json` — whether a running machine says hello at once when the person
  changes its settings at the machine (spec/CONTROL.md §2): `{ change, expect }`, what was done
  (a receiver paired or removed, the folders, mode, name or asking changed, or nothing) and
  `hello` or `none`. Run by `packages/cli/test/control-poll.test.ts`.
- `control-pictures.json` — which of a command's files is a picture, and which pictures each harness
  is given natively besides the text's list (spec/CONTROL.md §6 `start`, *Pictures*; spec/ADAPTERS.md):
  `facts` is `{ name, type, bytes, expect }`, a file's signed type, its bytes in base64 (as much as
  its header needs) and `{ type, width, height, animated }` or null for a file the text lists and
  nothing more; `takes` is `{ harness, why, picture, expect }`, a picture as saved and whether that
  harness (`codex`, `acp` for an agent that says it takes images, `claude-code-sdk`, `claude-code`,
  `antigravity`) is given it. Run by `packages/core/test/pictures.test.ts`.
- `control-marks.json` — what a machine names a message by when it hands it to a live session
  (spec/CONTROL.md §6 `prompt`): `{ id, mark, channel }`, the receiver's unsigned `id`, the mark
  it makes for a frame and for a channel's tag, and null for every id that is not a whole ULID.
  Run by `packages/core/test/frames.test.ts` and `packages/cli/test/control-reply.test.ts`.
- `control-order.json` — the order a machine delivers one session's control messages in
  (spec/CONTROL.md §6 `prompt`): `{ steps: [{ arrive | done | drop }], expect: [ids] }`, a
  poll's messages arriving together, the running one finishing, one being refused. Run by
  `packages/cli/test/control-line.test.ts`; a second implementation of the machine runs the
  same file.
- `control-vectors/*.json` — signed control commands, valid and broken, and enrollment
  proofs, each with the verdict every verifier must reach (spec/CONTROL.md §5). Run by
  `packages/core/test/control-vectors.test.ts`; `npm run vectors` writes the ones not yet
  there and keeps the rest (`SESSIONPIPE_WRITE_VECTORS=all` rewrites every one).

Filled in M1. Run with `npm run conformance`, or against a live receiver with
`npx @sessionpipe/conformance https://host`.
