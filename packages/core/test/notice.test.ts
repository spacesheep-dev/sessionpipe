// SPDX-License-Identifier: Apache-2.0
// A notice, read (CONTROL.md §14): the closed shape from the generated definition, the checks a
// schema can't say, the poll's cap, and an ack that can only say what it may.
import { describe, expect, it } from "vitest";
import { SCHEMAS, validate } from "../src/schema/index.js";
import {
  NOTICE_MAX_BYTES,
  NOTICE_MAX_LIFE_MS,
  NOTICE_SEEN_MS,
  NOTICES_PER_POLL,
  noticeAck,
  noticeId,
  noticesIn,
  parseNotice,
} from "../src/triggers/notice.js";

const ID = "01KB4M2Q8V3T6Y9C0D1E2F3G4H";
const AT = Date.parse("2026-11-24T09:14:02.000Z");
const NOTICE = {
  id: ID,
  topic: "acme/tasks",
  event: "record.updated",
  subject: "X-001",
  state: "todo",
  for: "studio-claude",
  by: "u-41c9",
  at: "2026-11-24T09:14:02.000Z",
  expires_at: "2026-11-25T09:14:02.000Z",
};
const now = AT + 60_000;
const with_ = (o: Record<string, unknown>) => ({ ...NOTICE, ...o });

describe("parseNotice (CONTROL.md §14)", () => {
  it("takes the closed set of short typed fields, and the optional ones may be left out", () => {
    expect(parseNotice(NOTICE, now)).toEqual({ ok: true, notice: NOTICE });
    const { state: _s, for: _f, by: _b, ...bare } = NOTICE;
    expect(parseNotice(bare, now)).toEqual({ ok: true, notice: bare });
    expect(validate("control-notice", NOTICE)).toEqual([]);
  });
  it("drops a notice with any member it doesn't name, and says its id so it can be acked", () => {
    for (const extra of ["session", "words", "text", "folder", "cwd", "level", "permission", "tools", "cmd", "x"]) {
      const r = parseNotice(with_({ [extra]: "anything" }), now);
      expect(r, extra).toMatchObject({ ok: false, code: "bad_notice", id: ID });
    }
  });
  it("drops a notice with a broken member, each against the definition's own pattern", () => {
    const broken: Record<string, unknown>[] = [
      { topic: "Acme/Tasks" },
      { topic: "/acme" },
      { topic: `a${"b".repeat(80)}` },
      { event: "Record.updated" },
      { event: "1record" },
      { event: `e${"v".repeat(40)}` },
      { subject: "-X" },
      { subject: "X 001" },
      { subject: "X`001" },
      { subject: "X\n001" },
      { subject: `X${"0".repeat(40)}` },
      { state: "TODO" },
      { state: "" },
      { state: "s".repeat(33) },
      { for: "studio claude" },
      { by: "u.41" },
      { at: "2026-11-24T09:14:02Z" },
      { expires_at: "tomorrow" },
      { subject: 1 },
      { state: null },
    ];
    for (const b of broken)
      expect(parseNotice(with_(b), now), JSON.stringify(b)).toMatchObject({ code: "bad_notice", id: ID });
    for (const k of ["topic", "event", "subject", "at", "expires_at"]) {
      const { [k as keyof typeof NOTICE]: _, ...missing } = NOTICE;
      expect(parseNotice(missing, now), k).toMatchObject({ ok: false, code: "bad_notice", id: ID });
    }
  });
  it("a notice whose id can't be read is refused with nothing to ack", () => {
    const { id: _, ...noId } = NOTICE;
    expect(parseNotice(noId, now)).toMatchObject({ ok: false, code: "bad_notice", id: null });
    expect(parseNotice(with_({ id: "01kb4m2q8v3t6y9c0d1e2f3g4h" }), now)).toMatchObject({ id: null });
    expect(parseNotice(with_({ id: 7 }), now)).toMatchObject({ id: null });
    for (const raw of [null, undefined, "notice", 3, [NOTICE], () => NOTICE])
      expect(parseNotice(raw, now)).toMatchObject({ ok: false, code: "bad_notice", id: null });
    expect(noticeId(NOTICE)).toBe(ID);
    expect(noticeId([ID])).toBeNull();
    expect(noticeId(null)).toBeNull();
  });
  it("more than 1 KiB is refused before any pattern is tried, and so is what isn't JSON", () => {
    const big = with_({ pad: "x".repeat(NOTICE_MAX_BYTES) });
    expect(parseNotice(big, now)).toEqual({
      ok: false,
      code: "bad_notice",
      id: ID,
      why: "a notice is at most 1024 bytes",
    });
    expect(parseNotice(with_({ at: 1n }), now)).toMatchObject({
      code: "bad_notice",
      why: "a notice is at most 1024 bytes",
    });
    // A notice that fits its shape can never reach the cap: the widest one is under half of it.
    const widest = with_({
      topic: `a${"b".repeat(79)}`,
      event: `e${"v".repeat(39)}`,
      subject: `X${"0".repeat(39)}`,
      state: "s".repeat(32),
      for: `F${"f".repeat(39)}`,
      by: `B${"b".repeat(39)}`,
    });
    expect(parseNotice(widest, now).ok).toBe(true);
    expect(JSON.stringify(widest).length).toBeLessThan(NOTICE_MAX_BYTES / 2);
  });
  it("the times: after it was made, at most a day of life, not from the future, and not yet expired", () => {
    expect(parseNotice(with_({ expires_at: NOTICE.at }), now)).toMatchObject({
      code: "bad_notice",
      why: "a notice expires after it was made",
    });
    const day = new Date(AT + NOTICE_MAX_LIFE_MS).toISOString();
    expect(parseNotice(with_({ expires_at: day }), now).ok).toBe(true);
    const longer = new Date(AT + NOTICE_MAX_LIFE_MS + 1).toISOString();
    expect(parseNotice(with_({ expires_at: longer }), now)).toMatchObject({ why: "a notice lives at most 24 hours" });
    // Five minutes of clock slack between the receiver and the machine, no more.
    expect(parseNotice(NOTICE, AT - 5 * 60_000).ok).toBe(true);
    expect(parseNotice(NOTICE, AT - 5 * 60_000 - 1)).toMatchObject({
      code: "bad_notice",
      why: "a notice made more than 5 minutes ahead of this machine's clock",
    });
    const until = Date.parse(NOTICE.expires_at);
    expect(parseNotice(NOTICE, until - 1).ok).toBe(true);
    expect(parseNotice(NOTICE, until)).toEqual({ ok: false, code: "expired", id: ID, why: "the notice expired" });
    expect(NOTICE_SEEN_MS).toBeGreaterThan(NOTICE_MAX_LIFE_MS + 5 * 60_000);
  });
  it("the RFC's example wrote its times without milliseconds: the protocol's date-time has them", () => {
    expect(parseNotice(with_({ at: "2026-11-24T09:14:02Z", expires_at: "2026-11-25T09:14:02Z" }), now)).toMatchObject({
      code: "bad_notice",
    });
  });
});

