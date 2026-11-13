---
"sessionpipe": minor
"sessionpipe-core": minor
---

reinstall: one command that repairs the install, whatever state it is in

Computers end up with several copies of sessionpipe: one typed, another the background service was started from, a third in an npx cache whose folder is on some PATH. `update` makes one of them the one in use; nothing removed the rest, and a stale copy first on PATH in some shell started the drift again. And when an install was cut off half-way, there was no command to type at all.

`sessionpipe reinstall` leaves one clean copy of the newest release, in use everywhere, and removes the rest. It shows what it found (every copy, its version, what uses it) and what will happen, asks once at a terminal (`--yes` doesn't ask, `--dry-run` only looks, a pipe without `--yes` does nothing), then: fetches the release (nothing is touched before that works); installs it fresh where the copy you type lives, with what was there put back if the install fails; writes the hooks again and moves the background service onto it by `update`'s own rules; removes every other copy, the one it runs from last; and checks that the command runs, a shell finds one `sessionpipe`, and nothing names a removed copy. Pairings, settings, keys and the outbox are never touched. It does the whole job in the process that was started, so `npx -y sessionpipe@latest reinstall` is the way in when `sessionpipe` itself no longer runs; `doctor`, a failed `update` and the hooks' launcher now say that line.

It removes only what is provably a published sessionpipe (a real folder named `node_modules/sessionpipe` in a global npm folder or an npx cache entry, holding nothing a published package doesn't; npm's own `.sessionpipe-XXXXXXXX` leftovers; the link npm made), through one function. A checkout, a build, a linked folder, a project's dependency, Volta's copy and a file that only has the name are left and named; a copy that needs `sudo` is left with its one line. A copy in the npx cache that nothing uses is no reason to act and goes with the rest when there is one. A file that is not sessionpipe's in the place the fresh copy's link goes is a refusal before any step, with the line that moves it aside; something else named `sessionpipe` first on PATH is left, and the last line says what is still typed. It also repairs: a copy with no `dist`, a link that leads nowhere, hooks or a service file that name a node or a copy that is gone, a service that is not loaded or keeps crashing, a service file nothing needs, and a daemon started by hand that holds the socket a service needs.

`sessionpipe doctor` has a row for more than one copy (and for a copy that is not whole) and names `sessionpipe reinstall` as the one fix there; `doctor --json` gains `copies` and one warning string. Exit codes as `update`: 0, 3 (the service is still at work), 1 (one next command), 2.

`sessionpipe-core/service`: `serviceState` also answers the process the manager runs for the service (`pid`).
