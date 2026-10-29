---
"sessionpipe-core": patch
"sessionpipe": patch
---

Control: a `claude --help` that couldn't be read is never taken for a Claude Code with no permission modes (#152). `detectCaps` marks a run that times out, or fails without listing `--permission-mode`, as `unread` (and takes a timeout, 30 s by default); `modeFlags` then refuses every level but `inherit`, saying why ("this machine couldn't read its Claude Code's options (`claude --help` timed out after 30 s); try again in a minute"), where it used to refuse `auto` as a mode that Claude Code lacks and to run `safe` with no permission flag at all. The daemon asks an unread `--help` again a minute later, and logs each one, instead of keeping it until a restart. A daemon that started 82 s after a Mac's reboot, beside 28 other Claude Code processes, kept such a read for 8 h 12 min, and refused the message sent in that time.

While that `--help` is unread, the hello offers no Claude Code start at all (an offered `safe` was taken, and then run with no permission flag), and a start is refused before it is taken, never run with an empty argv.
