---
"sessionpipe": patch
---

A busy session's hook events no longer multiply, go out twice, or hold up the machine's hooks

- A job that had waited over a minute for its turn could be handed to two workers. A claim's age was read from the job file's own time, which claiming does not change, so a sweep that came by took the job back from the worker that was running it. Both ran it and its events went out twice; or, with the session busy, both put it back, and one job became two, then four. On one machine 9,627 hook events of one session became 152,800 queued files in a day. A claim is now timed from the moment it is made, and a worker whose claim was given back to the queue stands down: it neither runs the job nor puts a copy back.
- A copy of a hook event just run is dropped. Each job says which hook event it is (the name its hook gave it; for a job an older hook wrote, its time and payload), a session remembers the last 64 it ran, and a copy that comes up while its event is among them is dropped under the session's lock, and the control daemon is not told of it again. That covers a worker held up past its claim (a machine asleep) and one killed between writing the events and letting go of the claim. A queue that already holds copies of many events still sends most of them as it empties.
- A turn that says nothing new is looked at once every 20 s on a tool call, as `turn.progress` always said. A look that found nothing was not written down, so while a session waited on its own subagents each of their tool calls read its whole transcript again, under the session's lock.
- A sweep reads at most 1,024 names of the jobs folder, and `sessionpipe doctor` and `sessionpipe status` count up to 1,000 waiting hook events (doctor says "1000 or more"). Both listed the whole folder. A folder that holds more than 1,024 is no longer taken oldest first: its jobs are run in the folder's own order until it is back under that.
- A session's facts are written beside their file and moved into its place, so a full disk or a kill leaves them whole or as they were. Facts cut short read as none, and the next turn's end then sent every turn of the session again.
