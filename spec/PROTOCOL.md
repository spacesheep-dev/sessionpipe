# sessionpipe protocol v1

> This document is part of the sessionpipe protocol and is licensed under [CC BY 4.0](LICENSE). The words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are used as in RFC 2119. Status: **Draft** (see [VERSIONING.md](VERSIONING.md)).

## 1. What this is

A coding-agent harness (Claude Code, Codex, Gemini CLI, Antigravity, Devin, Cursor, …) fires
hooks as a session runs. sessionpipe turns those hooks into a small, uniform stream of
**events** about the session — started, working on a tool, needs you, ended — filtered
to a **privacy tier** the person chose per destination, and delivers them to any
**receiver** over HTTP (or to a file, or to stdout). A receiver may send **control
messages** back (answer a permission prompt, queue a message for the next turn).

The protocol carries **facts and timestamps**. It never carries a verdict: what
"stale" means, when a session that never said goodbye is "done", and what a session
is about are a receiver's readings, made from the facts.

This document defines the envelope, the session block, the event vocabulary and the
tiers. [HTTP.md](HTTP.md) is the wire binding, [PRIVACY.md](PRIVACY.md) the tiers and
rulesets in detail, [CONTROL.md](CONTROL.md) the channel back, [ADAPTERS.md](ADAPTERS.md)
the per-harness mapping, [VERSIONING.md](VERSIONING.md) how this changes.

## 2. Envelope

