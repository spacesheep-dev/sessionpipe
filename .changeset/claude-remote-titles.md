---
"sessionpipe-core": minor
"sessionpipe": minor
---

Claude Code: remote titles, off by default (`sessionpipe remote-titles on|off`, config.json `remote_titles`). A session linked to claude.ai goes by the name the Claude app shows for it: the worker reads `title` from `GET api.anthropic.com/v1/sessions/<session_…>` with the session's own Claude Code sign-in (the macOS Keychain item Claude Code keeps for its config dir, else `.credentials.json`), never refreshes, stores or logs the token, and sends the name as `harness`, below a person's own rename. Asked at most once a minute until claude.ai has a name, then every ten minutes; any failure keeps the last name. ADAPTERS.md and PRIVACY.md §3, §5 say so; a redaction vector covers the Claude Code access token's shape (`sk-ant-oat01-`). New: the optional `Adapter.remoteFacts`, `Config.remote_titles`.
