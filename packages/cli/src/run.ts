// SPDX-License-Identifier: Apache-2.0
// What a worker run does, as a function so tests and `sessionpipe replay` share it.
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  opendirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type AdapterEvent,
  adapterByName,
  Cursors,
  capTail,
  claudeControl,
  type DataOf,
  type DeliveryResult,
  type Event,
  type FactsState,
  FileSink,
  filterEvent,
  gitFacts,
  isInjected,
  machineName,
  makeEvent,
  Outbox,
  type OutboxRef,
  processAlive,
  readConfig,
  readHook,
  redactDeep,
  type Session,
  type Sink,
  type SinkConfig,
  StdoutSink,
  safeId,
  shortId,
  stateDir,
  type TranscriptRead,
  type Turn,
  takeLock,
  takeNamedLock,
  tilde,
  writeConfig,
  writeWhole,
} from "@sessionpipe/core";
import { deliveredWords } from "@sessionpipe/core/control";
import { aliasFile, readAliases, receiverIdOf } from "./control/aliases.js";
import { ask, socketPath, threadOf } from "./control/local.js";
import { sendTool, ToolClock, type ToolsMode, toolsMode } from "./fold.js";
import { HttpSink } from "./http-sink.js";
import { sinkWithSecrets } from "./secrets.js";

async function tellDaemon(
  state: string,
  job: Job,
  session: string,
  cwd: string | undefined,
  transcript: string | undefined,
  events: readonly { type: string; data: Record<string, unknown> }[],
): Promise<void> {
  const sock = socketPath(state);
  if (process.platform !== "win32" && !existsSync(sock)) return;
  // The session's own permission mode, where its payload names one (CONTROL.md §6, The
  // session's mode): the daemon records it per session, and an in-place lane and a
  // relaunch's narrowing both rest on it. Read from the top-level field, never matched
  // out of the payload's text, so a tool input that quotes one cannot set it.
  let payload: unknown = null;
  try {
    payload = JSON.parse(job.stdin);
  } catch {}
  const mode = claudeControl.hookMode(payload);
  // What a held permission prompt is let go by (CONTROL.md §7; control/attention.ts):
  // the thread this event is about, its tool call, when its hook fired, and what a Stop
  // says is still in flight. A Claude Code session's alone: the daemon holds a prompt for
  // no other harness, and these are its payload's names.
  const background = events.find((e) => e.type === "turn.ended")?.data.background;
  const about =
    job.harness === "claude-code"
      ? {
          // (An object: the adapter read a session id out of it.)
          ...threadOf(Object(payload) as Record<string, unknown>),
          at: job.at,
          ...(typeof background === "number" ? { background } : {}),
        }
      : {};
  await ask(
    sock,
    {
      op: "event",
      session: `${job.harness}:${session}`,
      event: job.event,
      ...(cwd ? { cwd } : {}),
      ...(transcript ? { transcript } : {}),
      ...(mode ? { mode } : {}),
      ...about,
    },
    300,
  );
}

declare const __SESSIONPIPE_VERSION__: string;
const VERSION = typeof __SESSIONPIPE_VERSION__ === "string" ? __SESSIONPIPE_VERSION__ : "0.0.0";

export interface Job {
  /** The hook event this job is, as its hook named it: the same in every copy of the job.
   *  A job an older hook wrote has none. */
  id?: string;
  harness: string;
  event: string;
  argv: string[];
  stdin: string;
  cwd: string;
  env: Record<string, string>;
  ppid?: number;
  at: number;
  /** How many times the session's lock held this job out (a fresh worker starts for
   *  it each time, up to MAX_TRIES; after that a sweep picks it up). */
  tries?: number;
  /** The length of a payload too big for the hook to hand on (hook.ts STDIN_MAX); `stdin`
   *  is then empty. */
  omitted_bytes?: number;
}

export const MAX_TRIES = 10;

