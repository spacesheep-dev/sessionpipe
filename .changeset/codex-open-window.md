---
"sessionpipe": patch
---

A message for a Codex session that is open in a window reaches it

- Codex 0.171 locks a session that a window has open, or that its background server still holds for about a minute after the window's last turn, and refuses a second run of it. A message sent to such a session from a paired device failed with Codex's own error, "already has an active writer". It now goes into Codex's own queue for that window (`codex queue`): the window takes it as a turn of its own, at once when it is idle and when its turn ends otherwise, and the answer comes back as for any message delivered in place.
- The message counts as delivered only once Codex's session file shows that a turn began for it. If Codex takes it into its queue and no turn begins (the window was closed in that moment, or the process that has the session does not serve the queue), the outcome is `failed` with code `held`: it says the message is in Codex's queue and may run when the session is next used. Nothing more is queued for that session until it has.
- That turn runs in the window, under the window's own approval and sandbox settings, as if it were typed there; where only Codex's background server still has the session, it runs there with no window open. A message from `sessionpipe ask` carries limits of its own, which hold only in a turn sessionpipe runs itself, so an ask for a session that is open and idle in Codex is refused with that reason and is not queued.
- Where another program's headless `codex exec` is in the middle of a turn in the session, nothing is queued, and the message's outcome says to send it again when that turn is done.
- A Stop cannot take a message back out of Codex's queue: from the moment it is handed to Codex, the turn is the window's to stop.
- Where Codex has a session's lock file and the `codex` on the daemon's path is 0.171.0 or later, the session is no longer refused for 90 seconds after it was last written to: Codex itself says whether something has it.
- In the transcript, a message that was delivered to a Codex session is the person's words, without sessionpipe's frame around them.
