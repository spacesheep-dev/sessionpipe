---
"sessionpipe-core": minor
"sessionpipe": minor
---

A control `prompt` can carry `files`, as a `start` can (CONTROL.md §3.1, §6 `prompt`), to a machine whose hello says `prompt_files: true`. The daemon fetches and checks them as for a start, writes them to `<cwd>/.sessionpipe/files/<session>/<nonce>/` (the command's signed nonce, never the receiver's unsigned message id), and appends the same "Attached files" block before the message is handed over in any mode: a resume, a fork, a held SDK session, an ACP agent (`api`), a waiter or a Stop. A file that fails is acked `failed` with code `file` and the message is not delivered. A receiver no longer needs to put a link to an image into the message's text.
