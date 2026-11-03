// SPDX-License-Identifier: Apache-2.0
// Issue #208: a workflow of a hundred subagents fired a hook per tool call, a request
// per hook, and a receiver that allows 30 000 requests a day per machine went blind at
// 2 a.m. Two things now keep it in step: a sink is sent a subagent's tool events at
// most one per session per minute (`tools`, folded at delivery: the outbox keeps
// every event), and a drain starts at most one request a second per machine.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { Cursors, type Event, Outbox, type SinkConfig, takeLock, takeNamedLock, ulid } from "@sessionpipe/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isToolsMode, sendTool, TOOL_FOLD_MS, ToolClock, toolsMode } from "../src/fold.js";
import {
  type Clock,
  drain,
  enqueueJob,
  flush,
  type Job,
  PACE_MS,
  PASS_BUDGET_MS,
  runJob,
  sweepJobs,
} from "../src/run.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "sp-fold-"));
  process.env.SESSIONPIPE_CONFIG = path.join(tmp, "config.json");
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(tmp, { recursive: true, force: true });
});

const T0 = Date.parse("2026-11-01T09:00:00Z");
const ev = (type: string, at: number, data: Record<string, unknown> = {}, session = "s", seq = 0): Event => ({
  protocol: 1,
  id: ulid(),
  type,
  time: new Date(at).toISOString(),
  tier: 3,
  harness: { name: "claude-code" },
  session: { id: session, seq },
  privacy: { rulesets: [], pii: false },
  data: type.startsWith("tool.") ? { tool: "Bash", ok: true, ...data } : data,
});
const sub = (type: string, at: number, seq = 0) => ev(type, at, { agent_id: "a1" }, "s", seq);

describe("toolsMode", () => {
  it("is the sink's own setting, else what the receiver's well-known file asked for, else every tool event", () => {
    expect(toolsMode({ url: "https://r.example" })).toBe("all");
    expect(toolsMode({ url: "http://127.0.0.1:9" })).toBe("all");
    expect(toolsMode({ url: "file:/tmp/x" })).toBe("all");
    expect(toolsMode({ url: "stdout" })).toBe("all");
    expect(toolsMode({ url: "https://r.example", receiver_tools: "main" })).toBe("main");
    expect(toolsMode({ url: "https://r.example", receiver_tools: "beat" })).toBe("beat");
    // The owner's own word wins over the receiver's ask, either way.
    expect(toolsMode({ url: "https://r.example", tools: "all", receiver_tools: "main" })).toBe("all");
    expect(toolsMode({ url: "https://r.example", tools: "main" })).toBe("main");
    expect(toolsMode({ url: "stdout", tools: "beat" })).toBe("beat");
    expect(toolsMode({ url: "https://r.example", receiver_tools: "some" as never })).toBe("all");
    // A hand-edited value nobody knows falls back to the default, never to "send nothing".
    expect(toolsMode({ url: "stdout", tools: "some" as never })).toBe("all");
    expect(isToolsMode("main")).toBe(true);
    expect(isToolsMode("MAIN")).toBe(false);
    expect(isToolsMode(undefined)).toBe(false);
  });
});

