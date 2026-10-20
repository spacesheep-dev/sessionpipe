---
"sessionpipe": patch
"sessionpipe-core": patch
---

`turn.progress`: a message absorbed by a running turn, and text the person never typed, no longer open a turn of their own. Claude Code reports a message sent mid-turn (the person's, another session's, a task notification) as a prompt carrying the running turn's id; its reading went out numbered as the next turn, which the transcript never delivers, so a receiver kept showing it, with an empty reply, instead of the running turn. Such a prompt now leaves the reading on the turn the transcript is in, and a task notification that starts a turn is not shown as its ask. `isInjected` also recognises a wrapper tag with attributes (`<cross-session-message from="…">…</cross-session-message>`).
