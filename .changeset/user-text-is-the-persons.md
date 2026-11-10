---
"sessionpipe-core": patch
"sessionpipe": patch
---

A turn's `user` text is what the person wrote, and nothing the machine wrote around it. A receiver draws that text as the person's own message, and three things were getting into it from Claude Code sessions. A subagent's report: when a subagent hands its report back, Claude Code records it the way it records a message from another session, and it was read as part of the prompt ("[Subagent hand-back] The text below is the final report of a subagent…"). sessionpipe's own words around a message it delivers: "(Sent via <host> with sessionpipe control, signed on the sender's device.)", "Message via <host> (sessionpipe control, …):", the note to a copy of a session ("You are a copy of that session, started because the original is open in a window…"), and the notes on how an answer travels. And `[Request interrupted by user]`. All are left out now, in `turn.transcript`, in `turn.progress` from its first moment, and in the title a session takes from its first ask; the list of attached files stays. sessionpipe's sentences come off only where the daemon puts them (the line before the words, the line or the note after them): the same words typed or pasted by the person stay, and a prompt that is nothing but one of them is sent as typed.

Two of sessionpipe's own lines stay where they were, because a receiver tells an agent's words from the person's by them: the paragraph after a task another agent asked with `sessionpipe ask` ("(Asked by <harness>:<id> on this machine with sessionpipe ask. …)", the last paragraph of the turn's `user` text however the task arrived), and the first line of a handoff's answer ("Answer from <harness>:<id> (sessionpipe handoff, …):").

A message delivered into a terminal session at a Stop hook is now a turn of its own: its `user` text is the message, marked `injected` like any message that arrived from elsewhere, and the reply is that turn's. Its reply used to be added to the turn before, or sent as a turn with no prompt.

`sessionpipe-core/control` exports the sentences (`frame`, `frameStart`, `frameMarked`, `frameAsk`, `frameHandoff`, `IN_PLACE_ANSWER`, `copyNote`, `RE_ARM`) and `deliveredWords`, which takes off a text the ones that are not the message.
