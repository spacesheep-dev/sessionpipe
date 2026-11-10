---
"sessionpipe-core": patch
"sessionpipe": patch
---

A turn in a Claude Code terminal session reaches a tier-2 sink when it ends, not when the next one does. Claude Code writes its transcript up to 100 ms after the fact and a terminal's Stop hook fires sooner than that, so the worker used to read a file that did not hold the turn's last message yet: the receiver got "the turn ended" and then the prompt and the reply one turn late, or only when the session closed. The Stop names the turn's last words, and the worker now waits for the file to hold them: 400 ms with the turn's end, then for 5 s more behind it, then at the session's next hook. A turn is sent once, and whole: one that said something before a tool call is no longer sent as that half with the rest as a second turn that nobody asked. The hook itself does no more than before.

A turn stopped with Esc or Ctrl-C is no longer lost. No hook fires for it, so at the session's next prompt, compaction, start or end the worker reads the interruption from the transcript and sends the turn with what it had said, and a `turn.ended` with `reason: interrupt` where the turn was still held as running. The next prompt is a turn of its own instead of being joined to the one that was stopped, and `[Request interrupted by user]` is never part of anyone's prompt.
