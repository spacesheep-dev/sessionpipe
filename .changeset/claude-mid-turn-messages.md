---
"sessionpipe-core": patch
"sessionpipe": patch
---

Claude Code: a message the person sends while a turn is running now reaches `turn.transcript` and `turn.progress`. Claude Code records it as a `queued_command` attachment rather than a `user` record, so the transcript reader dropped it from tier 2.
