---
"sessionpipe": patch
---

A session whose run the daemon ended is no longer left mid-turn. The child's own hooks mark the session mid-turn when its turn begins, and a child that is killed reports no Stop: after a run ended at the 30-minute cap the next message for that session waited for a Stop that was never coming, up to 30 minutes. When a run of the daemon's own ends, however it ends (by itself, at the cap, by a Stop), the session it ran in is no longer mid-turn, and whatever was waiting for its Stop is delivered another way. So after a Stop the next message runs at once, and a second Stop answers "nothing is running in that session as far as this computer can tell, so there was nothing to stop".
