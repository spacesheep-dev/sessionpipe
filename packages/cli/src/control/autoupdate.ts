// SPDX-License-Identifier: Apache-2.0
// The control daemon keeps its own copy current. About a minute after it starts, and
// then once a day by the wall clock (state/control/update.json remembers the last
// check, so a restart or a machine that slept doesn't ask twice in a day), it reads
// npm's `latest`. When that is newer it waits until the daemon has nothing in hand —
// no message being delivered, no headless run or start, no held SDK session mid-turn,
// no permission prompt open, no session on the machine mid-turn, no acks being sent —
// stops taking new messages, installs the release into the prefix it runs from
// (update.ts), and restarts onto it:
//
//   launchd / systemd   exit UPDATE_EXIT; the service restarts it on the new code
//                       (every plist and unit sessionpipe ever wrote restarts on a
//                       non-zero exit).
//   anything else       this process stops being the daemon and becomes its parent:
//                       it runs the new `control run` as its child with the same env
//                       and output, restarts it on UPDATE_EXIT, and exits with it
//                       otherwise. Whatever waits on this process (a terminal, a
//                       container's init, a setsid'd shell) keeps waiting.
//
// Off with SESSIONPIPE_NO_UPDATE_CHECK, `update_check: false` in config.json
// (`sessionpipe update off`), or when the running copy isn't a global npm install.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Config } from "@sessionpipe/core";
import { compareVersions, globalPrefix, isNewer, unwritable } from "../update.js";
import { controlState, writePrivate } from "./store.js";

// The exit code a restart asks for, and the parent that answers it where no service
// manager will, live in core (sessionpipe-core/version).
export { supervise, UPDATE_EXIT } from "@sessionpipe/core/version";
export const DAY_MS = 24 * 3600_000;
const LABEL = "org.sessionpipe.control";
const UNIT = "sessionpipe-control.service";

/** What the daemon remembers about updating, in state/control/update.json. */
export interface UpdateRecord {
  /** The last time it asked npm, whatever the answer. */
  checked_at?: string;
  /** What npm said was `latest` then; null when the check failed. */
  latest?: string | null;
  error?: string | null;
  /** The version that checked. */
  running?: string;
  /** Why the daemon's auto-update is off, as the daemon sees it (its own env), or null. */
  off?: string | null;
  /** A newer release waiting for the daemon to be idle. */
  pending?: string | null;
  updated?: { from: string; to: string; at: string; ms: number } | null;
  failed?: { version: string; at: string; error: string } | null;
}

export const updateFile = (env: NodeJS.ProcessEnv = process.env): string => path.join(controlState(env), "update.json");

export function readUpdate(file: string): UpdateRecord {
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as UpdateRecord;
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}

/** Due when it never checked, last checked a day or more ago, or the clock went back. */
export function isDue(rec: UpdateRecord, now: number): boolean {
  const t = Date.parse(rec.checked_at ?? "");
  if (!Number.isFinite(t)) return true;
  if (t > now + 5 * 60_000) return true;
  return now - t >= DAY_MS;
}

/** Why auto-update is off for this copy, or null when it is on. */
export function autoUpdateOff(o: {
  env: NodeJS.ProcessEnv;
  config: Pick<Config, "update_check">;
  distDir: string;
  platform?: NodeJS.Platform;
}): string | null {
  if (o.env.SESSIONPIPE_NO_UPDATE_CHECK) return "SESSIONPIPE_NO_UPDATE_CHECK is set";
  if (o.config.update_check === false) return "update_check is false in config.json (`sessionpipe update on`)";
  const prefix = globalPrefix(o.distDir, o.platform);
  if (!prefix) return "this copy isn't a global npm install (npx, a checkout or a dev build)";
  return unwritable(prefix, o.platform);
}

/** What `status` and `doctor` say about updating. */
export interface UpdateSummary {
  auto: boolean;
  /** Why updates are by hand only, or null. */
  off: string | null;
  last_check: string | null;
  latest: string | null;
  last_error: string | null;
  pending: string | null;
  updated: UpdateRecord["updated"] | null;
  failed: UpdateRecord["failed"] | null;
}

