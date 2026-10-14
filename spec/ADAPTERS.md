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
named in the hook payload, a session registry, the config file's account id. No
vendor API is called, no credential is read, no token is sent anywhere. The
documentation URL per harness is in its row.

## Registry

| `harness.name` | Product | Docs | Session end? | Stop can block? | Milestone |
|------------------|---------|------|:---:|:---:|:---:|
| `claude-code` | Claude Code (Anthropic) | code.claude.com/docs/en/hooks | yes | yes | M2 |
| `codex` | Codex CLI (OpenAI) | learn.chatgpt.com/docs/hooks | yes | yes | M2 |
| `gemini-cli` | Gemini CLI (Google) | geminicli.com/docs/hooks/reference | yes | yes (AfterAgent) | M2 |
| `antigravity` | Antigravity (Google) | antigravity.google/docs/hooks | **no** | no | M2 |
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
- **Facts** (title, url, model, account_id, repo, branch) are read by the worker from
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
| Mapping | `SessionStart` → `session.started` (`source` ← `source` / `trigger`) · `UserPromptSubmit` → `turn.started` (`turn_id` ← `prompt_id`, `prompt_chars`) · `PreToolUse` → `tool.started` · `PostToolUse` → `tool.ended` ok · `PostToolUseFailure` → `tool.ended` !ok · `PermissionRequest` → `attention.needed` permission · `Notification` → `attention.needed` (`permission_prompt` → permission, `idle_prompt` → idle, `elicitation_dialog` → elicitation, others → question) · `Stop` → `turn.ended` stop · `StopFailure` → `turn.ended` error (`error` = the API error class) · `SubagentStart`/`SubagentStop` → `subagent.*` · `PreCompact`/`PostCompact` → `context.compacted` · `SessionEnd` → `session.ended` (`reason`: `clear` · `logout` · `exit` · `prompt_input_exit`→`exit` · other). |
| Ids in stdin | `session_id`, `prompt_id`, `cwd`, `transcript_path`, `tool_name`, `tool_use_id`, `agent_id`, `permission_mode`, `hook_event_name`. |
| Env | `CLAUDE_CODE_HOST_SESSION_ID` (`local_…`): the desktop app's id for the session → `session.url` `claude://code/continue/<id>` when no bridge link exists. `CLAUDE_PROJECT_DIR`. |
| Transcript (tier 2) | `<config>/projects/<cwd-slug>/<session_id>.jsonl`; records `type: user\|assistant` with `message.content` a string or text parts. Skip `isMeta`, `isSidechain`, non-`human` `origin.kind`, injected `<tag>…</tag>` blocks. |
| Facts | Title: the per-pid registry `<config>/sessions/<pid>.json` (`name` with `nameSource` user → `custom`, auto/hook/peer → `harness`; `derived` is never a title), found through process ancestry because a `--continue --remote-control` session files its entry under another id; then `custom-title` / `ai-title` records; then the first human ask cut to 50 chars (`first-ask`). URL: registry `bridgeSessionId` → `https://claude.ai/code/<session_…>`, else `bridge_status` / `bridge-session` records. Account: `oauthAccount.accountUuid` in the config dir's `.claude.json` (never the email on an event); control's pair and hello name each config dir's account as `{id: accountUuid, email: emailAddress}`. Model: last assistant record's `message.model`. |
| Quirks | Running sessions pick up hook changes live from 2.1.280. `type: "http"` handler exists (native lane). A prompt with pasted images can put the first ask megabytes into the file: stream to it, cap at 16 MB. |

Claude Code 2.1.300's `claude mcp list` can fire a lone `SessionEnd` with a fresh id
and a transcript path that never exists (reported 2026-10-13). The worker ignores
that end when the session has neither an outbox nor saved facts and the transcript
is absent. An end backed by any of those is preserved. This avoids inventing a
session for an administrative command (PROTOCOL.md §4); the reported shape is in
`conformance/worker/claude-code-mcp-list.json`.

