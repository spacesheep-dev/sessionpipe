---
"sessionpipe": patch
---

The pool no longer loses its accounts' sign-ins to a secrets store that cannot be written

- Refreshing a pooled account's token replaces its sign-in: the old one is dead once it is used. When the secrets store refused the new one (a keychain that is locked), the pool kept it in memory only, and the daemon's next start found the old one, already used up: the account needed signing in again. On one laptop three accounts were refreshed that way in one night, and all three were signed out after the daemon's next start.
- No refresh is made now while the store cannot be reached, unless a request is waiting on a token that no longer works. The idle usage poll, which nobody waits on, never refreshes then, and a token with minutes left is used as it is. Whether a keychain can be reached is asked with one read of the account's own item, and after a refusal no sooner than 30 s, 60 s, then every five minutes: a locked keychain keeps its tool, and the daemon with it, waiting eight seconds for each answer.
- A sign-in that did have to be refreshed while the store refused the write is offered to it again: by the next request, by the idle poll while the pool runs, and once more when the daemon stops; the log says when it is in. While the pool runs and such a sign-in is less than a day old, the daemon does not restart by itself for an update. `sessionpipe pool` says how many are waiting, and a stop that still cannot write one says which command signs the account in again.
- A token refreshed for an account that was removed, or signed in afresh, while the vendor was being asked is no longer kept.
