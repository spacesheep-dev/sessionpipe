---
"sessionpipe": patch
---

The control daemon retries pending events for every non-paused sink once a minute, including sinks whose token is in config.json. A session whose final delivery was refused no longer needs another hook event to reach its sink after the retry wait. The existing per-sink wait and machine-wide delivery lock still apply.
