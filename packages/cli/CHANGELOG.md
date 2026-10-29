# sessionpipe

## 0.11.0

### Minor Changes

- 91a1e57: Session names from claude.ai, off until the person turns them on (`sessionpipe titles on`, config.json `remote_titles`). claude.ai names a session the Claude app starts seconds after its first message and never writes that name to the machine, so until now such a session went out under its first prompt cut to 50 characters while the Claude app showed another name. With it on, the worker asks claude.ai for the name of each Claude Code session with a claude.ai link (`GET https://api.anthropic.com/v1/code/sessions/<session_…>`, as Claude Code reads a session; the answer recorded in `conformance/remote/claude-code/`), a minute apart until it has one, then every half hour, within 3 s, and sends it as `session.title` with `title_source: "harness"`; a `custom` title still wins. `titles on` and `titles refresh [--days N]` also ask about the last 30 days' sessions and send each one already sent under another name again as `session.backfill`, so finished sessions are renamed too; a backfill takes these names as well. It bears the sign-in Claude Code keeps for that config dir (the macOS keychain item, else `.credentials.json`), sends it to `api.anthropic.com` alone, refuses redirects, never refreshes an expiring token and never writes it anywhere. Adapters gain an optional `remoteFacts` and `BackfillRow.transcript`; `Config` gains `remote_titles`. spec/ADAPTERS.md, spec/PRIVACY.md §3 and the `session.backfill` row of spec/PROTOCOL.md say so.
- 3f074d8: `limits.observed` reaches tier-1 sinks: after a Codex turn when its rollout holds new numbers, and from Claude Code's status line with `install --status-line` (or `connect --status-line`; `--no-status-line` takes it away; remembered in the config). A status line hides most of Claude Code's footer hints, so it is opt-in. The line shows the limits (`5h 23% · week 41%`) and hands the worker a job only when they changed, at most once a minute per config dir and never without a tier-1 sink. Before this a receiver could not tell which account still had room in its 5-hour or weekly window.
- 227e247: The pool: several Claude accounts behind one loopback listener the control daemon runs, so a Claude Code session keeps going when one account's limit is reached. `sessionpipe pool add --import` copies this machine's Claude Code logins into the pool (`--login` signs another account in: a URL, then the code pasted to `--code -`), `pool on` writes the `env` block into every Claude Code `settings.json` and installs the daemon's service if it is missing, `pool` lists the accounts in order with the room each has left, `order`, `enable`, `disable`, `remove` and `refresh` shape the roster, and `pool off` removes exactly what `on` wrote. A request goes to the first account in your order that has room; a session stays on its account while that account has room; the numbers an account reports on a session's request become a tier-1 `limits.observed` with `account_id` on that session, through the outbox like a hook's. Every hello carries the pool (`pool` object), a receiver's signed `pool` command drives it (`on`, `off`, `remove`, `order`, `disable` and `login.complete` need a fresh confirm, never a day grant alone: `confirm_required`), and while the daemon runs the CLI's commands go to it over the local socket, since it holds the listener, the pins and the credentials. The daemon now runs for the pool alone, with no receiver paired, and `control off` keeps its service while the pool is on; `sessionpipe uninstall` runs `pool off` first. Nothing of this happens until you run `pool add` or `pool on` yourself.

### Patch Changes

