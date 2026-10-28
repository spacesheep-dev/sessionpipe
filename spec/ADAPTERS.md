# Adapters: per-harness mapping

> This document is part of the sessionpipe protocol and is licensed under [CC BY 4.0](LICENSE). The words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are used as in RFC 2119. Status: **Draft** (see [VERSIONING.md](VERSIONING.md)).

An adapter is the only vendor-specific code in sessionpipe: one file under
`packages/core/src/adapters/<name>.ts` plus its fixtures under
`conformance/harness/<name>/`. This document is the registry of harness names and,
per harness, where the hooks are written, which native event maps to which protocol
event, which ids the payload carries, where the transcript is read for tier 2, and the
quirks the code must honour. Every mapping here is proven by a fixture recorded from
a real payload; a row without fixtures is marked *(recording pending)* and is not
yet normative.

**What every adapter reads, and nothing more.** A documented hooks or plugin API,
and files the person's own harness wrote on the person's own machine: the transcript
named in the hook payload, a session registry, the config file's account id (or the
API endpoint its settings name, for a home with no login). No vendor API is called,
no credential is read, no token is sent anywhere. The
documentation URL per harness is in its row.

**The one exception, the person's own to make.** A harness whose own service names a
session without telling the machine may be asked for that name, and only when the
person turned it on (`sessionpipe titles on`, config.json `remote_titles`; off by
default). The adapter then reads the harness's sign-in on this machine, sends it to
that service alone, for that one read, and keeps it nowhere: never in a file, an event
or a log. Only Claude Code has one (claude.ai, below).

## Registry

| `harness.name` | Product | Docs | Session end? | Stop can block? | Milestone |
|------------------|---------|------|:---:|:---:|:---:|
| `claude-code` | Claude Code (Anthropic) | code.claude.com/docs/en/hooks | yes | yes | M2 |
| `codex` | Codex CLI (OpenAI) | learn.chatgpt.com/docs/hooks | yes | yes | M2 |
| `gemini-cli` | Gemini CLI (Google) | geminicli.com/docs/hooks/reference | yes | yes (AfterAgent) | M2 |
| `antigravity` | Antigravity (Google) | antigravity.google/docs/hooks | **no** | no | M2 |
| `devin` | Devin CLI (Cognition) | docs.devin.ai/cli/extensibility/hooks/overview | yes | yes (exit 2) | M2 |
| `cursor` | Cursor | cursor.com/docs/hooks | yes | yes (`followup_message`) | M7 |
| `copilot-cli` | GitHub Copilot CLI | docs.github.com/en/copilot/reference/hooks-reference | yes | yes | M7 |
| `droid` | Droid (Factory) | docs.factory.ai/reference/hooks-reference | yes | yes | M7 |
| `kiro` | Kiro (Amazon) | kiro.dev/docs/hooks | **no** | yes | M7 |
| `opencode` | OpenCode (Anomaly) | opencode.ai/docs/plugins | **no** (`session.deleted` only) | n/a (input API) | M7 |

A receiver infers "done" for a harness without a session end from silence, and
presents that as its own reading.

## Common conventions

- **Config written by `sessionpipe install`** is one entry per event, running
  `"<absolute node>" "<absolute dist/hook.js>" <harness> <event>` with quoted absolute
  paths. Never `#!/usr/bin/env node`, never an npx path.
- **stdout**: nothing, except where the harness parses it (Antigravity: `{}`).
- **`session.seq`** is assigned by the sender's outbox, not by the adapter; adapter
  fixtures wildcard it.
- **Facts** (title, url, model, account_id, repo, branch, attended) are read by the worker from
  the harness's files after the hook exits; the hook event itself carries only what
  stdin has. A fixture's `expect` lists what stdin alone yields; `files` in a fixture
  supplies transcripts for fact tests.
- **Ids**: `turn_id` = the harness's prompt/turn id when it has one; `call_id` = its
  tool-use id; `attention_id` = the tool-use id of the permission request when the
  payload has one, else an id the sender mints, unique within the session. Claude
  Code's `PermissionRequest` carries no tool-use id, so its adapter mints
  `perm-<16 hex of sha256(prompt id | tool | input)>`: the same request always names the
  same attention, which is what a `permission.answer` has to name (CONTROL.md §6).
  Notifications without an id are `notif-<epoch ms>`.
- **Who started a turn** (`turn.started.submitted_by`, `turn.started.injected`): only
  `claude-code` fills these today, and only when its payload or the prompt's shape says so.
  `codex`, `gemini-cli` and `devin` leave `submitted_by` absent — no recorded payload of
  theirs names who submitted the prompt — and leave `injected` absent for want of a
  recorded wrapper of their own to key on, not because it is unknowable: all three carry
  the prompt, and Codex's reader already has `codexInjected`. `antigravity`'s `turn.started`
  has no prompt at all. An absent field is unknown, not "the person" (PROTOCOL.md §4).
- **Control** (CONTROL.md §6, §9): only on a machine with control paired, the Stop hook
  asks the daemon's socket for a queued, verified message and may answer a block with
  it, and the PermissionRequest hook may wait there for a verified answer. These two
  are the only hooks that ever print for a harness that doesn't parse stdout, and they
  are exempt from the 150 ms budget.

