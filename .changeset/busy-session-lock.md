---
"sessionpipe": patch
"sessionpipe-core": patch
---

A busy session's events no longer wait 6 s and go back to the queue behind its own lock. A lock whose worker is gone (its 15 s deadline ended it without a release) is taken at once instead of after 5 min; a job polls for the lock every 50 ms instead of doubling its wait, so siblings can't keep taking it in between; and the sinks drain at once, so the lock is held for the slowest round trip, not the sum of them (33 re-queues in one day's log on a machine with three sinks, 2026-10-13).
