---
"sessionpipe": patch
"sessionpipe-core": patch
---

A `safe` run says why a folder's own allow rule did nothing

- Claude Code leaves out the allow rules in a folder's `.claude/settings.json` and `.claude/settings.local.json` until a person has trusted that folder in Claude Code, and says so only on its error output. A session asked or started at `safe` in such a folder was denied what the folder allows, and its reply did not say why. When a turn was denied something, its reply now says that Claude Code left those rules out, and why, in sessionpipe's own fixed words: nothing of Claude Code's error output is copied into a reply. It never tells anyone to trust a folder, and sessionpipe never trusts one for anyone.
- A session started through the Agent SDK now names what it was denied after its reply, as a `claude -p` run always has.
- A reply too long for its acknowledgement is cut before that note, never through it and never through a character, so what was denied is still named, and a reply is never longer than the 20 000 characters an acknowledgement may carry, however long the note.
- A note about what was denied names at most 20 actions, then says how many more there were.
- The Agent SDK is told which settings files a session reads (the person's own, then the folder's, as `claude -p` reads them) only when it is release 0.2.89 or later, whose own default already reads those three: nothing is read that was not read before. Releases before 0.2.89, and an SDK whose version can't be read, are told nothing, as before, and their sessions still read no settings files at all, so they get neither the folder's allow rules nor the hooks in the person's own settings. The daemon's log says so when it finds such an SDK.