/** A job file the worker will pick up: random suffix, 0600, in a 0700 dir. */
export function enqueueJob(state: string, job: Job): string {
  const jobs = jobsDir(state);
  mkdirSync(jobs, { recursive: true, mode: 0o700 });
  const f = path.join(jobs, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.json`);
  writeFileSync(f, JSON.stringify(job), { mode: 0o600 });
  return f;
}

/** A job is claimed by renaming its file `<file>.<pid>.running`: of two workers that
 *  race for it, one rename wins. The claim stays until the job's events are in the
 *  outbox (or it went back to the queue), so a worker its deadline ended mid-run
 *  leaves it behind for a sweep to give back (ground rule 4: no event lost). */
export function claimJob(file: string): { job: Job; file: string } | null {
  const claimed = `${file}.${process.pid}.running`;
  try {
    renameSync(file, claimed);
  } catch {
    return null;
  }
  // A claim's age counts from here (sweepJobs gives back one older than any worker
  // lives). A rename keeps the file's own time, the moment its hook wrote it: a job that
  // had waited a minute for its turn was taken back from the worker running it by the
  // next sweep, each of the two put it back when the session was busy, and one job was
  // two, then four (9 627 hook events were 152 800 files, 2026-11-20).
  stampClaim(claimed);
  try {
    // A big payload follows the job's line as it came (hook.ts INLINE_MAX); JSON.stringify
    // never writes a newline of its own, so the first one ends the job.
    const text = readFileSync(claimed, "utf8");
    const nl = text.indexOf("\n");
    if (nl < 0) return { job: JSON.parse(text) as Job, file: claimed };
    return { job: { ...(JSON.parse(text.slice(0, nl)) as Job), stdin: text.slice(nl + 1) }, file: claimed };
  } catch {
    releaseJob(claimed);
    return null;
  }
}
/** Mark a claim as held now. False only when it is no longer there to mark: a time that
 *  cannot be set (a share that keeps none, a file another program holds open) leaves the
 *  claim this worker's, and its job is run. */
function stampClaim(claimed: string): boolean {
  try {
    const now = new Date();
    utimesSync(claimed, now, now);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ENOENT";
  }
}
/** Whether the job is still this worker's to run or to put back: a claim a sweep gave
 *  back (its worker was held up for longer than any worker lives: a machine asleep, a
 *  disk that stalled) is another worker's job now. The claim is marked as held again, so
 *  a sweep leaves it for another minute. A job run without a claim (a test, a hook with
 *  no worker) is its caller's. */
const holdsClaim = (claimed: string | undefined): boolean => claimed === undefined || stampClaim(claimed);

/** How many of its hook events a session remembers having run: the newest, and those
 *  whose copies keep coming (a copy that is dropped is the newest again). */
export const RAN_KEPT = 64;
/** One hook event: the same for every copy of its job, since a job put back keeps what
 *  its hook wrote. The name its hook gave it; for a job an older hook wrote, which has
 *  none, its time and payload together (two hook events of one session are not alike to
 *  the millisecond and the byte). Nothing for a job that says neither. */
export function jobKey(job: Job): string | undefined {
  if (typeof job.id === "string" && job.id) return job.id.slice(0, 40);
  if (typeof job.at !== "number") return undefined;
  return createHash("sha256")
    .update([job.at, job.harness, job.event, ...job.argv, job.stdin].join("\n"))
    .digest("hex")
    .slice(0, 16);
}
const ranKeys = (mem: Record<string, unknown>): string[] =>
  Array.isArray(mem.ran) ? mem.ran.filter((k): k is string => typeof k === "string") : [];
/** `key`, newest of the hook events a session has run. */
const ranWith = (mem: Record<string, unknown>, key: string): string[] =>
  [key, ...ranKeys(mem).filter((k) => k !== key)].slice(0, RAN_KEPT);
export function releaseJob(claimed: string | undefined): void {
  if (!claimed) return;
  try {
    unlinkSync(claimed);
  } catch {}
}

/** How many names of the jobs folder one sweep reads. A folder that holds no more is read
 *  whole and its jobs are taken oldest first, as ever. One that has grown past it costs a
 *  sweep the same as a small one: every worker sweeps, and when a session's jobs had
 *  outrun its lock for a day (152 800 files, 2026-11-20) 800 workers each listing and
 *  sorting all of them held one another, and every hook on the machine, for minutes. */
export const SWEEP_READ = 1024;

/** The first `most` names in a state's jobs folder, in the folder's own order (no order
 *  at all); none when there is no folder, or it cannot be read. Never the whole of a
 *  folder that holds more: see SWEEP_READ. */
export function jobNames(state: string, most: number): string[] {
  const names: string[] = [];
  try {
    const dir = opendirSync(jobsDir(state), { bufferSize: Math.min(Math.max(most, 1), 1024) });
    try {
      while (names.length < most) {
        const e = dir.readSync();
        if (!e) break;
        names.push(e.name);
      }
    } finally {
      dir.closeSync();
    }
  } catch {
    return [];
  }
  return names;
}

/** Jobs another worker left behind: a claim whose worker is gone (or older than any
 *  worker lives, `abandonedMs`) goes back to the queue, then every queued job older
 *  than `olderThanMs` (younger ones belong to the worker their hook just spawned)
 *  is claimed and run. Every worker sweeps before it exits. */
export async function sweepJobs(
  state: string,
  olderThanMs = 3000,
  limit = 20,
  abandonedMs = 60_000,
  o: DrainLife = {},
): Promise<number> {
  const jobs = jobsDir(state);
  const names = jobNames(state, SWEEP_READ);
  const queued = names.filter((n) => n.endsWith(".json"));
  for (const n of names) {
    const m = /^(.*\.json)\.(\d+)\.running$/.exec(n);
    if (!m) continue;
    const f = path.join(jobs, n);
    try {
      if (processAlive(Number(m[2])) && Date.now() - statSync(f).mtimeMs < abandonedMs) continue;
      renameSync(f, path.join(jobs, m[1] as string));
      queued.push(m[1] as string);
    } catch {}
  }
  let ran = 0;
  // The jobs' events go to the outbox one by one and the sinks drain once at the end:
  // a drain per job would wait out the machine's pace (PACE_MS) once per job. Each job
  // that appended something marks flush.more, so a drain already running sends it in
  // its next pass instead of leaving it behind the rest of the sweep. A job whose
  // session is busy waits SWEEP_LOCK_WAIT_MS, not a hook's 6 s, and goes back to the
  // queue; no job starts once the worker's life is too short for the drain after it.
  for (const n of queued.sort().slice(0, limit)) {
    if (o.deadline !== undefined && Date.now() + SWEEP_LOCK_WAIT_MS + PASS_BUDGET_MS > o.deadline) break;
    const f = path.join(jobs, n);
    try {
      if (Date.now() - statSync(f).mtimeMs < olderThanMs) continue;
    } catch {
      continue;
    }
    const c = claimJob(f);
    if (!c) continue;
    try {
      const r = await runJob(c.job, { state, claimed: c.file, drain: false, lockWaitMs: SWEEP_LOCK_WAIT_MS });
      if (r.events.length) markMore(state);
    } catch (e) {
      logFailed(state, c.job, e);
    } finally {
      releaseJob(c.file);
    }
    ran++;
  }
  if (ran) await drain(state, readConfig().sinks, new Outbox(state), undefined, o);
  return ran;
}

/** A job whose run threw is let go of, as it always was (run again it would throw again),
 *  and never in silence: for two days every job of one session ended on an outbox too big
 *  to read whole, and nothing on the machine said so (2026-11-20). What failed, by its
 *  harness and event. Why, in the error's own words only when the system said them (a file
 *  that could not be read or written: its message is a code and a path); any other error
 *  can quote the value it failed on, which may be a payload's, so it is named by its kind
 *  and where it was thrown. */
export function logFailed(state: string, job: Pick<Job, "harness" | "event">, e: unknown): void {
  let why = "something that is not an error was thrown";
  if (e instanceof Error) {
    const { code, syscall } = e as NodeJS.ErrnoException;
    // The stack begins with the error's own words, and those can hold a line that looks
    // like a frame (a tool's output with a stack trace in it): the frames come after them.
    const frames = (e.stack ?? "").slice(String(e).length);
    const where = /^\s+at (.+)$/m.exec(frames)?.[1] ?? "an unknown place";
    why = syscall ? `${e.name}: ${e.message}` : `${e.name}${typeof code === "string" ? ` [${code}]` : ""} at ${where}`;
  }
  log(
    state,
    `${job.harness} ${job.event}: the job failed and is not run again: ${why.replace(/\s+/g, " ").slice(0, 300)}`,
  );
}

export function log(state: string, line: string): void {
  try {
    mkdirSync(state, { recursive: true, mode: 0o700 });
    const f = path.join(state, "log");
    try {
      if (statSync(f).size > 1024 * 1024) renameSync(f, `${f}.1`);
    } catch {}
    appendFileSync(f, `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

/** <state>/facts/<harness>/<session>.json — what the machine learned about a session. */
export function factsState(state: string): FactsState {
  const file = (h: string, s: string) => path.join(state, "facts", safeId(h), `${safeId(s)}.json`);
  return {
    get(h, s) {
      try {
        return JSON.parse(readFileSync(file(h, s), "utf8")) as Record<string, unknown>;
      } catch {
        return {};
      }
    },
    save(h, s, patch) {
      const cur = this.get(h, s);
      const next = { ...cur, ...patch };
      if (JSON.stringify(next) === JSON.stringify(cur)) return;
      mkdirSync(path.dirname(file(h, s)), { recursive: true, mode: 0o700 });
      writeWhole(file(h, s), JSON.stringify(next));
    },
  };
}

export function buildSinks(sinks: SinkConfig[], o: { locked?: (name: string) => void } = {}): Sink[] {
  const out: Sink[] = [];
  for (const raw of sinks) {
    if (raw.paused) continue;
    // A token kept in a keychain is read now; one this process can't read (a keychain
    // locked in an ssh session) leaves the sink's events waiting, never sent unsigned.
    const s = sinkWithSecrets(raw);
    if (!s) {
      o.locked?.(raw.name);
      continue;
    }
    // Math.trunc: a tier of 1.5 that an older `sink add --tier 1.5` stored sends as 1.
    // `|| 0`: a sink with no tier (a hand edit) sends at 0, not as a `tier: null` no
    // receiver takes.
    const tier = Math.trunc(Math.min(Number(s.tier) || 0, s.max_tier ?? 3)) as 0 | 1 | 2 | 3;
    if (s.url === "stdout") out.push(new StdoutSink(s.name, tier, !!s.pii));
    else if (s.url.startsWith("file:"))
      out.push(new FileSink(s.name, s.url.slice(5).replace(/^~(?=\/|$)/, os.homedir()), tier, !!s.pii));
    else if (/^https?:\/\//.test(s.url)) out.push(new HttpSink(s, tier));
  }
  return out;
}

/** How often a running turn's words go out again (turn.progress), at most. */
export const PROGRESS_MS = 20_000;

/** The turn still running in a transcript read from the delivery cursor: the last
 *  turn with a reply so far, or a prompt nothing has answered yet (the hook's own
 *  copy when the transcript doesn't hold it yet). `base` is the number the cursor's
 *  first turn will get, so a turn keeps the number its turn.transcript will carry.
 *  The reply keeps its end when it is long: where the turn is now. */
export function openTurn(
  read: TranscriptRead,
  o: { base: number; prompt?: string | undefined; at: number },
): { turn: number; user: string; assistant: string; at: number; injected?: true } | null {
  const last = read.turns[read.turns.length - 1];
  const fresh = (user: string, at: number, injected?: true) => ({
    turn: o.base + read.turns.length,
    user: user.slice(0, MAX_TURN_SIDE),
    assistant: "",
    at,
    ...(injected ? { injected: true as const } : {}),
  });
  // A turn still running says the same about its ask as the finished one will: the board
  // would otherwise show the person's relayed words as typed here until the turn ends.
  if (read.open) return fresh(read.open.user, read.open.at, read.open.injected);
  // The prompt the hook just reported, unless the transcript already has its reply.
  // Text the person never typed (a task notification, another session's message) opens
  // no turn: the readers skip it, so that turn would never be delivered, and its
  // reading would stand in for the turn that is running until the next one lands.
  // What sessionpipe wrote around a message it delivered is taken off, as the readers
  // take it off the transcript's copy: the reading is the person's words there too.
  const prompt = o.prompt === undefined ? undefined : deliveredWords(o.prompt.trim()).text;
  if (prompt && !isInjected(prompt) && !(last && last.user.includes(prompt.slice(0, 200)))) return fresh(prompt, o.at);
  // A turn the person interrupted is over: it is not the one running now.
  if (!last || last.interrupted) return null;
  return {
    turn: o.base + read.turns.length - 1,
    user: last.user.slice(0, MAX_TURN_SIDE),
    assistant: capTail(last.assistant, MAX_TURN_SIDE),
    ...(last.injected ? { injected: true as const } : {}),
    at: last.at,
  };
}
const MAX_TURN_SIDE = 20_000;

/** A turn's Stop can come before the turn's last row is in the transcript: Claude Code
 *  queues its transcript writes and flushes them on a 100 ms timer, and a terminal
 *  session's Stop hook fires within tens of milliseconds of the last message (issue: the
 *  turn reached a receiver only when the NEXT turn ended, 8 turn ends of 9, 2026-11-10).
 *  So the worker waits for the words the Stop named. Under the session's lock, for at
 *  most SETTLE_FAST_MS, re-reading every SETTLE_STEP_MS: the usual case, and the turn's
 *  `turn.transcript` then goes into the outbox with its `turn.ended`, ahead of anything
 *  a later hook of the session emits. Past that the `turn.ended` goes alone and the
 *  worker keeps looking without the lock, every SETTLE_POLL_MS for SETTLE_MS; past that
 *  the session's next hook looks (for DUE_MS; a later turn's end takes over anyway). */
export const SETTLE_FAST_MS = 400;
const SETTLE_STEP_MS = 25;
export const SETTLE_MS = 5000;
export const SETTLE_POLL_MS = 100;
const DUE_MS = 60_000;

/** What a turn's last words are remembered by while the transcript does not hold them yet
 *  (facts `transcript_due`): a digest, never the words, since facts are not redacted. */
export const wordsDigest = (text: string): string =>
  createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 16);

/** The turns of a transcript read that nothing more will be added to, and the line the
 *  cursor may move to once they are sent. `all`: every turn with a reply, as a session's
 *  end or a harness that names no last words takes them. Otherwise the last turn is whole
 *  only once its last words are the ones its Stop named (`due`, their digest), a later
 *  prompt closed it, or the person interrupted it; until then it is held back with the
 *  cursor before it, so it is sent once, whole, and never in two halves. `waiting`: the
 *  words `due` names are not in the file yet. Only a reader that says where its last turn
 *  starts (`tail`: Claude Code's) can have a turn held back or told closed; from any
 *  other, nothing goes but at `all`. */
export function closedTurns(
  read: TranscriptRead,
  o: { all?: boolean; due?: string | undefined },
): { turns: Turn[]; line: number; waiting: boolean } {
  const whole = !!o.all || (read.tail?.said !== undefined && wordsDigest(read.tail.said) === o.due);
  const waiting = !whole && o.due !== undefined;
  if (whole) return { turns: read.turns, line: read.line, waiting };
  if (!read.tail) return { turns: [], line: read.line, waiting };
  if (read.open || read.turns[read.turns.length - 1]?.interrupted)
    return { turns: read.turns, line: read.line, waiting };
  // The last turn may still be growing.
  return { turns: read.turns.slice(0, -1), line: read.tail.start, waiting };
}

/** One exchange of a transcript as its turn.transcript, numbered `turn`: what a worker
 *  sends after a live turn, and `sessionpipe backfill` for a turn no hook reported. */
export const transcriptTurn = (t: Turn, turn: number, harnessEvent: string): AdapterEvent => ({
  type: "turn.transcript",
  harnessEvent,
  data: {
    turn,
    user: t.user,
    assistant: t.assistant,
    at: new Date(t.at).toISOString(),
    ...(t.injected ? { injected: true as const } : {}),
  },
});

/** The session's transcript cursor once `sent`, the first turns of `read`, went out
 *  numbered up to `next`: `line` (where the next read starts), the next turn's number, and
 *  the last turn sent, when it is the last of the file, by its prompt's id and a digest of
 *  its last words (what a hook that comes late knows it went out by). */
export function cursorPast(read: TranscriptRead, sent: Turn[], line: number, next: number): Record<string, unknown> {
  const last = sent[sent.length - 1] as Turn;
  return {
    transcript_line: line,
    transcript_turns: next,
    ...(sent.length === read.turns.length && last.id && read.tail?.said !== undefined
      ? { transcript_sent: `${last.id}:${wordsDigest(read.tail.said)}` }
      : {}),
  };
}

/** An event as the outbox keeps it: its strings redacted at rest (advisory
 *  GHSA-8f6f-c3c9-j5p6). The tier-3 fields stay, with their secrets already gone;
 *  filterEvent runs the same idempotent pass again per sink. */
export const atRest = (e: Event): Event => ({ ...e, session: redactDeep(e.session), data: redactDeep(e.data) });

/** A sink that is not paused takes events of `tier`, under its receiver's cap. */
export const sinkAt = (sinks: readonly SinkConfig[], tier: number): boolean =>
  sinks.some((s) => !s.paused && Math.min(s.tier, s.max_tier ?? 3) >= tier);

/** What session.attended is read from, the desktop app's link included, and session.launched_by
 *  and delegated_by (hook.ts picks all five): the job's own, never the worker's. */
const JOB_OWN_ENV = [
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_HOST_SESSION_ID",
  "SESSIONPIPE_ASKED_BY",
  "SESSIONPIPE_CONTROL_JOB",
  "SESSIONPIPE_LAUNCHED_BY",
];

/** Run one hook job end to end: events → outbox → sinks. Returns what happened.
 *  `claimed` is the job file this run holds: released once the events are in the
 *  outbox or the job is back in the queue (`requeued` names its new file). */
export async function runJob(
  job: Job,
  opts: {
    state?: string;
    now?: number;
    claimed?: string;
    lockWaitMs?: number;
    /** false: the events go to the outbox and the sinks are left for the caller to drain. */
    drain?: boolean;
    /** The drain's clock (pacing); tests stand in a simulated one. */
    clock?: Clock;
  } & DrainLife = {},
): Promise<{ events: Event[]; delivered: Record<string, number>; requeued?: string }> {
  const state = opts.state ?? stateDir();
  const cfg = readConfig();
  const adapter = adapterByName(job.harness);
  // A hooks file can outlive the build that wrote it (an update to a sessionpipe without
  // that adapter, a hand-written entry): without this line the events are dropped in
  // silence, with nothing on the machine to say so.
  if (!adapter) {
    log(state, `${job.harness} ${job.event}: no adapter for harness "${job.harness}"; event dropped`);
    return { events: [], delivered: {} };
  }
  // Who attends a session, and who launched it, is the job's own word, never the worker's: a
  // worker another session's hook spawned (sweepJobs) carries that session's. A key the job
  // lacks stays absent.
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of JOB_OWN_ENV) delete env[k];
  const r = readHook(adapter, { argv: job.argv, stdin: job.stdin, env: { ...env, ...job.env }, cwd: job.cwd });
  // The adapter did not claim the payload (another harness ran our entry out of a
  // shared hooks file, an event name it does not map, a payload with no session id).
  // Dropped either way, but never in silence: this is where a wrongly-named event
  // lands, and the log is the only thing on the machine that can say so.
  if (!r || !r.session.id) {
    let keys: string[] = [];
    /** The size of a payload nothing could read: too big for the hook to hand on, or not JSON. */
    let unread = job.omitted_bytes;
    try {
      // Some hooks pass JSON in argv instead of stdin. Only the top-level names
      // belong in this default log: values can contain prompts, paths or secrets.
      const payload: unknown = JSON.parse(job.argv.find((a) => a.startsWith("{")) ?? job.stdin);
      if (payload && typeof payload === "object" && !Array.isArray(payload)) keys = Object.keys(payload);
    } catch {
      if (job.stdin) unread = Buffer.byteLength(job.stdin);
    }
    log(
      state,
      unread !== undefined
        ? `${job.harness} ${job.event}: the payload (${unread} bytes) could not be read${job.omitted_bytes !== undefined ? ", too big for the hook to hand on" : " as JSON"}; event dropped`
        : `${job.harness} ${job.event}: the ${job.harness} adapter did not claim this payload; event dropped; keys: ${keys.join(", ") || "(none)"}`,
    );
    return { events: [], delivered: {} };
  }
  // A session the control daemon started goes by the id its start command named, not
  // the one the harness picked (CONTROL.md §6 `start`; control/aliases.ts): its events
  // say so, and so does everything below. The adapter's own reading of the session
  // (facts, a remote URL) keeps the harness's id.
  const id =
    receiverIdOf(readAliases(aliasFile(path.join(state, "control"))), job.harness, r.session.id) ?? r.session.id;
  const claudeEnd = job.harness === "claude-code" && r.events.some((e) => e.type === "session.ended");
  // The control daemon learns each session's turn state and folder from its events (a
  // message for a session mid-turn waits for its Stop; a pending permission prompt
  // closes when the tool runs). A local round trip, and nothing when no daemon runs.
  const key = jobKey(job);
  // A copy of a hook event already run told the daemon when it ran: a Stop or a prompt
  // from minutes ago does not set a session's turn back. Read without the session's lock,
  // to spare the daemon the word; what is run is decided under it, below.
  const told = !!key && ranKeys(factsState(state).get(job.harness, id)).includes(key);
  if (!claudeEnd && !told) await tellDaemon(state, job, id, r.session.cwd, r.transcript, r.events);
  const outbox = new Outbox(state);
  const ref = { harness: job.harness, session: id };
  // Hooks of one session fire close together (parallel subagents, issue #9): poll
  // for the lock, often enough that its siblings can't keep taking it in between,
  // before giving the job back to the queue.
  let release = takeLock(state, ref);
  const lockWait = opts.lockWaitMs ?? LOCK_WAIT_MS;
  for (const until = Date.now() + lockWait; !release && Date.now() < until; ) {
    await new Promise((res) => setTimeout(res, 50));
    release = takeLock(state, ref);
  }
  /** The job went back to the queue while this worker was held up: it is another's now. */
  const givenBack = (): { events: Event[]; delivered: Record<string, number> } => {
    log(
      state,
      `${job.harness} ${job.event}: its job went back to the queue while this worker was held up; left to the worker that has it (${shortId(job.harness, id)})`,
    );
    return { events: [], delivered: {} };
  };
  if (!release) {
    if (!holdsClaim(opts.claimed)) return givenBack();
    log(state, `${job.harness} ${job.event}: session ${id} locked for ${lockWait / 1000} s, re-queued`);
    const requeued = enqueueJob(state, { ...job, tries: (job.tries ?? 0) + 1 });
    releaseJob(opts.claimed);
    return { events: [], delivered: {}, requeued };
  }
  if (!holdsClaim(opts.claimed)) {
    release();
    return givenBack();
  }
  const events: Event[] = [];
  const clock = opts.clock ?? REAL_CLOCK;
  /** Set when a turn ended before its last words reached the transcript: the rest of the
   *  wait, run once the lock is released and the turn's end is on its way. */
  let settle: ((send: () => Promise<void>) => Promise<void>) | null = null;
  try {
    const facts = factsState(state);
    const mem = facts.get(job.harness, id);
    // A hook event just run is not run again. Its job can be in the queue twice (a worker
    // held up past its claim and the one that took the job over; a worker killed between
    // writing the events and letting go of the claim; the copies an older sessionpipe made
    // of a job two workers both put back), and every run of it comes here, under the
    // session's lock, where the first one wrote the event down as run. The session
    // remembers RAN_KEPT of them: a copy that comes up later than that is sent again.
    if (key && ranKeys(mem).includes(key)) {
      facts.save(job.harness, id, { ran: ranWith(mem, key) });
      releaseJob(opts.claimed);
      log(
        state,
        `${job.harness} ${job.event}: a copy of a hook event already run; dropped (${shortId(job.harness, id)})`,
      );
      return { events: [], delivered: {} };
    }
    // `claude mcp list` fires SessionEnd with a fresh id but no SessionStart or
    // transcript. Check under the session lock, before creating facts or a seq:
    // any existing outbox, facts or transcript is enough to preserve a real end.
    if (
      claudeEnd &&
      !existsSync(outbox.file(ref)) &&
      Object.keys(mem).length === 0 &&
      !(r.transcript && existsSync(r.transcript))
    ) {
      releaseJob(opts.claimed);
      return { events: [], delivered: {} };
    }
    if (claudeEnd) await tellDaemon(state, job, id, r.session.cwd, r.transcript, r.events);
    // Heartbeat-class events read no facts (they fire every tool call); the rest refresh them.
    const heavy = !/^(PreToolUse|PostToolUse|PostToolUseFailure|BeforeTool|AfterTool|PostInvocation)$/.test(job.event);
    let learned: Partial<Session> = {};
    if (heavy) {
      // The hook's environment, not the worker's: a swept job may be run by a worker
      // another harness's hook spawned, whose env names none of this harness's homes.
      const hookEnv = { ...process.env, ...job.env };
      const f = adapter.facts(r.session, r.transcript, r.hints ?? {}, facts, hookEnv);
      // A name only the harness's own service knows (claude.ai's): a round trip with the
      // person's sign-in, so only when they turned it on (`sessionpipe titles on`).
      if (cfg.remote_titles && adapter.remoteFacts)
        Object.assign(f, await adapter.remoteFacts(r.session, f, r.transcript, facts, hookEnv));
      const { started_at: _s, last_at: _l, first_ask: _fa, harness_version, ...rest } = f;
      learned = rest;
      if (harness_version) facts.save(job.harness, id, { harness_version });
      facts.save(job.harness, id, { session: { ...(mem.session as object), ...learned } });
      // Antigravity's transcript never says which folder a conversation runs in, and
      // Devin's payload names none either (only DEVIN_PROJECT_DIR in the hook's env);
      // the hooks do. Kept raw (this file is the machine's own, 0600), so the control
      // daemon still knows where to resume it after a restart.
      if (CWD_FROM_HOOKS.has(job.harness) && r.session.cwd && path.isAbsolute(r.session.cwd))
        facts.save(job.harness, id, { cwd: r.session.cwd });
    }
    const known = (mem.session as Partial<Session> | undefined) ?? {};
    const cwdRaw = learned.cwd ?? r.session.cwd ?? known.cwd;
    const git = heavy ? gitFacts(cwdRaw) : {};
    const session: Session = {
      ...known,
      ...learned,
      ...git,
      ...(learned.branch ? { branch: learned.branch } : {}),
      id,
      seq: 0,
      machine: machineName(cfg, os.hostname()),
      ...(cwdRaw ? { cwd: tilde(cwdRaw) } : {}),
      ...(r.session.model ? { model: r.session.model } : {}),
      ...(r.session.effort ? { effort: r.session.effort } : {}),
      ...(r.session.launched_by ? { launched_by: r.session.launched_by } : {}),
      ...(r.session.delegated_by ? { delegated_by: r.session.delegated_by } : {}),
    };
    const version = (facts.get(job.harness, id).harness_version as string | undefined) ?? undefined;
    const at = opts.now ?? job.at;
    /** An event of this job, with the session's next seq. */
    const stamp = (a: AdapterEvent): Event =>
      makeEvent(a, {
        harness: { name: job.harness, ...(version ? { version } : {}) },
        session: { ...session, seq: outbox.nextSeq(ref) },
        now: at,
      });
    const transcript = sinkAt(cfg.sinks, 2) ? r.transcript : undefined;
    const ending = r.events.some((e) => e.type === "turn.ended" || e.type === "session.ended");
    const starting = r.events.some((e) => e.type === "turn.started");
    // A message sent while a turn runs is absorbed by that turn, and Claude Code reports
    // it as a prompt with the running turn's own id. It is not a new turn: where it
    // belongs is the transcript's to say, so its text is no reading of its own.
    const startedId = r.events.find((e) => e.type === "turn.started")?.data.turn_id;
    const before = facts.get(job.harness, id);
    const absorbed = starting && typeof startedId === "string" && before.open_turn === startedId;
    /** Tier 2: the transcript's turns from the delivery cursor that nothing more will be
     *  added to, as turn.transcript events, the cursor moved past them (before they reach
     *  the outbox, so a turn is never sent twice). `open`: the turn the hooks still hold
     *  as running; when the transcript says the person interrupted it, its `turn.ended`
     *  goes first, since no hook fired one. `named`: the prompt id of the turn whose last
     *  words `due` are, as its Stop names it. */
    const turnEvents = (
      file: string,
      o: { all?: boolean; due?: string | undefined; open?: string | undefined; named?: string | undefined },
    ) => {
      const cur = facts.get(job.harness, id);
      let turnNo = Number(cur.transcript_turns) || 0;
      const read = adapter.readTranscript(file, Number(cur.transcript_line) || 0);
      const c = closedTurns(read, o);
      // A hook that comes late finds its turn gone out: a sibling's worker took the lock
      // first (a session's end fires within milliseconds of a headless run's Stop, and
      // sends every turn). The last turn sent had this Stop's prompt id and these last
      // words, and nothing after the cursor is that prompt's, so there is nothing to wait
      // for. Without an id on both sides it cannot be told from a turn that says the same
      // words as the one before it, and the wait stands.
      const gone =
        c.waiting &&
        o.named !== undefined &&
        cur.transcript_sent === `${o.named}:${o.due}` &&
        !read.turns.length &&
        (!read.open || (read.open.id !== undefined && read.open.id !== o.named));
      const waiting = c.waiting && !gone;
      // A look between two hooks leaves alone the turn the hooks still hold as running,
      // unless the person interrupted it: its own end is on its way (its worker lost the
      // lock to this one) and sends it, after its turn.ended. So are the turns after it.
      const held = o.open === undefined ? -1 : c.turns.findIndex((t) => t.id === o.open && !t.interrupted);
      const turns = held < 0 ? c.turns : c.turns.slice(0, held);
      const out: Event[] = [];
      for (const t of turns) {
        if (t.interrupted && o.open !== undefined && t.id === o.open) {
          out.push(
            stamp({ type: "turn.ended", harnessEvent: job.event, data: { turn_id: o.open, reason: "interrupt" } }),
          );
          facts.save(job.harness, id, { open_turn: null });
        }
        out.push(stamp(transcriptTurn(t, turnNo++, job.event)));
      }
      const last = turns[turns.length - 1];
      // With a turn left alone the cursor stops after the last one sent: the rows between
      // it and the next turn are no message. `transcript_sent` is what `gone` above knows
      // the last turn by.
      if (last) facts.save(job.harness, id, cursorPast(read, turns, held < 0 ? c.line : last.endLine + 1, turnNo));
      // The words a turn's end was waiting for are in (or nothing waits): the wait is over.
      if (!waiting && cur.transcript_due != null) facts.save(job.harness, id, { transcript_due: null });
      return { events: out, waiting };
    };
    // What the transcript settled since the session's last hook goes first: a turn whose
    // last words were not in the file when it ended (and not within SETTLE_MS after), and
    // a turn the person interrupted, which no hook ends. The interrupted one is looked for
    // where a turn can no longer be running: at the next prompt, a compaction, a start.
    const dueBefore =
      typeof before.transcript_due === "string" && at - Number(before.transcript_due_at) < DUE_MS
        ? before.transcript_due
        : undefined;
    const openBefore = typeof before.open_turn === "string" && !absorbed ? before.open_turn : undefined;
    if (
      transcript &&
      heavy &&
      !ending &&
      (dueBefore !== undefined ||
        (openBefore !== undefined &&
          r.events.some(
            (e) => e.type === "turn.started" || e.type === "context.compacted" || e.type === "session.started",
          )))
    )
      events.push(...turnEvents(transcript, { due: dueBefore, open: openBefore }).events);
    for (const a of r.events) events.push(stamp(a));
    // Tier 2, while a turn runs: what it has said so far, so a receiver can show a long
    // turn before it ends. On the prompt, then at most every PROGRESS_MS on a tool call,
    // and only when it changed. The cursor stays where it is: turn.transcript still
    // delivers the whole turn when it ends.
    if (transcript && !ending && (starting || r.events.some((e) => e.type === "tool.ended"))) {
      const cur = facts.get(job.harness, id);
      if (starting || at - (Number(cur.progress_at) || 0) >= PROGRESS_MS) {
        const p = openTurn(adapter.readTranscript(transcript, Number(cur.transcript_line) || 0), {
          base: Number(cur.transcript_turns) || 0,
          prompt: !absorbed && typeof r.hints?.prompt === "string" ? r.hints.prompt : undefined,
          at,
        });
        const sig = p && `${p.turn}:${p.user.length}:${p.assistant.length}`;
        if (p && (starting || sig !== cur.progress_sig)) {
          events.push(
            stamp({ type: "turn.progress", harnessEvent: job.event, data: { ...p, at: new Date(p.at).toISOString() } }),
          );
          facts.save(job.harness, id, { progress_at: at, progress_sig: sig });
        }
        // A look that found nothing new is a look all the same, and the next is PROGRESS_MS
        // away. A session waiting on its own subagents says nothing for hours while each
        // of their tool calls lands here: unstamped, every one of them read its whole
        // transcript again under the session's lock, and its jobs fell behind for good.
        else facts.save(job.harness, id, { progress_at: at });
      }
    }
    // The turn running now, by its prompt's id, until it ends (for `absorbed`).
    if (starting && typeof startedId === "string" && !absorbed) facts.save(job.harness, id, { open_turn: startedId });
    if (ending) facts.save(job.harness, id, { open_turn: null });
    // Tier 2: after a turn ends, the transcript's new turns become turn.transcript events.
    // A Stop that names the turn's last words is held to them (see SETTLE_FAST_MS): a
    // swept job is seconds old, so it reads once.
    if (transcript && ending) {
      const final =
        r.events.some((e) => e.type === "turn.ended") && typeof r.hints?.final === "string" && existsSync(transcript)
          ? wordsDigest(r.hints.final)
          : undefined;
      const named = r.events.find((e) => e.type === "turn.ended")?.data.turn_id;
      const how = { all: final === undefined, due: final, named: typeof named === "string" ? named : undefined };
      let got = turnEvents(transcript, how);
      events.push(...got.events);
      for (
        const until = ticksOf(clock) + SETTLE_FAST_MS;
        got.waiting && opts.drain !== false && ticksOf(clock) < until;
      ) {
        await clock.sleep(SETTLE_STEP_MS);
        got = turnEvents(transcript, how);
        events.push(...got.events);
      }
      if (got.waiting) {
        facts.save(job.harness, id, { transcript_due: final, transcript_due_at: at });
        if (opts.drain !== false)
          settle = async (send) => {
            // The budget is counted in ticks; the worker's deadline is a time of day, and
            // is only ever a reason to stop sooner.
            const until = ticksOf(clock) + SETTLE_MS;
            while (
              ticksOf(clock) + SETTLE_POLL_MS <= until &&
              (opts.deadline === undefined || clock.now() + SETTLE_POLL_MS + PASS_BUDGET_MS <= opts.deadline)
            ) {
              await clock.sleep(SETTLE_POLL_MS);
              // A sibling hook has the session: it looks for the words itself, or the next round does.
              const again = takeLock(state, ref);
              if (!again) continue;
              let late: { events: Event[]; waiting: boolean };
              try {
                // Another hook of the session found them meanwhile, or a later turn ended
                // and the wait is that turn's now.
                if (facts.get(job.harness, id).transcript_due !== final) return;
                late = turnEvents(transcript, how);
                if (late.events.length) {
                  outbox.append(ref, late.events.map(atRest));
                  log(
                    state,
                    `${job.harness} ${job.event}: ${late.events.map((e) => e.type).join(",")}, once the transcript held it (${shortId(job.harness, id)})`,
                  );
                }
              } finally {
                again();
              }
              if (late.events.length) {
                events.push(...late.events);
                await send();
              }
              if (!late.waiting) return;
            }
            log(
              state,
              `${job.harness} ${job.event}: the turn's last words are not in the transcript ${SETTLE_MS / 1000} s on; its turn.transcript waits for the session's next hook (${shortId(job.harness, id)})`,
            );
          };
      }
    }
    // Tier 1: the account's limits, when the turn left new numbers in the transcript
    // (Codex's rollout; Claude Code's come from its status line, through fromHook).
    if (adapter.limits && r.transcript && ending && sinkAt(cfg.sinks, 1)) {
      const limits = adapter.limits(r.transcript);
      const sig = limits && JSON.stringify(limits);
      if (limits && sig !== facts.get(job.harness, id).limits_sig) {
        events.push(stamp({ type: "limits.observed", harnessEvent: job.event, data: limits }));
        facts.save(job.harness, id, { limits_sig: sig });
      }
    }
    outbox.append(ref, events.map(atRest));
    // Written down as run only once its events are in the outbox: a worker that ends
    // before this line leaves a job that is run again, never one that is skipped.
    if (key && events.length) facts.save(job.harness, id, { ran: ranWith(facts.get(job.harness, id), key) });
    releaseJob(opts.claimed);
    log(
      state,
      `${job.harness} ${job.event}: ${events.map((e) => e.type).join(",") || "nothing"} (${shortId(job.harness, id)})`,
    );
  } finally {
    release();
  }
  // The session's lock covered the append; the sinks drain without it (the outbox
  // reader leaves a line still being written), so a sibling hook isn't held out for
  // a round trip. A prune holds the `flush` lock, so it goes first: a worker that
  // found the lock taken meanwhile left its events and a `flush.more` mark, and this
  // drain sends them.
  if (Math.random() < 0.02) outbox.prune(cfg.keep_days ?? 30);
  const delivered: Record<string, number> = {};
  const send = async (): Promise<void> => {
    const sent =
      (await drain(state, cfg.sinks, outbox, ref, {
        ...(opts.clock ? { clock: opts.clock } : {}),
        ...(opts.deadline !== undefined ? { deadline: opts.deadline } : {}),
        ...(opts.handoff ? { handoff: opts.handoff } : {}),
      })) ?? {};
    for (const [sink, n] of Object.entries(sent)) delivered[sink] = (delivered[sink] ?? 0) + n;
  };
  if (opts.drain !== false) await send();
  // The turn's end is on its way; its words follow as soon as the transcript holds them.
  if (settle) await (settle as (send: () => Promise<void>) => Promise<void>)(send);
  return { events, delivered };
}

/** One event for a session with no hook behind it: the pool's `limits.observed`, when
 *  the daemon read an account's numbers off a request the session made (pool/index.ts
 *  `onLimits`). It goes the way a hook's events go — only with a tier-1 sink, the
 *  session's known facts for `session` (its own account_id included), redacted at rest,
 *  under the session's lock, then the sinks drain — so a receiver can't tell it from
 *  the status line's. A hook holding the session's lock (its events are being written
 *  right then) is waited for, up to `lockWaitMs`; past that the numbers are dropped
 *  with a line in the log, never in silence (the live proof lost a turn's switch that
 *  way). Null: no sink wants it, or the session stayed busy. */
export async function appendObserved(
  state: string,
  harness: string,
  id: string,
  data: DataOf<"limits.observed">,
  opts: { now?: number; lockWaitMs?: number } = {},
): Promise<Event | null> {
  const cfg = readConfig();
  if (!sinkAt(cfg.sinks, 1)) return null;
  const outbox = new Outbox(state);
  const ref = { harness, session: id };
  let release = takeLock(state, ref);
  for (const until = Date.now() + (opts.lockWaitMs ?? OBSERVED_LOCK_WAIT_MS); !release && Date.now() < until; ) {
    await new Promise((res) => setTimeout(res, 50));
    release = takeLock(state, ref);
  }
  if (!release) {
    log(state, `${harness} limits.observed for ${shortId(harness, id)} dropped: the session is busy`);
    return null;
  }
  const now = opts.now ?? Date.now();
  let e: Event;
  try {
    const facts = factsState(state);
    const mem = facts.get(harness, id);
    const known = (mem.session as Partial<Session> | undefined) ?? {};
    const version = mem.harness_version as string | undefined;
    e = makeEvent(
      { type: "limits.observed", harnessEvent: "pool", data },
      {
        harness: { name: harness, ...(version ? { version } : {}) },
        session: { ...known, id, seq: outbox.nextSeq(ref), machine: machineName(cfg, os.hostname()) },
        now,
      },
    );
    outbox.append(ref, [atRest(e)]);
  } finally {
    release();
  }
  await drain(state, cfg.sinks, outbox, ref);
  return e;
}

/** What the drain reads the time from and waits with; tests stand in a simulated one. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Milliseconds that only go forward, from any origin: what a wait's budget is counted
   *  in, since `now` is the wall clock and a wait measured by it lasts as long again as
   *  the clock is set back. A clock without one counts by `now`. */
  ticks?(): number;
}
const REAL_CLOCK: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  ticks: () => performance.now(),
};
const ticksOf = (clock: Clock): number => (clock.ticks ? clock.ticks() : clock.now());

