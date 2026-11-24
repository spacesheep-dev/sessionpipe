// SPDX-License-Identifier: Apache-2.0
// A turn ends once (conformance/turn-end-once.json): Codex says one turn's end by its Stop
// hook and by its notify when both are installed, and the worker drops whichever comes
// second by the other road: nothing is reported or read for it.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Outbox } from "@sessionpipe/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runJob } from "../src/run.js";

const vectors = JSON.parse(
  readFileSync(new URL("../../../conformance/turn-end-once.json", import.meta.url), "utf8"),
) as { cases: { name: string; ends: [road: "hook" | "notify", turn: string | null][]; reported: unknown[] }[] };

const THREAD = "0199b6f2-7c1d-7e3a-9b4c-5d6e7f8a9b0c";
let tmp: string;
let state: string;
let codexHome: string;
let rollout: string;
let n = 0;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "sp-end-once-"));
  state = path.join(tmp, "state");
  codexHome = path.join(tmp, "codex");
  // The thread's rollout: what makes a notify a session's (it names no transcript itself).
  const day = path.join(codexHome, "sessions", "2026", "11", "24");
  mkdirSync(day, { recursive: true });
  rollout = path.join(day, `rollout-2026-11-24T09-12-23-${THREAD}.jsonl`);
  writeFileSync(rollout, "");
  vi.stubEnv("SESSIONPIPE_CONFIG", path.join(tmp, "config.json"));
  writeFileSync(path.join(tmp, "config.json"), JSON.stringify({ sinks: [], harnesses: {} }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

/** One end as Codex 0.171 says it: the Stop hook's payload on stdin, or notify's one argument. */
const end = (road: "hook" | "notify", turn: string | null) => {
  const base = { harness: "codex", cwd: tmp, env: { CODEX_HOME: codexHome }, at: Date.now(), id: `job-${n++}` };
  return road === "hook"
    ? {
        ...base,
        event: "Stop",
        argv: ["codex", "Stop"],
        stdin: JSON.stringify({
          session_id: THREAD,
          ...(turn ? { turn_id: turn } : {}),
          transcript_path: rollout,
          cwd: tmp,
          hook_event_name: "Stop",
          stop_hook_active: false,
          last_assistant_message: "done",
        }),
      }
    : {
        ...base,
        event: "notify",
        argv: [
          "codex",
          "notify",
          JSON.stringify({
            type: "agent-turn-complete",
            "thread-id": THREAD,
            ...(turn ? { "turn-id": turn } : {}),
            cwd: tmp,
            "last-assistant-message": "done",
          }),
        ],
        stdin: "",
      };
};
const reported = () =>
  new Outbox(state)
    .read({ harness: "codex", session: THREAD }, 0, 100)
    .events.filter((e) => e.type === "turn.ended")
    .map((e) => [e.harness.event === "notify" ? "notify" : "hook", (e.data as { turn_id?: string }).turn_id ?? null]);

describe("conformance/turn-end-once.json", () => {
  for (const c of vectors.cases)
    it(c.name, async () => {
      for (const [road, turn] of c.ends) await runJob(end(road, turn), { state, drain: false });
      expect(reported()).toEqual(c.reported);
    });
});

describe("the copy of a turn's end", () => {
  it("is logged as that, and a copy of it that comes up again is dropped as any job already run", async () => {
    await runJob(end("hook", "t1"), { state, drain: false });
    const copy = end("notify", "t1");
    expect(await runJob(copy, { state, drain: false })).toEqual({ events: [], delivered: {} });
    expect(readFileSync(path.join(state, "log"), "utf8")).toContain(
      "codex notify: this turn's end was already reported by its Stop hook; dropped",
    );
    // The other way round the log names the other road.
    await runJob(end("notify", "t2"), { state, drain: false });
    expect((await runJob(end("hook", "t2"), { state, drain: false })).events).toEqual([]);
    expect(readFileSync(path.join(state, "log"), "utf8")).toContain(
      "codex Stop: this turn's end was already reported by notify; dropped",
    );
    // The same job again (a worker that was held up): dropped as a copy of a hook event.
    expect((await runJob({ ...copy, tries: 2 }, { state, drain: false })).events).toEqual([]);
    expect(readFileSync(path.join(state, "log"), "utf8")).toContain("a copy of a hook event already run; dropped");
    expect(reported()).toEqual([
      ["hook", "t1"],
      ["notify", "t2"],
    ]);
  });

  it("a job that says neither its name nor its time (an old hook's) is dropped all the same", async () => {
    const { id: _a, at: _b, ...hook } = end("hook", "t1");
    const { id: _c, at: _d, ...notify } = end("notify", "t1");
    const now = Date.now();
    await runJob(hook as never, { state, drain: false, now });
    expect((await runJob(notify as never, { state, drain: false, now })).events).toEqual([]);
    expect(reported()).toEqual([["hook", "t1"]]);
  });

  it.runIf(process.platform !== "win32")(
    "a notify that is the copy is not told to the daemon; one that is the turn's only end is, once",
    async () => {
      mkdirSync(state, { recursive: true });
      const sock = path.join(tmp, "control.sock");
      const got: string[] = [];
      const server = net.createServer((c) =>
        c.once("data", (d) => {
          got.push(JSON.parse(d.toString("utf8").split("\n")[0] as string).event);
          c.end(`${JSON.stringify({ op: "ok" })}\n`);
        }),
      );
      await new Promise<void>((r) => server.listen(sock, () => r()));
      vi.stubEnv("SESSIONPIPE_SOCKET", sock);
      try {
        await runJob(end("hook", "t1"), { state, drain: false });
        await runJob(end("notify", "t1"), { state, drain: false });
        expect(got).toEqual(["Stop"]);
        // Hooks off: the notify is the turn's only end, and the daemon hears it.
        await runJob(end("notify", "t2"), { state, drain: false });
        expect(got).toEqual(["Stop", "notify"]);
        // Its own copy, run again, tells nothing more.
        const again = end("notify", "t3");
        await runJob(again, { state, drain: false });
        await runJob({ ...again, tries: 2 }, { state, drain: false });
        expect(got).toEqual(["Stop", "notify", "notify"]);
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    },
  );
});
