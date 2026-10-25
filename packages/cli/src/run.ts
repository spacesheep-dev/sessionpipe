// SPDX-License-Identifier: Apache-2.0
// What a worker run does, as a function so tests and `sessionpipe replay` share it.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  adapterByName,
  Cursors,
  capTail,
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
  processAlive,
  readConfig,
  redactDeep,
  type Session,
  type Sink,
  type SinkConfig,
  StdoutSink,
  safeId,
  shortId,
  stateDir,
  type TranscriptRead,
  takeLock,
  takeNamedLock,
  tilde,
  writeConfig,
} from "@sessionpipe/core";
import { aliasFile, readAliases, receiverIdOf } from "./control/aliases.js";
import { ask, socketPath } from "./control/local.js";
import { HttpSink } from "./http-sink.js";
import { sinkWithSecrets } from "./secrets.js";

async function tellDaemon(
  state: string,
  job: Job,
  session: string,
  cwd: string | undefined,
  transcript?: string,
): Promise<void> {
  const sock = socketPath(state);
  if (process.platform !== "win32" && !existsSync(sock)) return;
  await ask(
    sock,
    {
      op: "event",
      session: `${job.harness}:${session}`,
      event: job.event,
      ...(cwd ? { cwd } : {}),
      ...(transcript ? { transcript } : {}),
    },
    300,
  );
}

declare const __SESSIONPIPE_VERSION__: string;
const VERSION = typeof __SESSIONPIPE_VERSION__ === "string" ? __SESSIONPIPE_VERSION__ : "0.0.0";

export interface Job {
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
  try {
    return { job: JSON.parse(readFileSync(claimed, "utf8")) as Job, file: claimed };
  } catch {
    releaseJob(claimed);
    return null;
  }
}
export function releaseJob(claimed: string | undefined): void {
  if (!claimed) return;
  try {
    unlinkSync(claimed);
  } catch {}
}

/** Jobs another worker left behind: a claim whose worker is gone (or older than any
 *  worker lives, `abandonedMs`) goes back to the queue, then every queued job older
 *  than `olderThanMs` (younger ones belong to the worker their hook just spawned)
 *  is claimed and run. Every worker sweeps before it exits. */
export async function sweepJobs(state: string, olderThanMs = 3000, limit = 20, abandonedMs = 60_000): Promise<number> {
  const jobs = jobsDir(state);
  let names: string[] = [];
  try {
    names = readdirSync(jobs);
  } catch {
    return 0;
  }
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
  for (const n of queued.sort().slice(0, limit)) {
    const f = path.join(jobs, n);
    try {
      if (Date.now() - statSync(f).mtimeMs < olderThanMs) continue;
    } catch {
      continue;
    }
    const c = claimJob(f);
    if (!c) continue;
    try {
      await runJob(c.job, { state, claimed: c.file });
    } catch {
    } finally {
      releaseJob(c.file);
    }
    ran++;
  }
  return ran;
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
      writeFileSync(file(h, s), JSON.stringify(next), { mode: 0o600 });
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
    const tier = Math.min(s.tier, s.max_tier ?? 3) as 0 | 1 | 2 | 3;
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
): { turn: number; user: string; assistant: string; at: number } | null {
  const last = read.turns[read.turns.length - 1];
  const fresh = (user: string, at: number) => ({
    turn: o.base + read.turns.length,
    user: user.slice(0, MAX_TURN_SIDE),
    assistant: "",
    at,
  });
  if (read.open) return fresh(read.open.user, read.open.at);
  // The prompt the hook just reported, unless the transcript already has its reply.
  // Text the person never typed (a task notification, another session's message) opens
  // no turn: the readers skip it, so that turn would never be delivered, and its
  // reading would stand in for the turn that is running until the next one lands.
  const prompt = o.prompt?.trim();
  if (prompt && !isInjected(prompt) && !(last && last.user.includes(prompt.slice(0, 200)))) return fresh(prompt, o.at);
  if (!last) return null;
  return {
    turn: o.base + read.turns.length - 1,
    user: last.user.slice(0, MAX_TURN_SIDE),
    assistant: capTail(last.assistant, MAX_TURN_SIDE),
    at: last.at,
  };
}
const MAX_TURN_SIDE = 20_000;

