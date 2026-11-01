---
"sessionpipe": patch
---

`sessionpipe install`, `uninstall` and `backfill` refuse a bare word (`uninstall codex`, `uninstall --keep-state codex`, `install claude-code`), say to pass `--<harness>`, and exit 2 without touching anything. The word was ignored, so `uninstall codex` unhooked every harness and `install claude-code` hooked every harness found. A word that is an option's value (`install --machine codex`) is read as before.
