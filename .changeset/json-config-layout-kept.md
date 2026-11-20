---
"sessionpipe-core": patch
"sessionpipe": patch
---

Install and uninstall change only sessionpipe's entries in a JSON config's text (#205)

- A JSON config used to be written back whole, one item per line, so a list or object on one line came back spread over several. Now install puts only sessionpipe's entries into the file's text and uninstall takes only them out, on all seven JSON harnesses, Claude Code's status line and `pool on`/`off`: a file with lists on one line, tabs, CRLF or a byte-order mark comes back byte-identical. An empty `hooks` object or event list that sessionpipe's entries went into still goes with them, as before.
