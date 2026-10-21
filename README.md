# sessionpipe

**An open protocol, and a client, for what your coding agents are doing.** One
install hooks Claude Code, Codex, Gemini CLI, Antigravity and Devin; every event is
filtered to a privacy tier you choose per destination, secrets are removed on your
machine before anything leaves it, and it goes to your server, to a file, or nowhere
at all. Messages come back the same way: answer a permission or queue the next prompt
from your phone, signed by your passkey and checked on the machine.

[![CI](https://github.com/spacesheep-dev/sessionpipe/actions/workflows/ci.yml/badge.svg)](https://github.com/spacesheep-dev/sessionpipe/actions/workflows/ci.yml)
[![coverage 100%](https://img.shields.io/badge/coverage-100%25_lines_%C2%B7_branches-brightgreen)](CONTRIBUTING.md#dev-setup)
[![npm](https://img.shields.io/npm/v/sessionpipe)](https://www.npmjs.com/package/sessionpipe)
[![License: Apache-2.0](https://img.shields.io/badge/code-Apache--2.0-blue)](LICENSE)
[![Spec: CC BY 4.0](https://img.shields.io/badge/spec-CC%20BY%204.0-blue)](spec/LICENSE)
[![DCO](https://img.shields.io/badge/contributions-DCO-informational)](DCO)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://sessionpipe.org/diagrams/architecture-dark.svg">
  <img alt="Architecture: harnesses fire hooks into one adapter each; the adapters feed sessionpipe core, which normalises, filters to a tier, redacts and appends to an outbox; sinks deliver from a cursor to a file, the reference receiver, spacesheep.dev or any HTTPS receiver; control comes back along the same path." src="https://sessionpipe.org/diagrams/architecture-light.svg" width="960">
</picture>

> Status: **pre-release**, spec **Draft** until two independent receivers pass the
> conformance suite. On npm: `sessionpipe` (the CLI), `sessionpipe-core`,
> `sessionpipe-receiver`, `sessionpipe-conformance`, published unscoped until the
> `@sessionpipe` org exists. See [ROADMAP.md](ROADMAP.md) and the
> [changelog](https://sessionpipe.org/changelog/).

## Install

To a receiver that offers pairing, one command per machine:

```sh
npx sessionpipe connect your-receiver.example
```

It shows six digits; approve them on any phone or computer where you're signed in to
the receiver (it doesn't have to be this machine). That one approval is the whole
setup: the hooks for every agent and every Claude Code account here, a sink at tier 2,
signed messages from your devices, the keys in your keychain when this session has one
unlocked, a background daemon that keeps running after you log out, and the last 30
days backfilled. It asks nothing else; run it again and it only fixes what's missing.
The daemon keeps sessionpipe up to date by itself, installing a new release once a day
at most and only when it's idle (`sessionpipe update off` stops that; see
[the CLI's README](packages/cli/README.md#updates)).

In the Claude desktop app, ask the session to run `sessionpipe wait` as a background
command. Messages from your devices then arrive in that session, in the app, with no
`claude` command or separate sign-in
([Get started](https://sessionpipe.org/get-started/)).

Or only the hooks, with nothing sent anywhere:

```sh
npx sessionpipe install
```

That detects the harnesses on your machine, writes their hooks, and backfills the
last 30 days of sessions into a local outbox. Nothing is sent anywhere until you add
a sink:

```sh
sessionpipe sink add https://your-receiver.example --tier 1
sessionpipe tail            # watch events locally, no server needed
```

### From source

```sh
git clone https://github.com/spacesheep-dev/sessionpipe && cd sessionpipe
npm ci --ignore-scripts && npm run build && npm test
npm pack -w sessionpipe
npm install -g --prefix ~/.local sessionpipe-*.tgz     # ~/.local/bin on PATH; never the clone itself
sessionpipe install
```

The CLI tarball bundles core, so it needs no other package. Don't `npm link` the
clone: the hooks would point into it, and moving the clone would break every harness.

## What a session looks like

```
$ sessionpipe tail --tier 1
sessionpipe tail · tier 1 · ~/.local/state/sessionpipe/outbox (Ctrl-C to stop)
02:56:19 codex       01a0…  session.started   source=startup  ~/spacesheep main
02:56:20 codex       01a0…  turn.started      prompt_chars=147
02:56:20 codex       01a0…  tool.started      Bash
02:56:21 codex       01a0…  tool.ended        Bash ok
02:56:21 codex       01a0…  turn.ended        stop
02:56:22 codex       01a0…  session.ended     reason=other
```

(A real Codex 0.157.1 run on 28 Sep 2026, through the hook, the worker and the outbox.)

## Harnesses

One adapter file each, under [`packages/core/src/adapters/`](packages/core/src/adapters/),
the only vendor-specific code in the tree. A harness is in the registry once it has
fixtures recorded from real hook payloads ([`conformance/harness/`](conformance/harness/)).

| Harness | Hooks | Transcript (tier 2) | Facts read | Fixtures |
|---------|:-----:|:-------------------:|------------|:--------:|
| Claude Code | 14 events | the session's `.jsonl`, mid-turn messages included | title, url, model, account, per config dir | 21 |
| Codex CLI, Codex Desktop | 12 events + `notify` | the thread's rollout; forks, never subagents or ephemeral threads | title, model | 15 |
| Gemini CLI | 8 events | the chat log | title, model | 14 |
| Antigravity | 4 events | `brain/<id>` messages | title, url to the conversation, in a git checkout too | 8 |
| Devin CLI | 8 events | its SQLite session store, read-only | title, model, times | 8 |

Next in the registry ([ADAPTERS.md](spec/ADAPTERS.md)): Cursor, Copilot CLI, Droid,
Kiro, OpenCode.

## Privacy tiers

Each sink is configured at a tier; the receiver declares its maximum; the lower wins.

| Tier | What leaves | Who it is for |
|-----:|-------------|---------------|
| 0 | Session ids, state, timing, machine, repo, branch, model, title; attention *kind* | A presence board: "working / needs you / done" |
| 1 | + tool names, durations, ok/error, file paths, attention message, subagents, compactions | An activity feed |
| 2 | + your prompts and the assistant's text (`turn.transcript`), a running turn as it runs (`turn.progress`) | Memory, search, recaps |
| 3 | + tool input and output, thinking, raw hook lines | Full replay, your own server only |

The secrets ruleset runs on every string above tier 0 and cannot be turned off; PII
reduction is a second, opt-in pass. `sessionpipe tail` shows exactly what a tier
sends. **Provided as-is; check what a sink receives with `sessionpipe tail` before
you point it anywhere.**

## Control: the channel back

A receiver carries commands; it can never forge one. Every command is signed on your
device with a passkey (or a day key the passkey vouched for), and the machine checks
the exact bytes against keys enrolled at its own terminal, the nonce, the age, the
folder allowlist, and that a permission you answer is still open. Then it delivers
through the harness's own documented hooks: a message for the next turn, a permission
answer while the terminal shows its prompt (nothing is ever auto-allowed), a cancel, or
a new session started headlessly for any harness the machine can drive, with files if
the command carries them. [CONTROL.md](spec/CONTROL.md) has every rule and refusal
code; 89 shared vectors pin them.

```sh
sessionpipe control pair https://your-receiver.example   # once, at the machine's own terminal
sessionpipe control folders add ~/work                   # where messaged sessions may run
sessionpipe control mode safe                            # or auto; what a messaged session may do
```

## Three promises

- **No telemetry.** sessionpipe reports to the sinks you configured and to nobody else.
  The website has no analytics.
- **Secrets never leave.** Redaction runs on your machine, before the outbox.
- **Your server or none.** A file sink, `stdout`, the reference receiver on your
  laptop, or any HTTPS endpoint that speaks the protocol.

## Receivers

| Receiver | Where it runs | max tier |
|----------|---------------|:--------:|
| [sessionpipe-gui](https://github.com/spacesheep-dev/sessionpipe-gui) | your laptop; a board for every phone on the LAN, control included | 3 |
| [spacesheep.dev](https://spacesheep.dev) | hosted; sessions across machines, messages from anywhere | 2 |
| [sessionpipe-receiver](packages/receiver) | the reference, one process and JSONL files | 3 |
| any HTTPS endpoint | that speaks [HTTP.md](spec/HTTP.md): one well-known file, one endpoint, a dedup key | yours |

The full list: [sessionpipe.org/receivers](https://sessionpipe.org/receivers/).

## How it's tested

The fixtures are the contract, and CI refuses what they don't prove.

- **Every registered harness has fixtures** recorded from real payloads, run through its
  adapter on every PR, and a mutation suite that feeds every fixture 40 to 60 broken
  shapes (dropped keys, wrong types, nulls, truncated JSON, unknown events) and proves
  no adapter can throw: a harness's next release can't crash a hook.
- **100 % line and branch coverage** of every source file in every package, enforced
  as a threshold, with dead code deleted rather than ignored.
- **The invariants are tests**: append-only outbox, a cursor that moves only on a 2xx,
  two processes appending at once, every HTTP status the spec names driven against an
  in-process receiver, the 19 delivery scenarios, the control vectors, redaction
  idempotent on 66 vectors, the hook under 300 ms on a shared runner (it's about
  35 ms).
- **Gates on the PR**: a spec change carries a fixture, an adapter change carries a
  fixture or a test, every commit is signed off, every test worker runs in a sandbox
  home and fails if it touches a real one.

## Pieces

| | |
|---|---|
| [`spec/`](spec/) | The protocol: envelope, events, tiers, HTTP binding, control channel, adapters, versioning (CC BY 4.0) |
| [`schemas/v1/`](schemas/v1/) | JSON Schemas, generated from the code; also served at `https://sessionpipe.org/schema/v1/` |
| [`conformance/`](conformance/) | Real hook payloads per harness, redaction vectors, delivery scenarios, control vectors |
| [`packages/core`](packages/core) | `sessionpipe-core`: types, adapters, privacy filter, outbox, sinks, the control verifier (zero dependencies) |
| [`packages/cli`](packages/cli) | `sessionpipe`: connect, install, sink, status, doctor, tail, forget, replay, update, the control daemon |
| [`packages/receiver`](packages/receiver) | `sessionpipe-receiver`: one process, JSONL files, a page you can answer from a phone |
| [`packages/conformance`](packages/conformance) | `sessionpipe-conformance`: scores a receiver or an adapter |
| [`website/`](website/) | [sessionpipe.org](https://sessionpipe.org), rendered from `spec/` |

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). Every commit is signed off under the
[DCO](DCO); there is no CLA. A new harness is one adapter file plus fixtures for every
event it handles and a row in [ADAPTERS.md](spec/ADAPTERS.md). A protocol change starts
as a [spec proposal](https://github.com/spacesheep-dev/sessionpipe/issues/new?template=spec-proposal.yml)
with a fixture, then seven days of lazy consensus. Security reports go through
[SECURITY.md](SECURITY.md).

Code is Apache-2.0 ([LICENSE](LICENSE), [NOTICE](NOTICE)); the spec is CC BY 4.0
([spec/LICENSE](spec/LICENSE)). "sessionpipe" is a mark of Michael Makarov; see
[TRADEMARKS.md](TRADEMARKS.md). Governance: [GOVERNANCE.md](GOVERNANCE.md).
