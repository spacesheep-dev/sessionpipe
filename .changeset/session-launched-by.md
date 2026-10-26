---
"sessionpipe-core": minor
"sessionpipe": minor
"sessionpipe-conformance": patch
---

`session.launched_by`: the session that started this one, as `<harness>:<id>`, read from `SESSIONPIPE_LAUNCHED_BY` in the hook's environment (PROTOCOL.md §3). A script that runs `claude -p` for a session sets it, and a receiver can group the run under its launcher without reading it as a subagent. A subagent keeps its `parent_id` and gets no `launched_by`.
