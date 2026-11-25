---
"sessionpipe": minor
"sessionpipe-core": minor
---

The notice a receiver sends for a trigger, defined

- The protocol defines a notice (`control-notice.json`): a receiver's unsigned word that something changed on a topic the machine listed, as a closed set of short typed fields with no session, words, folder, level or tool. It travels in a new `notices` list beside `messages` in a poll answer, at most 50 at a time, and is acked at `POST {control}/notices/ack` (`control-notice-ack.json`) with its outcome alone: what ran is never said.
- A machine's hello can carry `triggers`: whether triggers are on and the topics a receiver may send notices on. A receiver's well-known file can say `control.notices`.
- `sessionpipe-core` exports `parseNotice`, `noticesIn` and `noticeAck`, which read a notice against the generated definition and build its ack. Nothing runs on a notice yet.
