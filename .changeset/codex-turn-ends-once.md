---
"sessionpipe": patch
---

A Codex turn is reported as ended once

- With sessionpipe's hooks and its notify fallback both installed, as `sessionpipe install` leaves them, Codex says each turn's end twice: by its Stop hook, then by its notify. Both were sent, so a receiver saw every Codex turn end two times, and the second also read the transcript and the limits again. The second of the two is now dropped: nothing is sent for it and nothing is read again. A machine where Codex has not approved the hooks still reports each turn's end, from the notify alone.
- A notify of any other kind than a finished turn is not taken for a turn's end.
