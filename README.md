# sessionpipe

**An open protocol, and a client, for what your coding agents are doing.** One
install hooks Claude Code, Codex, Gemini CLI, Antigravity, Devin and more; every event is
filtered to a privacy tier you choose per destination, secrets are removed on your
machine before anything leaves it, and it goes to your server, to a file, or nowhere
at all.

[![CI](https://github.com/spacesheep-dev/sessionpipe/actions/workflows/ci.yml/badge.svg)](https://github.com/spacesheep-dev/sessionpipe/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/sessionpipe)](https://www.npmjs.com/package/sessionpipe)
[![License: Apache-2.0](https://img.shields.io/badge/code-Apache--2.0-blue)](LICENSE)
[![Spec: CC BY 4.0](https://img.shields.io/badge/spec-CC%20BY%204.0-blue)](spec/LICENSE)
[![DCO](https://img.shields.io/badge/contributions-DCO-informational)](DCO)

> Status: **pre-release** (0.1.x). On npm: `sessionpipe` (the CLI), `sessionpipe-core`,
> `sessionpipe-receiver`, `sessionpipe-conformance`. The three library packages are
> published unscoped until the `@sessionpipe` npm org exists; the code is identical and
> the scoped names will be added as aliases. See [ROADMAP.md](ROADMAP.md).

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
The daemon then keeps sessionpipe up to date by itself, installing a new release once a
day at most and only when it's idle (`sessionpipe update off` stops that; see
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

## Privacy tiers

Each sink is configured at a tier; the receiver declares its maximum; the lower wins.

| Tier | What leaves | Who it is for |
|-----:|-------------|---------------|
| 0 | Session ids, state, timing, machine, repo, branch, model, title; attention *kind* | A presence board: "working / needs you / done" |
| 1 | + tool names, durations, ok/error, file paths, attention message, subagents, compactions | An activity feed |
| 2 | + your prompts and the assistant's text (`turn.transcript`) | Memory, search, recaps |
| 3 | + tool input and output, thinking, raw hook lines | Full replay, your own server only |

The secrets ruleset runs on every string above tier 0 and cannot be turned off; PII
reduction is a second, opt-in pass. `sessionpipe tail` shows exactly what a tier
sends. **Provided as-is; check what a sink receives with `sessionpipe tail` before
you point it anywhere.**

## Three promises

- **No telemetry.** sessionpipe reports to the sinks you configured and to nobody else.
  The website has no analytics.
- **Secrets never leave.** Redaction runs on your machine, before the outbox.
- **Your server or none.** A file sink, `stdout`, the reference receiver on your
  laptop, or any HTTPS endpoint that speaks the protocol.

## Pieces

| | |
|---|---|
| [`spec/`](spec/) | The protocol: envelope, events, tiers, HTTP binding, control channel, adapters (CC BY 4.0) |
| [`schemas/v1/`](schemas/v1/) | JSON Schemas, generated from the code; also served at `https://sessionpipe.org/schema/v1/` |
| [`conformance/`](conformance/) | Real hook payloads per harness, redaction vectors, delivery scenarios |
| [`packages/core`](packages/core) | `sessionpipe-core` (`@sessionpipe/core` once the org exists): types, adapters, privacy filter, outbox, sinks (zero dependencies) |
| [`packages/cli`](packages/cli) | `sessionpipe`: install, sink, status, doctor, tail |
| [`packages/receiver`](packages/receiver) | `sessionpipe-receiver`: one process, JSONL files, a page you can answer from a phone |
| [`packages/conformance`](packages/conformance) | `sessionpipe-conformance`: scores a receiver or an adapter |
| [`website/`](website/) | [sessionpipe.org](https://sessionpipe.org), rendered from `spec/` |

Who receives: [sessionpipe.org/receivers](https://sessionpipe.org/receivers/).

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). Every commit is signed off under the
[DCO](DCO); there is no CLA. A new harness is one adapter file plus its fixtures. A
protocol change starts as a [spec proposal](https://github.com/spacesheep-dev/sessionpipe/issues/new?template=spec-proposal.yml)
with a fixture. Security reports go through [SECURITY.md](SECURITY.md).

Code is Apache-2.0 ([LICENSE](LICENSE), [NOTICE](NOTICE)); the spec is CC BY 4.0
([spec/LICENSE](spec/LICENSE)). "sessionpipe" is a mark of Michael Makarov; see
[TRADEMARKS.md](TRADEMARKS.md). Governance: [GOVERNANCE.md](GOVERNANCE.md).
