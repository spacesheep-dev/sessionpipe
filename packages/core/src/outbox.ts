// SPDX-License-Identifier: Apache-2.0
// The outbox: append-only JSONL per (harness, session) under
// <state>/outbox/<harness>/<session>.jsonl, a per-session seq counter, a per-sink
// cursor that moves only when the sink acknowledged, and a per-session lock so two
// workers never interleave. Never lose, never duplicate.

import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { safeId } from "./paths.js";
import type { Event } from "./types.js";

export interface OutboxRef {
  harness: string;
  session: string;
}

const READ_CHUNK = 1024 * 1024;
const READ_MAX = 8 * 1024 * 1024;

export class Outbox {
  constructor(readonly root: string) {}

  dir(harness: string): string {
    return path.join(this.root, "outbox", safeId(harness));
  }
  file(ref: OutboxRef): string {
    return path.join(this.dir(ref.harness), `${safeId(ref.session)}.jsonl`);
  }
  private seqFile(ref: OutboxRef): string {
    return path.join(this.dir(ref.harness), `${safeId(ref.session)}.seq`);
  }

  /** The next seq for a session, persisted (survives a hibernating machine and a
   *  restart; an in-memory counter would restart at 0 and collide). */
  nextSeq(ref: OutboxRef): number {
    const f = this.seqFile(ref);
    let n = -1;
    try {
      const t = readFileSync(f, "utf8").trim();
      if (/^\d+$/.test(t)) n = Number(t);
    } catch {}
    // A missing or unreadable counter (a crash between truncate and write leaves it
    // empty) with an existing outbox: recover from the file's last line.
    if (n < 0) n = this.lastSeqInFile(ref) + 1;
    mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    writeFileSync(f, String(n + 1), { mode: 0o600 });
    return n;
  }

