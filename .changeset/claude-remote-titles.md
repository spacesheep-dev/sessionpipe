---
"sessionpipe-core": minor
"sessionpipe": minor
---

Claude Code: remote titles, off by default (`sessionpipe remote-titles on|off`, config.json `remote_titles`). A session linked to claude.ai goes by the name the Claude app shows for it: the worker reads `title` from `GET api.anthropic.com/v1/sessions/<session_…>` with the session's own Claude Code sign-in (the macOS Keychain item Claude Code keeps for its config dir, else `.credentials.json`), never refreshes, stores or logs the token, and sends the name as `harness`, below a person's own rename. Asked once a minute while claude.ai answers without a name, else every ten minutes, a failure included; the Keychain lookups give up after 1 s and the call after 3 s, inside the 6 s a sibling hook waits for the session lock. Any failure keeps the last name. ADAPTERS.md and PRIVACY.md §3, §5 say so; a redaction vector covers the Claude Code access token's shape (`sk-ant-oat01-`). New: the optional `Adapter.remoteFacts`, `Config.remote_titles`.
