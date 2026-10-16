---
"sessionpipe-core": patch
---

Recover a session's seq counter when its file is empty or not a number (a crash between truncate and write leaves it empty). Before, the counter restarted at 0 and the receiver's deduplication silently dropped every later event of that session; now the next seq is read from the outbox file's last line, as it already was when the counter file was missing.
