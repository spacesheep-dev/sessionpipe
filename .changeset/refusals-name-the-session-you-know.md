---
"sessionpipe": patch
---

A refusal for a session this machine doesn't have names it by the start of its own id, the one a receiver's page and `claude --resume` use: "no Claude Code session 88749ed7 on this machine". It used the protocol's short id, a hash no page shows ("66a04e0a" for that session), so the person was told about a session they had never seen. The same for Codex sessions and for the daemon's own log lines. A machine whose start limit is 0 now says "this machine is set to start no new sessions (the start limit in its control config is 0)" instead of "already starting 0 new session(s); it starts at most 0 at once". A message rerouted at a Stop to a session whose transcript has gone is refused with that reason, not with a bare code. And two sessions that each have a copy are no longer taken for one session by `sessionpipe ask`'s loop rule, which refused an ask between them as a session asking itself.
