// SPDX-License-Identifier: Apache-2.0
// The detached worker in-process: it claims its job by rename, runs it, starts a fresh
// worker for a job the session's lock held out (up to MAX_TRIES), sweeps, and exits
// within 15 s whatever the job does.
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DrainLife, drain, enqueueJob, MAX_TRIES, runJob, sweepJobs } from "../src/run.js";

const spawned = vi.hoisted(() => ({ spawn: vi.fn(), unref: vi.fn() }));
vi.mock("node:child_process", async (orig) => ({
  ...(await orig<typeof import("node:child_process")>()),
  spawn: (...a: unknown[]) => {
    spawned.spawn(...a);
    return { unref: spawned.unref };
  },
}));
vi.mock("../src/run.js", async (orig) => {
  const m = await orig<typeof import("../src/run.js")>();
  return { ...m, runJob: vi.fn(m.runJob), sweepJobs: vi.fn(m.sweepJobs), drain: vi.fn(m.drain) };
});

import { DRAIN_ARG, WORKER_LIFE_MS, workerMain } from "../src/worker.js";

const here = path.dirname(fileURLToPath(import.meta.url));
let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "sp-worker-"));
  process.env.SESSIONPIPE_STATE = tmp;
  process.env.SESSIONPIPE_CONFIG = path.join(tmp, "config.json");
  writeFileSync(process.env.SESSIONPIPE_CONFIG, JSON.stringify({ sinks: [], harnesses: {} }));
  spawned.spawn.mockClear();
  spawned.unref.mockClear();
  vi.mocked(runJob).mockReset();
  vi.mocked(sweepJobs).mockReset();
  vi.mocked(drain).mockReset();
  vi.mocked(drain).mockResolvedValue({});
  vi.mocked(runJob).mockResolvedValue({ events: [], delivered: {} });
  vi.mocked(sweepJobs).mockResolvedValue(0);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  rmSync(tmp, { recursive: true, force: true });
});

const job = (tries?: number) => ({
  harness: "codex",
  event: "Stop",
  argv: ["codex", "Stop"],
  stdin: JSON.stringify({ session_id: "w-1", cwd: tmp }),
  cwd: tmp,
  env: {},
  at: Date.now(),
  ...(tries === undefined ? {} : { tries }),
});
const argv = (file?: string) => [process.execPath, "/opt/sessionpipe/worker.js", ...(file ? [file] : [])];
const queue = () => readdirSync(path.join(tmp, "jobs"));

