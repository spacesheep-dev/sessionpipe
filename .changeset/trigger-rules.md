---
"sessionpipe": minor
"sessionpipe-core": minor
---

A trigger rule, defined once

- A rule and the rules file (`<config>/triggers.json`) are defined in `proto/sessionpipe/v1/config.proto`, with what `sessionpipe trigger list --json` and `trigger test --json` will print. The file is the machine's own: its schema is generated for the CLI and the background service and published nowhere.
- `sessionpipe-core` exports pure functions over them: `checkTriggers` and `readTriggers` (a file that does not fit is refused whole), `describeRule` (the sentence a person confirms), `helloTriggers` (the topics a receiver learns, and nothing else), `matchNotice` and `firstMatch`, `triggerLevel` (never wider than the rule, the machine's mode or the session's own level), `ruleWords` and `composeWords` (the person's words, the notice's tokens in backticks, framed), `triggerRun`, `sampleNotice` and `testAnswer`.
- A rule's subject pattern is a small, safe subset of regular expressions (`^X-[0-9]{1,6}$`): anchored, no groups or alternation, matched without backtracking, so a subject chosen by someone else can never make a match slow.
