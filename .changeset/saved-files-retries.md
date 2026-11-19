---
"sessionpipe": patch
---

Control: a file sent with a message gets through a moment's trouble, and a failure says what happened in plain words

- When the connection drops or the receiver answers with a 5xx, the daemon tries a picture or file twice more, after 1 s and 4 s, inside the file's 5-minute limit; a 404, another status, a wrong size or hash still fails at once.
- A failure says what happened: `"shot.png" didn't finish downloading within 5 minutes`, `couldn't download "shot.png": the connection to the receiver kept failing`, `couldn't save the files: this folder can't be written to`, `couldn't save the files: the disk is full`. `spec/CONTROL.md` §6 has the rule, and `conformance/control-file-retry.json` the cases.
