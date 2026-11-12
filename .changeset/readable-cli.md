---
"sessionpipe": minor
"sessionpipe-core": minor
---

cli: output a person can read at a glance, and one place that says whether this computer is fine

`sessionpipe doctor` now starts with a verdict (`All good`, or how many things need attention), sets out what it looked at in groups of aligned rows, each with a mark and a word, and ends with **To fix**: one plain sentence and one command each, in the order to run them. It exits 1 when anything needs attention. `sessionpipe status` is the same in a few lines. `--json` keeps its shape on both.

Trouble that only the daemon's log knew is on that page: a disk that filled up, a key the service can't read from the keychain, a pool with no account left to try, a receiver that hasn't answered. Whether Claude Code is signed in is asked of the running service over its socket (a new, read-only `health` request), because a shell over ssh can't read a Mac's login keychain; before, doctor told people who were signed in to sign in again. A service that launchd or systemd doesn't have at all is said to be not loaded, where it used to read as offline.

`sessionpipe control status` is a page at a terminal, and exactly the JSON it always printed when piped or given `--json`. `--help` is one page of every command in groups, each with what it is for in a line that fits 80 columns; a command's own `--help` folds its usage between options. A command that fails prints `error` with what is wrong and `try` with the one command to run next.

Colour comes from one small module with no dependency: on at a terminal, off in a pipe, off with `--no-color`, `NO_COLOR` or `TERM=dumb`, on anywhere with `FORCE_COLOR`. Nothing is said by colour alone. Lines fold at the terminal's width under their own text, never inside a command; a pipe gets whole lines, as before. Nothing a program reads has changed: hook output, the worker, the status line, every `--json`, the daemon's log.

`sessionpipe-core/service` gains `serviceState`: whether launchd or systemd has a service now, without changing anything.
