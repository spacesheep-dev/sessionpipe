---
"sessionpipe": patch
"sessionpipe-core": patch
---

control: fx asks on a safe machine

fx's own default permission mode (`auto`) edits files and runs the commands it recognises without asking, so an fx session started from a phone on a safe machine did both without anyone approving them: the daemon refuses what an agent asks, and fx asked nothing. fx's process is now given its mode for the machine's, for that run only and never saved (`FX_PERMISSION_MODE`): `ask` on a safe machine, so every call that needs approval reaches the daemon and is refused and named in the reply; `auto` on an auto machine; nothing on an inherit machine, where the person's own fx setting decides. Measured against fx 0.0.16: before, a write and a shell command ran on a safe machine; after, the write was refused. `conformance/control-acp-mode-env.json` holds the table.

And for every agent driven over ACP: a held agent runs, and has its permission requests answered, in the mode it was opened in, so when the machine's mode changes (`sessionpipe control mode`) in a way that would run it otherwise, the daemon now lets go of it, at once when idle and else when its turn ends, and the next message reopens the session (`session/load`) in the new mode. An agent opened while the mode changed is let go of after its first turn. Before, a held agent kept the old mode for as long as messages kept it in use. Safe and inherit are answered alike, so a change between them lets go only of an agent given a word of its own for either (fx).
