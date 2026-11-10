---
"sessionpipe-core": patch
"sessionpipe": patch
---

A turn's `user` text no longer ends with what 0.13.0 to 0.13.2 told a copy ("You are a copy of that session, started to answer this message: …"). No daemon writes that sentence any more, but every copy those versions made has it in its transcript, so on a backfill it stayed in the person's words, and an agent's ask that carried it was not recognised as an ask. `deliveredWords` takes it off like today's notes.
