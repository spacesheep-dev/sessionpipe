---
"sessionpipe": patch
"sessionpipe-core": patch
---

A turn that was stopped no longer reads as answered with "No response requested."

When a Claude Code session is resumed after its last turn was ended mid-way (a Stop sent
through `sessionpipe control`, a killed process, a crash), Claude Code writes "No response
requested." into the transcript as the assistant's, under its own `<synthetic>` model.
sessionpipe sent that on as what the agent had said, so a receiver drew a stopped turn as
answered with those words. It is now read as the end of a turn that was stopped, the way
`[Request interrupted by user]` is: the turn goes out with what it had really said, which
may be nothing. Claude Code's other synthetic rows, such as an API error, are still the
turn's reply.
