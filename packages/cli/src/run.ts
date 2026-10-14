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
  machineName,
  makeEvent,
  Outbox,
  readConfig,
  redactDeep,
  type Session,
  type Sink,
  type SinkConfig,
  StdoutSink,
  safeId,
  stateDir,
  type TranscriptRead,
  takeLock,
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
}

/** A job file the worker will pick up: random suffix, 0600, in a 0700 dir. */
export function enqueueJob(state: string, job: Job): string {
  const jobs = jobsDir(state);
  mkdirSync(jobs, { recursive: true, mode: 0o700 });
  const f = path.join(jobs, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.json`);
  writeFileSync(f, JSON.stringify(job), { mode: 0o600 });
  return f;
}

/** Jobs another worker left behind (a lost lock race, a killed worker): every
 *  worker sweeps the ones older than `olderThanMs` before it exits, so no event
 *  is lost (ground rule 4). Each is removed before it runs, so two sweepers
 *  never run one twice, and none is started at or after `until`: one still waiting
 *  for its session's lock when the worker's deadline came would be gone, neither
 *  run nor re-queued. Swept jobs don't deliver; the caller delivers once after. */
export async function sweepJobs(
  state: string,
  olderThanMs = 3000,
  limit = 20,
  o: { until?: number } = {},
): Promise<number> {
  const jobs = jobsDir(state);
  let names: string[] = [];
  try {
    names = readdirSync(jobs).filter((n) => n.endsWith(".json"));
  } catch {
    return 0;
  }
  let ran = 0;
  for (const n of names.sort().slice(0, limit)) {
    if (o.until !== undefined && Date.now() >= o.until) break;
    const f = path.join(jobs, n);
    let job: Job | null = null;
    try {
      if (Date.now() - statSync(f).mtimeMs < olderThanMs) continue;
      job = JSON.parse(readFileSync(f, "utf8")) as Job;
      unlinkSync(f);
    } catch {
      continue;
    }
    await runJob(job, { state, deliver: false }).catch(() => {});
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
  const prompt = o.prompt?.trim();
  if (prompt && !(last && last.user.includes(prompt.slice(0, 200)))) return fresh(prompt, o.at);
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
 *  `deliver: false` stops at the outbox (a sweep delivers once for all its jobs);
 *  `until` ends the delivery's rounds (deliver). */
export async function runJob(
  job: Job,
  opts: { state?: string; now?: number; deliver?: boolean; until?: number } = {},
): Promise<{ events: Event[]; delivered: Record<string, number> }> {
  const state = opts.state ?? stateDir();
  const cfg = readConfig();
  const adapter = adapterByName(job.harness);
  if (!adapter) return { events: [], delivered: {} };
  const r = adapter.fromHook({ argv: job.argv, stdin: job.stdin, env: { ...process.env, ...job.env }, cwd: job.cwd });
  if (!r || !r.session.id) return { events: [], delivered: {} };
  // A session the control daemon started goes by the id its start command named, not
  // the one the harness picked (CONTROL.md §6 `start`; control/aliases.ts): its events
  // say so, and so does everything below. The adapter's own reading of the session
  // (facts, a remote URL) keeps the harness's id.
  const id =
    receiverIdOf(readAliases(aliasFile(path.join(state, "control"))), job.harness, r.session.id) ?? r.session.id;
  // The control daemon learns each session's turn state and folder from its events (a
  // message for a session mid-turn waits for its Stop; a pending permission prompt
  // closes when the tool runs). A local round trip, and nothing when no daemon runs.
  await tellDaemon(state, job, id, r.session.cwd, r.transcript);
  const outbox = new Outbox(state);
  const ref = { harness: job.harness, session: id };
  // Hooks of one session fire close together (parallel subagents, issue #9): wait
  // for the lock with a short backoff before giving the job back to the queue.
  let release = takeLock(state, ref);
  for (let wait = 50; !release && wait <= 3200; wait *= 2) {
    await new Promise((res) => setTimeout(res, wait));
    release = takeLock(state, ref);
  }
  if (!release) {
    log(state, `${job.harness} ${job.event}: session ${id} locked for 6 s, re-queued`);
    enqueueJob(state, job);
    return { events: [], delivered: {} };
  }
  let events: Event[] = [];
  try {
    const facts = factsState(state);
    const mem = facts.get(job.harness, id);
    // Heartbeat-class events read no facts (they fire every tool call); the rest refresh them.
    const heavy = !/^(PreToolUse|PostToolUse|PostToolUseFailure|BeforeTool|AfterTool|PostInvocation)$/.test(job.event);
    let learned: Partial<Session> = {};
    if (heavy) {
      const f = adapter.facts(r.session, r.transcript, r.hints ?? {}, facts);
      const { started_at: _s, last_at: _l, first_ask: _fa, harness_version, ...rest } = f;
      learned = rest;
      if (harness_version) facts.save(job.harness, id, { harness_version });
      facts.save(job.harness, id, { session: { ...(mem.session as object), ...learned } });
      // Antigravity's transcript never says which folder a conversation runs in; the
      // hooks do. Kept raw (this file is the machine's own, 0600), so the control
      // daemon still knows where to resume it after a restart.
      if (job.harness === "antigravity" && r.session.cwd && path.isAbsolute(r.session.cwd))
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
    events = [];
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
    if (wantsTranscript && r.transcript && !ending && (starting || r.events.some((e) => e.type === "tool.ended"))) {
      const cur = facts.get(job.harness, id);
      const at = opts.now ?? job.at;
      if (starting || at - (Number(cur.progress_at) || 0) >= PROGRESS_MS) {
        const p = openTurn(adapter.readTranscript(r.transcript, Number(cur.transcript_line) || 0), {
          base: Number(cur.transcript_turns) || 0,
          prompt: typeof r.hints?.prompt === "string" ? r.hints.prompt : undefined,
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
    log(state, `${job.harness} ${job.event}: ${events.map((e) => e.type).join(",") || "nothing"} (${id.slice(0, 8)})`);
  } finally {
    release();
  }
  // Delivery runs after the session's lock is let go. The lock guards the outbox, its
  // seq and the facts: local, synchronous work. Held across the POSTs, it made every
  // other hook of a busy session wait 6 s and go back to the queue (5,192 jobs
  // waiting on one machine with four busy sessions, 2026-10-13).
  const delivered =
    opts.deliver === false
      ? {}
      : await deliver(state, cfg.sinks, outbox, ref, opts.until !== undefined ? { until: opts.until } : {});
  if (Math.random() < 0.02) outbox.prune(cfg.keep_days ?? 30);
  return { events, delivered };
}

/** The machine-wide delivery lock: a lock on a name no harness uses, so it has the
 *  session locks' exclusivity and their release on exit. A worker holds it under
 *  15 s (its deadline), so one older than this was left by a process that died. */
const DELIVERY = { harness: "sessionpipe", session: "delivery" };
const DELIVERY_STALE_MS = 60_000;

/** One delivery at a time on this machine. Every worker used to flush for itself, so
 *  a machine running four busy sessions sent hundreds of batches a minute, and after
 *  its receiver's first 429 it kept sending: 828 refused requests in two minutes at least
 *  (2026-10-13). Now a worker that finds a delivery running leaves a mark and goes; the
 *  one delivering looks for the mark after it lets go, and goes round again. An event
 *  appended before its worker left the mark is read by a round that starts after it,
 *  so there are never more rounds than hooks. The rounds stop at `until` (the
 *  worker's deadline is near) or when every sink is waiting; what is left is the
 *  next worker's, from the same cursors. */
export async function deliver(
  state: string,
  sinkConfigs: SinkConfig[],
  outbox: Outbox,
  first?: { harness: string; session: string },
  o: { until?: number } = {},
): Promise<Record<string, number>> {
  const total: Record<string, number> = {};
  const more = path.join(state, "locks", "delivery.more");
  for (;;) {
    let release = takeLock(state, DELIVERY, DELIVERY_STALE_MS);
    if (!release) {
      try {
        writeFileSync(more, "");
      } catch {}
      // The one delivering may have let go between the first try and the mark.
      release = takeLock(state, DELIVERY, DELIVERY_STALE_MS);
      if (!release) return total;
    }
    try {
      try {
        unlinkSync(more);
      } catch {}
      for (const [k, v] of Object.entries(await flush(state, sinkConfigs, outbox, first, { gapMs: MIN_GAP_MS })))
        total[k] = (total[k] ?? 0) + v;
    } finally {
      release();
    }
    if (!existsSync(more) || (o.until !== undefined && Date.now() >= o.until)) return total;
    const now = Date.now();
    if (sinkConfigs.every((s) => s.paused || sinkWait(state, s.name).until > now)) return total;
  }
}

/** What a sink is waiting out, kept per sink in <state>/sinks/<sink>.json so every
 *  worker on the machine waits, not only the one that was told (HTTP.md §2): a 429's
 *  `retry-after`, or the backoff after the receiver failed `failures` times in a
 *  row. `last` is when a batch last went to it. */
export interface SinkWait {
  until: number;
  failures: number;
  status?: number;
  last?: number;
}

/** 5xx, network error, timeout: 2 s · 10 s · 60 s · 5 min · 30 min, then every 30 min (HTTP.md §2). */
const BACKOFF_MS = [2_000, 10_000, 60_000, 300_000, 1_800_000];

/** The least time between two batches of the workers' delivery to one HTTP receiver.
 *  An event after a quiet second goes at once (the p50 2 s target, HTTP.md §2 Time);
 *  in a burst, what comes meanwhile rides in the next batch of up to BATCH. A command
 *  a person runs (replay, the install's backfill) isn't paced. */
export const MIN_GAP_MS = 1_000;

const waitFile = (state: string, sink: string): string => path.join(state, "sinks", `${safeId(sink)}.json`);

export function sinkWait(state: string, sink: string): SinkWait {
  try {
    const j = JSON.parse(readFileSync(waitFile(state, sink), "utf8")) as Partial<SinkWait>;
    return {
      until: Number(j.until) || 0,
      failures: Number(j.failures) || 0,
      ...(j.status ? { status: Number(j.status) } : {}),
      ...(j.last ? { last: Number(j.last) } : {}),
    };
  } catch {
    return { until: 0, failures: 0 };
  }
}

function saveWait(state: string, sink: string, w: SinkWait): void {
  try {
    const f = waitFile(state, sink);
    mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(w), { mode: 0o600 });
    renameSync(tmp, f);
  } catch {}
}

/** How long to wait after a refused batch: a 429 says (a missing or unreadable
 *  `retry-after` is a minute), a failure counts up the backoff. */
function waitAfter(res: DeliveryResult, failures: number): number {
  if (res.status === 429) {
    const ms = res.retryAfterMs;
    return ms !== undefined && Number.isFinite(ms) && ms > 0 ? Math.min(ms, 86_400_000) : 60_000;
  }
  return BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1] ?? 1_800_000;
}

const BATCH = 50;
const MAX_PER_RUN = 500;

/** Drain every sink from its cursor: this session first, then any backlog. Events
 *  from many sessions are packed into one batch of up to BATCH, so a first
 *  install's 400-session backfill is nine POSTs, not four hundred (the receiver's
 *  write limit ended the first replay at 278 events, 2026-09-28). A cursor moves
 *  only after its batch was acknowledged; a refused batch stops the sink for this
 *  run and the next worker starts from the same cursors. A sink told to wait (a 429,
 *  or a failing receiver: HTTP.md §2) is skipped until its time, by every worker on
 *  the machine (sinkWait), and batches to an HTTP receiver go `gapMs` apart. */
export async function flush(
  state: string,
  sinkConfigs: SinkConfig[],
  outbox: Outbox,
  first?: { harness: string; session: string },
  o: { gapMs?: number } = {},
): Promise<Record<string, number>> {
  const delivered: Record<string, number> = {};
  const now = Date.now();
  const ready = sinkConfigs.filter((s) => {
    if (sinkWait(state, s.name).until <= now) return true;
    delivered[s.name] = 0;
    return false;
  });
  const sinks = buildSinks(ready, {
    locked: (name) => log(state, `sink ${name}: its token is in a keychain this process can't read; left for later`),
  });
  const refs = outbox.sessions();
  if (first) {
    const k = `${first.harness}/${safeId(first.session)}`;
    refs.sort((a, b) => (`${a.harness}/${a.session}` === k ? -1 : `${b.harness}/${b.session}` === k ? 1 : 0));
  }
  for (const sink of sinks) {
    const cursors = new Cursors(state, sink.name);
    const c = cursors.read();
    let wait = sinkWait(state, sink.name);
    const gap = sink instanceof HttpSink ? (o.gapMs ?? 0) : 0;
    let sent = 0;
    let stalled = false;
    // Pull filtered events session by session into one batch; remember where each
    // session's offset would land if the batch goes through.
    let batch: Event[] = [];
    let pending: Record<string, number> = {};
    const send = async (): Promise<boolean> => {
      if (!batch.length) {
        Object.assign(c, pending);
        pending = {};
        cursors.write(c);
        return true;
      }
      // Never longer than the gap itself, whatever a clock that jumped left in `last`.
      const pause = Math.min(gap, (wait.last ?? 0) + gap - Date.now());
      if (pause > 0) await new Promise((r) => setTimeout(r, pause));
      const res = await sink.send(batch);
      const at = Date.now();
      if (!res.ok) {
        const action = res.action ?? "retry";
        if (action === "retry") {
          const failures = res.status === 429 ? wait.failures : wait.failures + 1;
          const hold = waitAfter(res, failures);
          wait = { until: at + hold, failures, last: at, ...(res.status ? { status: res.status } : {}) };
          log(
            state,
            `sink ${sink.name}: ${res.status ?? ""} ${res.error ?? ""} → retry in ${Math.ceil(hold / 1000)} s`,
          );
        } else {
          wait = { ...wait, last: at };
          log(state, `sink ${sink.name}: ${res.status ?? ""} ${res.error ?? ""} → ${action}`);
        }
        saveWait(state, sink.name, wait);
        if (action === "pause" || action === "lower-tier") applySinkVerdict(sink.name, res);
        if (action !== "drop") {
          batch = [];
          pending = {};
          return false;
        }
      } else {
        wait = { until: 0, failures: 0, last: at };
        saveWait(state, sink.name, wait);
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
  }
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
