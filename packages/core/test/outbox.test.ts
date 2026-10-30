// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import {
  appendFileSync,
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
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Cursors, Outbox, processAlive, takeLock, takeNamedLock } from "../src/outbox.js";
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
  it("read offsets count bytes, not characters, across batches", () => {
    const o = new Outbox(tmp);
    const ref = { harness: "codex", session: "bytes" };
    const evs = [0, 1, 2].map((seq) => ({ ...ev(seq), data: { text: "é".repeat(100) } }));
    o.append(ref, evs);
    const r1 = o.read(ref, 0, 2);
    expect(r1.events.map((e) => e.session.seq)).toEqual([0, 1]);
    const r2 = o.read(ref, r1.offset, 2);
    expect(r2.events.map((e) => e.session.seq)).toEqual([2]);
    expect(r2.offset).toBe(statSync(o.file(ref)).size);
  });
  it("an event longer than a read chunk is still read whole", () => {
    const o = new Outbox(tmp);
    const ref = { harness: "codex", session: "big" };
    o.append(ref, [ev(0), { ...ev(1), data: { text: "x".repeat(1_500_000) } }, ev(2)]);
    const r1 = o.read(ref, 0, 1);
    expect(r1.events.map((e) => e.session.seq)).toEqual([0]);
    const r2 = o.read(ref, r1.offset, 1);
    expect(r2.events.map((e) => e.session.seq)).toEqual([1]);
    expect(o.read(ref, r2.offset).events.map((e) => e.session.seq)).toEqual([2]);
  });
  it("over a megabyte of lines that parse to nothing never stops a drain", () => {
    const o = new Outbox(tmp);
    const ref = { harness: "codex", session: "junk" };
    mkdirSync(o.dir("codex"), { recursive: true });
    appendFileSync(o.file(ref), `${"not json\n".repeat(150_000)}`);
    o.append(ref, [ev(7)]);
    const r = o.read(ref, 0, 50);
    expect(r.events.map((e) => e.session.seq)).toEqual([7]);
    expect(r.offset).toBe(statSync(o.file(ref)).size);
  });
  it("lock is exclusive and released", () => {
    const ref = { harness: "codex", session: "s" };
    const release = takeLock(tmp, ref);
    expect(release).not.toBeNull();
    expect(takeLock(tmp, ref)).toBeNull();
    release?.();
    expect(takeLock(tmp, ref)).not.toBeNull();
  });
  it("a lock whose worker is gone is taken at once, not after 5 min", () => {
    const ref = { harness: "codex", session: "gone" };
    mkdirSync(path.join(tmp, "locks"), { recursive: true });
    // No process has this pid (above every platform's limit); a lock a dead worker left.
    writeFileSync(path.join(tmp, "locks", "codex-gone.lock"), "2147483647");
    expect(takeLock(tmp, ref)).not.toBeNull();
    // One a live process holds (this one) is still exclusive.
    expect(takeLock(tmp, ref)).toBeNull();
  });
});

