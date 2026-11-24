---
"sessionpipe": patch
---

A Codex session can ask another agent

- Codex runs a session's commands in a sandbox that closes the way to this computer's background service. `sessionpipe ask` from a Codex session then said that no service was running and told the model to have the person run `sessionpipe ask on`, which changed nothing. It now says the command was stopped on its way to the service, and what lets it through.
- `sessionpipe ask setup` writes the Codex rule that lets `sessionpipe ask <agent> "<task>"` out of the sandbox, and nothing else: `ask on`, `ask off` and `ask setup` stay the person's, a flag where the agent goes is refused, and a program that is only named `sessionpipe` is not taken for it. The rule is tried on the machine's own Codex first and written only where that Codex reads it as meant; `ask setup --remove` takes it out.
- `on`, `off`, `status` and `setup` are commands only as the first word after `ask`: `sessionpipe ask --yes on` and `sessionpipe ask --no-color on` are now usage errors.
- The answer as it grows is shown on stderr only to a person at a terminal, never to a session that asks. A harness hands its model the command's two streams as one text, and the model read the answer twice, run together.
