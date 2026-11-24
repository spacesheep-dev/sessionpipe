---
"sessionpipe": patch
---

Allow or Deny for a Codex permission prompt says plainly that it is answered in Codex

- sessionpipe reports a Codex permission prompt but does not answer it: Codex asks its hooks before it shows its own prompt and waits for them, so a hook that waited for an answer from another device would keep the prompt from the person at the keyboard. An Allow sent for a Codex session used to come back as "no permission prompt open for that id" and a Deny as expired; both now say that a Codex prompt is answered in Codex itself.
