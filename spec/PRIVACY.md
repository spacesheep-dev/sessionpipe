# Privacy: tiers and rulesets

> This document is part of the sessionpipe protocol and is licensed under [CC BY 4.0](LICENSE). The words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are used as in RFC 2119. Status: **Draft** (see [VERSIONING.md](VERSIONING.md)).

Sessions are personal. A prompt names colleagues, a path names a client, a pasted
config carries a key. The protocol's answer is **data minimisation by construction**:
a sink gets a tier, the tier is an allowlist, and two rulesets scrub what remains.

## 1. Tiers

| Tier | Name | Carries |
|-----:|------|---------|
| 0 | presence | Session id, state events (`session.*`, `turn.started`, `turn.ended`, `attention.*` with only `attention_id` and `kind`), timing, machine, cwd, repo, branch, model, title, url, account_id, attended, launched_by. Enough for "working / needs you / done" and a link to open the session. `turn.started` carries `submitted_by` and `injected`: who started the turn, and whether its prompt was the harness's own block — never any of the prompt's words, but `injected` is one bit read off the prompt's first characters, where the prompt's bare length (`prompt_chars`) is tier 1. `submitted_by` is a bare word (PROTOCOL.md §4) because tier 0 is not scrubbed by `secrets@1`. |
| 1 | actions | + tool names, `call_id`, durations, ok/error text, `files.changed` paths, attention `tool` and `message` (redacted, ≤ 200 chars), `prompt_chars`, subagents, compactions, the account's usage limits (`limits.observed`: percentages, reset times, plan). Enough for an activity feed. |
| 2 | conversation | + `turn.transcript`: the person's prompts and the assistant's text, redacted, ≤ 20 000 chars a side, and `turn.progress`, the same for a turn still running. Enough for memory, search, recaps. |
| 3 | full | + tool `input` and `output` (≤ 64 KB each), thinking where the harness exposes it, the native lane's raw lines. Full replay; meant for a receiver you own. |

Rules:

