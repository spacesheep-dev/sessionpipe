---
"sessionpipe": minor
---

The background service runs the person's trigger rules

- A rule on a clock (`mon 09:00`, `day 08:30`, `2h`) runs at its time in this computer's local time, once, however many of its ticks the computer slept through, when the latest is under six hours late; later it is refused `missed`. The nights the clocks change are handled: a skipped time runs as the clock jumps past it, a repeated one runs once.
- A run goes the way a local `sessionpipe ask` goes, at the rule's level narrowed by this computer's mode (and, continuing a session, by that session's own level), with the rule's MCP tools allowed, its framed words and `SESSIONPIPE_TRIGGERED_BY` in the session's environment. It answers no permission prompt.
- Each rule runs at most its cap a day. A run waits while this computer's caps on new sessions are reached, or while a window holds the session it continues (never a copy, never handed to the window), and is refused when it waits too long. A rule whose session is gone is paused by this computer, in its own record; the rules file stays as the person confirmed it.
- Turning triggers off drops every run that waits, a run waiting behind another turn in its session's line too, and stops every triggered run in progress. A run stopped before it began gives its count back.
- A rule that continues a session runs only in that session's own folder, and only when that is the rule's folder, allowed and not a place a rule may never run. A turn of a rule never goes into a session something else holds, and nothing else's turn goes into a session a rule opened: such a session is closed when the rule's turn ends.
- The service's record of the rules is read as untrusted: whatever does not fit is left out and said in its log, and nothing in it, or in the rules file, can stop the service starting. A rule may be named anything the rules allow, `constructor` too.
- Everything a rule did is kept for `sessionpipe trigger list`: the latest lines, a week at most.
