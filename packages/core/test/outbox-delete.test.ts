// SPDX-License-Identifier: Apache-2.0
// `sessionpipe forget` on the outbox: Outbox.delete takes the session's key out of
// every sink's cursor with its file, and waitNamedLock is how the command waits for
// a drain's `flush` lock. outbox.test.ts has the rest of the outbox.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Cursors, Outbox, waitNamedLock } from "../src/outbox.js";
import type { Event } from "../src/types.js";
import { ulid } from "../src/ulid.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "sp-outbox-delete-"));
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
describe("delete: the session's cursor keys go with its file (sessionpipe forget)", () => {
  const ref = { harness: "codex", session: "s/1" };
  // The key a drain writes (from the file's name) and the one Cursors.key gives the ref.
  const drainKey = "codex/s_1";
  const refKey = "codex/s/1";

  it("a session that goes on after a forget is read from its new file's start, by every sink", () => {
    const o = new Outbox(tmp);
    const other = { harness: "codex", session: "other" };
    o.append(ref, [ev(0), ev(1), ev(2), ev(3), ev(4)]);
    o.append(other, [ev(0)]);
    const end = statSync(o.file(ref)).size;
    const a = new Cursors(tmp, "a");
    const b = new Cursors(tmp, "b");
    a.write({ [drainKey]: end, "codex/other": 7 });
    b.write({ [refKey]: end, [drainKey]: end });
    o.delete(ref);
    expect(a.read()).toEqual({ "codex/other": 7 });
    expect(b.read()).toEqual({});
    expect(existsSync(o.file(ref))).toBe(false);
    // The session goes on: a new file from byte 0, shorter than the old offset.
    o.append(ref, [ev(0), ev(1), ev(2)]);
    expect(o.read(ref, a.read()[drainKey] ?? 0).events.map((e) => e.session.seq)).toEqual([0, 1, 2]);
    expect(o.read(ref, b.read()[drainKey] ?? 0).events.map((e) => e.session.seq)).toEqual([0, 1, 2]);
    expect(o.read(other, a.read()["codex/other"] ?? 0).events).toEqual([]);
  });

  it("a cursor file of a sink no longer in the config is taken too; one that doesn't parse, and a stray file, are left", () => {
    const o = new Outbox(tmp);
    o.append(ref, [ev(0)]);
    new Cursors(tmp, "https://old.example/v1").write({ [drainKey]: 40, "codex/kept": 2 });
    const bad = path.join(tmp, "cursors", "bad.json");
    writeFileSync(bad, `{"${drainKey}": 40`);
    const stray = path.join(tmp, "cursors", `a.json.${process.pid}.tmp`);
    writeFileSync(stray, `{"${drainKey}": 40}`);
    o.delete(ref);
    expect(new Cursors(tmp, "https://old.example/v1").read()).toEqual({ "codex/kept": 2 });
    expect(readFileSync(bad, "utf8")).toBe(`{"${drainKey}": 40`);
    expect(readFileSync(stray, "utf8")).toBe(`{"${drainKey}": 40}`);
    expect(readdirSync(path.join(tmp, "cursors")).sort()).toEqual([
      `a.json.${process.pid}.tmp`,
      "bad.json",
      "https___old.example_v1.json",
    ]);
  });

  it("a cursor file holding null or a list reads as empty, and delete leaves it as it is", () => {
    const o = new Outbox(tmp);
    o.append(ref, [ev(0)]);
    mkdirSync(path.join(tmp, "cursors"), { recursive: true });
    for (const [name, text] of [
      ["null", "null"],
      ["list", "[1]"],
      ["num", "7"],
    ] as const) {
      writeFileSync(path.join(tmp, "cursors", `${name}.json`), text);
      expect(new Cursors(tmp, name).read()).toEqual({});
    }
    o.delete(ref);
    expect(readFileSync(path.join(tmp, "cursors", "null.json"), "utf8")).toBe("null");
    expect(readFileSync(path.join(tmp, "cursors", "list.json"), "utf8")).toBe("[1]");
    expect(readFileSync(path.join(tmp, "cursors", "num.json"), "utf8")).toBe("7");
  });

  it("a file whose cursors don't name the session is not rewritten", () => {
    const o = new Outbox(tmp);
    const c = new Cursors(tmp, "a");
    c.write({ "codex/other": 3 });
    const f = path.join(tmp, "cursors", "a.json");
    const t = Date.now() / 1000 - 100;
    utimesSync(f, t, t);
    const before = statSync(f).mtimeMs;
    o.delete(ref);
    expect(statSync(f).mtimeMs).toBe(before);
    expect(c.read()).toEqual({ "codex/other": 3 });
  });

  it("no cursors dir, or no outbox file for the session: quiet, and the keys still go", () => {
    const o = new Outbox(tmp);
    expect(() => o.delete(ref)).not.toThrow();
    expect(existsSync(path.join(tmp, "cursors"))).toBe(false);
    const a = new Cursors(tmp, "a");
    a.write({ [drainKey]: 12 });
    expect(existsSync(o.file(ref))).toBe(false);
    o.delete(ref);
    expect(a.read()).toEqual({});
  });
});

describe("waitNamedLock", () => {
  it("takes a free lock at once, one let go within the wait, and none held past it", async () => {
    const release = await waitNamedLock(tmp, "flush", 1000, 20);
    expect(release).not.toBeNull();
    const t0 = Date.now();
    expect(await waitNamedLock(tmp, "flush", 100, 20)).toBeNull();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(90);
    setTimeout(() => release?.(), 60);
    const again = await waitNamedLock(tmp, "flush", 1000, 20);
    expect(again).not.toBeNull();
    again?.();
  });
});