describe("noticesIn: at most 50 a poll", () => {
  it("takes the first 50 in the receiver's order and counts the rest, which wait for the next poll", () => {
    const list = Array.from({ length: 60 }, (_, i) => ({ n: i }));
    const r = noticesIn({ messages: [], notices: list });
    expect(r.notices).toHaveLength(NOTICES_PER_POLL);
    expect(r.notices[49]).toEqual({ n: 49 });
    expect(r.left).toBe(10);
    expect(noticesIn({ notices: list.slice(0, 3) })).toEqual({ notices: list.slice(0, 3), left: 0 });
  });
  it("a poll with no list, or one that isn't, has none: messages are never in the way of notices or the other way", () => {
    for (const poll of [{ messages: [] }, { notices: "x" }, { notices: { a: 1 } }, null, "poll", 1])
      expect(noticesIn(poll)).toEqual({ notices: [], left: 0 });
  });
  it("the poll's schema says the same cap", () => {
    expect(SCHEMAS["control-poll"].properties.notices.maxItems).toBe(NOTICES_PER_POLL);
    expect(validate("control-poll", { messages: [], notices: [NOTICE] })).toEqual([]);
    expect(validate("control-poll", { messages: [] })).toEqual([]);
  });
});

describe("noticeAck: the outcome, the session only when it ran, the code only when refused", () => {
  it("fits control-notice-ack.json, and names no rule", () => {
    const t = AT + 1000;
    const acks = [
      noticeAck(ID, { outcome: "ran", session: "claude-code:8c132906-8c3f-4814-870a-afc3d05e1d2e" }, t),
      noticeAck(ID, { outcome: "refused", code: "cooldown" }, t),
      noticeAck(ID, { outcome: "no_match" }, t),
      noticeAck(ID, { outcome: "taken" }, t),
    ];
    expect(acks[0]).toEqual({
      id: ID,
      outcome: "ran",
      session: "claude-code:8c132906-8c3f-4814-870a-afc3d05e1d2e",
      at: "2026-11-24T09:14:03.000Z",
    });
    expect(acks[1]).toEqual({ id: ID, outcome: "refused", code: "cooldown", at: "2026-11-24T09:14:03.000Z" });
    expect(acks[2]).toEqual({ id: ID, outcome: "no_match", at: "2026-11-24T09:14:03.000Z" });
    expect(validate("control-notice-ack", { acks })).toEqual([]);
    expect(validate("control-notice-ack", { acks: [] })).not.toEqual([]);
  });
});
