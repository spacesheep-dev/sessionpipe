---
"sessionpipe": patch
---

`sessionpipe control pair` names a first pairing the way the hooks name the machine: `machine` from config.json, else the hostname without its `.local`, `.lan` or `.home` suffix. On macOS the daemon used to register as `<name>.local` while events said `<name>`, so a receiver showed the same machine twice and could not route approvals to it. `--name` and an existing pairing's name still win.
