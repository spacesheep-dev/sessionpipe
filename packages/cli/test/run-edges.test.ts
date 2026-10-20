// SPDX-License-Identifier: Apache-2.0
// The corners of run.ts no real adapter or sink reaches: a facts pass that learns a
// version and a branch, a session without a folder, a result that says nothing, the
// delivery results a receiver may leave bare, and the flush lock lost between passes.
// A hand-built adapter stands in for a harness, a scripted HttpSink for a receiver.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  type Adapter,
  type DeliveryResult,
  type Event,
  type HookResult,
  Outbox,
  readConfig,
  type SessionFacts,
  type TranscriptRead,
  takeNamedLock,
  ulid,
} from "@sessionpipe/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drain, factsState, flush, readBackoff, runJob } from "../src/run.js";

const fake = vi.hoisted(() => ({
  result: null as HookResult | null,
  facts: {} as SessionFacts,
  read: { turns: [], line: 0 } as TranscriptRead,
}));
vi.mock("@sessionpipe/core", async (orig) => {
  const m = await orig<typeof import("@sessionpipe/core")>();
  const adapter: Adapter = {
    name: "fake",
    events: [],
    detect: () => false,
    configFiles: () => [],
    install: () => [],
    uninstall: () => [],
    installed: () => [],
    fromHook: () => fake.result,
    readTranscript: () => fake.read,
    facts: () => fake.facts,
    backfill: () => [],
  };
  return {
    ...m,
    adapterByName: (name: string) => (name === "fake" ? adapter : m.adapterByName(name)),
    takeNamedLock: vi.fn(m.takeNamedLock),
  };
});
const http = vi.hoisted(() => ({ send: vi.fn<(name: string, events: Event[]) => Promise<DeliveryResult>>() }));
vi.mock("../src/http-sink.js", () => ({
  HttpSink: class {
    readonly name: string;
    readonly pii = false;
    constructor(
      s: { name: string },
      readonly tier: 0 | 1 | 2 | 3,
    ) {
      this.name = s.name;
    }
    send(events: Event[]) {
      return http.send(this.name, events);
    }
  },
}));

let tmp: string;
let out: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "sp-edges-"));
  out = path.join(tmp, "out.jsonl");
  process.env.SESSIONPIPE_STATE = tmp;
  process.env.SESSIONPIPE_CONFIG = path.join(tmp, "config.json");
  config({ sinks: [{ name: "h", url: "https://h.example/v1", tier: 3 }] });
  fake.result = null;
  fake.facts = {};
  fake.read = { turns: [], line: 0 };
  http.send.mockReset();
  vi.mocked(takeNamedLock).mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});
const config = (c: Record<string, unknown>) =>
  writeFileSync(process.env.SESSIONPIPE_CONFIG as string, JSON.stringify({ harnesses: {}, ...c }));
const job = (event = "Stop") => ({
  harness: "fake",
  event,
  argv: ["fake", event],
  stdin: "",
  cwd: tmp,
  env: {},
  at: 1_700_000_000_000,
});
const beat = { type: "session.heartbeat", data: {}, harnessEvent: "X" };
const ev = (session: string, seq: number): Event => ({
  protocol: 1,
  id: ulid(),
  type: "session.heartbeat",
  time: new Date().toISOString(),
  tier: 3,
  harness: { name: "codex" },
  session: { id: session, seq },
  privacy: { rulesets: [], pii: false },
  data: {},
});
const logged = () => (existsSync(path.join(tmp, "log")) ? readFileSync(path.join(tmp, "log"), "utf8") : "");
const sent = () =>
  existsSync(out)
    ? readFileSync(out, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Event)
    : [];

