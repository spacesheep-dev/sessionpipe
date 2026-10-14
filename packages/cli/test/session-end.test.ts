// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Outbox, takeLock } from "@sessionpipe/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claimJob, enqueueJob, factsState, type Job, runJob } from "../src/run.js";

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../conformance/worker/claude-code-mcp-list.json", import.meta.url)),
    "utf8",
  ),
);
const payload = JSON.parse(fixture.input.stdin);
const ref = { harness: fixture.harness, session: payload.session_id };
let state: string;
let transcript: string;
let job: Job;
beforeEach(() => {
  state = mkdtempSync(path.join(os.tmpdir(), "sp-session-end-"));
  transcript = path.join(state, payload.transcript_path);
  vi.stubEnv("SESSIONPIPE_CONFIG", path.join(state, "config.json"));
  writeFileSync(
    process.env.SESSIONPIPE_CONFIG!,
    JSON.stringify({ harnesses: {}, sinks: [{ name: "f", url: `file:${path.join(state, "sent.jsonl")}`, tier: 2 }] }),
  );
  job = {
    harness: fixture.harness,
    event: fixture.event,
    argv: fixture.input.argv,
    stdin: JSON.stringify({ ...payload, cwd: state, transcript_path: transcript }),
    cwd: state,
    env: { HOME: state },
    at: Date.now(),
  };
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(state, { recursive: true, force: true });
});

describe("Claude Code SessionEnd", () => {
  it.skipIf(process.platform === "win32")("only real ends reach the local daemon", async () => {
    const received: Record<string, unknown>[] = [];
    const server = net.createServer((c) =>
      c.once("data", (d) => {
        received.push(JSON.parse(d.toString("utf8").split("\n")[0]!));
        c.end(`${JSON.stringify({ op: "ok" })}\n`);
      }),
    );
    await new Promise<void>((resolve) => server.listen(path.join(state, "control.sock"), resolve));
    try {
      await runJob(job, { state });
      expect(received).toEqual([]);
      writeFileSync(transcript, "");
      await runJob(job, { state });
      expect(received).toEqual([
        { op: "event", session: `claude-code:${ref.session}`, event: "SessionEnd", cwd: state, transcript },
      ]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("the reported mcp list fixture emits nothing and leaves no facts, outbox or claim", async () => {
    const claimed = claimJob(enqueueJob(state, job))!;
    const result = await runJob(job, { state, claimed: claimed.file });
    expect(result).toEqual({ events: fixture.expect, delivered: {} });
    expect(new Outbox(state).sessions()).toEqual([]);
    expect(existsSync(path.join(state, "facts"))).toBe(false);
    expect(existsSync(path.join(state, "sent.jsonl"))).toBe(false);
    expect(existsSync(claimed.file)).toBe(false);
    const release = takeLock(state, ref);
    expect(release).not.toBeNull();
    release?.();
  });

  it("keeps a normal end after SessionStart even when its transcript is missing", async () => {
    await runJob({ ...job, event: "SessionStart", argv: [job.harness, "SessionStart"] }, { state });
    const result = await runJob(job, { state });
    expect(result.events.map((e) => [e.type, e.session.seq])).toEqual([["session.ended", 1]]);
    expect(result.events[0]?.data).toEqual({ reason: "other" });
    expect(result.delivered.f).toBe(1);
  });

  it("keeps an end when only the outbox remains", async () => {
    await runJob({ ...job, event: "SessionStart", argv: [job.harness, "SessionStart"] }, { state });
    rmSync(path.join(state, "facts"), { recursive: true });
    expect((await runJob(job, { state })).events[0]?.type).toBe("session.ended");
  });

  it("keeps an end when only facts remain", async () => {
    factsState(state).save(job.harness, ref.session, { session: { title: "An existing session" } });
    expect((await runJob(job, { state })).events[0]?.session.title).toBe("An existing session");
  });

  it("keeps an end with an existing transcript, including its tier-2 turns", async () => {
    writeFileSync(
      transcript,
      `${[
        { type: "user", timestamp: "2026-10-13T00:00:00Z", message: { role: "user", content: "hello" } },
        {
          type: "assistant",
          timestamp: "2026-10-13T00:00:01Z",
          message: { role: "assistant", content: [{ type: "text", text: "world" }] },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n")}\n`,
    );
    const result = await runJob(job, { state });
    expect(result.events.map((e) => e.type)).toEqual(["session.ended", "turn.transcript"]);
    expect(result.events[1]?.data).toMatchObject({ user: "hello", assistant: "world" });
    expect(result.delivered.f).toBe(2);
  });

  it("keeps an end even when the existing transcript is empty", async () => {
    writeFileSync(transcript, "");
    expect((await runJob(job, { state })).events.map((e) => e.type)).toEqual(["session.ended"]);
  });
});