describe("sendTool", () => {
  it("all: every event goes", () => {
    const clock = {};
    for (let i = 0; i < 5; i++) expect(sendTool(sub("tool.started", T0 + i), "all", clock, "k")).toBe(true);
    expect(clock).toEqual({});
  });
  it("main: the main thread goes live; a subagent's: tool.ended only, the first of each minute", () => {
    const clock: Record<string, number> = {};
    expect(sendTool(ev("tool.started", T0), "main", clock, "k")).toBe(true);
    expect(sendTool(ev("tool.ended", T0 + 1), "main", clock, "k")).toBe(true);
    expect(sendTool(ev("tool.ended", T0 + 1, { agent_id: "" }), "main", clock, "k")).toBe(true);
    // A thinned thread's tool.started never goes: tool.ended is what a receiver reads.
    expect(sendTool(sub("tool.started", T0 + 2), "main", clock, "k")).toBe(false);
    expect(clock).toEqual({});
    expect(sendTool(sub("tool.ended", T0 + 3), "main", clock, "k")).toBe(true);
    expect(sendTool(sub("tool.ended", T0 + 4), "main", clock, "k")).toBe(false);
    expect(sendTool(sub("tool.ended", T0 + 3 + TOOL_FOLD_MS - 1), "main", clock, "k")).toBe(false);
    // Another session keeps its own minute.
    expect(sendTool(sub("tool.ended", T0 + 4), "main", clock, "other")).toBe(true);
    expect(sendTool(sub("tool.ended", T0 + 3 + TOOL_FOLD_MS), "main", clock, "k")).toBe(true);
    expect(clock).toEqual({ k: T0 + 3 + TOOL_FOLD_MS, other: T0 + 4 });
  });
  it("a regular cadence can't lock the minute onto tool.started: every kept event is a tool.ended", () => {
    // A subagent running 5 s tools with 1 s between them, for ten minutes.
    const clock: Record<string, number> = {};
    const kept: string[] = [];
    for (let i = 0; i < 100; i++) {
      for (const [type, at] of [
        ["tool.started", T0 + i * 6000],
        ["tool.ended", T0 + i * 6000 + 5000],
      ] as const)
        if (sendTool(sub(type, at), "main", clock, "k")) kept.push(type);
    }
    expect(kept).toHaveLength(10);
    expect(new Set(kept)).toEqual(new Set(["tool.ended"]));
  });
  it("only tool events are thinned: turns, attention, subagents and files go as they come", () => {
    const clock: Record<string, number> = { k: T0 };
    for (const type of [
      "turn.started",
      "turn.ended",
      "attention.needed",
      "attention.cleared",
      "subagent.started",
      "subagent.ended",
      "files.changed",
      "turn.progress",
      "limits.observed",
      "session.ended",
    ])
      expect(sendTool(ev(type, T0 + 1, { agent_id: "a1" }), "beat", clock, "k")).toBe(true);
  });
  it("a thread's tool.ended after its permission prompt always goes: it shows the prompt was answered", () => {
    const clock: Record<string, number> = {};
    expect(sendTool(sub("tool.ended", T0), "main", clock, "k")).toBe(true);
    // Subagent a1 asks; another subagent's tool.ended in the same minute stays thinned.
    expect(sendTool(ev("attention.needed", T0 + 10_000, { agent_id: "a1" }), "main", clock, "k")).toBe(true);
    expect(sendTool(ev("tool.ended", T0 + 15_000, { agent_id: "a2" }), "main", clock, "k")).toBe(false);
    // One of a1's from before the prompt (reaching the outbox late) is no answer.
    expect(sendTool(sub("tool.ended", T0 + 9_000), "main", clock, "k")).toBe(false);
    // a1's next tool.ended goes, inside the minute, and the minute restarts there.
    expect(sendTool(sub("tool.ended", T0 + 20_000), "main", clock, "k")).toBe(true);
    expect(sendTool(sub("tool.ended", T0 + 25_000), "main", clock, "k")).toBe(false);
    expect(clock).toEqual({ k: T0 + 20_000 });
    // The main thread's prompt marks nothing in main mode (its tool events go anyway)…
    expect(sendTool(ev("attention.needed", T0 + 30_000), "main", clock, "k")).toBe(true);
    expect(clock).toEqual({ k: T0 + 20_000 });
    // …and in beat mode it does, keyed on the main thread; a prompt timed by no clock counts from 0.
    expect(sendTool({ ...ev("attention.needed", T0), time: "garbage" }, "beat", clock, "k")).toBe(true);
    expect(sendTool(sub("tool.ended", T0 + 31_000), "beat", clock, "k")).toBe(false);
    expect(sendTool(ev("tool.ended", T0 + 32_000), "beat", clock, "k")).toBe(true);
  });
  it("beat: the main thread's tool events are thinned too", () => {
    const clock: Record<string, number> = {};
    expect(sendTool(ev("tool.started", T0), "beat", clock, "k")).toBe(false);
    expect(sendTool(ev("tool.ended", T0 + 10), "beat", clock, "k")).toBe(true);
    expect(sendTool(ev("tool.ended", T0 + 20), "beat", clock, "k")).toBe(false);
    expect(sendTool(sub("tool.ended", T0 + 30), "beat", clock, "k")).toBe(false);
    expect(sendTool(ev("tool.ended", T0 + 10 + TOOL_FOLD_MS), "beat", clock, "k")).toBe(true);
  });
  it("a little out of time order stays in the window; only a jump back by a window or more restarts it", () => {
    const clock: Record<string, number> = { k: T0 };
    expect(sendTool(sub("tool.ended", T0 - 5000), "main", clock, "k")).toBe(false);
    expect(sendTool(sub("tool.ended", T0 - TOOL_FOLD_MS + 1), "main", clock, "k")).toBe(false);
    expect(clock.k).toBe(T0);
    expect(sendTool(sub("tool.ended", T0 - TOOL_FOLD_MS), "main", clock, "k")).toBe(true);
    expect(clock.k).toBe(T0 - TOOL_FOLD_MS);
    expect(sendTool(sub("tool.ended", T0 - TOOL_FOLD_MS + 4000), "main", clock, "k")).toBe(false);
    // An event with no readable time goes, and moves nothing.
    expect(sendTool({ ...sub("tool.ended", T0), time: "garbage" }, "main", clock, "k")).toBe(true);
    expect(clock.k).toBe(T0 - TOOL_FOLD_MS);
  });
});