describe("outbox: never lose, never duplicate (PROTOCOL.md §6)", () => {
  const ref = { harness: "codex", session: "inv" };
  const key = "codex/inv";

  it("append-only: a later append never rewrites earlier bytes", () => {
    const o = new Outbox(tmp);
    o.append(ref, [ev(0), ev(1)]);
    const before = readFileSync(o.file(ref));
    o.append(ref, [ev(2)]);
    const after = readFileSync(o.file(ref));
    expect(after.subarray(0, before.length).equals(before)).toBe(true);
    expect(after.length).toBeGreaterThan(before.length);
    expect(after.toString("utf8").endsWith("\n")).toBe(true);
    expect(after.toString("utf8").split("\n").filter(Boolean)).toHaveLength(3);
  });

  it("appending nothing touches nothing", () => {
    const o = new Outbox(tmp);
    o.append(ref, []);
    expect(existsSync(o.file(ref))).toBe(false);
  });

  it("one cursor per sink, each in its own file, none moving another", () => {
    const o = new Outbox(tmp);
    o.append(ref, [ev(0), ev(1), ev(2)]);
    const a = new Cursors(tmp, "https://a.example/v1");
    const b = new Cursors(tmp, "file:/tmp/b.jsonl");
    const r = o.read(ref, 0, 2);
    a.write({ [a.key(ref)]: r.offset });
    expect(a.key(ref)).toBe(key);
    expect(b.read()).toEqual({});
    expect(o.read(ref, b.read()[key] ?? 0).events.map((e) => e.session.seq)).toEqual([0, 1, 2]);
    expect(o.read(ref, a.read()[key] ?? 0).events.map((e) => e.session.seq)).toEqual([2]);
    expect(readdirSync(path.join(tmp, "cursors")).sort()).toEqual(["https___a.example_v1.json"]);
  });

  it("the cursor moves only on a success; a failed delivery re-reads the same events", () => {
    const o = new Outbox(tmp);
    const c = new Cursors(tmp, "sink");
    o.append(ref, [ev(0), ev(1)]);
    // The drain a sink runs: read from the cursor, deliver, move the cursor on a 2xx only.
    const drain = (deliver: (events: Event[]) => boolean) => {
      const cur = c.read();
      const r = o.read(ref, cur[key] ?? 0);
      if (r.events.length && deliver(r.events)) c.write({ ...cur, [key]: r.offset });
      return r.events.map((e) => e.session.seq);
    };
    expect(drain(() => false)).toEqual([0, 1]); // a 5xx, a 429, a timeout
    expect(c.read()).toEqual({});
    expect(drain(() => false)).toEqual([0, 1]);
    expect(drain(() => true)).toEqual([0, 1]);
    expect(c.read()[key]).toBe(statSync(o.file(ref)).size);
    expect(drain(() => true)).toEqual([]);
    o.append(ref, [ev(2)]);
    expect(drain(() => true)).toEqual([2]);
  });

  it("a crash between the append and the cursor move loses nothing: the next worker re-reads", () => {
    const o = new Outbox(tmp);
    o.append(ref, [ev(0), ev(1), ev(2)]);
    const worker1 = new Cursors(tmp, "sink");
    const sent = o.read(ref, worker1.read()[key] ?? 0);
    expect(sent.events).toHaveLength(3);
    // worker1 dies here: delivered, cursor never written.
    const worker2 = new Cursors(tmp, "sink");
    const again = o.read(ref, worker2.read()[key] ?? 0);
    // A duplicate at worst, never a gap: the receiver dedups on seq.
    expect(again.events.map((e) => e.session.seq)).toEqual([0, 1, 2]);
    worker2.write({ [key]: again.offset });
    expect(new Cursors(tmp, "sink").read()[key]).toBe(again.offset);
  });

  it("a cursor file cut off mid-write reads as 'from the start', never past anything", () => {
    const c = new Cursors(tmp, "sink");
    mkdirSync(path.join(tmp, "cursors"), { recursive: true });
    writeFileSync(path.join(tmp, "cursors", "sink.json"), '{"codex/inv": 12');
    expect(c.read()).toEqual({});
  });

  it("the seq counter survives a crash that left it empty or unreadable", () => {
    const o = new Outbox(tmp);
    expect(o.nextSeq(ref)).toBe(0);
    expect(o.nextSeq(ref)).toBe(1);
    o.append(ref, [ev(0), ev(1)]);
    const seqFile = path.join(tmp, "outbox", "codex", "inv.seq");
    writeFileSync(seqFile, ""); // a crash between truncate and write
    expect(o.nextSeq(ref)).toBe(2);
    writeFileSync(seqFile, "abc");
    expect(o.nextSeq(ref)).toBe(2);
    expect(o.nextSeq(ref)).toBe(3);
  });

  it("recovering the seq skips lines without one and starts at 0 when none parses", () => {
    const o = new Outbox(tmp);
    mkdirSync(o.dir("codex"), { recursive: true });
    writeFileSync(
      o.file(ref),
      `${JSON.stringify(ev(4))}\n{"no":"session"}\n{"session":null}\n{"session":{}}\nnull\nnot json\n`,
    );
    expect(o.nextSeq(ref)).toBe(5);
    const junk = { harness: "codex", session: "junk-only" };
    writeFileSync(o.file(junk), "{}\nnot json\n");
    expect(o.nextSeq(junk)).toBe(0);
  });

  it("a truncated trailing line is left for the next read; a corrupt whole line is skipped", () => {
    const o = new Outbox(tmp);
    o.append(ref, [ev(0)]);
    appendFileSync(o.file(ref), "corrupt but complete\n\n");
    const afterCorrupt = statSync(o.file(ref)).size;
    const half = JSON.stringify(ev(1)).slice(0, 40);
    appendFileSync(o.file(ref), half);
    const r1 = o.read(ref, 0);
    expect(r1.events.map((e) => e.session.seq)).toEqual([0]);
    expect(r1.offset).toBe(afterCorrupt);
    expect(o.read(ref, r1.offset)).toEqual({ events: [], offset: afterCorrupt });
    appendFileSync(o.file(ref), `${JSON.stringify(ev(1)).slice(40)}\n`);
    const r2 = o.read(ref, r1.offset);
    expect(r2.events.map((e) => e.session.seq)).toEqual([1]);
    expect(r2.offset).toBe(statSync(o.file(ref)).size);
  });

  it("a read from past the end, or of a session with no file, returns the offset it was given", () => {
    const o = new Outbox(tmp);
    expect(o.read({ harness: "codex", session: "none" }, 7)).toEqual({ events: [], offset: 7 });
    o.append(ref, [ev(0)]);
    const size = statSync(o.file(ref)).size;
    expect(o.read(ref, size)).toEqual({ events: [], offset: size });
    expect(o.read(ref, size + 100)).toEqual({ events: [], offset: size + 100 });
  });

  it("a line longer than the largest read chunk stops the read before it, without hanging", () => {
    const o = new Outbox(tmp);
    o.append(ref, [ev(0)]);
    const first = statSync(o.file(ref)).size;
    appendFileSync(o.file(ref), `${"x".repeat(9 * 1024 * 1024)}\n`);
    o.append(ref, [ev(1)]);
    const r = o.read(ref, 0);
    expect(r.events.map((e) => e.session.seq)).toEqual([0]);
    expect(r.offset).toBe(first);
  });

  it("sessions(): none without an outbox, a stray file in it is skipped, newest first", () => {
    const o = new Outbox(tmp);
    expect(o.sessions()).toEqual([]);
    const older = { harness: "codex", session: "older" };
    const newer = { harness: "claude-code", session: "newer" };
    o.append(older, [ev(0)]);
    o.append(newer, [ev(0)]);
    writeFileSync(path.join(tmp, "outbox", "stray.txt"), "");
    const t = Date.now() / 1000;
    utimesSync(o.file(older), t - 100, t - 100);
    utimesSync(o.file(newer), t, t);
    expect(o.sessions()).toEqual([newer, older]);
  });

  it("prune: files older than the window go, their counters stay, the rest stay", () => {
    const o = new Outbox(tmp);
    const old = { harness: "codex", session: "old" };
    const live = { harness: "codex", session: "live" };
    for (const r of [old, live]) {
      o.nextSeq(r);
      o.append(r, [ev(0)]);
    }
    const t = Date.now() / 1000 - 40 * 86_400;
    utimesSync(o.file(old), t, t);
    expect(o.prune(30)).toBe(1);
    expect(existsSync(o.file(old))).toBe(false);
    expect(existsSync(path.join(tmp, "outbox", "codex", "old.seq"))).toBe(true);
    expect(existsSync(o.file(live))).toBe(true);
    expect(existsSync(path.join(tmp, "outbox", "codex", "live.seq"))).toBe(true);
    expect(o.prune(30)).toBe(0);
    expect(o.prune(0, Date.now() + 1000)).toBe(1);
  });

  it("prune: a session resumed after the window counts on, and every sink reads its new file from the start", () => {
    const o = new Outbox(tmp);
    const old = { harness: "codex", session: "old" };
    const live = { harness: "codex", session: "live" };
    for (const r of [old, live]) for (let i = 0; i < 3; i++) o.append(r, [ev(o.nextSeq(r))]);
    const end = (r: typeof old) => o.read(r, 0).offset;
    const a = new Cursors(tmp, "a");
    const b = new Cursors(tmp, "b");
    const other = new Cursors(tmp, "other");
    a.write({ [a.key(old)]: end(old), [a.key(live)]: end(live) });
    b.write({ [b.key(old)]: end(old) });
    other.write({ [other.key(live)]: end(live) });
    const t = Math.floor(Date.now() / 1000) - 40 * 86_400;
    utimesSync(o.file(old), t, t);
    utimesSync(path.join(tmp, "cursors", "other.json"), t, t);
    expect(o.prune(30)).toBe(1);
    expect(a.read()).toEqual({ [a.key(live)]: end(live) });
    expect(b.read()).toEqual({});
    expect(statSync(path.join(tmp, "cursors", "other.json")).mtimeMs).toBe(t * 1000);
    // The session comes back (a resume keeps its id): seq 3, not 0, and a sink reads it.
    o.append(old, [ev(o.nextSeq(old))]);
    const back = o.read(old, b.read()[b.key(old)] ?? 0).events;
    expect(back.map((e) => e.session.seq)).toEqual([3]);
  });

  it("prune: a drain holding the flush lock keeps its cursors, and a later prune drops the keys left behind", () => {
    const o = new Outbox(tmp);
    const old = { harness: "codex", session: "old" };
    o.append(old, [ev(o.nextSeq(old))]);
    const a = new Cursors(tmp, "a");
    a.write({ [a.key(old)]: o.read(old, 0).offset, "codex/forgotten": 99 });
    const t = Date.now() / 1000 - 40 * 86_400;
    utimesSync(o.file(old), t, t);
    const drain = takeNamedLock(tmp, "flush");
    expect(o.prune(30)).toBe(1);
    expect(Object.keys(a.read())).toEqual([a.key(old), "codex/forgotten"]);
    drain?.();
    expect(o.prune(30)).toBe(0);
    expect(a.read()).toEqual({});
    expect(existsSync(path.join(tmp, "locks", "flush.lock"))).toBe(false);
  });

  it("delete removes the file and the counter, and is quiet when they are gone", () => {
    const o = new Outbox(tmp);
    o.nextSeq(ref);
    o.append(ref, [ev(0)]);
    o.delete(ref);
    expect(existsSync(o.file(ref))).toBe(false);
    expect(existsSync(path.join(tmp, "outbox", "codex", "inv.seq"))).toBe(false);
    expect(() => o.delete(ref)).not.toThrow();
  });

  it("two processes appending to one session file never tear a line", async () => {
    const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/index.js");
    expect(existsSync(dist), "build core before the tests").toBe(true);
    mkdirSync(tmp, { recursive: true });
    const script = path.join(tmp, "writer.mjs");
    writeFileSync(
      script,
      [
        "const { Outbox } = await import(process.argv[2]);",
        "const [root, tag, count] = process.argv.slice(3);",
        "const o = new Outbox(root);",
        "for (let i = 0; i < Number(count); i++)",
        "  o.append({ harness: 'codex', session: 'shared' }, [{ protocol: 1, id: tag + i, type: 'session.heartbeat',",
        "    time: 't', tier: 0, harness: { name: 'codex' }, session: { id: 'shared', seq: i },",
        "    privacy: { rulesets: [], pii: false }, data: { tag, i, pad: 'x'.repeat(3000) } }]);",
      ].join("\n"),
    );
    const run = (tag: string) =>
      new Promise<number>((resolve) => {
        const p = spawn(process.execPath, [script, pathToFileURL(dist).href, tmp, tag, "300"], { stdio: "ignore" });
        p.on("close", (code) => resolve(code ?? -1));
      });
    expect(await Promise.all([run("a"), run("b")])).toEqual([0, 0]);
    const shared = { harness: "codex", session: "shared" };
    const o = new Outbox(tmp);
    const lines = readFileSync(o.file(shared), "utf8").split("\n");
    expect(lines.pop()).toBe("");
    expect(lines).toHaveLength(600);
    const seen: Record<string, number[]> = { a: [], b: [] };
    for (const l of lines) {
      const j = JSON.parse(l) as Event & { data: { tag: "a" | "b"; i: number; pad: string } };
      expect(j.data.pad).toHaveLength(3000);
      seen[j.data.tag]?.push(j.data.i);
    }
    const want = Array.from({ length: 300 }, (_, i) => i);
    expect(seen.a).toEqual(want);
    expect(seen.b).toEqual(want);
    const all = o.read(shared, 0, 10_000);
    expect(all.events).toHaveLength(600);
    expect(all.offset).toBe(statSync(o.file(shared)).size);
  }, 30_000);
});

