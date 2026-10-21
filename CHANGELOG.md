# Changelog

Per-package changelogs are written by Changesets into each `packages/*/CHANGELOG.md`
and released in lockstep. This file records protocol-level changes.

## Unreleased

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