describe("ToolClock", () => {
  it("reads nothing as empty, keeps a day, and is 0600", () => {
    const c = new ToolClock(tmp, "https://r.example");
    expect(c.read()).toEqual({});
    c.write({ fresh: T0, old: T0 - 25 * 60 * 60_000, day: T0 - 23 * 60 * 60_000 });
    expect(c.read()).toEqual({ fresh: T0, day: T0 - 23 * 60 * 60_000 });
    const f = path.join(tmp, "folds", "https___r.example.json");
    if (process.platform !== "win32") expect(statSync(f).mode & 0o777).toBe(0o600);
    writeFileSync(f, "[1,2]");
    expect(c.read()).toEqual({});
    writeFileSync(f, "{not json");
    expect(c.read()).toEqual({});
    c.write({});
    expect(c.read()).toEqual({});
  });
});

/** A file sink's lines, as events. */
const lines = (file: string): Event[] =>
  readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Event);

describe("flush with a sink that thins tool events", () => {
  it("skips the folded events, moves the cursor over them, and keeps the minute across runs", async () => {
    const outbox = new Outbox(tmp);
    const ref = { harness: "claude-code", session: "s" };
    outbox.append(ref, [
      ev("turn.started", T0, {}, "s", 0),
      sub("tool.started", T0 + 1, 1),
      sub("tool.ended", T0 + 2, 2),
      ev("tool.started", T0 + 3, {}, "s", 3),
      sub("tool.started", T0 + 4, 4),
    ]);
    const file = path.join(tmp, "out.jsonl");
    const sinks: SinkConfig[] = [{ name: "f", url: `file:${file}`, tier: 1, tools: "main" }];
    outbox.append(ref, [sub("tool.ended", T0 + 5, 5)]);
    expect((await flush(tmp, sinks, outbox)).f).toBe(3);
    expect(lines(file).map((e) => e.session.seq)).toEqual([0, 2, 3]);
    expect(new Cursors(tmp, "f").read()["claude-code/s"]).toBe(statSync(outbox.file(ref)).size);
    // The next run remembers the minute: a subagent's tool event 30 s later is skipped,
    // and the cursor still moves (nothing is sent, nothing waits).
    outbox.append(ref, [sub("tool.ended", T0 + 30_000, 6)]);
    expect((await flush(tmp, sinks, outbox)).f).toBe(0);
    expect(new Cursors(tmp, "f").read()["claude-code/s"]).toBe(statSync(outbox.file(ref)).size);
    outbox.append(ref, [sub("tool.ended", T0 + 62_000, 7), ev("turn.ended", T0 + 63_000, {}, "s", 8)]);
    expect((await flush(tmp, sinks, outbox)).f).toBe(2);
    expect(lines(file).map((e) => e.session.seq)).toEqual([0, 2, 3, 7, 8]);
    expect(new ToolClock(tmp, "f").read()).toEqual({ "claude-code/s": T0 + 62_000 });
  });
  it("a file sink is sent every tool event unless told otherwise", async () => {
    const outbox = new Outbox(tmp);
    outbox.append(
      { harness: "claude-code", session: "s" },
      [0, 1, 2, 3].map((i) => sub(i % 2 ? "tool.ended" : "tool.started", T0 + i, i)),
    );
    const file = path.join(tmp, "all.jsonl");
    expect((await flush(tmp, [{ name: "f", url: `file:${file}`, tier: 1 }], outbox)).f).toBe(4);
  });
  it("a receiver is sent a subagent's first tool.ended of the minute; a refused batch picks the same one again", async () => {
    const posts: Event[][] = [];
    let refuse = 1;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      posts.push((JSON.parse(String(init.body)) as { events: Event[] }).events);
      if (refuse-- > 0) return new Response("{}", { status: 429, headers: { "retry-after": "0" } });
      return new Response("{}", { status: 202 });
    });
    const outbox = new Outbox(tmp);
    outbox.append(
      { harness: "claude-code", session: "s" },
      Array.from({ length: 10 }, (_, i) => sub(i % 2 ? "tool.ended" : "tool.started", T0 + i * 1000, i)),
    );
    const sinks: SinkConfig[] = [{ name: "r", url: "https://r.example", tier: 1, token: "t", receiver_tools: "main" }];
    expect((await flush(tmp, sinks, outbox)).r).toBe(0);
    expect(new ToolClock(tmp, "r").read()).toEqual({});
    expect((await flush(tmp, sinks, outbox)).r).toBe(1);
    expect(posts.map((p) => p.map((e) => e.session.seq))).toEqual([[1], [1]]);
    expect(new ToolClock(tmp, "r").read()).toEqual({ "claude-code/s": T0 + 1000 });
  });
});

