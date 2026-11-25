// SPDX-License-Identifier: Apache-2.0
// A lock file one process holds at a time: the rules file's (a command's last read and its write,
// rules-file.ts) and the triggers' record's (the one daemon that runs the rules, daemon.ts).
// Made with O_EXCL, so it never follows a link planted there; it holds its owner's token (the pid
// and a random id), so a release removes only its own lock and a broken lock is told from a fresh
// one. A lock is stale, and broken, when its owner's process has ended, when it is not a regular
// file (a dangling link), when its time is in the future, or when it is older than `staleMs`. It
// is broken by renaming it aside first, so of two processes that find the same stale lock only one
// breaks it; what was renamed is checked to be what was judged stale, and put back when it is not.
import { randomUUID } from "node:crypto";
import {
  closeSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import path from "node:path";

/** A folder where the lock file goes: nothing here removes it, so the person is told. */
export class LockIsFolder extends Error {
  constructor(readonly file: string) {
    super(`${file} is a folder, not a lock file`);
  }
}

export interface Held {
  readonly token: string;
  /** Let go of it: removes the file only while it is still this holder's. */
  release(): void;
}

const tokenOf = (file: string): string | null => {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
};

/** Whether the process `pid` is running (one this process can't signal is running). */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Why the lock at `file` may be broken, with what it held; null while its owner holds it. */
function staleness(file: string, staleMs: number): { why: string; token: string | null } | null {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(file);
  } catch {
    return { why: "gone", token: null };
  }
  if (st.isDirectory()) throw new LockIsFolder(file);
  if (!st.isFile()) return { why: "not a file", token: null };
  const token = tokenOf(file);
  const pid = Number(token?.split(" ")[0]);
  if (!alive(pid)) return { why: "its command has ended", token };
  const age = Date.now() - st.mtimeMs;
  if (age < -1000) return { why: "its time is in the future", token };
  if (age > staleMs) return { why: `${Math.round(age / 1000)} s old`, token };
  return null;
}

/** Take the lock at `file`, or null while another holds it. `broke` is told why a stale one was
 *  broken. Throws LockIsFolder when a folder is there, and what the disk says otherwise. */
export function takeLock(file: string, o: { staleMs?: number; broke?: (why: string) => void } = {}): Held | null {
  const staleMs = o.staleMs ?? Number.POSITIVE_INFINITY;
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const token = `${process.pid} ${randomUUID()}`;
  for (let tries = 0; tries < 3; tries++) {
    try {
      const fd = openSync(file, "wx", 0o600);
      writeSync(fd, `${token}\n`);
      closeSync(fd);
      return {
        token,
        release: () => {
          if (tokenOf(file) === token) rmSync(file, { force: true });
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const stale = staleness(file, staleMs);
    if (!stale) return null;
    if (stale.why === "gone") continue;
    // Aside first: of two that found it stale, one renames it and the other finds it gone.
    const aside = `${file}.${randomUUID()}.stale`;
    try {
      renameSync(file, aside);
    } catch {
      continue;
    }
    // What was renamed is what was judged stale, or another's fresh lock, which goes back.
    if (tokenOf(aside) !== stale.token) {
      try {
        linkSync(aside, file);
      } catch {}
      rmSync(aside, { force: true });
      return null;
    }
    rmSync(aside, { force: true });
    o.broke?.(stale.why);
  }
  /* v8 ignore next -- broken, and taken by another in the same instant, three times over */
  return null;
}
