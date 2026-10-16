---
"sessionpipe": patch
---

After a 429, the HTTP sink waits as `retry-after` says when the header is an HTTP date (RFC 9110), not only when it is a number of seconds. Before, a date fell back to the 2 s backoff ladder.
