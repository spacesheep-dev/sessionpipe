---
"sessionpipe": patch
---

A copy answers knowing what the session has done since, and the session hears what the copy did

- A message the daemon can't hand to a session in place runs in a copy of the session, and every later message went to that same copy for good. A session that kept working after the copy was made (open in the desktop app, say) had its messages answered for days by a copy that knew none of that work. Now, once the session has been written to since a message last ran in its copy, the next message gets a fresh copy of the session as it is. A follow-up while the session hasn't moved still goes to the same copy.
- Nothing a copy does shows in the session's own conversation, so the session went on working beside edits it never saw. What each copy was asked and answered is now kept, and the session gets it as context with its next prompt (Claude Code's `UserPromptSubmit` hook), once.
