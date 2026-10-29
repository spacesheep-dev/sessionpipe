---
"sessionpipe-core": patch
"sessionpipe": patch
---

Windows: a harness installed with `npm install -g` is a `.cmd` shim (`claude.cmd`, `codex.cmd`, `gemini.cmd`), which node refuses to spawn without a shell (EINVAL, since 20.12). `doctor` and `connect` died with `spawn EINVAL` on such a machine, `claude --help` silently read as a Claude Code with no capabilities, and every headless turn the daemon ran for Claude Code, Codex or an ACP agent failed the same way (#165). Now the shim's own script (the one npm's shim names) is run under the node sessionpipe runs on, with no shell, so a prompt reaches the harness byte for byte; a probe with fixed words (`--help`, `auth status`, `login status`, `--version`) whose launcher can't be read that way runs through a shell as one quoted command; and a headless turn whose launcher can't be read says so instead of spawning it. Elsewhere nothing changes.
