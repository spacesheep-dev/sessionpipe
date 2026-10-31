---
"sessionpipe-conformance": patch
---

`sessionpipe-conformance` runs a single fixture file as well as a folder, takes `HTTPS://` in any case, and says in one line which path it could not read (the target, or an entry under it) or that a folder holds no `.json` fixtures (exit 2), instead of a stack trace. A file that is not an adapter fixture (a control vector, a delivery or redaction fixture), is not JSON, or cannot be read is a failure row naming why, instead of "no adapter undefined" or a throw that ends the run.
