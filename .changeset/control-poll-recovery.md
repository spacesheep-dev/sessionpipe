---
"sessionpipe": patch
---

Retry control polls after a 401 with a capped backoff, resume immediately when a hello accepts the token, and honour Retry-After on 503 responses. Show polling state, time since the last successful poll, and the last control error in status and doctor.
