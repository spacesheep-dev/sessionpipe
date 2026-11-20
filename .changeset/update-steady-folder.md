---
"sessionpipe": patch
---

`sessionpipe update` works from a folder the terminal cannot read

- An update runs npm, and npm asks which folder it is in before anything else. In a terminal that could not read its own folder (macOS had not let it into Desktop, or the folder was deleted under the shell) npm stopped there, and the update failed with `npm install: } Node.js v23.6.1`. When the folder a `sessionpipe update` or a `sessionpipe reinstall` was typed in cannot be told, npm, the new copy's version check and the hooks' re-arm now start in the home folder. From any other folder nothing changes.
- When one of those commands stops on an error nothing caught, the reason given is what was thrown, the line under the caret in the dump (`Error: EPERM: operation not permitted, uv_cwd`), not the dump's last two lines.
