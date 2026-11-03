---
"sessionpipe": patch
---

Control: a permission prompt in a turn the daemon itself runs (a session started or continued from a receiver, held through the Agent SDK or resumed headless) now waits for the owner's signed answer, as a terminal session's does. It used to skip that wait, so the receiver showed Allow and Deny, every Allow was refused `no_attention` ("that permission is no longer open"), and the turn sat on the prompt with the next message queued behind it. The Stop hook of such a turn still never asks: the daemon hands that session its next message itself.
