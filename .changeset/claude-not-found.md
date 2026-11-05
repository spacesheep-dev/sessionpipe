---
"sessionpipe": patch
"sessionpipe-core": patch
---

A `claude` installed under a node version manager is found by the daemon. launchd and systemd start the daemon with a bare PATH, so a Claude Code that `npm install -g` had put under nvm was never found; with no binary, its capabilities read as none, and a message to an open session was refused with "this Claude Code can't copy it (no --fork-session)" for a Claude Code that had the flag. The lookup now also checks nvm, fnm, volta and asdf (their default folders, or the ones NVM_DIR, FNM_DIR, VOLTA_HOME and ASDF_DATA_DIR name), newest node first. `sessionpipe connect` writes the pairing shell's PATH and the `claude` it found (as SESSIONPIPE_CLAUDE) into the service file, so the daemon sees what the person's shell saw. When no `claude` can be found at all, the daemon says "Claude Code not found on this computer" and what to do, in its log at start and in the failed ack, instead of blaming the flag.
