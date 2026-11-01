---
"sessionpipe": minor
"sessionpipe-core": minor
---

A machine running workflows with hundreds of parallel subagents no longer runs a receiver out of requests (#208). A receiver is now sent a subagent's tool calls at most one per session per minute, the main thread's as they happen, and at most one request a second from the machine, carrying everything that piled up meanwhile. Turns, prompts, permission questions, subagents and file changes are never thinned, and the local outbox still keeps every event. `sessionpipe sink add … --tools all|main|beat` picks what a sink is sent: `main` is the default for an HTTPS receiver, `all` (every tool call, as before) for a file or stdout sink, `beat` thins the main thread too. `sink list`, `status` and `doctor` show each sink's setting. In a simulated workflow of 100 subagents making 30 tool calls each over three minutes (6,214 events), the receiver got 6,214 requests before, 217 with the one-a-second pace alone, and 76 with the default.
