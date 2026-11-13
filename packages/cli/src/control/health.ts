// SPDX-License-Identifier: Apache-2.0
// What `sessionpipe doctor` finds out about the background service beyond its status:
// whether launchd or systemd has it at all, what it sees from where it runs (asked over
// its socket, since a shell over ssh can't read a Mac's login keychain and would only
// guess), and the trouble that until now only its log knew: a full disk, a pool with no
// account left to try. Everything here looks; nothing is started, stopped or written.
import { execFileSync } from "node:child_process";
import { closeSync, fstatSync, openSync, readSync, realpathSync, statfsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { configFile, stateDir } from "@sessionpipe/core";
import type { Exec, ServiceState } from "@sessionpipe/core/service";
import * as core from "@sessionpipe/core/service";
import { ask, type Health } from "./local.js";
import { controlState } from "./store.js";

export const SERVICE_LABEL = "org.sessionpipe.control";
export const SERVICE_UNIT = "sessionpipe-control.service";

/** A service of a sessionpipe's own: always one of sessionpipe's, by its name, so that
 *  no other program's service is ever booted out or its file written over. */
const OWN_LABEL = /^org\.sessionpipe\.[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** This account's home as the system has it, which `$HOME` doesn't change: a world made
 *  by pointing HOME somewhere else is still not this computer's own. */
function accountHome(): string {
  try {
    return os.userInfo().homedir || os.homedir();
  } catch {
    // An account the system has no entry for (a container run under a bare uid).
    return os.homedir();
  }
}

/** Two paths to one place: the same once resolved, or by their real names where both
 *  are there (a home reached through a link). */
function samePlace(a: string, b: string): boolean {
  if (path.resolve(a) === path.resolve(b)) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/** Where this sessionpipe keeps its files, when that is not where this account's
 *  sessionpipe keeps them with nothing set: the folder or file that differs, and the
 *  usual one. Decided on the paths as they resolve, whichever variable moved them
 *  (SESSIONPIPE_STATE, SESSIONPIPE_CONFIG, XDG_*, HOME, on Windows APPDATA). */
export function elsewhere(env: NodeJS.ProcessEnv = process.env): { now: string; usual: string } | null {
  const home = accountHome();
  const usual =
    process.platform === "win32"
      ? [
          path.join(home, "AppData", "Local", "sessionpipe"),
          path.join(home, "AppData", "Roaming", "sessionpipe", "config.json"),
        ]
      : [path.join(home, ".local", "state", "sessionpipe"), path.join(home, ".config", "sessionpipe", "config.json")];
  const now = [stateDir(env), configFile(env)];
  const i = now.findIndex((p, n) => !samePlace(p, usual[n] as string));
  return i < 0 ? null : { now: now[i] as string, usual: usual[i] as string };
}

/** The folders this sessionpipe may call this computer's own, for what it looks at and
 *  removes outside its state (`sessionpipe reinstall`): all of them where it keeps its
 *  files in this account's usual place; where it keeps them somewhere else (a test, an
 *  agent's throwaway world), only its own home folder, and nothing at all when that home
 *  is this account's real one. So a world of its own is its `$HOME`, and a run in one can
 *  never remove a copy of this computer's. */
export function reach(env: NodeJS.ProcessEnv = process.env): true | string | null {
  if (!elsewhere(env)) return true;
  const home = os.homedir();
  return samePlace(home, accountHome()) ? null : home;
}

/** The service's names, or null where this sessionpipe has none to look at or change.
 *  One that keeps its files somewhere other than this account's usual place (a test, an
 *  agent's throwaway world, a profile that sets SESSIONPIPE_CONFIG) says nothing about
 *  this computer's usual service and never touches it. SESSIONPIPE_SERVICE_LABEL names a
 *  service of its own, `org.sessionpipe.<name>`; naming the usual one means that one. */
export function serviceNames(env: NodeJS.ProcessEnv = process.env): { label: string; unit: string } | null {
  const own = env.SESSIONPIPE_SERVICE_LABEL;
  if (own === SERVICE_LABEL) return { label: SERVICE_LABEL, unit: SERVICE_UNIT };
  if (own) return OWN_LABEL.test(own) ? { label: own, unit: `${own}.service` } : null;
  return elsewhere(env) ? null : { label: SERVICE_LABEL, unit: SERVICE_UNIT };
}

/** Why this sessionpipe has no service to look at or change, in a sentence for a
 *  person; null when it has one. */
export function noService(env: NodeJS.ProcessEnv = process.env): string | null {
  if (serviceNames(env)) return null;
  const own = env.SESSIONPIPE_SERVICE_LABEL;
  if (own)
    return `SESSIONPIPE_SERVICE_LABEL is set to ${own}, and a service of sessionpipe's own is named org.sessionpipe.<name>`;
  const where = elsewhere(env) as { now: string; usual: string };
  return `this sessionpipe keeps its files somewhere other than this computer's usual place (${where.now}, not ${where.usual}), so the usual background service is left alone`;
}

/** Whether launchd or systemd has the service now; null where there is nothing to ask. */
export function serviceLook(
  o: { env?: NodeJS.ProcessEnv; exec?: Exec; platform?: NodeJS.Platform; home?: string } = {},
): ServiceState | null {
  const names = serviceNames(o.env);
  if (!names) return null;
  const st = core.serviceState({
    ...names,
    ...(o.exec ? { exec: o.exec } : {}),
    ...(o.platform ? { platform: o.platform } : {}),
    ...(o.home ? { home: o.home } : {}),
  });
  return st.manager ? st : null;
}

/** What the running service sees; null when none answers or it is too old to be asked
 *  (before this, a daemon closed the connection on a request it didn't know). */
export async function askHealth(sock: string, timeoutMs = 25_000): Promise<Health | null> {
  const r = await ask(sock, { op: "health" }, timeoutMs);
  return r?.op === "health" ? r.health : null;
}

/** Trouble the service wrote down and told nobody. */
export interface Trouble {
  kind: "disk" | "pool";
  /** How many times in the window. */
  times: number;
  /** When it last happened (ms). */
  last: number;
}

/** How far back a line in the log still says something about now. */
export const TROUBLE_WINDOW_MS = 60 * 60_000;

/** The trouble in a daemon log's text: lines of the last hour, and only of the daemon
 *  that is running now (after its last "up" line). */
export function logTroubles(text: string, now: number): Trouble[] {
  const lines = text.split("\n");
  let from = 0;
  lines.forEach((l, i) => {
    if (/ control daemon \S+ up · pid /.test(l)) from = i;
  });
  const found = new Map<Trouble["kind"], Trouble>();
  for (const l of lines.slice(from)) {
    const at = Date.parse(l.slice(0, l.indexOf(" ")));
    if (!Number.isFinite(at) || now - at > TROUBLE_WINDOW_MS) continue;
    const kind = /ENOSPC|no space left on device/i.test(l)
      ? "disk"
      : / no account could be tried/.test(l)
        ? "pool"
        : null;
    if (!kind) continue;
    const t = found.get(kind) ?? { kind, times: 0, last: at };
    found.set(kind, { kind, times: t.times + 1, last: Math.max(t.last, at) });
  }
  return [...found.values()];
}

/** The end of a file, at most `max` bytes of it; "" when it can't be read. */
export function tailOf(file: string, max = 256 * 1024): string {
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(size, max));
    readSync(fd, buf, 0, buf.length, size - buf.length);
    return buf.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** The service's recent log: the file launchd writes, else what journald kept for the
 *  systemd unit; "" when neither can be read. */
export function serviceLog(o: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; exec?: Exec } = {}): string {
  const text = tailOf(path.join(controlState(o.env), "daemon.log"));
  const names = serviceNames(o.env);
  if (text || (o.platform ?? process.platform) !== "linux" || !names) return text;
  const exec: Exec =
    o.exec ??
    ((cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }));
  try {
    return exec("journalctl", ["--user", "-u", names.unit, "--since", "-1h", "-o", "cat", "--no-pager"]);
  } catch {
    return "";
  }
}

/** Bytes this user can still write where sessionpipe keeps its state (or in the nearest
 *  folder above it that exists); null when the system won't say. */
export function freeBytes(dir: string, statfs: typeof statfsSync = statfsSync): number | null {
  for (let d = dir; ; d = path.dirname(d)) {
    try {
      const s = statfs(d);
      return Number(s.bavail) * Number(s.bsize);
    } catch {
      if (path.dirname(d) === d) return null;
    }
  }
}

/** Below this the disk counts as full: the outbox, the cursors and the service's own
 *  state can no longer be relied on to be written. */
export const DISK_FULL_BYTES = 16 * 1024 * 1024;
