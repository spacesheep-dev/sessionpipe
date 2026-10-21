---
"sessionpipe": minor
"sessionpipe-core": minor
---

`turn.ended` carries `background`: how much background work the harness reports still in flight as the turn ends, each piece of which wakes the session when it finishes. Claude Code's Stop hook lists it as `background_tasks` (in every Stop recorded since 2.1.258): a background shell command, a monitor, a subagent, a workflow. A session that ended its turn waiting on a two-hour background command read as finished on its receiver, under "Last 24 hours", until the command woke it. Tier 0, a count only: never what that work runs.