export function updateSummary(o: {
  /** autoUpdateOff() for this copy, from this shell (its env aside: the daemon's counts). */
  off: string | null;
  paired: boolean;
  rec: UpdateRecord;
  platform?: NodeJS.Platform;
}): UpdateSummary {
  const daemonEnv = o.rec.off?.startsWith("SESSIONPIPE_NO_UPDATE_CHECK")
    ? "SESSIONPIPE_NO_UPDATE_CHECK is set in the daemon's environment"
    : null;
  // No service manager runs the daemon on Windows yet (pair says so): it checks only while
  // someone keeps `sessionpipe control run` going, which is not "automatic".
  const byHand =
    (o.platform ?? process.platform) === "win32"
      ? "it runs in the control daemon, which has no service on Windows yet: it checks while `sessionpipe control run` is running"
      : null;
  const off =
    o.off ??
    (o.paired
      ? (daemonEnv ?? byHand)
      : "it runs in the control daemon, which isn't set up here (`sessionpipe connect`)");
  return {
    auto: !off,
    off,
    last_check: o.rec.checked_at ?? null,
    latest: o.rec.latest ?? null,
    last_error: o.rec.error ?? null,
    pending: o.rec.pending ?? null,
    updated: o.rec.updated ?? null,
    failed: o.rec.failed ?? null,
  };
}

export function ago(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return "at an unreadable time";
  if (ms < 90_000) return "just now";
  if (ms < 90 * 60_000) return `${Math.round(ms / 60_000)} min ago`;
  if (ms < 36 * 3600_000) return `${Math.round(ms / 3600_000)} h ago`;
  return `${Math.round(ms / DAY_MS)} days ago`;
}

/** One line: whether it's automatic, when it last looked, what it found. */
export function updateLine(s: UpdateSummary, now: number): string {
  const parts = [
    s.auto
      ? "automatic (the control daemon checks npm once a day and installs when idle; `sessionpipe update off` stops it)"
      : `not automatic: ${s.off}`,
  ];
  if (s.last_check)
    parts.push(
      s.last_error
        ? `last check ${ago(s.last_check, now)} failed: ${s.last_error}`
        : `last check ${ago(s.last_check, now)}: latest ${s.latest ?? "?"}`,
    );
  else if (s.auto) parts.push("not checked yet (a minute after the daemon starts)");
  if (s.pending) parts.push(`${s.pending} waits for the daemon to be idle`);
  if (s.failed) parts.push(`installing ${s.failed.version} failed ${ago(s.failed.at, now)}: ${s.failed.error}`);
  else if (s.updated) parts.push(`updated ${s.updated.from} → ${s.updated.to} ${ago(s.updated.at, now)}`);
  return parts.join(" · ");
}

export type RestartVia = "launchd" | "systemd" | "supervisor";

/** Who restarts this process when it exits UPDATE_EXIT, or null when nobody will (it
 *  then supervises the new daemon itself). A wrong "nobody" costs one extra process; a
 *  wrong "somebody" would leave the machine without a daemon, so each answer is checked
 *  against the process's own parentage — a variable inherited by a child of the daemon
 *  (a session it started) never counts. */
export function restartVia(o: {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  pid: number;
  ppid: number;
  /** /proc/self/cgroup (Linux). */
  cgroup?: () => string;
}): RestartVia | null {
  const s = o.env.SESSIONPIPE_SERVICE ?? "";
  if (s.startsWith("supervisor:") && s === `supervisor:${o.ppid}`) return "supervisor";
  if (o.platform === "darwin" && o.ppid === 1 && (s === "launchd" || o.env.XPC_SERVICE_NAME === LABEL))
    return "launchd";
  if (o.platform === "linux") {
    let cg = "";
    try {
      cg = (o.cgroup ?? (() => readFileSync("/proc/self/cgroup", "utf8")))();
    } catch {}
    const inUnit = cg.split("\n").some((l) => l.endsWith(`/${UNIT}`) || l.includes(`/${UNIT}/`));
    const mainPid = !o.env.SYSTEMD_EXEC_PID || o.env.SYSTEMD_EXEC_PID === String(o.pid);
    if (inUnit && mainPid) return "systemd";
  }
  return null;
}

