---
"sessionpipe": minor
"sessionpipe-core": minor
---

Control: a third machine mode, `inherit`, so sessions you message run the way your own sessions on that machine run. `sessionpipe control mode inherit` (or `--mode inherit` on `control pair` and `connect`, or the whole word at pairing's question) passes no permission flag, so each harness starts every turn in its own default there: Claude Code in its settings' `permissions.defaultMode` (a resume too, and through the Agent SDK too), Codex as its `config.toml`'s `approval_policy` and `sandbox_mode` say, Antigravity with no flag, as in safe. No mode passes a bypass flag. Before this, a machine whose Claude Code settings turn auto mode off (`permissions.disableAutoMode`) had no mode that fit: `auto` ran each messaged session in Claude Code's default mode, which refused every command that needed approval, and `safe` refuses them by design. Schemas: `control-pair` and `control-hello` `mode` gains `inherit`.