- **Allowlist per type.** `filter(event, tier, pii)` keeps, for each type, only the
  fields the table in [PROTOCOL.md §4](PROTOCOL.md#4-event-vocabulary) names at that
  tier or below, and drops the whole event when its type's tier is higher. It never
  works by removing named fields from an unknown shape. A field this spec does not
  mention at a tier is not sent at that tier.
- **Per sink.** A person may send tier 0 to a team board and tier 2 to their own
  memory. The tier is a property of the sink, not of the machine.
- **Capped by the receiver.** `max_tier` in the well-known file wins when lower.
  A receiver MUST 403 an event above its cap; it MUST NOT quietly keep it.
- **Default is 0.** A sink added by hand without `--tier` is tier 0. The installer
  asks once per sink, shows what each tier sends, and remembers the answer.
- **Every event says what ran.** `privacy.rulesets` and `privacy.pii` are on every
  event, so a receiver can tell an unredacted native-lane row from a client row.

## 2. Rulesets

### `secrets@1` (always, above tier 0)

Runs on every string an event carries above tier 0, before the event reaches the
outbox. It cannot be disabled per sink. It removes the **value** and keeps the
sentence: `password: [redacted]`. What it matches:

| Class | Examples |
|-------|----------|
| Vendor token shapes | `ghp_…`, `github_pat_…`, `glpat-…`, `xox[abposre]-…`, Slack and Discord webhook URLs, `sk-…` (OpenAI, Anthropic, DeepSeek, OpenRouter), `sk_live_` / `rk_test_` (Stripe), `whsec_…`, `AIza…`, `ya29.…`, `GOCSPX-…`, AWS access key ids, `xai-`, `gsk_`, `pplx-`, `hf_`, `pcsk_`, `npm_`, `pypi-`, SendGrid, Shopify, DigitalOcean, Linear, Notion, Supabase, Figma, Doppler, Granola, spacesheep `ss_`, Telegram bot tokens, JWTs, PEM private-key blocks (including one cut off mid-paste). |
| URL credentials | `scheme://user:password@host` → the password goes, user and host stay. |
| Authorization headers | `Bearer`, `Basic`, `Token` followed by a credential. |
| Assignments | `NAME=value`, `NAME: value`, `NAME => value` where NAME names a secret (`DB_PASSWORD`, `apiKey`, `client-secret`, `*_KEY`, `*token*` …) — but not `password_hash`, `tokenizer`, `max_tokens: 4096`, and not a bare `pass:` (a count after "Verification pass:" is prose, not a credential). Only a secret name may consume a value, so `https:` never swallows a `?token=` behind it. |
| Prose | "password is Hunter2!", "the token was …", "set the password to …" — only when the value looks generated (letters and digits, or three character classes), so "the password is wrong" stays. |

Placeholders are left alone: `<your-key>`, `${VAR}`, `process.env.X`, `string`,
`[redacted]`, a member path, a call. The rules are **linear** (bounded repetition,
no nested quantifiers); the adversarial vectors pin that a 50 000-space run or
`password_` × 5000 returns in milliseconds. The ruleset is idempotent.

Vectors: `conformance/redaction/secrets.json`. The reference implementation is
`packages/core/src/privacy/secrets.ts`; every other copy (a server-side re-check,
a CLI) MUST import it or run its vectors.

### `pii@1` (opt-in, any tier)

A second pass, on by `--pii` per sink. It reduces identifiers, it does not promise
anonymity:

| Rule | Effect |
|------|--------|
| Email addresses | → `[email]` |
| Phone numbers (E.164 and common national forms) | → `[phone]` |
| Home directory paths | → `~` (already the rule for `session.cwd`; here applied inside every string) |
| `session.machine` | → the first 8 hex characters of its SHA-256 |
| `session.account_id` | dropped |

Vectors: `conformance/redaction/pii.json`.

Tiers and rulesets govern events. The control lane is not a sink: it talks only to a
receiver the person paired with by approving it with their passkey, and its pairing
request and hellos may name the machine's harness accounts with their emails, or an
API endpoint's host for a home with no login (`accounts`, [CONTROL.md §2](CONTROL.md#2-keys-and-enrollment)),
so that receiver's board can label `session.account_id`. No event carries an email or
a host for that.

## 3. What a sender never reads

An adapter uses a harness's documented hooks API and reads files the person's own
harness wrote on the person's own machine (its transcript, its session registry, its
config's account id, or the API endpoint its settings name — that one value, never the
token beside it). It never reads a credential file, never calls a vendor API, and
never sends a token of the harness's anywhere. [ADAPTERS.md](ADAPTERS.md) states this
per harness with the documentation URL.

One exception is the person's own to make, and off until they do: with `remote_titles`
on (`sessionpipe titles on`), the Claude Code adapter reads Claude Code's sign-in on this
machine to ask claude.ai for a session's name, the one fact claude.ai never writes to the
machine. The token goes to `api.anthropic.com` alone, for that read; it is never stored,
logged, put in an event, or sent to a sink. Only the name comes back, as `session.title`.

## 4. For receivers

*This section is guidance, not legal advice.*

Session events can be **personal data**: names in prompts, an account id, paths that
name a client or a colleague. If you operate a receiver for anyone but yourself, you
are the controller of what it stores.

- **The tiers are your data-minimisation tool.** Declare the lowest `max_tier` your
  purpose needs. A receiver serving more than its operator SHOULD declare `max_tier`
  ≤ 1.
- **`session.forgotten` is the deletion path.** Honour it fully (events, derived
  data, backups on their schedule) and say in your documentation how long that takes.
- **Document retention.** Say how long events are kept and delete on schedule.
- **Access requests** can be answered from the per-session file: the protocol's
  storage unit is one session's events, in order.
- **Secrets can still arrive.** `secrets@1` is good, not perfect; treat every stored
  string as though it might contain one. Never log event bodies.
- **The native lane carries unredacted data.** Do not enable it on a receiver other
  people send to.
- **`launched_by` can name a session you never saw.** The launcher and the session it
  started may report to different sinks. The id is opaque: it says the two are related
  and nothing else.

## 5. What sessionpipe itself never does

- No telemetry: the client reports to the sinks the person configured and to no one
  else. The website has no analytics.
- No hosted receiver: the project operates no server that receives anyone's data.
- The optional daily version check is a plain read of the npm registry, off with
  `SESSIONPIPE_NO_UPDATE_CHECK=1`.
