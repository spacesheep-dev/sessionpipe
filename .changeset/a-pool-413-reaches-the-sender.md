---
"sessionpipe": patch
---

pool: a request over the body cap gets the 413 that says why, not a connection reset

The pool answered a request over its 32 MiB cap the moment the cap was passed, while the client was still sending, and closed the connection. On macOS and Windows the bytes still on their way could make the connection reset, throwing away the 413 before the client read it, so Claude Code saw a connection error instead of "request body over … bytes". The pool now reads the rest of the body and drops it (nothing past the cap is kept), and answers when the request ends. A body more than 8 MiB past the cap, or one still arriving 5 seconds after it passed the cap, is answered then and the connection closed, so an endless or stalled upload holds nothing; that far out a reset can still happen.
