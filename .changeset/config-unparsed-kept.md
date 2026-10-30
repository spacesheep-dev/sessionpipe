---
"sessionpipe-core": patch
"sessionpipe": patch
---

A config.json that does not parse (a hand edit's trailing comma, a byte-order mark, a file cut short) is no longer written over with the defaults, which erased the machine's name and every sink with its token. A command that would save it stops with an error naming the file and what is wrong with it; `install`, `connect`, `uninstall` and `control pair` stop before they change anything, and `sink add` before it asks the receiver anything. A config.json that is there but cannot be read is not written over either.
