---
"sessionpipe": patch
"sessionpipe-core": patch
---

Claude Code: a Read of a big picture reaches the board, and tool output carries no picture bytes

- The hook used to cut a payload over 1 MiB, and a 2560 px picture's base64 is 1–3 MB, so the Read never showed as finished and a held permission question after it could stay open. A tool's result over 1 MiB with a picture in it now goes without the picture's bytes.
- `tool.ended.output` for a picture Read is `{type: "image", media_type, original_size, dimensions}` at any size. A picture Read's base64, a PDF's bytes and an image part's data in a tool's content list are left out (`omitted_bytes`): they no longer sit in the outbox or go to a sink. `spec/ADAPTERS.md` has the mapping, and `conformance/harness/claude-code/post-tool-use-read-image.json` the recorded payload.
