// SPDX-License-Identifier: Apache-2.0
// Two things about the jobs folder that only show with the file system stood in for: a
// claim whose time cannot be set, and how much of the folder one sweep reads.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fsState = vi.hoisted(() => ({
  utimes: null as (() => never) | null,
  /** Called with each file about to be written or moved; throws to refuse it. */
  refuse: null as ((op: "write" | "rename", file: string) => void) | null,
  reads: 0,
}));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const stood = {
    ...real,
    utimesSync: (...a: Parameters<typeof real.utimesSync>) => {
      fsState.utimes?.();
      return real.utimesSync(...a);
    },
    writeFileSync: (...a: Parameters<typeof real.writeFileSync>) => {
      fsState.refuse?.("write", String(a[0]));
      return real.writeFileSync(...a);
    },
    renameSync: (...a: Parameters<typeof real.renameSync>) => {
      fsState.refuse?.("rename", String(a[0]));
      return real.renameSync(...a);
    },
    opendirSync: (...a: Parameters<typeof real.opendirSync>) => {
      const dir = real.opendirSync(...a);
      const read = dir.readSync.bind(dir);
      dir.readSync = () => {
        fsState.reads++;
        return read();
      };
      return dir;
    },
  };
  return { ...stood, default: stood };
});

const { claimJob, enqueueJob, jobsDir, runJob, SWEEP_READ, sweepJobs } = await import("../src/run.js");

const tmp = mkdtempSync(path.join(os.tmpdir(), "sp-claims-"));
afterEach(() => {
  fsState.utimes = null;
  fsState.refuse = null;
  rmSync(tmp, { recursive: true, force: true });
});
process.env.SESSIONPIPE_CONFIG = path.join(tmp, "config.json");

const job = (event: string, extra: Record<string, unknown> = {}) => ({
  harness: "codex",
  event,
  argv: ["codex", event],
  stdin: JSON.stringify({ session_id: "claims-1", cwd: tmp, hook_event_name: event, model: "m", ...extra }),
  cwd: tmp,
  env: {},
  at: Date.now(),
});

describe("claims and the jobs folder, with the file system stood in for", () => {
  // A share that keeps no times, a file an indexer holds open: the claim is still there,
  // so it is still this worker's. Taken for gone, its job was deleted without being run.
  it("a claim whose time cannot be set is still its worker's: the job is run", async () => {
    const f = enqueueJob(tmp, job("SessionEnd", { reason: "exit" }));
    fsState.utimes = () => {
      throw Object.assign(new Error("EPERM: operation not permitted, utime"), { code: "EPERM" });
    };
    const c = claimJob(f);
    expect(readdirSync(jobsDir(tmp))).toEqual([path.basename(c?.file as string)]);
    const r = await runJob(c?.job as Parameters<typeof runJob>[0], { state: tmp, claimed: c?.file as string });
    expect(r.events.map((e) => e.type)).toEqual(["session.ended"]);
    expect(readdirSync(jobsDir(tmp))).toEqual([]);
  });

  // A session's facts hold its transcript cursor. They are written beside the file and
  // moved into its place, so a full disk or a kill leaves them whole or as they were; and
  // where the move, or the file beside, is refused, in place as they always were.
  it("a session's facts are written beside the file and moved into its place; in place where that is refused", async () => {
    const facts = path.join(tmp, "facts", "codex", "claims-1.json");
    const moved: string[] = [];
    fsState.refuse = (op, file) => {
      if (op === "rename" && file.startsWith(`${facts}.`)) moved.push(path.basename(file));
    };
    await runJob({ ...job("SessionStart", { source: "startup" }), id: "a" }, { state: tmp, drain: false });
    expect(moved.length).toBeGreaterThan(0);
    expect(moved.every((n) => n === `claims-1.json.${process.pid}.tmp`)).toBe(true);
    expect(JSON.parse(readFileSync(facts, "utf8")).ran).toEqual(["a"]);
    expect(readdirSync(path.dirname(facts))).toEqual(["claims-1.json"]);
    // The move refused (another program has the file open): written in place, nothing left beside.
    fsState.refuse = (op, file) => {
      if (op === "rename" && file.endsWith(".tmp")) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    };
    await runJob({ ...job("SessionEnd", { reason: "exit" }), id: "b" }, { state: tmp, drain: false });
    expect(JSON.parse(readFileSync(facts, "utf8")).ran).toEqual(["b", "a"]);
    expect(readdirSync(path.dirname(facts))).toEqual(["claims-1.json"]);
    // The file beside refused too (a folder that takes no new files): in place all the same.
    fsState.refuse = (op, file) => {
      if (op === "write" && file.endsWith(".tmp")) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    };
    await runJob({ ...job("SessionStart", { source: "resume" }), id: "c" }, { state: tmp, drain: false });
    expect(JSON.parse(readFileSync(facts, "utf8")).ran).toEqual(["c", "b", "a"]);
    expect(readdirSync(path.dirname(facts))).toEqual(["claims-1.json"]);
  });

  // Every worker sweeps, and a sweep listed and sorted the whole folder. With 152 800
  // files in it (2026-11-20) and 800 workers at it, the first name took 38 s to come.
  it("a sweep reads SWEEP_READ names of the folder and no more, however many it holds", async () => {
    /** `n` jobs no adapter takes, written a while ago, in a state folder of their own. */
    const queued = (name: string, n: number): string => {
      const state = path.join(tmp, name);
      mkdirSync(jobsDir(state), { recursive: true });
      const old = new Date(Date.now() - 10_000);
      for (let i = 0; i < n; i++) {
        const f = path.join(jobsDir(state), `${(1000 + i).toString(36)}-${name}.json`);
        writeFileSync(
          f,
          JSON.stringify({
            harness: "no-such-harness",
            event: "Stop",
            argv: [],
            stdin: "{}",
            cwd: tmp,
            env: {},
            at: 1,
          }),
        );
        utimesSync(f, old, old);
      }
      return state;
    };
    const all = SWEEP_READ + 45;
    const state = queued("behind", all);
    fsState.reads = 0;
    expect(await sweepJobs(state, 0)).toBe(20);
    expect(fsState.reads).toBe(SWEEP_READ);
    expect(readdirSync(jobsDir(state))).toHaveLength(all - 20);
    // A folder that holds fewer is read to its end: every name, then the one that says so.
    const small = queued("small", 3);
    fsState.reads = 0;
    expect(await sweepJobs(small, 0)).toBe(3);
    expect(fsState.reads).toBe(4);
  });
});