describe("runJob with a harness that says little", () => {
  it("no adapter, or a payload the adapter makes nothing of, is no run", async () => {
    expect(await runJob({ ...job(), harness: "no-such-harness" })).toEqual({ events: [], delivered: {} });
    expect(await runJob(job())).toEqual({ events: [], delivered: {} });
    fake.result = { session: { id: "" }, events: [beat] };
    expect(await runJob(job())).toEqual({ events: [], delivered: {} });
    expect(http.send).not.toHaveBeenCalled();
  });

  // The fake daemon is a Unix socket; Windows has none.
  it.runIf(process.platform !== "win32")(
    "the facts pass keeps a harness version and a branch; a session with no folder has none; nothing is logged as nothing",
    async () => {
      const sock = path.join(tmp, "control.sock");
      const asked: unknown[] = [];
      const server = net.createServer((c) =>
        c.once("data", (d) => {
          asked.push(JSON.parse(d.toString("utf8").split("\n")[0] as string));
          c.end('{"op":"ok"}\n');
        }),
      );
      await new Promise<void>((r) => server.listen(sock, () => r()));
      try {
        fake.result = { session: { id: "s1" }, events: [] };
        fake.facts = { harness_version: "1.2.3", branch: "dev", title: "t" };
        expect(await runJob(job())).toEqual({ events: [], delivered: { h: 0 } });
        expect(asked).toEqual([{ op: "event", session: "fake:s1", event: "Stop" }]);
        expect(logged()).toMatch(/fake Stop: nothing/);
        expect(factsState(tmp).get("fake", "s1")).toEqual({
          harness_version: "1.2.3",
          session: { branch: "dev", title: "t" },
        });
        // The next event carries what was learned: the version on the harness block, no cwd at all.
        fake.result = { session: { id: "s1" }, events: [beat] };
        fake.facts = {};
        http.send.mockResolvedValue({ ok: true, acknowledged: 1 });
        const { events } = await runJob(job("PostToolUse"));
        expect(events[0]?.harness).toEqual({ name: "fake", event: "X", version: "1.2.3" });
        expect(events[0]?.session).toMatchObject({ id: "s1", branch: "dev", title: "t" });
        expect(events[0]?.session).not.toHaveProperty("cwd");
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    },
  );

  it("a folder the facts remember stays the session's when neither the hook nor the facts pass name one", async () => {
    factsState(tmp).save("fake", "s2", { session: { cwd: path.join(os.homedir(), "proj") } });
    fake.result = { session: { id: "s2" }, events: [beat] };
    http.send.mockResolvedValue({ ok: true, acknowledged: 1 });
    const { events } = await runJob(job("PostToolUse"));
    expect(events[0]?.session.cwd).toBe(path.join("~", "proj"));
  });

  it("tier 2 with a version: the running turn's words and the finished turn carry it too", async () => {
    config({ sinks: [{ name: "f", url: `file:${out}`, tier: 2 }] });
    const transcript = path.join(tmp, "t.jsonl");
    writeFileSync(transcript, "");
    factsState(tmp).save("fake", "s3", { harness_version: "2.0" });
    // A tool call with no progress ever sent: too soon is measured from zero.
    fake.result = {
      session: { id: "s3" },
      events: [{ type: "tool.ended", data: { tool: "Bash", ok: true }, harnessEvent: "PostToolUse" }],
      transcript,
    };
    fake.read = { turns: [], line: 0, open: { user: "fix it", at: 1_700_000_000_000 } };
    await runJob(job("PostToolUse"));
    expect(sent().map((e) => [e.type, e.harness.version])).toEqual([
      ["tool.ended", "2.0"],
      ["turn.progress", "2.0"],
    ]);
    expect(sent()[1]?.data).toMatchObject({ turn: 0, user: "fix it", assistant: "" });
    // The turn's end: its transcript, numbered from the cursor.
    fake.result = {
      session: { id: "s3" },
      events: [{ type: "turn.ended", data: { reason: "stop" }, harnessEvent: "Stop" }],
      transcript,
    };
    fake.read = { turns: [{ user: "fix it", assistant: "done", at: 1_700_000_001_000, endLine: 2 }], line: 2 };
    await runJob(job());
    expect(sent().map((e) => [e.type, e.harness.version])).toEqual([
      ["tool.ended", "2.0"],
      ["turn.progress", "2.0"],
      ["turn.ended", "2.0"],
      ["turn.transcript", "2.0"],
    ]);
    expect(factsState(tmp).get("fake", "s3")).toMatchObject({ transcript_line: 2, transcript_turns: 1 });
  });

  it("one run in fifty prunes the outbox, to keep_days or 30", async () => {
    fake.result = { session: { id: "s4" }, events: [beat] };
    http.send.mockResolvedValue({ ok: true, acknowledged: 1 });
    const prune = vi.spyOn(Outbox.prototype, "prune");
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    await runJob(job());
    expect(prune).not.toHaveBeenCalled();
    vi.spyOn(Math, "random").mockReturnValue(0);
    config({ sinks: [{ name: "h", url: "https://h.example/v1", tier: 3 }], keep_days: 5 });
    await runJob(job());
    expect(prune).toHaveBeenLastCalledWith(5);
    config({ sinks: [{ name: "h", url: "https://h.example/v1", tier: 3 }], keep_days: null });
    await runJob(job());
    expect(prune).toHaveBeenLastCalledWith(30);
  });
});

describe("what a receiver may leave out of its answer", () => {
  const outboxWith = (n: number, session = "s") => {
    const outbox = new Outbox(tmp);
    outbox.append(
      { harness: "codex", session },
      Array.from({ length: n }, (_, i) => ev(session, i)),
    );
    return outbox;
  };
  const sinks = () => readConfig().sinks;

  it("a refusal with no status, error or action is a retry, 2 s", async () => {
    http.send.mockResolvedValue({ ok: false, acknowledged: 0 });
    expect(await flush(tmp, sinks(), outboxWith(1))).toEqual({ h: 0 });
    expect(readBackoff(tmp, "h")).toMatchObject({ failures: 1, why: "" });
    expect(logged()).toMatch(/sink h: {3}→ retry, waits 2 s/);
  });

  it("413 on one event alone, with no message: dropped and logged", async () => {
    http.send.mockResolvedValue({ ok: false, acknowledged: 0, action: "split" });
    expect(await flush(tmp, sinks(), outboxWith(1))).toEqual({ h: 1 });
    expect(logged()).toMatch(/sink h: 413 {2}→ event \S+ \(session\.heartbeat\) is too large alone, dropped/);
  });

  it("halves acknowledged without counts add up to a whole", async () => {
    http.send.mockImplementation(async (_n, events) =>
      events.length > 1 ? { ok: false, acknowledged: 0, action: "split" } : { ok: true, acknowledged: 1 },
    );
    expect(await flush(tmp, sinks(), outboxWith(2))).toEqual({ h: 2 });
    expect(http.send).toHaveBeenCalledTimes(3);
  });

  it("lower-tier without a cap changes nothing; with one it caps the sink", async () => {
    http.send.mockResolvedValue({ ok: false, acknowledged: 0, action: "lower-tier" });
    await flush(tmp, sinks(), outboxWith(1));
    expect(readConfig().sinks[0]).not.toHaveProperty("max_tier");
    http.send.mockResolvedValue({ ok: false, acknowledged: 0, action: "lower-tier", max_tier: 1 });
    await flush(tmp, sinks(), outboxWith(1));
    expect(readConfig().sinks[0]?.max_tier).toBe(1);
  });

  it("a pause with no reason is logged as unauthorized", async () => {
    http.send.mockResolvedValue({ ok: false, acknowledged: 0, action: "pause" });
    await flush(tmp, sinks(), outboxWith(1));
    expect(readConfig().sinks[0]?.paused).toMatch(/^\d{4}-\d{2}-\d{2}T\S+ unauthorized$/);
  });

  it("the session the job was for goes first, wherever the outbox lists it", async () => {
    config({ sinks: [{ name: "f", url: `file:${out}`, tier: 3 }] });
    const outbox = new Outbox(tmp);
    for (const s of ["a", "b", "c", "d"]) outbox.append({ harness: "codex", session: s }, [ev(s, 0)]);
    await flush(tmp, sinks(), outbox, { harness: "codex", session: "c" });
    const ids = sent().map((e) => e.session.id);
    expect(ids[0]).toBe("c");
    expect(ids.sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("drain: the flush lock taken the moment it was marked as missed is taken after all", async () => {
    config({ sinks: [{ name: "f", url: `file:${out}`, tier: 3 }] });
    vi.mocked(takeNamedLock).mockReturnValueOnce(null);
    expect(await drain(tmp, sinks(), outboxWith(1))).toEqual({ f: 1 });
    expect(existsSync(path.join(tmp, "locks", "flush.more"))).toBe(false);
  });

  it("drain: more arrived during the pass but another worker took the lock: it is theirs now", async () => {
    http.send.mockImplementation(async () => {
      mkdirSync(path.join(tmp, "locks"), { recursive: true });
      writeFileSync(path.join(tmp, "locks", "flush.more"), "");
      return { ok: true, acknowledged: 1 };
    });
    const outbox = outboxWith(1);
    const real = vi.mocked(takeNamedLock).getMockImplementation() as typeof takeNamedLock;
    vi.mocked(takeNamedLock).mockImplementationOnce(real).mockReturnValueOnce(null);
    expect(await drain(tmp, sinks(), outbox)).toEqual({ h: 1 });
    expect(http.send).toHaveBeenCalledTimes(1);
    expect(existsSync(path.join(tmp, "locks", "flush.more"))).toBe(true);
  });
});
