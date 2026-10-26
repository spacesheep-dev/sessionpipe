# Changelog

Per-package changelogs are written by Changesets into each `packages/*/CHANGELOG.md`
and released in lockstep. This file records protocol-level changes.

## Unreleased

### For receivers (0.10.0)

What a 0.10.0 daemon or hook sends, what it accepts, and how a receiver adopts it while
some machines still run 0.9.0 (a hello says which). Everything is additive on protocol 1
except the first item, which tightens what a machine accepts, on purpose.

- **The command field set is closed** (CONTROL.md §3.1). Each kind carries the fields its
  table row names, plus `v`, `t`, `machine`, `kind`, `session`, `nonce`, `iat` and
  `note`. Any other field inside the signed `cmd` is refused `bad_fields`, by the
  verifier and on the machine; 0.9.0 ignored it. A receiver keeps its own data (a
  `match`, an `origin`) beside `cmd`, never inside it, so a field a machine doesn't know
  fails closed.
- **`mode: "inherit"`** (CONTROL.md §2) in a pairing request and a hello. The machine
  passes no permission flag, so each harness runs as the person's own sessions there do:
  Claude Code in its settings' `permissions.defaultMode`, `bypassPermissions` included,
  and Codex as its `config.toml` says. A start that names no level runs that way. A
  receiver shows the machine as `inherit`, on its pairing page and wherever it shows a
  mode, and never as `safe` or `auto`; an unknown mode is unknown, not safe.
  **The gate:** a 0.10.0 machine pairs in `inherit`, or switches to it, only with
  receivers whose well-known file says `control.inherit: true` (HTTP.md §1). Elsewhere
  the person is told "`<receiver>` doesn't know inherit mode yet; it would show this
  machine as safe while the sessions you message run with no permission flag", and the
  machine keeps its mode. A receiver sets the flag once it shows the mode truthfully and
  accepts `mode: "inherit"` in `/pair` and `/hello` (conformance `delivery/23`).
- **The refusal code `mode` is now `permission`** (CONTROL.md §5), beside a new
  `refused` `model`, and `failed` `model` when the harness rejects a start's model. A
  0.9.0 machine still says `mode`, so a receiver maps both; `detail` always has the
  words.
- **New hello fields** (CONTROL.md §2). `start`: per harness, the `permissions` a start
  may name there (among `read`, `safe`, `edits`, `auto`, already capped by the mode; on
  an `inherit` machine at most `safe`), the default `permission` (which may be
  `inherit`), and `models` / `any_model`. `prompt_files: true`: the machine takes `files`
  on a `prompt`. `files: true` is as in 0.9.0. There is **no `home`**: no hello names the
  machine's home folder, which would tell every receiver the OS user name. Instead a
  start's `cwd` may be `~` or `~/…`, the way events write a session's folder, and the
  machine reads it under its own home. `harnesses` lists at most 20 (Claude Code, Codex
  and Antigravity first), and `modes` include `api` whenever an ACP agent is listed.
- **Acks carry `applied`** (CONTROL.md §6, §10): a start's `taken` and `delivered` say
  what it runs with, `{"permission": …, "model"?: …}`, where `permission` may be
  `inherit`. A receiver shows `applied`, never what was asked; a delivered start with no
  `applied` reached a machine that ignored the options.
- **New event fields** (PROTOCOL.md; all optional, tier 0): `session.attended`,
  `turn.ended.background`, `turn.started.submitted_by` and `injected`,
  `session.launched_by`, and `session.account_id` `api-<16 hex>` for a Claude Code home
  on another API, named in the pair and hello `accounts[]` by `name` (the host) with no
  `email`. A receiver that doesn't know them keeps them as extra keys.
- **ACP harnesses** (CONTROL.md §6, ADAPTERS.md "Agents driven through ACP"): a hello's
  `harnesses` may name any agent from the ACP registry that is installed (`gemini-cli`,
  `opencode`, `goose`, `cursor`, `copilot-cli`, `droid`, `qwen-code` and more); their
  turns are acked in delivery mode `api`, and an ack's `session` may be
  `<acp-harness>:<id>`. They take no start options. A receiver shows a harness it has no
  label for by its raw name.
