---
"sessionpipe-core": patch
"sessionpipe": patch
---

When the daemon can't read a Claude Code's options, the refusal says why in the command's own words: `claude --help` failed: env: node: No such file or directory (the first line it wrote to stderr), "no such file", "the file can't be run (permission denied)", or its exit code. It used to say only "failed", which gave the person who sent the message nothing to act on. The line is one line of at most 200 characters, with the home folder written `~` and anything shaped like a secret removed.
