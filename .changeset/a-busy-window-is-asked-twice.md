---
"sessionpipe": patch
---

A message sent in the first moments of a turn typed in an open Claude Code window is no longer answered in a copy. The window's registry row says it is busy a few hundred milliseconds before its hooks' report of the turn reaches the daemon, and for a moment after they report the turn's end: a message that landed in between found a window that was busy (so not written into its inbox) and not mid-turn (so not handed over at its Stop), and ran in a copy. Every later message for that session then went to the copy, "ran in the copy made earlier", while the window sat idle. Where a window is busy by its row and its hooks have not said so yet, the daemon now waits up to two seconds for them (the message is acked `taken` meanwhile) and routes it again: it is handed over at that turn's Stop, or written into the inbox of a window that is idle after all. A session whose hooks have never reported to the daemon is not waited for.
