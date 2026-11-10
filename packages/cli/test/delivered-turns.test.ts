// SPDX-License-Identifier: Apache-2.0
// A turn's `user` text is what the person wrote, whichever way sessionpipe delivered it.
// Three sessions recorded on 2.1.322 (2026-11-10), replayed through the worker a hook at
// a time: a message a Stop hook delivered into a terminal session, a session the daemon
// started whose subagent handed a report back, and a copy of a session.
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Event } from "@sessionpipe/core";
import { frame, frameStart } from "@sessionpipe/core/control";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openTurn, runJob } from "../src/run.js";

const rows = (name: string) =>
  readFileSync(new URL(`../../../conformance/transcripts/claude-code/${name}.jsonl`, import.meta.url), "utf8")
    .trimEnd()
    .split("\n");
const SID = "00000000-0000-4000-8000-000000000004";
const HOST = "http://localhost:8791";

let tmp: string;
let transcript: string;
let out: string;
let at = Date.parse("2026-11-10T16:57:10.000Z");
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "sp-delivered-"));
  transcript = path.join(tmp, "t.jsonl");
  out = path.join(tmp, "sent.jsonl");
  process.env.SESSIONPIPE_CONFIG = path.join(tmp, "config.json");
  writeFileSync(
    process.env.SESSIONPIPE_CONFIG,
    JSON.stringify({ sinks: [{ name: "f", url: `file:${out}`, tier: 2 }], harnesses: {} }),
  );
  writeFileSync(transcript, "");
});
afterEach(() => {
  delete process.env.SESSIONPIPE_CONFIG;
  rmSync(tmp, { recursive: true, force: true });
});
const hook = (event: string, extra: Record<string, unknown> = {}) => {
  at += 1000;
  return runJob(
    {
      harness: "claude-code",
      event,
      argv: ["claude-code", event],
      stdin: JSON.stringify({
        session_id: SID,
        cwd: tmp,
        hook_event_name: event,
        transcript_path: transcript,
        ...extra,
      }),
      cwd: tmp,
      env: { CLAUDE_CONFIG_DIR: tmp },
      at,
    },
    { state: tmp },
  );
};
const sent = (): Event[] =>
  existsSync(out)
    ? readFileSync(out, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
const types = (events: Event[]) => events.map((e) => e.type);
const said = (type: string) =>
  sent()
    .filter((e) => e.type === type)
    .map((e) => e.data);

describe("a message sessionpipe's Stop hook delivered in a terminal session", () => {
  const ROWS = rows("stop-hook-delivery");
  const flush = (from: number, to: number) =>
    appendFileSync(
      transcript,
      ROWS.slice(from, to)
        .map((l) => `${l}\n`)
        .join(""),
    );
  const SLEEP =
    "Run `sleep 25` in bash, then read docs/api.md and say one sentence about it, then end with the word LONGDONE.";
  const WAITING =
    "`sleep 25` is running in the background, since this environment blocks foreground sleep. I'll read `docs/api.md` once it finishes.";
  const DONE =
    "`docs/api.md` is a short stub with a heading and one line pointing to `src/api.ts` for the API details.\n\nLONGDONE";

  it("is the prompt of the turn that answers it; the turn before and the one after are their own", async () => {
    await hook("SessionStart", { source: "startup" });
    flush(0, 1);
    await hook("UserPromptSubmit", { prompt: SLEEP, prompt_id: "id1" });
    // The turn ends; the Stop hook answers with the message the daemon had queued.
    flush(1, 5);
    const first = await hook("Stop", {
      prompt_id: "id1",
      last_assistant_message: WAITING,
      background_tasks: [{ id: "b1" }],
    });
    expect(types(first.events)).toEqual(["turn.ended", "turn.transcript"]);
    // The session answers the message, and stops again.
    flush(5, 10);
    const second = await hook("Stop", {
      prompt_id: "id1",
      last_assistant_message: "INTERRUPT1",
      stop_hook_active: true,
    });
    expect(types(second.events)).toEqual(["turn.ended", "turn.transcript"]);
    // The background command finishes and wakes the session: a turn nobody asked.
    flush(10, 13);
    const woken = await hook("UserPromptSubmit", {
      prompt: "<task-notification>\n<task-id>blcjyvy8f</task-id>\n<status>completed</status>\n</task-notification>",
      prompt_id: "id19",
    });
    expect(types(woken.events)).toEqual(["turn.started"]);
    flush(13, 18);
    await hook("Stop", { prompt_id: "id19", last_assistant_message: DONE });

    expect(said("turn.transcript")).toEqual([
      { turn: 0, user: SLEEP, assistant: WAITING, at: "2026-11-10T16:57:10.609Z" },
      {
        turn: 1,
        user: "Reply with only the word INTERRUPT1.",
        assistant: "INTERRUPT1",
        at: "2026-11-10T16:57:30.600Z",
        injected: true,
      },
      { turn: 2, user: "", assistant: DONE, at: "2026-11-10T16:57:47.883Z" },
    ]);
    expect(JSON.stringify(sent())).not.toMatch(/hook feedback|Message via|Answer it right here/);
  });
});

describe("a session the daemon started, whose subagent handed its report back", () => {
  const ROWS = rows("subagent-handback");
  const WORDS =
    "Use a subagent (the Agent tool) to count the files under docs/, then reply with only: SEVEN-B and the count.";
  it("reads as the person's words from its first moment to its last", async () => {
    await hook("SessionStart", { source: "startup" });
    // The prompt as the daemon gave it to `claude -p`: the words, then where they came from.
    const started = await hook("UserPromptSubmit", { prompt: frameStart(WORDS, HOST), prompt_id: "id1" });
    expect(started.events[1]?.data).toMatchObject({ turn: 0, user: WORDS, assistant: "" });
    // The subagent's report is absorbed by the running turn: Claude Code fires a prompt
    // hook for it under the turn's own id.
    appendFileSync(transcript, `${ROWS.slice(0, 5).join("\n")}\n`);
    const absorbed = await hook("UserPromptSubmit", {
      prompt: '<agent-message from="agent1">\n[Subagent hand-back] The report follows:\n  4 files.\n</agent-message>',
      prompt_id: "id1",
    });
    expect(absorbed.events.find((e) => e.type === "turn.progress")?.data).toMatchObject({ turn: 0, user: WORDS });
    appendFileSync(transcript, `${ROWS.slice(5).join("\n")}\n`);
    await hook("Stop", { prompt_id: "id1", last_assistant_message: "SEVEN-B 4" });
    expect(said("turn.transcript")).toEqual([
      { turn: 0, user: WORDS, assistant: "SEVEN-B 4", at: "2026-11-10T17:43:34.348Z" },
    ]);
    expect(JSON.stringify(sent().filter((e) => e.type !== "turn.started"))).not.toMatch(
      /Sent via|hand-back|docs\/ directory/,
    );
  });
});

describe("a copy of a session", () => {
  const ROWS = rows("copy-of-session");
  it("shows the message it was started for, not the daemon's note to the copy", async () => {
    await hook("SessionStart", { source: "fork" });
    const given = (ROWS.map((l) => JSON.parse(l))[0] as { message: { content: string } }).message.content;
    expect(given).toMatch(
      /^Message via localhost:8791 .*\n\nReply with only the word IDLE1\.\n\nYou are a copy of that session/,
    );
    const started = await hook("UserPromptSubmit", { prompt: given, prompt_id: "id2" });
    expect(started.events[1]?.data).toMatchObject({ turn: 0, user: "Reply with only the word IDLE1.", assistant: "" });
    appendFileSync(transcript, `${ROWS.slice(0, 4).join("\n")}\n`);
    await hook("Stop", { prompt_id: "id2", last_assistant_message: "IDLE1" });
    expect(said("turn.transcript")).toEqual([
      { turn: 0, user: "Reply with only the word IDLE1.", assistant: "IDLE1", at: "2026-11-10T17:01:32.949Z" },
    ]);
  });
});

describe("openTurn: the hook's own copy of a prompt", () => {
  it("is read without sessionpipe's words, and known again in the transcript's copy", () => {
    const hint = frame("Rebase the branch.", HOST);
    expect(openTurn({ turns: [], line: 0 }, { base: 3, at: 9, prompt: hint })).toEqual({
      turn: 3,
      user: "Rebase the branch.",
      assistant: "",
      at: 9,
    });
    // The transcript already has the turn, with a reply: it is that turn, not a new one.
    const read = { turns: [{ user: "Rebase the branch.", assistant: "Rebasing.", at: 1, endLine: 2 }], line: 3 };
    expect(openTurn(read, { base: 3, at: 9, prompt: hint })).toMatchObject({ turn: 3, assistant: "Rebasing." });
    // A prompt that was nothing but frame opens no turn.
    expect(openTurn({ turns: [], line: 0 }, { base: 0, at: 9, prompt: frameStart(" ", HOST) })).toBeNull();
  });
});
