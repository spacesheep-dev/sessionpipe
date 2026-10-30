// SPDX-License-Identifier: Apache-2.0
// The outbox: append-only JSONL per (harness, session) under
// <state>/outbox/<harness>/<session>.jsonl, a per-session seq counter, a per-sink
// cursor that moves only when the sink acknowledged, and a per-session lock so two
// workers never interleave. Never lose, never duplicate.
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
   *  ones it already has, and the sinks read the new file from its start. */
  prune(days: number, now = Date.now()): number {
    const gone: string[] = [];
    const cutoff = now - days * 86_400_000;
    for (const ref of this.sessions()) {
      const f = this.file(ref);
      try {
        if (statSync(f).mtimeMs < cutoff) {
          unlinkSync(f);
          gone.push(`${ref.harness}/${ref.session}`);
        }
      } catch {}
    }
    if (gone.length) {
      const dir = path.join(this.root, "cursors");
      let names: string[] = [];
      try {
        names = readdirSync(dir).filter((n) => n.endsWith(".json"));
      } catch {}
      for (const n of names) {
        const cursors = new Cursors(this.root, n.slice(0, -5));
        const c = cursors.read();
        if (!gone.some((k) => k in c)) continue;
        for (const k of gone) delete c[k];
        cursors.write(c);
      }
    }
    return gone.length;
  }

  delete(ref: OutboxRef): void {
    for (const f of [this.file(ref), this.seqFile(ref)]) {
      try {
        unlinkSync(f);
      } catch {}
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
  read(): Record<string, number> {
    try {
      return JSON.parse(readFileSync(this.file(), "utf8")) as Record<string, number>;
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
 *  its pid. Stale once that process is gone, or after `staleMs`. */
export function takeNamedLock(root: string, name: string, staleMs = 5 * 60_000): (() => void) | null {
  const dir = path.join(root, "locks");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const f = path.join(dir, `${name}.lock`);
  try {
    if (Date.now() - statSync(f).mtimeMs > staleMs || !processAlive(Number(readFileSync(f, "utf8")))) unlinkSync(f);
    else return null;
  } catch {}
  try {
    writeFileSync(f, String(process.pid), { flag: "wx" });
  } catch {
    return null;
  }
  return () => {
    try {
      unlinkSync(f);
    } catch {}
  };
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
