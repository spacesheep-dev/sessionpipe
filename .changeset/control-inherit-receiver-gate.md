---
"sessionpipe": minor
"sessionpipe-core": minor
---

Control: a machine runs in `inherit` mode only with receivers that know it. A receiver that predates `inherit` shows such a machine as safe, while its sessions run with no permission flag. A receiver now says it shows the mode as what it is with `control.inherit: true` in its well-known file (HTTP.md §1, CONTROL.md §2), and `sessionpipe control pair --mode inherit` (and `connect --mode inherit`) refuses, before anything is sent, a receiver that doesn't: "… doesn't know inherit mode yet; it would show this machine as safe while the sessions you message run with no permission flag". `sessionpipe control mode inherit` checks every paired receiver the same way and keeps the mode it had when one doesn't know it, or can't be read. Schema: `well-known` `control.inherit` (optional boolean). Conformance: `delivery/23-control-inherit`.
