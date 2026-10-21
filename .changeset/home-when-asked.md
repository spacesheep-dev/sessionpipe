---
"sessionpipe-core": patch
---

Internal: the home directory is read when a path is asked for, not when the package loads. A process whose HOME changes after import (a test with a sandbox home) gets the new one; no user-facing change.
