---
"sessionpipe-core": patch
---

Control: a message for a Claude Code session is no longer refused `ambiguous_home` when several accounts share one `projects/` tree and live-session registry by symlink. Each finds the same transcript and the same live record, so the machine takes that one session (spec/CONTROL.md §6.1). Two transcripts, two processes, or nothing live is still refused.
