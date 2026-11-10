---
"sessionpipe": patch
---

A copy that was stopped before it wrote anything is no longer recorded as the session's copy. A fork names its new session in its first line of output, and a Stop that came right after that recorded the copy from the name alone; with no transcript behind it, every later message to the session would have been sent to resume a session that does not exist. The copy is recorded only when its transcript is on disk; otherwise the stopped turn's ack names no copy, and the next message is routed afresh.
