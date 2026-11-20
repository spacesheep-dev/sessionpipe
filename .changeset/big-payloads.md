---
"sessionpipe": patch
"sessionpipe-core": patch
---

A prompt, a Write or a tool result over 1 MiB makes its event again

- The hook kept only the first 1 MiB of a payload, so a bigger one was cut mid-JSON and its event dropped with a log line saying the adapter did not claim it (#200). The hook now hands on the whole payload, up to 64 MiB, and an event too long for one outbox line is written with its text cut the way every sink is sent it anyway, so no sink gets less than before and no session's drain stops at it. A payload that cannot be read (over 64 MiB, or not JSON) is still dropped, and the log line now says how many bytes it was. `spec/OUTBOX.md` §2 and `spec/ADAPTERS.md` say so.
