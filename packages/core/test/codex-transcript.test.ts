// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { codex, codexFacts } from "../src/adapters/codex.js";
import { codexReplayBoundary } from "../src/adapters/codex-rollout.js";
import { codexHookPrompts, codexInjected, codexPictureTag, codexWords, readCodex } from "../src/readers/transcripts.js";

// Codex writes the AGENTS.md it read into the session as a "user" message (measured on
// codex-cli 0.160.0, 2026-10-04): a turn and a title built from it named the
// instructions instead of what the person asked.
const user = (text: string) =>
  JSON.stringify({
    type: "response_item",
    timestamp: "2026-10-04T12:00:00Z",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
  });
const assistant = (text: string) =>
  JSON.stringify({
    type: "response_item",
    timestamp: "2026-10-04T12:00:05Z",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
  });
const ROLLOUT = [
  JSON.stringify({ type: "session_meta", payload: { cwd: "/workspace", cli_version: "0.160.0" } }),
  user("# AGENTS.md instructions for /workspace\n\n<INSTRUCTIONS>\n# This machine\n…\n</INSTRUCTIONS>"),
  user("<environment_context>\n  <cwd>/workspace</cwd>\n</environment_context>"),
  user("what folder are you in?"),
  assistant("/workspace"),
];

const dirs: string[] = [];
const rolloutFile = (lines: string[]) => {
  const dir = mkdtempSync(path.join(tmpdir(), "sp-codex-"));
  dirs.push(dir);
  mkdirSync(path.join(dir, "sessions"));
  const file = path.join(dir, "sessions", "rollout-2026-10-09T23-47-06-11111111-1111-4111-8111-111111111111.jsonl");
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("a Codex rollout", () => {
  it("knows Codex's own injections from the person's words", () => {
    expect(codexInjected("# AGENTS.md instructions for /workspace\n\n<INSTRUCTIONS>")).toBe(true);
    expect(codexInjected("<environment_context>")).toBe(true);
    expect(codexInjected("fix the AGENTS.md instructions please")).toBe(false);
  });

  it("pairs the person's ask with the answer, not the instructions", () => {
    const read = readCodex(ROLLOUT, 0);
    expect(read.turns.map((t) => [t.user, t.assistant])).toEqual([["what folder are you in?", "/workspace"]]);
  });

  it("titles the session after the first real ask", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sp-codex-"));
    const file = path.join(dir, "rollout-2026-10-04T12-00-00-01a10928-77cd-7080-b626-70eff7eff680.jsonl");
    writeFileSync(file, `${ROLLOUT.join("\n")}\n`);
    expect(codexFacts(file)).toMatchObject({
      cwd: "/workspace",
      title: "what folder are you in?",
      title_source: "first-ask",
    });
    // No session_meta, or one without a cwd: the title still comes, the cwd does not.
    expect(codexFacts(rolloutFile(ROLLOUT.slice(1)))).toEqual({
      title: "what folder are you in?",
      title_source: "first-ask",
      started_at: Date.parse("2026-10-04T12:00:00Z"),
      last_at: Date.parse("2026-10-04T12:00:05Z"),
    });
    const noCwd = JSON.stringify({ type: "session_meta", payload: { cli_version: "0.160.0" } });
    expect(codexFacts(rolloutFile([noCwd, ...ROLLOUT.slice(1)]))).toMatchObject({ harness_version: "0.160.0" });
    expect(codexFacts(rolloutFile([noCwd, ...ROLLOUT.slice(1)])).cwd).toBeUndefined();
  });

  it("keeps the existing non-forked fixture's serialized output byte for byte", () => {
    const file = rolloutFile(ROLLOUT);
    expect(JSON.stringify(readCodex(ROLLOUT, 0))).toBe(
      '{"turns":[{"user":"what folder are you in?","assistant":"/workspace","at":1791115200000,"endLine":4}],"line":5}',
    );
    expect(JSON.stringify(codexFacts(file))).toBe(
      '{"cwd":"/workspace","harness_version":"0.160.0","title":"what folder are you in?","title_source":"first-ask","started_at":1791115200000,"last_at":1791115205000}',
    );
    expect(JSON.stringify(readCodex([...ROLLOUT, ""], 5))).toBe('{"turns":[],"line":5}');
  });
});

