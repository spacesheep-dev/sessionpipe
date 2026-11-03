---
"sessionpipe": patch
"sessionpipe-core": patch
---

In-place delivery with the inbox and the channel together (#159). A channel takes a message only while its session is idle: Claude Code folds a channel message that arrives during a turn into that turn, where the model need not answer it, so a running turn takes the message at its Stop. A channel's delivery is proven the way an inbox write is, by the turn the session begins for it; one the session began no turn for is acked `failed` with code `held`, and that channel is handed nothing more, since Claude Code drops a channel's messages in silence where it didn't register the channel. `sessionpipe channel` no longer parks in a `--print` or Agent SDK session, which ignore the channel flags (the Claude app's sessions run so). An answer the model thought about first comes back whole: the reader took the thinking record that ends such a turn (`stop_reason: end_turn`, no text) for the end of the answer, and acked it with no reply. A channel's ask is marked `injected`, as a peer's is.
