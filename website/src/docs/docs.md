# Docs

Everything the `sessionpipe` command does, and how the parts that run on their own behave. New
here? [Get started](/get-started/) is the five-minute version; [the protocol](/protocol/) is the
contract a receiver implements.

The usage lines below are read from the CLI's own `--help` table when the site is built, so they
are the ones your copy prints (`sessionpipe <command> --help`). The longer sections are the
package READMEs, included as they are in the repository.

## Commands

### Set up

{{usage connect}}

The whole setup against a receiver that offers pairing, in one command and one approval. It
shows six digits; approve them on any device where you're signed in to the receiver. You get
hooks for every agent and every Claude Code account here, a sink at tier 2, signed messages,
keys in the keychain, a daemon that outlives logout, and the last 30 days backfilled. Run it
again and it only fixes what's missing.

{{usage install}}

Finds the agents on this machine, writes their hooks and backfills 30 days into the local
outbox. Nothing is sent until a sink exists. `--<harness>` hooks one even if it isn't detected;
`--sink URL --tier N` adds a sink first.

```sh
sessionpipe uninstall [--keep-state]
```

Removes the hook entries sessionpipe wrote and nothing else: every config file is otherwise
byte-identical. The outbox stays under the state folder and is pruned after 30 days.

### Destinations

{{usage sink add}}

Adds a destination: an HTTPS receiver, a file, or stdout. For a receiver it reads
`/.well-known/sessionpipe`, caps the tier at the receiver's `max_tier`, stores the token and
sends one heartbeat as a test. `--pii` turns on the PII pass for this sink.

{{usage sink list}}

The sinks on this machine.

{{usage sink remove}}

Removes one.

{{usage sink test}}

Sends a heartbeat and then its `session.forgotten`, so the receiver keeps no phantom session
from the test.

{{usage secrets}}

Where each key on this machine lives (the macOS Keychain, a desktop session's Secret Service
keyring, or a `0600` file), and the best store this session can reach.

{{usage secrets move}}

Moves sink and control keys to that store. A key it can't read here, or one the store refuses,
stays where it is, and the command says which.

### Watch and check

{{usage tail}}

Follows the local outbox, one event per line, filtered to a tier (1 unless you say): exactly
what a sink at that tier would receive. No server needed. `--all` starts from the beginning of
each session instead of now; `--json` prints the filtered events whole.

{{usage status}}

Sinks and what each has waiting, queued jobs, hook timing (p50 and p95 of the last 100) and
the self-update state. `--json` is described [below](#status-json).

{{usage doctor}}

Everything `status` checks, plus a live hook benchmark, each Claude Code account's sign-in,
keychain access, and warnings for what looks wrong.

### History

{{usage backfill}}

Reads the last N days of sessions from the agents' own files into the outbox.

{{usage replay}}

Sends what's waiting to a sink now, without waiting out a backoff. `--from-start` rewinds the
sink's cursor first, so everything in the outbox goes again. Runs under the drain's lock, as
`forget` does.

{{usage forget}}

Asks every sink to delete one session (a `session.forgotten` event), then removes it from the
local outbox and from every sink's cursor, so a session that goes on is sent from its start.
Both wait for a running drain (up to 10 s); past that they change nothing, say so and exit 1.

### Session names

{{usage titles}}

Which one holds. A session the Claude app starts here is named by claude.ai a few seconds
after its first message, and that name never reaches the machine; out of the box sessionpipe
reads local files only, so such a session goes out under your first prompt.

{{usage titles on}}

Claude Code sessions with a claude.ai link take claude.ai's name, read with the sign-in Claude
Code keeps and sent to `api.anthropic.com` alone. It also asks about the last N days' sessions
and renames the ones a receiver already has. A name you gave the session (`/rename`) still wins.

{{usage titles refresh}}

Asks again about the last N days' sessions.

{{usage titles off}}

Local files only again (the default).

### Accounts

{{usage pool}}

The account pool: the accounts in order, the room each has left in its 5-hour and weekly
windows, and when each resets. Nothing here runs until you ask for it; `install` and `connect`
never touch the pool.

{{usage pool add}}

`--import` copies every Claude Code login on this machine into the pool; `--login` signs in to
another account (a URL, then the code to `--code -`). Credentials live in sessionpipe's own
secrets store and never appear on an event or on the terminal.

{{usage pool on}}

Points every Claude Code on this machine at the pool through the `env` block of its
`settings.json`, and installs the daemon's service if it isn't there. New sessions use the pool
from the moment it returns; running ones at their next start.

{{usage pool off}}

Removes exactly what `pool on` wrote; the accounts stay.

{{usage pool order}}

The complete order: each request goes to the first account that has room.

{{usage pool enable}}

{{usage pool disable}}

Takes an account out of the rotation, or puts it back, without forgetting it.

{{usage pool remove}}

Forgets the account and its credentials.

{{usage pool refresh}}

Reads usage from the vendor now, for one account or all of them; otherwise the daemon reads it
every five minutes while the pool is on.

### Messages to your sessions

{{usage control pair}}

Pairs this machine with a receiver for signed messages and installs the daemon. Asks once, at
this terminal, whether sessions you message run in safe, auto or inherit mode.

{{usage control mode}}

Changes that answer; the running daemon picks it up within seconds.

{{usage control status}}

Receivers, parked waiters, sessions mid-turn, open permission prompts.

{{usage control keys}}

The device keys enrolled here; `remove <id>` forgets one.

{{usage control keys remove}}

{{usage control off}}

Tells the receiver, then forgets its token and keys.

{{usage control run}}

The daemon itself, in the foreground: what launchd or systemd starts. One runs per machine; a
second one finds the first, says so and exits 0.

{{usage wait}}

Parks in a session's background so a message reaches it in place, in about 60 ms with no
network. Claude Code's session id comes from `CLAUDE_CODE_SESSION_ID`.

### Self-update

{{usage update}}

Installs the latest release now; a running daemon restarts onto it once nothing is in hand.

{{usage update off}}

{{usage update on}}

The daemon's daily update check, off or back on.

{{usage version}}

## Control

{{include packages/cli/README.md#Control}}

## Updates

{{include packages/cli/README.md#Updates}}

## Session names from claude.ai

{{include packages/cli/README.md#Session names from claude.ai}}

## The pool

{{include packages/cli/README.md#The pool}}

## Status JSON {#status-json}

{{include packages/cli/README.md#Help and status JSON}}

## Conformance

{{include conformance/README.md}}

## For agents

Every page on this site is also plain Markdown, so an agent can read it without a browser or
a scraper. Hand it the first file below and it can find the rest.

| File | What it is |
|------|------------|
| [`/agent.md`](/agent.md) | Context for an agent helping a person with sessionpipe: what it is, every command, and the rules to follow (tiers, approvals, keys). Paste it into Claude Code, Codex or any agent. |
| [`/llms.txt`](/llms.txt) | The index, in the [llms.txt](https://llmstxt.org) format, linking each page's Markdown. |
| [`/llms-full.txt`](/llms-full.txt) | The whole site in one file: this page, the protocol, the changelog. |
| `<page>/index.md` | Any page's Markdown, such as [`/docs/index.md`](/docs/index.md). Each page links it in its `<head>` as `rel="alternate" type="text/markdown"`, and has a button that copies it. |
| [`/schema/v1/`](/schema/) | JSON Schemas for every message, at the URLs their `$id`s name. |
| [`/changelog/feed.xml`](/changelog/feed.xml) | Releases, as an Atom feed. |

All of it is rebuilt from the repository on every deploy, the same way the pages are, and
the Markdown carries absolute links so a copied page still works on its own.
