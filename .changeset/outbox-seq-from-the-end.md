---
"sessionpipe": patch
"sessionpipe-core": patch
---

A session with a very large outbox no longer stops sending when its seq counter is lost

- A session's next seq is kept in a small counter file. When that file was unreadable, the last seq was recovered by reading the session's whole outbox into one string. A long session's outbox does not fit in one (1.9 GB on one machine): the read took a worker's whole life and 1.7 GB, then failed, for every hook event of that session, under the session's lock. Nothing of that session was sent for two days, and the workers queueing behind it slowed every hook on the machine. The last seq is now read from the outbox's end, a line at a time (3 ms for that file), and no more than one line of the size an outbox is written with is held at once.
- The counter, like a session's facts, is written beside its file and moved into its place. A kill between the two leaves the counter as it was, and so does a disk too full to write beside it, where it used to be left empty. Where the move is refused (Windows, with the file open elsewhere) it is written in place as before.
- A job whose run fails with an error is still not run again, and the log now says so: `claude-code PreToolUse: the job failed and is not run again: RangeError [ERR_STRING_TOO_LONG] at …`. It said nothing before. The error's own words are kept only when the system said them (a file, a command or a connection that failed: a code and a path or a name); any other error is named by its kind and where it was thrown, since its words can quote a payload.
