// SPDX-License-Identifier: Apache-2.0
// Carrying out a plan (plan.ts), one step after the other. It decides nothing about what
// to do: only what a step's result means for the ones after it. Everything that touches
// the computer comes in as a dependency, and the only deletion is ours.ts's.
//
// The order is what keeps a computer working if this stops half-way: the release is
// fetched before anything is touched; the fresh copy is installed and seen to run, with
// what was there put back if it doesn't; the hooks and the service are moved onto it by
// `update`'s own steps (current.ts); only then is anything else removed, the copy this
// command runs from last. A run that stopped anywhere is finished by running it again.
import path from "node:path";
import type { Status } from "../control/daemon.js";
import type { Health } from "../control/local.js";
import { holding, type Outcome, type Step as Said } from "../current.js";
import type { Plan, Step } from "./plan.js";

export type Done =
  /** One copy, in use everywhere. `warn`: what is left to say all the same. */
  | { state: "one"; said: string; warn: string[] }
  /** The background service finishes by itself, or is still at work. */
  | { state: "waiting"; said: string }
  | { state: "failed"; error: string; next: string };

export interface Proof {
  /** What `--version` printed when the fresh copy was run; null: nothing. */
  runs: string | null;
  /** Every `sessionpipe` a shell finds now, first first, and whether the first is the
   *  fresh copy. */
  onPath: string[];
  first: boolean;
  /** A file that still names a path that was removed. */
  named: { file: string; path: string }[];
}

export interface Doing {
  say: (s: Said) => void;
  /** How a path is shown to a person. */
  tilde: (p: string) => string;
  /** Fetch the release into npm's own cache; why it couldn't be, or null. */
  fetch: (version: string) => Promise<string | null>;
  /** `npm install` of the release into a prefix whose slot is empty, and a look that it
   *  runs; why it didn't, or null. */
  install: (prefix: string, version: string) => Promise<string | null>;
  exists: (p: string) => boolean;
  rename: (from: string, to: string) => void;
  /** Eight characters for the name of the folder moved aside. */
  id: () => string;
  status: () => Promise<Status | null>;
  health: () => Promise<Health | null>;
  quiesce: () => Promise<boolean | null>;
  seed: (sessions: string[]) => void;
  /** Ask a daemon to stop, by the signal it stops cleanly on. */
  stop: (pid: number) => void;
  /** Remove the service file nothing needs. */
  unserve: () => void;
  /** `update`'s own steps from the fresh copy: hooks, service, the wait for receivers. */
  use: (version: string, serve: boolean) => Promise<Outcome>;
  /** The package folder the service file names now. */
  serviceDir: () => string | null;
  /** ours.ts `remove`: what is gone. Throws for what is not ours. `alone`: the folder
   *  only, its bin link left. */
  remove: (what: string, alone?: boolean) => Promise<string[]>;
  /** See that the link that starts the copy in a prefix is there, making it where it can
   *  be made; false when it is not there afterwards. */
  relink: (prefix: string) => boolean;
  prove: (removed: string[]) => Promise<Proof>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  settleMs?: number;
  stopMs?: number;
}

const failed = (error: string, next: string): Done => ({ state: "failed", error, next });

async function until<T>(d: Doing, ms: number, ask: () => Promise<T>, done: (v: T) => boolean): Promise<T> {
  const end = d.now() + ms;
  for (;;) {
    const v = await ask();
    if (done(v) || d.now() >= end) return v;
    await d.sleep(500);
  }
}

/** The fresh install: what is in the slot is moved aside under a name npm itself uses
 *  for such a folder, npm installs into the empty slot, the copy is seen to run, and the
 *  folder moved aside is removed. If the install fails, what npm left is removed and the
 *  folder is moved back. */
