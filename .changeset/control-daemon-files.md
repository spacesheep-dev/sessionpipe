---
"sessionpipe": minor
---

Control daemon: a `start` may bring files, for every harness it can start (Claude Code, Codex, Antigravity). The daemon fetches each from `{control}/files/{sha256}` with the machine's token, stops reading past the signed size, checks length and hash, writes them under `<cwd>/.sessionpipe/files/<session>/` (self-ignoring `.gitignore`, no symlinks followed, exclusive create, mode 0600) and starts the session with the text plus the list of relative paths. Any file problem acks `failed` with code `file` and starts nothing. Pair and hello now say `files: true`.
