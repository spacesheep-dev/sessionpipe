---
"sessionpipe": patch
"sessionpipe-core": patch
---

A busy machine no longer floods its receiver, and its hooks no longer queue behind the receiver. Delivery now runs after the session's lock is let go, one at a time per machine (a worker that finds one running leaves it a mark and goes), with batches to an HTTP receiver at least a second apart. A sink waits out a 429's `retry-after`, and a failing receiver's 2 s · 10 s · 60 s · 5 min · 30 min backoff, for every worker on the machine, as HTTP.md §2 says; `status`, `doctor` and `replay` show the wait. A worker killed at its 15 s deadline lets go of its locks, and the sweep starts no job it could not finish before then.
