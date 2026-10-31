---
"sessionpipe": patch
---

A batch the receiver answers 413 is halved, and when one half then gets a 400, only that half is dropped (and logged with its size); the other half is still sent. Before, the 400 on the first half was taken as the answer for the whole batch: the cursor moved past both halves, so the second half's events were never sent, and the log named only the 400.
