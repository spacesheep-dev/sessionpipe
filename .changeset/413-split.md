---
"sessionpipe": patch
---

A batch a receiver refuses with 413 is halved and sent again until it fits, and one event too large on its own is dropped and logged (HTTP.md §2). Before, the sink stopped for the run and the next worker sent the same batch again, so one oversized batch stopped a sink for good.
