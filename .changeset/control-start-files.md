---
"sessionpipe-core": minor
---

Control: `sessionpipe-core/control` accepts `files` on a `start` (1–10 files, each `{name, type, size, sha256}`, 25 MiB each, 50 MiB together, names safe to write and unique ignoring case) and refuses them on any other kind, `null` or empty as `bad_fields`; new exports `filesProblem`, `ControlFile` and the limits. Schemas: `control-command` gains `files`, `control-pair` / `control-hello` / the well-known `control` object gain `files: true`. 24 new shared vectors (`66`–`89`).