/** What the daemon offers the updater. */
export interface Quiescent {
  /** Null when nothing is in hand; otherwise what is. */
  busy(): string | null;
  /** Stop taking new messages (in-flight long-polls end); the receiver keeps them. */
  pauseIntake(): void;
  resumeIntake(): void;
}

export interface UpdaterDeps {
  now: () => number;
  log: (line: string) => void;
  /** The running version. */
  version: string;
  file: string;
  /** Why it is off right now (re-read every tick: config.json may have changed). */
  off: () => string | null;
  latest: () => Promise<string>;
  /** The version of the copy on disk. */
  installed: () => Promise<string | null>;
  install: (version: string) => Promise<{ ok: true; ms: number; hooks?: string } | { ok: false; error: string }>;
  daemon: Quiescent;
  /** Stop the daemon and come back on the code on disk. Doesn't return in production. */
  restart: (from: string, to: string) => Promise<void>;
  firstCheckMs?: number;
  /** How often it looks at the clock; a check runs only when one is due. */
  tickMs?: number;
  idlePollMs?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());

export class AutoUpdater {
  private first: NodeJS.Timeout | null = null;
  private every: NodeJS.Timeout | null = null;
  private stopped = false;
  private busyWith: Promise<void> | null = null;
  private lastOff: string | null | undefined = undefined;

  constructor(private readonly d: UpdaterDeps) {}

