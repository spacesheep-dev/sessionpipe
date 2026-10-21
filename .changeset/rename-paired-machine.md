---
"sessionpipe": patch
---

`sessionpipe connect --machine NAME --rename-machine` (and `install`) now renames a paired control daemon too, so the hooks and the daemon stay one machine on a receiver. Before, setup refused to touch a paired daemon's name, and a machine whose pairing predates the fix in 0.9.0 that names pairings like the hooks had no way to merge its two cards. The daemon says a new name in a hello at once, as it does for folders and mode.
