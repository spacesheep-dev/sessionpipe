---
"sessionpipe": minor
"sessionpipe-core": minor
"sessionpipe-receiver": minor
"sessionpipe-conformance": minor
---

Review fixes to the Devin adapter and two gaps it exposed.

`devin`: a turn is now timed by the message's own `metadata.created_at`, not by `message_nodes.created_at` — that column is the time the row batch was last **saved**, one value for the whole chain, rewritten on every save and not monotonic along it, so every turn of a session was reported at the same wrong instant. The chain read is now bounded by the cursor and caps from the newest end: past 4000 nodes the old query kept the 4000 **oldest** and then delivered nothing ever again, and every Stop re-read the chain's root (a 17 kB system prompt and four more system blocks). `installed()` reports `inactive`, not `current`, when the config file holds any event name Devin does not know — Devin then loads no hooks from that file at all, ours included — and `install()` says so too. A `tool_response` that is not an object no longer loses its output. `facts()` takes the hook's environment (new optional argument on the `Adapter` interface), so a job swept by a worker another harness's hook spawned still reads the right config and session store.

`sessionpipe uninstall` takes the same `--<harness>` selection `install` has, removes the shared hook launcher only on a full uninstall, and refuses an all-harnesses uninstall when `SESSIONPIPE_CONFIG`/`SESSIONPIPE_STATE` point away from this machine while other harnesses would still be read from `$HOME` (pass `--all` to mean it). The hook forwards `XDG_CONFIG_HOME`, `XDG_DATA_HOME` and `APPDATA` in the job file, beside the per-harness variables already there. The control wait — up to 125 s on a `PermissionRequest` — now applies the same "this is not a Claude Code payload" test the worker does, so our entry in `~/.claude/settings.json` run by another harness returns at once. A payload no adapter claims is logged rather than dropped in silence.

Tests: the Devin session-store tests build their fixture through the `sqlite3` binary where `node:sqlite` is absent, so they run on the Node 20 floor — where the `cli` engine is the only way into a database, and where all seven used to skip. Each engine is asserted where it works and skipped only for itself; `inlineParams` and the adapter's own chain query are covered.
