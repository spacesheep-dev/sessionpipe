---
"sessionpipe-core": patch
"sessionpipe": patch
---

Nothing of a message's `id` reaches a session unless it is a whole ULID. The id is the receiver's and nobody signs it, and the last twelve characters of whatever it was went into the text a live session is handed, inside the header that says "signed on the sender's device". The mark is now made only from a 26-character ULID (`messageMark` in `sessionpipe-core/control` answers null for anything else, and `frameMarked` then frames the message without one). A message whose id is not a ULID is still delivered, as far as it can be without a mark: it is not handed to a session's `sessionpipe channel` and not written into its inbox, the two ways in whose only proof of delivery is the mark, so it runs as a resume or in a copy instead (a copy's ack says "it could not be reached in place: the receiver gave this message an id that is not a ULID, so the turn it would cause there could not be told from any other"); handed over at the session's Stop or to `sessionpipe wait`, it is acked `delivered` with no `reply` when the session's turn ends. Receivers that follow HTTP.md already send ULIDs and see no change.
