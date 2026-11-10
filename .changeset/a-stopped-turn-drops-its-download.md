---
"sessionpipe": patch
---

A turn stopped while its files are still being downloaded gets one final ack, and the download ends there: the request in flight is dropped, no further file is asked for, and a file that arrives all the same is not written into the folder. A message stopped then is acked `delivered` with "(The turn was cancelled.)", and a new session `failed` with code `cancelled` and nothing of it left in the project.
