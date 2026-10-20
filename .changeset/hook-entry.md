---
"sessionpipe": patch
---

The hook and worker entries run only when invoked as the script, so both can be tested in process. What they do, print and exit with is unchanged; the hook still imports node builtins only and its timing is the same.