  private lastSeqInFile(ref: OutboxRef): number {
    const f = this.file(ref);
    if (!existsSync(f)) return -1;
    const lines = readFileSync(f, "utf8").trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const j = JSON.parse(lines[i] as string) as Event;
        if (typeof j.session?.seq === "number") return j.session.seq;
      } catch {}
    }
    return -1;
  }

  append(ref: OutboxRef, events: Event[]): void {
    if (!events.length) return;
    mkdirSync(this.dir(ref.harness), { recursive: true, mode: 0o700 });
    appendFileSync(this.file(ref), `${events.map((e) => JSON.stringify(e)).join("\n")}\n`, { mode: 0o600 });
  }

  /** Every session file, newest first. */
  sessions(): OutboxRef[] {
    const out: { ref: OutboxRef; mtime: number }[] = [];
    const base = path.join(this.root, "outbox");
    if (!existsSync(base)) return [];
    for (const h of readdirSync(base)) {
      const d = path.join(base, h);
      let names: string[] = [];
      try {
        names = readdirSync(d).filter((n) => n.endsWith(".jsonl"));
      } catch {
        continue;
      }
      for (const n of names) {
        try {
          out.push({ ref: { harness: h, session: n.slice(0, -6) }, mtime: statSync(path.join(d, n)).mtimeMs });
        } catch {}
      }
    }
    return out.sort((a, b) => b.mtime - a.mtime).map((x) => x.ref);
  }

  /** Read events after byte offset `from`; returns them and the new offset. Lines
   *  are read whole; a partial trailing line (a write in progress) is left. A read
   *  takes READ_CHUNK bytes at a time, not the rest of the file: a session file grows
   *  to tens of MB and a drain takes it in batches of 50. It reads on until the batch
   *  is full or the file ends, so lines that parse to nothing never stop a drain; one
   *  line longer than the chunk gets a larger one, up to READ_MAX. */
  read(ref: OutboxRef, from: number, maxEvents = 500): { events: Event[]; offset: number } {
    const f = this.file(ref);
    if (!existsSync(f)) return { events: [], offset: from };
    const size = statSync(f).size;
    if (from >= size) return { events: [], offset: from };
    const fd = openSync(f, "r");
    try {
      const events: Event[] = [];
      let offset = from;
      let chunk = READ_CHUNK;
      while (events.length < maxEvents && offset < size) {
        const buf = Buffer.alloc(Math.min(size - offset, chunk));
        const n = readSync(fd, buf, 0, buf.length, offset);
        const text = buf.subarray(0, n).toString("utf8");
        let pos = 0;
        let used = 0;
        while (events.length < maxEvents) {
          const nl = text.indexOf("\n", pos);
          if (nl < 0) break;
          const line = text.slice(pos, nl);
          pos = nl + 1;
          used += Buffer.byteLength(line, "utf8") + 1;
          if (!line.trim()) continue;
          try {
            events.push(JSON.parse(line) as Event);
          } catch {}
        }
        offset += used;
        if (used) continue;
        // No whole line in this chunk: a line longer than it, or a write in progress.
        if (offset + n >= size || chunk >= READ_MAX) break;
        chunk *= 2;
      }
      return { events, offset };
    } finally {
      closeSync(fd);
    }
  }

  /** Files older than `days` are pruned, and each sink's cursor into them. The seq
   *  counter stays: a session resumed after the window counts on from where it was,
   *  so a receiver's (harness, session, seq) dedup doesn't take its new events for
   *  ones it already has, and the sinks read the new file from its start.
   *  It all happens under the drain's `flush` lock, since a drain holds the whole
   *  cursor map and writes it back: a file and its cursor keys go together, so a
   *  session resumed in between can't keep a key past its new file's end. While a
   *  drain runs, nothing is pruned (0); the next prune does it. It never throws: it
   *  is a cleanup, and a hook's drain comes after it. */
  prune(days: number, now = Date.now()): number {
    let release: (() => void) | null = null;
    try {
      release = takeNamedLock(this.root, "flush");
    } catch {}
    if (!release) return 0;
    let n = 0;
    try {
      const cutoff = now - days * 86_400_000;
      const aged = this.sessions().filter((ref) => {
        try {
          return statSync(this.file(ref)).mtimeMs < cutoff;
        } catch {
          return false;
        }
      });
      // The keys go first: a worker that dies or fails to write here leaves a file
      // with no cursor, which a sink sends again (a receiver's dedup takes it), never
      // a cursor past the end of a file a resume starts. Each file is checked again
      // right before it goes: one a hook appended to meanwhile stays.
      this.dropStaleCursors(new Set(aged.map((ref) => `${ref.harness}/${ref.session}`)));
      for (const ref of aged) {
        const f = this.file(ref);
        try {
          if (statSync(f).mtimeMs < cutoff) {
            unlinkSync(f);
            n++;
          }
        } catch {}
      }
    } catch {
    } finally {
      release();
    }
    return n;
  }

  /** A sink's cursor into a session file about to be pruned (`gone`), or one already
   *  missing (an earlier prune, an older release, by hand) is removed. The caller
   *  holds the `flush` lock. */
  private dropStaleCursors(gone: Set<string>): void {
    let names: string[] = [];
    try {
      names = readdirSync(path.join(this.root, "cursors")).filter((n) => n.endsWith(".json"));
    } catch {}
    const stale = (c: Record<string, number>): string[] =>
      Object.keys(c).filter((k) => {
        if (gone.has(k)) return true;
        const i = k.indexOf("/");
        return !existsSync(this.file({ harness: k.slice(0, i), session: k.slice(i + 1) }));
      });
    for (const n of names) {
      const s = new Cursors(this.root, n.slice(0, -5));
      const c = s.read();
      const keys = stale(c);
      if (!keys.length) continue;
      for (const k of keys) delete c[k];
      s.write(c);
    }
  }

  delete(ref: OutboxRef): void {
    // The cursor keys go before the files: a death between leaves the old file with
    // no cursor, so the next drain sends it whole and the person, who sees no "removed"
    // line, runs forget again; the other way round leaves a cursor past the end of
    // the file a session that goes on starts, and nothing says so.
    this.dropCursors(ref);
    for (const f of [this.file(ref), this.seqFile(ref)]) {
      try {
        unlinkSync(f);
      } catch {}
    }
  }

  /** The key every sink's cursor holds for a session is removed with the session's
   *  file: the key alone pointed into the old file, and a session that went on (still
   *  running, or resumed later) had its new file's first events unsent until it grew
   *  past that offset. Every file under <state>/cursors is taken (a sink since taken
   *  out of the config still has one; one that doesn't parse reads as empty and is
   *  left), by the key a drain writes (the file's own name, `safeId`) and by the ref
   *  as given. The caller holds the drain's `flush` lock: a drain holds the whole
   *  cursor map and writes it back, so a key dropped under it would come back. */
  private dropCursors(ref: OutboxRef): void {
    const keys = new Set([`${ref.harness}/${ref.session}`, `${safeId(ref.harness)}/${safeId(ref.session)}`]);
    let names: string[] = [];
    try {
      names = readdirSync(path.join(this.root, "cursors")).filter((n) => n.endsWith(".json"));
    } catch {
      return;
    }
    for (const n of names) {
      const s = new Cursors(this.root, n.slice(0, -5));
      const c = s.read();
      const had = Object.keys(c).filter((k) => keys.has(k));
      if (!had.length) continue;
      for (const k of had) delete c[k];
      s.write(c);
    }
  }
}

