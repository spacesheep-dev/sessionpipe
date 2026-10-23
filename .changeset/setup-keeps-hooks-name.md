---
"sessionpipe": patch
---

A repeat `install` or `connect` on a config without a machine name keeps the name the hooks have been using (the hostname without `.local`), and renames a control daemon paired under another name to it, instead of adopting the daemon's. Before, a Mac paired before 0.9.0 (daemon `<host>.local`, events `<host>`) had its events switch to `<host>.local` on the first update, so a receiver showed its new sessions under a second machine. Receivers key a pairing by id, so the daemon's rename costs nothing.
