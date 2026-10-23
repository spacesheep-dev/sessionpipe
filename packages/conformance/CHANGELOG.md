# @sessionpipe/conformance

## 0.9.0

### Minor Changes

- d525320: A `devin` adapter: Devin CLI (Cognition) sessions are reported like any other harness. `sessionpipe install` (or `--devin`) writes the eight event names Devin accepts into the `hooks` key of its user config file; the payload maps to the protocol's events, the folder comes from `DEVIN_PROJECT_DIR` (nothing in the payload names it), and tier 2, the model, the title and the times are read read-only from Devin's own SQLite session store — through a new `readers/sqlite.ts` that works on Node 20 too (in-process `node:sqlite`, else a short child process, else the `sqlite3` CLI, else no turns). Eight fixtures recorded from real runs on 3000.11.3. Also: the `claude-code` adapter now drops a payload with no `transcript_path` and a non-UUID session id — that is another harness running our entry in `~/.claude/settings.json`, not Claude Code — and the worker logs a dropped event instead of discarding it in silence when no adapter owns its harness name.
- 3fd0041: Review fixes to the Devin adapter and two gaps it exposed.
  
  `devin`: a turn is now timed by the message's own `metadata.created_at`, not by `message_nodes.created_at` — that column is the time the row batch was last **saved**, one value for the whole chain, rewritten on every save and not monotonic along it, so every turn of a session was reported at the same wrong instant. The chain read is now bounded by the cursor and caps from the newest end: past 4000 nodes the old query kept the 4000 **oldest** and then delivered nothing ever again, and every Stop re-read the chain's root (a 17 kB system prompt and four more system blocks). `installed()` reports `inactive`, not `current`, when the config file holds any event name Devin does not know — Devin then loads no hooks from that file at all, ours included — and `install()` says so too. A `tool_response` that is not an object no longer loses its output. `facts()` takes the hook's environment (new optional argument on the `Adapter` interface), so a job swept by a worker another harness's hook spawned still reads the right config and session store.
  
  `sessionpipe uninstall` takes the same `--<harness>` selection `install` has, removes the shared hook launcher only on a full uninstall, and refuses an all-harnesses uninstall when `SESSIONPIPE_CONFIG`/`SESSIONPIPE_STATE` point away from this machine while other harnesses would still be read from `$HOME` (pass `--all` to mean it). The hook forwards `XDG_CONFIG_HOME`, `XDG_DATA_HOME` and `APPDATA` in the job file, beside the per-harness variables already there. The control wait — up to 125 s on a `PermissionRequest` — now applies the same "this is not a Claude Code payload" test the worker does, so our entry in `~/.claude/settings.json` run by another harness returns at once. A payload no adapter claims is logged rather than dropped in silence.
  
  Tests: the Devin session-store tests build their fixture through the `sqlite3` binary where `node:sqlite` is absent, so they run on the Node 20 floor — where the `cli` engine is the only way into a database, and where all seven used to skip. Each engine is asserted where it works and skipped only for itself; `inlineParams` and the adapter's own chain query are covered.

### Patch Changes

- 81764cc: Codex: only the person's own threads become sessions.
  
  - An ephemeral thread is no longer reported: its hooks carry `transcript_path: null` and its notify finds no rollout. Codex Desktop runs its own background work this way (ambient suggestions and their safety review, a new chat's title), and so does `codex exec --ephemeral`. Each used to arrive as an untitled session with no turns, often with `/` as its folder.
  - A subagent's thread is no longer a session of its own. Its parent already reports it (`SubagentStart` / `SubagentStop`, its tool calls), so its notify and its rollout (backfill) report nothing. A fork the person made is still a session.
  - Inside a subagent, Codex sends the parent's `session_id` with the subagent's own rollout. That file is no longer read as the parent's transcript, so the parent's running turn (`turn.progress`) no longer shows a subagent's words.
  - Conformance: a harness fixture with an empty `expect` is a payload the adapter must report nothing for.
- a68bf97: The CLI entry runs only when invoked as the script, so the package can be imported by tests. Output and exit codes are unchanged.

## 0.8.0

### Patch Changes

- ea1d43a: Build on TypeScript 7 (`baseUrl` dropped from every tsconfig; `paths` already resolved relative to the file). Dev-only: published output is unchanged.

## 0.7.0

No changes in this release.

## 0.6.1

No changes in this release.

## 0.6.0

No changes in this release.

## 0.5.0

No changes in this release.

## 0.4.2

No changes in this release.

## 0.4.1

No changes in this release.

## 0.4.0

No changes in this release.

## 0.3.0

No changes in this release.

## 0.2.0

No changes in this release.

## 0.1.1

### Patch Changes

- 08b5d89: READMEs carry the published (unscoped) package names.
- a360ee8: Published under unscoped names (sessionpipe-core, sessionpipe-receiver, sessionpipe-conformance) until the @sessionpipe npm org exists.

## 0.1.0

### Minor Changes

- c75aaa0: Core: adapters for Claude Code, Codex, Gemini CLI and Antigravity; the secrets@1 and pii@1 rulesets and the tier filter; outbox, cursors, locks; file, stdout and HTTP sinks. CLI: install, uninstall, sink, status, doctor, tail, backfill, forget, replay, update; the hook entry imports only node: builtins. Conformance: adapter fixture runner.

### Patch Changes

- Updated dependencies [e918475]
- Updated dependencies [c75aaa0]
  - @sessionpipe/core@0.1.0