/** A clock the test moves; `sleep` resolves when the test passes its time. */
function simClock(start = T0) {
  let t = start;
  const timers: { at: number; resolve: () => void }[] = [];
  const clock: Clock = {
    now: () => t,
    sleep: (ms) => new Promise<void>((resolve) => timers.push({ at: t + ms, resolve })),
  };
  return {
    clock,
    timers,
    set: (v: number) => {
      t = Math.max(t, v);
    },
    /** Wake every sleeper due by `until`, in time order, letting each run on. */
    async wake(until: number): Promise<void> {
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > until) break;
        timers.shift();
        t = Math.max(t, next.at);
        next.resolve();
        await settle();
      }
      if (Number.isFinite(until)) t = Math.max(t, until);
    },
  };
}
/** Let every promise that can move, move (fake fetch answers at once). */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await new Promise<void>((r) => setImmediate(r));
}

/** A receiver answering 202 to every POST, counting them. */
function stubReceiver() {
  const posts: Event[][] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const events = (JSON.parse(String(init.body)) as { events: Event[] }).events;
    posts.push(events);
    return new Response(JSON.stringify({ accepted: events.length, duplicates: 0, rejected: [] }), { status: 202 });
  });
  return posts;
}

describe("drain's pace: at most one request a second per machine", () => {
  const sinks: SinkConfig[] = [{ name: "r", url: "https://r.example", tier: 1, token: "t", receiver_tools: "main" }];
  it("a lone event goes at once; the next drain within the second waits out the rest of it", async () => {
    const posts = stubReceiver();
    const sim = simClock();
    const outbox = new Outbox(tmp);
    const ref = { harness: "claude-code", session: "s" };
    outbox.append(ref, [ev("turn.started", T0, {}, "s", 0)]);
    expect(await drain(tmp, sinks, outbox, ref, { clock: sim.clock })).toEqual({ r: 1 });
    expect(sim.timers).toHaveLength(0);
    sim.set(T0 + 300);
    outbox.append(ref, [ev("turn.ended", T0 + 300, {}, "s", 1)]);
    let done = false;
    const second = drain(tmp, sinks, outbox, ref, { clock: sim.clock }).then((d) => {
      done = true;
      return d;
    });
    await settle();
    expect(done).toBe(false);
    expect(sim.timers.map((x) => x.at)).toEqual([T0 + PACE_MS]);
    // Meanwhile another worker's event lands; it only marks that there is more.
    outbox.append(ref, [ev("attention.needed", T0 + 500, { attention_id: "x", kind: "idle" }, "s", 2)]);
    expect(await drain(tmp, sinks, outbox, ref, { clock: sim.clock })).toBeNull();
    expect(posts).toHaveLength(1);
    await sim.wake(T0 + PACE_MS);
    expect(await second).toEqual({ r: 2 });
    // Both went in one request, a second after the first.
    expect(posts.map((p) => p.map((e) => e.session.seq))).toEqual([[0], [1, 2]]);
  });
  it("a pass with nothing for a receiver doesn't wait, nor does one whose stamp is a second old", async () => {
    stubReceiver();
    const sim = simClock();
    const outbox = new Outbox(tmp);
    const ref = { harness: "claude-code", session: "s" };
    outbox.append(ref, [ev("turn.started", T0, {}, "s", 0)]);
    await drain(tmp, sinks, outbox, ref, { clock: sim.clock });
    // Nothing new: no wait, nothing sent.
    expect(await drain(tmp, sinks, outbox, ref, { clock: sim.clock })).toEqual({ r: 0 });
    // A file sink's events never wait on the receiver's pace.
    outbox.append(ref, [ev("turn.ended", T0, {}, "s", 1)]);
    const file = path.join(tmp, "local.jsonl");
    expect(await drain(tmp, [{ name: "f", url: `file:${file}`, tier: 1 }], outbox, ref, { clock: sim.clock })).toEqual({
      f: 2,
    });
    // A paused receiver and one in backoff aren't waited for either.
    const paused = [{ ...sinks[0], paused: "x" } as SinkConfig];
    expect(await drain(tmp, paused, outbox, ref, { clock: sim.clock })).toEqual({});
    mkdirSync(path.join(tmp, "backoff"), { recursive: true });
    writeFileSync(
      path.join(tmp, "backoff", "r.json"),
      JSON.stringify({ until: Math.max(Date.now(), T0) + 3_600_000, failures: 1, why: "429" }),
    );
    expect(await drain(tmp, sinks, outbox, ref, { clock: sim.clock })).toEqual({ r: 0 });
    expect(sim.timers).toHaveLength(0);
  });
  it("a stamp from the future (a clock set back) waits a second at most", async () => {
    stubReceiver();
    const sim = simClock();
    const outbox = new Outbox(tmp);
    const ref = { harness: "claude-code", session: "s" };
    mkdirSync(path.join(tmp, "locks"), { recursive: true });
    writeFileSync(path.join(tmp, "locks", "flush.sent"), String(T0 + 3_600_000));
    outbox.append(ref, [ev("turn.started", T0, {}, "s", 0)]);
    const d = drain(tmp, sinks, outbox, ref, { clock: sim.clock });
    await settle();
    expect(sim.timers.map((x) => x.at)).toEqual([T0 + PACE_MS]);
    await sim.wake(T0 + PACE_MS);
    expect(await d).toEqual({ r: 1 });
    // A stamp nobody can read waits for nothing.
    writeFileSync(path.join(tmp, "locks", "flush.sent"), "garbage");
    outbox.append(ref, [ev("turn.ended", T0 + PACE_MS, {}, "s", 1)]);
    expect(await drain(tmp, sinks, outbox, ref, { clock: sim.clock })).toEqual({ r: 1 });
    expect(sim.timers).toHaveLength(0);
  });
});

