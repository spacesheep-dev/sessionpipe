---
"sessionpipe": minor
---

Autopilot: sessions report under their own name, `sessionpipe install --autopilot`

- A new adapter, `autopilot`, for Directionally Local's Autopilot. `sessionpipe install` writes one entry per event, each with the id `sessionpipe`, into Autopilot's global hook settings (`~/.config/autopilot/settings.json`, `$XDG_CONFIG_HOME` when set), and reports the session, its turns and tools, a permission prompt that is waiting, compactions and the session end; at tier 2, the conversation from the Claude Code-format transcript Autopilot writes beside each session. `/hooks disable sessionpipe` in Autopilot switches them off, and `sessionpipe status` says so.
- Autopilot's session ids hold a `_`, which the protocol's ids don't allow (#279): the adapter writes it as `.`.
- Autopilot imports Claude Code's hooks switched off. If the person switches sessionpipe's Claude Code entry on there, that entry now tells an Autopilot payload apart and reports nothing; the Autopilot adapter reports it.
- Recorded on a build of Autopilot with directionally-local/autopilot#1272 (`StopFailure`, `PreCompact.trigger`, versioned payloads), not yet released; `PreCompact` still waits for a recorded payload.
