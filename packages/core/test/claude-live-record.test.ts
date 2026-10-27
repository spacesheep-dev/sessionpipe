// SPDX-License-Identifier: Apache-2.0
// Which one process holds a Claude Code session, and which account it belongs to when
// more than one has its transcript (spec/CONTROL.md §6, Homes; §6.3 `inbox`). Registry
// rows are files in a temp dir; the live pid is this test process's own.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { findTranscripts, liveRecord, liveRecords, resolveHome } from "../src/adapters/claude-code-control.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "sp-live-record-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const SESSION = "ed6c7665-589f-40c7-b7b4-e38ee662b7bc";
const PROJECT = "-Users-dev-app";

/** A config dir with a transcript for `session`, and the rows asked for. */
function home(name: string, o: { session?: string; rows?: Record<string, unknown>[]; keyFor?: number } = {}): string {
  const dir = path.join(tmp, name);
  if (o.session) {
    mkdirSync(path.join(dir, "projects", PROJECT), { recursive: true });
    writeFileSync(path.join(dir, "projects", PROJECT, `${o.session}.jsonl`), "");
  }
  if (o.rows) {
    mkdirSync(path.join(dir, "sessions"), { recursive: true });
    for (const r of o.rows) writeFileSync(path.join(dir, "sessions", `${r.pid}.json`), JSON.stringify(r));
  }
  if (o.keyFor !== undefined)
    writeFileSync(path.join(dir, "sessions", `${o.keyFor}.${"a".repeat(64)}.key`), JSON.stringify({ peerToken: "x" }));
  return dir;
}

describe("liveRecords", () => {
  it("reads one row per live process, with every field the inbox lane checks", () => {
    const dir = home("records", {
      session: SESSION,
      rows: [
        {
          pid: process.pid,
          sessionId: SESSION,
          messagingSocketPath: "/tmp/sp.sock",
          peerProtocol: 1,
          procStart: "Mon Oct 26 19:53:13 2026",
          status: "idle",
          kind: "interactive",
          entrypoint: "cli",
        },
      ],
      keyFor: process.pid,
    });
    const [rec, ...rest] = liveRecords(SESSION, dir);
    expect(rest).toEqual([]);
    expect(rec).toMatchObject({
      configDir: dir,
      pid: process.pid,
      socket: "/tmp/sp.sock",
      peerProtocol: 1,
      procStart: "Mon Oct 26 19:53:13 2026",
      status: "idle",
      kind: "interactive",
      entrypoint: "cli",
    });
    expect(rec?.keyFile).toBe(path.join(dir, "sessions", `${process.pid}.${"a".repeat(64)}.key`));
    expect(liveRecord(SESSION, dir)).toEqual(rec);
    expect(liveRecord(SESSION, [dir])).toEqual(rec);
  });

  it("a row with nothing but a session id reads as a process with no inbox", () => {
    const dir = home("bare", { session: SESSION, rows: [{ pid: process.pid, sessionId: SESSION }] });
    expect(liveRecord(SESSION, dir)).toMatchObject({
      socket: null,
      peerProtocol: null,
      procStart: null,
      status: null,
      kind: null,
      entrypoint: null,
      keyFile: null,
    });
  });

  it("skips a dead pid, another session, a file that isn't a row and one that isn't JSON", () => {
    const dir = home("skips", {
      session: SESSION,
      rows: [
        { pid: 2_147_483_000, sessionId: SESSION },
        { pid: 7, sessionId: "another-session" },
      ],
    });
    writeFileSync(path.join(dir, "sessions", "notes.json"), "{}");
    writeFileSync(path.join(dir, "sessions", "9.json"), "{ broken");
    expect(liveRecords(SESSION, dir)).toEqual([]);
    expect(liveRecord(SESSION, dir)).toBeNull();
    expect(liveRecords(SESSION, path.join(tmp, "no-such-home"))).toEqual([]);
  });

  it("the pid comes from the file name when the row doesn't say", () => {
    const dir = home("byname", { session: SESSION, rows: [{ pid: process.pid, sessionId: SESSION }] });
    rmSync(path.join(dir, "sessions", `${process.pid}.json`));
    writeFileSync(path.join(dir, "sessions", `${process.pid}.json`), JSON.stringify({ sessionId: SESSION }));
    expect(liveRecord(SESSION, dir)?.pid).toBe(process.pid);
  });

  it("two live processes for one session is null, not a guess", () => {
    const a = home("two-a", { session: SESSION, rows: [{ pid: process.pid, sessionId: SESSION }] });
    const b = home("two-b", { session: SESSION, rows: [{ pid: process.ppid, sessionId: SESSION }] });
    expect(liveRecords(SESSION, [a, b])).toHaveLength(2);
    expect(liveRecord(SESSION, [a, b])).toBeNull();
  });
});

describe("resolveHome", () => {
  it("one account with the transcript needs no live process", () => {
    const dir = home("one", { session: SESSION });
    expect(findTranscripts(SESSION, [dir])).toHaveLength(1);
    expect(findTranscripts("short", [dir])).toEqual([]);
    expect(resolveHome(SESSION, [dir])).toEqual({
      transcript: { file: path.join(dir, "projects", PROJECT, `${SESSION}.jsonl`), configDir: dir, project: PROJECT },
    });
  });

  it("no account has it at all", () => {
    expect(resolveHome(SESSION, [path.join(tmp, "nowhere")])).toBeNull();
  });

  it("two accounts, one holding it open: that one", () => {
    const live = home("pick-live", { session: SESSION, rows: [{ pid: process.pid, sessionId: SESSION }] });
    const cold = home("pick-cold", { session: SESSION });
    const got = resolveHome(SESSION, [cold, live]);
    expect(got).toEqual({
      transcript: {
        file: path.join(live, "projects", PROJECT, `${SESSION}.jsonl`),
        configDir: live,
        project: PROJECT,
      },
    });
  });

  it("two accounts and none of them live: ambiguous, named by directory and nothing else", () => {
    const a = home("amb-a", { session: SESSION });
    const b = home("amb-b", { session: SESSION });
    expect(resolveHome(SESSION, [b, a])).toEqual({ ambiguous: ["amb-a", "amb-b"] });
  });

  it("two accounts and both live: ambiguous too", () => {
    const a = home("both-a", { session: SESSION, rows: [{ pid: process.pid, sessionId: SESSION }] });
    const b = home("both-b", { session: SESSION, rows: [{ pid: process.ppid, sessionId: SESSION }] });
    expect(resolveHome(SESSION, [a, b])).toEqual({ ambiguous: ["both-a", "both-b"] });
    expect([a, b].every((d) => path.isAbsolute(d))).toBe(true);
  });
});
