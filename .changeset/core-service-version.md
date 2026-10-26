---
"sessionpipe-core": minor
"sessionpipe": patch
---

Two Node-only subpaths in `sessionpipe-core`, so a receiver of the person's own (a board on their machine) runs as a service with the daemon's code rather than a copy of it. `sessionpipe-core/service`: the launchd agent and the systemd user unit for any process (`serviceFiles`, `installService` and `uninstallService`, each with a dry run that answers the files and commands and touches nothing, and `ensureLinger`). `sessionpipe-core/version`: `compareVersions`, `isNewer`, `parseVersion`, `UPDATE_EXIT` and `supervise`, the parent that restarts a process onto new code where no service manager will. The root export is unchanged and still runs in a Worker and a browser. The control daemon now uses both; its service is the same, except that the unit's `ExecStart` quotes every argument.