- 83929e3: Codex's config.toml keeps its CRLF line ends through `install` and `uninstall`: the notify line goes in with the file's own line end, and `uninstall` leaves the file byte-identical, as it already did for an LF file.
- b5285de: `install`, `status` and `doctor` read Gemini CLI's version on Windows, where the CLI is npm's `gemini.cmd` shim; before, every Windows install said "could not run `gemini --version`" and the 0.46 check never happened.
- 1891dab: A hooks file that starts with a UTF-8 byte-order mark (PowerShell 5's UTF8 encoding, older Windows editors) is read like any other and written back with the mark, so `install` hooks it instead of reporting "not plain JSON; not touched", and `uninstall` leaves it byte-identical. The harnesses read such a file themselves.
- 2153f5b: `sink add` and `sink remove` rewrite the hooks when a sink crosses tier 0, as `install`'s own message says they will; before, the hooks stayed the lean set, `status` read `stale`, and `doctor` blamed an old node or script path. `doctor` now says which set the hooks are and why that no longer matches, when that is the cause.
- caa12b5: `sessionpipe tail` names the outbox with the platform's own separator: `~\AppData\Local\sessionpipe\outbox` on Windows, where it read `…sessionpipe/outbox`.

## 0.10.0

### Minor Changes

- 5ea2f11: Control can start, prompt and cancel any agent that speaks the Agent Client Protocol (CONTROL.md §6, `api` mode; ADAPTERS.md "Agents driven through ACP"). The daemon runs the agent's own CLI as a child on the launch line the ACP registry publishes (Gemini CLI, OpenCode, goose, Copilot CLI, Cursor, Droid, Devin, Kilo, Qwen Code, Cline and twenty more, 2026-10-22), is its JSON-RPC client, keeps the process for the next message, cancels with `session/cancel`, reopens an idle session with `session/load` where the agent can, and answers its permission requests from the machine's mode (safe refuses and the reply says what; auto allows). Only an agent already installed is ever run (on PATH, or where `SESSIONPIPE_ACP_<HARNESS>` points); the hello advertises the ones found. The pairing request and every hello list at most 20 harnesses, the schema's limit (Claude Code, Codex and Antigravity first, then the agents in the registry's order), and their `modes` include `api` whenever an ACP agent is listed.
- 7b65074: A Claude Code home that runs on another API now has an account. Such a home has no claude.ai login, and its `settings.json` sets `env.ANTHROPIC_BASE_URL` (Kimi K3 on a Modal endpoint, GLM on Z.ai). Its events carry `account_id: api-<16 hex>`, made from the endpoint's origin and the same on every machine that uses it. Control's pair and hello name it by the endpoint's host, in `accounts[].name`, a new optional field. Before this, its sessions carried no account, so a board filed them with the harnesses that report none (a person's Kimi sessions sat in "No account" beside 1,331 Codex ones). Only that one settings key is read, never the token or the headers beside it.
- 27c4194: Control: device keys (CONTROL.md §2, §3.2). `sessionpipe-core/control` verifies a device key's signature (`{cred, sig}`, raw r‖s over `sessionpipe.device.v1⏎<purpose>⏎<rp id>⏎<challenge>`) for a grant, a confirm or a pairing proof, chosen by the machine's own record of the key; `keyUsable` closes key fields and checks a device key's rules (`type: "device"`, `alg -7`, `store: "hardware"`, `uv: "each-use"`, id = SHA-256 of the SPKI); `verifyCommand` refuses a `key.add` whose key could never be used (`bad_fields`). `verifyAssertion` takes the purpose. New exports `DEVICE_CONTEXT`, `deviceMessage`, `deviceKeyId`, `KEY_TYPES`, `DEVICE_SIG_FIELDS`, `DeviceSignature`, `DeviceGrant`. The daemon advertises `key_types: ["passkey","device"]` when pairing and in every hello, stores a device key whole (from a pairing or a `key.add`), and `control keys` shows each key's kind. 26 new shared vectors (`111`–`136`).
- abcba7f: Control: a third machine mode, `inherit`, so sessions you message run the way your own sessions on that machine run. `sessionpipe control mode inherit` (or `--mode inherit` on `control pair` and `connect`, or the whole word at pairing's question) passes no permission flag, so each harness starts every turn in its own default there: Claude Code in its settings' `permissions.defaultMode` (a resume too, and through the Agent SDK too), Codex as its `config.toml`'s `approval_policy` and `sandbox_mode` say, Antigravity with no flag, as in safe. No mode passes a bypass flag. Before this, a machine whose Claude Code settings turn auto mode off (`permissions.disableAutoMode`) had no mode that fit: `auto` ran each messaged session in Claude Code's default mode, which refused every command that needed approval, and `safe` refuses them by design. Schemas: `control-pair` and `control-hello` `mode` gains `inherit`.
- 531b391: Control: a machine runs in `inherit` mode only with receivers that know it. A receiver that predates `inherit` shows such a machine as safe, while its sessions run with no permission flag. A receiver now says it shows the mode as what it is with `control.inherit: true` in its well-known file (HTTP.md §1, CONTROL.md §2), and `sessionpipe control pair --mode inherit` (and `connect --mode inherit`) refuses, before anything is sent, a receiver that doesn't: "… doesn't know inherit mode yet; it would show this machine as safe while the sessions you message run with no permission flag". `sessionpipe control mode inherit` checks every paired receiver the same way and keeps the mode it had when one doesn't know it, or can't be read. Schema: `well-known` `control.inherit` (optional boolean). Conformance: `delivery/23-control-inherit`.
- 2865e0d: **For receivers.** What a 0.10.0 machine sends and accepts, and how to adopt it while some machines still run 0.9.0 (CHANGELOG.md, "For receivers (0.10.0)", has the detail).
  
  - **Closed command field set.** Each command kind carries only its own fields; any other field inside the signed `cmd` is refused `bad_fields`, by the verifier and on the machine (0.9.0 ignored it). Keep your own data beside `cmd`, never in it.
  - **`mode: "inherit"`** in pairing requests and hellos: no permission flag, so a start that names no level runs as the person's own sessions there do, permission checks off included where their settings say so. Show it as `inherit`, never as safe or auto. A 0.10.0 machine pairs in inherit, or switches to it, only with a receiver whose well-known file says `control.inherit: true`; it tells everyone else's person "… doesn't know inherit mode yet; it would show this machine as safe". Set the flag once you show the mode truthfully and accept it in `/pair` and `/hello` (conformance `delivery/23`).
  - **Refusal code `mode` is now `permission`**, plus `refused` `model` and `failed` `model`. Map both codes; a 0.9.0 machine still says `mode`.
  - **Hello:** `start` (per harness: `permissions` among `read`, `safe`, `edits`, `auto`, capped by the mode; the default `permission`, which may be `inherit`; `models`, `any_model`), `prompt_files: true`, and no `home`: a start's `cwd` may be `~` or `~/…` instead. `harnesses` lists at most 20, and `modes` include `api` when an ACP agent is listed.
  - **Acks:** a start's `taken` and `delivered` carry `applied` (`permission` may be `inherit`). Show `applied`, never what was asked.
  - **Events:** `session.attended`, `turn.ended.background`, `turn.started.submitted_by` and `injected`, `session.launched_by`, and `account_id` `api-<16 hex>` for a Claude Code home on another API, named in `accounts[]` by `name` with no `email`. All optional, tier 0.
  - **ACP agents** (gemini-cli, opencode, goose, cursor, copilot-cli, droid and more) appear in `harnesses` and in ack `session` refs, acked in mode `api`; they take no start options.
  - **Device keys:** an app that can't run WebAuthn signs with a hardware-held P-256 key, `{id, alg: -7, spki, type: "device", store: "hardware", uv: "each-use"}`, its signature `{cred, sig}` (plus `str` in a grant) where an assertion would stand; a 0.10.0 machine says `key_types: ["passkey","device"]` when pairing and in every hello. To accept them, store and carry the key whole (all six fields) in a pairing's and a `key.add`'s `key`, pass a `{cred, sig}` grant, confirm or pairing proof through untouched, and say `control.signing.key_types: ["passkey","device"]` in your well-known file. They are added only as passkeys are: at the terminal's pairing code, or by a `key.add` a trusted key signed. A receiver that doesn't know them keeps working, passkeys only.
  - **While machines run 0.9.0:** send `permission` or `model` only where the last hello's `start` advertises them (0.9.0 ignores them silently); `files` on a `prompt` only with `prompt_files: true` (0.9.0 refuses them); a `~` folder only to a machine whose hello has `start`; never `inherit` as a command's level; a device key only for a machine whose last hello lists `device` in `key_types` (0.9.0 would store it as a passkey and refuse its signatures); read an absent `attended`, `background`, `submitted_by`, `injected` or `launched_by` as unknown, never as false, 0 or a person.
- a6f8bb7: A control `prompt` can carry `files`, as a `start` can (CONTROL.md §3.1, §6 `prompt`), to a machine whose hello says `prompt_files: true`. The daemon fetches and checks them as for a start, writes them to `<cwd>/.sessionpipe/files/<session>/<nonce>/` (the command's signed nonce, never the receiver's unsigned message id), and appends the same "Attached files" block before the message is handed over in any mode: a resume, a fork, a held SDK session, an ACP agent (`api`), a waiter or a Stop. A file that fails is acked `failed` with code `file` and the message is not delivered. A receiver no longer needs to put a link to an image into the message's text.
- d51fd31: `session.attended` says whether a person attends the session: an optional tier-0 boolean in the harness's own word, absent when the harness does not say (unknown, never `false`). Claude Code fills it from `CLAUDE_CODE_SESSION_ATTENDED`, counting a control turn and a session with a link (its Remote Control bridge, the desktop app) as attended: every headless run says `0`, a Remote Control session included, and a `claude -p` started inside one inherits `CLAUDE_CODE_ENVIRONMENT_KIND=bridge`, so the link is what tells them apart. The hook carries `CLAUDE_CODE_SESSION_ATTENDED` and `SESSIONPIPE_CONTROL_JOB` into the job, and the worker takes those and `CLAUDE_CODE_HOST_SESSION_ID` from the job alone, so a worker another session's hook spawned no longer lends a swept job its own. Codex, Gemini CLI, Antigravity and Devin leave it absent.
- fae77a5: `session.launched_by`: the session that started this one, as `<harness>:<id>`, read from `SESSIONPIPE_LAUNCHED_BY` in the hook's environment (PROTOCOL.md §3). A script that runs `claude -p` for a session sets it, and a receiver can group the run under its launcher without reading it as a subagent. A subagent keeps its `parent_id` and gets no `launched_by`.
- bd49ef7: A control `start` can say how much the new session may do and which model it runs (CONTROL.md §2, §3.1, §5 step 8, §6 Options; ADAPTERS.md "Start options"). `permission` is one of four levels, `read`, `safe`, `edits` and `auto`, with nothing above `auto`; `model` is the harness's own id, passed as one argument. The machine's `mode` is the ceiling, and a start above it, or at a level the harness has no flag for, is refused `permission` before anything is taken or run (the daemon's old `mode` code). On a machine in `inherit` mode a start that names no level runs with no permission flag, as the person's own sessions there do, and one that names a level may name only `read` or `safe`, since sessionpipe can't rank the person's own default; `inherit` is never a level a command names. The hello advertises what each harness takes here (`start`, capped by the mode: Claude Code's levels from its `--help`, Codex's models from its own cache; a harness's default may be `inherit`). A start's `cwd` may be `~` or `~/…`, read under the daemon user's home, so a receiver can start a session in a folder an event reported without the machine ever telling it its home. A start's level and model are recorded with the session, and every later resume or fork runs at the narrower of that and the machine's mode then (at most `safe` on an inherit machine for a session that named a level). The `taken` and `delivered` acks of a start carry `applied` (its `permission` may be `inherit`); a model the harness rejects ends `failed` with code `model`. An ACP agent takes neither option: a start that names one is refused, never run without it. Each command kind now has a closed set of fields, so a field a machine doesn't know is refused rather than ignored. `sessionpipe control status` shows the options per harness. A start whose text begins with a dash no longer reaches `claude -p` as a flag.
- d7269b4: `turn.ended` carries `background`: how much background work the harness reports still in flight as the turn ends, each piece of which wakes the session when it finishes. Claude Code's Stop hook lists it as `background_tasks` (in every Stop recorded since 2.1.258): a background shell command, a monitor, a subagent, a workflow. A session that ended its turn waiting on a two-hour background command read as finished on its receiver, under "Last 24 hours", until the command woke it. Tier 0, a count only: never what that work runs.
- f8770b9: `turn.started` can now say who started the turn: two optional tier-0 fields, `submitted_by` (the harness's own word for who submitted the prompt, forwarded verbatim and never mapped onto a vocabulary of the spec — a different vocabulary from `session.started.source`) and `injected` (`true` when the prompt text is a block the harness wrote rather than words a person typed). Claude Code fills `submitted_by` from `UserPromptSubmit.source` when a payload carries that key — its hook schema documents `user` · `sdk` · `system` · `loop_wakeup` · `schedule_wakeup` · `poll_event` and says a payload may omit it while the field rolls out, and no build through 2.1.304 sends it — and sets `injected` from a closed list of its own prompt wrappers (`<task-notification>`, `<cross-session-message …>`, `<system-reminder>`, `<local-command-stdout>`, `<command-…>`), so a task notification, a peer message or a slash-command expansion is distinguishable from a person typing. `injected: true` says only that the prompt is not the person's words, never that no person caused the turn: a Talk or `sessionpipe wait` delivery arrives inside a `<task-notification>`. Both fields are absent when the harness does not say, and an absent field is unknown, never "the person". `sessionpipe tail` prints both. Codex, Gemini CLI, Antigravity and Devin leave both absent.

### Patch Changes

- fc0fedd: Two Node-only subpaths in `sessionpipe-core`, so a receiver of the person's own (a board on their machine) runs as a service with the daemon's code rather than a copy of it. `sessionpipe-core/service`: the launchd agent and the systemd user unit for any process (`serviceFiles`, `installService` and `uninstallService`, each with a dry run that answers the files and commands and touches nothing, and `ensureLinger`). `sessionpipe-core/version`: `compareVersions`, `isNewer`, `parseVersion`, `UPDATE_EXIT` and `supervise`, the parent that restarts a process onto new code where no service manager will. The root export is unchanged and still runs in a Worker and a browser. The control daemon now uses both; its service is the same, except that the unit's `ExecStart` quotes every argument.

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
