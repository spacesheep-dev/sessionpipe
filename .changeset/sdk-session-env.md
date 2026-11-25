---
"sessionpipe": patch
---

A session started through the Agent SDK gets the same environment as a `claude -p` run: a daemon started from inside a Claude Code session no longer hands it that session's markers (`CLAUDECODE`, its entrypoint and port), which made the new session take itself for one nested in another.
