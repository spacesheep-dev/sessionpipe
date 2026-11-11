---
"sessionpipe": minor
---

Grok Build: sessions report under their own name, `sessionpipe install --grok-build`

- A new adapter, `grok-build`, for xAI's Grok Build CLI. `sessionpipe install` writes a hooks file of its own, `~/.grok/hooks/sessionpipe.json`, and reports the session, its turns and tools, a permission prompt that is waiting, and (at tier 2) the conversation from the session's `updates.jsonl`. Title, model, folder and times come from the session's `summary.json`. `backfill` lists past sessions.
- Grok Build also runs the hooks in `~/.claude/settings.json`, with a payload that looks like Claude Code's. Until now sessionpipe's Claude Code entry there reported every Grok session as a Claude Code session. That entry now tells a Grok payload apart and reports nothing; the Grok adapter reports it.
- Recorded on Grok Build 1.0.77; `PostToolUseFailure`, `StopFailure` and `PreCompact` are mapped from Grok's documentation and still wait for a recorded payload.
