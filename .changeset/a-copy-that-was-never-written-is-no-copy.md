---
"sessionpipe": patch
---

A copy that is stopped before it has written anything is not recorded as the session's copy. A fork names its new session in its first line of output, before there is a transcript behind the name, so a copy counts as the session's only once its transcript is on disk. Stopped before that, the turn's ack names no copy, and the next message is routed afresh instead of being sent to resume a session that does not exist.
