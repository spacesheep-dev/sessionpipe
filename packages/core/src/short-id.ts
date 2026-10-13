// SPDX-License-Identifier: Apache-2.0
// A session's short id (spec/PROTOCOL.md §3): the first 8 hex digits of
// sha256("sessionpipe.session:" + harness + ":" + id). What a person reads in a log
// line, a notification, a search box; derived, never sent. Not a prefix of the id
// itself: Codex ids are time-ordered (UUIDv7), and two sessions started in the same
// minute share their first eight characters.
import { createHash } from "node:crypto";

export function shortId(harness: string, id: string): string {
  return createHash("sha256").update(`sessionpipe.session:${harness}:${id}`).digest("hex").slice(0, 8);
}