## Claude Code (`claude-code`) — M2

| | |
|---|---|
| Config | `settings.json` in **every** config dir: `~/.claude`, `$CLAUDE_CONFIG_DIR`, and any `~/.claude-*` holding `projects/` or `settings.json` (one per account; hooks written to one never fire for the others). Timeouts in seconds. |
| Hook shape | `{"hooks":{"<Event>":[{"matcher":"","hooks":[{"type":"command","command":"…","timeout":5}]}]}}`; the matcher is only present on tool and permission events. |
| Mapping | `SessionStart` → `session.started` (`source` ← `source` / `trigger`) · `UserPromptSubmit` → `turn.started` (`turn_id` ← `prompt_id`, `prompt_chars`, `submitted_by` ← the payload's `source` forwarded verbatim when it has one, `injected: true` when the prompt opens with one of Claude Code's own wrappers) · `PreToolUse` → `tool.started` · `PostToolUse` → `tool.ended` ok · `PostToolUseFailure` → `tool.ended` !ok · `PermissionRequest` → `attention.needed` permission · `Notification` → `attention.needed` (`permission_prompt` → permission, `idle_prompt` → idle, `elicitation_dialog` → elicitation, others → question) · `Stop` → `turn.ended` stop (`background` ← the length of `background_tasks`, the in-flight background work Claude Code lists, recorded from 2.1.258 on) · `StopFailure` → `turn.ended` error (`error` = the API error class) · `SubagentStart`/`SubagentStop` → `subagent.*` · `PreCompact`/`PostCompact` → `context.compacted` · `SessionEnd` → `session.ended` (`reason`: `clear` · `logout` · `exit` · `prompt_input_exit`→`exit` · other). |
| Ids in stdin | `session_id`, `prompt_id`, `cwd`, `transcript_path`, `tool_name`, `tool_use_id`, `agent_id`, `permission_mode`, `hook_event_name`. `UserPromptSubmit.source` is in the documented schema (`user` · `sdk` · `system` · `loop_wakeup` · `schedule_wakeup` · `poll_event`, "payloads may omit it while the field rolls out") and is forwarded as is when a payload has the key; none recorded through 2.1.304 does. |
| Env | `CLAUDE_CODE_HOST_SESSION_ID` (`local_…`): the desktop app's id for the session → `session.url` `claude://code/continue/<id>` when no bridge link exists. `CLAUDE_PROJECT_DIR`. `CLAUDE_CODE_SESSION_ATTENDED` (`1` / `0`) and sessionpipe's own `SESSIONPIPE_CONTROL_JOB`, for `session.attended`. |
| Transcript (tier 2) | `<config>/projects/<cwd-slug>/<session_id>.jsonl`; records `type: user\|assistant` with `message.content` a string or text parts, and the person's mid-turn messages: one the running turn absorbs is never a `user` record but `type: attachment` with `attachment.type: queued_command`, `commandMode: prompt` and the text in `attachment.prompt` (a string or text parts); it reaches `turn.transcript` / `turn.progress` as the person's words. Skip `isMeta`, `isSidechain`, non-`human` `origin.kind` (a queued command's is `attachment.origin`, absent in older versions; task notifications and `peer` messages share the record), injected `<tag>…</tag>` blocks. |
| Limits (tier 1) | Only a status line command is handed the account's limits (https://code.claude.com/docs/en/statusline): stdin `rate_limits.five_hour` / `seven_day` / `spend_limit`, each `used_percentage` and `resets_at` (epoch seconds), for Pro and Max (or behind a gateway) and only after the session's first response. A status line hides most of Claude Code's footer hints, so it is opt-in: `install --status-line` writes `statusLine` → the hook with event `StatusLine` and `refreshInterval: 60`, and never replaces one the person set. The hook prints the limits as the line (`5h 23% · week 41%`) and queues a job only when they changed, at most once a minute per config dir; Claude Code runs a status line only on events (an assistant message, a window's reset), so without the timer a change held back that minute would wait for the next prompt; `StatusLine` → `limits.observed`: every window under Claude Code's own key, so one it adds later arrives as its own id; `window_minutes` 300 and 10 080 for `five_hour` and `seven_day` and absent otherwise. `seven_day` is the week across all models. `spend_limit` carries `used_percent` (above 100 once exceeded) and `resets_at`; its `used_usd`, `limit_usd` and `period` are not carried. |
| Facts | Title: the per-pid registry `<config>/sessions/<pid>.json` (`name` with `nameSource` user → `custom`, auto/hook/peer → `harness`; `derived` is never a title), found through process ancestry because a `--continue --remote-control` session files its entry under another id; then `custom-title` / `ai-title` records; then the first human ask cut to 50 chars (`first-ask`). With `remote_titles` on, a session with a claude.ai link takes claude.ai's name for it (`harness`) over everything but a `custom` title: claude.ai names a session the Claude app started a few seconds after its first message and never writes that name to the machine (none of 177 such sessions on one Mac had it on disk), so without this the Claude app shows one name and every local reader another. It is read the way Claude Code reads a session, `GET https://api.anthropic.com/v1/code/sessions/<session_…>` (`anthropic-version: 2023-06-01`; the answer is `{response_shape: {id, title, …}}`, recorded in `conformance/remote/claude-code/`, and Claude Code also reads `session`; asked as `session_…` it names the session `cse_…`, the same one; the title is taken only when the id names the session asked about, cleaned as Claude Code cleans a name, and an answer over 1 MiB is not read), bearing the config dir's own sign-in: the macOS keychain item `Claude Code-credentials` (with `-` and the first 8 hex of the SHA-256 of `$CLAUDE_CONFIG_DIR` as it was set, for a config dir it names), else `<config>/.credentials.json`, `claudeAiOauth.accessToken`. A token within a minute of its `expiresAt` is not used and never refreshed (that would rotate Claude Code's own login). A redirect is refused. Asked again a minute later while it has no name, then every half hour, within 3 s (the worker holds the session's lock); a 400, 401 or 404, or no answer, keeps the name it had. Turning it on (`sessionpipe titles on`, again with `titles refresh`) asks about every session of the last 30 days and sends each one already sent under another name again as `session.backfill` with that name; a backfill takes these names too. A rename in the Claude app needs none of this: it reaches the transcript as a `custom-title` record. URL: registry `bridgeSessionId` → `https://claude.ai/code/<session_…>`, else `bridge_status` / `bridge-session` records. Account: `oauthAccount.accountUuid` in the config dir's `.claude.json` (never the email on an event); control's pair and hello name each config dir's account as `{id: accountUuid, email: emailAddress}`. A config dir with no `oauthAccount` whose `settings.json` sets `env.ANTHROPIC_BASE_URL` to an http(s) host other than Anthropic's (`*.anthropic.com`) runs on another API (Kimi on a Modal endpoint, GLM on Z.ai): its account is `api-` + the first 16 hex of the SHA-256 of that URL's origin (`scheme://host[:port]`; never its path or a `user:password@`), and pair and hello name it `{id, name: host}`. Only that one key is read, never the tokens or headers beside it. Model: last assistant record's `message.model`. Attended: `CLAUDE_CODE_SESSION_ATTENDED=1`, a control turn (`SESSIONPIPE_CONTROL_JOB`), or a link (the bridge link or the desktop app's) → `true`; `0` with none of those → `false`; no variable → absent. |
| Quirks | Running sessions pick up hook changes live from 2.1.280. `type: "http"` handler exists (native lane). A prompt with pasted images can put the first ask megabytes into the file: stream to it, cap at 16 MB. Every headless run says `CLAUDE_CODE_SESSION_ATTENDED=0`, a Remote Control session included, and only a terminal says `1` (measured on 2.1.307–2.1.310). A `claude -p` started inside a Remote Control session inherits `CLAUDE_CODE_ENVIRONMENT_KIND=bridge` and the bridge owner's ids, but the registry entry it writes for itself has no `bridgeSessionId`: its link, not its environment, tells a Remote Control session from a probe run inside one. **Who started a turn is only partly knowable.** No payload recorded through 2.1.304 carries `source` at all, so `turn.started.submitted_by` is absent on every build in the field today and `injected` is the only signal. `injected` is a **closed list of Claude Code's own wrappers** — `<task-notification>`, `<cross-session-message …>`, `<system-reminder>`, `<local-command-stdout>`, `<command-…>`, closed or self-closing, after trimming — and deliberately narrower than this spec's own transcript reader (`isInjected`), which calls any `<tag>…</tag>` block or HTML comment injected. The reader can afford that: dropping one record from a transcript costs little. A `turn.started` cannot, because a receiver acting on `injected` would drop one of the person's own turns whenever they pasted nothing but an SVG, an HTML page or a JSX element. So `injected` **misses**: a peer message delivered as bare text (byte-identical to a person's prompt), a cron or scheduled wake whose prompt is ordinary text, an HTML-comment injection, and any wrapper Claude Code adds after this list. It is also **not** "no person caused this turn": a Talk or `sessionpipe wait` delivery hands the person's own message over inside a `<task-notification>` whose text is an output-file path. The transcript is no substitute: a queued command's `attachment.origin.kind` is absent in older versions, the transcript fixture records a `<cross-session-message>` with `origin.kind: "human"` and `humanTurn: true` (`conformance/transcripts/claude-code/queued-command.jsonl` line 14), and the hook fires before the record lands. Neither field ever proves a person typed the prompt. |
| Start options (CONTROL.md §3.1, §6) | `claude -p`, and its resumes and forks: `read` → `--permission-mode plan`, `safe` → `--permission-mode dontAsk` (a build without `dontAsk`: `--permission-mode default`, or `manual` where it has no `default`, plus `--permission-prompts none` where it has that), `edits` → `--permission-mode acceptEdits`, `auto` → `--permission-mode auto`; `model` → `--model <id>`, two arguments. The Agent SDK: `permissionMode` `plan` / `dontAsk` / `acceptEdits` / `auto`, and the `model` option. A level is offered only when `claude --help` lists the mode it maps to (`plan`, `acceptEdits`, `auto`); `safe` always is. Any well-formed model is passed (`any_model`); Claude Code names an unknown one in its error. Never `bypassPermissions`. On an `inherit` machine a start that names no level gets no `--permission-mode` (and the SDK no `permissionMode`), so Claude Code's own `permissions.defaultMode` decides; a start there may name only `read` or `safe`. |

Fixtures recorded 2026-09-28 on Claude Code 2.1.258 (one `claude -p` run): `SessionStart`,
`UserPromptSubmit`, `PreToolUse` / `PostToolUse` for Bash, Read and Agent (with
`duration_ms` and, inside the subagent, `agent_id`), `PermissionRequest` (no
`tool_use_id`; carries `permission_suggestions`), `SubagentStart` / `SubagentStop`, `Stop`,
`SessionEnd`, `StopFailure` (`error: server_error`, forced with an unreachable API). Still pending real payloads: `PostToolUseFailure`, `Notification`,
`PreCompact` / `PostCompact` (a failing `cat` arrived as a `PostToolUse` with the error in
`tool_response`). Recorded 2026-10-21 on Claude Code 2.1.304, a background task's
notification waking a second turn (`user-prompt-submit-injected.json`): `UserPromptSubmit`
with an injected prompt and **no** `source` key. No recorded payload carries that key, so
the `submitted_by` mapping is covered by unit tests only, until a build sends one.

## Codex (`codex`) — M2

| | |
|---|---|
| Config | `~/.codex/hooks.json` (`{"hooks":{…}}`, Claude-shaped, timeouts in seconds; `SessionEnd` and `Interrupt` are clamped to 3 s), **and** `notify` at the **top level** of `config.toml`, before the first `[table]`, as the fallback when hooks are off. An existing `notify` (Codex Computer Use) is chained through `--previous-notify`, never replaced. Non-managed hooks need trust (`/hooks` in the CLI); the installer says so. |
| Mapping | `SessionStart` → `session.started` · `UserPromptSubmit` → `turn.started` (`turn_id`) · `PreToolUse`/`PostToolUse` → `tool.*` (`tool_response` a string → ok unless it is an error text the harness marks; Codex has no PostToolUseFailure, so `ok` is true and `error` absent) · `PermissionRequest` → `attention.needed` · `Stop` → `turn.ended` stop · `Interrupt` → `turn.ended` interrupt · `SubagentStart`/`SubagentStop` · `PreCompact`/`PostCompact` · `SessionEnd`; notify `agent-turn-complete` → `turn.ended` when hooks are off. |
| Ids in stdin | `session_id`, `turn_id`, `cwd`, `transcript_path`, `model`, `permission_mode`, `tool_name`, `tool_input`, `tool_response`, `tool_use_id` (`exec-<uuid>`), `stop_hook_active`, `last_assistant_message`, `source`, `reason`. |
| Transcript (tier 2) | `transcript_path` = `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl` (`.zst` possible); `response_item` records with `payload.type: message`, `role`, `content[].input_text \| output_text`. Skip user texts starting with `<tag>` (Codex's own injections). |
| Limits (tier 1) | Every turn writes an `event_msg` with `payload.type: token_count` whose `rate_limits` holds `primary` and `secondary` (`used_percent`, `window_minutes`, `resets_at` epoch seconds, either may be null) and `plan_type`. Codex keeps one snapshot and overwrites it with whichever bucket the server named last (`limit_id`: `codex`, or a model's own such as `codex_other`; codex-rs `merge_rate_limit_fields`), so only a snapshot with `limit_id` `codex` or none is read. After a turn ends the worker reads the newest from the rollout's tail → `limits.observed` (ids `primary`, `secondary`), when it changed. |
| Facts | Title: first user message (`first-ask`, 80 chars). `session_meta.payload`: `cwd`, `cli_version`, `git.branch`, `git.repository_url`. Model: last `turn_context.payload.model`. |
| Threads | Only the person's own threads are sessions. **An ephemeral thread** has no rollout: every hook carries `transcript_path: null` and its notify finds no file, so the adapter reports nothing for it. Codex Desktop runs its own background work this way (ambient suggestions and their safety review, a new chat's title), and so does `codex exec --ephemeral`. **A subagent's thread** (its `session_meta.source.subagent`) is part of its parent's session. Codex fires the subagent's hooks with the parent's `session_id`: `SubagentStart` / `SubagentStop` name it as `agent_id`. Its `SubagentStart` and tool calls carry the subagent's own rollout as `transcript_path`, which is never read as the session's transcript. Its notify and its rollout (backfill) report nothing. A fork the person made (`forked_from_id` alone) is a session of its own. |
| Quirks | The `notify` line lands inside a `[projects."…"]` table when appended at the end, and never runs — write before the first table, move a misplaced one. |
| Control | `codex exec --json --skip-git-repo-check -C <cwd> … -- <text>` starts a session; `codex exec resume --json --skip-git-repo-check … -- <id> <text>` continues one; stdin closed. Codex picks the id (`thread.started` → `thread_id`), so a daemon keeps the start's id as the name (CONTROL.md §6 `start`). The answer is the turn's `agent_message` items; `error` items are warnings, `turn.failed` is a failure. Safe mode: `-s workspace-write`; auto: `--approve-for-me`; inherit: no flag, so the person's `config.toml` decides (`approval_policy`, `sandbox_mode`), a resume's too (0.160). Never `--dangerously-bypass-approvals-and-sandbox` or `--dangerously-bypass-hook-trust`. Signed in: `codex login status` exits 0 (or `CODEX_API_KEY` is set). |
| Start options (CONTROL.md §3.1, §6) | `codex exec`: `read` → `-s read-only`, `safe` → `-s workspace-write`, `auto` → `--approve-for-me`; `edits` is not offered, because Codex's safe is its workspace sandbox: edits inside `cwd`, no network, nothing outside. `codex exec resume` takes neither `-s` nor `--approve-for-me`, so it says the same in config overrides: `-c sandbox_mode="read-only"` or `"workspace-write"`, and for `auto` also `-c approval_policy="on-request" -c approvals_reviewer="auto_review"`. `model` → `-m <id>` on both, two arguments. The hello's `models` are the slugs in `$CODEX_HOME/models_cache.json` whose `visibility` is `list` (at most 50), and any well-formed model is passed (`any_model`). Never `danger-full-access`. On an `inherit` machine a start that names no level gets no sandbox or approval flag, so `config.toml` decides; a start there may name only `read` or `safe`. |

Fixtures recorded 2026-09-28 on codex-cli 0.157.1: all of `SessionStart`,
`UserPromptSubmit`, `PreToolUse`, `PostToolUse` (ok and a sandbox error), `Stop`,
`SessionEnd`. Recorded 2026-10-20 on codex-cli 0.160.0, an ephemeral thread
(`codex exec --ephemeral`): `SessionStart`, `UserPromptSubmit`, `Stop` and `SessionEnd`,
each with `transcript_path: null` and an empty `expect`.

## Gemini CLI (`gemini-cli`) — M2

| | |
|---|---|
| Config | `~/.gemini/settings.json` `hooks` key: `{"<Event>":[{"matcher":…,"hooks":[{"type":"command","command":"…","name":"sessionpipe","timeout":5000}]}]}`. **Timeouts in milliseconds.** stdout must be JSON or empty. |
| Mapping | `SessionStart` → `session.started` (`source`) · `BeforeAgent` → `turn.started` (`prompt_chars`) · `BeforeTool`/`AfterTool` → `tool.*` (`tool_response.error` → !ok) · `Notification` (`ToolPermission`) → `attention.needed` permission · `AfterAgent` → `turn.ended` stop · `PreCompress` → `context.compacted` · `SessionEnd` → `session.ended`. |
| Ids in stdin | `session_id`, `cwd`, `transcript_path`, `timestamp`, `hook_event_name`, `tool_name`, `tool_input`, `tool_response`, `prompt`, `prompt_response`, `notification_type`, `message`, `details`, `trigger`, `source`, `reason`. |
| Transcript (tier 2) | `transcript_path` (`~/.gemini/tmp/<hash>/chats/session-*.jsonl`): records of `type: user \| gemini`. |
| Quirks | Gemini CLI's own telemetry defaults `logPrompts` **on**; the installer says so once. |
| Control | Through ACP: `gemini --acp` (*Agents driven through ACP*, below). A session the daemon started this way fires these same hooks, under Gemini CLI's own `session_id`; the daemon keeps the start's id as its name (CONTROL.md §6 `start`). |

Fixtures: *(recording pending: Gemini CLI is not signed in on the recording
machine.)*

## Antigravity (`antigravity`) — M2

| | |
|---|---|
| Config | `~/.gemini/config/hooks.json`: top-level keys are hook **names**; ours is `sessionpipe` = `{"enabled":true,"PreInvocation":[handler],"PostInvocation":[handler],"PostToolUse":[{"matcher":"*","hooks":[handler]}],"Stop":[handler]}`. Timeouts in **seconds**. The file is read when a conversation starts. **No `PreToolUse`**: its answer must carry a `decision`, and `{}` is read as a deny (0.6.1 removed it; a stale entry still loaded is answered `{"decision":"ask",…}` with the reason). |
| Mapping | `PreInvocation` with `invocationNum` 0 → `session.started` (`source: unknown`) **and** `turn.started`; later `PreInvocation`s → nothing at tier ≥ 1 (a heartbeat below) · `PostToolUse` → the same heartbeat (it names no tool, only `stepIdx` and `error`; a payload that does name one → `tool.ended`) · `Stop` → `turn.ended` (`terminationReason`; `error` → `error`). No session end exists. |
| Ids in stdin (camelCase, **no event name** — it rides in argv) | `conversationId`, `workspacePaths[]` (paths or `file://` URIs), `transcriptPath`, `artifactDirectoryPath`, `modelName` (`auto` means unknown), `invocationNum`, `initialNumSteps`, `toolCall.{name,args}`, `stepIdx`, `executionNum`, `terminationReason`, `fullyIdle`. |
| stdout | **`{}`** for every event registered; non-JSON is a deny. |
| Control | `agy -p <text> --output-format stream-json` starts a conversation in the folder it runs in; `--conversation <id>` continues one (an id it doesn't know silently starts a fresh one). agy picks the id (`init` → `conversation_id`), so a daemon keeps the start's id as the name (CONTROL.md §6 `start`); no file records the folder, so it keeps the one a start ran in, or the hooks' `workspacePaths` for a conversation it didn't start. Safe mode passes no permission flag (tool calls are denied and listed in `result.denied_actions`), and neither does inherit; auto passes `--mode accept-edits`. Never `--dangerously-skip-permissions`. |
| Start options (CONTROL.md §3.1, §6) | `safe` → no flag, `edits` → `--mode accept-edits`. `read` is not offered (no read-only mode is known), nor `auto` (accept-edits is its widest), nor `model` (not yet measured). On an `auto` machine its default is reported as what it is: `edits`. On an `inherit` machine its default is no flag, and only `safe` may be named. |
| Transcript (tier 2) | `<data dir>/brain/<conversationId>/.system_generated/logs/transcript.jsonl` — data dirs `~/.gemini/antigravity`, `antigravity-cli`, `antigravity-ide`; records `type: USER_INPUT \| PLANNER_RESPONSE`, `content` with `<USER_REQUEST>` wrapping. |
| Facts | Title: first `USER_INPUT` (`first-ask`). URL: `https://antigravity.google.com/r/<installation_uuid>-v2?p=c/<id>?section=<project>` from `antigravity_state.pbtxt` and `~/.gemini/config/projects/*.json`. |

Fixtures: *(recording pending: a recorder hook is installed on the recording
machine; the next conversation fills them.)*

## Devin (`devin`) — M2

| | |
|---|---|
| Config | The `hooks` key of the **user config file**: `~/.config/devin/config.json` (`$XDG_CONFIG_HOME/devin/config.json` when set; `%APPDATA%\devin\config.json` on Windows). Claude-shaped; `matcher` is a **regex** on the tool name, not a glob; timeouts in **seconds**. `.devin/hooks.v1.json` is project-level only, so there is nothing to write outside the config file. Devin reads **exactly eight** event names and rejects the WHOLE file on one it does not know (`unknown variant ... expected one of PreToolUse, PostToolUse, UserPromptSubmit, Stop, PostCompaction, SessionStart, SessionEnd, PermissionRequest`), which disables every hook in it: the adapter registers those eight and nothing else. The config file is documented as JSON *with comment support*; one with comments is never written back (the install is `skipped` and says why). `/hooks` inside `devin` lists what loaded. `sessionpipe status` reports **`inactive`**, not `current`, when the file holds any event name outside those eight — our entries can be byte-current and still report nothing, because Devin loads none of them. |
| Hook shape | `{"hooks":{"<Event>":[{"matcher":"","hooks":[{"type":"command","command":"…","timeout":5}]}]}}`; the matcher is only present on tool and permission events. |
| Mapping | `SessionStart` → `session.started` (`source`: `startup` · `resume`) · `UserPromptSubmit` → `turn.started` (`turn_id` ← `prompt_id`, `prompt_chars`) · `PreToolUse` → `tool.started` · `PostToolUse` → `tool.ended` (`ok` ← `tool_response.success`, `error` ← `tool_response.error`, `output` ← `tool_response.output`) · `PermissionRequest` → `attention.needed` permission (`attention_id` ← `tool_use_id`, which this payload does carry) · `Stop` → `turn.ended` stop · `PostCompaction` → `context.compacted` auto (Devin has no pre-compaction event) · `SessionEnd` → `session.ended`. |
| Ids in stdin | `hook_event_name`, `session_id` (a word-word slug such as `frill-vulture`, **not** a UUID; it is the primary key of the session store), `prompt_id` (a UUID, per turn, absent from `SessionStart`), `tool_name`, `tool_input`, `tool_use_id` (`call_<24 hex>#<32 hex>`), `tool_response.{success,output,error}`, `prompt`, `last_assistant_message`, `stop_hook_active`, `source`, `reason`. **No `cwd`, no `transcript_path`, no `model`, no `permission_mode`.** |
| Env | `DEVIN_PROJECT_DIR` — the folder; the only thing in a Devin hook invocation that names it, so `session.cwd` comes from there and the worker keeps it (as it does for Antigravity). |
| stdout | **Nothing**, for every event. Devin reads a decision from stdout; silence with exit 0 is "carry on". Printing nothing, printing `{}`, exiting 1 and exceeding the timeout were each measured against a real tool call and none blocked it — only exit 2 or an explicit `{"decision":"block"}` blocks. |
| Transcript (tier 2) | One SQLite database for every session: `~/.local/share/devin/cli/sessions.db` (`$XDG_DATA_HOME/devin/cli/sessions.db`; `%APPDATA%\devin\cli\sessions.db` on Windows), read **read-only**. There is no per-session file, so the adapter addresses a session as `<database>#<session id>`. `message_nodes` is a forest that keeps abandoned branches (27 nodes for a two-turn session): the transcript is the one chain ending at `sessions.main_chain_id`, walked up through `parent_node_id` (a recursive CTE), never every node. `chat_message` is JSON: `role: "user"` with `metadata.is_user_input` true is the person, `role: "assistant"` with non-empty `content` is the reply; `role: "system"` (Cognition's own prompt, the subagent profiles, the skills manifest, the generated `system_info`) and `role: "tool"` are skipped at every tier. `node_id` is the cursor, and it bounds the read: the walk stops there, so a Stop does not re-read the chain's root (a 17 kB system prompt and four more system blocks) every time, and where a chain is longer than the reader's 4000-node cap the **newest** nodes are the ones kept. A turn is timed by the message's own `chat_message.metadata.created_at`; `message_nodes.created_at` is the time the row batch was last **saved** — one value for the whole chain, rewritten on every save, and not monotonic along it — so it is only the fallback for a message with no time of its own. On a machine with neither `node:sqlite` nor the `sqlite3` binary there is no way into the database at all: Devin then reports **tier 0–1 only** — no model, no folder from the store, no title, no times, no tier-2 turns, and an empty `backfill`. |
| Facts | Title: the earliest non-shell `prompt_history.content` (`first-ask`, 80 chars) — `sessions.title` is the titler's own output and holds a backticked command, or a raw `functions.Shell:0{…}` mid-turn. Model: `sessions.model` (the slug, e.g. `swe-2-medium`). `cwd`: `sessions.working_directory`. Times: `sessions.created_at` / `last_activity_at`, which are unix **seconds**. Version: the `_versions/current` symlink under the data directory. Account: `devin.org_id` from the user config — the only account id Devin keeps in a plain local file (`devin auth status` would name the user, but that is a subprocess, and `credentials.toml` is never read). |
| Quirks | Every `devin -p` starts a **new** session with a new slug; `-c` / `-r <id>` reuse the id and fire `SessionStart` again with `source: "resume"`. `Stop` is **not** guaranteed — a turn whose tool was rejected went `UserPromptSubmit` → `PreToolUse` → `PermissionRequest` → `SessionEnd` with no `Stop`; `SessionEnd` fired on every run, and `session.ended` is therefore not "the session is over for good". `PermissionRequest` fires **after** `PreToolUse` for the same `tool_use_id`. Devin also imports `~/.claude/settings.json` hooks (`read_config_from.claude`, on by default), so a Claude Code entry there can be run by Devin: the `claude-code` adapter drops a payload with no `transcript_path` and a non-UUID session id for exactly that reason. |
| Control | Through ACP: `devin acp` (*Agents driven through ACP*, below); a session the daemon started this way fires these same hooks under Devin's own session id, and the daemon keeps the start's id as its name. A `permission.answer` for a `devin` session is still refused (the hook never prints). |

Fixtures recorded 2026-10-08 on Devin CLI 3000.11.3 (seven `devin --model swe-2-medium -p`
runs with a recording hook): `SessionStart` (`startup` and `resume`), `UserPromptSubmit`,
`PreToolUse`, `PostToolUse`, `PermissionRequest`, `Stop`, `SessionEnd`. Still pending a real
payload: `PostCompaction` *(recording pending)* — the runs were far too short to compact.

## Cursor (`cursor`) — M7

`~/.cursor/hooks.json` `{"version":1,"hooks":{…}}`. `sessionStart` · `beforeSubmitPrompt` → `turn.started` · `preToolUse`/`postToolUse`/`postToolUseFailure` · `afterFileEdit` → `files.changed` · `subagent*` · `preCompact` · `stop` → `turn.ended` · `sessionEnd`. Ids: `conversation_id`, `generation_id`, `workspace_roots[]`, `transcript_path \| null`. Observer hooks print nothing (invalid JSON blocks permission hooks); `stop` may return `followup_message` (control prompt). *(recording pending)*

## Copilot CLI (`copilot-cli`) — M7

`~/.copilot/hooks/sessionpipe.json` `{"version":1,"hooks":{…}}`. `sessionStart` · `userPromptSubmitted` · `preToolUse`/`postToolUse`/`postToolUseFailure` · `permissionRequest`, `notification` → `attention` · `agentStop` → `turn.ended` · `subagent*` · `preCompact` · `sessionEnd`. camelCase payload: `sessionId`, `timestamp`, `cwd`, `transcriptPath` on `agentStop`/`preCompact`. Timeouts fail open; `type: "http"` exists. *(recording pending)*

## Droid (`droid`) — M7

`~/.factory/hooks.json`; the nine Claude-shaped events with the Claude Code mapping. Ids: `session_id`, `transcript_path`, `cwd`, `message_id`. Tool names differ (`Execute`, `Create` …) and are kept as given. *(recording pending)*

## Kiro (`kiro`) — M7

`~/.kiro/hooks/sessionpipe.json` (v1 schema). `SessionStart` · `UserPromptSubmit` · `Pre/PostToolUse` · `PostFileSave` → `files.changed` · `Stop` → `turn.ended`. Ids: `session_id`, `cwd`; no transcript path; no session end. *(recording pending)*

## OpenCode (`opencode`) — M7

No shell hook: a plugin file `~/.config/opencode/plugins/sessionpipe.ts` POSTs bus events to the local worker over a Unix socket / named pipe. `session.created` → `session.started` · `message.updated` (user) → `turn.started` · `tool.execute.before/after` · `permission.asked` → `attention` · `session.idle` → `turn.ended` · `session.deleted` → `session.ended`. Ids: `sessionID`, `directory`. Immediate `prompt` and `cancel` exist through the server API (M6). *(recording pending)*

## Agents driven through ACP (control only)

The [Agent Client Protocol](https://agentclientprotocol.com) (ACP) is one JSON-RPC
conversation over an agent's stdin and stdout, the same for every agent that speaks
it. For control (CONTROL.md §6: `start`, then `prompt` and `cancel` in `api` mode) one
client in the daemon drives all of them; nothing here is a hook adapter, and an agent
in this table reports no events unless it also has a row above. The daemon runs only
an agent that is already installed on the machine: its CLI on `PATH`, or the file
`SESSIONPIPE_ACP_<HARNESS>` names (the harness name upper-cased, `-` as `_`:
`SESSIONPIPE_ACP_GEMINI_CLI`); it never downloads one. The launch line per agent is the
one the [ACP registry](https://github.com/agentclientprotocol/registry) publishes and
checks nightly, as of its 2026-10-22 state (the registry id in the second column); a
harness that has a row above keeps its name here. Claude Code, Codex and Antigravity
have their own drivers (above) and their ACP wrappers (`claude-acp`, `codex-acp`,
`antigravity-acp`) are not run.

| `harness.name` | Registry id | Product | Launch |
|----------------|-------------|---------|--------|
| `gemini-cli` | `gemini` | Gemini CLI (Google) | `gemini --acp` |
| `devin` | `devin` | Devin CLI (Cognition) | `devin acp` |
| `opencode` | `opencode` | OpenCode | `opencode acp` |
| `cursor` | `cursor` | Cursor | `cursor-agent acp` |
| `copilot-cli` | `github-copilot-cli` | GitHub Copilot CLI | `copilot --acp` |
| `droid` | `factory-droid` | Droid (Factory) | `droid exec --output-format acp-daemon` |
| `goose` | `goose` | goose (Block) | `goose acp` |
| `kilo` | `kilo` | Kilo | `kilo acp` |
| `qwen-code` | `qwen-code` | Qwen Code | `qwen --acp --experimental-skills` |
| `cline` | `cline` | Cline | `cline --acp` |
| `auggie` | `auggie` | Auggie (Augment) | `auggie --acp` |
| `kimi` | `kimi` | Kimi CLI (Moonshot) | `kimi acp` |
| `amp` | `amp-acp` | Amp (Sourcegraph) | `amp-acp` |
| `mistral-vibe` | `mistral-vibe` | Mistral Vibe | `vibe-acp` |
| `bob` | `bob` | Bob (IBM) | `bob acp` |
| `grok-build` | `grok-build` | Grok Build (xAI) | `grok agent stdio` |
| `qoder` | `qoder` | Qoder CLI | `qodercli --acp` |
| `minimax-code` | `minimax-code` | MiniMax Code | `mcode acp` |
| `codebuddy-code` | `codebuddy-code` | Codebuddy Code (Tencent) | `codebuddy --acp` |
| `nova` | `nova` | Nova (Compass) | `nova acp` |
| `dimcode` | `dimcode` | DimCode | `dim acp` |
| `dirac` | `dirac` | Dirac | `dirac --acp` |
| `harn` | `harn` | Harn | `harn serve acp` |
| `vtcode` | `vtcode` | VT Code | `vtcode acp` |
| `stakpak` | `stakpak` | Stakpak | `stakpak acp` |
| `crow-cli` | `crow-cli` | crow-cli | `crow-cli acp` |
| `corust-agent` | `corust-agent` | Corust Agent | `corust-agent-acp` |
| `cortex-code` | `cortex-code` | Cortex Code (Snowflake) | `cortex acp serve` |
| `kimchi` | `kimchi` | Kimchi | `kimchi --mode acp` |

What the daemon says and reads, in the protocol's own names:

- `initialize` with `protocolVersion: 1`, `clientCapabilities: {fs: {readTextFile: false,
  writeTextFile: false}, terminal: false}` and `clientInfo` naming sessionpipe. An agent
  that answers with `authMethods` and then refuses `session/new` with an *authentication
  required* error is acked `failed` with the agent's words: signing in is done at the
  machine's terminal, never by the daemon.
- `session/new` with `cwd` (the start's folder) and `mcpServers: []`; `session/load`
  with the same and the agent's `sessionId` to reopen one.
- `session/prompt` with one `text` block; its response's `stopReason` ends the turn.
- `session/update`: `agent_message_chunk` whose `content` is `text` is the reply;
  `tool_call` and `tool_call_update` name what ran (for the reply's list of refusals);
  every other kind is ignored.
- `session/request_permission`: answered from the machine's mode (CONTROL.md §6).
- `session/cancel` (a notification) for `cancel`.

A session an ACP agent runs is placed by the folder its start ran in, which the daemon
records with the agent's session id (`aliases.json`), or by the folder the harness's
own hooks reported where it has a row above.