async function fresh(s: Extract<Step, { do: "install" }>, d: Doing): Promise<string | null> {
  const aside = path.join(path.dirname(s.dir), `.sessionpipe-${d.id()}`);
  const moved = d.exists(s.dir);
  const said = (e: unknown) => (e as Error).message;
  try {
    if (moved) d.rename(s.dir, aside);
  } catch (e) {
    return `what is there now couldn't be moved out of the way (${said(e)}). Nothing was changed`;
  }
  const why = await d.install(s.prefix, s.version);
  if (!why) {
    // The old folder goes only now, with the fresh copy seen to run. One that can't be
    // removed is found, and taken away, by the next run.
    if (moved) await d.remove(aside).catch(() => {});
    return null;
  }
  let linked = true;
  try {
    // What npm left goes, and only that: the link stays for the folder that comes back.
    if (d.exists(s.dir)) await d.remove(s.dir, true);
    if (moved) {
      d.rename(aside, s.dir);
      linked = d.relink(s.prefix);
    }
  } catch (e) {
    // Only a folder that was moved aside is kept there: into an empty slot there is none.
    return moved
      ? `${why}; and what was there could not be put back (${said(e)}): it is kept beside it, as ${d.tilde(aside)}`
      : `${why}; and what npm left there could not be removed (${said(e)})`;
  }
  return `${why}. ${
    !moved
      ? "Nothing else was changed"
      : linked
        ? "What was there is back in its place"
        : "What was there is back in its place, but the link that starts it is gone"
  }`;
}

