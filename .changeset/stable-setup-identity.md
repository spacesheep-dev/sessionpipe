---
"sessionpipe": patch
---

Refuse connect/install downgrades of newer global packages or persistent hook copies,
including newer prereleases, unless --allow-downgrade is explicit. Preserve the
configured machine name when --machine differs; require --rename-machine for an
unpaired rename and refuse names that would split sessions from a configured daemon.