describe("a worker's life: no pass starts that its deadline would end", () => {
  const sinks: SinkConfig[] = [{ name: "r", url: "https://r.example", tier: 1, token: "t", receiver_tools: "main" }];
  const more = () => path.join(tmp, "locks", "flush.more");
  it("too little life left: the work stays marked, the lock is let go, and it is handed on", async () => {
    const posts = stubReceiver();
    const sim = simClock();
    const outbox = new Outbox(tmp);
    const ref = { harness: "claude-code", session: "s" };
    outbox.append(ref, [ev("turn.ended", T0, {}, "s", 0)]);
    let handed = 0;
    const life = { clock: sim.clock, deadline: T0 + PASS_BUDGET_MS - 1, handoff: () => handed++ };
    expect(await drain(tmp, sinks, outbox, ref, life)).toEqual({});
    expect(posts).toHaveLength(0);
    expect(handed).toBe(1);
    expect(existsSync(more())).toBe(true);
    expect(existsSync(path.join(tmp, "locks", "flush.lock"))).toBe(false);
    // Without a handoff to call, the mark alone is left for the next worker.
    expect(await drain(tmp, sinks, outbox, ref, { clock: sim.clock, deadline: T0 })).toEqual({});
    // The next worker, with its life ahead of it, sends it.
    expect(await drain(tmp, sinks, outbox, ref, { clock: sim.clock, deadline: T0 + 15_000 })).toEqual({ r: 1 });
    expect(existsSync(more())).toBe(false);
  });
  it("a pass that fits runs; the one after it, marked by another worker, is handed on", async () => {
    const posts = stubReceiver();
    const sim = simClock();
    const outbox = new Outbox(tmp);
    const ref = { harness: "claude-code", session: "s" };
    outbox.append(ref, [ev("turn.started", T0, {}, "s", 0)]);
    let handed = 0;
    const d = drain(tmp, sinks, outbox, ref, {
      clock: sim.clock,
      deadline: T0 + PASS_BUDGET_MS + 500,
      handoff: () => handed++,
    });
    // Another worker's event while the first pass is on its way: it marks there is more.
    outbox.append(ref, [ev("turn.ended", T0 + 1, {}, "s", 1)]);
    expect(await drain(tmp, sinks, outbox, ref, { clock: sim.clock })).toBeNull();
    sim.set(T0 + 600);
    expect(await d).toEqual({ r: 1 });
    expect(handed).toBe(1);
    expect(posts.map((p) => p.map((e) => e.session.seq))).toEqual([[0]]);
    expect(existsSync(more())).toBe(true);
  });
  it("a sweep marks each job's events for the drain running now, gives a busy session's job back within a second, and starts none it has no life for", async () => {
    const config = process.env.SESSIONPIPE_CONFIG as string;
    writeFileSync(
      config,
      JSON.stringify({ sinks: [{ name: "f", url: `file:${path.join(tmp, "o.jsonl")}`, tier: 1 }], harnesses: {} }),
    );
    const job = (session: string): Job => ({
      harness: "claude-code",
      event: "Stop",
      argv: ["claude-code", "Stop"],
      stdin: JSON.stringify({ session_id: session, cwd: tmp, hook_event_name: "Stop" }),
      cwd: tmp,
      env: {},
      at: T0,
    });
    const FREE = "5b1c2d3e-0000-4000-8000-000000000001";
    const BUSY = "5b1c2d3e-0000-4000-8000-000000000002";
    const old = Date.now() / 1000 - 60;
    const queue = (session: string) => {
      const f = enqueueJob(tmp, job(session));
      utimesSync(f, old, old);
      return f;
    };
    // No life left for a job: nothing is claimed.
    queue(FREE);
    expect(await sweepJobs(tmp, 0, 20, 60_000, { deadline: Date.now() + PASS_BUDGET_MS })).toBe(0);
    expect(readdirSync(path.join(tmp, "jobs"))).toHaveLength(1);
    // A drain is running (its lock is held), and the second job's session is busy.
    const flushLock = takeNamedLock(tmp, "flush");
    const busy = takeLock(tmp, { harness: "claude-code", session: BUSY });
    await new Promise((r) => setTimeout(r, 5));
    queue(BUSY);
    const started = Date.now();
    const sweep = sweepJobs(tmp, 0, 20, 60_000);
    await vi.waitFor(() => expect(existsSync(more())).toBe(true), { timeout: 900, interval: 20 });
    // The first job's events are marked before the busy one has given up.
    expect(Date.now() - started).toBeLessThan(900);
    expect(await sweep).toBe(2);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(readdirSync(path.join(tmp, "jobs")).filter((n) => n.endsWith(".json"))).toHaveLength(1);
    busy?.();
    flushLock?.();
  });
});

