// SPDX-License-Identifier: Apache-2.0
// Attachments on a `start` or a `prompt` (spec/CONTROL.md §3.1, §6): the signed command
// names each file by its SHA-256; the bytes wait on the receiver. The daemon fetches
// each one with the machine's token, stops reading past the signed size, checks length
// and hash, and only then writes it — under <cwd>/.sessionpipe/files/<session>/ for a
// start, <session>/<nonce>/ for a prompt — never through a symlink, never over an
// existing path, mode 0600. Any problem: nothing is kept, and the session doesn't start
// or the message isn't delivered. The same for every harness and every delivery mode:
// the files are in `cwd` before the run, and nothing about them is the harness's.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ControlFile } from "@sessionpipe/core/control";

/** One file's download may take this long (25 MiB on a slow link). */
export const FETCH_TIMEOUT_MS = 5 * 60_000;

/** A file could not be fetched, checked or written: the ack's `detail`, code `file`. */
export class FileProblem extends Error {}

export interface Fetched {
  file: ControlFile;
  /** The name as written: NFC. */
  name: string;
  bytes: Uint8Array;
}

export interface FetchOptions {
  control: string;
  token: string;
  fetch: typeof fetch;
  /** Per file; tests shorten it. */
  timeoutMs?: number | undefined;
}

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const reason = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 160);

/** Fetch every file, in order, and check each against the signed size and hash.
 *  Every failure is a FileProblem naming the file. */
export async function fetchFiles(files: ControlFile[], o: FetchOptions): Promise<Fetched[]> {
  const out: Fetched[] = [];
  for (const file of files) {
    let bytes: Uint8Array;
    try {
      bytes = await fetchOne(file, o);
    } catch (e) {
      if (e instanceof FileProblem) throw e;
      throw new FileProblem(`couldn't download ${JSON.stringify(file.name)}: ${reason(e)}`);
    }
    out.push({ file, name: file.name.normalize("NFC"), bytes });
  }
  return out;
}

async function fetchOne(f: ControlFile, o: FetchOptions): Promise<Uint8Array> {
  const label = JSON.stringify(f.name);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), o.timeoutMs ?? FETCH_TIMEOUT_MS);
  try {
    const res = await o.fetch(`${o.control.replace(/\/$/, "")}/files/${f.sha256}`, {
      headers: { authorization: `Bearer ${o.token}` },
      signal: ctl.signal,
    });
    if (res.status === 404) throw new FileProblem(`${label} isn't on the receiver (never uploaded, or expired)`);
    if (res.status !== 200) throw new FileProblem(`couldn't download ${label}: HTTP ${res.status}`);
    // A declared length past the signed size: not a byte of it is read.
    if (Number(res.headers.get("content-length")) > f.size) throw tooLong(label, f);
    const buf = new Uint8Array(f.size);
    let got = 0;
    const reader = res.body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // Past the signed size: stop reading, whatever the receiver keeps sending.
      if (got + value.length > f.size) throw tooLong(label, f);
      buf.set(value, got);
      got += value.length;
    }
    if (got !== f.size) throw new FileProblem(`${label} is ${got} bytes, not its signed ${f.size}`);
    const hash = b64url(createHash("sha256").update(buf).digest());
    if (hash !== f.sha256) throw new FileProblem(`${label} doesn't match its signed hash: it was changed`);
    return buf;
  } finally {
    clearTimeout(t);
    // Done or failed: whatever the receiver is still sending is cut off here.
    ctl.abort();
  }
}

const tooLong = (label: string, f: ControlFile) =>
  new FileProblem(`${label} is larger than its signed size (${f.size} bytes)`);

/** A directory that must be real (not a symlink) — made when absent. Anything else in
 *  the way (a file of that name) fails the mkdir, and the files with it. */
function realDir(p: string, why: string): void {
  mkdirSync(p, { recursive: true, mode: 0o700 });
  if (lstatSync(p).isSymbolicLink()) throw new FileProblem(`${why} is a symlink`);
}

/**
 * Write the checked files to <cwd>/.sessionpipe/files/<session>/ (a start's, which must
 * be new) or <session>/<message>/ (a prompt's: the session's folder may be there, the
 * message's must be new), and answer their paths relative to cwd. `cwd` is already
 * resolved (realpath) and allowed. On any problem everything written here is removed
 * and FileProblem thrown.
 */
export function writeFiles(cwd: string, session: string, files: Fetched[], message?: string): string[] {
  const top = path.join(cwd, ".sessionpipe");
  const parent = path.join(top, "files");
  const sub = message ? `${session}/${message}` : session;
  const dir = path.join(parent, session, ...(message ? [message] : []));
  let made = false;
  try {
    // Names the protocol allows in an id that are no folder of their own.
    for (const part of [session, message])
      if (part === "." || part === "..") throw new FileProblem(`no folder ${part}`);
    realDir(top, ".sessionpipe");
    // The folder ignores itself, so a repository never picks it up.
    const ignore = path.join(top, ".gitignore");
    if (!existsSync(ignore)) writeFileSync(ignore, "*\n", { flag: "wx", mode: 0o600 });
    realDir(parent, ".sessionpipe/files");
    if (message) realDir(path.join(parent, session), `.sessionpipe/files/${session}`);
    if (existsSync(dir)) throw new FileProblem(`.sessionpipe/files/${sub} already exists`);
    mkdirSync(dir, { mode: 0o700 });
    made = true;
    // Every parent between cwd and here is a real directory right now.
    if (realpathSync.native(dir) !== dir) throw new FileProblem(".sessionpipe leads outside the session's folder");
    const rel: string[] = [];
    for (const f of files) {
      // wx: exclusive create, which also refuses to open through a symlink.
      writeFileSync(path.join(dir, f.name), f.bytes, { flag: "wx", mode: 0o600 });
      rel.push(`.sessionpipe/files/${sub}/${f.name}`);
    }
    return rel;
  } catch (e) {
    if (made) rmSync(dir, { recursive: true, force: true });
    if (e instanceof FileProblem) throw e;
    throw new FileProblem(`couldn't save the files: ${reason(e)}`);
  }
}

/** 183402 → "179 KB", 1258291 → "1.2 MB" (units of 1024). */
export function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1_048_576) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1_048_576).toFixed(1)} MB`;
}

/** The command's text followed by the list of files the session can read. */
export function withFiles(text: string, files: Fetched[], rel: string[]): string {
  const lines = files.map((f, i) => `- ${rel[i]} (${f.file.type}, ${humanSize(f.file.size)})`);
  return `${text}\n\nAttached files (saved in this folder):\n${lines.join("\n")}`;
}
