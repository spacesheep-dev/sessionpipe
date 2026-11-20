---
"sessionpipe": minor
"sessionpipe-core": minor
---

Claude Code: a session says the reasoning effort its latest turn ran at

- `session.effort` is new and optional, tier 0 like `model` (#210). The Claude Code adapter takes it from the hook payload's `effort.level`, and from the newest assistant line of the transcript that says one, so a change made with `/effort` shows on the next event. A payload or transcript that says nothing sends nothing, and a receiver reads absent as unknown.
- It is a bare word of at most 40 characters, as `submitted_by` is: tier 0 is not redacted, so a value of any other shape is not sent. `spec/PROTOCOL.md` §3 and `spec/PRIVACY.md` say so.
