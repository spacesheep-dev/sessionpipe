// SPDX-License-Identifier: Apache-2.0
// Carrying out a plan (plan.ts), one step after the other. It decides nothing about what
// to do: only what a step's result means for the ones after it. Everything that touches
// the computer comes in as a dependency, and the only deletion is ours.ts's.
//
// The order is what keeps a computer working if this stops anywhere: the release is
// fetched before anything is touched; npm installs it BESIDE the copy that is there, it is
// seen to run, and only then do the two change places, by two renames (so the slot is
// never empty while npm works, and an install that fails, or is cut off, has touched
// nothing); the hooks and the service are moved onto it by `update`'s own steps
// (current.ts); then it is proven that typing `sessionpipe` starts this copy, and only
// after that is anything else removed, the copy this command runs from last. A run that
// stopped anywhere is finished by running it again.
import path from "node:path";
import type { Status } from "../control/daemon.js";
import type { Health } from "../control/local.js";
import { holding, type Outcome, type Step as Said } from "../current.js";
import type { Plan, Step } from "./plan.js";

export type Done =
  /** One copy, in use everywhere. `said`: what works; `warn`: what is left to say all
   *  the same, a sentence each. */
  | { state: "one"; said: string; warn: string[] }
  /** The fresh copy is in use, and a copy this command would have removed is still
   *  there: what works, what is left, and the one command for it. */
  | { state: "left"; said: string; warn: string[]; still: string; next: string }
  /** The background service finishes by itself, or is still at work. */
  | { state: "waiting"; said: string }
  | { state: "failed"; error: string; next: string };

export interface Proof {
  /** What `--version` printed when the copy in the home was run through its own link;
   *  null: nothing, or no link of npm's leads to it. */
  runs: string | null;
  /** Typing `sessionpipe` starts that copy: the same look as the one before the run. */
  typed: boolean;
  /** Every `sessionpipe` a shell finds now, first first. */
  onPath: string[];
  /** A file that still names a path that was removed. */
  named: { file: string; path: string }[];
}

