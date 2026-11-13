---
"sessionpipe": minor
"sessionpipe-core": minor
---

control: fx (Vercel Labs' coding agent) can be started and messaged like the other ACP agents

The daemon drives `fx acp` with the client it uses for every agent that speaks the Agent Client Protocol: `start`, then `prompt` and `cancel` in `api` mode, and a closed session reopened with `session/load`. Its harness name is `fx`. fx is not in the ACP registry, so the launch line is the one its own manual gives; `SESSIONPIPE_ACP_FX` names another binary. Opening a session asks fx for the MCP servers in the person's `~/.fx/mcp.json` (`_meta.fx.profileMcpServers`), which an ACP session of fx's otherwise leaves out. fx has no hooks, so an fx session reports no events: it is control only. Measured against fx 0.0.16.
