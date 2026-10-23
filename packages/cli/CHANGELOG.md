# sessionpipe

## 0.9.0

### Minor Changes

- 55320c7: Control daemon: a `start` may bring files, for every harness it can start (Claude Code, Codex, Antigravity). The daemon fetches each from `{control}/files/{sha256}` with the machine's token, stops reading past the signed size, checks length and hash, writes them under `<cwd>/.sessionpipe/files/<session>/` (self-ignoring `.gitignore`, no symlinks followed, exclusive create, mode 0600) and starts the session with the text plus the list of relative paths. Any file problem acks `failed` with code `file` and starts nothing. Pair and hello now say `files: true`.
- ac26495: `sessionpipe control folders [add|remove <dir>…]`: change the folders that sessions you message may run in, at the machine, without pairing again. Before this, the folders were set only by `control pair --folder`. On 2026-10-13 a Kimi session in `~/claude-kimi` on a machine paired with `~/claude` was refused ("that session's folder isn't one this machine allows"), and the only fix was a new pairing, with its passkey approval. A folder to add must exist and can't be the home folder or above it (pair's rule). The running daemon picks up the new list within seconds, and when the folders or the mode change it sends a hello at once, so the receiver's folder picker doesn't wait up to ten minutes for the next one.
- d525320: A `devin` adapter: Devin CLI (Cognition) sessions are reported like any other harness. `sessionpipe install` (or `--devin`) writes the eight event names Devin accepts into the `hooks` key of its user config file; the payload maps to the protocol's events, the folder comes from `DEVIN_PROJECT_DIR` (nothing in the payload names it), and tier 2, the model, the title and the times are read read-only from Devin's own SQLite session store — through a new `readers/sqlite.ts` that works on Node 20 too (in-process `node:sqlite`, else a short child process, else the `sqlite3` CLI, else no turns). Eight fixtures recorded from real runs on 3000.11.3. Also: the `claude-code` adapter now drops a payload with no `transcript_path` and a non-UUID session id — that is another harness running our entry in `~/.claude/settings.json`, not Claude Code — and the worker logs a dropped event instead of discarding it in silence when no adapter owns its harness name.
- 3fd0041: Review fixes to the Devin adapter and two gaps it exposed.
  
  `devin`: a turn is now timed by the message's own `metadata.created_at`, not by `message_nodes.created_at` — that column is the time the row batch was last **saved**, one value for the whole chain, rewritten on every save and not monotonic along it, so every turn of a session was reported at the same wrong instant. The chain read is now bounded by the cursor and caps from the newest end: past 4000 nodes the old query kept the 4000 **oldest** and then delivered nothing ever again, and every Stop re-read the chain's root (a 17 kB system prompt and four more system blocks). `installed()` reports `inactive`, not `current`, when the config file holds any event name Devin does not know — Devin then loads no hooks from that file at all, ours included — and `install()` says so too. A `tool_response` that is not an object no longer loses its output. `facts()` takes the hook's environment (new optional argument on the `Adapter` interface), so a job swept by a worker another harness's hook spawned still reads the right config and session store.
  
  `sessionpipe uninstall` takes the same `--<harness>` selection `install` has, removes the shared hook launcher only on a full uninstall, and refuses an all-harnesses uninstall when `SESSIONPIPE_CONFIG`/`SESSIONPIPE_STATE` point away from this machine while other harnesses would still be read from `$HOME` (pass `--all` to mean it). The hook forwards `XDG_CONFIG_HOME`, `XDG_DATA_HOME` and `APPDATA` in the job file, beside the per-harness variables already there. The control wait — up to 125 s on a `PermissionRequest` — now applies the same "this is not a Claude Code payload" test the worker does, so our entry in `~/.claude/settings.json` run by another harness returns at once. A payload no adapter claims is logged rather than dropped in silence.
  
  Tests: the Devin session-store tests build their fixture through the `sqlite3` binary where `node:sqlite` is absent, so they run on the Node 20 floor — where the `cli` engine is the only way into a database, and where all seven used to skip. Each engine is asserted where it works and skipped only for itself; `inlineParams` and the adapter's own chain query are covered.
