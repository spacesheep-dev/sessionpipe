---
"sessionpipe-core": minor
"sessionpipe": minor
---

`session.attended` says whether a person attends the session: an optional tier-0 boolean in the harness's own word, absent when the harness does not say (unknown, never `false`). Claude Code fills it from `CLAUDE_CODE_SESSION_ATTENDED`, counting a control turn and a session with a link (its Remote Control bridge, the desktop app) as attended: every headless run says `0`, a Remote Control session included, and a `claude -p` started inside one inherits `CLAUDE_CODE_ENVIRONMENT_KIND=bridge`, so the link is what tells them apart. The hook carries `CLAUDE_CODE_SESSION_ATTENDED` and `SESSIONPIPE_CONTROL_JOB` into the job, and the worker takes those and `CLAUDE_CODE_HOST_SESSION_ID` from the job alone, so a worker another session's hook spawned no longer lends a swept job its own. Codex, Gemini CLI, Antigravity and Devin leave it absent.