describe("locks", () => {
  it("a lock that cannot be written (something else sits at its path) is not taken", () => {
    mkdirSync(path.join(tmp, "locks", "busy.lock"), { recursive: true });
    expect(takeNamedLock(tmp, "busy")).toBeNull();
  });
  it("a lock older than the stale window is taken over, a fresh one is not", () => {
    mkdirSync(path.join(tmp, "locks"), { recursive: true });
    const f = path.join(tmp, "locks", "aged.lock");
    writeFileSync(f, String(process.pid));
    expect(takeNamedLock(tmp, "aged", 60_000)).toBeNull();
    const t = Date.now() / 1000 - 120;
    utimesSync(f, t, t);
    const release = takeNamedLock(tmp, "aged", 60_000);
    expect(release).not.toBeNull();
    expect(readFileSync(f, "utf8")).toBe(String(process.pid));
    release?.();
    expect(existsSync(f)).toBe(false);
    expect(() => release?.()).not.toThrow();
  });
  it("processAlive: a pid that cannot be read counts as running; this process is; a stale one is not", () => {
    expect(processAlive(0)).toBe(true);
    expect(processAlive(-5)).toBe(true);
    expect(processAlive(1.5)).toBe(true);
    expect(processAlive(Number.NaN)).toBe(true);
    expect(processAlive(process.pid)).toBe(true);
    if (process.platform !== "win32") expect(processAlive(1)).toBe(true); // init: alive, and not ours to signal
    expect(processAlive(2147483647)).toBe(false);
  });
});