/** A pass of the drain starts at least this long after the machine's last request to
 *  a receiver (issue #208): under a few hundred subagents a receiver gets one request
 *  a second with everything that piled up, not one per hook. A lone event goes at once. */
export const PACE_MS = 1000;
/** <state>/locks/flush.sent: when this machine last sent a request to a receiver
 *  (epoch ms), written as the request leaves. Every worker reads the same file. */
const sentFile = (state: string): string => path.join(state, "locks", "flush.sent");
function lastSent(state: string): number {
  try {
    // Unreadable text is NaN, and a NaN wait waits for nothing.
    return Number(readFileSync(sentFile(state), "utf8"));
  } catch {
    return 0;
  }
}
function noteSent(state: string, at: number): void {
  try {
    mkdirSync(path.dirname(sentFile(state)), { recursive: true, mode: 0o700 });
    writeFileSync(sentFile(state), String(at), { mode: 0o600 });
  } catch {}
}

/** Whether a receiver (an HTTP sink not paused and not in backoff) has outbox bytes
 *  past its cursor: the pass that follows may send it a request. Bytes it will skip
 *  (a thinned tool event) count too; reading them is the pass's job. */
function waitingForReceiver(state: string, sinkConfigs: SinkConfig[], outbox: Outbox, now: number): boolean {
  const receivers = sinkConfigs.filter(
    (s) => !s.paused && /^https?:\/\//.test(s.url) && !((readBackoff(state, s.name)?.until ?? 0) > now),
  );
  if (!receivers.length) return false;
  const refs = outbox.sessions();
  for (const s of receivers) {
    const cursors = new Cursors(state, s.name);
    const c = cursors.read();
    for (const ref of refs) {
      try {
        if (statSync(outbox.file(ref)).size > (c[cursors.key(ref)] ?? 0)) return true;
      } catch {}
    }
  }
  return false;
}

