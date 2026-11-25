// SPDX-License-Identifier: Apache-2.0
// A notice, read (spec/CONTROL.md §14): the receiver's unsigned word that something changed on
// a topic the machine listed. It is checked against the generated definition
// (schemas/v1/control-notice.json, from control.proto) and then for the few things a schema
// cannot say. Nothing here matches a notice against a rule, and nothing here runs: "a receiver
// decides whether to send. Only the machine decides whether to run" (CONTROL.md §1).
import { SCHEMAS } from "../../gen/schemas.js";
import type { ControlNotice, NoticeAck, TriggerRefusal } from "../../gen/v1.js";
import { SKEW_MS } from "../control/verify.js";
import { problems } from "../schema/validate.js";
import { visible } from "./text.js";

/** A notice is at most this many bytes, as JSON in UTF-8. */
export const NOTICE_MAX_BYTES = 1024;
/** A poll answer carries at most this many notices (control.proto `ControlPoll.notices`); a
 *  machine leaves the rest for the next poll. */
export const NOTICES_PER_POLL: number = SCHEMAS["control-poll"].properties.notices.maxItems;
/** A notice lives at most this long: `expires_at` at most a day after `at`. */
export const NOTICE_MAX_LIFE_MS = 24 * 3600_000;
/** How long a machine remembers a notice's id: longer than its longest life plus the clock slack. */
export const NOTICE_SEEN_MS = 25 * 3600_000;

const SCHEMA = SCHEMAS["control-notice"];
/** The id's pattern, read from the definition, so the readable-id rule is the schema's own. */
const ID_RE = new RegExp(SCHEMA.properties.id.pattern);

/** What a machine makes of one notice. A refusal says whether its id could be read: one that
 *  can is acked (so the receiver stops sending it), one that can't has nothing to ack. */
export type NoticeReading =
  | { ok: true; notice: ControlNotice }
  | { ok: false; code: "bad_notice" | "expired"; id: string | null; why: string };

/** The notice's id when it is one, whatever else is wrong with it; null when it can't be read. */
export function noticeId(raw: unknown): string | null {
  const id = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { id?: unknown }).id : undefined;
  return typeof id === "string" && ID_RE.test(id) ? id : null;
}

/** The size of a value as JSON in UTF-8 bytes, serialised with no whitespace (the notice as
 *  received, parsed and written again: CONTROL.md §14.2); Infinity when it is not JSON at all. */
function jsonBytes(raw: unknown): number {
  try {
    const text = JSON.stringify(raw);
    return text === undefined ? Number.POSITIVE_INFINITY : new TextEncoder().encode(text).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Read one notice from a poll answer at `now` (epoch ms): the typed notice, or why it is
 *  refused. Principle 3 (CONTROL.md §1): "a machine MUST NOT run anything on the strength of"
 *  a bearer token, so a notice is the closed set of short typed fields and nothing else; any
 *  other member, or a broken one, drops it (`bad_notice`). */
export function parseNotice(raw: unknown, now: number): NoticeReading {
  const id = noticeId(raw);
  const bad = (why: string): NoticeReading => ({ ok: false, code: "bad_notice", id, why });
  // The size first, so nothing larger than a notice is matched against a pattern.
  if (jsonBytes(raw) > NOTICE_MAX_BYTES) return bad(`a notice is at most ${NOTICE_MAX_BYTES} bytes`);
  const shape = problems(SCHEMA, raw);
  // A value the receiver sent may be quoted in the reason: shown as it is, nothing hidden.
  if (shape.length) return bad(visible(shape[0]!));
  const n = raw as ControlNotice;
  const at = Date.parse(n.at);
  const until = Date.parse(n.expires_at);
  if (until <= at) return bad("a notice expires after it was made");
  if (until - at > NOTICE_MAX_LIFE_MS) return bad("a notice lives at most 24 hours");
  if (at > now + SKEW_MS) return bad("a notice made more than 5 minutes ahead of this machine's clock");
  if (now >= until) return { ok: false, code: "expired", id, why: "the notice expired" };
  return { ok: true, notice: n };
}

/** The notices of one poll answer, at most NOTICES_PER_POLL in the receiver's order, each
 *  still to be read on its own; `left` counts the ones past the cap, which wait for the next
 *  poll. A poll with no `notices` list (a receiver that sends none) has none. */
export function noticesIn(poll: unknown): { notices: unknown[]; left: number } {
  const list = poll && typeof poll === "object" ? (poll as { notices?: unknown }).notices : undefined;
  if (!Array.isArray(list)) return { notices: [], left: 0 };
  return { notices: list.slice(0, NOTICES_PER_POLL), left: Math.max(0, list.length - NOTICES_PER_POLL) };
}

/** What a notice's ack says, closed so that `session` comes only with `ran` and `code` only
 *  with `refused`, as CONTROL.md §14 asks. Never the rule, its words, level or filter. */
export type NoticeResult =
  | { outcome: "ran"; session: string }
  | { outcome: "refused"; code: TriggerRefusal }
  | { outcome: "taken" | "no_match" | "duplicate" | "expired" | "failed" };

/** One notice's ack, at `now` (epoch ms). */
export function noticeAck(id: string, result: NoticeResult, now: number): NoticeAck {
  return { id, ...result, at: new Date(now).toISOString() };
}
