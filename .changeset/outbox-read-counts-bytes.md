---
"sessionpipe-core": patch
"sessionpipe": patch
---

outbox: a line that is not valid UTF-8 no longer costs a later event

`Outbox.read` counted each line's length from its decoded text. Bytes that are not UTF-8, such as the end of an append cut off inside a character with the next append joined onto it, decode to U+FFFD, which is three bytes and can stand for one to three bad bytes, so the offset it returned could run a few bytes past the line's end. The next read then started inside a line, which failed to parse and was skipped without a word: the drain, `sessionpipe tail` and the GUI's outbox source all missed that event. Lines are now found and counted in the bytes as read, so the offset is always the byte after the newline.
