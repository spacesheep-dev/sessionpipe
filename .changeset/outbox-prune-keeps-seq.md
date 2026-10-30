---
"sessionpipe-core": patch
---

A session whose outbox file was pruned (untouched for `keep_days`, 30 by default) and then resumed under the same id is sent again. Before, pruning also deleted the session's seq counter but left each sink's cursor at the old file's end, so the resumed session restarted at seq 0, which a receiver's (harness, session, seq) deduplication drops as already seen, and the sinks read nothing from the new, shorter file until it grew past the old offset, then started mid-line. Now the counter stays and each sink's cursor into the pruned file is removed.
