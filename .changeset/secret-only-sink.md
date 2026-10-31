---
"sessionpipe": patch
---

A sink added with `--secret` and no `--token` (it signs with Standard Webhooks and sends no bearer) sends again once its secret is in the macOS Keychain or the Secret Service, which `connect` does by itself on a Mac: the secret was stored, but reading it back gave up without a token, so every drain treated the sink as locked and its events waited for good, `sessionpipe secrets` said it couldn't be read, and `secrets move file` left it there. Each item the store holds is read now, so a sink an older release left stuck comes back the same way, and `secrets move file` brings it home. A sink with both items whose token item alone is gone sends signed and without a bearer, and the receiver's 401 pauses it (`doctor` says so) instead of its events waiting silently; a locked store still leaves them waiting. `sink add` with `--token` on such a sink keeps the secret its store holds, instead of dropping it.
