---
"sessionpipe": patch
---

A Codex turn that fails is reported as failed

- Codex fires neither its Stop hook nor its notify when a turn fails at its model's service (a usage limit, a sign-in that ran out, a server error). Such a turn was reported as started and never as ended, and its prompt was joined to the next turn's in the transcript. Its end is now read from Codex's own session file and reported as `turn.ended` with `reason: error` and Codex's class for the error (`usage_limit_exceeded`, `unauthorized`, ...), never the error's message. In `codex exec` that happens as the session ends; in an open window, at the person's next prompt or when the session is next started.
- A turn that failed, and one the person stopped, is a turn of its own in the transcript: the prompt after it is no longer joined to it.
