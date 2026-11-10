---
"sessionpipe-core": patch
"sessionpipe": patch
---

A headless run that is stopped or reaches its 30-minute cap no longer signals its process group ten seconds after the child has exited. The follow-up SIGKILL was on a timer that was never cleared, so it went to the group's number even when the group was gone, the one way the daemon could signal a process it had not started (a pid reused as a group leader inside those ten seconds); every remote Stop armed it. The timer is cleared when the child exits, whatever the child left in its group (a tool that ignores SIGTERM) is killed at that moment, once, and a Stop or a cap that arrives after the child has exited signals nothing and no longer marks the finished run as stopped or timed out.
