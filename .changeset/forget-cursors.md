---
"sessionpipe": patch
"sessionpipe-core": patch
---

`sessionpipe forget` takes the session out of every sink's cursor along with its outbox file, so a session that goes on after it (still running, or resumed later) is sent from its new file's first event. Before, each cursor kept the old file's end offset, and the sinks read nothing from the new file until it grew past that offset, then started mid-way, so the first events were never sent. The cursors are the drain's, so `forget` and `replay` wait for its lock (up to 10 s) before they change anything; past that they change nothing, say so and exit 1. A cursor file holding `null` or a list reads as empty instead of stopping a drain.
