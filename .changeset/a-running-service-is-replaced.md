---
"sessionpipe-core": patch
"sessionpipe": patch
---

Pairing a Mac again no longer leaves it with no daemon. Installing the service over one that is running (`sessionpipe control pair` on a machine that is already paired, `sessionpipe ask on`, `sessionpipe pool on`) booted the old one out and bootstrapped the new one at once; launchd answers a bootout before the old process has exited and refuses a bootstrap until it has, so the daemon was stopped and nothing started it again: the machine read offline until someone ran `launchctl bootstrap` by hand. The install now waits for launchd to let go of the old service (up to 10 s) and then starts the new one, and when launchd still refuses, the error says the command that starts it. On a Mac this happened to, pair again or run `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/org.sessionpipe.control.plist`.
