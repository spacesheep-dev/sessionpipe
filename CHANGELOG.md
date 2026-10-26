# Changelog

Per-package changelogs are written by Changesets into each `packages/*/CHANGELOG.md`
and released in lockstep. This file records protocol-level changes.

## Unreleased

- `turn.started` can say who started the turn (PROTOCOL.md §4; PRIVACY.md §1;
  ADAPTERS.md). Two new OPTIONAL tier-0 fields: `submitted_by`, the harness's **own** word
  for who submitted the prompt, forwarded verbatim and never mapped onto a vocabulary of
  this spec (a bare word, `[A-Za-z0-9][A-Za-z0-9_.-]{0,39}`, because tier 0 is not
  scrubbed; a different vocabulary from `session.started.source`, which a receiver MUST NOT
  merge with it); and `injected`, `true` when the prompt **text** is a block the harness
  wrote rather than words a person typed. `injected: true` says only that the prompt is not
  the person's words — never that no person caused the turn, since a harness may deliver a
  person's message inside such a block. A receiver MUST read an absent field as unknown,
  MUST keep a `submitted_by` it does not recognise, and MUST NOT let a second `turn.started`
  for a `turn_id` it already accepted reclassify that turn. Claude Code fills `injected`
  from a closed list of its own wrappers and would fill `submitted_by` from
  `UserPromptSubmit.source`, which no build in the field sends yet; fixture
  `conformance/harness/claude-code/user-prompt-submit-injected.json`. Additive: a receiver
  that does not know the fields keeps them as extra keys on `data`.
- `session.attended`: whether a person attends the session (PROTOCOL.md §3, §5; PRIVACY.md
  §1; ADAPTERS.md). A new OPTIONAL tier-0 boolean in the session block, in the harness's own
  word: `true` when a person is at the session or drives it from one of the harness's own
  clients, `false` for a run nobody watches. A receiver MUST read an absent field as unknown,
  never as `false`. Claude Code fills it from `CLAUDE_CODE_SESSION_ATTENDED`, counting a
  control turn and a session with a link (its Remote Control bridge or the desktop app) as
  attended, because every headless run says `0`, a Remote Control session included. The hook
  carries `CLAUDE_CODE_SESSION_ATTENDED` and `SESSIONPIPE_CONTROL_JOB` into the job, and the
  worker reads those and `CLAUDE_CODE_HOST_SESSION_ID` from the job alone, never from its own
  environment. Additive: a receiver that does not know the field ignores it.
- Control: a `start` may carry `files` (CONTROL.md §3.1, §6; HTTP.md §1, §3; still
  Draft). Up to 10 files, 25 MiB each and 50 MiB together, each named in the signed
  command by its SHA-256 (base64url), so a receiver cannot swap one. The receiver
  holds the bytes and serves them at `GET {control}/files/{sha256}` with the machine's
  token; the machine stops reading past the signed size, checks length and hash,
  writes them under `<cwd>/.sessionpipe/files/<session id>/` (self-ignoring
  `.gitignore`, no symlinks followed, mode 0600) and starts the session — of any
  harness it can start — with the text plus the list of relative paths. Any file
  problem acks `failed` with code `file` and starts nothing. `files` on another kind,
  `null` or empty is `bad_fields`. Schemas: `control-command` gains `files`;
  `control-pair` and `control-hello` gain `files: true` (the machine takes attachments
  — a receiver should not send files to one that doesn't say so); the well-known
  `control` object may say `files: true`. 24 new control vectors (`66`–`89`).
- `turn.ended` gains `background` (tier 0, optional): how much background work the
  harness reports still in flight as the turn ends, each piece of which wakes the session
  when it finishes. A receiver may keep such a session under working instead of reading
  "done" (PROTOCOL.md). Claude Code fills it from the Stop hook's `background_tasks`,
  in every Stop recorded since 2.1.258. Conformance: `harness/claude-code/stop-background.json`
  (a background shell command running, 2.1.305); `stop.json` now pins `background: 1` (an
  Explore subagent still running) and `stop-2.json` `background: 0`. Additive: a receiver
  that doesn't know the field keeps it and carries on.
- Control: `start` is no longer Claude Code's alone (CONTROL.md §6; asked for by the
  maintainer on 2026-10-04, so the spec change ships with its code). A `start` names a
  session of any harness the machine can drive headlessly — the reference daemon drives
  Claude Code, Codex (`codex exec`) and Antigravity (`agy -p`) and lists them in its
  hello — and `resume` covers Codex (`codex exec resume`) and Antigravity
  (`agy --conversation`). New rule: a machine whose harness names its own sessions
  keeps the command's id as the session's name in everything it reports (acks, later
  prompts, hook events); a prompt for a session whose start is still running waits for
  it. Conformance: `control-vectors/53-start-other-harness.json` (a Codex start) now
  verifies, where it was refused `bad_fields`. ADAPTERS.md: Codex and Antigravity gain a
  Control row, and Antigravity's row no longer lists the PreToolUse hook 0.6.1 removed.
- Control rewritten before anyone implemented it (CONTROL.md, HTTP.md §3; still
  Draft, milestone M6). The old draft let whoever held a bearer token prompt an agent
  and answer "allow"; now:
  - **Every command is signed** on the person's device — a passkey vouches for a day
    key, the day key signs each command (or one passkey confirm per command) — and
    **verified on the machine** against keys enrolled at its own terminal
    (`sessionpipe control pair`). A receiver carries and may pre-check; it can never
    forge. One verifier, `sessionpipe-core/control` (WebCrypto only), and
    `conformance/control-vectors/` (60 vectors) that every verifier must agree with.
  - **One poll per machine**, not per session: `GET {control}?machine=…` with the
    machine's own token, minted at pairing; the command names its session
    (`<harness>:<id>`). New: `POST {control}/pair`, `GET {control}/pair?code=`,
    `POST {control}/hello`, `POST {control}/off`.
  - **Six delivery modes**, first fit wins (`sdk`, `waiter`, `turn`, `api`, `resume`,
    `fork`), acked with the mode used; new kind `start`; new outcome `refused` with a
    `code`; acks may carry `reply`.
  - Schemas: `control.json` is now the carried envelope (`cmd`, `csig`, `grant`,
    `confirm`); new `control-command`, `control-grant`, `control-key`, `control-pair`,
    `control-pair-started`, `control-paired`, `control-hello`; `control-ack` gains
    `mode`, `session`, `code`, `reply`; the well-known `control` object gains
    `signing` (`rp_id`, `algs`).
  - Limits fixed where the two implementations it came from disagreed: nonce 22–64
    base64url, text ≤ 4 000 characters, command ≤ 12 000, session id per adapter.
- Fixed contradictions: a sink never carries `control` (the CLI's `sink add --control`
  is now ignored with a pointer to `control pair`); sessionpipe.org no longer says
  spacesheep runs "with control"; CONTROL.md's six delivery scenarios all exist
  (09–14); Gemini CLI's AfterAgent is in the Stop-block list; attention ids are
  specified as the adapters mint them; a retried batch reuses its `webhook-id`
  (derived from the events' ids); SECURITY.md and CONTRIBUTING.md name the one
  exception to "the hook never alters the harness" — a verified control message — and
  exempt the PermissionRequest wait from the 150 ms hook budget.
- Protocol v1 (Draft): envelope, event vocabulary, tiers 0–3, HTTP binding,
  discovery, control channel. See `spec/`.
