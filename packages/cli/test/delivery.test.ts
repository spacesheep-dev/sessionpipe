// SPDX-License-Identifier: Apache-2.0
// A busy machine and its receiver (HTTP.md §2): a session's hooks don't wait on the
// receiver, the machine makes one delivery at a time, batches to an HTTP receiver go
// MIN_GAP_MS apart, and a 429 or a failing receiver is waited out by every worker.
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { type Event, Outbox, ulid } from "@sessionpipe/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deliver, flush, jobsDir, MIN_GAP_MS, runJob, sinkWait } from "../src/run.js";

let tmp = "";
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "sp-delivery-"));
  process.env.SESSIONPIPE_CONFIG = path.join(tmp, "config.json");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

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

interface Answer {
  status: number;
  headers?: Record<string, string>;
}

/** A receiver that answers the n-th POST with `answer(n)` after `delayMs`, and keeps
 *  what it acknowledged, when each POST came, and the most it had in flight. */
async function receiver(answer: (n: number) => Answer, delayMs = 0) {
  const got: Event[] = [];
  const at: number[] = [];
  let inFlight = 0;
  let most = 0;
  const server = createServer((req, res) => {
    const n = at.length;
    at.push(Date.now());
    most = Math.max(most, ++inFlight);
    let body = "";
    req.on("data", (d) => {
      body += d;
    });
    req.on("end", () =>
      setTimeout(() => {
        inFlight--;
        const a = answer(n);
        const events = (JSON.parse(body) as { events: Event[] }).events;
        if (a.status === 202) got.push(...events);
        res.writeHead(a.status, { "content-type": "application/json", ...a.headers });
        res.end(
          JSON.stringify(
            a.status === 202 ? { accepted: events.length, duplicates: 0, rejected: [] } : { reason: "not now" },
          ),
        );
      }, delayMs),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    got,
    at,
    most: () => most,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
}

/** The sink's wait is over (its failure count kept), with no gap left to keep. */
function elapse(sink: string): void {
  writeFileSync(
    path.join(tmp, "sinks", `${sink}.json`),
    JSON.stringify({ until: 0, failures: sinkWait(tmp, sink).failures }),
  );
}

describe("a receiver that says wait (HTTP.md §2)", () => {
  it("a 429 holds the sink for its retry-after, for every later flush; the backlog goes after", async () => {
    const r = await receiver((n) => (n === 0 ? { status: 429, headers: { "retry-after": "120" } } : { status: 202 }));
    try {
      const outbox = new Outbox(tmp);
      outbox.append({ harness: "codex", session: "s" }, [ev("s", 0), ev("s", 1)]);
      const sinks = [{ name: "h", url: r.url, tier: 0 as const }];
      expect((await flush(tmp, sinks, outbox)).h).toBe(0);
      const w = sinkWait(tmp, "h");
      expect(w.status).toBe(429);
      expect(w.until - Date.now()).toBeGreaterThan(110_000);
      // Another worker inside the window asks nothing.
      expect((await flush(tmp, sinks, outbox)).h).toBe(0);
      expect(r.at).toHaveLength(1);
      elapse("h");
      expect((await flush(tmp, sinks, outbox)).h).toBe(2);
      expect(r.got.map((e) => e.session.seq)).toEqual([0, 1]);
      expect(sinkWait(tmp, "h")).toMatchObject({ until: 0, failures: 0 });
    } finally {
      await r.close();
    }
  });

  it("a failing receiver is tried again after 2 s, then 10 s; one 202 clears the count", async () => {
    const r = await receiver((n) => (n < 2 ? { status: 503 } : { status: 202 }));
    try {
      const outbox = new Outbox(tmp);
      outbox.append({ harness: "codex", session: "s" }, [ev("s", 0)]);
      const sinks = [{ name: "h", url: r.url, tier: 0 as const }];
      const waits: number[] = [];
      for (let i = 1; i <= 2; i++) {
        expect((await flush(tmp, sinks, outbox)).h).toBe(0);
        const w = sinkWait(tmp, "h");
        expect(w.failures).toBe(i);
        waits.push(w.until - Date.now());
        elapse("h");
      }
      expect(waits[0]).toBeGreaterThan(1_000);
      expect(waits[0]).toBeLessThanOrEqual(2_000);
      expect(waits[1]).toBeGreaterThan(9_000);
      expect(waits[1]).toBeLessThanOrEqual(10_000);
      expect((await flush(tmp, sinks, outbox)).h).toBe(1);
      expect(sinkWait(tmp, "h")).toMatchObject({ until: 0, failures: 0 });
    } finally {
      await r.close();
    }
  });

  it("the workers' batches to an HTTP receiver go MIN_GAP_MS apart", async () => {
    const r = await receiver(() => ({ status: 202 }));
    try {
      const outbox = new Outbox(tmp);
      for (const s of ["a", "b"])
        outbox.append(
          { harness: "codex", session: s },
          Array.from({ length: 30 }, (_, i) => ev(s, i)),
        );
      expect((await deliver(tmp, [{ name: "h", url: r.url, tier: 0 as const }], outbox)).h).toBe(60);
      expect(r.at).toHaveLength(2);
      expect((r.at[1] ?? 0) - (r.at[0] ?? 0)).toBeGreaterThanOrEqual(MIN_GAP_MS - 20);
    } finally {
      await r.close();
    }
  });
});

describe("one delivery per machine", () => {
  const job = (session: string, event: string, extra: Record<string, unknown> = {}) => ({
    harness: "codex",
    event,
    argv: ["codex", event],
    stdin: JSON.stringify({ session_id: session, cwd: tmp, hook_event_name: event, model: "m", ...extra }),
    cwd: tmp,
    env: {},
    at: Date.now(),
  });
  const sinkTo = (url: string) =>
    writeFileSync(
      process.env.SESSIONPIPE_CONFIG as string,
      JSON.stringify({ harnesses: {}, sinks: [{ name: "h", url, tier: 1 }] }),
    );

  it("eight hooks of one session and a slow receiver: none waits its turn, one POST at a time, each event once", async () => {
    // Before, each hook held the session's lock across its POST: the eighth waited
    // seven seconds, gave up at six and went back to the queue.
    const r = await receiver(() => ({ status: 202 }), 1_000);
    try {
      sinkTo(r.url);
      const jobs = [
        job("busy", "SessionStart", { source: "startup" }),
        job("busy", "UserPromptSubmit", { prompt: "go" }),
        ...Array.from({ length: 5 }, (_, i) =>
          job("busy", "PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: `t${i}` }),
        ),
        job("busy", "Stop"),
      ];
      await Promise.all(jobs.map((j) => runJob(j, { state: tmp })));
      expect(existsSync(jobsDir(tmp)) ? readdirSync(jobsDir(tmp)) : []).toEqual([]);
      expect(r.most()).toBe(1);
      expect(r.got.map((e) => e.session.seq).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    } finally {
      await r.close();
    }
  }, 20_000);

  it("six sessions' hooks at once: one POST in flight, all six delivered", async () => {
    const r = await receiver(() => ({ status: 202 }), 300);
    try {
      sinkTo(r.url);
      await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          runJob(job(`s${i}`, "SessionStart", { source: "startup" }), { state: tmp }),
        ),
      );
      expect(r.most()).toBe(1);
      expect(new Set(r.got.map((e) => e.session.id)).size).toBe(6);
    } finally {
      await r.close();
    }
  }, 20_000);
});