/** Per-sink cursor: byte offset per session file, moved only on a 2xx. */
export class Cursors {
  constructor(
    readonly root: string,
    readonly sink: string,
  ) {}
  private file(): string {
    return path.join(this.root, "cursors", `${safeId(this.sink)}.json`);
  }
  /** The map; empty when the file is missing, cut off mid-write, or holds anything
   *  but an object (`null`, a list), so a drain never indexes into those. */
  read(): Record<string, number> {
    try {
      const c = JSON.parse(readFileSync(this.file(), "utf8")) as unknown;
      return c && typeof c === "object" && !Array.isArray(c) ? (c as Record<string, number>) : {};
    } catch {
      return {};
    }
  }
  write(c: Record<string, number>): void {
    const f = this.file();
    mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(c), { mode: 0o600 });
    renameSync(tmp, f);
  }
  key(ref: OutboxRef): string {
    return `${ref.harness}/${ref.session}`;
  }
}

/** A lock per session so two workers never interleave. Stale once the worker that
 *  took it is gone (its 15 s deadline ends it without a release), or after 5 min. */
export function takeLock(root: string, ref: OutboxRef, staleMs = 5 * 60_000): (() => void) | null {
  return takeNamedLock(root, `${safeId(ref.harness)}-${safeId(ref.session)}`, staleMs);
}

/** A named lock under <root>/locks, held by one process at a time: the file names
 *  its pid and a nonce. Stale once that process is gone, or after `staleMs`. A stale
 *  lock is taken over by renaming it aside first: of two workers that both judged it
 *  stale, one rename wins, and one that moved a fresh lock instead (another worker's,
 *  made in between) puts it back and stands down. The release deletes the file only
 *  while it is still this taker's, so a lock taken over can't be wiped by its old
 *  holder. Two holders at once used to mean two drains reading the same cursors and
 *  sending the same batch (issue #208's one-request-a-second pace rests on one). */
export function takeNamedLock(root: string, name: string, staleMs = 5 * 60_000): (() => void) | null {
  const dir = path.join(root, "locks");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const f = path.join(dir, `${name}.lock`);
  const nonce = randomBytes(8).toString("hex");
  const mine = `${process.pid} ${nonce}`;
  let body: string | null = null;
  try {
    body = readFileSync(f, "utf8");
    const stale = Date.now() - statSync(f).mtimeMs > staleMs || !processAlive(Number(body.split(" ")[0]));
    if (!stale) return null;
  } catch {
    body = null;
  }
  if (body !== null) {
    const aside = `${f}.${process.pid}.${nonce}.stale`;
    try {
      renameSync(f, aside);
    } catch {
      return null;
    }
    // The aside name is this call's own: nobody else reads or removes it.
    const moved = readFileSync(aside, "utf8");
    unlinkSync(aside);
    if (moved !== body) {
      try {
        writeFileSync(f, moved, { flag: "wx" });
      } catch {}
      return null;
    }
  }
  try {
    writeFileSync(f, mine, { flag: "wx" });
  } catch {
    return null;
  }
  return () => {
    try {
      if (readFileSync(f, "utf8") === mine) unlinkSync(f);
    } catch {}
  };
}

/** `takeNamedLock`, tried again every `everyMs` until `forMs` have passed: for a
 *  command whose work goes under a lock a worker holds for seconds (a drain). null
 *  once the time is up. */
export async function waitNamedLock(
  root: string,
  name: string,
  forMs: number,
  everyMs = 100,
): Promise<(() => void) | null> {
  for (let waited = 0; ; waited += everyMs) {
    const release = takeNamedLock(root, name);
    if (release || waited >= forMs) return release;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** Whether the process a lock or a claimed job names is still running. A pid that
 *  can't be read counts as running: the age rule decides then. */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
