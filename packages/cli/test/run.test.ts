// SPDX-License-Identifier: Apache-2.0
// Issue #9 (no event lost to the lock race) and advisory GHSA-8f6f-c3c9-j5p6
// (the outbox holds redacted strings at rest, 0600/0700).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Outbox, takeLock } from "@sessionpipe/core";
import { afterEach, describe, expect, it } from "vitest";
import { aliasFile, readAliases, receiverIdOf, writeAliases } from "../src/control/aliases.js";
import { enqueueJob, runJob, sweepJobs } from "../src/run.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "sp-run-"));
afterEach(() => rmSync(tmp, { recursive: true, force: true }));
process.env.SESSIONPIPE_CONFIG = path.join(tmp, "config.json");
writeFileSync(process.env.SESSIONPIPE_CONFIG, JSON.stringify({ sinks: [], harnesses: {} }));

const job = (event: string, extra: Record<string, unknown> = {}) => ({
  harness: "codex",
  event,
  argv: ["codex", event],
  stdin: JSON.stringify({ session_id: "race-1", cwd: tmp, hook_event_name: event, model: "m", ...extra }),
  cwd: tmp,
  env: {},
  at: Date.now(),
});

describe("runJob", () => {
  it("four concurrent hooks of one session all reach the outbox, in seq order", async () => {
    const jobs = [
      job("SessionStart", { source: "startup" }),
      job("UserPromptSubmit", { prompt: "hi" }),
      job("PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "a" }),
      job("Stop"),
    ];
    await Promise.all(jobs.map((j) => runJob(j, { state: tmp })));
    const { events } = new Outbox(tmp).read({ harness: "codex", session: "race-1" }, 0, 100);
    expect(events).toHaveLength(4);
    expect(events.map((e) => e.session.seq)).toEqual([0, 1, 2, 3]);
  });
  it("stores tool input redacted at rest, in 0600 files under 0700 dirs", async () => {
    await runJob(
      job("PostToolUse", {
        tool_name: "Bash",
        tool_input: { command: "export DB_PASSWORD=hunter2" },
        tool_response: "ok",
        tool_use_id: "b",
      }),
      { state: tmp },
    );
    const f = new Outbox(tmp).file({ harness: "codex", session: "race-1" });
    const text = readFileSync(f, "utf8");
    expect(text).not.toContain("hunter2");
    expect(text).toContain("[redacted]");
    if (process.platform !== "win32") {
      expect(statSync(f).mode & 0o777).toBe(0o600);
      expect(statSync(path.dirname(f)).mode & 0o777).toBe(0o700);
    }
  });
  it("a job takes its session's lock as soon as a sibling lets go, not at the next backoff step", async () => {
    const ref = { harness: "codex", session: "race-1" };
    const release = takeLock(tmp, ref);
    setTimeout(() => release?.(), 900);
    const t0 = Date.now();
    const { events } = await runJob(job("PreToolUse", { tool_name: "Bash", tool_input: {}, tool_use_id: "c" }), {
      state: tmp,
    });
    expect(events).toHaveLength(1);
    expect(Date.now() - t0).toBeLessThan(1400); // doubling backoff got there at 1550 ms
  });
  it("sweepJobs runs a job another worker left behind", async () => {
    const f = enqueueJob(tmp, job("SessionEnd", { reason: "exit" }));
    const old = new Date(Date.now() - 10_000);
    const { utimesSync } = await import("node:fs");
    utimesSync(f, old, old);
    expect(await sweepJobs(tmp, 3000)).toBe(1);
    const { events } = new Outbox(tmp).read({ harness: "codex", session: "race-1" }, 0, 100);
    expect(events.some((e) => e.type === "session.ended")).toBe(true);
  });
});

describe("sessions the control daemon named (control/aliases.ts)", () => {
  it("aliases are written whole, 0600, and looked up both ways", () => {
    const file = aliasFile(path.join(tmp, "control"));
    expect(readAliases(file)).toEqual({});
    writeAliases(file, { "codex:start-1": { id: "thread-1", cwd: tmp, at: "2026-10-04T00:00:00.000Z" } });
    expect(readAliases(file)["codex:start-1"]).toMatchObject({ id: "thread-1", cwd: tmp });
    expect(receiverIdOf(readAliases(file), "codex", "thread-1")).toBe("start-1");
    expect(receiverIdOf(readAliases(file), "antigravity", "thread-1")).toBeNull();
    expect(receiverIdOf(readAliases(file), "codex", "start-1")).toBeNull();
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    writeFileSync(file, "{");
    expect(readAliases(file)).toEqual({});
  });

  it("a hook event of a session the daemon started goes out under the start's id", async () => {
    writeAliases(aliasFile(path.join(tmp, "control")), {
      "codex:start-1": { id: "race-1", cwd: tmp, at: "2026-10-04T00:00:00.000Z" },
    });
    const { events } = await runJob(job("SessionStart", { source: "startup" }), { state: tmp });
    expect(events.map((e) => e.session.id)).toEqual(["start-1"]);
    const outbox = new Outbox(tmp);
    expect(outbox.read({ harness: "codex", session: "start-1" }, 0, 10).events).toHaveLength(1);
    expect(outbox.read({ harness: "codex", session: "race-1" }, 0, 10).events).toHaveLength(0);
  });

  it.runIf(process.platform !== "win32")(
    "every harness tells the daemon, with the session's own folder; Antigravity's folder is kept",
    async () => {
      mkdirSync(tmp, { recursive: true }); // the last test's cleanup took it
      const sock = path.join(tmp, "control.sock");
      const got: Record<string, unknown>[] = [];
      const server = net.createServer((c) =>
        c.once("data", (d) => {
          got.push(JSON.parse(d.toString("utf8").split("\n")[0] as string));
          c.end(`${JSON.stringify({ op: "ok" })}\n`);
        }),
      );
      await new Promise<void>((r) => server.listen(sock, () => r()));
      try {
        const ws = path.join(tmp, "ws");
        mkdirSync(ws, { recursive: true });
        writeAliases(aliasFile(path.join(tmp, "control")), {
          "antigravity:start-2": { id: "conv-1", cwd: ws, at: "2026-10-04T00:00:00.000Z" },
        });
        await runJob(
          {
            harness: "antigravity",
            event: "Stop",
            argv: ["antigravity", "Stop"],
            stdin: JSON.stringify({ conversationId: "conv-1", workspacePaths: [`file://${ws}`] }),
            cwd: "/",
            env: {},
            at: Date.now(),
          },
          { state: tmp },
        );
        await runJob(job("Stop", { cwd: ws }), { state: tmp });
        expect(got).toEqual([
          { op: "event", session: "antigravity:start-2", event: "Stop", cwd: ws },
          { op: "event", session: "codex:race-1", event: "Stop", cwd: ws },
        ]);
        const facts = JSON.parse(readFileSync(path.join(tmp, "facts", "antigravity", "start-2.json"), "utf8"));
        expect(facts.cwd).toBe(ws);
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    },
  );
});
