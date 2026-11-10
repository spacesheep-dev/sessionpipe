---
"sessionpipe-core": patch
"sessionpipe": patch
---

A turn's `user` text is what the person wrote, and nothing the machine wrote around it. A receiver draws that text as the person's own message, and three things were getting into it from Claude Code sessions. A subagent's report: when a subagent hands its report back, Claude Code records it the way it records a message from another session, and it was read as part of the prompt ("[Subagent hand-back] The text below is the final report of a subagent…"). sessionpipe's own words around a message it delivers: "(Sent via <host> with sessionpipe control, signed on the sender's device.)", "Message via <host> (sessionpipe control, …):", the note to a copy of a session ("You are a copy of that session, started because the original is open in a window…"), and the notes on how an answer travels. And `[Request interrupted by user]`. All are left out now, in `turn.transcript`, in `turn.progress` from its first moment, and in the title a session takes from its first ask; the list of attached files stays.

A message delivered into a terminal session at a Stop hook is now a turn of its own: its `user` text is the message, marked `injected` like any message that arrived from elsewhere, and the reply is that turn's. Its reply used to be added to the turn before, or sent as a turn with no prompt.

`sessionpipe-core/control` exports the sentences (`frame`, `frameStart`, `frameInbox`, `frameAsk`, `frameHandoff`, `IN_PLACE_ANSWER`, `COPY_NOTE`, `RE_ARM`) and `deliveredWords`, which takes them off a text.
