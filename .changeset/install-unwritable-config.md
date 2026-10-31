---
"sessionpipe-core": patch
"sessionpipe": patch
---

A harness config file the system won't let sessionpipe write (read-only: EACCES, or EPERM on Windows after `attrib +r`; a read-only filesystem's EROFS) is reported for that one file with the code — `! claude-code: ~/.claude/settings.json — can't write it (EACCES); not touched` — the way a file that is not plain JSON already was, and `install` goes on to the next harness, so Codex and Gemini CLI are still hooked. Before, the first such file ended the whole command with `EACCES: permission denied` and left every harness after it unhooked. The refusal is caught where each file is written, so a file the adapter wrote before it (Codex's hooks.json before config.toml, one Claude Code account's settings.json before another's) keeps its report, `created` included, which `uninstall` needs. `uninstall` reports a file it can't write or delete the same way and goes on. Only a write that fails after the file was opened (ENOSPC) says the file may be cut short instead of "not touched".
