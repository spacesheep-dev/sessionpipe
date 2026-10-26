---
"sessionpipe-core": minor
"sessionpipe": minor
---

Control can start, prompt and cancel any agent that speaks the Agent Client Protocol (CONTROL.md §6, `api` mode; ADAPTERS.md "Agents driven through ACP"). The daemon runs the agent's own CLI as a child on the launch line the ACP registry publishes (Gemini CLI, OpenCode, goose, Copilot CLI, Cursor, Droid, Devin, Kilo, Qwen Code, Cline and twenty more, 2026-10-22), is its JSON-RPC client, keeps the process for the next message, cancels with `session/cancel`, reopens an idle session with `session/load` where the agent can, and answers its permission requests from the machine's mode (safe refuses and the reply says what; auto allows). Only an agent already installed is ever run (on PATH, or where `SESSIONPIPE_ACP_<HARNESS>` points); the hello advertises the ones found. The pairing request and every hello list at most 20 harnesses, the schema's limit (Claude Code, Codex and Antigravity first, then the agents in the registry's order), and their `modes` include `api` whenever an ACP agent is listed.
