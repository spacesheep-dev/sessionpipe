---
"sessionpipe-core": patch
"sessionpipe": patch
---

pii@1 keeps an ISO date: `released 2026-10-31` stays as written instead of becoming `released [phone]`, and `2026-10-31 12:00` no longer becomes `[phone]:00`. A date (years 1900–2099, month 01–12, day 01–31) is kept only when nothing after it could carry the run on: no letter or digit, and no separator then two digits (a phone's group; `2026-10-31 5 files` keeps its date) unless that is a time's hour (` 12:00`, 00–23), and not right after a `)` or a `+` with a country code. A date after a `+` (a diff's added line) is kept too. A date that a phone's digit group follows directly, as in `2026-10-31 415-555-0132` or `2026-10-31 0132:`, is read as before (a `(`, `+` or `,` between them starts a new number, and the date stays).
