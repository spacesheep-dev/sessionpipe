// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Cursors, Outbox, takeLock } from "../src/outbox.js";
import type { Event } from "../src/types.js";
import { isUlid, ulid } from "../src/ulid.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "sp-outbox-"));
afterEach(() => rmSync(tmp, { recursive: true, force: true }));
const ev = (seq: number): Event => ({
  protocol: 1,
  id: ulid(),
  type: "session.heartbeat",
  time: new Date().toISOString(),
  tier: 0,
  harness: { name: "codex" },
  session: { id: "s/1", seq },
  privacy: { rulesets: [], pii: false },
  data: {},
});

describe("ulid", () => {
  it("is 26 chars, sorts within a millisecond", () => {
    const a = ulid(1000);
    const b = ulid(1000);
    expect(isUlid(a)).toBe(true);
    expect(b > a).toBe(true);
    expect(ulid(2000) > b).toBe(true);
  });
});

describe("outbox", () => {
  it("seq is persistent and monotonic, recovered from the file when the counter is gone", () => {
    const o = new Outbox(tmp);
    const ref = { harness: "codex", session: "s/1" };
    expect(o.nextSeq(ref)).toBe(0);
    expect(o.nextSeq(ref)).toBe(1);
    o.append(ref, [ev(0), ev(1)]);
    rmSync(path.join(tmp, "outbox/codex/s_1.seq"));
    expect(o.nextSeq(ref)).toBe(2);
  });
  it("reads from an offset, whole lines only, and cursors move independently per sink", () => {
    const o = new Outbox(tmp);
    const ref = { harness: "codex", session: "s/1" };
    o.append(ref, [ev(0), ev(1), ev(2)]);
    const r1 = o.read(ref, 0, 2);
    expect(r1.events.map((e) => e.session.seq)).toEqual([0, 1]);
    const r2 = o.read(ref, r1.offset);
    expect(r2.events.map((e) => e.session.seq)).toEqual([2]);
    const a = new Cursors(tmp, "a");
    const b = new Cursors(tmp, "b");
    a.write({ [a.key(ref)]: r1.offset });
    expect(a.read()[a.key(ref)]).toBe(r1.offset);
    expect(b.read()).toEqual({});
    expect(o.sessions()).toEqual([ref].map((r) => ({ harness: r.harness, session: "s_1" })));
  });
  it("lock is exclusive and released", () => {
    const ref = { harness: "codex", session: "s" };
    const release = takeLock(tmp, ref);
    expect(release).not.toBeNull();
    expect(takeLock(tmp, ref)).toBeNull();
    release?.();
    expect(takeLock(tmp, ref)).not.toBeNull();
  });
  it("a lock goes with a process that exits holding it, and a stale release frees nobody else's", () => {
    // A worker at its 15 s deadline leaves through process.exit, which runs no finally.
    const ref = { harness: "codex", session: "s" };
    const a = takeLock(tmp, ref);
    expect(a).not.toBeNull();
    const onExit = process.listeners("exit").find((l) => l.name === "releaseHeldLocks");
    expect(onExit).toBeDefined();
    onExit?.(0);
    expect(existsSync(path.join(tmp, "locks", "codex-s.lock"))).toBe(false);
    const b = takeLock(tmp, ref);
    expect(b).not.toBeNull();
    a?.();
    expect(takeLock(tmp, ref)).toBeNull();
    b?.();
    const c = takeLock(tmp, ref);
    expect(c).not.toBeNull();
    c?.();
  });
});