/** How long a worker's life must still run for a pass of the drain to start: the
 *  pace's wait (≤ PACE_MS) and a round trip. A worker that has less leaves the work
 *  marked (flush.more) and hands it on (DrainLife.handoff) rather than be ended by its
 *  deadline mid-pass, holding events nobody else knows to send. */
export const PASS_BUDGET_MS = 3000;
/** How long a swept job waits for its session's lock before it goes back to the queue. */
const SWEEP_LOCK_WAIT_MS = 1000;

/** A worker's remaining life, for the drain and the sweep. Both unset: no limit. */
export interface DrainLife {
  /** When the process will be ended (epoch ms, on the drain's clock). */
  deadline?: number;
  /** Called, with the flush lock released, when work is left marked for another
   *  worker because this one's life is too short for it (worker.ts starts a drainer). */
  handoff?: () => void;
}

const moreFile = (state: string): string => path.join(state, "locks", "flush.more");
/** Tell the worker draining now (if any) that the outbox has more for it. */
function markMore(state: string): void {
  try {
    mkdirSync(path.dirname(moreFile(state)), { recursive: true, mode: 0o700 });
    writeFileSync(moreFile(state), "", { mode: 0o600 });
  } catch {}
}

/** One worker drains a machine's sinks at a time (the `flush` lock). Another whose
 *  events are in the outbox meanwhile marks that there is more and leaves them to
 *  it (null: nothing sent by this one). The one draining looks for the mark after
 *  each pass, once it has let the lock go, so events appended during a pass go out
 *  in its next pass or with the worker that appended them, never wait for a later
 *  hook. Under a flood of hook events this is one uploader sending full batches,
 *  not one per event, all refused together (mordast, 2026-10-14: 828 refusals in
 *  two minutes, 5 192 jobs queued). A pass that would follow the machine's last
 *  request by less than PACE_MS first waits out the rest, holding the lock: the
 *  workers that arrive meanwhile only mark that there is more, and the pass sends
 *  everything they appended. A pass starts only while the worker's life has
 *  PASS_BUDGET_MS left; otherwise the mark stays and the work is handed on. */
