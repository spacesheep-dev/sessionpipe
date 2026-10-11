---
"sessionpipe": minor
"sessionpipe-core": minor
---

`turn.progress` (tier 2): a turn still running goes out as it runs, not only when it ends. The prompt is sent as the turn starts, then what the assistant has said so far, at most every 20 s on a tool call and only when it changed, under the number its `turn.transcript` will carry. Over 20 000 characters the reply keeps its end. A 21-minute turn used to show nothing on its receiver for 21 minutes.
