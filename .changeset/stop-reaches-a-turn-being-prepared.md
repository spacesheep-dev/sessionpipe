---
"sessionpipe": patch
---

A Stop reaches a turn from the moment its message's turn comes, not only once its process is running. Before a child process exists the daemon checks the harness's login (`claude auth status`, seconds when it is not cached), downloads the message's files and may wait for a free slot: a Stop in any of those means the turn never starts. The Stop is acked `taken` and then `delivered` ("stopped the turn this computer was running for that session"), a message's own ack is `delivered` with "(The turn was cancelled.)", and a start that never began is acked `failed` with code `cancelled` and "stopped before it started, as asked: no session was created". For a session whose start is still running, a Stop stops that start and not a message waiting for it, whichever of the two the daemon got through its checks first, and it never waits for a start to end.
