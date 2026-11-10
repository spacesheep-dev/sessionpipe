---
"sessionpipe": patch
---

Two messages can no longer run in one copy's transcript at the same time. A session's messages go to its copy, and the copy is on the board under its own id, so a person can message either. The daemon queued runs under the id each message named, so one sent to the session and one sent to the copy were started side by side in the copy whenever the copy's own hooks had not yet marked it mid-turn (always, where that account has no hooks). Runs are queued by the transcript they run in.