// Entirely synthetic: the reported Codex 0.160.0 layout, including a replayed
// parent session_meta, three completed turns and a pending parent prompt.
const FORK = readFileSync(new URL("./fixtures/codex-forked-subagent.jsonl", import.meta.url), "utf8")
  .trimEnd()
  .split("\n");
const CHILD_TURNS = [
  {
    user: "",
    assistant: "I will inspect the sorting code.\n\nThe sorting code handles the synthetic input.",
    at: Date.parse("2026-10-09T23:47:08.000Z"),
    endLine: 44,
  },
];

describe("a forked Codex subagent rollout", () => {
  it("reads only the child's complete reply with its real timestamp and original line numbers", () => {
    const file = rolloutFile(FORK);
    expect(codex.readTranscript!(file, 0)).toEqual({ turns: CHILD_TURNS, line: 46, ended: true });
    // A subagent's rollout is part of its parent's session, so backfill skips it. The
    // same rollout as a fork the person made (no `source.subagent`) is backfilled with
    // the child's own facts, not the parent's.
    expect(codex.backfill!(0, { CODEX_HOME: path.dirname(path.dirname(file)) })).toEqual([]);
    const meta = JSON.parse(FORK[0]!);
    delete meta.payload.source;
    const fork = rolloutFile([JSON.stringify(meta), ...FORK.slice(1)]);
    const rows = codex.backfill!(0, { CODEX_HOME: path.dirname(path.dirname(fork)) });
    expect(rows).toHaveLength(1);
    // The rollout it was read from, for the words a tier-2 backfill sends.
    expect(rows[0]?.transcript).toBe(fork);
    expect(rows[0]?.session).toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      cwd: "/synthetic/child",
      model: "child-model",
    });
  });

  it("does not title the child after the parent's ask or inherit its model", () => {
    const facts = codexFacts(rolloutFile(FORK));
    expect(facts).toEqual({
      cwd: "/synthetic/child",
      harness_version: "0.160.0",
      model: "child-model",
      started_at: Date.parse("2026-10-09T23:47:06.489Z"),
      last_at: Date.parse("2026-10-09T23:47:11.000Z"),
    });
  });

  it("has no boundary without a session_meta, or for a session that is nobody's fork", () => {
    expect(codexReplayBoundary(null)).toBeUndefined();
    expect(codexReplayBoundary({ type: "event_msg" })).toBeUndefined();
    expect(codexReplayBoundary({ type: "session_meta", payload: { id: "x" } })).toBeUndefined();
    expect(
      codexReplayBoundary({ type: "session_meta", payload: { forked_from_id: "p" } })?.({ type: "event_msg" }),
    ).toBe(false);
  });

  it.each(["forked_from_id", "source"])("recognizes a fork using only %s", (key) => {
    const meta = JSON.parse(FORK[0]!);
    delete meta.payload[key === "source" ? "forked_from_id" : "source"];
    expect(readCodex([JSON.stringify(meta), ...FORK.slice(1)], 0)).toEqual({
      turns: CHILD_TURNS,
      line: 46,
      ended: true,
    });
  });

  it("reconstructs the boundary when a saved cursor is inside the parent's replay", () => {
    expect(readCodex(FORK, 12)).toEqual({ turns: CHILD_TURNS, line: 46, ended: true });
    expect(readCodex(FORK, 37)).toEqual({ turns: CHILD_TURNS, line: 46, ended: true });
    expect(readCodex(FORK, 46)).toEqual({ turns: [], line: 46 });
  });

  it("waits for the child's boundary, ignoring events that name the parent", () => {
    const prefix = FORK.slice(0, 37);
    expect(readCodex(prefix, 0)).toEqual({ turns: [], line: 37 });
    expect(codexFacts(rolloutFile(prefix))).toEqual({
      cwd: "/synthetic/child",
      harness_version: "0.160.0",
      started_at: Date.parse("2026-10-09T23:47:06.489Z"),
      last_at: Date.parse("2026-10-09T23:47:06.489Z"),
    });
    expect(readCodex(FORK, 37)).toEqual({ turns: CHILD_TURNS, line: 46, ended: true });
  });

  it("keeps a later real child ask and holds the cursor until its reply arrives", () => {
    const ask = JSON.parse(user("Check synthetic edge cases."));
    ask.timestamp = "2026-10-09T23:48:00.000Z";
    const reply = JSON.parse(assistant("The synthetic edge cases pass."));
    reply.timestamp = "2026-10-09T23:48:05.000Z";
    const pending = [...FORK, JSON.stringify(ask)];
    expect(readCodex(pending, 46)).toEqual({
      turns: [],
      line: 46,
      open: { user: "Check synthetic edge cases.", at: Date.parse("2026-10-09T23:48:00.000Z") },
    });
    const complete = [...pending, JSON.stringify(reply)];
    expect(readCodex(complete, 46)).toEqual({
      turns: [
        {
          user: ask.payload.content[0].text,
          assistant: reply.payload.content[0].text,
          at: Date.parse(ask.timestamp),
          endLine: 47,
        },
      ],
      line: 48,
    });
    expect(codexFacts(rolloutFile(complete))).toMatchObject({
      title: "Check synthetic edge cases.",
      title_source: "first-ask",
    });
  });

  it("does not use a parent title or model when replay exceeds the facts head and tail windows", () => {
    const padding = JSON.stringify({
      type: "event_msg",
      payload: { type: "token_count", padding: "x".repeat(200_000) },
    });
    const prefix = [...FORK.slice(0, 7), padding, ...FORK.slice(7, 37)];
    const facts = codexFacts(rolloutFile(prefix));
    expect(facts.title).toBeUndefined();
    expect(facts.model).toBeUndefined();
    const complete = [...prefix, ...FORK.slice(37)];
    expect(codexFacts(rolloutFile(complete))).toMatchObject({ model: "child-model" });
    expect(codexFacts(rolloutFile(complete)).title).toBeUndefined();
    expect(readCodex(complete, 0)).toEqual({ turns: [{ ...CHILD_TURNS[0], endLine: 45 }], line: 47, ended: true });
  });

  it("keeps current child facts when the boundary falls between the sampled windows", () => {
    const padding = JSON.stringify({
      type: "event_msg",
      payload: { type: "token_count", padding: "x".repeat(200_000) },
    });
    // A line in the gap that is not JSON is skipped by the scan, never mistaken for the boundary.
    const lines = [...FORK.slice(0, 37), padding, "not json", ...FORK.slice(37, 39), padding, ...FORK.slice(39)];
    expect(codexFacts(rolloutFile(lines))).toEqual({
      cwd: "/synthetic/child",
      harness_version: "0.160.0",
      model: "child-model",
      started_at: Date.parse("2026-10-09T23:47:06.489Z"),
      last_at: Date.parse("2026-10-09T23:47:11.000Z"),
    });
  });
});

