---
"sessionpipe-core": patch
"sessionpipe": patch
---

An Antigravity session in a git checkout now opens its own conversation from its link, not Antigravity's home. Antigravity keeps a git checkout's folder under `gitFolder` in `~/.gemini/config/projects/<id>.json` (`{ "gitFolder": { "folderUri": … } }`) and only a plain folder's at the top of the resource, so the session's project was never found for a repo: the link had no `?p=c/<conversation>?section=<project>`, or named an enclosing plain folder's project instead (6 of 8 projects on one machine, 2026-10-20).
