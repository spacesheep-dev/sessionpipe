// SPDX-License-Identifier: Apache-2.0
// A turn's `user` text is what the person wrote, whichever way sessionpipe delivered it.
// Three sessions recorded on 2.1.322 (2026-11-10), replayed through the worker a hook at
// a time: a message a Stop hook delivered into a terminal session, a session the daemon
// started whose subagent handed a report back, and a copy of a session.
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Event } from "@sessionpipe/core";
import { COPY_NOTE, frame, frameStart } from "@sessionpipe/core/control";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { frameAsk as routeAsk } from "../src/control/route.js";
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
const hook = (event: string, extra: Record<string, unknown> = {}, env: Record<string, string> = {}) => {
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
      env: { CLAUDE_CONFIG_DIR: tmp, ...env },
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

// An agent's task, handed over by `sessionpipe ask` (CONTROL.md §13), is not the person's
// words, and the paragraph the daemon puts after it is what says so. A receiver reads it
// off the turn's `user` text: spacesheep's session page captions the turn "asked with
// sessionpipe" by the test below (`askedBy`, packages/app/src/pages/session-detail.ts,
// copied as it stood on 2026-11-10; its handoff twin reads the first line of an answer).
// With the paragraph taken off, the task was drawn as the person's own message.
const askedBy = (user: string) => {
  const m =
    /\n\n\(Asked by ([a-z][a-z0-9-]{0,39}:[A-Za-z0-9._:-]{1,128}) on this machine with sessionpipe ask(?:, message [A-Za-z0-9]{1,40})?\.[^)]*\)\s*$/.exec(
      user,
    );
  return m ? { from: m[1], text: user.slice(0, m.index) } : null;
};

describe("a task another agent asked with sessionpipe ask", () => {
  const FROM = "codex:01a10860-a43f-7ce2-b12f-a7911ae8a880";
  const TASK = "Count the files under docs/.";
  // The text exactly as the daemon builds it for every lane an ask takes (control/daemon.ts
  // `framed`, a sink's `frame`): the task, then who asked and how the answer travels.
  const GIVEN = routeAsk(TASK, FROM);
  const USER =
    "Count the files under docs/.\n\n(Asked by codex:01a10860-a43f-7ce2-b12f-a7911ae8a880 on this machine with sessionpipe ask. Answer here in full: your reply is returned to that session automatically. Don't run a command or call a tool just to send it.)";
  // Claude Code's own records, as recorded: a prompt the daemon gave `claude -p`, a reply,
  // and the meta record of a Stop hook's block. Only the words in them are set here.
  const START = rows("subagent-handback").map((l) => JSON.parse(l));
  const BLOCK = rows("stop-hook-delivery").map((l) => JSON.parse(l));
  const row = (shape: { message: { content: unknown } }, content: unknown) =>
    appendFileSync(transcript, `${JSON.stringify({ ...shape, message: { ...shape.message, content } })}\n`);
  const reply = (text: string) => row(START[5], [{ type: "text", text }]);

  it("is built as the test expects", () => {
    expect(GIVEN).toBe(USER);
  });

  it("a cold ask, a new session started for it: the task with the paragraph that says who asked", async () => {
    const asked = { SESSIONPIPE_ASKED_BY: FROM };
    await hook("SessionStart", { source: "startup" }, asked);
    const started = await hook("UserPromptSubmit", { prompt: GIVEN, prompt_id: "id1" }, asked);
    expect(started.events[1]?.data).toEqual({ turn: 0, user: USER, assistant: "", at: expect.any(String) });
    row(START[0], GIVEN);
    reply("4");
    await hook("Stop", { prompt_id: "id1", last_assistant_message: "4" }, asked);
    const [turn] = sent().filter((e) => e.type === "turn.transcript");
    expect(turn?.data).toEqual({ turn: 0, user: USER, assistant: "4", at: "2026-11-10T17:43:34.348Z" });
    // Every event of the session says whose it answers, and the turn's text says it too.
    expect(turn?.session.delegated_by).toBe(FROM);
    expect(askedBy(USER)).toEqual({ from: FROM, text: TASK });
  });

  it("an ask into an idle session, resumed for it, or a copy of one open in a window: the same text", async () => {
    await hook("SessionStart", { source: "resume" }, { SESSIONPIPE_ASKED_BY: FROM });
    row(START[0], GIVEN);
    reply("4");
    await hook("Stop", { prompt_id: "id1", last_assistant_message: "4" });
    // The copy is told it is a copy after the paragraph; that note is the daemon's alone.
    row(START[0], `${GIVEN}\n\n${COPY_NOTE}`);
    reply("Still 4.");
    await hook("Stop", { prompt_id: "id1", last_assistant_message: "Still 4." });
    expect(said("turn.transcript").map((t) => [t.user, t.assistant, t.injected ?? false])).toEqual([
      [USER, "4", false],
      [USER, "Still 4.", false],
    ]);
  });

  it("an ask handed over at a Stop hook of the person's own session: its own turn, marked as delivered", async () => {
    await hook("SessionStart", { source: "startup" });
    row(BLOCK[0], "Tidy the changelog.");
    await hook("UserPromptSubmit", { prompt: "Tidy the changelog.", prompt_id: "id1" });
    reply("Tidied.");
    await hook("Stop", { prompt_id: "id1", last_assistant_message: "Tidied." });
    // The hook's block: Claude Code hands the model the daemon's text as a Stop hook's feedback.
    row(BLOCK[5], `Stop hook feedback:\n${GIVEN}`);
    reply("4");
    await hook("Stop", { prompt_id: "id1", last_assistant_message: "4", stop_hook_active: true });
    const turns = sent().filter((e) => e.type === "turn.transcript");
    expect(turns.map((e) => e.data)).toEqual([
      { turn: 0, user: "Tidy the changelog.", assistant: "Tidied.", at: "2026-11-10T16:57:10.609Z" },
      { turn: 1, user: USER, assistant: "4", at: "2026-11-10T16:57:30.600Z", injected: true },
    ]);
    // Nothing else says an agent asked: this is the person's session, not one started for the ask.
    expect(turns[1]?.session.delegated_by).toBeUndefined();
    expect(askedBy(USER)).toEqual({ from: FROM, text: TASK });
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
