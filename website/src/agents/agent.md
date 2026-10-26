# sessionpipe: context for an agent

You are helping a person use sessionpipe {{version}}. Read this whole file before you run
anything. Everything else on https://sessionpipe.org is Markdown too: the index is
https://sessionpipe.org/llms.txt and the whole site is one file at
https://sessionpipe.org/llms-full.txt.

## What it is

An open protocol and a small CLI. Coding agents (Claude Code, Codex, Gemini CLI, Antigravity)
fire hooks when a session starts, a tool runs, or the agent needs the person. sessionpipe
installs those hooks, turns each one into a protocol event (`session.started`, `tool.ended`,
`attention.needed`, 17 types in protocol 1), removes secrets on the machine, writes the events
to a local outbox, and sends them to the destinations ("sinks") the person configured, filtered
to a privacy tier per sink. A receiver is the server at a sink's URL.

| Tier | What leaves the machine |
|-----:|-------------------------|
| 0 | session state and timing, machine, folder, repo, branch, model, title; the kind of attention needed |
| 1 | + tool names, durations, ok/error, file paths, the attention message, subagents |
| 2 | + the person's prompts and the assistant's replies, redacted |
| 3 | + tool input and output, thinking, raw hook lines |

## Setting it up

- To a receiver that offers pairing, one command per machine:
  `npx sessionpipe connect <receiver>`. It prints six digits that the person approves with a
  passkey on a device where they are signed in to the receiver. You cannot approve it for
  them: tell them the digits and wait.
- Hooks only, nothing sent anywhere: `npx sessionpipe install`, then `sessionpipe tail --tier 1`
  to watch events locally.
- Add a destination later: `sessionpipe sink add <url> --tier <0-3> --token <t>`.
- Check the result with `sessionpipe doctor`; read state with `sessionpipe status --json`.

## Rules to follow

1. Never choose or raise a tier on the person's behalf. Tier 2 sends what they type; tier 3
   sends tool input and output. Ask, and say what the tier sends.
2. Before adding a sink, run `sessionpipe tail --tier <n>` and show the person what that tier
   would send.
3. Never edit the hook entries in an agent's settings by hand. `install` and `uninstall` own
   them; `uninstall` removes only what sessionpipe wrote.
4. Never paste a sink token or control key into a file, a commit or a chat. `sessionpipe
   secrets` says where each one is kept.
5. Messages to sessions ("control") are signed on the person's device and checked on the
   machine. Pairing (`sessionpipe control pair`) and choosing safe, auto or inherit mode are
   the person's to do at their own terminal.

## Commands

Read from the CLI's own usage table when this file was built. `sessionpipe <command> --help`
prints the same line without running anything.

{{commands}}

## Read next

- Every command, in detail: https://sessionpipe.org/docs/index.md
- Get started: https://sessionpipe.org/get-started/index.md
- The protocol (for writing a receiver): https://sessionpipe.org/protocol/index.md
- JSON Schemas for every message: https://sessionpipe.org/schema/v1/event.json and its siblings
- What changed: https://sessionpipe.org/changelog/index.md
- Source: https://github.com/spacesheep-dev/sessionpipe