- **Device keys** (CONTROL.md §2, §3.2; HTTP.md §1). A desktop or phone app whose web
  view can't run WebAuthn signs with a P-256 key held in hardware and verified each use,
  `{id, alg: -7, spki, type: "device", store: "hardware", uv: "each-use"}`, and its
  signature is `{cred, sig}` (plus `str` in a grant) where a passkey's `{cred, ad, cd,
  sig}` would stand. A 0.10.0 machine says `key_types: ["passkey","device"]` in its
  pairing request and every hello. **To accept device keys**, a receiver stores and
  carries such a key whole, all six fields, in a pairing's `key` and in a `key.add`'s
  `key` (never trimmed to `id`, `alg`, `spki`); passes a `{cred, sig}` grant, confirm or
  pairing proof through as it came; and says `control.signing.key_types:
  ["passkey","device"]` in its well-known file. A device key reaches a machine only as a
  passkey does: approved at the terminal's pairing code, or by a `key.add` that a key the
  machine already trusts signed. **A receiver that doesn't know device keys keeps
  working:** with no `key_types` it is passkeys only, an app offers it none, and nothing
  about passkeys changed.

Adopting 0.10.0 while machines still run 0.9.0:

- Send `permission` or `model` on a start only when the last hello's `start[harness]`
  lists that level in `permissions`, or has `any_model` or `models`. A 0.9.0 machine
  ignores both in silence and runs at its own mode.
- Send `files` on a `prompt` only to a machine whose hello says `prompt_files: true`; a
  0.9.0 machine refuses the prompt `bad_fields`.
- Send a `~` folder as a start's `cwd` only to a machine whose hello carries `start`;
  give any other an absolute one (from `folders`).
- Never sign `inherit` as a command's `permission`: it only ever comes from the machine.
- Read an absent `attended`, `background`, `submitted_by`, `injected` or `launched_by`
  as unknown: never `false`, `0` or "a person". Keep a `submitted_by` you don't know.
- Offer a device key for a machine only when its latest hello lists `device` in
  `key_types`. A 0.9.0 machine would store it as a passkey and refuse every signature it
  makes (vector `122`).
- Gate per machine on its latest hello, cloud boxes included: one asleep on an old
  snapshot may still poll on 0.9.0.
- A receiver that pre-checks commands with a copy of the verifier re-vendors 0.10.0's
  `sessionpipe-core/control` and its vectors (`69` is now `files-on-permission-answer`;
  `90`–`136` are new; `verifyAssertion` now takes the signature's purpose).

### Protocol changes

- Control: **device keys** (CONTROL.md §2, §3.2, §5, §11; HTTP.md §1; still Draft). An
  app whose web view can't run WebAuthn (a desktop or phone app) signs with a P-256
  key held in hardware and verified each use: `{id, alg: -7, spki, type: "device",
  store: "hardware", uv: "each-use"}`, its id the SHA-256 of its SPKI. Its signature
  is `{cred, sig}` (plus `str` in a grant), raw r‖s over
  `sessionpipe.device.v1⏎<purpose>⏎<rp id>⏎<challenge>`, purposes `grant`, `confirm`
  and `pair`; the challenge is the one a passkey would sign, so the day grant, confirms,
  pairing and `key.add` work unchanged. A machine verifies by its own record of the key,
  never the message. No new refusal codes. Machines advertise `key_types` in the pairing
  request and every hello, receivers in `control.signing.key_types`; a client offers a
  device key only where both list `device`. A `key.add` key is now checked like an
  enrollment (an SPKI the machine can import, and every device rule), `bad_fields`
  otherwise, so an unimportable key is never stored. Key fields are closed: a passkey
  carries `id`, `alg`, `spki` only. Schemas: `control-key` is a closed `oneOf`
  (passkey | device), `control-command` and `control-paired` use it, grant, confirm and
  pairing proof take either signature shape, `control-pair`, `control-hello` and the
  well-known `control.signing` gain `key_types`. 26 new control vectors (`111`–`136`).
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
- Protocol: `session.launched_by` (PROTOCOL.md §3): the session that started this one, as
  `<harness>:<id>`, read from `SESSIONPIPE_LAUNCHED_BY` in the hook's environment. A script
  that runs `claude -p` for a session sets it, and a receiver can group the run under its
  launcher without reading it as a subagent, which `parent_id` would say (#65). A subagent
  keeps its `parent_id` and gets no `launched_by`; a launcher that starts a further session
  resets the variable, so it names the nearest launcher only.
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
