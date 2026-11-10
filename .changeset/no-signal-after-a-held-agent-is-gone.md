---
"sessionpipe-core": patch
"sessionpipe": patch
---

Closing an ACP agent that has already exited signals nothing. The daemon closes a held agent it finds gone, and the close armed its two timers all the same (SIGTERM after 2 seconds, SIGKILL after 12), whose only disarming was an exit that had already happened: both went to the number of a process group that no longer existed, or that the system had since given to another process.
