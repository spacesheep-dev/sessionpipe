---
"sessionpipe": patch
---

Ignore Claude Code's lone SessionEnd hooks (for example, from `claude mcp list`) when there is no outbox, stored facts or existing transcript. These hooks no longer create an outbox or reach a sink or the local daemon. Real sessions still send their end, including when their transcript was deleted but an outbox or facts remain.
