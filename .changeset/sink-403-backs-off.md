---
"sessionpipe": patch
---

HTTP sink: a 403 the sink cannot act on backs off like a 5xx

- A 403 with no `max_tier` (an access proxy's "Forbidden" page), or with a `max_tier` at or above the tier the sink already sends at, now waits on the 2 s … 30 min backoff and the log names the 403, instead of the same batch being sent again on every run (#201). Only a 403 whose `max_tier` is below the sink's tier lowers it. `spec/HTTP.md` §2 has a row for it.
