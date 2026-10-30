---
"sessionpipe-core": minor
"sessionpipe": minor
---

**For receivers.** What a 0.12.0 machine sends and accepts beyond 0.11.0 (CHANGELOG.md, "For receivers (0.12.0)", has the detail).

- **Hello and pairing request** say `ask` (sessions there may ask another agent) and `handoff: true` (a `start` or a `prompt` may carry `reply_to`). A machine that says neither is 0.11.0 or older: send it no `reply_to`, or it refuses the command `bad_fields`.
- **`reply_to`** on a `start` or a `prompt`: a session on the same machine that gets the answer as a message after the command's final `delivered` ack, framed `Answer from <harness>:<short id> (sessionpipe handoff, asked via <receiver host>):`. The command's own ack is unchanged; the relay is not acked and never relayed further.
- **Events:** `delegation.started` and `delegation.ended` on the asking session (tier 0; `text` at 1, `reply` at 2), with `relayed` saying how a handoff went, and `session.delegated_by` on every event of the session that answers. Lineage, never authority: join on `to` and `delegated_by`, never read `delegated_by` as a subagent, and keep a `delegation.*` event you don't know as any other type.
- A receiver that pre-checks commands re-vendors 0.12.0's `sessionpipe-core/control` and its vectors (`165`–`169` are new).
