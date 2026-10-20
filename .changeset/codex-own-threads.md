---
"sessionpipe-core": patch
"sessionpipe": patch
"sessionpipe-conformance": patch
---

Codex: only the person's own threads become sessions.

- An ephemeral thread is no longer reported: its hooks carry `transcript_path: null` and its notify finds no rollout. Codex Desktop runs its own background work this way (ambient suggestions and their safety review, a new chat's title), and so does `codex exec --ephemeral`. Each used to arrive as an untitled session with no turns, often with `/` as its folder.
- A subagent's thread is no longer a session of its own. Its parent already reports it (`SubagentStart` / `SubagentStop`, its tool calls), so its notify and its rollout (backfill) report nothing. A fork the person made is still a session.
- Inside a subagent, Codex sends the parent's `session_id` with the subagent's own rollout. That file is no longer read as the parent's transcript, so the parent's running turn (`turn.progress`) no longer shows a subagent's words.
- Conformance: a harness fixture with an empty `expect` is a payload the adapter must report nothing for.
