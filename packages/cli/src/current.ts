// SPDX-License-Identifier: Apache-2.0
// `sessionpipe update`: one command that leaves this whole computer current. When it
// ends well, the copy a person types, the copy the background service runs and the
// hooks are one version, the newest; the service is running it and hearing from its
// receivers. When it can't get there it says what is wrong and the one thing to type
// next, or that nothing is: the service finishes by itself once what it holds is done.
//
//   1. npm's latest, and this copy brought up to it (update.ts `installEverywhere`,
//      the same steps the service's own daily update takes).
//   2. The hooks written again from this copy.
//   3. The service made to run this copy: the same one a person types, so the two can't
//      drift apart again. Where launchd or systemd has it under another copy, or should
//      have it (its file is there) and nothing runs, it is replaced (core's
//      `installService`: the old one booted out, the new one started once it is gone).
//      Where it runs this copy already, and where someone runs it by hand (no manager
//      has it: `pair --no-service`, tmux, a container), it is asked to restart itself
//      over its socket. A service nobody asked for is never installed: with no service
//      file and nothing running, the next step is `sessionpipe control run`.
//   4. A look: it answers with the new version, and has heard from its receivers since
//      it started (a first answer to a long-poll can take half a minute). A receiver
//      that hasn't answered by then is named in the last line as a warning: the computer
//      is up to date all the same, and a receiver that is down is not this command's to
//      fail on.
//
// A restart never cuts short what the service itself holds (a turn it runs, a message in
// hand, a prompt held for an answer): it is given a moment, and past that the service
// restarts by itself when it is done. A session someone is working in is not held back
// for: the service remembers it is mid-turn across the restart (daemon.ts). A service
// from before 0.15 doesn't remember, so what it knows of who is mid-turn is written down
// for it before it is replaced (`seed`); and where such a one restarts itself it waits
// for those sessions by its own older rule, which is said as it is: waiting, not failed.
//
// Everything that touches the computer comes in as a dependency, so each path is a test.
import type { ServiceState } from "@sessionpipe/core/service";
import { isNewer } from "@sessionpipe/core/version";
import type { Status } from "./control/daemon.js";
import type { Health } from "./control/local.js";
import { hostOf } from "./control/view.js";
import { shq } from "./shell.js";
import type { Mark } from "./style.js";
import type { InstallResult } from "./update.js";

/** One line of what was done. */
export interface Step {
  mark: Mark;
  text: string;
}

export type Outcome =
  /** Everything runs `version`. `warn`: what is not as it should be all the same, and is
   *  not this command's to put right (a receiver that hasn't answered the service). */
  | { state: "current"; version: string; said: string; warn?: string }
  /** The rest happens by itself; nothing to type. */
  | { state: "waiting"; version: string; said: string }
  /** What is wrong, and the one command to run next. */
  | { state: "failed"; error: string; next: string };

export interface CurrentDeps {
  /** The version of the running copy, its dist folder, and the node that runs it. */
  version: string;
  distDir: string;
  node: string;
  /** This copy's cli.js by its real path: what the service is made to run. */
  cli: string;
  /** The prefix npm installed this copy into; null when npm didn't (a checkout, a dev build). */
  prefix: string | null;
  /** Why npm can't write that prefix, or null. */
  unwritable: string | null;
  /** The system this runs on: how a path is quoted in a command it prints, and whether
   *  there is a `sudo` to name. */
  platform: NodeJS.Platform;
  latest: () => Promise<string>;
  /** Why npm is not to be asked at all (SESSIONPIPE_NO_UPDATE_CHECK), or null. What is
   *  here is then made one version, and nothing newer is looked for. */
  unasked: string | null;
  /** Install into this copy's prefix and each of `others`, then write the hooks again. */
  install: (version: string, others: string[]) => Promise<InstallResult>;
  /** Write the hooks again from this copy. */
  rearm: () => Promise<{ ok: boolean; said: string }>;
  /** The version the hooks run now; null where there are none (or on Windows, where they
   *  name this copy directly). */
  hooks: () => string | null;
  /** The harnesses set up on this computer. */
  harnesses: string[];
  /** Something on this computer needs the service: a receiver, the pool, asking. */
  wanted: boolean;
  status: () => Promise<Status | null>;
  health: () => Promise<Health | null>;
  /** Ask the running service to restart itself onto the copy on disk; true when it will. */
  restart: () => Promise<boolean>;
  /** What launchd or systemd has; null where this sessionpipe has no service to manage,
   *  or no manager that can be asked from here. */
  look: () => ServiceState | null;
  /** Why this sessionpipe has no service of its own to look at, in a sentence (it keeps
   *  its files somewhere other than this computer's usual place: health.ts `noService`);
   *  null where it has one, or where only a manager is missing. */
  apart: string | null;
  /** Replace the service with one that runs this copy; throws with why it couldn't, also
   *  where nothing here could start one. */
  place: () => void;
  /** Leave the sessions that are mid-turn for the service that starts next (store.ts
   *  `writeTurnsSeed`): a service too old to write that down itself is about to be stopped. */
  seed: (sessions: string[]) => void;
  /** The version of the copy in a dist folder, and that folder's npm prefix if it has one. */
  versionAt: (distDir: string) => string | null;
  globalPrefix: (distDir: string) => string | null;
  /** Two paths to one file. */
  same: (a: string, b: string) => boolean;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  say: (step: Step) => void;
  /** How long the service is given to finish what it holds, to come up, to be heard. */
  settleMs?: number;
  startMs?: number;
  heardMs?: number;
}

