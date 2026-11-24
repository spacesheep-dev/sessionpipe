---
"sessionpipe": patch
---

A message sent to a Codex session that is busy reaches it

- A message for a Codex session in the middle of a turn was taken and then failed: the session's Stop never asked for it. Codex's Stop hook now asks the background service as Claude Code's does, and Codex goes on with the message in the same turn. The reply is read from Codex's own session file and sent back.
- In the transcript such a message is the person's own turn, in their words, where it used to appear wrapped in Codex's markup. A reason another tool's Stop hook gave Codex is no longer shown as something the person typed.
- The answer to a message handed over this way is sent as one turn when it is over, where a slow read could send its first words alone.
- When the person stops a Codex turn, a message that was waiting for the turn's end no longer waits for an end that is not coming.