describe("the worker", () => {
  it("without a job file, or with one already taken, it does nothing", async () => {
    await workerMain(argv());
    await workerMain(argv(path.join(tmp, "jobs", "gone.json")));
    expect(runJob).not.toHaveBeenCalled();
    expect(sweepJobs).not.toHaveBeenCalled();
  });

  it("claims the job by rename, runs it under that claim, releases it, then sweeps the state dir", async () => {
    const j = job();
    const f = enqueueJob(tmp, j);
    let seen: string[] = [];
    vi.mocked(runJob).mockImplementation(async () => {
      seen = queue();
      return { events: [], delivered: {} };
    });
    await workerMain(argv(f));
    expect(seen).toEqual([`${path.basename(f)}.${process.pid}.running`]);
    const life = { deadline: expect.any(Number), handoff: expect.any(Function) };
    expect(runJob).toHaveBeenCalledWith(j, { claimed: `${f}.${process.pid}.running`, ...life });
    expect(queue()).toEqual([]);
    expect(sweepJobs).toHaveBeenCalledWith(tmp, undefined, undefined, undefined, life);
    expect(spawned.spawn).not.toHaveBeenCalled();
  });

  it("tells the drain and the sweep when it will be ended; a drain left marked starts one drainer, once", async () => {
    const before = Date.now();
    let life: DrainLife = {};
    vi.mocked(runJob).mockImplementation(async (_j, o) => {
      life = o as DrainLife;
      return { events: [], delivered: {} };
    });
    await workerMain(argv(enqueueJob(tmp, job())));
    expect(life.deadline).toBeGreaterThanOrEqual(before + WORKER_LIFE_MS);
    expect(life.deadline).toBeLessThanOrEqual(Date.now() + WORKER_LIFE_MS);
    life.handoff?.();
    life.handoff?.();
    expect(spawned.spawn).toHaveBeenCalledTimes(1);
    expect(spawned.spawn).toHaveBeenCalledWith(process.execPath, ["/opt/sessionpipe/worker.js", DRAIN_ARG], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
  });

  it(`${DRAIN_ARG}: no job, it drains and sweeps under its own life; a drain that throws is swallowed`, async () => {
    await workerMain(argv(DRAIN_ARG));
    expect(runJob).not.toHaveBeenCalled();
    const life = { deadline: expect.any(Number), handoff: expect.any(Function) };
    expect(drain).toHaveBeenCalledWith(tmp, [], expect.anything(), undefined, life);
    expect(sweepJobs).toHaveBeenCalledWith(tmp, undefined, undefined, undefined, life);
    vi.mocked(drain).mockRejectedValue(new Error("boom"));
    await expect(workerMain(argv(DRAIN_ARG))).resolves.toBeUndefined();
  });

  it("a job the lock held out gets a fresh worker, this script again, detached", async () => {
    const f = enqueueJob(tmp, job());
    vi.mocked(runJob).mockResolvedValue({ events: [], delivered: {}, requeued: path.join(tmp, "jobs", "again.json") });
    await workerMain(argv(f));
    expect(spawned.spawn).toHaveBeenCalledWith(
      process.execPath,
      ["/opt/sessionpipe/worker.js", path.join(tmp, "jobs", "again.json")],
      { detached: true, stdio: "ignore", windowsHide: true },
    );
    expect(spawned.unref).toHaveBeenCalledTimes(1);
  });

  it("after MAX_TRIES in a row no worker is started: a later sweep picks the job up", async () => {
    vi.mocked(runJob).mockResolvedValue({ events: [], delivered: {}, requeued: path.join(tmp, "jobs", "again.json") });
    await workerMain(argv(enqueueJob(tmp, job(MAX_TRIES - 2))));
    expect(spawned.spawn).toHaveBeenCalledTimes(1);
    await workerMain(argv(enqueueJob(tmp, job(MAX_TRIES - 1))));
    expect(spawned.spawn).toHaveBeenCalledTimes(1);
  });

  it("a job that throws is still released and the sweep still runs; a sweep that throws is swallowed", async () => {
    const f = enqueueJob(tmp, job());
    vi.mocked(runJob).mockRejectedValue(new Error("boom"));
    vi.mocked(sweepJobs).mockRejectedValue(new Error("sweep"));
    await expect(workerMain(argv(f))).resolves.toBeUndefined();
    expect(queue()).toEqual([]);
    expect(sweepJobs).toHaveBeenCalledTimes(1);
  });

  it("exits at 15 s whatever the job is doing; a job that ends in time cancels that", async () => {
    vi.useFakeTimers();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const done = workerMain(argv(enqueueJob(tmp, job())));
    await vi.advanceTimersByTimeAsync(20_000);
    await done;
    expect(exit).not.toHaveBeenCalled();
    vi.mocked(runJob).mockReturnValue(new Promise(() => {}));
    void workerMain(argv(enqueueJob(tmp, job())));
    await vi.advanceTimersByTimeAsync(14_999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("`node worker.js <job>` runs the job for real and exits 0", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const real = await vi.importActual<typeof import("../src/run.js")>("../src/run.js");
    vi.mocked(runJob).mockImplementation(real.runJob);
    vi.mocked(sweepJobs).mockImplementation(real.sweepJobs);
    const f = enqueueJob(tmp, job());
    const saved = process.argv;
    process.argv = [process.execPath, path.resolve(here, "../src/worker.ts"), f];
    try {
      vi.resetModules();
      await import("../src/worker.js");
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
      expect(existsSync(f)).toBe(false);
      expect(existsSync(path.join(tmp, "outbox", "codex"))).toBe(true);
    } finally {
      process.argv = saved;
    }
  });
});
