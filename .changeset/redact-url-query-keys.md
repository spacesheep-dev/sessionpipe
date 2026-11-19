---
"sessionpipe-core": patch
---

secrets@1: a link reaches a sink without the key in its query

- In a URL's query, the value of `k`, `key`, `sig`, `signature`, `X-Amz-Signature` or `X-Goog-Signature` (any case, 16 characters or more) is replaced, so a board's picture link, a spacesheep signed link or a pre-signed storage link arrives as `…?e=1795139368424&k=[redacted]`. The name, the other parameters and the rest of the URL stay; a short value (`?page=2&k=short`) stays. A `?token=` or `&api_key=` was already an assignment's, and still is.
- A `k` or `key` value that reads as words stays, as a search or a docs link carries it (`?k=wireless+bluetooth+headphones`, `?key=top-10-dashboards-2026.`): without the punctuation at its end, split on `+`, `-`, `_`, `.` and `%20`, every piece is lowercase letters, one capital then lowercase letters, or one to four digits. A hex or base64 key, a UUID or a long number still goes.
- The link is read after the other rules, so a link that is a secret's whole value goes whole (`API_KEY=[redacted]`). `spec/PRIVACY.md` §2 has the row, and `conformance/redaction/secrets.json` the cases.
