// SPDX-License-Identifier: Apache-2.0
// limits.observed: an account's usage limits reach a tier-1 sink when the harness
// reports new numbers — Codex's rollout after a turn, Claude Code's status line.
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { runJob } from "../src/run.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "sp-limits-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const out = path.join(tmp, "events.jsonl");
process.env.SESSIONPIPE_CONFIG = path.join(tmp, "config.json");
const sinkAt = (tier: number, extra: Record<string, unknown> = {}) =>
  writeFileSync(
    process.env.SESSIONPIPE_CONFIG as string,
    JSON.stringify({ sinks: [{ name: "f", url: `file:${out}`, tier, ...extra }], harnesses: {} }),
  );
const sent = (type = "limits.observed") =>
  existsSync(out)
    ? readFileSync(out, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((e) => e.type === type)
    : [];
beforeEach(() => {
  rmSync(out, { force: true });
  sinkAt(1);
});

const SID = "01a0ce98-b031-7ce3-aa6b-b74a647b0ebc";
const rollout = path.join(tmp, `rollout-2026-10-21T20-08-28-${SID}.jsonl`);
writeFileSync(rollout, `${JSON.stringify({ type: "session_meta", payload: { id: SID, cwd: tmp } })}\n`);
const tokens = (used: number) =>
  appendFileSync(
    rollout,
    `${JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        rate_limits: {
          primary: { used_percent: used, window_minutes: 10080, resets_at: 1793099533 },
          secondary: null,
          plan_type: "prolite",
        },
      },
    })}\n`,
  );
const codexJob = (event: string, transcript: string | null = rollout) => ({
  harness: "codex",
  event,
  argv: ["codex", event],
  stdin: JSON.stringify({ session_id: SID, cwd: tmp, hook_event_name: event, transcript_path: transcript }),
  cwd: tmp,
  env: { CODEX_HOME: tmp },
  at: Date.now(),
});

describe("Codex: the rollout's newest limits after a turn", () => {
  it("goes once per change, at tier 1 with its windows and plan", async () => {
    tokens(6);
    await runJob(codexJob("Stop"), { state: tmp });
    await runJob(codexJob("Stop"), { state: tmp });
    expect(sent().map((e) => e.data)).toEqual([
      {
        windows: [{ id: "primary", used_percent: 6, window_minutes: 10080, resets_at: "2026-10-27T11:12:13.000Z" }],
        plan: "prolite",
      },
    ]);
    expect(sent()[0]).toMatchObject({ tier: 1, harness: { name: "codex", event: "Stop" } });
    tokens(7);
    await runJob(codexJob("Stop"), { state: tmp });
    expect(sent().map((e) => e.data.windows[0].used_percent)).toEqual([6, 7]);
  });
  it("names the Codex version the rollout records", async () => {
    const id = "01a0ce98-b031-7ce3-aa6b-b74a647b0ebd";
    const f = path.join(tmp, `rollout-2026-10-21T20-09-00-${id}.jsonl`);
    writeFileSync(
      f,
      `${[
        { type: "session_meta", payload: { id, cwd: tmp, cli_version: "0.163.0" } },
        { type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: 2 } } } },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n")}\n`,
    );
    const j = codexJob("Stop", f);
    await runJob({ ...j, stdin: j.stdin.replace(SID, id) }, { state: tmp });
    expect(sent()[0]).toMatchObject({ harness: { name: "codex", version: "0.163.0" }, session: { id } });
  });
  it("not while a turn runs, nor without a rollout", async () => {
    tokens(8);
    await runJob(codexJob("PostToolUse"), { state: tmp });
    await runJob(codexJob("Stop", null), { state: tmp });
    expect(sent()).toEqual([]);
  });
  it("not for a sink below tier 1, or a paused one", async () => {
    tokens(9);
    sinkAt(0);
    await runJob(codexJob("Stop"), { state: tmp });
    sinkAt(3, { paused: "2026-10-22" });
    await runJob(codexJob("Stop"), { state: tmp });
    expect(sent("turn.ended")).toHaveLength(1);
    expect(sent()).toEqual([]);
  });
});

describe("Claude Code: the status line's limits", () => {
  it("become limits.observed on the session, like any hook event", async () => {
    await runJob(
      {
        harness: "claude-code",
        event: "StatusLine",
        argv: ["claude-code", "StatusLine"],
        stdin: JSON.stringify({
          session_id: "0b4a6e3c-1d2f-4a5b-8c6d-7e8f9a0b1c2d",
          cwd: tmp,
          transcript_path: path.join(tmp, "t.jsonl"),
          rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 1738425600 } },
        }),
        cwd: tmp,
        env: { CLAUDE_CONFIG_DIR: tmp },
        at: Date.now(),
      },
      { state: tmp },
    );
    expect(sent()).toMatchObject([
      {
        session: { id: "0b4a6e3c-1d2f-4a5b-8c6d-7e8f9a0b1c2d" },
        data: {
          windows: [
            { id: "five_hour", used_percent: 23.5, window_minutes: 300, resets_at: "2025-02-01T16:00:00.000Z" },
          ],
        },
      },
    ]);
  });
});
