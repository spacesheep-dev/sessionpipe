---
"sessionpipe": patch
"sessionpipe-core": patch
---

A machine's hello says, per Claude Code account, whether the command line is signed in to it (`accounts[].signed_in`, CONTROL.md §2), from the same `claude auth status` the daemon asks before a resume. A session signed in through the Claude app runs fine in its window while the `claude` the daemon resumes with has no login of its own, and until now the first message found that out, failing with "run `claude auth login`"; a receiver can now say so before anyone sends one. The daemon logs the change ("claude isn't signed in as me@example.com as the daemon sees it …"), once per change. Absent when the daemon can't tell.