export async function drain(
  state: string,
  sinkConfigs: SinkConfig[],
  outbox: Outbox,
  first?: { harness: string; session: string },
  o: { clock?: Clock } & DrainLife = {},
): Promise<Record<string, number> | null> {
  const clock = o.clock ?? REAL_CLOCK;
  const more = moreFile(state);
  let release = takeNamedLock(state, "flush");
  if (!release) {
    markMore(state);
    release = takeNamedLock(state, "flush");
    if (!release) return null;
  }
  const delivered: Record<string, number> = {};
  for (;;) {
    if (o.deadline !== undefined && clock.now() + PASS_BUDGET_MS > o.deadline) {
      markMore(state);
      release();
      o.handoff?.();
      return delivered;
    }
    try {
      // Never more than PACE_MS: a stamp in the future (a clock set back) can't park it.
      // A pass with nothing for a receiver (a file sink's events, a cursor already at
      // the end) doesn't wait at all.
      const wait = Math.min(PACE_MS, lastSent(state) + PACE_MS - clock.now());
      if (wait > 0 && waitingForReceiver(state, sinkConfigs, outbox, clock.now())) await clock.sleep(wait);
      try {
        unlinkSync(more);
      } catch {}
      for (const [k, v] of Object.entries(await flush(state, sinkConfigs, outbox, first, { clock })))
        delivered[k] = (delivered[k] ?? 0) + v;
    } finally {
      release();
    }
    if (!existsSync(more)) return delivered;
    release = takeNamedLock(state, "flush");
    if (!release) return delivered;
  }
}

