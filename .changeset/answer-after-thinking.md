---
"sessionpipe": patch
---

An answer a live session gives in place now comes back whole when the model thought before writing it. Claude Code 2.1.314 writes such a turn's last message as a thinking record and then the text, both with `stop_reason: end_turn`; the daemon took the thinking record for the end of the answer and acked a `waiter` or `turn` delivery with no reply.