Every event is one JSON object with exactly these top-level members. The normative
shape is [`schema/v1/event.json`](https://sessionpipe.org/schema/v1/event.json),
generated from the reference implementation's types.

```json
{
  "protocol": 1,
  "id": "01K6ABCXYZ0123456789ABCDEF",
  "type": "tool.ended",
  "time": "2026-09-28T01:03:11.204Z",
  "tier": 1,
  "harness": { "name": "claude-code", "version": "2.1.290", "event": "PostToolUse" },
  "session": {
    "id": "8c132906-8c3f-4814-870a-afc3d05e1d2e",
    "seq": 412,
    "machine": "misha-air", "cwd": "~/spacesheep",
    "repo": "github.com/micmmakarov/spacesheep", "branch": "main",
    "model": "claude-fable-5-1",
    "title": "Open-source session hooks", "title_source": "harness",
    "url": "https://claude.ai/code/session_01…", "account_id": "a1b2…",
    "attended": true, "parent_id": null
  },
  "privacy": { "rulesets": ["secrets@1"], "pii": false },
  "data": { "tool": "Bash", "call_id": "toolu_01…", "ms": 1830, "ok": true }
}
```

| Field | Type | Req. | Rule |
|-------|------|:----:|------|
| `protocol` | integer | yes | `1`. Bumped only on a breaking change ([VERSIONING.md](VERSIONING.md)). |
| `id` | ULID | yes | Unique per event. The idempotency key for control acks. |
| `type` | string | yes | Dotted, lowercase (`^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$`), or the literal `native`. From §4. A receiver MUST accept and store an unknown type; it MUST NOT reject the batch for it. |
| `time` | RFC 3339 | yes | The sender's clock, UTC, millisecond precision (`…Z`). Receivers MUST also stamp their own arrival time. |
| `tier` | 0–3 | yes | The tier the event was filtered to. A receiver MUST answer 403 to an event above its `max_tier` and MUST NOT silently keep it. |
| `harness` | object | yes | `name` from the registry in ADAPTERS.md (`claude-code`, `codex`, `gemini-cli`, `antigravity`, `devin`, `cursor`, `copilot-cli`, `droid`, `kiro`, `opencode`; other `[a-z0-9-]` names allowed); `version` and `event` (the harness's own event name) optional. |
| `session` | object | yes | §3. `id` and `seq` required, the rest optional. |
| `privacy` | object | yes | `rulesets`: the redaction rulesets that ran (`secrets@1` MUST be present above tier 0); `pii`: whether `pii@1` ran. |
| `data` | object | yes | Per type, §4. Extra keys are allowed; a receiver MUST keep them. |

## 3. The session block

Every event carries the session as the sender knows it **at that moment**. A hook
fired a second after start may know only the id and the folder; the worker learns the
title, the model and the link later from the harness's own files. A receiver MUST
merge with COALESCE semantics: a later event whose field is absent or empty never
blanks an earlier full value.

| Field | Rule |
|-------|------|
| `id` | The harness's own session id; ≤ 128 chars of `[A-Za-z0-9._:-]`. |
| `seq` | Integer ≥ 0, monotonic per (harness, session) per sender. With `harness.name` and `session.id` it is the deduplication key. Order of arrival is not guaranteed; `seq` is the order. |
| `machine` | A name for the sending machine: the hostname unless the person configured one. A sender MUST NOT guess it; an empty field beats a wrong one. |
| `cwd` | The folder the session started in. The home directory is written `~`. |
| `repo` | The `origin` remote as a URL with any credentials stripped. |
| `branch` | The checked-out branch; absent on a detached HEAD. |
| `model` | The model id the harness reports. |
| `title`, `title_source` | The session's name and where it came from: `custom` (the person named it), `harness` (the tool's own titler), `first-ask` (the first prompt, cut). A receiver SHOULD never replace a better source with a worse one. |
| `url` | A link that opens the session (a Remote Control link, a web remote). |
| `account_id` | An opaque id for the harness account, never an email. A receiver the person paired with for control learns the email that goes with it from the pairing request and the daemon's hellos (`accounts`, [CONTROL.md §2](CONTROL.md#2-keys-and-enrollment)). A Claude Code home that runs on another API has no harness login; its account is the endpoint, `api-` and 16 hex characters of the SHA-256 of the endpoint's origin, the same on every machine that uses it, and the hellos name it by the endpoint's host. |
| `attended` | Whether a person attends the session, as the harness says: `true` when one is at it or drives it from one of its own clients (a terminal, a remote-control link, a desktop app), `false` for a run nobody watches, such as a headless run a script started. Absent when the harness does not say, and a receiver MUST read absent as unknown, never as `false`. A later event may change it (a headless session resumed in a terminal). |
| `parent_id` | For a subagent's own events: the parent session's id. `null` or absent otherwise. |
| `launched_by` | The session that started this one, as `<harness>:<id>` (the form [CONTROL.md](CONTROL.md) uses for a command's session): a script that runs `claude -p` for a session sets `SESSIONPIPE_LAUNCHED_BY` in the child's environment, and the hook carries it. It names at most the nearest launcher: environments are inherited, so anything that starts a further session MUST unset or reset it, and a value that names the session itself is ignored. Absent for a subagent, whose launcher is its `parent_id`, and when nothing says. A receiver MAY group on it and MUST NOT read it as a subagent. |

**Short id.** Where a session is named to a person (a log line, a notification, a
search box), senders and receivers use its short id: the first 8 hex digits, lowercase,
of `sha256("sessionpipe.session:" + harness.name + ":" + session.id)`. It is derived
from fields every event carries and is never sent. The id's own prefix is not a short
form: Codex ids are time-ordered (UUIDv7), so two sessions started in the same minute
share their first eight characters. A receiver SHOULD accept a typed prefix of a short
id and resolve it against its sessions newest first, and MUST list the candidates
rather than pick one when more than one matches. Vectors: `claude-code` with
`8c132906-8c3f-4814-870a-afc3d05e1d2e` → `58ab6602`; `codex` with
`01a10860-a43f-7ce2-b12f-a7911ae8a880` → `ae08c6ab`.

## 4. Event vocabulary

*Tier* is the lowest tier that carries the type; a sink below it never sees it.
Per-type `data` shapes are normative in
[`schema/v1/event-data.json`](https://sessionpipe.org/schema/v1/event-data.json).

| type | tier | data | Fires when |
|------|:----:|------|------------|
| `session.started` | 0 | `source`: `startup` · `resume` · `clear` · `compact` · `fork` · `unknown` | The harness's session-start hook; for Antigravity, the first `PreInvocation` of a conversation. |
| `session.heartbeat` | 0 | — | At most once per 60 s while a turn is running, for sinks **below tier 1** (which get no tool events). Lets a tier-0 receiver show "working". |
| `session.ended` | 0 | `reason`: `clear` · `logout` · `exit` · `other` | The harness's session-end hook. Four harnesses never fire one (ADAPTERS.md); a receiver infers "done" from silence and MUST present that as its own reading. |
| `session.backfill` | 0 | `started_at`, `last_at`, `turns?` | One per historical session found in local files at install. `seq` is 0 and the session block carries what the files say. |
| `session.forgotten` | 0 | — | The person ran `sessionpipe forget`. A receiver MUST delete everything it holds for the session and answer as for any accepted event. |
| `turn.started` | 0 | `turn_id?`, `submitted_by?` (the harness's own word for who submitted the prompt), `injected?` (`true`: the prompt text is a block the harness wrote); tier 1 adds `prompt_chars` | A prompt was submitted. |
| `turn.ended` | 0 | `turn_id?`, `reason`: `stop` · `interrupt` · `error`, `ms?`, `background?` (integer); tier 1 adds `error` (the harness's error class when the reason is `error`) | The Stop / AfterAgent / agentStop hook; Claude Code's `StopFailure` (a turn that ended on an API error) with `reason: error`. `background` is how much background work the harness reports still in flight as the turn ends, each piece of which wakes the session when it finishes (a background shell command, a monitor, a subagent, a workflow); it is a count, never what that work runs. A session whose last turn ended with `background` > 0 is paused waiting on its own work, not done: a receiver MAY show it as working until its next event. Absent when the harness doesn't say. |
| `turn.transcript` | 2 | `turn` (integer), `user`, `assistant` (each ≤ 20 000 chars, redacted), `at` | Read from the harness's transcript file by the worker after a turn ends; one event per completed exchange, in order. |
| `turn.progress` | 2 | `turn` (integer), `user`, `assistant` (each ≤ 20 000 chars, redacted; over the cap the `assistant` side keeps its **end**), `at` | The turn still running: its prompt as the turn starts, then what the assistant has said so far, at most every 20 s on a tool call and only when it changed. `turn` is the number its `turn.transcript` will carry. A receiver keeps the latest per session and drops it once that `turn.transcript` (or the turn's end) arrives; it is a reading, never history. OPTIONAL for senders. |
| `tool.started` | 1 | `tool`, `call_id?`, `turn_id?`, `agent_id?` (set when a subagent made the call); tier 3 adds `input` | Pre-tool hook. OPTIONAL for senders whose harness has none. |
| `tool.ended` | 1 | `tool`, `call_id?`, `turn_id?`, `agent_id?`, `ms?`, `ok`, `error?`; tier 3 adds `input`, `output` (each ≤ 64 KB) | Post-tool hook. A tool name is `[A-Za-z0-9_.:-]{1,120}`; MCP tools keep the harness's own spelling. |
| `files.changed` | 1 | `paths[]` (repo-relative or `~`-relative) | File-edit hooks (Cursor, Kiro, Goose), or paths lifted from a write tool's input. |
| `attention.needed` | 0 | `attention_id`, `kind`: `permission` · `question` · `elicitation` · `idle` · `error`; tier 1 adds `tool`, `message` (redacted, ≤ 200) | PermissionRequest, Notification, permission.asked. Tier-0 receivers learn "needs you" without the words. |
| `attention.cleared` | 0 | `attention_id`, `how`: `answered` · `cancelled` · `timeout` · `unknown` | The next event that proves the prompt was resolved (a tool ran, a turn ended), or a control answer. |
| `subagent.started` / `subagent.ended` | 1 | `agent_id`, `agent_type?` | Subagent hooks; the subagent's own events carry `session.parent_id`. |
| `context.compacted` | 1 | `trigger`: `manual` · `auto` | Compaction hooks. |
| `native` | 3 | the raw hook JSON | Only on the native lane (HTTP.md §6); never emitted by the client. |

Rules for all types:

- A sender MUST emit at least `session.started` (or `session.backfill`) before
  any other event of a session, and SHOULD emit `turn.started` / `turn.ended` for
  every prompt its harness reports.
- A sender MUST NOT emit a type at a tier below the type's tier (a `tool.ended` in a
  tier-0 event is a protocol error; a receiver MAY reject it with reason `tier_type`).
- `attention_id`, `turn_id`, `call_id`, `agent_id` are opaque strings the sender
  chooses; when the harness provides one (`tool_use_id`, `prompt_id`) it SHOULD be
  used as is.
- **Who started a turn.** `turn.started.submitted_by` is the harness's **own** word for
  who submitted the prompt (Claude Code: `user` · `sdk` · `system` · `loop_wakeup` ·
  `schedule_wakeup` · `poll_event`). It is a different vocabulary from
  `session.started.source`, which is this spec's own enum; a receiver MUST NOT merge the
  two. `turn.started.injected` is `true` when the prompt **text** is a block the harness
  wrote around something rather than words a person typed. Both fields are OPTIONAL for
  senders.
  - A sender whose harness supplies the word MUST forward it verbatim and MUST NOT map it
    onto a vocabulary of this spec, because a harness may extend its own list at any time.
    The value is a bare word, `[A-Za-z0-9][A-Za-z0-9_.-]{0,39}`, because tier 0 is not
    redacted ([PRIVACY.md](PRIVACY.md) §2); a sender whose harness supplies something else,
    or supplies nothing, MUST omit the field rather than guess.
  - `injected: true` says only that the prompt is **not the person's words**. It MUST NOT be
    read as "no person caused this turn": a harness may hand a person's message to a session
    inside an injected block, as Claude Code does with a `<task-notification>`. A sender MAY
    decide it from the prompt's shape, which is a reading and can be wrong in either
    direction; each sender's gaps belong in [ADAPTERS.md](ADAPTERS.md).
  - A receiver MUST read an absent field as **unknown** — never as "a person submitted
    this" — and MUST keep a value it does not recognise. A receiver that acts on either
    field MUST NOT read silence as the opposite.
  - A receiver that separates the person's own activity from the harness's (a recency board)
    MAY act on `injected: true` **together with** whatever else it knows about who caused
    the turn, or on a `submitted_by` that the sender's harness documents as non-human. A
    harness MAY fire a further `turn.started` for a `turn_id` already seen, when it absorbs
    a message into a running turn; a receiver MUST NOT let a later `injected: true`
    reclassify a turn it has already accepted without it.

## 5. Tiers

What each tier carries. The full rules, the rulesets and guidance are in
[PRIVACY.md](PRIVACY.md).

| What | 0 | 1 | 2 | 3 |
|------|:-:|:-:|:-:|:-:|
| Session id, state events, timing | ✓ | ✓ | ✓ | ✓ |
| Machine, cwd, repo, branch, model, title, url, account_id, attended | ✓ | ✓ | ✓ | ✓ |
| Attention kind | ✓ | ✓ | ✓ | ✓ |
| Tool names, durations, ok/error | — | ✓ | ✓ | ✓ |
| File paths touched | — | ✓ | ✓ | ✓ |
| Attention message, prompt length, subagents, compactions | — | ✓ | ✓ | ✓ |
| Prompts and assistant text (`turn.transcript`, `turn.progress`) | — | — | ✓ | ✓ |
| Tool input and output, thinking, raw lines | — | — | — | ✓ |
| Secrets ruleset | n/a | always | always | always |
| PII ruleset | opt-in | opt-in | opt-in | opt-in |

**Filtering is a pure function.** `filter(event, tier, pii)` returns the event with
fields removed and strings redacted. It removes by **allowlist per type**, never by
denylist, so a field the spec does not name at a tier is not sent at that tier. The
same function runs in the conformance runner, so a receiver can prove what a tier-N
event may contain.

**Tier per sink, capped by the receiver.** A sink is configured at a tier; the
receiver's well-known file declares `max_tier`; the sender uses the lower.

## 6. Invariants a sender keeps

1. **Never lose, never duplicate.** The outbox is append-only; a sink's cursor
   advances only on a 2xx; every event carries `seq`; a receiver deduplicates on
   (harness.name, session.id, session.seq). An outage costs delay, never an event.
2. **Secrets never leave.** `secrets@1` runs on every string above tier 0 before an
   event reaches the outbox, and cannot be turned off per sink.
3. **The hook path is invisible.** The process a harness spawns reads stdin, writes
   one job file, spawns a detached worker and exits 0; it writes to stdout only what
   the harness requires. Nothing in this protocol may block or alter the harness.
4. **No telemetry.** A sender reports to the sinks the person configured and to
   nobody else.

## 7. Conformance

A sender or receiver is conformant when it passes the fixtures under
`conformance/`: adapter fixtures (real hook payloads → expected events), redaction
vectors, and delivery scenarios (HTTP.md §7). `sessionpipe-conformance` runs them.
