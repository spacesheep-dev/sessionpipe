---
"sessionpipe": patch
---

A Codex session says which account it ran under

- A Codex session's events now carry `account_id` where Codex records one: the ChatGPT account the thread was created under and the person in it, as Codex writes them into the session's file. A session on an API key or another provider still has none.
- The usage limits a Codex turn leaves are stamped with the account that Codex was signed in to when it started, so a thread picked up again after signing in to another account does not file its numbers under the account that made it.
- The background service's hello names the machine's Codex account beside the Claude Code ones, with its email as the label, for a receiver the person paired with. It comes from Codex's own sign-in file: the account, the person's id and the email are used, never the tokens.
