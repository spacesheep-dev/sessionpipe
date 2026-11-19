---
"sessionpipe-core": patch
---

Outbox: the event written after an append that was cut short is no longer lost with it

- An append cut short by a full disk, a file-size limit or a killed process left a line with no end. The next event was written onto that line, and every reader dropped the two together: no log line, and a gap in `seq` at the receiver. An append now looks at the file's last byte and starts on a new line when it is not a newline, so only the cut event is lost (#202). `spec/OUTBOX.md` §2 says so.
