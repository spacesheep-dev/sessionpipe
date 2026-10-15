# @sessionpipe/core

## 0.9.0

### Minor Changes

- 40fb6e5: A session's short id (PROTOCOL.md §3): the first 8 hex digits of `sha256("sessionpipe.session:" + harness + ":" + id)`, what a person reads in a log line, a notification or a search box. Derived, never sent. Not a prefix of the id: Codex ids are time-ordered, and four of ninety on one machine shared their first eight characters. `shortId()` in core; the worker's log and the daemon's lines that name a session use it.
- 0940788: `turn.progress` (tier 2): a turn still running goes out as it runs, not only when it ends. The prompt is sent as the turn starts, then what the assistant has said so far, at most every 20 s on a tool call and only when it changed, under the number its `turn.transcript` will carry. Over 20 000 characters the reply keeps its end. A 21-minute turn used to show nothing on its receiver for 21 minutes.

### Patch Changes

- 91265cb: A busy session's events no longer wait 6 s and go back to the queue behind its own lock. A lock whose worker is gone (its 15 s deadline ended it without a release) is taken at once instead of after 5 min; a job polls for the lock every 50 ms instead of doubling its wait, so siblings can't keep taking it in between; and the sinks drain at once, so the lock is held for the slowest round trip, not the sum of them (33 re-queues in one day's log on a machine with three sinks, 2026-10-13).
- 94c1b2f: Skip the parent's replayed history in forked Codex rollouts when reading session
  facts and transcripts. Wait for an event naming the fork's own thread, preserve
  its original transcript timestamps and cursors, and leave its title unset until
  it contains a real user ask of its own.
- 1ca23ee: No hook event is lost to a worker's 15 s deadline, and none waits for an unrelated hook. A worker used to delete its job file before running it, so one ended mid-run (a sink that hung, a lock held out) took the event with it. A job is now claimed by renaming its file and the claim is released only once its events are in the outbox; a sweep gives a claim whose worker is gone back to the queue. A job the session's lock held out used to wait in the queue for the next hook's sweep, however long that took; a fresh worker now starts for it.
- 434d10c: A machine under a flood of hook events no longer floods its sinks. One worker drains the sinks at a time; the others leave their events in the outbox for it and it sends them in full batches of 50, so four busy sessions cost a request per batch, not per event. A sink that answered 429 is not tried again by any worker before its `retry-after`, and one that could not be reached waits 2 s · 10 s · 60 s · 5 min · 30 min, then every 30 min, as HTTP.md §2 has said all along (a machine with four busy sessions was refused 828 times in two minutes and had 5 192 jobs queued, 2026-10-14). The session's lock now covers only the append, not the round trips.
- cdb1dbf: Draining a large session file no longer re-reads the rest of it for every batch: a read takes 1 MB (more only for one event longer than that), not the remaining file up to 8 MB, and counts its offset per line rather than from the start. A 10 MB session drained in batches of 50 decoded 55 MB.

## 0.8.0

### Minor Changes

- 3c5d8fb: Control's pairing request and every daemon hello name the Claude Code accounts signed in on the machine (`accounts`: `{harness, id, email}` per config dir, read again for each hello), so a receiver the person paired with can label `session.account_id` with the account's email instead of showing an id. Events are unchanged: `account_id` stays an id and no event carries an email. `sessionpipe control pair` and `connect` say which accounts they named.

### Patch Changes

- ea1d43a: Build on TypeScript 7 (`baseUrl` dropped from every tsconfig; `paths` already resolved relative to the file). Dev-only: published output is unchanged.

## 0.7.0

### Minor Changes

- 5431264: Control: messages reach Codex and Antigravity sessions too. The daemon starts a new
  session with `codex exec --json` or `agy -p … --output-format stream-json`, and resumes
  one with `codex exec resume` or `agy --conversation`, the way it drives `claude -p`:
  acked taken, the answer streamed as progress, then delivered with the reply. Both
  harnesses pick their own session ids, so the daemon records the one a start got
  (`state/control/aliases.json`) and keeps the start's id everywhere it reports the
  session: acks, later messages, and the hook events. A message sent right behind its
  start, even in the same poll, waits for it and resumes what it named. Safe mode runs
  Codex in its `workspace-write` sandbox and agy with no permission flag; auto mode passes
  `--approve-for-me` / `--mode accept-edits`; the bypass flags are never used. Hello and
  pairing advertise the harnesses installed on the machine. Core gains the runners
  (`codexControl`, `antigravityControl`), a shared headless spawner (`runHeadless`) and
  `drivableHarnesses`; the verifier accepts a `start` for any harness.

### Patch Changes

- 653245d: Codex: a session's turns and its title skip the AGENTS.md instructions Codex writes into the session as a "user" message, so a turn shows what the person asked.

## 0.6.1

### Patch Changes

- 9035be1: Antigravity: stop hooking PreToolUse. Antigravity reads a PreToolUse answer without a
  `decision` as a deny, so the `{}` sessionpipe printed blocked every tool call on every
  machine it was installed on, with no reason shown. Tool activity now comes from
  PostToolUse (a "still working" beat, since Antigravity names no tool there).
  `sessionpipe install` / `update` (and the daemon's auto-update) rewrite the old entry; a
  conversation that started before the rewrite still has it loaded, and gets an `ask` with
  a reason instead of a silent deny until it is restarted.

## 0.6.0

No changes in this release.

## 0.5.0

### Minor Changes

- 6a5cda8: `sessionpipe connect <receiver>`: one command and one approval set a machine up — hooks for every agent and every Claude Code account, a sink at tier 2 with the key the receiver hands over at pairing, signed messages, keys in the keychain, a daemon that outlives logout, 30 days backfilled. It asks nothing (safe mode unless `--mode auto`; folders from `--folder`, the folder it ran in, or where recent sessions ran — never the home folder) and a second run only fixes what's missing.
  
  - Hooks run a launcher, `~/.local/share/sessionpipe/sessionpipe-hook`, with its own copy of the hook: a Node upgrade, `nvm uninstall` or a moved npm prefix no longer silently stops reporting. Re-installs move old entries to it in place.
  - Keys (sink tokens and secrets, machine tokens) live in the macOS Keychain or a desktop session's Secret Service when one is writable, else in the 0600 files as before; `sessionpipe secrets [move keychain|secret-service|file]`. A token a locked keychain won't hand over leaves events waiting (never unsigned); the daemon drains them from your session.
  - The Linux daemon turns on systemd linger, so closing ssh no longer stops it; on a Mac with nobody at the screen it runs as a background launchd agent instead of failing.
  - Before a headless run the daemon asks Claude Code whether that account is signed in (`claude auth status`) and fails the message with what to do — on a Mac, that a keychain login can't be read with nobody logged in at the screen — instead of Claude Code's "please run /login". `connect` and `doctor` list each account's state.
  - `sink add` keeps a sink's existing key when only the tier changes (it used to drop it); pairing fills in a sink that has no key and takes `--tier`; `control pair` run from the home folder no longer allows all of it; `control.json` keeps the machine's own caps across a write.

## 0.4.2

No changes in this release.

## 0.4.1

No changes in this release.

## 0.4.0

### Minor Changes

- b5cf64b: `key.add`: a device the machine already trusts vouches for a new one (a phone with a different keychain), signed and verified like any command; the daemon adds the key to its store. Five new conformance vectors.
- 37546aa: `sessionpipe control pair` asks once, at the machine, whether sessions you message run in auto or safe mode (no more silent safe default), and `sessionpipe control mode auto|safe` changes it; the running daemon picks it up within seconds. Message text may be 20 000 characters (command 48 000): a 4 000 cap silently cut real task briefs.
- 765b95a: A receiver's well-known `control.session_tools` names MCP servers its sessions may use without asking (spacesheep names its own), so a safe-mode run answering a message can publish the page it was asked for. MCP server names only; built-in tools stay behind the person's approval rules.
- 2cd4475: Answers stream: a non-final `progress` ack carries the answer so far (whole, with a rising `seq`). The daemon streams headless runs from Claude Code's `stream-json` output (token by token) and in-place deliveries from the session's transcript (message by message); the final ack still carries the whole answer.

## 0.3.0

### Minor Changes

- 79fc0a4: Open pairing: `sessionpipe control pair spacesheep.dev` needs no key where the receiver declares `control.open_pairing`. One link, one passkey approval; the daemon proves itself on the status poll with a `poll_key` only it holds, prints which account approved, and adds the sessions key the receiver hands over as its events sink (tier 0). A bare host means https, and a `--token` with a character no key has (a pasted `ss_…` placeholder) is refused in words.

## 0.2.0

### Minor Changes

- 54820be: The control daemon (M6): `sessionpipe control pair | status | keys | off | run` and `sessionpipe wait`. One daemon per computer verifies every command against keys enrolled at its terminal and delivers it in place when it can (a parked waiter, the session's next Stop, an Agent SDK session it started), else as a headless resume or fork; Stop and PermissionRequest hooks answer only for verified messages, and only where control is paired. Claude Code's PermissionRequest hook timeout is now 130 s (re-run `sessionpipe install`). A machine caps new sessions itself (2 at once, 10 an hour, `limits` in control.json) and runs at most 3 headless Claude Code processes at once; messages are handled concurrently, one session's in order; after a receiver outage the daemon is polling again within seconds and logs `back after N s`.
- 87d9a65: Control (M6): `sessionpipe-core/control`, the one verifier for signed control commands (WebCrypto only, safe in Workers and browsers), with 60 shared conformance vectors; the control schemas rewritten for signed, per-machine delivery. The CLI ignores `sink add --control` (control is per machine) and a retried batch reuses its `webhook-id`.

## 0.1.1

### Patch Changes

- 08b5d89: READMEs carry the published (unscoped) package names.
- a360ee8: Published under unscoped names (sessionpipe-core, sessionpipe-receiver, sessionpipe-conformance) until the @sessionpipe npm org exists.
- b8b8599: Fixes from the first outside install (Yaroslav Bulatov, issues #8–#14 and advisory GHSA-8f6f-c3c9-j5p6): a config file that is not plain JSON is never written back; installs keep a file's indent and final newline and uninstall deletes files sessionpipe created; jobs that lose the session-lock race are retried and swept, never lost; Claude Code `StopFailure` → `turn.ended` with `reason: error`; `status`/`doctor` say when Gemini CLI won't run hooks (`tools.enableHooks`) and word the Codex review honestly; `doctor` measures the wall clock a harness waits; with no sink above tier 0 only one tool event per harness is hooked; the npx bootstrap installs into `~/.local` when npm's prefix is Homebrew's versioned Cellar; a bare `pass:` is no longer a secret name; the outbox holds redacted strings at rest in 0600 files under 0700 directories.

## 0.1.0

### Minor Changes

- e918475: Protocol v1 draft: the Zod source of truth (`packages/core/schema/v1.ts`) and the generated `schemas/v1/*.json`; inferred runtime types.
- c75aaa0: Core: adapters for Claude Code, Codex, Gemini CLI and Antigravity; the secrets@1 and pii@1 rulesets and the tier filter; outbox, cursors, locks; file, stdout and HTTP sinks. CLI: install, uninstall, sink, status, doctor, tail, backfill, forget, replay, update; the hook entry imports only node: builtins. Conformance: adapter fixture runner.
