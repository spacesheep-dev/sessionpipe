---
"sessionpipe": minor
"sessionpipe-core": minor
---

A session can say which of your rules started it

- A session's events may carry `triggered_by`: the name of the rule (`sessionpipe trigger`, coming next) that the background service started or resumed it for. The hook reads it from `SESSIONPIPE_TRIGGERED_BY`, as it reads `SESSIONPIPE_LAUNCHED_BY`, and ignores a value that is not a rule's name. It names, and allows nothing.
- Everything that starts a further session resets the variable with the other lineage variables, so a session started from a triggered one is not marked as the rule's.
- `sessionpipe-core` exports `triggeredBy`, `TRIGGERED_BY_ENV` and `RULE_NAME_RE`, the one pattern a rule is named by.
