---
"sessionpipe": patch
"sessionpipe-core": patch
---

Control: a picture sent with a message reaches Codex, an ACP agent and an Agent SDK session as a picture, not only as a path

- The daemon still saves every file in the session's folder and lists it in the text. A harness that has its own way to take a picture now gets the pictures that way too, in the same run: Codex as `--image <path>` on `codex exec` and `codex exec resume`, an ACP agent that says `promptCapabilities.image` as `image` blocks after the text, and a Claude Code session held through the Agent SDK as `image` blocks before the words. `claude -p` and Antigravity get the list, as before: Claude Code opens the pictures itself, and `agy` has no way to take one.
- A file is a picture when its type is PNG, JPEG, GIF or WebP and its bytes are that format with a width and height in their header; a PDF, or a file that only says it is a PNG, is listed and nothing more. Each harness gets only what it takes: Codex a still picture of up to 30 000 patches whose path has no comma (Codex splits `--image` on commas); an ACP agent and the Agent SDK up to 3 750 000 bytes and 3000 px a side each, and in one message pictures while their base64 stays within 10 000 000 characters. A picture gone or changed before it is handed over is left out. The daemon's log says, for each run with pictures, how many went natively and how many stayed in the list.
- A native way refused before the harness has done anything never fails a message the text alone would have delivered: a Codex older than `--image` is run again at once without it, and an ACP agent that refuses the pictures before writing, running or asking anything is sent the text alone. With no pictures, every harness gets exactly what it got before.
- Codex's title and transcript text for a session given a picture are the person's words: the `<image name=[Image #1] path="…">` and `</image>` lines Codex writes around a picture are left out.
- `spec/CONTROL.md` §6 has the rule (*Pictures*), `spec/ADAPTERS.md` each harness's way and limits, `conformance/control-pictures.json` the cases, and `conformance/transcripts/codex/picture-attached.jsonl` a rollout recorded on Codex 0.171.0.
