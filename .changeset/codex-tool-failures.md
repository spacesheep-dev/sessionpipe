---
"sessionpipe": patch
---

A Codex command that fails is reported as failed

- Codex tells its hooks what a command printed and never how it exited, so every Codex tool call was reported as `ok`. Codex's own session file says how a finished command exited, a moment after the hook. The worker now looks there before it reports the call's end: a command that exited with anything but 0 is `ok: false` with `error: "exit N"`.
- Not covered, and reported as before: a command Codex leaves running in the background, an edit, a tool that is not a command, calls a subagent makes, calls run side by side whose results Codex writes late, and a Codex old enough to name its calls otherwise.