export interface Doing {
  say: (s: Said) => void;
  /** How a path is shown to a person. */
  tilde: (p: string) => string;
  /** Fetch the release into npm's own cache; why it couldn't be, or null. */
  fetch: (version: string) => Promise<string | null>;
  /** `npm install` of the release into a prefix of its own beside the slot, and a look
   *  that it runs there; why it didn't, or null. */
  install: (prefix: string, version: string) => Promise<string | null>;
  exists: (p: string) => boolean;
  rename: (from: string, to: string) => void;
  /** Eight characters for the name of a folder beside the slot. */
  id: () => string;
  status: () => Promise<Status | null>;
  health: () => Promise<Health | null>;
  quiesce: () => Promise<boolean | null>;
  seed: (sessions: string[]) => void;
  /** Ask a daemon to stop, by the signal it stops cleanly on. */
  stop: (pid: number) => void;
  /** `update`'s own steps from the copy in the home: hooks, service, the wait for receivers. */
  use: (version: string, serve: boolean) => Promise<Outcome>;
  /** The package folder the daemon that is still at work runs from; null where it can't
   *  be told (one from before 0.15 that someone runs by hand names no copy). */
  runningFrom: () => Promise<string | null>;
  /** One folder, by whatever name. */
  same: (a: string, b: string) => boolean;
  /** ours.ts `remove`: what is gone. Throws for what is not ours, and for a folder it
   *  could only remove in part. */
  remove: (what: string) => Promise<string[]>;
  /** See that npm's link to the copy in a prefix is there, making it where it is not;
   *  false when it is not there afterwards. */
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

/** The way in when the command itself may no longer run. */
const NPX = "npx -y sessionpipe@latest reinstall";

/** The fresh install. npm installs the release into a prefix of its own beside the slot
 *  (a folder named as npm names one it has moved aside, which the proof knows) and it is
 *  seen to run there. Then two renames: what is in the slot steps aside, the fresh copy
 *  steps in. Until then nothing of the copy that is there was touched, so an install that
 *  fails, or a run that is cut off while npm works, leaves this computer as it was; and
 *  the way back from the second rename is the first one, the other way round. What it
 *  made beside the slot is removed at the end, and said where it can't be. */
async function fresh(s: Extract<Step, { do: "install" }>, d: Doing): Promise<{ error: string; next: string } | null> {
  const modules = path.dirname(s.dir);
  const stage = path.join(modules, `.sessionpipe-${d.id()}`);
  const old = path.join(modules, `.sessionpipe-${d.id()}`);
  const said = (e: unknown) => (e as Error).message;
  /** What this made beside the slot goes; one that stays is the next run's, and is said. */
  const tidy = async (...made: string[]) => {
    for (const x of made)
      await d.remove(x).catch((e) => d.say({ mark: "warn", text: `${d.tilde(x)} could not be removed (${said(e)})` }));
  };
  const why = await d.install(stage, s.version);
  if (why) {
    if (d.exists(stage)) await tidy(stage);
    return { error: `${why}. Nothing was changed`, next: "sessionpipe reinstall" };
  }
  const there = d.exists(s.dir);
  try {
    if (there) d.rename(s.dir, old);
  } catch (e) {
    await tidy(stage);
    return {
      error: `what is there now couldn't be moved out of the way (${said(e)}). Nothing was changed`,
      next: "sessionpipe reinstall",
    };
  }
  try {
    d.rename(path.join(stage, "lib", "node_modules", "sessionpipe"), s.dir);
  } catch (e) {
    try {
      if (there) d.rename(old, s.dir);
    } catch (back) {
      // The slot is empty: the command may not start. The way in that still works is named.
      return {
        error: `the fresh copy couldn't be put in its place (${said(e)}), and what was there could not be put back (${said(back)}): it is beside its place, as ${d.tilde(old)}, and the fresh copy as ${d.tilde(stage)}`,
        next: NPX,
      };
    }
    await tidy(stage);
    return {
      error: `the fresh copy couldn't be put in its place (${said(e)}). ${there ? "What was there is back where it was" : "Nothing else was changed"}`,
      next: "sessionpipe reinstall",
    };
  }
  await tidy(stage, ...(there ? [old] : []));
  return d.relink(s.prefix)
    ? null
    : { error: "the fresh copy is in its place, and the link that starts it couldn't be made", next: NPX };
}

export async function carryOut(p: Plan, d: Doing): Promise<Done> {
  const target = p.target as string;
  const home = (p.home as NonNullable<Plan["home"]>).shown;
  const removed: string[] = [];
  const stayed: { what: string; why: string }[] = [];
  const warn: string[] = [];
  /** The proof before the first removal was taken, and held. */
  let proven = false;
  const unfit = (proof: Proof): string =>
    `the copy in ${home} doesn't run as it should (\`--version\` printed ${proof.runs ?? "nothing"})`;
  const untyped = (proof: Proof): string =>
    `Typing \`sessionpipe\` does not start the copy in ${home}${
      proof.onPath.length ? ` (it starts ${d.tilde(proof.onPath[0] as string)})` : ""
    }`;
  /** The service is still at work: what `update` said of it, and the copy it runs from. */
  let waiting: { said: string; from: string | null } | null = null;
  for (const s of p.steps) {
    if (s.do === "fetch") {
      const why = await d.fetch(s.version);
      if (why)
        return failed(
          `sessionpipe ${s.version} couldn't be downloaded from npm (${why}). Nothing was changed`,
          "sessionpipe reinstall",
        );
      d.say({ mark: "ok", text: `sessionpipe ${s.version} downloaded` });
    } else if (s.do === "install") {
      const bad = await fresh(s, d);
      if (bad) return failed(`sessionpipe ${s.version} couldn't be installed in ${home}: ${bad.error}`, bad.next);
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
    } else if (s.do === "use") {
      const r = await d.use(target, s.serve);
      // `update`'s own next step for a service that didn't move is itself; here it is this.
      if (r.state === "failed")
        return failed(r.error, r.next === "sessionpipe update" ? "sessionpipe reinstall" : r.next);
      // And the command it names for "once more" is this one: `update` would leave the
      // other copies where they are.
      if (r.state === "waiting")
        waiting = {
          said: r.said.split("sessionpipe update").join("sessionpipe reinstall"),
          from: await d.runningFrom(),
        };
      else if (r.warn) warn.push(r.warn);
    } else if (s.do === "remove") {
      // The copy a daemon still at work runs from stays until it is done; where it can't
      // be told which copy that is, every copy stays.
      if (waiting && (!waiting.from || d.same(waiting.from, s.path))) continue;
      // Nothing is removed until this computer provably has its working copy: the one in
      // the home runs through its own link, and typing `sessionpipe` starts it.
      if (!proven) {
        const proof = await d.prove([]);
        if (proof.runs !== target) return failed(`${unfit(proof)}: no other copy was removed`, NPX);
        // (Where what typing starts was never read, it is not asked of the proof either.)
        if (!p.inferred && !proof.typed)
          return failed(`${untyped(proof)}: no other copy was removed`, "sessionpipe doctor");
        proven = true;
      }
      try {
        const gone = await d.remove(s.path);
        removed.push(...gone);
        // The plan's own words for it; a copy's link went with it where it had one.
        d.say({ mark: "ok", text: `removed ${s.say}${gone.length > 1 ? ", with its link" : ""}` });
      } catch (e) {
        stayed.push({ what: d.tilde(s.path), why: (e as Error).message });
        d.say({ mark: "warn", text: `${d.tilde(s.path)} could not be removed: ${(e as Error).message}` });
      }
    } else if (!waiting) {
      const proof = await d.prove(removed);
      if (proof.runs !== target) return failed(unfit(proof), NPX);
      d.say({ mark: "ok", text: `the copy in ${home} runs: \`--version\` says ${target}` });
      // What a person types is what a shell finds first. What is behind it on PATH is what
      // was left alone, and starts nothing typed.
      // Where it was not read, nothing is said of it here: the plan's note says what is
      // not known.
      if (!p.inferred && !proof.typed) warn.push(`${untyped(proof)}.`);
      else if (!p.inferred)
        d.say(
          proof.onPath.length < 2
            ? {
                mark: "ok",
                text: `typing \`sessionpipe\` starts it${proof.onPath.length ? `: ${d.tilde(proof.onPath[0] as string)}` : ""}`,
              }
            : {
                mark: "info",
                text: `typing \`sessionpipe\` starts it; behind it on PATH: ${proof.onPath.slice(1).map(d.tilde).join(", ")}`,
              },
        );
      for (const n of proof.named) warn.push(`${d.tilde(n.file)} still names ${d.tilde(n.path)}, which was removed.`);
      if (!proof.named.length && removed.length)
        d.say({ mark: "ok", text: "nothing here names a removed copy any more" });
    }
  }
  if (waiting) {
    const kept = p.steps.some((x) => x.do === "remove" && (!waiting.from || d.same(waiting.from, x.path)));
    return {
      state: "waiting",
      said: !kept
        ? waiting.said
        : waiting.from
          ? `${waiting.said.split(". ")[0]}. It still runs from ${d.tilde(waiting.from)}, which stays until that is done. Then run \`sessionpipe reinstall\` once more: it moves the service and removes that last copy.`
          : `${waiting.said.split(". ")[0]}. It doesn't say which copy it runs from, so no copy was removed. When that is done, run \`sessionpipe reinstall\` once more.`,
    };
  }
  // A published copy that is still there means the job is not done. What works is said
  // first all the same, then what is left, and the one line for it.
  const still = [
    ...p.left.filter((l) => l.ours).map((l) => ({ what: `${l.version ?? "a broken copy"} in ${l.where}`, ...l })),
    ...stayed.map((x) => ({ ...x, line: null })),
  ];
  if (still.length)
    return {
      state: "left",
      said: `sessionpipe ${target} is installed in ${home} and in use. Pairings and settings are as they were.`,
      warn,
      still: `${still.length === 1 ? "One other copy is" : `${still.length} other copies are`} still there: ${still
        .map((o) => `${o.what} (${o.line ? "needs sudo" : o.why})`)
        .join("; ")}.`,
      next:
        still
          .map((o) => o.line)
          .filter(Boolean)
          .join(" && ") || "sessionpipe reinstall",
    };
  return {
    state: "one",
    said: `${p.kept ? `sessionpipe ${target} is installed in ${home} and in use` : `This computer has one sessionpipe: ${target}, in ${home}`}${
      p.stays ? " (not installed again: it is whole, the newest, and not yours to write)" : ""
    }. Pairings and settings are as they were.`,
    warn,
  };
}
