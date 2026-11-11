---
"sessionpipe": patch
---

A Stop for a session of one harness no longer stops another harness's session that has the same id. The daemon looked up the turn it was running, and the session it was holding, by the id alone: a Stop for `claude-code:<id>` ended its run of `codex:<id>`, and a Stop for `codex:<id>` interrupted a Claude Code session it held under that id. Both are found by the whole session ref now.
