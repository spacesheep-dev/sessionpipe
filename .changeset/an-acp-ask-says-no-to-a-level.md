---
"sessionpipe": patch
---

ask: a level or a model on a new ACP session is refused, and `ask status` lists ACP agents

- `sessionpipe ask grok-build "…" --permission read` started the agent with the flag
  dropped: an ACP agent takes no level (CONTROL.md §6) and ran as the machine's mode
  said, so on an auto machine a "read" ask could write. It is refused now, in words
  that name the mode, as an ask into an existing ACP session already was. `--model`
  the same.
- `sessionpipe ask status` listed only the agents that take start options, so an
  installed ACP agent (Grok Build, Gemini CLI, …) the daemon could start was missing.
  It lists what the daemon says an ask can start.