/** A Claude Code workflow: one session, subagents each making thirty tool calls over
 *  three minutes, the main thread starting it and waiting. Every hook is a job, run in
 *  time order as its worker would; workers that find the drain busy leave their events
 *  to it, as they do on the machine. Forty subagents keep the run to seconds;
 *  SESSIONPIPE_FANOUT_AGENTS=100 is issue #208's size (about a minute here: 6 214 events,
 *  0.11.0 6 214 requests, paced all 217, main 76, beat 69). */
const AGENTS = Number(process.env.SESSIONPIPE_FANOUT_AGENTS) || 40;
describe(`fan-out: ${AGENTS} subagents × 30 tool calls`, () => {
  const SESSION = "0c3e4a52-6f7b-4d0e-9a51-2b1f9b3f0c11";
  const CALLS = 30;

  /** `jitter`: the jobs reach the outbox up to that far out of time order (workers take
   *  the session's lock in lock order, not hook order); each event keeps its own time. */
  function jobs(jitter = 0): Job[] {
    let seed = 208;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const out: Job[] = [];
    const hook = (at: number, event: string, extra: Record<string, unknown> = {}) =>
      out.push({
        harness: "claude-code",
        event,
        argv: ["claude-code", event],
        stdin: JSON.stringify({ session_id: SESSION, cwd: tmp, hook_event_name: event, prompt_id: "p1", ...extra }),
        cwd: tmp,
        env: {},
        at: T0 + Math.round(at),
      });
    let call = 0;
    const tool = (at: number, agent?: string) => {
      const id = `toolu_${call++}`;
      const base = {
        tool_name: "Bash",
        tool_input: { command: "ls" },
        tool_use_id: id,
        ...(agent ? { agent_id: agent, agent_type: "general" } : {}),
      };
      hook(at, "PreToolUse", base);
      hook(at + 300 + rnd() * 3000, "PostToolUse", { ...base, tool_response: "ok" });
    };
    hook(0, "SessionStart", { source: "startup" });
    hook(100, "UserPromptSubmit", { prompt: "run the workflow" });
    for (let i = 0; i < 4; i++) tool(500 + i * 1500);
    for (let a = 0; a < AGENTS; a++) {
      const agent = `agent${a}`;
      const start = 7_000 + rnd() * 8_000;
      hook(start, "SubagentStart", { agent_id: agent, agent_type: "general" });
      let t = start + 200;
      for (let c = 0; c < CALLS; c++) {
        t += 1_000 + rnd() * 9_000;
        tool(t, agent);
      }
      hook(t + 4_000, "SubagentStop", { agent_id: agent, agent_type: "general" });
    }
    // The main thread asks a question halfway, and the person answers it; so does a
    // subagent, whose next tool call is the answer.
    hook(90_000, "PermissionRequest", { tool_name: "Bash", tool_input: { command: "rm -rf build" } });
    tool(95_000);
    hook(120_000, "PermissionRequest", {
      tool_name: "Bash",
      tool_input: { command: "git push" },
      agent_id: "agent0",
      agent_type: "general",
    });
    tool(125_000, "agent0");
    hook(200_000, "Stop", {});
    out.sort((a, b) => a.at - b.at);
    if (!jitter) return out;
    const order = new Map(out.map((j) => [j, j.at + (rnd() * 2 - 1) * jitter]));
    return out.sort((a, b) => (order.get(a) as number) - (order.get(b) as number));
  }

  /** Run every job; returns the requests the receiver got and the outbox's events. */
  async function run(tools: SinkConfig["tools"], paced: boolean, jitter = 0) {
    const state = mkdtempSync(path.join(tmp, "m-"));
    writeFileSync(
      process.env.SESSIONPIPE_CONFIG as string,
      JSON.stringify({
        // A receiver that asked for `main` in its well-known file; `tools` is the owner overriding it.
        sinks: [
          {
            name: "r",
            url: "https://r.example",
            tier: 1,
            token: "t",
            receiver_tools: "main",
            ...(tools ? { tools } : {}),
          },
        ],
        harnesses: {},
      }),
    );
    const posts = stubReceiver();
    const sim = simClock();
    // 0.11.0 had no pace: a clock whose every reading is far past the last stamp.
    let far = T0;
    const unpaced: Clock = { now: () => (far += 3_600_000), sleep: async () => {} };
    const clock = paced ? sim.clock : unpaced;
    const running: Promise<unknown>[] = [];
    for (const j of jobs(jitter)) {
      await sim.wake(j.at);
      running.push(runJob(j, { state, now: j.at, clock }));
      await settle();
    }
    await sim.wake(Number.POSITIVE_INFINITY);
    await Promise.all(running);
    await sim.wake(Number.POSITIVE_INFINITY);
    const outbox = new Outbox(state);
    const all = outbox.read({ harness: "claude-code", session: SESSION }, 0, 100_000).events;
    return { posts, delivered: posts.flat(), all };
  }

  it("sends a small fraction of the requests 0.11.0 sent, and every turn, prompt and subagent", async () => {
    const before = await run("all", false);
    const all = await run("all", true);
    const main = await run(undefined, true);
    const beat = await run("beat", true);
    const shuffled = await run(undefined, true, 6000);
    const n = (r: { posts: Event[][] }) => r.posts.length;
    console.log(
      `fan-out (${AGENTS} subagents × ${CALLS} tool calls, ${before.all.length} events): 0.11.0 ${n(before)} requests · paced, tools all ${n(all)} · paced, tools main (the default) ${n(main)} · paced, tools beat ${n(beat)}`,
    );
    // The outbox kept every event in each run.
    for (const r of [all, main, beat, shuffled]) expect(r.all.length).toBe(before.all.length);
    expect(before.all.filter((e) => e.type === "tool.started")).toHaveLength(AGENTS * CALLS + 6);
    // 0.11.0: a request per hook that had something to send.
    expect(n(before)).toBeGreaterThan(AGENTS * CALLS);
    expect(n(all)).toBeLessThan(n(before) / 10);
    expect(n(main)).toBeLessThan(n(all) / 2);
    expect(n(beat)).toBeLessThanOrEqual(n(main));
    // Every event that isn't a tool call arrived, in every mode; the main thread's tool calls too.
    const kept = (e: Event) => !e.type.startsWith("tool.") || !e.data.agent_id;
    for (const r of [all, main]) {
      const got = new Set(r.delivered.map((e) => e.session.seq));
      for (const e of r.all.filter(kept)) expect(got.has(e.session.seq), `${e.type} #${e.session.seq}`).toBe(true);
    }
    const got = new Set(beat.delivered.map((e) => e.session.seq));
    for (const e of beat.all.filter((e) => !e.type.startsWith("tool.")))
      expect(got.has(e.session.seq), `${e.type} #${e.session.seq}`).toBe(true);
    for (const type of [
      "turn.started",
      "turn.ended",
      "attention.needed",
      "attention.cleared",
      "subagent.started",
      "subagent.ended",
    ])
      expect(main.delivered.filter((e) => e.type === type).length, type).toBe(
        main.all.filter((e) => e.type === type).length,
      );
    // A subagent's tool calls: a tool.ended at most once per minute of the run, per
    // session, plus the one that answers its permission prompt; never a tool.started.
    // The same when the hooks reach the outbox up to 6 s out of order.
    for (const r of [main, shuffled]) {
      const subTools = r.delivered.filter((e) => e.type.startsWith("tool.") && e.data.agent_id);
      expect(subTools.every((e) => e.type === "tool.ended")).toBe(true);
      expect(subTools.length).toBeLessThanOrEqual(5);
      const ask = r.delivered.find((e) => e.type === "attention.needed" && e.data.agent_id === "agent0");
      expect(ask).toBeDefined();
      const answer = r.all
        .filter((e) => e.type === "tool.ended" && e.data.agent_id === "agent0" && e.time > (ask as Event).time)
        .sort((a, b) => a.session.seq - b.session.seq)[0];
      expect(r.delivered.some((e) => e.id === answer?.id)).toBe(true);
    }
    // Nothing went twice, and within the session seq only rose.
    const seqs = main.delivered.map((e) => e.session.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  }, 180_000);
});
