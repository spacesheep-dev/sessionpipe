---
"sessionpipe": minor
"sessionpipe-core": minor
"sessionpipe-receiver": minor
"sessionpipe-conformance": minor
---

A `devin` adapter: Devin CLI (Cognition) sessions are reported like any other harness. `sessionpipe install` (or `--devin`) writes the eight event names Devin accepts into the `hooks` key of its user config file; the payload maps to the protocol's events, the folder comes from `DEVIN_PROJECT_DIR` (nothing in the payload names it), and tier 2, the model, the title and the times are read read-only from Devin's own SQLite session store — through a new `readers/sqlite.ts` that works on Node 20 too (in-process `node:sqlite`, else a short child process, else the `sqlite3` CLI, else no turns). Eight fixtures recorded from real runs on 3000.11.3. Also: the `claude-code` adapter now drops a payload with no `transcript_path` and a non-UUID session id — that is another harness running our entry in `~/.claude/settings.json`, not Claude Code — and the worker logs a dropped event instead of discarding it in silence when no adapter owns its harness name.