  start(): void {
    // A wait that a restart cut short is picked up again from `latest` by tick().
    if (this.record().pending) this.save({ pending: null });
    this.first = setTimeout(() => void this.tick(), this.d.firstCheckMs ?? 60_000);
    this.first.unref?.();
    // A look at the clock every ten minutes (one small file read): a machine that
    // sleeps catches up soon after it wakes, not up to an hour of awake time later.
    this.every = setInterval(() => void this.tick(), this.d.tickMs ?? 10 * 60_000);
    this.every.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.first) clearTimeout(this.first);
    if (this.every) clearInterval(this.every);
  }

  record(): UpdateRecord {
    return readUpdate(this.d.file);
  }

  private save(patch: Partial<UpdateRecord>): void {
    try {
      writePrivate(this.d.file, { ...readUpdate(this.d.file), ...patch });
    } catch {}
  }

  /** One look at the clock: check when a check is due and nothing is under way. */
  async tick(): Promise<void> {
    if (this.stopped || this.busyWith) return;
    const off = this.d.off();
    if (off !== this.lastOff) {
      if (off) this.d.log(`auto-update off: ${off}`);
      else if (this.lastOff) this.d.log("auto-update on");
      this.lastOff = off;
      this.save({ off });
    }
    if (off) return;
    const rec = this.record();
    if (isDue(rec, this.d.now())) return this.check();
    // Not due, but the last check found a release this daemon never got to (it was
    // restarted while it waited to be idle): carry on. One that failed waits a day.
    const known = rec.latest;
    if (known && isNewer(known, this.d.version) && rec.failed?.version !== known)
      return this.guard(() => this.apply(known));
  }

  /** One update job at a time; whatever it throws is logged, never left unhandled. */
  private guard(job: () => Promise<void>): Promise<void> {
    if (this.busyWith) return this.busyWith;
    this.busyWith = job()
      .catch((e) => {
        if (!this.stopped) this.d.log(`update: ${String((e as Error)?.message || e)}`);
      })
      .finally(() => {
        this.busyWith = null;
      });
    return this.busyWith;
  }

  /** Ask npm now; when it has a newer release, install it once idle and restart. */
  check(): Promise<void> {
    return this.guard(async () => {
      const t0 = this.d.now();
      let latest: string;
      try {
        latest = await this.d.latest();
      } catch (e) {
        const error = String((e as Error)?.message || e).slice(0, 200);
        this.save({ checked_at: new Date(t0).toISOString(), latest: null, error, running: this.d.version });
        this.d.log(`update check: failed after ${this.d.now() - t0} ms: ${error}`);
        return;
      }
      const ms = this.d.now() - t0;
      this.save({ checked_at: new Date(t0).toISOString(), latest, error: null, running: this.d.version });
      if (!isNewer(latest, this.d.version)) {
        this.save({ pending: null });
        this.d.log(`update check: ${this.d.version} is current (npm latest ${latest}, ${ms} ms)`);
        return;
      }
      this.d.log(`update check: ${latest} is out (running ${this.d.version}, ${ms} ms); updating once idle`);
      await this.apply(latest);
    });
  }

  /** Restart onto the copy on disk once idle (`sessionpipe update` installed it). */
  restartWhenIdle(): boolean {
    if (this.stopped) return false;
    // An update under way ends the same way: on the newest copy on disk.
    if (this.busyWith) return true;
    void this.guard(async () => {
      const onDisk = await this.d.installed();
      if (!onDisk || onDisk === this.d.version) {
        this.d.log(`restart asked: the copy on disk is ${onDisk ?? "unreadable"}, the one running; staying`);
        return;
      }
      await this.quiesce(onDisk, false);
      await this.resumeOnError(async () => {
        this.d.log(`restart: ${this.d.version} → ${onDisk} (installed by hand)`);
        this.save({ updated: { from: this.d.version, to: onDisk, at: new Date(this.d.now()).toISOString(), ms: 0 } });
        await this.d.restart(this.d.version, onDisk);
      });
    });
    return true;
  }

  /** Wait until the daemon has nothing in hand, then stop its intake. A message that
   *  slipped in between is let through and waited for. An automatic update turned off
   *  meanwhile (`sessionpipe update off`) stops waiting. */
  private async quiesce(target: string, auto = true): Promise<void> {
    let said = false;
    for (;;) {
      let why = this.d.daemon.busy();
      while (why) {
        if (this.stopped) throw new Error("stopped");
        const off = auto ? this.d.off() : null;
        if (off) {
          this.save({ pending: null });
          throw new Error(`${target} not installed: auto-update was turned off (${off})`);
        }
        if (!said) {
          this.d.log(`update: ${target} waits until the daemon is idle (${why})`);
          said = true;
        }
        await sleep(this.d.idlePollMs ?? 15_000);
        why = this.d.daemon.busy();
      }
      this.d.daemon.pauseIntake();
      if (!this.d.daemon.busy()) return;
      this.d.daemon.resumeIntake();
    }
  }

  /** Intake is paused from quiesce() on: whatever goes wrong after it lets it go. */
  private async resumeOnError(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      this.d.daemon.resumeIntake();
      throw e;
    }
  }

  private async apply(target: string): Promise<void> {
    this.save({ pending: target });
    await this.quiesce(target);
    await this.resumeOnError(() => this.installAndRestart(target));
  }

  private async installAndRestart(target: string): Promise<void> {
    const from = this.d.version;
    const t0 = this.d.now();
    const onDisk = await this.d.installed();
    let note = "";
    // Someone already installed it (or something newer) by hand: never install over a
    // newer copy, just restart onto what is there.
    const c = onDisk ? compareVersions(onDisk, target) : null;
    if (onDisk && c !== null && c >= 0) {
      target = onDisk;
      note = " (already on disk)";
    } else {
      const r = await this.d.install(target);
      if (!r.ok) {
        this.d.daemon.resumeIntake();
        const ms = this.d.now() - t0;
        this.save({
          pending: null,
          failed: { version: target, at: new Date(this.d.now()).toISOString(), error: r.error },
        });
        this.d.log(`update: ${from} → ${target} failed after ${ms} ms: ${r.error}; still running ${from}`);
        return;
      }
      if (r.hooks) note = `; ${r.hooks}`;
    }
    const ms = this.d.now() - t0;
    // Anything that came in over the socket while npm ran (a permission prompt) ends
    // first. The new copy is on disk by now, so it is restarted onto whatever happens.
    if (this.d.daemon.busy()) {
      this.d.daemon.resumeIntake();
      await this.quiesce(target, false);
    }
    this.save({
      pending: null,
      failed: null,
      updated: { from, to: target, at: new Date(this.d.now()).toISOString(), ms },
    });
    this.d.log(`update: ${from} → ${target} in ${ms} ms${note}; restarting`);
    await this.d.restart(from, target);
  }
}
