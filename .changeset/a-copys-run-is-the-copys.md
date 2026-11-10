---
"sessionpipe": patch
---

A copy of a session that fails no longer makes the machine treat the original as free. The end of the daemon's own run counted as the end of whatever had last written to the session it was started from, also when that run was a copy (`--fork-session`), which runs in the copy and never in the original: so after a copy failed, a message sent a second later was resumed in place, in a session that something else had written to seconds before. A copy's run now accounts only for the copy, however it ends (by itself, by failing, by a Stop): the original stays held for as long as it was going to be, and a turn the person is in there is still a turn in progress, so the next message is copied again or waits for their Stop.
