#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// The detached worker. `node worker.js <job>`: the job file is claimed (renamed, so
// a sweeper racing for it loses); adapter turns the payload into events; facts are
// merged; every event is appended to the outbox with its seq, and the claim is
// released; on a turn end the transcript is read from the stored offset for tier-2
// sinks; then the sinks are drained from their cursors, unless another worker is
// at it (run.ts drain: this one leaves its events to it). Exits within 15 s: a
// claim still held then is a job a sweep gives back; a sink that cannot be reached
// waits as HTTP.md §2 says, for every worker. A job the session's
// lock held out goes back to the queue, and a fresh worker is started for it (up
// to MAX_TRIES in a row; then a later worker's sweep picks it up).
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Outbox, readConfig, stateDir } from "@sessionpipe/core";
import { claimJob, type DrainLife, drain, MAX_TRIES, releaseJob, runJob, sweepJobs } from "./run.js";
import { refreshSinks } from "./wellknown.js";

/** How long a worker lives. */
export const WORKER_LIFE_MS = 15_000;
/** The argument that starts a worker with no job, to drain what another left marked. */
export const DRAIN_ARG = "--drain";

/** Start a detached worker: for a job file, or (DRAIN_ARG) only to drain. */
function startWorker(script: string, arg: string): void {
  const p = spawn(process.execPath, [script, arg], { detached: true, stdio: "ignore", windowsHide: true });
  p.unref();
}

/** One worker run over `argv` as node received it ([node, worker.js, job]). Resolves
 *  once the job is done and the sweep is over; the process then exits 0. A drain
 *  that finds this worker's life too short for another pass leaves the work marked
 *  and starts one fresh worker to take it over (at most one per worker). */
export async function workerMain(argv: string[]): Promise<void> {
  const jobFile = argv[2];
  if (!jobFile) return;
  const script = argv[1] as string;
  let handedOff = false;
  const life: DrainLife = {
    deadline: Date.now() + WORKER_LIFE_MS,
    handoff: () => {
      if (handedOff) return;
      handedOff = true;
      startWorker(script, DRAIN_ARG);
    },
  };
  const deadline = setTimeout(() => process.exit(0), WORKER_LIFE_MS);
  deadline.unref();
  // A receiver's well-known file, read again once a day (its cap, the tool events it
  // asks for): before the drain, so this pass already sends what it asked.
  await refreshSinks();
  if (jobFile === DRAIN_ARG) {
    await drain(stateDir(), readConfig().sinks, new Outbox(stateDir()), undefined, life)
      .then(() => sweepJobs(stateDir(), undefined, undefined, undefined, life))
      .catch(() => {})
      .finally(() => clearTimeout(deadline));
    return;
  }
  const claimed = claimJob(jobFile);
  if (!claimed) {
    clearTimeout(deadline);
    return;
  }
  await runJob(claimed.job, { claimed: claimed.file, ...life })
    .then((r) => {
      if (!r.requeued || (claimed.job.tries ?? 0) + 1 >= MAX_TRIES) return;
      startWorker(script, r.requeued);
    })
    .catch(() => {})
    .finally(() => releaseJob(claimed.file))
    .then(() => sweepJobs(stateDir(), undefined, undefined, undefined, life))
    .catch(() => {})
    .finally(() => clearTimeout(deadline));
}

// Run as `node worker.js <job>`; importing this module runs nothing (real path: see hook.ts).
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  workerMain(process.argv).finally(() => process.exit(0));
