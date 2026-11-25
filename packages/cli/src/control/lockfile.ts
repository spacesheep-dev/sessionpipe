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
import os from "node:os";
import path from "node:path";
import { procStartOf, sameStart } from "./inbox.js";

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

/** Active long-lived claim tokens held by this process, so a leftover claim naming our own pid
 *  from before a restart is broken while a second live daemon in the same process is kept. */
const heldClaims = new Set<string>();

const tokenOf = (file: string): string | null => {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
};

/** Who holds the lock file right now (its pid, if readable), for status and doctor. */
export function lockHolder(file: string): { pid: number; token: string } | null {
  const token = tokenOf(file);
  if (!token) return null;
  const pid = Number(token.split(" ")[0]);
  return Number.isInteger(pid) && pid > 0 ? { pid, token } : null;
}

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
function staleness(
  file: string,
  staleMs: number,
  claim: boolean,
  procStart: (pid: number) => string | null,
): { why: string; token: string | null } | null {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(file);
  } catch {
    return { why: "gone", token: null };
  }
  if (st.isDirectory()) throw new LockIsFolder(file);
  if (!st.isFile()) return { why: "not a file", token: null };
  const token = tokenOf(file);
  /* v8 ignore next -- vanished between lstatSync and readFileSync */
  if (token === null) return { why: "gone", token: null };
  const age = Date.now() - st.mtimeMs;
  // An empty file younger than two seconds may be mid-write by another writer.
  if (token === "" && age < 2_000) return null;
  const parts = token.split(" ");
  const pid = Number(parts[0]);
  if (!alive(pid)) return { why: "its command has ended", token };
  if (claim) {
    if (pid === process.pid && !heldClaims.has(token)) return { why: "this daemon's own pid from before", token };
    const recorded = parts.slice(2).join(" ");
    if (recorded) {
      const live = procStart(pid);
      if (live && !sameStart(recorded, live)) return { why: "another process has that pid now", token };
    }
    const bootAt = Date.now() - os.uptime() * 1000;
    if (st.mtimeMs < bootAt - 5_000) return { why: "from before this computer started", token };
  }
  if (age > staleMs) return { why: `${Math.round(age / 1000)} s old`, token };
  return null;
}

/** Write the token to a unique temp file and link it into place, so the lock never exists empty. */
function atomicCreate(file: string, token: string): boolean {
  const tmp = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, `${token}\n`);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tmp, file);
    return true;
  } catch (e) {
    /* v8 ignore next -- linkSync error other than EEXIST (e.g. EXDEV/EPERM) */
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    return false;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Take the lock at `file`, or null while another holds it. `broke` is told why a stale one was
 *  broken. `claim`: long-lived daemon claim (records process start time; breaks leftover own-pid,
 *  recycled-pid and pre-boot claims). Throws LockIsFolder when a folder is there. */
export function takeLock(
  file: string,
  o: {
    staleMs?: number;
    broke?: (why: string) => void;
    claim?: boolean;
    procStart?: (pid: number) => string | null;
  } = {},
): Held | null {
  const staleMs = o.staleMs ?? Number.POSITIVE_INFINITY;
  const claim = o.claim === true;
  const procStart = o.procStart ?? procStartOf;
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const start = claim ? procStart(process.pid) : null;
  const token = `${process.pid} ${randomUUID()}${start ? ` ${start}` : ""}`;
  for (let tries = 0; tries < 3; tries++) {
    if (atomicCreate(file, token)) {
      if (claim) heldClaims.add(token);
      return {
        token,
        release: () => {
          if (claim) heldClaims.delete(token);
          if (tokenOf(file) === token) rmSync(file, { force: true });
        },
      };
    }
    const stale = staleness(file, staleMs, claim, procStart);
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
