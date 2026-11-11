---
"sessionpipe": patch
---

The `PermissionRequest` hook names a prompt by its tool call's id where Claude Code's payload carries one, as the `attention.needed` it reports already did. The hook always used the hash of the prompt, the tool and its input, so on a Claude Code that names the tool call the page's Allow / Deny would have named a prompt the daemon did not hold. None does to date: nothing changes on the versions recorded so far.
