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
import { stateDir } from "@sessionpipe/core";
import { claimJob, MAX_TRIES, releaseJob, runJob, sweepJobs } from "./run.js";

const jobFile = process.argv[2];
if (!jobFile) process.exit(0);
const claimed = claimJob(jobFile);
if (!claimed) process.exit(0);
const deadline = setTimeout(() => process.exit(0), 15_000);
deadline.unref();
runJob(claimed.job, { claimed: claimed.file })
  .then((r) => {
    if (!r.requeued || (claimed.job.tries ?? 0) + 1 >= MAX_TRIES) return;
    const p = spawn(process.execPath, [process.argv[1] as string, r.requeued], {
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
  .finally(() => process.exit(0));
