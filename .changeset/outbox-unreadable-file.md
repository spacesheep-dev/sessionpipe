---
"sessionpipe": patch
---

A drain skips an outbox file it can't read (a 0600 file a hook left as another user under the same HOME, or, on macOS and Linux, a folder named `<id>.jsonl`; Windows reads a folder as an empty file) with a line in the log naming the file and the error, leaves that session's cursors where they were, and still sends every other session to every sink. Before, the read error threw out of the drain: no sink took the sessions listed after that file, nothing was logged, and the prune that follows the drain never ran.
