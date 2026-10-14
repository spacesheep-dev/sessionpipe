---
"sessionpipe": patch
---

Ignore Claude Code SessionEnd hooks with no local session history or transcript,
so administrative MCP checks cannot create empty sessions. Refuse setup downgrades
unless explicitly allowed, and preserve machine names on re-connect or re-install;
explicit renames cannot diverge from the paired daemon.