// A session started or resumed with a picture (`codex exec --image`, recorded on codex-cli
// 0.171.0, 2026-11-19, before its request went out): Codex writes the ask as an
// `<image name=[Image #1] path="…">` line, the picture, `</image>`, then the words.
const PICTURES = fileURLToPath(
  new URL("../../../conformance/transcripts/codex/picture-attached.jsonl", import.meta.url),
);

describe("a Codex rollout whose asks carry pictures (conformance/transcripts/codex/picture-attached.jsonl)", () => {
  it("the title is the person's words, not Codex's wrapper or the picture's path", () => {
    expect(codexFacts(PICTURES)).toMatchObject({
      cwd: "/home/user/my project é",
      harness_version: "0.171.0",
      title: "What single word is written in the picture?",
      title_source: "first-ask",
    });
  });

  it("the transcript's asks are the words alone, start and resume", () => {
    const r = readCodex(readFileSync(PICTURES, "utf8").split("\n"), 0);
    // Both turns failed (the Codex that recorded them was not signed in: its rollout ends
    // each with a `task_complete` that carries the error), so each ask is a turn of its own.
    expect(r.turns.map((t) => [t.user, t.assistant, t.failed])).toEqual([
      ["What single word is written in the picture?", "", true],
      ["And in this one?", "", true],
    ]);
    expect(r.open).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain(".sessionpipe/files");
  });

  it("only Codex's own wrapper lines are dropped, whole", () => {
    expect(codexPictureTag('<image name=[Image #1] path="/w/a b é.png">')).toBe(true);
    expect(codexPictureTag("<image name=[Image #12]>")).toBe(true);
    expect(codexPictureTag("</image>")).toBe(true);
    expect(codexPictureTag("<image>")).toBe(false);
    expect(codexPictureTag('<image name=[Image #1] path="/w/a.png"> what is this?')).toBe(false);
    expect(codexPictureTag(" </image>")).toBe(false);
    expect(codexPictureTag("<image name=[Image one]>")).toBe(false);
    // A person who writes the tag in the middle of their words keeps it.
    expect(codexWords([{ type: "input_text", text: "is </image> a tag?" }])).toBe("is </image> a tag?");
    expect(codexWords("plain words")).toBe("plain words");
    expect(codexWords([{ type: "input_text", text: "</image>" }, { type: "input_image" }, "junk", null])).toBe("");
  });
});