const LOOK_MS = 500;

type Receiver = Status["receivers"][number];
/** The service has had an answer from this receiver since it started, and nothing is
 *  wrong now. A poll that is only under way has heard nothing yet: `polling` is true
 *  from the moment the loop starts. */
const hears = (r: Receiver): boolean => r.polling && r.last_poll !== null && !r.last_error;
const hosts = (rs: Receiver[]): string => rs.map((r) => hostOf(r.url)).join(" and ");

/** What a restart would cut short, in the service's own words; null when nothing. A
 *  service older than 0.15 also called a session in someone's own window "in hand":
 *  that is not its to wait for. */
export function holding(st: Status): string | null {
  return st.busy && st.busy !== "a session on this machine mid-turn" ? st.busy : null;
}

/** Ask until `done` says yes or `ms` has passed; the last answer either way. */
async function until<T>(d: CurrentDeps, ms: number, ask: () => Promise<T>, done: (v: T) => boolean): Promise<T> {
  const end = d.now() + ms;
  for (;;) {
    const v = await ask();
    if (done(v) || d.now() >= end) return v;
    await d.sleep(LOOK_MS);
  }
}

export async function bringCurrent(d: CurrentDeps): Promise<Outcome> {
  // --- 1. the newest release, and this copy on it ---------------------------------------
  let target = d.version;
  let unasked: string | null = null;
  if (d.unasked) d.say({ mark: "info", text: `npm isn't asked for a newer release: ${d.unasked}` });
  else
    try {
      const latest = await d.latest();
      if (isNewer(latest, d.version)) target = latest;
      else d.say({ mark: "ok", text: `sessionpipe ${d.version} is the newest release` });
    } catch (e) {
      unasked = (e as Error).message;
      d.say({ mark: "warn", text: `couldn't ask npm for the newest release: ${unasked}` });
    }
  if (target !== d.version) {
    if (!d.prefix)
      return {
        state: "failed",
        error: `sessionpipe ${target} is out and this copy is ${d.version}, but npm didn't install this copy (it runs from ${d.distDir}), so npm can't update it`,
        next: "npx sessionpipe@latest update",
      };
    if (d.unwritable)
      // Windows has no sudo: the same command does it all from a terminal that may write there.
      return d.platform === "win32"
        ? {
            state: "failed",
            error: `sessionpipe ${target} is out and this copy is ${d.version}, but ${d.unwritable}. Open a terminal as administrator and run this there`,
            next: "sessionpipe update",
          }
        : {
            state: "failed",
            error: `sessionpipe ${target} is out and this copy is ${d.version}, but ${d.unwritable}`,
            next: `sudo npm install -g --prefix ${shq(d.prefix, d.platform)} sessionpipe@${target} && sessionpipe update`,
          };
  }

  // The service's own copy, when that is another install than this one.
  const look = d.look();
  const before = await d.status();
  const theirs = look?.argv?.[1] && !d.same(look.argv[1], d.cli) ? look.argv[1].replace(/[\\/]cli\.js$/, "") : null;
  const held = before ? holding(before) : null;

  // Nothing here is ever moved back to an older release: with npm out of reach this copy
  // may be the oldest of the three, and then it is the one thing that can't be fixed now.
  const ahead = [d.hooks(), before?.version ?? null, theirs ? d.versionAt(theirs) : null].find(
    (v) => v && isNewer(v, target, true),
  );
  if (ahead)
    return {
      state: "failed",
      error: unasked
        ? `this copy is sessionpipe ${d.version}, older than what already runs on this computer (${ahead}), and npm couldn't be asked for the newest release: ${unasked}. Nothing was changed`
        : `sessionpipe ${ahead} already runs on this computer, newer than npm's latest (${target}); nothing was changed`,
      next:
        unasked || !d.prefix
          ? "sessionpipe update"
          : `npm install -g --prefix ${shq(d.prefix, d.platform)} sessionpipe@${ahead}`,
    };

  let hooksError: string | null = null;
  if (target !== d.version) {
    // While the service holds something it can't be moved onto this copy yet: its own
    // copy is brought up too, so the restart it makes by itself lands on the new release.
    d.say({ mark: "info", text: `installing sessionpipe ${target} (this copy is ${d.version})…` });
    const r = await d.install(target, held && theirs && d.globalPrefix(theirs) ? [theirs] : []);
    if (!r.ok)
      return {
        state: "failed",
        error: `sessionpipe ${target} couldn't be installed (${r.error}); this computer still runs ${d.version}`,
        next: "sessionpipe update",
      };
    d.say({ mark: "ok", text: `sessionpipe ${target} installed (it was ${d.version})` });
    for (const dir of r.along ?? [])
      d.say({
        mark: "ok",
        text: `the background service's own copy (in ${d.globalPrefix(dir)}) is ${target} too`,
      });
    for (const o of r.others ?? [])
      d.say({ mark: "warn", text: `the other copy in ${o.dir} couldn't be updated (${o.error})` });
    if (!r.rearmed) hooksError = r.hooks;
  } else if (d.harnesses.length && d.hooks() !== target) {
    // --- 2. the hooks, where they run another version than this copy ---------------------
    const r = await d.rearm();
    if (!r.ok) hooksError = r.said;
  }
  if (hooksError) d.say({ mark: "warn", text: hooksError });
  else if (d.harnesses.length)
    d.say({ mark: "ok", text: `the hooks run sessionpipe ${target} (${d.harnesses.join(", ")})` });

  // --- 3. the service, on this copy -------------------------------------------------------
  let heard: Status | null = null;
  if (!d.wanted && !before)
    d.say({ mark: "info", text: "the background service isn't set up on this computer: nothing to restart" });
  else {
    let running = before;
    // A manager has it now; and someone asked for a service: its file is there (also
    // after a start that failed, which leaves the file and nothing loaded).
    const has = look?.loaded === true;
    const asked = look?.installed === true;
    // The manager is what puts it on this copy where it has it now and it runs another
    // copy, doesn't answer or has lost its file, and where it should have it and nothing
    // runs. A daemon that answers and that no manager has is someone's own to run: it is
    // asked to restart itself, and no service is installed that nobody asked for.
    if (has ? theirs || !before || !asked : asked && !before) {
      // Give it a moment to finish what it holds; a turn of its own can take an hour.
      if (held) {
        d.say({ mark: "info", text: `the background service is busy (${held}): giving it a moment…` });
        running = await until(d, d.settleMs ?? 25_000, d.status, (s) => !s || !holding(s));
      }
      const still = running ? holding(running) : null;
      if (still) {
        // It can't be moved now. It restarts itself when it is done, onto its own copy:
        // the new release, where that copy was brought up above.
        const will = (await d.restart()) && (!theirs || d.versionAt(theirs) === target);
        return {
          state: "waiting",
          version: target,
          said: will
            ? `The background service is busy: ${still}. It restarts by itself onto sessionpipe ${target} when that is done: nothing more to type.`
            : `The background service is busy: ${still}. Moving it onto this copy now would cut that short; when it is done, run \`sessionpipe update\` once more.`,
        };
      }
      // A service from before 0.15 writes nothing down when it is stopped, and the one
      // that replaces it would copy a session it didn't know was mid-turn. It is told
      // apart by what it answers: only one that remembers says which copy it is.
      if (running && !(await d.health())?.copy) {
        const turns = running.mid_turn ?? [];
        if (turns.length) d.seed(turns);
      }
      try {
        d.place();
      } catch (e) {
        return {
          state: "failed",
          error: `the background service couldn't be started: ${(e as Error).message}`,
          next: "sessionpipe update",
        };
      }
      running = await until(d, d.startMs ?? 30_000, d.status, (s) => s?.version === target);
      if (running?.version !== target)
        return {
          state: "failed",
          error: running
            ? `the background service was started, but it answers as sessionpipe ${running.version}, not ${target}`
            : "the background service was started and doesn't answer",
          next: "sessionpipe doctor",
        };
      d.say({
        mark: "ok",
        text: theirs
          ? `the background service now runs this copy (it ran another one, in ${d.globalPrefix(theirs) ?? theirs})`
          : before
            ? "the background service was started again on this copy"
            : "the background service is started",
      });
    } else if (!before) {
      // Nothing answers, and there is no service here to put back: no file for one, or
      // no manager that can be asked. Only a person can start it.
      return {
        state: "failed",
        error: d.apart
          ? `the background service isn't running, and nothing starts it by itself: ${d.apart}. Run it yourself, or give this one a service of its own with SESSIONPIPE_SERVICE_LABEL=org.sessionpipe.<name>`
          : "the background service isn't running, and nothing on this computer starts it by itself",
        next: "sessionpipe control run",
      };
    } else if (before.version !== target) {
      // It runs this copy already, or someone runs it by hand: it restarts itself.
      const copy = (await d.health())?.copy;
      if (copy && !d.same(copy.cli, d.cli))
        return copy.via === "launchd" || copy.via === "systemd"
          ? {
              state: "failed",
              error: `the background service runs another copy (${copy.cli}) on sessionpipe ${before.version}, and ${copy.via} can't be asked from this shell to move it onto this one. Run this from a terminal you opened on this computer yourself`,
              next: "sessionpipe update",
            }
          : {
              state: "failed",
              error: `the background service was started by hand from another copy (${copy.cli}) and runs sessionpipe ${before.version}: stop it where it runs, then start this one`,
              next: "sessionpipe control run",
            };
      const will = await d.restart();
      if (will) running = await until(d, d.settleMs ?? 25_000, d.status, (s) => s?.version === target);
      if (running?.version !== target) {
        // It took the restart and waits for something: that ends by itself. What it
        // waits for is said as it is. One from before 0.15 waits for every session on
        // this computer to end its turn, which is not a failure of this command's.
        if (will && running?.busy)
          return {
            state: "waiting",
            version: target,
            said: holding(running)
              ? `The background service is busy: ${running.busy}. It restarts by itself onto sessionpipe ${target} when that is done: nothing more to type.`
              : `The background service still runs sessionpipe ${running.version}, which waits for the sessions on this computer to end their turn before it restarts. It restarts by itself onto sessionpipe ${target} when the one it waits for ends its turn: nothing more to type.`,
          };
        if (will && !running)
          return {
            state: "failed",
            error: `the background service stopped to restart onto sessionpipe ${target} and doesn't answer`,
            next: "sessionpipe doctor",
          };
        // One a manager has can be asked again. One that someone started is theirs to
        // stop and start: that always puts it on the copy they type.
        return has
          ? {
              state: "failed",
              error: `the background service still runs sessionpipe ${before.version} and didn't restart onto ${target}`,
              next: "sessionpipe update",
            }
          : {
              state: "failed",
              error: `the background service still runs sessionpipe ${before.version} and didn't restart onto ${target}. It was started by hand: stop it where it runs, then start it again`,
              next: "sessionpipe control run",
            };
      }
      d.say({ mark: "ok", text: `the background service restarted onto sessionpipe ${target}` });
    } else d.say({ mark: "ok", text: `the background service runs sessionpipe ${target}` });

    // --- 4. a look: it has heard from its receivers ----------------------------------------
    heard = await d.status();
    if (heard && !heard.receivers.every(hears)) {
      d.say({
        mark: "info",
        text: `waiting for ${hosts(heard.receivers.filter((r) => !hears(r)))} to answer the background service…`,
      });
      heard = await until(d, d.heardMs ?? 40_000, d.status, (s) => !s || s.receivers.every(hears));
    }
    if (!heard)
      return {
        state: "failed",
        error: `the background service was running sessionpipe ${target} and has stopped answering`,
        next: "sessionpipe doctor",
      };
  }

  // --- the last line: one version everywhere, unless something above stood in the way -----
  const parts = [
    "the command",
    ...(d.harnesses.length ? ["the hooks"] : []),
    ...(heard ? ["the background service"] : []),
  ];
  const hearing = heard?.receivers.filter(hears) ?? [];
  const deaf = heard?.receivers.filter((r) => !hears(r)) ?? [];
  const what =
    (parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : "the command") +
    (hearing.length ? `, which hears ${hosts(hearing)}` : "");
  // A receiver that hasn't answered: said, with what the service last heard of it.
  const warn = deaf
    .map(
      (r) => `${hostOf(r.url)} hasn't answered the background service${r.last_error ? `: ${r.last_error}.` : " yet."}`,
    )
    .join(" ");
  if (hooksError)
    return {
      state: "failed",
      error: `the hooks couldn't be written again from this copy (${hooksError.replace(/; `sessionpipe install` does it$/, "")})`,
      next: "sessionpipe install",
    };
  if (unasked)
    return {
      state: "failed",
      error: `couldn't ask npm whether there is a newer release: ${unasked}. Everything on this computer runs sessionpipe ${target}: ${what}`,
      next: "sessionpipe update",
    };
  return {
    state: "current",
    version: target,
    said: d.unasked
      ? `Everything on this computer runs sessionpipe ${target}: ${what}. npm was not asked for a newer release.`
      : `This computer is up to date: sessionpipe ${target} runs ${what}.`,
    ...(warn ? { warn: `${warn} \`sessionpipe doctor\` looks again.` } : {}),
  };
}
