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
import { stateDir } from "@sessionpipe/core";
import { claimJob, MAX_TRIES, releaseJob, runJob, sweepJobs } from "./run.js";

/** One worker run over `argv` as node received it ([node, worker.js, job]). Resolves
 *  once the job is done and the sweep is over; the process then exits 0. */
export async function workerMain(argv: string[]): Promise<void> {
  const jobFile = argv[2];
  if (!jobFile) return;
  const claimed = claimJob(jobFile);
  if (!claimed) return;
  const deadline = setTimeout(() => process.exit(0), 15_000);
  deadline.unref();
  await runJob(claimed.job, { claimed: claimed.file })
    .then((r) => {
      if (!r.requeued || (claimed.job.tries ?? 0) + 1 >= MAX_TRIES) return;
      const p = spawn(process.execPath, [argv[1] as string, r.requeued], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      p.unref();
    })
    .catch(() => {})
    .finally(() => releaseJob(claimed.file))
    .then(() => sweepJobs(stateDir()))
    .catch(() => {})
    .finally(() => clearTimeout(deadline));
}

// Run as `node worker.js <job>`; importing this module runs nothing (real path: see hook.ts).
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  workerMain(process.argv).finally(() => process.exit(0));