Fixtures recorded 2026-09-28 on Claude Code 2.1.258 (one `claude -p` run): `SessionStart`,
`UserPromptSubmit`, `PreToolUse` / `PostToolUse` for Bash, Read and Agent (with
`duration_ms` and, inside the subagent, `agent_id`), `PermissionRequest` (no
`tool_use_id`; carries `permission_suggestions`), `SubagentStart` / `SubagentStop`, `Stop`,
`SessionEnd`, `StopFailure` (`error: server_error`, forced with an unreachable API). Still pending real payloads: `PostToolUseFailure`, `Notification`,
`PreCompact` / `PostCompact` (a failing `cat` arrived as a `PostToolUse` with the error in
`tool_response`).

## Codex (`codex`) — M2

| | |
|---|---|
| Config | `~/.codex/hooks.json` (`{"hooks":{…}}`, Claude-shaped, timeouts in seconds; `SessionEnd` and `Interrupt` are clamped to 3 s), **and** `notify` at the **top level** of `config.toml`, before the first `[table]`, as the fallback when hooks are off. An existing `notify` (Codex Computer Use) is chained through `--previous-notify`, never replaced. Non-managed hooks need trust (`/hooks` in the CLI); the installer says so. |
| Mapping | `SessionStart` → `session.started` · `UserPromptSubmit` → `turn.started` (`turn_id`) · `PreToolUse`/`PostToolUse` → `tool.*` (`tool_response` a string → ok unless it is an error text the harness marks; Codex has no PostToolUseFailure, so `ok` is true and `error` absent) · `PermissionRequest` → `attention.needed` · `Stop` → `turn.ended` stop · `Interrupt` → `turn.ended` interrupt · `SubagentStart`/`SubagentStop` · `PreCompact`/`PostCompact` · `SessionEnd`; notify `agent-turn-complete` → `turn.ended` when hooks are off. |
| Ids in stdin | `session_id`, `turn_id`, `cwd`, `transcript_path`, `model`, `permission_mode`, `tool_name`, `tool_input`, `tool_response`, `tool_use_id` (`exec-<uuid>`), `stop_hook_active`, `last_assistant_message`, `source`, `reason`. |
| Transcript (tier 2) | `transcript_path` = `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl` (`.zst` possible); `response_item` records with `payload.type: message`, `role`, `content[].input_text \| output_text`. Skip user texts starting with `<tag>` (Codex's own injections). |
| Facts | Title: first user message (`first-ask`, 80 chars). `session_meta.payload`: `cwd`, `cli_version`, `git.branch`, `git.repository_url`. Model: last `turn_context.payload.model`. |
| Quirks | The `notify` line lands inside a `[projects."…"]` table when appended at the end, and never runs — write before the first table, move a misplaced one. |
| Control | `codex exec --json --skip-git-repo-check -C <cwd> … -- <text>` starts a session; `codex exec resume --json --skip-git-repo-check … -- <id> <text>` continues one; stdin closed. Codex picks the id (`thread.started` → `thread_id`), so a daemon keeps the start's id as the name (CONTROL.md §6 `start`). The answer is the turn's `agent_message` items; `error` items are warnings, `turn.failed` is a failure. Safe mode: `-s workspace-write`; auto: `--approve-for-me`. Never `--dangerously-bypass-approvals-and-sandbox` or `--dangerously-bypass-hook-trust`. Signed in: `codex login status` exits 0 (or `CODEX_API_KEY` is set). |

Fixtures recorded 2026-09-28 on codex-cli 0.157.1: all of `SessionStart`,
`UserPromptSubmit`, `PreToolUse`, `PostToolUse` (ok and a sandbox error), `Stop`,
`SessionEnd`.

## Gemini CLI (`gemini-cli`) — M2

| | |
|---|---|
| Config | `~/.gemini/settings.json` `hooks` key: `{"<Event>":[{"matcher":…,"hooks":[{"type":"command","command":"…","name":"sessionpipe","timeout":5000}]}]}`. **Timeouts in milliseconds.** stdout must be JSON or empty. |
| Mapping | `SessionStart` → `session.started` (`source`) · `BeforeAgent` → `turn.started` (`prompt_chars`) · `BeforeTool`/`AfterTool` → `tool.*` (`tool_response.error` → !ok) · `Notification` (`ToolPermission`) → `attention.needed` permission · `AfterAgent` → `turn.ended` stop · `PreCompress` → `context.compacted` · `SessionEnd` → `session.ended`. |
| Ids in stdin | `session_id`, `cwd`, `transcript_path`, `timestamp`, `hook_event_name`, `tool_name`, `tool_input`, `tool_response`, `prompt`, `prompt_response`, `notification_type`, `message`, `details`, `trigger`, `source`, `reason`. |
| Transcript (tier 2) | `transcript_path` (`~/.gemini/tmp/<hash>/chats/session-*.jsonl`): records of `type: user \| gemini`. |
| Quirks | Gemini CLI's own telemetry defaults `logPrompts` **on**; the installer says so once. |

Fixtures: *(recording pending: Gemini CLI is not signed in on the recording
machine.)*

## Antigravity (`antigravity`) — M2

| | |
|---|---|
| Config | `~/.gemini/config/hooks.json`: top-level keys are hook **names**; ours is `sessionpipe` = `{"enabled":true,"PreInvocation":[handler],"PostInvocation":[handler],"PostToolUse":[{"matcher":"*","hooks":[handler]}],"Stop":[handler]}`. Timeouts in **seconds**. The file is read when a conversation starts. **No `PreToolUse`**: its answer must carry a `decision`, and `{}` is read as a deny (0.6.1 removed it; a stale entry still loaded is answered `{"decision":"ask",…}` with the reason). |
| Mapping | `PreInvocation` with `invocationNum` 0 → `session.started` (`source: unknown`) **and** `turn.started`; later `PreInvocation`s → nothing at tier ≥ 1 (a heartbeat below) · `PostToolUse` → the same heartbeat (it names no tool, only `stepIdx` and `error`; a payload that does name one → `tool.ended`) · `Stop` → `turn.ended` (`terminationReason`; `error` → `error`). No session end exists. |
| Ids in stdin (camelCase, **no event name** — it rides in argv) | `conversationId`, `workspacePaths[]` (paths or `file://` URIs), `transcriptPath`, `artifactDirectoryPath`, `modelName` (`auto` means unknown), `invocationNum`, `initialNumSteps`, `toolCall.{name,args}`, `stepIdx`, `executionNum`, `terminationReason`, `fullyIdle`. |
| stdout | **`{}`** for every event registered; non-JSON is a deny. |
| Control | `agy -p <text> --output-format stream-json` starts a conversation in the folder it runs in; `--conversation <id>` continues one (an id it doesn't know silently starts a fresh one). agy picks the id (`init` → `conversation_id`), so a daemon keeps the start's id as the name (CONTROL.md §6 `start`); no file records the folder, so it keeps the one a start ran in, or the hooks' `workspacePaths` for a conversation it didn't start. Safe mode passes no permission flag (tool calls are denied and listed in `result.denied_actions`); auto passes `--mode accept-edits`. Never `--dangerously-skip-permissions`. |
| Transcript (tier 2) | `<data dir>/brain/<conversationId>/.system_generated/logs/transcript.jsonl` — data dirs `~/.gemini/antigravity`, `antigravity-cli`, `antigravity-ide`; records `type: USER_INPUT \| PLANNER_RESPONSE`, `content` with `<USER_REQUEST>` wrapping. |
| Facts | Title: first `USER_INPUT` (`first-ask`). URL: `https://antigravity.google.com/r/<installation_uuid>-v2?p=c/<id>?section=<project>` from `antigravity_state.pbtxt` and `~/.gemini/config/projects/*.json`. |

Fixtures: *(recording pending: a recorder hook is installed on the recording
machine; the next conversation fills them.)*

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
