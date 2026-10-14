---
"sessionpipe": patch
"sessionpipe-core": patch
---

A machine under a flood of hook events no longer floods its sinks. One worker drains the sinks at a time; the others leave their events in the outbox for it and it sends them in full batches of 50, so four busy sessions cost a request per batch, not per event. A sink that answered 429 is not tried again by any worker before its `retry-after`, and one that could not be reached waits 2 s · 10 s · 60 s · 5 min · 30 min, then every 30 min, as HTTP.md §2 has said all along (a machine with four busy sessions was refused 828 times in two minutes and had 5 192 jobs queued, 2026-10-14). The session's lock now covers only the append, not the round trips.
