---
"sessionpipe": patch
---

`sessionpipe install` exits 1 when every harness it worked on was left alone (a settings file that isn't plain JSON, say), and its last line says nothing was hooked. It exited 0, so a script couldn't tell. One harness hooked is still exit 0.
