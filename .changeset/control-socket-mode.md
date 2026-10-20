---
"sessionpipe": patch
---

The control daemon's socket is now mode 0600, as spec/CONTROL.md §8 says. It used to take the umask (0755 on a default macOS), so only its 0700 parent kept other users out.
