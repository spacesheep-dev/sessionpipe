---
"sessionpipe-core": patch
---

The stdout sink answers with a retry result when its writer fails (a closed pipe under `sessionpipe tail | head`), as the file and HTTP sinks do, instead of throwing out of `send()`.
