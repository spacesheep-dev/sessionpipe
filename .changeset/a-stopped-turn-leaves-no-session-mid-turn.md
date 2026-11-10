---
"sessionpipe": patch
---

After a Stop, the next message for that session runs at once. The stopped child's own hooks had marked the session mid-turn, and a child that is killed reports no Stop, so the message queued behind it (and any sent after) waited for a Stop that was never coming: up to 30 minutes, and a second Stop answered "a turn is running in that session, in a process this computer's daemon didn't start and can't find". When a run of the daemon's own ends, however it ends, the session is no longer mid-turn and whatever was waiting for its Stop is delivered another way. The same held for a run ended at the 30-minute cap, and for every kill on Windows.