- 0940788: `turn.progress` (tier 2): a turn still running goes out as it runs, not only when it ends. The prompt is sent as the turn starts, then what the assistant has said so far, at most every 20 s on a tool call and only when it changed, under the number its `turn.transcript` will carry. Over 20 000 characters the reply keeps its end. A 21-minute turn used to show nothing on its receiver for 21 minutes.

### Patch Changes

- 6ee80e1: A batch a receiver refuses with 413 is halved and sent again until it fits, and one event too large on its own is dropped and logged (HTTP.md §2). Before, the sink stopped for the run and the next worker sent the same batch again, so one oversized batch stopped a sink for good.
- 8184e2a: An Antigravity session in a git checkout now opens its own conversation from its link, not Antigravity's home. Antigravity keeps a git checkout's folder under `gitFolder` in `~/.gemini/config/projects/<id>.json` (`{ "gitFolder": { "folderUri": … } }`) and only a plain folder's at the top of the resource, so the session's project was never found for a repo: the link had no `?p=c/<conversation>?section=<project>`, or named an enclosing plain folder's project instead (6 of 8 projects on one machine, 2026-10-20).
- 91265cb: A busy session's events no longer wait 6 s and go back to the queue behind its own lock. A lock whose worker is gone (its 15 s deadline ended it without a release) is taken at once instead of after 5 min; a job polls for the lock every 50 ms instead of doubling its wait, so siblings can't keep taking it in between; and the sinks drain at once, so the lock is held for the slowest round trip, not the sum of them (33 re-queues in one day's log on a machine with three sinks, 2026-10-13).
- 366043f: Claude Code: a message the person sends while a turn is running now reaches `turn.transcript` and `turn.progress`. Claude Code records it as a `queued_command` attachment rather than a `user` record, so the transcript reader dropped it from tier 2.
- 023993a: The sessionpipe command's entry runs only when invoked as the script (through its npm bin link too), so every command can be tested in process. Output and exit codes are unchanged.
- 8253085: The usage table behind `--help` is exported (`usageTable`), so sessionpipe.org's docs page prints the same usage lines the CLI does; `--help` output is unchanged. The README's closing links sit at its end again, after "Help and status JSON".
- 94c1b2f: Skip the parent's replayed history in forked Codex rollouts when reading session
  facts and transcripts. Wait for an event naming the fork's own thread, preserve
  its original transcript timestamps and cursors, and leave its title unset until
  it contains a real user ask of its own.
- 81764cc: Codex: only the person's own threads become sessions.
  
  - An ephemeral thread is no longer reported: its hooks carry `transcript_path: null` and its notify finds no rollout. Codex Desktop runs its own background work this way (ambient suggestions and their safety review, a new chat's title), and so does `codex exec --ephemeral`. Each used to arrive as an untitled session with no turns, often with `/` as its folder.
  - A subagent's thread is no longer a session of its own. Its parent already reports it (`SubagentStart` / `SubagentStop`, its tool calls), so its notify and its rollout (backfill) report nothing. A fork the person made is still a session.
  - Inside a subagent, Codex sends the parent's `session_id` with the subagent's own rollout. That file is no longer read as the parent's transcript, so the parent's running turn (`turn.progress`) no longer shows a subagent's words.
  - Conformance: a harness fixture with an empty `expect` is a payload the adapter must report nothing for.
- e2ba5c8: The control daemon retries pending events for every non-paused sink once a minute, including sinks whose token is in config.json. A session whose final delivery was refused no longer needs another hook event to reach its sink after the retry wait. The existing per-sink wait and machine-wide delivery lock still apply.
- e252398: `sessionpipe control pair` names a first pairing the way the hooks name the machine: `machine` from config.json, else the hostname without its `.local`, `.lan` or `.home` suffix. On macOS the daemon used to register as `<name>.local` while events said `<name>`, so a receiver showed the same machine twice and could not route approvals to it. `--name` and an existing pairing's name still win.
- 1b286e6: Retry control polls after a 401 with a capped backoff, resume immediately when a hello accepts the token, and honour Retry-After on 503 responses. Show polling state, time since the last successful poll, and the last control error in status and doctor.
- 56cb3ef: The control daemon's socket is now mode 0600, as spec/CONTROL.md §8 says. It used to take the umask (0755 on a default macOS), so only its 0700 parent kept other users out.
- ab5c975: The hook and worker entries run only when invoked as the script, so both can be tested in process. What they do, print and exit with is unchanged; the hook still imports node builtins only and its timing is the same.
- 2d8a8ae: Ignore Claude Code's lone SessionEnd hooks (for example, from `claude mcp list`) when there is no outbox, stored facts or existing transcript. These hooks no longer create an outbox or reach a sink or the local daemon. Real sessions still send their end, including when their transcript was deleted but an outbox or facts remain.
- 1ca23ee: No hook event is lost to a worker's 15 s deadline, and none waits for an unrelated hook. A worker used to delete its job file before running it, so one ended mid-run (a sink that hung, a lock held out) took the event with it. A job is now claimed by renaming its file and the claim is released only once its events are in the outbox; a sweep gives a claim whose worker is gone back to the queue. A job the session's lock held out used to wait in the queue for the next hook's sweep, however long that took; a fresh worker now starts for it.
- 434d10c: A machine under a flood of hook events no longer floods its sinks. One worker drains the sinks at a time; the others leave their events in the outbox for it and it sends them in full batches of 50, so four busy sessions cost a request per batch, not per event. A sink that answered 429 is not tried again by any worker before its `retry-after`, and one that could not be reached waits 2 s · 10 s · 60 s · 5 min · 30 min, then every 30 min, as HTTP.md §2 has said all along (a machine with four busy sessions was refused 828 times in two minutes and had 5 192 jobs queued, 2026-10-14). The session's lock now covers only the append, not the round trips.
- 6ea4095: `control pair`: a code nobody approved before it expired is renewed in place, with fresh digits, for up to an hour. A person approving three headless machines from a phone ran out of ten-minute codes (2026-10-08). The expired code is dead on the receiver, so nothing lives longer than it did; a keyed pairing keeps the machine row its first code made. The terminal now also says how long a code is good for.
- dc14f84: `turn.progress`: a message absorbed by a running turn, and text the person never typed, no longer open a turn of their own. Claude Code reports a message sent mid-turn (the person's, another session's, a task notification) as a prompt carrying the running turn's id; its reading went out numbered as the next turn, which the transcript never delivers, so a receiver kept showing it, with an empty reply, instead of the running turn. Such a prompt now leaves the reading on the turn the transcript is in, and a task notification that starts a turn is not shown as its ask. `isInjected` also recognises a wrapper tag with attributes (`<cross-session-message from="…">…</cross-session-message>`).
- 1a77ec3: `sessionpipe connect --machine NAME --rename-machine` (and `install`) now renames a paired control daemon too, so the hooks and the daemon stay one machine on a receiver. Before, setup refused to touch a paired daemon's name, and a machine whose pairing predates the fix in 0.9.0 that names pairings like the hooks had no way to merge its two cards. The daemon says a new name in a hello at once, as it does for folders and mode.
- 9314032: After a 429, the HTTP sink waits as `retry-after` says when the header is an HTTP date (RFC 9110), not only when it is a number of seconds. Before, a date fell back to the 2 s backoff ladder.
- fd9c880: A repeat `install` or `connect` on a config without a machine name keeps the name the hooks have been using (the hostname without `.local`), and renames a control daemon paired under another name to it, instead of adopting the daemon's. Before, a Mac paired before 0.9.0 (daemon `<host>.local`, events `<host>`) had its events switch to `<host>.local` on the first update, so a receiver showed its new sessions under a second machine. Receivers key a pairing by id, so the daemon's rename costs nothing.
- 40fb6e5: A session's short id (PROTOCOL.md §3): the first 8 hex digits of `sha256("sessionpipe.session:" + harness + ":" + id)`, what a person reads in a log line, a notification or a search box. Derived, never sent. Not a prefix of the id: Codex ids are time-ordered, and four of ninety on one machine shared their first eight characters. `shortId()` in core; the worker's log and the daemon's lines that name a session use it.
- 92bba52: Refuse connect/install downgrades of newer global packages or persistent hook copies,
  including newer prereleases, unless --allow-downgrade is explicit. Preserve the
  configured machine name when --machine differs; require --rename-machine for an
  unpaired rename and refuse names that would split sessions from a configured daemon.

## 0.8.0

### Minor Changes

- 3c5d8fb: Control's pairing request and every daemon hello name the Claude Code accounts signed in on the machine (`accounts`: `{harness, id, email}` per config dir, read again for each hello), so a receiver the person paired with can label `session.account_id` with the account's email instead of showing an id. Events are unchanged: `account_id` stays an id and no event carries an email. `sessionpipe control pair` and `connect` say which accounts they named.

### Patch Changes

- 93a8420: Handle `--help` and `-h` before dispatching every CLI command, including nested commands, so asking for usage cannot install hooks, queue work, or contact a receiver. Implement `status --json` with doctor's names for shared facts plus pending session counts and queued jobs, preserving the human status output.
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

### Minor Changes

- f62bad9: The control daemon updates itself. About a minute after it starts and then once a day (the last check is kept in `state/control/update.json`, so restarts and sleeping machines don't ask more often), it reads npm's `latest`; when that is newer it waits until nothing is in hand (no delivery, headless run, start, SDK turn, open permission prompt, session mid-turn or ack flush), pauses intake, installs with `npm install --global --ignore-scripts` into the prefix it runs from, re-arms the hooks of the harnesses already set up, and restarts onto the new code: exit 75 under launchd or systemd (every service file ever written restarts on a non-zero exit; new ones also carry `SESSIONPIPE_SERVICE` and `RestartForceExitStatus=75`), and otherwise the old process stays as the new daemon's parent. Off with `sessionpipe update off` (`update_check: false`, now actually read), `SESSIONPIPE_NO_UPDATE_CHECK`, or when the copy isn't a writable global npm install. `status` and `doctor` show whether it's on, the last check and the latest version.
  
  One daemon per machine: `control run` no longer takes the socket from a daemon that answers on it (it says so and exits 0), steps aside if another daemon replaces its socket file, and never deletes another daemon's socket. `sessionpipe update` installs through the same path (npm run by the daemon's own node, the copy on disk checked, only the configured harnesses re-armed) and asks a running daemon to restart onto it once idle.

### Patch Changes

- e474c81: A started session's first message puts the person's words first and the "sent via" line after, so Claude Code names the session from what they asked instead of "Message via spacesheep.dev (sessionpipe control, s…".

## 0.5.0

### Minor Changes

- 6a5cda8: `sessionpipe connect <receiver>`: one command and one approval set a machine up — hooks for every agent and every Claude Code account, a sink at tier 2 with the key the receiver hands over at pairing, signed messages, keys in the keychain, a daemon that outlives logout, 30 days backfilled. It asks nothing (safe mode unless `--mode auto`; folders from `--folder`, the folder it ran in, or where recent sessions ran — never the home folder) and a second run only fixes what's missing.
  
  - Hooks run a launcher, `~/.local/share/sessionpipe/sessionpipe-hook`, with its own copy of the hook: a Node upgrade, `nvm uninstall` or a moved npm prefix no longer silently stops reporting. Re-installs move old entries to it in place.
  - Keys (sink tokens and secrets, machine tokens) live in the macOS Keychain or a desktop session's Secret Service when one is writable, else in the 0600 files as before; `sessionpipe secrets [move keychain|secret-service|file]`. A token a locked keychain won't hand over leaves events waiting (never unsigned); the daemon drains them from your session.
  - The Linux daemon turns on systemd linger, so closing ssh no longer stops it; on a Mac with nobody at the screen it runs as a background launchd agent instead of failing.
  - Before a headless run the daemon asks Claude Code whether that account is signed in (`claude auth status`) and fails the message with what to do — on a Mac, that a keychain login can't be read with nobody logged in at the screen — instead of Claude Code's "please run /login". `connect` and `doctor` list each account's state.
  - `sink add` keeps a sink's existing key when only the tier changes (it used to drop it); pairing fills in a sink that has no key and takes `--tier`; `control pair` run from the home folder no longer allows all of it; `control.json` keeps the machine's own caps across a write.

### Patch Changes

- 10d19eb: Run control pairing from the global install when invoked through npx, and use a stable Homebrew Node path for the daemon service. Existing service files are repaired by pairing again with the fixed CLI; install and update alone do not rewrite them.

## 0.4.2

### Patch Changes

- 4b39a06: A message for a session the daemon's own run is still working on (a start, a resume) waits for that run and resumes the session, instead of forking a copy that would work the same task in parallel.

## 0.4.1

### Patch Changes

- 98374b0: `control pair` says the approval happens on any device where you're signed in to the receiver, not necessarily the machine being paired (which may have no screen), and that several machines are paired one by one, each with its own digits.

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

### Patch Changes

- 87d9a65: Control (M6): `sessionpipe-core/control`, the one verifier for signed control commands (WebCrypto only, safe in Workers and browsers), with 60 shared conformance vectors; the control schemas rewritten for signed, per-machine delivery. The CLI ignores `sink add --control` (control is per machine) and a retried batch reuses its `webhook-id`.

## 0.1.1

### Patch Changes

- 8ae0d49: The sink drain packs events from many sessions into one batch of up to 50 (a first install's backfill is a handful of POSTs, not one per session); cursors move only after the batch was acknowledged.
- be95792: `sink test` sends a heartbeat and then its `session.forgotten`, so a receiver keeps no phantom session from the test.
- b8b8599: Fixes from the first outside install (Yaroslav Bulatov, issues #8–#14 and advisory GHSA-8f6f-c3c9-j5p6): a config file that is not plain JSON is never written back; installs keep a file's indent and final newline and uninstall deletes files sessionpipe created; jobs that lose the session-lock race are retried and swept, never lost; Claude Code `StopFailure` → `turn.ended` with `reason: error`; `status`/`doctor` say when Gemini CLI won't run hooks (`tools.enableHooks`) and word the Codex review honestly; `doctor` measures the wall clock a harness waits; with no sink above tier 0 only one tool event per harness is hooked; the npx bootstrap installs into `~/.local` when npm's prefix is Homebrew's versioned Cellar; a bare `pass:` is no longer a secret name; the outbox holds redacted strings at rest in 0600 files under 0700 directories.

## 0.1.0

### Minor Changes

- c75aaa0: Core: adapters for Claude Code, Codex, Gemini CLI and Antigravity; the secrets@1 and pii@1 rulesets and the tier filter; outbox, cursors, locks; file, stdout and HTTP sinks. CLI: install, uninstall, sink, status, doctor, tail, backfill, forget, replay, update; the hook entry imports only node: builtins. Conformance: adapter fixture runner.

### Patch Changes

- Updated dependencies [e918475]
- Updated dependencies [c75aaa0]
  - @sessionpipe/core@0.1.0