// One thread, recorded on codex-cli 0.171.0 against a stand-in model, 2026-11-24: a turn
// the model's service refused (HTTP 400), a turn the person stopped while a command ran,
// then a turn that finished. Codex fired no Stop hook and no notify for the first.
const FAILED = fileURLToPath(
  new URL("../../../conformance/transcripts/codex/failed-then-interrupted.jsonl", import.meta.url),
);
const T_FAILED = "01a20ea0-fd4b-7f40-b63c-2a1001851908";
const T_STOPPED = "01a20ea1-0a47-78c3-b575-a67507464ad4";
const T_DONE = "01a20ea1-2a75-7012-94ae-2922c00d507e";

describe("a turn that failed and one the person stopped (conformance/transcripts/codex/failed-then-interrupted.jsonl)", () => {
  const lines = readFileSync(FAILED, "utf8").split("\n");

  it("each is a turn of its own, whole as it stands: its prompt never joins the next turn's", () => {
    const r = readCodex(lines, 0);
    expect(r.turns.map(({ at: _at, endLine: _end, ...t }) => t)).toEqual([
      { user: "Why did the build fail?", assistant: "", failed: true },
      { user: "RUN: sleep 30\nSAY: never said", assistant: "", interrupted: true },
      { user: "RUN: echo fine\nSAY: The build is fine now.", assistant: "The build is fine now." },
    ]);
    expect(r.open).toBeUndefined();
    expect(r.ended).toBe(true);
  });

  it("read up to the failed turn's end, the file says its last turn is over and holds no open prompt", () => {
    const failedAt = lines.findIndex((l) => l.includes('"task_complete"'));
    const r = readCodex(lines.slice(0, failedAt + 1), 0);
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0]).toMatchObject({ user: "Why did the build fail?", failed: true, endLine: failedAt });
    expect(r.ended).toBe(true);
    // Before that line the prompt is a turn that just began.
    expect(readCodex(lines.slice(0, failedAt), 0)).toMatchObject({
      turns: [],
      open: { user: "Why did the build fail?" },
    });
    // Stopped: the same, at `turn_aborted`.
    const stoppedAt = lines.findIndex((l) => l.includes('"turn_aborted"'));
    expect(readCodex(lines.slice(0, stoppedAt + 1), 0).turns.at(-1)).toMatchObject({ interrupted: true });
    expect(readCodex(lines.slice(0, stoppedAt + 1), 0).ended).toBe(true);
  });

  it("an end record of a task that is not the person's turn cuts nothing", () => {
    const row = (type: string, payload: Record<string, unknown>) => JSON.stringify({ type, payload });
    const says = (role: string, text: string) =>
      row("response_item", {
        type: "message",
        role,
        content: [{ type: role === "user" ? "input_text" : "output_text", text }],
      });
    const r = readCodex(
      [
        says("user", "a"),
        says("assistant", "x"),
        row("event_msg", { type: "task_complete", turn_id: "t1", last_agent_message: "x" }),
        // Codex's own tasks end the same way: a compaction that failed, a review that was stopped.
        row("event_msg", { type: "task_complete", turn_id: "c1", error: { message: "m", codex_error_info: "other" } }),
        row("event_msg", { type: "turn_aborted", turn_id: "c2", reason: "replaced" }),
      ],
      0,
    );
    expect(r.turns.map(({ at: _at, endLine: _end, ...t }) => t)).toEqual([{ user: "a", assistant: "x" }]);
    expect(r.ended).toBe(true);
  });

  it("how each turn ended, by the id its hooks gave: the error's class, never its message", () => {
    expect(codex.turnEnd?.(FAILED, T_FAILED)).toEqual({ reason: "error", error: "other" });
    expect(codex.turnEnd?.(FAILED, T_STOPPED)).toEqual({ reason: "interrupt" });
    expect(codex.turnEnd?.(FAILED, T_DONE)).toEqual({ reason: "stop" });
    expect(codex.turnEnd?.(FAILED, "01a20ea0-0000-7000-8000-000000000000")).toBeNull();
    expect(JSON.stringify(codex.turnEnd?.(FAILED, T_FAILED))).not.toContain("refused");
  });
});

