---
"sessionpipe": minor
---

`limits.observed` reaches tier-1 sinks: after a Codex turn when its rollout holds new numbers, and from Claude Code's status line with `install --status-line` (or `connect --status-line`; `--no-status-line` takes it away; remembered in the config). A status line hides most of Claude Code's footer hints, so it is opt-in. The line shows the limits (`5h 23% · week 41%`) and hands the worker a job only when they changed, at most once a minute per config dir and never without a tier-1 sink. Before this a receiver could not tell which account still had room in its 5-hour or weekly window.
