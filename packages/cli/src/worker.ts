#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// The detached worker. `node worker.js <job>`: adapter turns the payload into
// events; facts are merged; every event is appended to the outbox with its seq;
// on a turn end the transcript is read from the stored offset for tier-2 sinks;
// then the machine's one delivery drains every sink from its cursor (a worker that
// finds one running leaves it a mark: run.ts deliver). Exits within 15 s; a sink
// that cannot be reached, or is waiting out a 429, is left for a later worker,
// which drains the backlog first.
import { readFileSync, unlinkSync } from "node:fs";
import { Outbox, readConfig, stateDir } from "@sessionpipe/core";
import { deliver, runJob, sweepJobs } from "./run.js";

const jobFile = process.argv[2];
if (!jobFile) process.exit(0);
let job: Parameters<typeof runJob>[0] | null = null;
try {
  job = JSON.parse(readFileSync(jobFile, "utf8"));
} catch {}
try {
  unlinkSync(jobFile);
} catch {}
if (!job) process.exit(0);
const deadline = setTimeout(() => process.exit(0), 15_000);
deadline.unref();
// Delivery rounds stop at 7 s and the sweep starts no job after that: a swept job is
// out of the queue while it runs, and one that then waits the full 6 s for its
// session's lock still ends before the deadline. One last delivery sends what the
// sweep appended.
const started = Date.now();
const until = started + 7_000;
runJob(job, { until })
  .catch(() => {})
  .then(() => sweepJobs(stateDir(), 3000, 20, { until }))
  .then((swept) =>
    swept
      ? deliver(stateDir(), readConfig().sinks, new Outbox(stateDir()), undefined, { until: started + 12_000 })
      : undefined,
  )
  .catch(() => {})
  .finally(() => process.exit(0));
