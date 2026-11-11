---
"sessionpipe": patch
---

A run that was asked for a copy and ran as the original instead no longer frees the original when it ends. A Claude Code that takes no notice of `--fork-session` runs in the session it was told to copy, and its hooks report under that session's id: when such a run ended by itself, its own Stop and SessionEnd read as the original's, the write that had held the original counted as accounted for, and the next message was resumed in place. After a copy's run that is not known to have run in another session, the original now stays held for 90 seconds, as it is by any write of unknown hand, so the next message is copied (or waits) instead.
