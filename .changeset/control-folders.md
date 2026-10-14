---
"sessionpipe": minor
---

`sessionpipe control folders [add|remove <dir>…]`: change the folders that sessions you message may run in, at the machine, without pairing again. Before this, the folders were set only by `control pair --folder`. On 2026-10-13 a Kimi session in `~/claude-kimi` on a machine paired with `~/claude` was refused ("that session's folder isn't one this machine allows"), and the only fix was a new pairing, with its passkey approval. A folder to add must exist and can't be the home folder or above it (pair's rule). The running daemon picks up the new list within seconds, and when the folders or the mode change it sends a hello at once, so the receiver's folder picker doesn't wait up to ten minutes for the next one.
