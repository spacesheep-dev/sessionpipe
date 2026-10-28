# sessionpipe

**An open protocol, and a client, for what your coding agents are doing.** One
install hooks Claude Code, Codex, Gemini CLI, Antigravity and Devin (Cursor, Copilot
CLI, Droid, Kiro and OpenCode are next); every event is filtered to a privacy tier you
choose per destination; secrets are removed on your machine before anything leaves
it; it goes to your server, to a file, or nowhere at all.

```sh
npx sessionpipe install        # writes the hooks, backfills 30 days locally
sessionpipe tail --tier 1      # watch events, no server needed
sessionpipe sink add https://your-receiver.example --tier 1 --token <t>
sessionpipe doctor             # what is wired, hook timing, sink state
sessionpipe uninstall          # every config file byte-identical again
```

`connect` and `install` refuse to replace a newer global package or hook launcher
with an older build, including a newer prerelease (`0.9.0-devin.1` is newer than
`0.7.0`). The refusal prints both versions and exits before installing or writing
hooks. Use the installed newer CLI, or explicitly pass `--allow-downgrade` to
replace it. Already-published older CLIs do not gain this guard retroactively.

`--machine NAME` sets the initial name. On later runs, setup keeps the configured
name and says when it ignores a different `--machine`, so a copied setup command
cannot separate sessions from their daemon or reset the identity used for backoff.
`--machine NAME --rename-machine` explicitly renames it, the paired daemon included:
control.json takes the name and the daemon says it in its next hello. A receiver keys
machines by their id, so the pairing holds and its two cards become one.

| Tier | What leaves |
|-----:|-------------|
| 0 | session state and timing, folder, repo, branch, model, title, the *kind* of attention needed |
| 1 | + tool names, durations, ok/error, file paths, the attention message |
| 2 | + your prompts and the assistant's text, redacted |
| 3 | + tool input and output |