// One turn of four commands, recorded on codex-cli 0.171.0 against a stand-in model,
// 2026-11-24: a command that fails, one that works, one with a long output that exits 3,
// and one the sandbox refused. Codex's PostToolUse hook gave each command's output and
// nothing of how it exited.
const EXITS = fileURLToPath(new URL("../../../conformance/transcripts/codex/command-exits.jsonl", import.meta.url));

describe("how a command exited (conformance/transcripts/codex/command-exits.jsonl)", () => {
  it("each call's result, by the id its hook gave", () => {
    expect(codex.toolResult?.(EXITS, "call_70")).toEqual({ ok: false, error: "exit 1" });
    expect(codex.toolResult?.(EXITS, "call_71")).toEqual({ ok: true });
    expect(codex.toolResult?.(EXITS, "call_72")).toEqual({ ok: false, error: "exit 3" });
    expect(codex.toolResult?.(EXITS, "call_73")).toEqual({ ok: false, error: "exit 1" });
    // A call the file does not hold, and an id that is only the start of another's: nothing to read.
    expect(codex.toolResult?.(EXITS, "call_74")).toEqual({});
    expect(codex.toolResult?.(EXITS, "call_7")).toEqual({});
  });
});

// One turn, recorded on codex-cli 0.171.0 against a stand-in model, 2026-11-24: its Stop
// hook (sessionpipe's own, asking a stand-in daemon) was answered with a message for the
// session, and Codex went on with it in the same turn.
const STOP_BLOCK = fileURLToPath(new URL("../../../conformance/transcripts/codex/stop-block.jsonl", import.meta.url));

