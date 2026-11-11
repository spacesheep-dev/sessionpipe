---
"sessionpipe-core": patch
"sessionpipe": patch
---

A Claude Code session is found only under the id its transcript is filed as. On a disk that ignores case (macOS, Windows) a command naming `claude-code:8C132906-…` opened the transcript of `8c132906-…`, while the session's registry row and its hooks, which are what say it is open in a window or mid-turn, are kept under the id as Claude Code wrote it: the session looked idle and was resumed in place, `claude -p --resume 8C132906-…`, beside the person's own window. Such a command is now refused `no_session` ("no Claude Code session 8C132906 on this machine") on every platform, as it already was on Linux. A new session's id that differs from an existing session's only by case is still refused as taken (`bad_session`): on such a disk it would be written into that session's file.
