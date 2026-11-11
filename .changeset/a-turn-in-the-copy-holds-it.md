---
"sessionpipe": patch
---

A message for a session whose copy is in the middle of a turn is no longer run into that turn. A session's later messages go to its copy, and the copy's hooks report under the copy's own id, but only the original's own mid-turn state was looked at: with a turn running in the copy and no registry row to say so, a message that named the original was `delivered mode=resume` in the copy, beside the process that had it. A turn the copy's own hooks report now holds the copy; the message is acked `unsupported` with "another Claude Code process on this computer was running the copy this session's messages go to, and a copy is never itself copied", and runs once that turn has ended.
