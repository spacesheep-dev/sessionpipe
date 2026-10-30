// SPDX-License-Identifier: Apache-2.0
// The daemon's auto-update at its edges: the words `status` says, the clock, an
// updater stopped or busy at the wrong moment, a restart that fails, and the
// supervisor's child that crashes, can't start, or is stopped before it runs.
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AutoUpdater,
  ago,
  readUpdate,
  restartVia,
  supervise,
  UPDATE_EXIT,
  type UpdaterDeps,
  updateLine,
  updateSummary,
} from "../src/control/autoupdate.js";

let tmp: string;
const NOW = Date.parse("2026-10-04T12:00:00Z");

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "sp-autoupd-"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

/** An updater against fakes whose answers each test scripts. */
function harness(over: Partial<UpdaterDeps> = {}, o: { busy?: (string | null)[]; noIdlePoll?: boolean } = {}) {
  const calls: string[] = [];
  const lines: string[] = [];
  const busy = [...(o.busy ?? [])];
  let clock = NOW;
  const deps: UpdaterDeps = {
    now: () => clock,
    log: (l) => lines.push(l),
    version: "0.5.0",
    file: path.join(tmp, "control", "update.json"),
    off: () => null,
    latest: async () => "0.6.0",
    installed: async () => "0.5.0",
    install: async (v) => {
      calls.push(`install ${v}`);
      return { ok: true, ms: 1 };
    },
    daemon: {
      busy: () => (busy.length ? (busy.shift() as string | null) : null),
      pauseIntake: () => calls.push("pause"),
      resumeIntake: () => calls.push("resume"),
    },
    restart: async (from, to) => {
      calls.push(`restart ${from}→${to}`);
    },
    idlePollMs: 1,
    ...over,
  };
  if (o.noIdlePoll) delete deps.idlePollMs;
  return {
    u: new AutoUpdater(deps),
    deps,
    calls,
    lines,
    tick: (ms: number) => (clock += ms),
    record: () => readUpdate(deps.file),
  };
}

