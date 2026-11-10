---
"sessionpipe": patch
---

Messages for one session run one at a time in the order they were sent. Three messages sent half a second apart behind a running turn ran first, third, second: the two that arrived in one poll were verified side by side, and the one whose verification finished first went first. A message now takes its place in its session's line as it arrives, before it is verified, and the line goes by the time each message was signed (`iat`), then by arrival. That holds on the resume, fork and turn rungs, for a message that has to wait for its session's start, and when the message ahead is stopped, fails or is refused.
