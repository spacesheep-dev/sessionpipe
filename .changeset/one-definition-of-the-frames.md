---
"sessionpipe-core": patch
"sessionpipe": patch
---

The control daemon builds the words around a delivered message with the same definitions the transcript readers take them off with (`sessionpipe-core/control`), so the three wordings this release adds are left out of a turn's `user` text like the rest: the header that names the message where it is handed to a live session at its Stop or through its waiter (`Message via <host> (sessionpipe control, signed on the sender's device; message XXXXXXXXXXXX):`), the note to a copy whose original is not open in a window but in use by another process, and the mark in an ask handed over in place (`…with sessionpipe ask, message XXXXXXXXXXXX. Answer here in full: …`). The paragraph that says an agent asked stays, in its plain form (`(Asked by <harness>:<id> on this machine with sessionpipe ask. Answer here in full: …)`), whichever way the task arrived. `sessionpipe-core/control` exports `messageMark` (null for an id that is not a ULID), `frameMarked`, `copyNote(why)` and `unframe`, and `frameAsk` takes the mark as a third argument.
