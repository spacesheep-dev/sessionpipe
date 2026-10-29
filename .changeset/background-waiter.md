---
"sessionpipe-core": minor
"sessionpipe": minor
"sessionpipe-receiver": minor
"sessionpipe-conformance": minor
---

A session waiting on its own background work no longer reads idle on a receiver until the work ends (#153). `turn.ended.background` leaves out sessionpipe's own waiter (`sessionpipe wait`, which ends only when a message arrives, and so held every reachable session at "working"), `subagent.ended` carries `background`, the count once that subagent is out of it, and PROTOCOL.md §4 says a receiver SHOULD keep such a session as working until its next `turn.ended` or `session.ended`, not until the next event, which was always the workflow's own. Fixtures: `harness/claude-code/stop-waiter` (recorded on 2.1.312) and `subagent-stop`.
