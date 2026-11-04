---
"sessionpipe-core": patch
"sessionpipe": patch
---

A subagent's end now carries the `background` count it restates (PROTOCOL.md §4, #153). 0.12.0 added `background` to `subagent.ended` so a receiver holding a session as waiting on its own work learns the count fell before the session wakes, but the privacy allowlist still kept only `agent_id` and `agent_type` for that event, so the count never left the machine. `turn.ended.background` was unaffected.
