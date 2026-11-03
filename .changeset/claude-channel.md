---
"sessionpipe": minor
"sessionpipe-core": patch
---

`sessionpipe channel`: a Claude Code channel, so a message reaches a live session in its own thread. Claude Code runs it as one session's MCP server (`claude mcp add --scope user sessionpipe -- sessionpipe channel`, then `claude --dangerously-load-development-channels server:sessionpipe` while channels are a research preview). It parks on the daemon's local socket as that session's waiter for as long as the session runs, and pushes each message in as a `notifications/claude/channel`: the session takes it in its own permission mode, as the person's own words, and shows it as a message from `sessionpipe` in the terminal and in the Claude app. The daemon routes to it as a waiter while the session is idle and reads the answer back from the transcript. The transcript reader now keeps a channel's message (`origin.kind: "channel"`, wrapped in `<channel source="…">`) as its turn's ask: a turn asked through a channel, Telegram's included, used to reach a receiver with nothing asked.
