// SPDX-License-Identifier: Apache-2.0
// Claude Code's `mcp list` emits SessionEnd without ever starting a session.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { type Event, Outbox, takeLock } from "@sessionpipe/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aliasFile, writeAliases } from "../src/control/aliases.js";
import { claimJob, enqueueJob, factsState, runJob } from "../src/run.js";

const fixture = JSON.parse(
  readFileSync(new URL("fixtures/claude-code-lone-session-end.json", import.meta.url), "utf8"),
);
const ref = { harness: "claude-code", session: fixture.payload.session_id as string };
let tmp: string;
let transcript: string;
let out: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "sp-end-"));
  transcript = path.join(tmp, fixture.payload.transcript_path);
  out = path.join(tmp, "sent.jsonl");
  vi.stubEnv("SESSIONPIPE_CONFIG", path.join(tmp, "config.json"));
  vi.stubEnv("SESSIONPIPE_SOCKET", path.join(tmp, "control.sock"));
  writeFileSync(
    process.env.SESSIONPIPE_CONFIG!,
    JSON.stringify({ sinks: [{ name: "f", url: `file:${out}`, tier: 2 }], harnesses: {} }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

const job = (event = "SessionEnd", extra: Record<string, unknown> = {}) => ({
  harness: ref.harness,
  event,
  argv: [ref.harness, event],
  stdin: JSON.stringify({
    ...fixture.payload,
    transcript_path: transcript,
    cwd: tmp,
    hook_event_name: event,
    ...extra,
  }),
  cwd: tmp,
  env: { CLAUDE_CONFIG_DIR: tmp },
  at: Date.parse("2026-10-14T12:00:00.000Z"),
});
const sent = (): Event[] =>
  existsSync(out)
    ? readFileSync(out, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
    : [];
const writeTranscript = (text = "") => {
  mkdirSync(path.dirname(transcript), { recursive: true });
  writeFileSync(transcript, text);
};

describe("Claude SessionEnd", () => {
  it("the lone-end fixture sends nothing and leaves no outbox, sequence or facts, even on retry", async () => {
    expect(existsSync(transcript)).toBe(false);
    for (let i = 0; i < 2; i++) {
      const claim = claimJob(enqueueJob(tmp, job()))!;
      const result = await runJob(claim.job, { state: tmp, claimed: claim.file });
      expect(result).toEqual({ events: [], delivered: {} });
      expect(existsSync(claim.file)).toBe(false);
      expect(existsSync(path.join(tmp, "outbox"))).toBe(false);
      expect(existsSync(path.join(tmp, "facts"))).toBe(false);
      expect(existsSync(out)).toBe(false);
      const release = takeLock(tmp, ref);
      expect(release).not.toBeNull();
      release?.();
    }
  });

  it("also ignores an unknown session whose hook omits transcript_path", async () => {
    expect(await runJob(job("SessionEnd", { transcript_path: undefined }), { state: tmp })).toEqual({
      events: [],
      delivered: {},
    });
    expect(existsSync(new Outbox(tmp).file(ref))).toBe(false);
    expect(sent()).toEqual([]);
  });

  it("SessionStart is enough even when no transcript was ever written", async () => {
    await runJob(job("SessionStart", { source: "startup" }), { state: tmp });
    const { events, delivered } = await runJob(job(), { state: tmp });
    expect(events.map((e) => e.type)).toEqual(["session.ended"]);
    expect(events[0]?.data).toEqual({ reason: "other" });
    expect(delivered).toEqual({ f: 1 });
    expect(sent().map((e) => [e.type, e.session.seq])).toEqual([
      ["session.started", 0],
      ["session.ended", 1],
    ]);
  });

  it("an existing outbox preserves the end when the transcript was deleted and facts are gone", async () => {
    writeTranscript();
    await runJob(job("SessionStart", { source: "startup" }), { state: tmp });
    unlinkSync(transcript);
    rmSync(path.join(tmp, "facts"), { recursive: true, force: true });
    expect(existsSync(new Outbox(tmp).file(ref))).toBe(true);
    const { events, delivered } = await runJob(job(), { state: tmp });
    expect(events.map((e) => [e.type, e.session.seq])).toEqual([["session.ended", 1]]);
    expect(delivered).toEqual({ f: 1 });
    expect(sent().map((e) => e.type)).toEqual(["session.started", "session.ended"]);
  });

  it("stored facts alone preserve the end without an outbox or transcript", async () => {
    factsState(tmp).save(ref.harness, ref.session, { session: { title: "A real session" } });
    const { events, delivered } = await runJob(job(), { state: tmp });
    expect(events.map((e) => e.type)).toEqual(["session.ended"]);
    expect(events[0]?.session.title).toBe("A real session");
    expect(delivered).toEqual({ f: 1 });
    expect(sent()).toHaveLength(1);
  });

  it("an existing empty transcript preserves the end without prior state", async () => {
    writeTranscript();
    const { events, delivered } = await runJob(job(), { state: tmp });
    expect(events.map((e) => e.type)).toEqual(["session.ended"]);
    expect(delivered).toEqual({ f: 1 });
    expect(sent()).toHaveLength(1);
  });

  it("a real transcript still sends its turns with the end when SessionStart was missed", async () => {
    writeTranscript(
      `${[
        { type: "user", timestamp: "2026-10-14T11:59:00.000Z", message: { role: "user", content: "Hello" } },
        {
          type: "assistant",
          timestamp: "2026-10-14T11:59:01.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "Hi" }] },
        },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n")}\n`,
    );
    const { events, delivered } = await runJob(job(), { state: tmp });
    expect(events.map((e) => e.type)).toEqual(["session.ended", "turn.transcript"]);
    expect(events[1]?.data).toMatchObject({ turn: 0, user: "Hello", assistant: "Hi" });
    expect(delivered).toEqual({ f: 2 });
    expect(sent()).toHaveLength(2);
  });

  it("checks facts using the receiver's aliased session id", async () => {
    writeAliases(aliasFile(path.join(tmp, "control")), {
      "claude-code:receiver-session": { id: ref.session, cwd: tmp, at: "2026-10-14T11:59:00.000Z" },
    });
    factsState(tmp).save(ref.harness, "receiver-session", { session: { title: "Aliased session" } });
    const { events } = await runJob(job(), { state: tmp });
    expect(events.map((e) => [e.type, e.session.id])).toEqual([["session.ended", "receiver-session"]]);
    expect(sent()).toHaveLength(1);
  });

  it("waits for the session lock before deciding that no session exists", async () => {
    const release = takeLock(tmp, ref)!;
    try {
      const pending = runJob(job(), { state: tmp });
      factsState(tmp).save(ref.harness, ref.session, { session: { title: "Started by another worker" } });
      release();
      const { events } = await pending;
      expect(events.map((e) => e.type)).toEqual(["session.ended"]);
      expect(sent()).toHaveLength(1);
    } finally {
      release();
    }
  });

  it.runIf(process.platform !== "win32")("only a real session's end reaches the local daemon", async () => {
    const got: Record<string, unknown>[] = [];
    const server = net.createServer((c) =>
      c.once("data", (d) => {
        got.push(JSON.parse(d.toString("utf8").split("\n")[0]!));
        c.end('{"op":"ok"}\n');
      }),
    );
    await new Promise<void>((r) => server.listen(path.join(tmp, "control.sock"), () => r()));
    try {
      await runJob(job(), { state: tmp });
      expect(got).toEqual([]);
      await runJob(job("SessionStart", { source: "startup" }), { state: tmp });
      await runJob(job(), { state: tmp });
      expect(got.map((e) => e.event)).toEqual(["SessionStart", "SessionEnd"]);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