/** HTTP.md §2: a sink that answered 429 isn't tried again before its `retry-after`;
 *  one that was unreachable (5xx, a timeout) waits 2 s · 10 s · 60 s · 5 min · 30 min,
 *  then every 30 min. Kept in <state>/backoff/<sink>.json, so every worker on the
 *  machine waits, not only the one that was refused. Cleared by the next batch the
 *  sink takes. */
export interface Backoff {
  until: number;
  failures: number;
  why: string;
}
const BACKOFF_MS = [2_000, 10_000, 60_000, 5 * 60_000, 30 * 60_000];
const backoffFile = (state: string, sink: string): string => path.join(state, "backoff", `${safeId(sink)}.json`);
export function readBackoff(state: string, sink: string): Backoff | null {
  try {
    const b = JSON.parse(readFileSync(backoffFile(state, sink), "utf8")) as Backoff;
    return typeof b.until === "number" ? b : null;
  } catch {
    return null;
  }
}
function noteFailure(state: string, sink: string, res: DeliveryResult, prev: Backoff | null): Backoff {
  const failures = (prev?.failures ?? 0) + 1;
  const ladder = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1] as number;
  const wait = Number.isFinite(res.retryAfterMs) ? (res.retryAfterMs as number) : ladder;
  const b = { until: Date.now() + wait, failures, why: `${res.status ?? ""} ${res.error ?? ""}`.trim() };
  const f = backoffFile(state, sink);
  try {
    mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    writeFileSync(f, JSON.stringify(b), { mode: 0o600 });
  } catch {}
  return b;
}
function clearBackoff(state: string, sink: string): void {
  try {
    unlinkSync(backoffFile(state, sink));
  } catch {}
}