No telemetry. Secrets never leave (`secrets@1` runs above tier 0, always). Your
server or none. Pre-release: the reference receiver is still being built; see the
[roadmap](https://github.com/spacesheep-dev/sessionpipe/blob/main/ROADMAP.md).

## Control: messages to your sessions (M6: Claude Code, Codex, Antigravity)

A receiver that lists `control` can carry a message from your phone to a session on
this machine. It is signed on your device and **checked here**, against a key you
enroll at this terminal; the receiver can queue a message but can never forge one
([spec](https://sessionpipe.org/protocol/control/)).

```sh
sessionpipe control pair spacesheep.dev   # one link: approve with your passkey; installs the daemon (this folder by default)
sessionpipe control folders add ~/work/api   # let messages reach sessions in another folder too (no new pairing)
sessionpipe control folders [remove <dir>]   # the list, or stop allowing a folder
sessionpipe control status          # receivers, parked waiters, sessions mid-turn, open permission prompts
sessionpipe control keys [remove <id>]
sessionpipe control off             # tell the receiver, forget its token and keys
```

Pairing through `npx` first installs that version globally and runs pairing from
that persistent copy. On Homebrew, the daemon uses a matching stable Node link
so a Node upgrade does not leave it pointing at a removed Cellar version.

Services paired with older versions are **not** repaired by `install` or `update`.
After upgrading, run `sessionpipe control pair <receiver>` again (without
`--no-service`) to rewrite the service with persistent paths. On Linux, restart an
already-running daemon afterward with `systemctl --user restart sessionpipe-control.service`;
macOS pairing reloads the LaunchAgent.

A new session started from the receiver may bring files (screenshots, PDFs: up to 10,
50 MiB together), whichever harness it is for. The daemon downloads each one, checks
it against the hash you signed, saves it under `<folder>/.sessionpipe/files/<session>/`
(a folder that git-ignores itself) and tells the session where they are. If any file
is missing or doesn't match, the session doesn't start.

One daemon per computer holds one long-poll per receiver and delivers each message the
cheapest way the session allows: to `sessionpipe wait` parked in the session's
background (in place, ~60 ms, no network), at the session's next Stop if it is
mid-turn, through the Agent SDK for a session it started (if the SDK is installed), or
as a headless `claude -p --resume` (a `--fork-session` copy when a live process holds
it). A session stays reachable in place with zero idle turns by running, as a
background command with the longest timeout it can (Claude Code: raise
`BASH_MAX_TIMEOUT_MS`, else a background command is stopped after 2 hours at most):

```sh
sessionpipe wait            # Claude Code: the session id comes from CLAUDE_CODE_SESSION_ID
```

The waiter and next-Stop modes work in any Claude Code session that runs your hooks,
the Claude desktop app's included, and need nothing else. The Agent SDK, resume and fork
modes run the `claude` command, which has its own login (`claude auth login`); the
desktop app doesn't share its login with that command.

Permission prompts can be answered from the receiver too: while the terminal shows
its prompt, the PermissionRequest hook waits for your signed answer, and whichever
comes first wins. Nothing is ever auto-allowed. Safe mode (the default) runs headless
turns with `--permission-mode dontAsk`, so nothing that needs approval runs while
you're away. Auto mode runs them with `--permission-mode auto`; where Claude Code's
settings turn auto mode off (`permissions.disableAutoMode`), Claude Code runs them in
its default mode instead, which refuses whatever needs approval. Inherit mode
(`sessionpipe control mode inherit`, chosen only at the machine) passes no permission
flag, so each turn starts in the mode Claude Code picks by itself there, its
settings' `permissions.defaultMode`: messaged sessions run the way your own do,
`bypassPermissions` included if that is what you set.

Codex and Antigravity sessions are reached headlessly too, when `codex` or `agy` is
installed (the daemon looks on PATH, beside its own Node, in `~/.local/bin`, or where
`SESSIONPIPE_CODEX` / `SESSIONPIPE_AGY` point). A new session is
`codex exec --json -C <folder>` or `agy -p … --output-format stream-json`; the next
message is `codex exec resume <thread>` or `agy --conversation <id>`. Safe mode runs
Codex in its `workspace-write` sandbox and agy with no permission flag (it denies, and
the reply lists, what it wasn't allowed to do); auto mode passes `--approve-for-me` /
`--mode accept-edits`; inherit mode passes no flag, so Codex follows the
`approval_policy` and `sandbox_mode` in your `config.toml`. The bypass flags are never
passed. Both CLIs pick a new
session's id themselves, so the daemon keeps the one your start named: it records the
pair in `~/.local/state/sessionpipe/control/aliases.json`, and your receiver keeps
seeing one session under one id. A message to a Codex session someone has open (its
rollout written in the last 90 seconds) is acked `unsupported` rather than resumed beside them.
Before a Codex run the daemon checks `codex login status` (or `CODEX_API_KEY`) and says
`codex login --device-auth` if it isn't signed in.

Any other agent that speaks the [Agent Client Protocol](https://agentclientprotocol.com)
is reached the same way: Gemini CLI, OpenCode, goose, Copilot CLI, Cursor, Droid, Devin,
Kilo, Qwen Code, Cline and the rest of the ACP registry ([the list, with each one's
launch line](../../spec/ADAPTERS.md#agents-driven-through-acp-control-only)). The daemon
runs the agent's own CLI (`gemini --acp`, `opencode acp`, …) when it is installed, on
PATH or where `SESSIONPIPE_ACP_<HARNESS>` points (`SESSIONPIPE_ACP_GEMINI_CLI`), and
never downloads one. It is the agent's client: a start opens a session in your folder,
the reply streams back as the agent writes it, and the process stays up so the next
message lands in it with no cold start (`api` mode); `cancel` works there too. An agent
idle for ten minutes is closed, and a later message reopens the session where the agent
supports `session/load`. Safe mode answers every permission the agent asks with a
refusal, listed in the reply; auto mode allows. An agent that never asks (OpenCode, by
its own settings) runs its tools as it would at your terminal. Signing in is yours to do
at the terminal: an agent that wants it says so in the reply.

## The pool: several Claude accounts, one session that keeps going

Claude Code can't change account mid-session, but its requests can. `sessionpipe pool`
keeps several Claude accounts behind one loopback listener the control daemon runs on
this machine; Claude Code is pointed at it through the `env` block of its
`settings.json` (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, and the two flags that
keep its first-party features on). Each request goes to the first account in your order
that has room, a session stays on its account while that account has room, and when the
account's 5-hour or weekly window is used up the next request simply goes to the next
account: the session notices nothing. The numbers each account reports arrive as
`limits.observed` with `account_id`, so a receiver's usage page shows every account
([spec](../../spec/CONTROL.md#pool), [what it reads](../../spec/ADAPTERS.md),
[privacy](../../spec/PRIVACY.md)).

```sh
sessionpipe pool add --import        # copy every Claude Code login on this machine into the pool
sessionpipe pool add --login         # sign in to another account: a URL, then paste the code to --code -
sessionpipe pool on                  # write the env block; installs the daemon's service if it isn't there
sessionpipe pool                     # the accounts in order, each with its room left and reset times
sessionpipe pool order <id|email>…   # the complete order; enable | disable | remove | refresh too
sessionpipe pool off                 # remove exactly what `on` wrote; the accounts stay
```

Nothing here happens until you run `pool add` or `pool on` yourself: `install` and
`connect` never touch the pool. The credentials you add live in sessionpipe's own secrets
store (the keychain where there is one), are sent only to the vendor's own endpoints for
your own requests, and never appear on an event, in an ack or on the terminal. The
vendor is called (requests forwarded, idle usage read every five minutes) only while the
pool is on; `pool add --login` and `pool refresh` at the terminal are the exceptions,
because you asked. Whether pooling is allowed by each account's plan is yours to check;
sessionpipe doesn't change any limit.

New Claude Code sessions use the pool from the moment `pool on` returns; sessions
already running pick it up at their next start, since Claude Code reads
`settings.json`'s `env` when it starts. While the pool is on, every Claude Code request
on the machine depends on the daemon: if it isn't running, Claude Code gets "connection
refused", and `sessionpipe pool` says so (`sessionpipe control run` in a terminal, or the
service `pool on` installs). The daemon runs for the pool alone, with no receiver
paired; `control off` keeps the service while the pool is on. While the daemon runs,
every `sessionpipe pool` command goes to it over the local socket, since it holds the
listener, the session pins and the credentials; with no daemon the command runs here and
the daemon reads the result when it starts. From a receiver, the same actions arrive as
a signed `pool` command; turning it on or off, removing or reordering accounts, and
finishing a sign-in need a fresh confirm with your passkey or device key, never a day
grant alone. `sessionpipe uninstall` runs `pool off` first.

## Updates

The control daemon keeps its own copy current. About a minute after it starts, and then
once a day (the last check is kept in `~/.local/state/sessionpipe/control/update.json`,
so a restart or a machine that sleeps doesn't ask more often), it reads
`https://registry.npmjs.org/sessionpipe/latest`. When that is a newer release it waits
until nothing is in hand — no message being delivered, no headless run or new session,
no Agent SDK turn, no permission prompt waiting for your answer, no session of yours
mid-turn — stops taking new
messages (the receiver holds them meanwhile), runs
`npm install --global --ignore-scripts sessionpipe@<version>` into the prefix it was
installed in, re-copies the hook launcher's files, and restarts onto the new code. A
running turn is never interrupted.

How it restarts depends on how it runs:

- **launchd (macOS) or systemd (Linux)**, as `control pair` / `connect` set it up: the
  daemon exits with code 75 and the service starts it again. Every service file
  sessionpipe has written restarts on a non-zero exit, so older installs need nothing.
- **Anything else** (a terminal, tmux, a container that starts `sessionpipe control run`
  itself): the old process stays as the new daemon's parent, with the same environment
  and output, and restarts it the same way after each later update. Whatever waits on
  the daemon (a shell, a container's init) keeps waiting.

One daemon runs per machine: a second `sessionpipe control run` finds the first one
answering on the local socket, says so, and exits 0.

Only a global npm install that this user can write updates itself; a copy in the npx
cache, a git checkout or a dev build is left alone. `sessionpipe status` and
`sessionpipe doctor` say whether it's on, when it last checked and what it found; the
daemon's log (`~/.local/state/sessionpipe/control/daemon.log` under launchd,
`journalctl --user -u sessionpipe-control.service` under systemd) has one line per check
and per update.

```sh
sessionpipe update off      # the daemon stops checking ("update_check": false in config.json)
sessionpipe update on
sessionpipe update          # install the latest now; the daemon restarts onto it once idle
```

`SESSIONPIPE_NO_UPDATE_CHECK=1` turns it off too, but only where the daemon can see it:
a launchd or systemd service doesn't inherit your shell's variables, while
`sessionpipe update off` reaches it (it re-reads the config every ten minutes).

## Session names from claude.ai

A session the Claude app starts on this machine gets its name from claude.ai, a few
seconds after its first message, and claude.ai never writes that name to the machine.
Out of the box sessionpipe reads only local files, so such a session goes out under
your first prompt cut to 50 characters while the Claude app shows another name.

```sh
sessionpipe titles on       # Claude Code sessions with a claude.ai link take claude.ai's name
sessionpipe titles refresh  # ask again about the last 30 days' sessions (--days N)
sessionpipe titles off      # local files only again (the default)
sessionpipe titles          # which one holds
```

With it on, the worker asks claude.ai for the name of each Claude Code session that has
a claude.ai link, a minute apart until claude.ai has named it, then every half hour. To
ask, it reads the sign-in Claude Code keeps for that config dir (the macOS keychain item
Claude Code writes, else `.credentials.json` in the config dir). It sends that token to
`api.anthropic.com` alone and keeps it nowhere: not in a file, an event, a log or a
sink. A token about to expire is skipped, never refreshed, so Claude Code's own login is
never touched. A name you gave the session here (`/rename`) still wins, and so does a
rename in the Claude app, which reaches the transcript without any of this.

`titles on` (and `titles refresh`) also asks about every session of the last 30 days
and sends each one a receiver already has under another name again, as
`session.backfill` with claude.ai's name, so finished sessions are renamed too, not only
the ones that run again. It prints how many it found named and how many it sent.

## Help and status JSON

`sessionpipe <command> --help` (or `-h`) prints usage and exits successfully before
running the command. This also works after operands and for nested commands, such
as `sessionpipe sink remove example --help` and `sessionpipe control pair example --help`.

`sessionpipe status --json` prints one JSON object. Its shared fields use the same
names and meanings as `doctor --json`:

| Field | Shape / meaning |
|---|---|
| `version`, `machine`, `state`, `config` | Strings; state and config are absolute paths. |
| `harnesses` | Object keyed by harness name; each value is an array of `{file, state, note?}` hook checks. `file` uses `~` for home, as doctor does. Includes detected **or configured** harnesses. |
| `sinks` | Array of `{name, url, tier, max_tier, pii, control, paused, pending_sessions}`. `tier` is the configured tier; the effective tier is `min(tier, max_tier ?? 3)`. `max_tier` and `paused` are `null` when unset. No token or secret is included. |
| `timing` | `{n, p50, p95}` from the last 100 local hook timings, in milliseconds; `null` when unavailable. |
| `update` | Doctor's update summary: `{auto, off, last_check, latest, last_error, pending, updated, failed}`. `auto` is boolean; absent details are `null`. |
| `jobs` | Number of entries waiting in the local jobs directory; zero when absent. |

`pending_sessions` counts outbox session files with bytes beyond that sink's cursor,
including paused sinks; it counts files, not individual events. Empty collections
are `{}` / `[]`. Status omits doctor's active hook benchmark, login/keychain checks,
and warnings. Both commands still check hook installation, which can run
`gemini --version` (up to four seconds) when `tools.enableHooks` is unset. JSON is an
output format, not a promise of constant-time diagnostics. Plain `sessionpipe status`
keeps its existing human output.

---

Docs and the protocol: [sessionpipe.org](https://sessionpipe.org) · Source:
[github.com/spacesheep-dev/sessionpipe](https://github.com/spacesheep-dev/sessionpipe) · Apache-2.0.
Provided as-is; check what a sink receives with `sessionpipe tail` before you point it anywhere.
