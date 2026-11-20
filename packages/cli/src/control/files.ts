// SPDX-License-Identifier: Apache-2.0
// Attachments on a `start` or a `prompt` (spec/CONTROL.md §3.1, §6): the signed command
// names each file by its SHA-256; the bytes wait on the receiver. The daemon fetches
// each one with the machine's token, stops reading past the signed size, checks length
// and hash, and only then writes it — under <cwd>/.sessionpipe/files/<session>/ for a
// start, <session>/<nonce>/ for a prompt — never through a symlink, never over an
// existing path, mode 0600. A download the network or the receiver (5xx) let down is
// tried twice more, inside the file's one time limit. Any other problem: nothing is
// kept, and the session doesn't start or the message isn't delivered, with the reason
// in plain words. The same for every harness and every delivery mode:
// the files are in `cwd` before the run, and listed in its text. A harness with its own
// way to take a picture is given the pictures that way too (picturesOf, §6 *Pictures*).
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type ControlFile, type Picture, pictureFacts } from "@sessionpipe/core/control";

/** One file's download may take this long (25 MiB on a slow link). */
export const FETCH_TIMEOUT_MS = 5 * 60_000;

/** After a download the network or the receiver let down, wait this long before the
 *  next try: two more tries, all inside the file's FETCH_TIMEOUT_MS. */
export const RETRY_DELAYS_MS: readonly number[] = [1000, 4000];

/** A file could not be fetched, checked or written: the ack's `detail`, code `file`. */
export class FileProblem extends Error {}

/** What went wrong with one try at a file (conformance/control-file-retry.json). */
export type Failure =
  | { kind: "network" }
  | { kind: "status"; status: number }
  | { kind: "too_long" | "too_short" | "hash" | "timeout" | "stopped" };

/** One try's problem, with what kind it was. */
class TryFailed extends FileProblem {
  constructor(
    message: string,
    readonly failure: Failure,
  ) {
    super(message);
  }
}

/** Whether a try that failed this way is worth another: only when nothing the receiver
 *  answered settles it (the network, or a 5xx). A 404, any other status, a wrong length
 *  or hash would come back the same; a timeout or a stop leaves no time to try. */
export function retries(f: Failure): boolean {
  return f.kind === "network" || (f.kind === "status" && f.status >= 500 && f.status <= 599);
}

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
  /** Per file, every try and the waits between them; tests shorten it. */
  timeoutMs?: number | undefined;
  /** The waits before the second and third tries; tests shorten them. */
  retryDelaysMs?: readonly number[] | undefined;
  /** Whoever asked no longer wants them (the turn was stopped): the download in flight is
   *  dropped and no further file is asked for. */
  signal?: AbortSignal | undefined;
}

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const reason = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 160);
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** 300000 → "5 minutes", 300 → "0.3 seconds". */
export function limitWords(ms: number): string {
  return ms >= 60_000 && ms % 60_000 === 0 ? plural(ms / 60_000, "minute") : plural(ms / 1000, "second");
}

/** Fetch every file, in order, and check each against the signed size and hash.
 *  Every failure is a FileProblem naming the file. */
export async function fetchFiles(files: ControlFile[], o: FetchOptions): Promise<Fetched[]> {
  const out: Fetched[] = [];
  for (const file of files) {
    if (o.signal?.aborted) throw new FileProblem(`stopped before ${JSON.stringify(file.name)} was downloaded`);
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

/** Every try at one file, inside one time limit. A try the network or the receiver
 *  (5xx) let down is made again after RETRY_DELAYS_MS; anything else is final. */
async function fetchOne(f: ControlFile, o: FetchOptions): Promise<Uint8Array> {
  const label = JSON.stringify(f.name);
  const limit = o.timeoutMs ?? FETCH_TIMEOUT_MS;
  const delays = o.retryDelaysMs ?? RETRY_DELAYS_MS;
  const late = () => new FileProblem(`${label} didn't finish downloading within ${limitWords(limit)}`);
  const over = new AbortController();
  let timedOut = false;
  const t = setTimeout(() => {
    timedOut = true;
    over.abort();
  }, limit);
  const drop = (): void => over.abort();
  o.signal?.addEventListener("abort", drop, { once: true });
  try {
    for (let n = 0; ; n++) {
      try {
        return await tryOnce(f, o, label, over.signal);
      } catch (e) {
        if (timedOut) throw late();
        const failure: Failure = o.signal?.aborted
          ? { kind: "stopped" }
          : e instanceof TryFailed
            ? e.failure
            : { kind: "network" };
        if (n >= delays.length || !retries(failure))
          // The network's own words ("fetch failed", "terminated") say nothing a person acts on.
          throw failure.kind === "network"
            ? new FileProblem(`couldn't download ${label}: the connection to the receiver kept failing`)
            : e;
      }
      await new Promise<void>((done) => {
        const w = setTimeout(done, delays[n]);
        over.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(w);
            done();
          },
          { once: true },
        );
      });
      if (timedOut) throw late();
      if (o.signal?.aborted) throw new FileProblem(`stopped before ${label} was downloaded`);
    }
  } finally {
    clearTimeout(t);
    o.signal?.removeEventListener("abort", drop);
    over.abort();
  }
}

/** One try: the request, the body up to the signed size, and the checks. */
async function tryOnce(f: ControlFile, o: FetchOptions, label: string, over: AbortSignal): Promise<Uint8Array> {
  const ctl = new AbortController();
  const drop = (): void => ctl.abort();
  over.addEventListener("abort", drop, { once: true });
  try {
    const res = await o.fetch(`${o.control.replace(/\/$/, "")}/files/${f.sha256}`, {
      headers: { authorization: `Bearer ${o.token}` },
      signal: ctl.signal,
    });
    const status = { kind: "status", status: res.status } as const;
    if (res.status === 404) throw new TryFailed(`${label} isn't on the receiver (never uploaded, or expired)`, status);
    if (res.status !== 200) throw new TryFailed(`couldn't download ${label}: HTTP ${res.status}`, status);
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
    if (got !== f.size)
      throw new TryFailed(`${label} is ${got} bytes, not its signed ${f.size}`, { kind: "too_short" });
    const hash = b64url(createHash("sha256").update(buf).digest());
    if (hash !== f.sha256)
      throw new TryFailed(`${label} doesn't match its signed hash: it was changed`, { kind: "hash" });
    return buf;
  } finally {
    over.removeEventListener("abort", drop);
    // Done or failed: whatever the receiver is still sending is cut off here.
    ctl.abort();
  }
}

const tooLong = (label: string, f: ControlFile) =>
  new TryFailed(`${label} is larger than its signed size (${f.size} bytes)`, { kind: "too_long" });

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
    throw new FileProblem(`couldn't save the files: ${writeWords(e)}`);
  }
}

/** Why a write failed, in words a person acts on; anything else as the system said it. */
function writeWords(e: unknown): string {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") return "this folder can't be written to";
  if (code === "ENOSPC") return "the disk is full";
  return reason(e);
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

/** The saved files that are pictures (core's pictureFacts: by their signed type and their
 *  bytes), in order, each at its absolute path under `cwd`: what a harness that takes
 *  pictures natively may be given besides the text's list. */
export function picturesOf(cwd: string, files: Fetched[], rel: string[]): Picture[] {
  const out: Picture[] = [];
  files.forEach((f, i) => {
    const facts = pictureFacts(f.file.type, f.bytes);
    if (facts) out.push({ ...facts, path: path.join(cwd, rel[i] as string), size: f.bytes.length });
  });
  return out;
}
