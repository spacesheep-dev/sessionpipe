---
"sessionpipe": minor
"sessionpipe-core": minor
---

update: one command leaves the whole computer current

`sessionpipe update` used to update only the copy it ran from and ask the daemon to restart "as soon as nothing is in hand". On a Mac with two copies (the one typed, and another the background service ran) the typed command stayed at an old version while everything looked updated; on a computer where some session is always working the restart never came, and people were told to type `launchctl kickstart`.

Now, when it ends well, the copy you type, the copy the background service runs and the hooks are one version, the newest; the service is running it and hearing from its receivers; and the last line says so. It installs npm's latest into this copy, writes the hooks again from it, makes the service run this copy (one that runs another copy, or that launchd or systemd no longer has, is replaced with the safe replace from 0.13.7; one that runs this copy restarts itself), and looks that it answers and is asking its receivers. When it can't get there it stops with one line that says what is wrong and one that says what to run next: `sessionpipe update` again when npm can't be reached (what needs no download is still done, and nothing is ever moved back to an older release), a `sudo npm install … && sessionpipe update` line for a prefix this user can't write, `npx sessionpipe@latest update` for a copy npm didn't install. Exit 0 means everything is current, 3 that the service finishes by itself, 1 that it stopped.

A restart is now held back only by what the daemon itself holds: a turn it runs, a message in hand, a permission prompt it holds for an answer, a pooled request being answered. A session someone is working in, mid-turn in its own window, no longer holds it back: that it is mid-turn is written to the daemon's state at a stop and read back at the next start, so a message to it still waits for its Stop. `update` gives the daemon 25 seconds to finish what it holds; past that it says the service restarts by itself when that is done, and there is nothing more to type.

The daemon's own daily update takes the same steps (`installEverywhere`): its own copy, the `sessionpipe` on its PATH when that is another install (the copy a person types), the hooks, then its restart. `sessionpipe doctor` sees a split between the three, says which, and names `sessionpipe update` as the one fix; it no longer sends anyone to `sessionpipe install` from an older copy, which was refused or, forced, put the hooks back.

Also: the registry asked for `latest` is the one `npm_config_registry` names, when it names one, since that is where npm installs from. A sessionpipe pointed away from this computer's own files (`SESSIONPIPE_STATE` or `SESSIONPIPE_CONFIG`: a test, a throwaway world) never looks at, replaces or stops this computer's real service; `SESSIONPIPE_SERVICE_LABEL` gives such a world a service of its own. `sessionpipe-core/service`'s `serviceState` also answers the program a service file names (`serviceArgv`).