describe("a message handed over at a Stop (conformance/transcripts/codex/stop-block.jsonl)", () => {
  const lines = readFileSync(STOP_BLOCK, "utf8").split("\n");
  const part = (text: string) => [{ type: "input_text", text }];
  const by = (type: string) => ({ content_item_metadata: [{ provenance: { type } }] });

  it("is a turn of its own: the person's words as they sent them, and the answer to them", () => {
    const r = readCodex(lines, 0);
    expect(r.turns.map(({ at: _at, endLine: _end, ...t }) => t)).toEqual([
      { user: "RUN: echo first\nSAY: The first answer.", assistant: "The first answer." },
      { user: `Is 2 < 3 && "ok" > 'no'? Say why & how.`, assistant: "done", injected: true },
    ]);
    expect(r.ended).toBe(true);
    // Nothing of Codex's wrapper or sessionpipe's frame is the person's words.
    expect(JSON.stringify(r)).not.toMatch(/hook_prompt|Message via|sent back to them/);
    // The title is the first thing the person asked, not the message.
    expect(codexFacts(STOP_BLOCK).title).toBe("RUN: echo first");
  });

  it("while the turn goes on, the file says its last turn is still growing, and where it starts", () => {
    const at = lines.findIndex((l) => l.includes("hook_prompt"));
    const done = lines.findIndex((l) => l.includes('"task_complete"'));
    // Read as the first Stop's worker may find it: the message taken, half an answer written.
    const mid = readCodex(lines.slice(0, done), 0);
    expect(mid.turns).toHaveLength(2);
    expect(mid.growing).toEqual({ start: at });
    expect(mid.ended).toBeUndefined();
    expect(mid.tail).toBeUndefined();
    // Before the message's row, the turn's first words are the growing one.
    expect(readCodex(lines.slice(0, at), 0).growing).toEqual({
      start: lines.findIndex((l) => l.includes("RUN: echo first")),
    });
    // From a cursor inside the turn (the turns before it are sent) it is told all the same.
    expect(readCodex(lines.slice(0, done), at)).toMatchObject({ turns: [{ injected: true }], growing: { start: at } });
    // Over: nothing grows. Nothing of a turn read yet: nothing to hold.
    expect(readCodex(lines, 0).growing).toBeUndefined();
    expect(readCodex(lines, at).growing).toBeUndefined();
    expect(readCodex(lines.slice(0, 5), 0).growing).toBeUndefined();
    // A turn that is over is never the growing one, whatever began after it: the person's
    // next prompt, queued in the window, starts a turn of its own within milliseconds.
    const next = [
      ...lines.slice(0, done + 1),
      JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "t2" } }),
      JSON.stringify({
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "and then?" }] },
      }),
    ];
    expect(readCodex(next, 0)).toMatchObject({ open: { user: "and then?" } });
    expect(readCodex(next, 0).growing).toBeUndefined();
    // A rollout with no start records at all (an older Codex) says nothing of it.
    const old = lines.slice(0, done).filter((l) => !l.includes('"task_started"'));
    expect(readCodex(old, 0).growing).toBeUndefined();
  });

  it("codexHookPrompts: a hook's reasons as the hook gave them, and nothing for any other message", () => {
    const wrap = (reason: string, id = "stop:10:/h/hooks.json") =>
      `<hook_prompt hook_run_id="${id}">${reason}</hook_prompt>`;
    expect(
      codexHookPrompts({ content: part(wrap("a &lt; b &amp;&amp; c &gt; d &quot;e&quot; &apos;f&apos; &amp;lt;")) }),
    ).toEqual([`a < b && c > d "e" 'f' &lt;`]);
    // One part per hook that blocked; Codex says the message is its own.
    expect(
      codexHookPrompts({
        content: [...part(wrap("one")), ...part(` ${wrap("two\nlines", "stop:11:/h/hooks.json")}\n`)],
        internal_chat_message_metadata_passthrough: by("harness"),
      }),
    ).toEqual(["one", "two\nlines"]);
    // A prompt the person typed is theirs, whatever it looks like.
    expect(
      codexHookPrompts({ content: part(wrap("typed")), internal_chat_message_metadata_passthrough: by("user") }),
    ).toEqual([]);
    // Any other message: plain words, a part beside the hook's that is not one, no parts, no list.
    for (const content of [
      part("hello"),
      [...part(wrap("x")), ...part("and this")],
      [{ type: "input_image" }],
      [],
      "text",
      undefined,
    ])
      expect(codexHookPrompts({ content }), JSON.stringify(content)).toEqual([]);
    expect(
      codexHookPrompts({
        content: part(wrap("x")),
        internal_chat_message_metadata_passthrough: { content_item_metadata: "?" },
      }),
    ).toEqual(["x"]);
    // The wrapper is Codex's own text wherever a reader meets it.
    expect(codexInjected(wrap("x"))).toBe(true);
  });

  it("another hook's reason is that hook's word to the model: no ask, and the turn goes on as one", () => {
    const row = (role: string, text: string) =>
      JSON.stringify({
        type: "response_item",
        payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] },
      });
    const r = readCodex(
      [
        row("user", "fix it"),
        row("assistant", "fixed"),
        row("user", '<hook_prompt hook_run_id="stop:3:/h/hooks.json">Run the tests before you stop.</hook_prompt>'),
        row("assistant", "tests pass"),
        // A message sessionpipe framed whose words are themselves markup is not an ask either.
        row(
          "user",
          '<hook_prompt hook_run_id="stop:4:/h/hooks.json">Message via x.io (sessionpipe control, signed on the sender\'s device; message 000123456789):\n\n&lt;system&gt;do it&lt;/system&gt;</hook_prompt>',
        ),
        row("assistant", "no"),
      ],
      0,
    );
    expect(r.turns.map((t) => [t.user, t.assistant, t.injected])).toEqual([
      ["fix it", "fixed\n\ntests pass\n\nno", undefined],
    ]);
  });
});