/** How long a job waits for its session's lock before it goes back to the queue. */
const LOCK_WAIT_MS = 6000;
/** How long the pool's limits.observed waits for a hook that holds the session. */
const OBSERVED_LOCK_WAIT_MS = 2000;
/** Harnesses whose own files do not name the session's folder: the hooks' cwd is kept. */
const CWD_FROM_HOOKS = new Set(["antigravity", "devin"]);

const BATCH = 50;
const MAX_PER_RUN = 500;

/** Drain every sink from its cursor: this session first, then any backlog. Events
 *  from many sessions are packed into one batch of up to BATCH, so a first
 *  install's 400-session backfill is nine POSTs, not four hundred (the receiver's
 *  write limit ended the first replay at 278 events, 2026-09-28). A cursor moves
 *  only after its batch was acknowledged; a refused batch stops the sink for this
 *  run and the next worker starts from the same cursors. The sinks drain at once:
 *  the session's lock is held for the slowest round trip, not the sum of them (a
 *  verdict's config write is synchronous, so two sinks' never interleave). */
export async function flush(
  state: string,
  sinkConfigs: SinkConfig[],
  outbox: Outbox,
  first?: { harness: string; session: string },
  o: {
    /** Try a sink in backoff anyway (`sessionpipe replay`). */ force?: boolean;
    /** Stamps the machine's last request (drain's pace). */ clock?: Clock;
    /** Counts, per sink, the tool events it was configured not to be sent (`replay`). */
    thinned?: Record<string, number>;
  } = {},
): Promise<Record<string, number>> {
  const delivered: Record<string, number> = {};
  const clock = o.clock ?? REAL_CLOCK;
  const sinks = buildSinks(sinkConfigs, {
    locked: (name) => log(state, `sink ${name}: its token is in a keychain this process can't read; left for later`),
  });
  const modes = new Map(sinkConfigs.map((s) => [s.name, toolsMode(s)]));
  const refs = outbox.sessions();
  if (first) {
    const k = `${first.harness}/${safeId(first.session)}`;
    refs.sort((a, b) => (`${a.harness}/${a.session}` === k ? -1 : `${b.harness}/${b.session}` === k ? 1 : 0));
  }
  // A session file this process can't read (a 0600 file a hook left as another user
  // under the same HOME, EACCES; a folder named <id>.jsonl, EISDIR on macOS and Linux,
  // while Windows stats a folder at 0 bytes and reads it as empty) is skipped with a
  // line in the log, and the other sessions still go out to every sink; before, the
  // error threw out of `flush`, so no sink took the sessions listed after that file,
  // and nothing was logged. Its cursors stay where they were, so a file readable again
  // is taken from there on the next drain. Logged once per flush pass, not once per
  // sink (the sinks drain at once), and again on every pass while the file stays
  // unreadable. Only a system error (one with a code) is a skip; anything else is a
  // bug and throws as before.
  const unreadable = new Set<string>();
  const readOrSkip = (ref: OutboxRef, offset: number, room: number): { events: Event[]; offset: number } | null => {
    try {
      return outbox.read(ref, offset, room);
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      if (typeof code !== "string") throw e;
      const f = outbox.file(ref);
      if (!unreadable.has(f)) {
        unreadable.add(f);
        log(state, `drain: can't read ${f} (${code}); skipped, its cursors stay`);
      }
      return null;
    }
  };
  const drainSink = async (sink: Sink): Promise<void> => {
    let backoff = readBackoff(state, sink.name);
    if (backoff && !o.force && backoff.until > Date.now()) {
      delivered[sink.name] = 0;
      return;
    }
    const cursors = new Cursors(state, sink.name);
    const c = cursors.read();
    // Issue #208: the tool events this sink is not sent are skipped here, the cursor
    // moving over them. The clock moves with the cursor, only once a batch went
    // through, so a refused batch's tool event is chosen again next time.
    const mode = modes.get(sink.name) as ToolsMode; // buildSinks names each sink after its config
    const tools = new ToolClock(state, sink.name);
    let clockNow = mode === "all" ? {} : tools.read();
    let clockNext = { ...clockNow };
    let sent = 0;
    let stalled = false;
    // Pull filtered events session by session into one batch; remember where each
    // session's offset would land if the batch goes through.
    let batch: Event[] = [];
    let pending: Record<string, number> = {};
    // HTTP.md §2 413: halve the batch and try again; one event too large on its own
    // is dropped and logged. A half the receiver drops (400) is dropped and logged on
    // its own, and the other half is still sent: the 400 answered that half, not the
    // batch. A half that is refused for another reason stops the run like any
    // refusal: the cursor stays, and the halves that went through are sent again
    // next time (the receiver counts them as duplicates).
    const deliver = async (events: Event[]): Promise<DeliveryResult> => {
      if (sink instanceof HttpSink) noteSent(state, clock.now());
      const res = await sink.send(events);
      if (res.ok || res.action !== "split") return res;
      if (events.length === 1) {
        const e = events[0] as Event;
        log(state, `sink ${sink.name}: 413 ${res.error ?? ""} → event ${e.id} (${e.type}) is too large alone, dropped`);
        return { ok: true, acknowledged: 0, accepted: 0, duplicates: 0, rejected: [{ id: e.id, reason: "too_large" }] };
      }
      const part = async (some: Event[]): Promise<DeliveryResult> => {
        const r = await deliver(some);
        if (r.ok || r.action !== "drop") return r;
        log(
          state,
          `sink ${sink.name}: ${r.status ?? ""} ${r.error ?? ""} → drop, ${some.length} of ${events.length} events`,
        );
        const rejected = some.map((e) => ({ id: e.id, reason: "dropped" }));
        return { ok: true, acknowledged: 0, accepted: 0, duplicates: 0, rejected };
      };
      const half = Math.ceil(events.length / 2);
      const a = await part(events.slice(0, half));
      if (!a.ok) return a;
      const b = await part(events.slice(half));
      if (!b.ok) return b;
      return {
        ok: true,
        acknowledged: a.acknowledged + b.acknowledged,
        accepted: (a.accepted ?? 0) + (b.accepted ?? 0),
        duplicates: (a.duplicates ?? 0) + (b.duplicates ?? 0),
        rejected: [...(a.rejected ?? []), ...(b.rejected ?? [])],
      };
    };
    const commitClock = (): void => {
      if (mode === "all" || JSON.stringify(clockNext) === JSON.stringify(clockNow)) return;
      tools.write(clockNext);
      clockNow = { ...clockNext };
    };
    const send = async (): Promise<boolean> => {
      if (!batch.length) {
        Object.assign(c, pending);
        pending = {};
        cursors.write(c);
        commitClock();
        return true;
      }
      const res = await deliver(batch);
      if (!res.ok) {
        const action = res.action ?? "retry";
        let wait = "";
        if (action === "retry") {
          backoff = noteFailure(state, sink.name, res, backoff);
          wait = `, waits ${Math.round((backoff.until - Date.now()) / 1000)} s`;
        }
        log(state, `sink ${sink.name}: ${res.status ?? ""} ${res.error ?? ""} → ${action}${wait}`);
        if (res.action === "pause" || res.action === "lower-tier") applySinkVerdict(sink.name, res);
        if (res.action !== "drop") {
          batch = [];
          pending = {};
          clockNext = { ...clockNow };
          return false;
        }
      } else if (backoff) {
        clearBackoff(state, sink.name);
        backoff = null;
      }
      sent += batch.length;
      Object.assign(c, pending);
      cursors.write(c);
      commitClock();
      batch = [];
      pending = {};
      return true;
    };
    for (const ref of refs) {
      if (stalled || sent >= MAX_PER_RUN) break;
      let offset = pending[cursors.key(ref)] ?? c[cursors.key(ref)] ?? 0;
      for (;;) {
        const room = BATCH - batch.length;
        const read = readOrSkip(ref, offset, room);
        if (!read) break;
        const { events, offset: next } = read;
        if (!events.length) break;
        for (const e of events) {
          const f = filterEvent(e, sink.tier, sink.pii, { home: os.homedir() });
          if (!f) continue;
          if (sendTool(f, mode, clockNext, cursors.key(ref))) batch.push(f);
          else if (o.thinned) o.thinned[sink.name] = (o.thinned[sink.name] ?? 0) + 1;
        }
        offset = next;
        pending[cursors.key(ref)] = offset;
        if (batch.length >= BATCH) {
          if (!(await send())) {
            stalled = true;
            break;
          }
          if (sent >= MAX_PER_RUN) break;
        }
      }
    }
    if (!stalled && (batch.length || Object.keys(pending).length)) if (!(await send())) stalled = true;
    delivered[sink.name] = sent;
  };
  await Promise.all(sinks.map(drainSink));
  return delivered;
}

function applySinkVerdict(name: string, res: { action?: string; max_tier?: number; error?: string }): void {
  try {
    const cfg = readConfig();
    const s = cfg.sinks.find((x) => x.name === name);
    if (!s) return;
    if (res.action === "pause") s.paused = `${new Date().toISOString()} ${res.error ?? "unauthorized"}`;
    if (res.action === "lower-tier" && typeof res.max_tier === "number") s.max_tier = res.max_tier as 0 | 1 | 2 | 3;
    writeConfig(cfg);
  } catch {}
}

export { VERSION };
export const versionLine = (): string => `sessionpipe ${VERSION}`;
export const jobsDir = (state: string): string => path.join(state, "jobs");
export const hasJobs = (state: string): boolean => existsSync(jobsDir(state));
