---
"sessionpipe": minor
"sessionpipe-core": minor
---

`sessionpipe backfill` sends the words of sessions no hook reported (#123)

- A session whose turns no hook ever reported (a Codex Desktop thread, a Claude Code session from before the hooks were installed) used to reach a receiver only as one `session.backfill`, with no words. `sessionpipe backfill`, with a sink at tier 2 or higher, for Claude Code, Codex and Grok Build sessions (the harnesses whose backfill names a transcript), now also queues one `turn.transcript` per exchange its transcript holds that was never sent, numbered from the session's transcript cursor as a live turn's are, and redacted the same way before it is written. Each event is filtered per sink as any other, so a sink below tier 2 gets what it got before.
- The cursor is saved, so a second `backfill` sends nothing again, and a transcript not written since a backfill read it to its end, or found it a day old, is not read again until it is written. A session a hook is busy with is left for the next run. A session's last turn waits until it is over: its file says the turn ended (Claude Code: a reply that waits on no tool; Codex: `task_complete`; Grok Build: `turn_completed`), the file has been quiet for ten minutes and no hook holds a turn open; or nothing has written the file for a day. A turn a hook holds open goes only once its file says it ended, however long it waits, so its own worker and the backfill never each send a part of it.
- `sessionpipe install` and `sessionpipe connect` still backfill metadata only; with a tier-2 sink and a session whose words a backfill can read, each now says that `sessionpipe backfill --days N` sends them.
- `spec/PROTOCOL.md` widens who sends `turn.transcript`, and `conformance/delivery/35-backfill-transcript.json` is the receiver's scenario for it.