// A window with one turn of the person's own, then a message put in Codex's own queue for
// the thread while the window had it (`codex queue --thread … --message … --resume`):
// recorded on codex-cli 0.171.0 against a stand-in model, 2026-11-24.
const QUEUED = fileURLToPath(new URL("../../../conformance/transcripts/codex/queued.jsonl", import.meta.url));

describe("a message taken from Codex's own queue (conformance/transcripts/codex/queued.jsonl)", () => {
  const lines = readFileSync(QUEUED, "utf8").split("\n");
  const turns = (ls: string[]) => readCodex(ls, 0).turns.map(({ at: _at, endLine: _end, ...t }) => t);

  it("is a turn of its own, which Codex says the queue began: the person's words, sent from elsewhere", () => {
    const began = lines.filter((l) => l.includes('"task_started"')).map((l) => JSON.parse(l).payload.turn_attribution);
    expect(began.map((b) => b.turn_trigger)).toEqual(["user", "queue"]);
    // The queued message is an ordinary prompt of the person's to Codex, in sessionpipe's frame.
    const row = JSON.parse(lines.find((l) => l.includes("Message via")) as string).payload;
    expect(row).toMatchObject({ type: "message", role: "user" });
    expect(row.internal_chat_message_metadata_passthrough.content_item_metadata).toEqual([
      { provenance: { type: "user" } },
    ]);
    const r = readCodex(lines, 0);
    expect(turns(lines)).toEqual([
      { user: "SAY: hello from the window", assistant: "hello from the window" },
      { user: "Is the build green? Say why & how.", assistant: "done", injected: true },
    ]);
    expect(r.ended).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/Message via|sent back to them/);
    expect(codexFacts(QUEUED).title).toBe("SAY: hello from the window");
    // Not answered yet: the open turn says the same of its ask.
    const at = lines.findIndex((l) => l.includes("Message via"));
    expect(readCodex(lines.slice(0, at + 1), 0).open).toMatchObject({
      user: "Is the build green? Say why & how.",
      injected: true,
    });
  });

  it("the same frame as the prompt of a headless turn is that turn's own ask, without the frame", () => {
    // What a `codex exec resume` the daemon runs is given (the `resume` mode).
    const headless = lines.map((l) => l.replace('"turn_trigger":"queue"', '"turn_trigger":"exec"'));
    expect(headless).not.toEqual(lines);
    expect(turns(headless)[1]).toEqual({ user: "Is the build green? Say why & how.", assistant: "done" });
    // A rollout from before Codex said what began a turn.
    const old = lines.filter((l) => !l.includes('"task_started"'));
    expect(turns(old)[1]).toEqual({ user: "Is the build green? Say why & how.", assistant: "done" });
  });

  it("a frame around words that are nobody's ask opens no turn; words in no frame are kept as typed", () => {
    const at = lines.findIndex((l) => l.includes("Message via"));
    const framed = JSON.parse(lines[at] as string);
    const text = framed.payload.content[0].text as string;
    const withWords = (words: string) => {
      const row = structuredClone(framed);
      row.payload.content[0].text = words;
      return [...lines.slice(0, at), JSON.stringify(row), ...lines.slice(at + 1)];
    };
    // A harness's own notification inside the frame: the readers skip it wherever it is.
    const note = text.replace("Is the build green? Say why & how.", "<task-notification>done</task-notification>");
    expect(note).not.toBe(text);
    expect(turns(withWords(note))).toEqual([
      { user: "SAY: hello from the window", assistant: "hello from the window\n\ndone" },
    ]);
    // Typed into the window while it took its queue: the person's own turn, as written.
    expect(turns(withWords("message 000123456789 was mine"))[1]).toEqual({
      user: "message 000123456789 was mine",
      assistant: "done",
    });
  });
});
