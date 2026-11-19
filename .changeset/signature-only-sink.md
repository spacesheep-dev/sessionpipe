---
"sessionpipe": patch
---

A sink added with `--secret` and no `--token` signs each batch and sends no bearer, and the spec now says that is a valid sink: `spec/HTTP.md` §2 makes `authorization` OPTIONAL on a signed request, and a receiver that verifies the signature MAY accept it (`conformance/delivery/34-auth-signed.json`); one that does not answers 401 and the sink pauses, as before. `sessionpipe sink` now lists `--secret` in its usage line, as `sink add --help` did (#199).
