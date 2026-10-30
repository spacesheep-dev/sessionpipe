---
"sessionpipe": patch
---

On Windows, `status`, `doctor`, `secrets` and `connect` say where a key lives (a file under your profile, not "0600": modes mean nothing there) and that updates run only while `sessionpipe control run` is running, since no service runs the daemon on Windows yet.
