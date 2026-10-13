---
"sessionpipe-core": patch
---

Draining a large session file no longer re-reads the rest of it for every batch: a read takes 1 MB (more only for one event longer than that), not the remaining file up to 8 MB, and counts its offset per line rather than from the start. A 10 MB session drained in batches of 50 decoded 55 MB.
