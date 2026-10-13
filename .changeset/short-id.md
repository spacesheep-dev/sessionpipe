---
"sessionpipe-core": minor
"sessionpipe": patch
---

A session's short id (PROTOCOL.md §3): the first 8 hex digits of `sha256("sessionpipe.session:" + harness + ":" + id)`, what a person reads in a log line, a notification or a search box. Derived, never sent. Not a prefix of the id: Codex ids are time-ordered, and four of ninety on one machine shared their first eight characters. `shortId()` in core; the worker's log and the daemon's lines that name a session use it.
