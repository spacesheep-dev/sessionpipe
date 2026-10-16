---
"sessionpipe-core": patch
---

Stop the transcript cursor before a last line the harness is still writing. Before, a prompt whose line had no newline yet when the worker read the file was counted as read and never delivered, so the reply that followed arrived as a turn with an empty prompt. A complete last line without a trailing newline is still read.
