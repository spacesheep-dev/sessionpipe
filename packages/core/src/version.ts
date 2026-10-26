// SPDX-License-Identifier: Apache-2.0
/** sessionpipe-core/version — versions, and restarting onto a new one: how two
 *  versions order, whether one is a release newer than another, the exit code that
 *  asks a service manager to start a process again on the code now on disk, and the
 *  parent that does so where no manager will. The control daemon updates itself with
 *  these, and a receiver of the person's own can do the same. Node only (the parent
 *  spawns its child), so never part of the root export. */
import { type ChildProcess, spawn } from "node:child_process";

/** EX_TEMPFAIL: "start me again, on the code now on disk". Every plist and unit
 *  sessionpipe-core/service writes restarts on it. */
export const UPDATE_EXIT = 75;

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export interface Parsed {
  n: [number, number, number];
  pre: string | null;
}
/** A version's numbers and its prerelease tag, or null when it isn't one. */
export function parseVersion(v: string): Parsed | null {
  const m = VERSION_RE.exec(String(v).trim());
  if (!m) return null;
  return { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null };
}

/** Order two versions: <0, 0, >0, or null if either isn't one. A release sorts above
 *  its own prereleases; prereleases compare by their tag. */
export function compareVersions(a: string, b: string): number | null {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return (x.n[i] as number) - (y.n[i] as number);
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre.localeCompare(y.pre, "en", { numeric: true });
}

/** `a` is a release newer than `b`. A prerelease is never offered as an update: the
 *  `latest` dist-tag is a release, and anything else is someone's experiment.
 *  Setup opts into prereleases when checking whether an installed build is newer. */
export function isNewer(a: string, b: string, includePrereleases = false): boolean {
  const x = parseVersion(a);
  if (!x || (!includePrereleases && x.pre !== null)) return false;
  const c = compareVersions(a, b);
  return c !== null && c > 0;
}

/** The parent left behind when no service manager will restart the daemon: runs
 *  `control run` as a child with the same env and output, starts it again when it exits
 *  UPDATE_EXIT (an update) or fails (after 5 s, like the service files), and exits
 *  with it when it exits cleanly or is told to stop. */
export function supervise(o: {
  node: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  spawn?: typeof spawn;
  exit?: (code: number) => void;
  failDelayMs?: number;
}): { stop: (sig?: NodeJS.Signals) => void } {
  const run = o.spawn ?? spawn;
  const exit = o.exit ?? ((c: number) => process.exit(c));
  const env = { ...o.env, SESSIONPIPE_SERVICE: `supervisor:${process.pid}` };
  let child: ChildProcess | null = null;
  let stopping = false;
  let later: NodeJS.Timeout | null = null;
  const start = () => {
    later = null;
    const c = run(o.node, o.args, { env, stdio: "inherit", windowsHide: true });
    child = c;
    let done = false;
    const ended = (code: number | null, signal: NodeJS.Signals | null) => {
      if (done) return;
      done = true;
      child = null;
      if (stopping) return exit(code ?? 0);
      if (code === UPDATE_EXIT) {
        o.log("the daemon is restarting onto its new version");
        return start();
      }
      if (code === 0) return exit(0);
      o.log(`the daemon exited (${signal ?? `code ${code}`}); starting it again in 5 s`);
      later = setTimeout(start, o.failDelayMs ?? 5000);
    };
    c.on("exit", ended);
    c.on("error", (e) => {
      o.log(`couldn't start the daemon: ${e.message}`);
      ended(1, null);
    });
  };
  const stop = (sig: NodeJS.Signals = "SIGTERM") => {
    stopping = true;
    if (later) clearTimeout(later);
    if (child) child.kill(sig);
    else exit(0);
  };
  start();
  return { stop };
}