export async function carryOut(p: Plan, d: Doing): Promise<Done> {
  const target = p.target as string;
  const home = (p.home as NonNullable<Plan["home"]>).shown;
  const removed: string[] = [];
  const stayed: { what: string; why: string }[] = [];
  const warn: string[] = [];
  /** What a shell finds first, where the proof found that it is not the fresh copy. */
  let typed: string | null = null;
  /** The service is still at work: what `update` said of it, and the copy it runs from. */
  let waiting: { said: string; from: string | null } | null = null;
  for (const s of p.steps) {
    if (s.do === "fetch") {
      const why = await d.fetch(s.version);
      if (why)
        return failed(
          `sessionpipe ${s.version} couldn't be fetched from npm (${why}). Nothing was changed`,
          "sessionpipe reinstall",
        );
      d.say({ mark: "ok", text: `sessionpipe ${s.version} fetched from npm` });
    } else if (s.do === "install") {
      const why = await fresh(s, d);
      if (why)
        return failed(`sessionpipe ${s.version} couldn't be installed in ${home}: ${why}`, "sessionpipe reinstall");
      d.say({
        mark: "ok",
        text: `installed fresh in ${home}, and it runs${s.replaces ? " (what was there is gone)" : ""}`,
      });
    } else if (s.do === "stop") {
      // Only the process the plan saw is this step's to stop. By now none may answer, or
      // another one does (the service's own took the socket): then there is nothing to
      // stop, and no signal goes to a number that may be some other process's.
      const theirs = (x: Status | null): x is Status => x?.pid === s.pid;
      const st = await until(d, d.settleMs ?? 25_000, d.status, (x) => !theirs(x) || !holding(x));
      if (theirs(st)) {
        const held = holding(st);
        if (held)
          return {
            state: "waiting",
            said: `The daemon someone started by hand (pid ${s.pid}) is busy: ${held}. The fresh copy is installed; when that is done, run \`sessionpipe reinstall\` once more and it finishes.`,
          };
        await d.quiesce();
        // One from before 0.15 writes nothing down when it stops: who is mid-turn is left
        // for the service that starts next, as `update` does.
        if (!(await d.health())?.copy && st.mid_turn?.length) d.seed(st.mid_turn);
        d.stop(s.pid);
        // Stopped when it no longer answers: the service's own daemon answering in its
        // place is what was wanted.
        if (theirs(await until(d, d.stopMs ?? 10_000, d.status, (x) => !theirs(x))))
          return failed(
            `the daemon someone started by hand (pid ${s.pid}) was asked to stop and still answers`,
            "sessionpipe reinstall",
          );
        d.say({ mark: "ok", text: `the daemon someone started by hand (pid ${s.pid}) is stopped` });
      }
    } else if (s.do === "unserve") {
      d.unserve();
      d.say({ mark: "ok", text: "the service file nothing here needs is removed" });
    } else if (s.do === "use") {
      const r = await d.use(target, s.serve);
      // `update`'s own next step for a service that didn't move is itself; here it is this.
      if (r.state === "failed")
        return failed(r.error, r.next === "sessionpipe update" ? "sessionpipe reinstall" : r.next);
      // And the command it names for "once more" is this one: `update` would leave the
      // other copies where they are.
      if (r.state === "waiting")
        waiting = { said: r.said.split("sessionpipe update").join("sessionpipe reinstall"), from: d.serviceDir() };
      else if (r.warn) warn.push(r.warn);
    } else if (s.do === "remove") {
      // The copy a service still at work runs from stays until it is done.
      if (waiting?.from && path.resolve(waiting.from) === path.resolve(s.path)) continue;
      try {
        removed.push(...(await d.remove(s.path)));
        d.say({ mark: "ok", text: `removed ${s.what} (${d.tilde(s.path)})` });
      } catch (e) {
        stayed.push({ what: d.tilde(s.path), why: (e as Error).message });
        d.say({ mark: "warn", text: `${d.tilde(s.path)} could not be removed: ${(e as Error).message}` });
      }
    } else if (!waiting) {
      const proof = await d.prove(removed);
      if (proof.runs !== target)
        return failed(
          `the fresh copy in ${home} doesn't run as it should (\`--version\` printed ${proof.runs ?? "nothing"})`,
          "npx -y sessionpipe@latest reinstall",
        );
      d.say({ mark: "ok", text: `the fresh copy runs: \`--version\` says ${target}` });
      // What a person types is what a shell finds first: said only when that is this copy.
      if (proof.first && proof.onPath.length === 1)
        d.say({ mark: "ok", text: `a shell finds one sessionpipe: ${d.tilde(proof.onPath[0] as string)}` });
      else if (proof.first)
        warn.push(`A shell finds ${proof.onPath.length}, this copy first: ${proof.onPath.map(d.tilde).join(", ")}.`);
      else if (proof.onPath.length) {
        typed = proof.onPath[0] as string;
        // The plan's own note says it already where this is the file it saw coming.
        if (!p.first || path.resolve(p.first) !== path.resolve(typed))
          warn.push(`What you type is still ${d.tilde(typed)}, not the fresh copy.`);
      }
      for (const n of proof.named) warn.push(`${d.tilde(n.file)} still names ${d.tilde(n.path)}, which was removed.`);
      if (!proof.named.length && removed.length)
        d.say({ mark: "ok", text: "nothing here names a removed copy any more" });
    }
  }
  if (waiting) {
    const where =
      waiting.from &&
      p.steps.some((s) => s.do === "remove" && path.resolve(s.path) === path.resolve(waiting.from as string));
    return {
      state: "waiting",
      said: where
        ? `${waiting.said.split(". ")[0]}. It still runs from ${d.tilde(waiting.from as string)}, which stays until that is done. Then run \`sessionpipe reinstall\` once more: it moves the service and removes that last copy.`
        : waiting.said,
    };
  }
  // A published copy that is still there means the job is not done: say the one line.
  const ours = [
    ...p.left.filter((l) => l.ours).map((l) => ({ what: l.where, why: l.why, line: l.line })),
    ...stayed.map((x) => ({ ...x, line: null })),
  ];
  if (ours.length)
    return failed(
      `sessionpipe ${target} is installed in ${home} and in use, and ${ours.length === 1 ? "one other copy is" : `${ours.length} other copies are`} still there: ${ours
        .map((o) => `${o.what} (${o.why})`)
        .join("; ")}${typed ? `. What you type is still ${d.tilde(typed)}` : ""}`,
      ours
        .map((o) => o.line)
        .filter(Boolean)
        .join(" && ") || "sessionpipe reinstall",
    );
  const alone = p.left.length;
  return {
    state: "one",
    said: `This computer has one sessionpipe: ${target}, in ${home}. Pairings and settings are as they were.`,
    warn: [
      ...warn,
      ...(alone
        ? [
            `${alone === 1 ? "One thing" : `${alone} things`} above that ${alone === 1 ? "is" : "are"} no install of it ${alone === 1 ? "was" : "were"} left alone.`,
          ]
        : []),
    ],
  };
}