/** Run one hook job end to end: events → outbox → sinks. Returns what happened.
 *  `claimed` is the job file this run holds: released once the events are in the
 *  outbox or the job is back in the queue (`requeued` names its new file). */
export async function runJob(
  job: Job,
  opts: { state?: string; now?: number; claimed?: string; lockWaitMs?: number } = {},
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
  const r = adapter.fromHook({ argv: job.argv, stdin: job.stdin, env: { ...process.env, ...job.env }, cwd: job.cwd });
  // The adapter did not claim the payload (another harness ran our entry out of a
  // shared hooks file, an event name it does not map, a payload with no session id).
  // Dropped either way, but never in silence: this is where a wrongly-named event
  // lands, and the log is the only thing on the machine that can say so.
  if (!r || !r.session.id) {
    let keys: string[] = [];
    try {
      // Some hooks pass JSON in argv instead of stdin. Only the top-level names
      // belong in this default log: values can contain prompts, paths or secrets.
      const payload: unknown = JSON.parse(job.argv.find((a) => a.startsWith("{")) ?? job.stdin);
      if (payload && typeof payload === "object" && !Array.isArray(payload)) keys = Object.keys(payload);
    } catch {}
    log(
      state,
      `${job.harness} ${job.event}: the ${job.harness} adapter did not claim this payload; event dropped; keys: ${keys.join(", ") || "(none)"}`,
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
  if (!claudeEnd) await tellDaemon(state, job, id, r.session.cwd, r.transcript);
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
  if (!release) {
    log(state, `${job.harness} ${job.event}: session ${id} locked for ${lockWait / 1000} s, re-queued`);
    const requeued = enqueueJob(state, { ...job, tries: (job.tries ?? 0) + 1 });
    releaseJob(opts.claimed);
    return { events: [], delivered: {}, requeued };
  }
  const events: Event[] = [];
  try {
    const facts = factsState(state);
    const mem = facts.get(job.harness, id);
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
    if (claudeEnd) await tellDaemon(state, job, id, r.session.cwd, r.transcript);
    // Heartbeat-class events read no facts (they fire every tool call); the rest refresh them.
    const heavy = !/^(PreToolUse|PostToolUse|PostToolUseFailure|BeforeTool|AfterTool|PostInvocation)$/.test(job.event);
    let learned: Partial<Session> = {};
    if (heavy) {
      // The hook's environment, not the worker's: a swept job may be run by a worker
      // another harness's hook spawned, whose env names none of this harness's homes.
      const f = adapter.facts(r.session, r.transcript, r.hints ?? {}, facts, { ...process.env, ...job.env });
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
    };
    const version = (facts.get(job.harness, id).harness_version as string | undefined) ?? undefined;
    for (const a of r.events) {
      const e = makeEvent(a, {
        harness: { name: job.harness, ...(version ? { version } : {}) },
        session: { ...session, seq: outbox.nextSeq(ref) },
        now: opts.now ?? job.at,
      });
      events.push(e);
    }
    const wantsTranscript = cfg.sinks.some((s) => !s.paused && Math.min(s.tier, s.max_tier ?? 3) >= 2);
    // Tier 2, while a turn runs: what it has said so far, so a receiver can show a long
    // turn before it ends. On the prompt, then at most every PROGRESS_MS on a tool call,
    // and only when it changed. The cursor stays where it is: turn.transcript still
    // delivers the whole turn when it ends.
    const ending = r.events.some((e) => e.type === "turn.ended" || e.type === "session.ended");
    const starting = r.events.some((e) => e.type === "turn.started");
    // A message sent while a turn runs is absorbed by that turn, and Claude Code reports
    // it as a prompt with the running turn's own id. It is not a new turn: where it
    // belongs is the transcript's to say, so its text is no reading of its own.
    const startedId = r.events.find((e) => e.type === "turn.started")?.data.turn_id;
    const absorbed = starting && typeof startedId === "string" && facts.get(job.harness, id).open_turn === startedId;
    if (wantsTranscript && r.transcript && !ending && (starting || r.events.some((e) => e.type === "tool.ended"))) {
      const cur = facts.get(job.harness, id);
      const at = opts.now ?? job.at;
      if (starting || at - (Number(cur.progress_at) || 0) >= PROGRESS_MS) {
        const p = openTurn(adapter.readTranscript(r.transcript, Number(cur.transcript_line) || 0), {
          base: Number(cur.transcript_turns) || 0,
          prompt: !absorbed && typeof r.hints?.prompt === "string" ? r.hints.prompt : undefined,
          at,
        });
        const sig = p && `${p.turn}:${p.user.length}:${p.assistant.length}`;
        if (p && (starting || sig !== cur.progress_sig)) {
          events.push(
            makeEvent(
              { type: "turn.progress", harnessEvent: job.event, data: { ...p, at: new Date(p.at).toISOString() } },
              {
                harness: { name: job.harness, ...(version ? { version } : {}) },
                session: { ...session, seq: outbox.nextSeq(ref) },
                now: at,
              },
            ),
          );
          facts.save(job.harness, id, { progress_at: at, progress_sig: sig });
        }
      }
    }
    // The turn running now, by its prompt's id, until it ends (for `absorbed`).
    if (starting && typeof startedId === "string" && !absorbed) facts.save(job.harness, id, { open_turn: startedId });
    if (ending) facts.save(job.harness, id, { open_turn: null });
    // Tier 2: after a turn ends, the transcript's new turns become turn.transcript events.
    if (
      wantsTranscript &&
      r.transcript &&
      r.events.some((e) => e.type === "turn.ended" || e.type === "session.ended")
    ) {
      const cur = facts.get(job.harness, id);
      const fromLine = Number(cur.transcript_line) || 0;
      let turnNo = Number(cur.transcript_turns) || 0;
      const read = adapter.readTranscript(r.transcript, fromLine);
      for (const t of read.turns) {
        events.push(
          makeEvent(
            {
              type: "turn.transcript",
              harnessEvent: job.event,
              data: { turn: turnNo++, user: t.user, assistant: t.assistant, at: new Date(t.at).toISOString() },
            },
            {
              harness: { name: job.harness, ...(version ? { version } : {}) },
              session: { ...session, seq: outbox.nextSeq(ref) },
              now: opts.now ?? job.at,
            },
          ),
        );
      }
      if (read.turns.length) facts.save(job.harness, id, { transcript_line: read.line, transcript_turns: turnNo });
    }
    // At rest the outbox holds redacted strings (advisory GHSA-8f6f-c3c9-j5p6): the
    // tier-3 fields stay, with their secrets already gone; filterEvent runs the same
    // idempotent pass again per sink.
    outbox.append(
      ref,
      events.map((e) => ({ ...e, session: redactDeep(e.session), data: redactDeep(e.data) })),
    );
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
  // a round trip.
  const delivered = (await drain(state, cfg.sinks, outbox, ref)) ?? {};
  if (Math.random() < 0.02) outbox.prune(cfg.keep_days ?? 30);
  return { events, delivered };
}

/** One worker drains a machine's sinks at a time (the `flush` lock). Another whose
 *  events are in the outbox meanwhile marks that there is more and leaves them to
 *  it (null: nothing sent by this one). The one draining looks for the mark after
 *  each pass, once it has let the lock go, so events appended during a pass go out
 *  in its next pass or with the worker that appended them, never wait for a later
 *  hook. Under a flood of hook events this is one uploader sending full batches,
 *  not one per event, all refused together (mordast, 2026-10-14: 828 refusals in
 *  two minutes, 5 192 jobs queued). */
export async function drain(
  state: string,
  sinkConfigs: SinkConfig[],
  outbox: Outbox,
  first?: { harness: string; session: string },
): Promise<Record<string, number> | null> {
  const more = path.join(state, "locks", "flush.more");
  let release = takeNamedLock(state, "flush");
  if (!release) {
    try {
      writeFileSync(more, "", { mode: 0o600 });
    } catch {}
    release = takeNamedLock(state, "flush");
    if (!release) return null;
  }
  const delivered: Record<string, number> = {};
  for (;;) {
    try {
      unlinkSync(more);
    } catch {}
    try {
      for (const [k, v] of Object.entries(await flush(state, sinkConfigs, outbox, first)))
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
  o: { /** Try a sink in backoff anyway (`sessionpipe replay`). */ force?: boolean } = {},
): Promise<Record<string, number>> {
  const delivered: Record<string, number> = {};
  const sinks = buildSinks(sinkConfigs, {
    locked: (name) => log(state, `sink ${name}: its token is in a keychain this process can't read; left for later`),
  });
  const refs = outbox.sessions();
  if (first) {
    const k = `${first.harness}/${safeId(first.session)}`;
    refs.sort((a, b) => (`${a.harness}/${a.session}` === k ? -1 : `${b.harness}/${b.session}` === k ? 1 : 0));
  }
  const drainSink = async (sink: Sink): Promise<void> => {
    let backoff = readBackoff(state, sink.name);
    if (backoff && !o.force && backoff.until > Date.now()) {
      delivered[sink.name] = 0;
      return;
    }
    const cursors = new Cursors(state, sink.name);
    const c = cursors.read();
    let sent = 0;
    let stalled = false;
    // Pull filtered events session by session into one batch; remember where each
    // session's offset would land if the batch goes through.
    let batch: Event[] = [];
    let pending: Record<string, number> = {};
    // HTTP.md §2 413: halve the batch and try again; one event too large on its own
    // is dropped and logged. A half that is refused for another reason stops the
    // run like any refusal: the cursor stays, and the halves that went through are
    // sent again next time (the receiver counts them as duplicates).
    const deliver = async (events: Event[]): Promise<DeliveryResult> => {
      const res = await sink.send(events);
      if (res.ok || res.action !== "split") return res;
      if (events.length === 1) {
        const e = events[0] as Event;
        log(state, `sink ${sink.name}: 413 ${res.error ?? ""} → event ${e.id} (${e.type}) is too large alone, dropped`);
        return { ok: true, acknowledged: 0, accepted: 0, duplicates: 0, rejected: [{ id: e.id, reason: "too_large" }] };
      }
      const half = Math.ceil(events.length / 2);
      const a = await deliver(events.slice(0, half));
      if (!a.ok) return a;
      const b = await deliver(events.slice(half));
      if (!b.ok) return b;
      return {
        ok: true,
        acknowledged: a.acknowledged + b.acknowledged,
        accepted: (a.accepted ?? 0) + (b.accepted ?? 0),
        duplicates: (a.duplicates ?? 0) + (b.duplicates ?? 0),
        rejected: [...(a.rejected ?? []), ...(b.rejected ?? [])],
      };
    };
    const send = async (): Promise<boolean> => {
      if (!batch.length) {
        Object.assign(c, pending);
        pending = {};
        cursors.write(c);
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
          return false;
        }
      } else if (backoff) {
        clearBackoff(state, sink.name);
        backoff = null;
      }
      sent += batch.length;
      Object.assign(c, pending);
      cursors.write(c);
      batch = [];
      pending = {};
      return true;
    };
    for (const ref of refs) {
      if (stalled || sent >= MAX_PER_RUN) break;
      let offset = pending[cursors.key(ref)] ?? c[cursors.key(ref)] ?? 0;
      for (;;) {
        const room = BATCH - batch.length;
        const { events, offset: next } = outbox.read(ref, offset, room);
        if (!events.length) break;
        for (const e of events) {
          const f = filterEvent(e, sink.tier, sink.pii, { home: os.homedir() });
          if (f) batch.push(f);
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