describe("what status says", () => {
  it("a record that isn't a record is empty", () => {
    const f = path.join(tmp, "update.json");
    writeFileSync(f, "null");
    expect(readUpdate(f)).toEqual({});
    writeFileSync(f, '"soon"');
    expect(readUpdate(f)).toEqual({});
  });
  it("how long ago, in words", () => {
    expect(ago("garbage", NOW)).toBe("at an unreadable time");
    expect(ago(new Date(NOW - 10_000).toISOString(), NOW)).toBe("just now");
    expect(ago(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe("5 min ago");
    expect(ago(new Date(NOW - 3 * 3600_000).toISOString(), NOW)).toBe("3 h ago");
    expect(ago(new Date(NOW - 4 * 24 * 3600_000).toISOString(), NOW)).toBe("4 days ago");
  });
  it("one line: automatic or why not, the last check, what waits, what failed or was done", () => {
    const base = updateSummary({ off: null, paired: true, rec: {} });
    expect(updateLine(base, NOW)).toBe(
      "automatic (the control daemon checks npm once a day and installs when idle; `sessionpipe update off` stops it) · not checked yet (a minute after the daemon starts)",
    );
    const checked = new Date(NOW - 60_000).toISOString();
    expect(updateLine({ ...base, last_check: checked, latest: "0.6.0", pending: "0.6.0" }, NOW)).toBe(
      "automatic (the control daemon checks npm once a day and installs when idle; `sessionpipe update off` stops it) · last check just now: latest 0.6.0 · 0.6.0 waits for the daemon to be idle",
    );
    expect(updateLine({ ...base, last_check: checked, last_error: "ENOTFOUND" }, NOW)).toContain(
      "last check just now failed: ENOTFOUND",
    );
    expect(updateLine({ ...base, last_check: checked }, NOW)).toContain("latest ?");
    const byHand = updateSummary({ off: null, paired: true, rec: {}, platform: "win32" });
    expect(byHand.auto).toBe(false);
    expect(byHand.off).toBe(
      "it runs in the control daemon, which has no service on Windows yet: it checks while `sessionpipe control run` is running",
    );
    expect(updateSummary({ off: null, paired: true, rec: {}, platform: "linux" }).auto).toBe(true);
    const off = updateSummary({ off: "npx", paired: false, rec: {} });
    expect(
      updateLine(
        {
          ...off,
          failed: { version: "0.6.0", at: checked, error: "npm: 403" },
          updated: { from: "a", to: "b", at: checked, ms: 1 },
        },
        NOW,
      ),
    ).toBe("not automatic: npx · installing 0.6.0 failed just now: npm: 403");
    expect(updateLine({ ...off, updated: { from: "0.4.0", to: "0.5.0", at: checked, ms: 1 } }, NOW)).toBe(
      "not automatic: npx · updated 0.4.0 → 0.5.0 just now",
    );
  });
  it("on linux without a cgroup reader it reads the process's own; a stranger's cgroup is nobody", () => {
    expect(restartVia({ env: {}, platform: "linux", pid: 1, ppid: 1 })).toBeNull();
  });
});

describe("the updater's edges", () => {
  it("looks at the clock on its own, at the pace it was given", async () => {
    vi.useFakeTimers();
    const { u, calls, lines } = harness({ firstCheckMs: 60_000, tickMs: 1000, latest: async () => "0.5.0" });
    u.start();
    await vi.advanceTimersByTimeAsync(999);
    expect(lines).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(lines).toEqual(["update check: 0.5.0 is current (npm latest 0.5.0, 0 ms)"]);
    u.stop();
    expect(calls).toEqual([]);
  });

  it("stopping before it started is fine; a stopped updater declines restarts and ticks", async () => {
    const { u, calls } = harness();
    u.stop();
    expect(u.restartWhenIdle()).toBe(false);
    await u.tick();
    expect(calls).toEqual([]);
  });

  it("one job at a time: a second check joins the first; a restart asked meanwhile is accepted", async () => {
    let release!: (v: string) => void;
    const { u, calls } = harness({ latest: () => new Promise((r) => (release = r)) });
    const a = u.check();
    const b = u.check();
    expect(b).toBe(a);
    expect(u.restartWhenIdle()).toBe(true);
    await u.tick();
    release("0.5.0");
    await a;
    expect(calls).toEqual([]);
  });

  it("turned off, then on again: both are said once", async () => {
    const answers: (string | null)[] = ["by hand", "by hand", null, null];
    const { u, lines, record } = harness({ off: () => answers.shift() ?? null, latest: async () => "0.5.0" });
    await u.tick();
    await u.tick();
    expect(lines).toEqual(["auto-update off: by hand"]);
    expect(record().off).toBe("by hand");
    await u.tick();
    expect(lines[1]).toBe("auto-update on");
    expect(record().off).toBeNull();
  });

  it("a registry that fails with something that isn't an Error is still a reason", async () => {
    const { u, record, lines } = harness({ latest: async () => Promise.reject("ECONNRESET") });
    await u.check();
    expect(record()).toMatchObject({ latest: null, error: "ECONNRESET" });
    expect(lines[0]).toContain("failed after 0 ms: ECONNRESET");
  });

  it("stopped while waiting to be idle: it stops waiting, quietly", async () => {
    const { u, calls, lines } = harness({
      daemon: { busy: () => "a run that never ends", pauseIntake: () => calls.push("pause"), resumeIntake: () => {} },
    });
    const job = u.check();
    await new Promise((r) => setTimeout(r, 5));
    u.stop();
    await job;
    expect(calls).toEqual([]);
    expect(lines.some((l) => l.startsWith("update: stopped"))).toBe(false);
  });

  it("idle, paused, then busy again: intake resumes and it waits once more", async () => {
    const { u, calls } = harness({}, { busy: [null, "a prompt came in", null, null] });
    await u.check();
    expect(calls).toEqual(["pause", "resume", "pause", "install 0.6.0", "restart 0.5.0→0.6.0"]);
  });

  it("a restart that throws lets intake go and is logged", async () => {
    const { u, calls, lines } = harness({
      restart: async () => {
        throw new Error("spawn EACCES");
      },
    });
    await u.check();
    expect(calls).toEqual(["pause", "install 0.6.0", "resume"]);
    expect(lines.at(-1)).toBe("update: spawn EACCES");
    const raw = harness({ restart: async () => Promise.reject("no exec") });
    await raw.u.check();
    expect(raw.lines.at(-1)).toBe("update: no exec");
  });

  it("the copy on disk can't be read: a restart asked for stays put", async () => {
    const { u, calls, lines } = harness({ installed: async () => null });
    expect(u.restartWhenIdle()).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    expect(calls).toEqual([]);
    expect(lines.at(-1)).toContain("the copy on disk is unreadable, the one running; staying");
  });

  it("installed, but something came in over the socket while npm ran: it ends first, then the restart", async () => {
    const { u, calls } = harness({ installed: async () => null }, { busy: [null, null, "a permission prompt", null] });
    await u.check();
    expect(calls).toEqual(["pause", "install 0.6.0", "resume", "pause", "restart 0.5.0→0.6.0"]);
  });

  it("without an idle poll of its own it looks every fifteen seconds", async () => {
    vi.useFakeTimers();
    const { u, calls } = harness({}, { busy: ["a run", null, null], noIdlePoll: true });
    const job = u.check();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await job;
    expect(calls).toContain("restart 0.5.0→0.6.0");
  });
});

describe("the supervisor's child", () => {
  /** A stand-in spawn: the child is an emitter the test drives. */
  function fakeSpawn() {
    const children: (EventEmitter & { kill: ReturnType<typeof vi.fn> })[] = [];
    const spawn = vi.fn(() => {
      const c = Object.assign(new EventEmitter(), { kill: vi.fn() });
      children.push(c);
      return c as never;
    });
    return { spawn, children };
  }

  it("a child that can't start is started again after the pause; a second end is ignored", async () => {
    vi.useFakeTimers();
    const { spawn, children } = fakeSpawn();
    const lines: string[] = [];
    const exit = vi.fn();
    supervise({ node: "node", args: [], env: {}, log: (l) => lines.push(l), spawn, exit, failDelayMs: 5000 });
    children[0]!.emit("error", new Error("ENOENT"));
    children[0]!.emit("exit", 1, null);
    expect(lines).toEqual([
      "couldn't start the daemon: ENOENT",
      "the daemon exited (code 1); starting it again in 5 s",
    ]);
    await vi.advanceTimersByTimeAsync(4999);
    expect(spawn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(exit).not.toHaveBeenCalled();
  });

  it("stopped while waiting to start again: no new child, exit 0; stopped with a child: the signal goes to it", () => {
    vi.useFakeTimers();
    const { spawn, children } = fakeSpawn();
    const exit = vi.fn();
    const sup = supervise({ node: "node", args: [], env: {}, log: () => {}, spawn, exit });
    children[0]!.emit("exit", null, "SIGKILL");
    sup.stop();
    vi.advanceTimersByTime(10_000);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    const two = supervise({ node: "node", args: [], env: {}, log: () => {}, spawn, exit });
    two.stop("SIGHUP");
    expect(children[1]!.kill).toHaveBeenCalledWith("SIGHUP");
    // The child ends on a signal: the supervisor exits 0 with it.
    children[1]!.emit("exit", null, "SIGHUP");
    expect(exit).toHaveBeenLastCalledWith(0);
  });

  it("the default pause is five seconds, and the default exit is the process's own", () => {
    vi.useFakeTimers();
    const { spawn, children } = fakeSpawn();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    supervise({ node: "node", args: [], env: {}, log: () => {}, spawn });
    children[0]!.emit("exit", 2, null);
    vi.advanceTimersByTime(4999);
    expect(spawn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(spawn).toHaveBeenCalledTimes(2);
    children[1]!.emit("exit", UPDATE_EXIT, null);
    expect(spawn).toHaveBeenCalledTimes(3);
    children[2]!.emit("exit", 0, null);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
