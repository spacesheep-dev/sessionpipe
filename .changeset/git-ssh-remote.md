---
"sessionpipe-core": patch
---

Write an `ssh://git@host/owner/repo.git` origin as `host/owner/repo` in `session.repo`, the same as the `git@host:owner/repo.git` form of that remote. Before, the two spellings of one repository reached a receiver as two different repos.
