// SPDX-License-Identifier: Apache-2.0
// A finished turn reaches a tier-2 sink when it ends, not when the next one does.
// Claude Code queues its transcript writes and flushes them on a 100 ms timer, and a
// terminal session's Stop hook fires within tens of milliseconds of the last message: on
// 2.1.322 the worker read the file 90 to 135 ms after the turn's last row was made and
// found it in 1 turn end of 9 (2026-11-10). The other 8 turns reached the receiver when
// the next turn ended, or when the session did. The Stop names the turn's last words
// (`last_assistant_message`), so the worker waits for the file to hold them; and a turn
// the person interrupted, which no hook ends, is told from the file at the next hook.
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Event, Outbox, takeLock } from "@sessionpipe/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Clock,
  closedTurns,
  factsState,
  openTurn,
  runJob,
  SETTLE_FAST_MS,
  SETTLE_MS,
  SETTLE_POLL_MS,
  wordsDigest,
} from "../src/run.js";

// A terminal session recorded on 2.1.322: a turn with a tool call ("SIX"), a turn of one
// word ("SEVEN"), and a turn stopped with Esc while its tool ran.
const ROWS = readFileSync(
  new URL("../../../conformance/transcripts/claude-code/interrupted-turn.jsonl", import.meta.url),
  "utf8",
)
  .trimEnd()
  .split("\n");
const ASK_SIX = "Run `sleep 6` in bash, then reply with only the word SIX.";
const ASK_SEVEN = "Reply with only the word SEVEN.";
const ASK_PING = "Run `ping -c 30 127.0.0.1` in bash, then reply with only the word PINGI.";
const SID = "00000000-0000-4000-8000-000000000003";
const ref = { harness: "claude-code", session: SID };
const T0 = Date.parse("2026-11-10T17:19:24.000Z");
const FAST = SETTLE_FAST_MS / 25;

let tmp: string;
let transcript: string;
let out: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "sp-settle-"));
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

/** Rows `from` to `to` of the recording reach the file, as a flush of Claude Code's queue does. */
const flush = (from: number, to: number) =>
  appendFileSync(
    transcript,
    ROWS.slice(from, to)
      .map((l) => `${l}\n`)
      .join(""),
  );
const job = (event: string, extra: Record<string, unknown> = {}, at = T0) => ({
  harness: "claude-code",
  event,
  argv: ["claude-code", event],
  stdin: JSON.stringify({ session_id: SID, cwd: tmp, hook_event_name: event, transcript_path: transcript, ...extra }),
  cwd: tmp,
  env: { CLAUDE_CONFIG_DIR: tmp },
  at,
});
const stop = (words: string | undefined, id: string, at = T0) =>
  job("Stop", { prompt_id: id, ...(words === undefined ? {} : { last_assistant_message: words }) }, at);
const lines = (file: string): Event[] =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
const sent = () => lines(out);
const stored = () => lines(new Outbox(tmp).file(ref));
const turns = (events: Event[]) => events.filter((e) => e.type === "turn.transcript").map((e) => e.data);
const types = (events: Event[]) => events.map((e) => e.type);
const facts = () => factsState(tmp).get("claude-code", SID);
const logged = () => readFileSync(path.join(tmp, "log"), "utf8");

/** A clock that only moves when the worker waits; `at(n)` runs as its n-th wait ends. */
function waits(at: (n: number) => void | Promise<void> = () => {}) {
  let now = T0;
  const slept: number[] = [];
  const clock: Clock = {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
      slept.push(ms);
      await at(slept.length);
    },
  };
  return { clock, slept };
}

describe("a turn's words, when its Stop comes before its last row is in the transcript", () => {
  it("go out with the turn's end once the row lands, and the next turn's with its own", async () => {
    await runJob(job("SessionStart", { source: "startup" }), { state: tmp });
    await runJob(job("UserPromptSubmit", { prompt: ASK_SIX, prompt_id: "id2" }), { state: tmp });
    flush(0, 3); // the prompt, the tool call and its result: all the file holds as the Stop fires
    const w = waits((n) => {
      if (n === 2) flush(3, 6);
    });
    const r = await runJob(stop("SIX", "id2"), { state: tmp, clock: w.clock });
    expect(types(r.events)).toEqual(["turn.ended", "turn.transcript"]);
    expect(w.slept).toEqual([25, 25]);
    expect(turns(r.events)).toEqual([{ turn: 0, user: ASK_SIX, assistant: "SIX", at: "2026-11-10T17:19:24.018Z" }]);
    // One append, adjacent seqs: nothing of the session can come between the end and the words.
    const [ended, said] = stored().slice(-2) as [Event, Event];
    expect([ended.type, said.type]).toEqual(["turn.ended", "turn.transcript"]);
    expect(said.session.seq).toBe(ended.session.seq + 1);
    expect(r.delivered).toEqual({ f: 2 });
    expect(facts().transcript_due ?? null).toBeNull();

    // The next turn: its row is in the file by the time its Stop's worker reads, so no wait.
    flush(6, 7);
    await runJob(job("UserPromptSubmit", { prompt: ASK_SEVEN, prompt_id: "id11" }), { state: tmp });
    flush(7, 10);
    const w2 = waits();
    const r2 = await runJob(stop("SEVEN", "id11"), { state: tmp, clock: w2.clock });
    expect(w2.slept).toEqual([]);
    expect(turns(r2.events)).toEqual([
      { turn: 1, user: ASK_SEVEN, assistant: "SEVEN", at: "2026-11-10T17:22:27.052Z" },
    ]);
    // Each turn once, in order, each right after its own end.
    expect(types(sent()).filter((t) => t === "turn.ended" || t === "turn.transcript")).toEqual([
      "turn.ended",
      "turn.transcript",
      "turn.ended",
      "turn.transcript",
    ]);
  });

  it("are never sent in halves: what the turn said before its last row waits with it", async () => {
    const said = (text: string) =>
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-11-10T17:19:30.000Z",
        message: { content: [{ type: "text", text }] },
      });
    flush(0, 1);
    appendFileSync(transcript, `${said("Running it now.")}\n`);
    flush(1, 3);
    const seen: unknown[] = [];
    const w = waits((n) => {
      seen.push(facts().transcript_line ?? null);
      if (n === 3) flush(3, 4);
    });
    const r = await runJob(stop("SIX", "id2"), { state: tmp, clock: w.clock });
    expect(turns(r.events)).toEqual([
      { turn: 0, user: ASK_SIX, assistant: "Running it now.\n\nSIX", at: "2026-11-10T17:19:24.018Z" },
    ]);
    // While it waited the cursor stood still: the half was neither sent nor passed.
    expect(seen).toEqual([null, null, null]);
    expect(turns(stored())).toHaveLength(1);
  });

  it("follow the turn's end, which is not held back, when the row is slower than the short wait", async () => {
    flush(0, 3);
    const atPoll: string[][] = [];
    const w = waits((n) => {
      if (n === FAST + 1) atPoll.push(types(sent()));
      if (n === FAST + 3) flush(3, 6);
    });
    const r = await runJob(stop("SIX", "id2"), { state: tmp, clock: w.clock });
    expect(w.slept).toEqual([...Array(FAST).fill(25), SETTLE_POLL_MS, SETTLE_POLL_MS, SETTLE_POLL_MS]);
    // The state change reached the sink before the words did.
    expect(atPoll).toEqual([["turn.ended"]]);
    expect(types(r.events)).toEqual(["turn.ended", "turn.transcript"]);
    expect(types(sent())).toEqual(["turn.ended", "turn.transcript"]);
    expect(r.delivered).toEqual({ f: 2 });
    expect(turns(sent())).toEqual([{ turn: 0, user: ASK_SIX, assistant: "SIX", at: "2026-11-10T17:19:24.018Z" }]);
    expect(facts().transcript_due).toBeNull();
    expect(logged()).toMatch(/claude-code Stop: turn\.transcript, once the transcript held it \([0-9a-f]{8}\)/);
  });

  it("are left for the session's next hook when the row is not there in SETTLE_MS, and sent once", async () => {
    flush(0, 3);
    const w = waits();
    const r = await runJob(stop("SIX", "id2"), { state: tmp, clock: w.clock });
    expect(w.slept).toHaveLength(FAST + SETTLE_MS / SETTLE_POLL_MS);
    expect(types(r.events)).toEqual(["turn.ended"]);
    expect(facts()).toMatchObject({ transcript_due: wordsDigest("SIX"), transcript_due_at: T0 });
    expect(logged()).toContain(
      "claude-code Stop: the turn's last words are not in the transcript 5 s on; its turn.transcript waits for the session's next hook",
    );
    // A tool event of a subagent does not look; the next event that is not one does, first.
    flush(3, 6);
    const tool = await runJob(
      job("PostToolUse", { tool_name: "Bash", tool_input: {}, tool_response: "ok", tool_use_id: "t1", agent_id: "a1" }),
      { state: tmp },
    );
    expect(types(tool.events)).not.toContain("turn.transcript");
    const idle = await runJob(job("Notification", { notification_type: "idle_prompt" }, T0 + 30_000), { state: tmp });
    expect(types(idle.events)).toEqual(["turn.transcript", "attention.needed"]);
    expect(facts().transcript_due).toBeNull();
    // Nothing is sent twice: not at the next prompt, not at the next turn's end.
    flush(6, 7);
    const next = await runJob(job("UserPromptSubmit", { prompt: ASK_SEVEN, prompt_id: "id11" }), { state: tmp });
    expect(types(next.events)).toEqual(["turn.started", "turn.progress"]);
    flush(7, 10);
    await runJob(stop("SEVEN", "id11"), { state: tmp, clock: waits().clock });
    expect(turns(stored()).map((t) => [t.turn, t.assistant])).toEqual([
      [0, "SIX"],
      [1, "SEVEN"],
    ]);
  });

  it("stop being looked for a minute on; the turn then goes when a later prompt has closed it", async () => {
    flush(0, 3);
    await runJob(stop("SIX", "id2"), { state: tmp, clock: waits().clock, deadline: T0 });
    flush(3, 7);
    const late = await runJob(job("Notification", { notification_type: "idle_prompt" }, T0 + 60_000), { state: tmp });
    expect(types(late.events)).toEqual(["attention.needed"]);
    flush(7, 10);
    const r = await runJob(stop("SEVEN", "id11", T0 + 61_000), { state: tmp, clock: waits().clock });
    expect(turns(r.events).map((t) => [t.turn, t.assistant])).toEqual([
      [0, "SIX"],
      [1, "SEVEN"],
    ]);
    expect(facts().transcript_due).toBeNull();
  });

  it("a later prompt closes a turn whose named words never come; the wait passes to the next end", async () => {
    flush(0, 4);
    // The Stop names words the file will never hold (a reader and a harness that disagree).
    const r = await runJob(stop("six", "id2"), { state: tmp, clock: waits().clock, deadline: T0 });
    expect(types(r.events)).toEqual(["turn.ended"]);
    flush(4, 7);
    const next = await runJob(job("UserPromptSubmit", { prompt: ASK_SEVEN, prompt_id: "id11" }), { state: tmp });
    expect(types(next.events)).toEqual(["turn.transcript", "turn.started", "turn.progress"]);
    expect(turns(next.events)[0]).toMatchObject({ turn: 0, assistant: "SIX" });
    expect(next.events[2]?.data).toMatchObject({ turn: 1, user: ASK_SEVEN });
    expect(facts().transcript_due).toBe(wordsDigest("six"));
    flush(7, 10);
    const end = await runJob(stop("SEVEN", "id11"), { state: tmp, clock: waits().clock });
    expect(turns(end.events)).toMatchObject([{ turn: 1, assistant: "SEVEN" }]);
    expect(facts().transcript_due).toBeNull();
  });

  it("when another hook of the session finds them first, the waiting worker sends nothing more", async () => {
    flush(0, 3);
    const w = waits(async (n) => {
      if (n !== FAST + 2) return;
      flush(3, 6);
      const sibling = await runJob(job("Notification", { notification_type: "idle_prompt" }), { state: tmp });
      expect(types(sibling.events)).toEqual(["turn.transcript", "attention.needed"]);
    });
    const r = await runJob(stop("SIX", "id2"), { state: tmp, clock: w.clock });
    expect(w.slept).toHaveLength(FAST + 2);
    expect(types(r.events)).toEqual(["turn.ended"]);
    expect(turns(stored())).toHaveLength(1);
    expect(logged()).not.toContain("not in the transcript");
  });

  it("a round in which a sibling hook holds the session is skipped, not lost", async () => {
    flush(0, 3);
    let held: (() => void) | null = null;
    const w = waits((n) => {
      if (n === FAST + 1) {
        flush(3, 6);
        held = takeLock(tmp, ref);
      }
      if (n === FAST + 2) held?.();
    });
    const r = await runJob(stop("SIX", "id2"), { state: tmp, clock: w.clock });
    expect(held).not.toBeNull();
    expect(w.slept).toHaveLength(FAST + 2);
    expect(types(r.events)).toEqual(["turn.ended", "turn.transcript"]);
  });

  it("an earlier turn a later prompt closed goes at once; only the turn that just ended waits", async () => {
    // Both turns are new to the sink (it was added mid-session): SIX is whole, SEVEN's row is late.
    flush(0, 7);
    const w = waits((n) => {
      if (n === FAST + 1) flush(7, 8);
    });
    const r = await runJob(stop("SEVEN", "id11"), { state: tmp, clock: w.clock });
    expect(types(r.events)).toEqual(["turn.ended", "turn.transcript", "turn.transcript"]);
    expect(types(stored().slice(0, 2))).toEqual(["turn.ended", "turn.transcript"]);
    expect(turns(r.events).map((t) => [t.turn, t.assistant])).toEqual([
      [0, "SIX"],
      [1, "SEVEN"],
    ]);
  });

  it("a worker near its end does not start the long wait, and a swept job does not wait at all", async () => {
    flush(0, 3);
    const w = waits();
    // 3 s is what a pass of the drain needs: with less left, the words are the next hook's.
    const r = await runJob(stop("SIX", "id2"), { state: tmp, clock: w.clock, deadline: T0 + SETTLE_FAST_MS + 3000 });
    expect(w.slept).toHaveLength(FAST);
    expect(types(r.events)).toEqual(["turn.ended"]);
    expect(logged()).toContain("waits for the session's next hook");

    const swept = waits();
    const s = await runJob(stop("SIX", "id2"), { state: tmp, clock: swept.clock, drain: false });
    expect(swept.slept).toEqual([]);
    expect(types(s.events)).toEqual(["turn.ended"]);
    expect(facts().transcript_due).toBe(wordsDigest("SIX"));
  });

  // A session's end fires within milliseconds of a headless run's Stop (37 ms apart in a
  // recorded run), and either hook's worker may take the session's lock first. When the
  // end's did, it sent every turn; the Stop then waited 417 ms under the lock and 5 s more
  // for words that had already gone out, and left the turn marked as waiting.
  it("a Stop whose turn a sibling hook's worker has already sent does not wait, and marks nothing", async () => {
    await runJob(job("SessionStart", { source: "startup" }), { state: tmp });
    await runJob(job("UserPromptSubmit", { prompt: ASK_SIX, prompt_id: "id2" }), { state: tmp });
    flush(0, 6);
    const end = await runJob(job("SessionEnd", { reason: "other" }), { state: tmp });
    expect(types(end.events)).toEqual(["session.ended", "turn.transcript"]);
    expect(facts().transcript_sent).toBe(`id2:${wordsDigest("SIX")}`);
    const w = waits();
    const late = await runJob(stop("SIX", "id2"), { state: tmp, clock: w.clock });
    expect(w.slept).toEqual([]);
    expect(types(late.events)).toEqual(["turn.ended"]);
    expect(facts().transcript_due ?? null).toBeNull();
    expect(turns(stored())).toHaveLength(1);
    expect(logged()).not.toContain("not in the transcript");
  });

  it("the same words under the same prompt id are waited for when the file holds more of that prompt", async () => {
    // A message a Stop hook delivered continues the turn under its prompt id, and its
    // reply can be the very words the turn ended on before.
    const row = (o: object) =>
      appendFileSync(transcript, `${JSON.stringify({ timestamp: "2026-11-10T17:00:00.000Z", ...o })}\n`);
    const said = (text: string) => row({ type: "assistant", message: { content: [{ type: "text", text }] } });
    row({ type: "user", promptId: "p1", message: { content: "Is it merged?" } });
    said("Yes.");
    await runJob(stop("Yes.", "p1"), { state: tmp, clock: waits().clock });
    expect(facts().transcript_sent).toBe(`p1:${wordsDigest("Yes.")}`);
    row({
      type: "user",
      isMeta: true,
      promptId: "p1",
      message: {
        content:
          "Stop hook feedback:\nMessage via localhost:8791 (sessionpipe control, signed on the sender's device):\n\nAnd deployed?",
      },
    });
    const w = waits((n) => {
      if (n === 2) said("Yes.");
    });
    const r = await runJob(stop("Yes.", "p1"), { state: tmp, clock: w.clock });
    expect(w.slept).toEqual([25, 25]);
    expect(turns(r.events)).toMatchObject([{ turn: 1, user: "And deployed?", assistant: "Yes.", injected: true }]);
  });

  it("a prompt after the cursor that names no id could be the turn's own: the wait stands", async () => {
    flush(0, 6);
    await runJob(job("SessionEnd", { reason: "other" }), { state: tmp });
    // A message the person sent mid-turn is recorded without a prompt id.
    appendFileSync(
      transcript,
      `${JSON.stringify({ type: "attachment", timestamp: "2026-11-10T17:20:00.000Z", attachment: { type: "queued_command", prompt: "and then?" } })}\n`,
    );
    const w = waits();
    await runJob(stop("SIX", "id2"), { state: tmp, clock: w.clock, deadline: T0 });
    expect(w.slept).toHaveLength(FAST);
    expect(facts().transcript_due).toBe(wordsDigest("SIX"));
    // One that names another prompt is a later turn's: this one has gone out.
    const next = waits();
    flush(6, 7);
    writeFileSync(
      transcript,
      readFileSync(transcript, "utf8")
        .split("\n")
        .filter((l) => !l.includes("queued_command"))
        .join("\n"),
    );
    await runJob(stop("SIX", "id2"), { state: tmp, clock: next.clock });
    expect(next.slept).toEqual([]);
    expect(facts().transcript_due).toBeNull();
  });

  // Two hooks fired close together are handled in the order their workers reach the
  // session's lock. The next prompt's may be first: it must not send the turn before the
  // turn's own Stop has said it ended.
  it("the next prompt's worker, running first, leaves the turn to its own Stop", async () => {
    await runJob(job("SessionStart", { source: "startup" }), { state: tmp });
    await runJob(job("UserPromptSubmit", { prompt: ASK_SIX, prompt_id: "id2" }), { state: tmp });
    flush(0, 7); // the whole turn, and the next prompt
    const next = await runJob(job("UserPromptSubmit", { prompt: ASK_SEVEN, prompt_id: "id11" }), { state: tmp });
    expect(types(next.events)).toEqual(["turn.started", "turn.progress"]);
    // The running turn is still numbered after the one not sent yet.
    expect(next.events[1]?.data).toMatchObject({ turn: 1, user: ASK_SEVEN });
    const w = waits();
    const late = await runJob(stop("SIX", "id2"), { state: tmp, clock: w.clock });
    expect(w.slept).toEqual([]);
    expect(types(late.events)).toEqual(["turn.ended", "turn.transcript"]);
    expect(turns(late.events)).toMatchObject([{ turn: 0, assistant: "SIX" }]);
  });

  it("and sends the turns before it that are closed, the cursor after the last one sent", async () => {
    // Nothing of the session has been sent (the sink is new); SEVEN is the turn the hooks hold.
    await runJob(job("UserPromptSubmit", { prompt: ASK_SEVEN, prompt_id: "id11" }), { state: tmp });
    writeFileSync(out, "");
    flush(0, 11);
    const next = await runJob(job("UserPromptSubmit", { prompt: ASK_PING, prompt_id: "id18" }), { state: tmp });
    expect(types(next.events)).toEqual(["turn.transcript", "turn.started", "turn.progress"]);
    expect(turns(next.events)).toMatchObject([{ turn: 0, assistant: "SIX" }]);
    expect(facts().transcript_line).toBe(4);
    expect(next.events[2]?.data).toMatchObject({ turn: 2, user: ASK_PING });
    const late = await runJob(stop("SEVEN", "id11"), { state: tmp, clock: waits().clock });
    expect(types(late.events)).toEqual(["turn.ended", "turn.transcript"]);
    expect(turns(stored()).map((t) => [t.turn, t.assistant])).toEqual([
      [0, "SIX"],
      [1, "SEVEN"],
    ]);
  });

  // The budgets are counted in ticks that only go forward. Counted by the wall clock, a
  // clock set back mid-wait kept the loop going until the worker's 15 s exit.
  it("a wall clock set back during the wait does not lengthen it", async () => {
    flush(0, 3);
    let wall = T0;
    let ticks = 0;
    const slept: number[] = [];
    const clock: Clock = {
      now: () => wall,
      ticks: () => ticks,
      sleep: async (ms) => {
        ticks += ms;
        wall -= 60_000; // an hour's correction, a minute a wait
        slept.push(ms);
      },
    };
    const r = await runJob(stop("SIX", "id2"), { state: tmp, clock });
    expect(slept).toHaveLength(FAST + SETTLE_MS / SETTLE_POLL_MS);
    expect(types(r.events)).toEqual(["turn.ended"]);
  });

  it("with the worker's own clock: the words land in real time and go with the turn's end", async () => {
    flush(0, 3);
    setTimeout(() => flush(3, 6), 40);
    const started = performance.now();
    const r = await runJob(stop("SIX", "id2"), { state: tmp });
    expect(types(r.events)).toEqual(["turn.ended", "turn.transcript"]);
    expect(performance.now() - started).toBeLessThan(SETTLE_FAST_MS + 2000);
  });

  it("a Stop that names no words, or a transcript that is not there, is read once as before", async () => {
    flush(0, 1);
    appendFileSync(
      transcript,
      `${JSON.stringify({ type: "assistant", timestamp: "2026-11-10T17:19:30.000Z", message: { content: [{ type: "text", text: "So far." }] } })}\n`,
    );
    const w = waits();
    const r = await runJob(stop(undefined, "id2"), { state: tmp, clock: w.clock });
    expect(w.slept).toEqual([]);
    expect(turns(r.events)).toMatchObject([{ turn: 0, user: ASK_SIX, assistant: "So far." }]);
    expect("transcript_due" in facts()).toBe(false);

    const none = await runJob(
      job("Stop", { last_assistant_message: "SIX", transcript_path: path.join(tmp, "gone.jsonl") }),
      { state: tmp, clock: w.clock },
    );
    expect(w.slept).toEqual([]);
    expect(types(none.events)).toEqual(["turn.ended"]);
  });
});

describe("a turn the person interrupted", () => {
  // Esc while the tool ran: Claude Code fires no Stop, and writes its marker in the transcript.
  const interrupted = async () => {
    await runJob(job("SessionStart", { source: "startup" }), { state: tmp });
    flush(10, 11);
    await runJob(job("UserPromptSubmit", { prompt: ASK_PING, prompt_id: "id18" }), { state: tmp });
    flush(11, 14);
    expect(facts().open_turn).toBe("id18");
  };
  const PING_TURN = { turn: 0, user: ASK_PING, assistant: "", at: "2026-11-10T17:31:34.318Z" };

  it("is ended and sent as a turn at the next prompt, before that prompt's own events", async () => {
    await interrupted();
    const r = await runJob(job("UserPromptSubmit", { prompt: "try again", prompt_id: "p2" }), { state: tmp });
    expect(types(r.events)).toEqual(["turn.ended", "turn.transcript", "turn.started", "turn.progress"]);
    expect(r.events[0]?.data).toEqual({ turn_id: "id18", reason: "interrupt" });
    expect(r.events[0]?.harness.event).toBe("UserPromptSubmit");
    expect(r.events[1]?.data).toEqual(PING_TURN);
    expect(r.events[3]?.data).toMatchObject({ turn: 1, user: "try again", assistant: "" });
    expect(facts().open_turn).toBe("p2");
    expect(JSON.stringify(stored())).not.toContain("Request interrupted");
  });

  it("is ended and sent at a compaction, and at a session start", async () => {
    await interrupted();
    const compact = await runJob(job("PreCompact", { trigger: "manual" }), { state: tmp });
    expect(types(compact.events)).toEqual(["turn.ended", "turn.transcript", "context.compacted"]);
    expect(compact.events[1]?.data).toEqual(PING_TURN);
    expect(facts().open_turn).toBeNull();
    // Once: the start that follows the compaction has nothing left to say about it.
    const after = await runJob(job("SessionStart", { source: "compact" }), { state: tmp });
    expect(types(after.events)).toEqual(["session.started"]);
  });

  it("is ended and sent when the session is resumed", async () => {
    await interrupted();
    const resumed = await runJob(job("SessionStart", { source: "resume" }), { state: tmp });
    expect(types(resumed.events)).toEqual(["turn.ended", "turn.transcript", "session.started"]);
  });

  it("at the session's end, as a turn, with no turn end of its own after the session's", async () => {
    await interrupted();
    const end = await runJob(job("SessionEnd", { reason: "prompt_input_exit" }), { state: tmp });
    expect(types(end.events)).toEqual(["session.ended", "turn.transcript"]);
    expect(end.events[1]?.data).toEqual(PING_TURN);
  });

  it("is not looked for by a message its own turn absorbs, nor by a prompt in a running turn", async () => {
    await interrupted();
    // The same prompt id: Claude Code's word for a message the running turn took in.
    const absorbed = await runJob(job("UserPromptSubmit", { prompt: "and faster", prompt_id: "id18" }), {
      state: tmp,
    });
    expect(types(absorbed.events)).not.toContain("turn.ended");
    expect(types(absorbed.events)).not.toContain("turn.transcript");
    // A permission prompt mid-turn is no place a turn can have ended.
    const asked = await runJob(job("Notification", { notification_type: "permission_prompt" }), { state: tmp });
    expect(types(asked.events)).toEqual(["attention.needed"]);
  });

  it("is sent without a turn end when the hooks hold another turn as the running one", async () => {
    await runJob(job("SessionStart", { source: "startup" }), { state: tmp });
    flush(10, 14);
    await runJob(job("UserPromptSubmit", { prompt: "something else", prompt_id: "other" }), { state: tmp });
    const r = await runJob(job("UserPromptSubmit", { prompt: "try again", prompt_id: "p2" }), { state: tmp });
    expect(types(r.events)).toEqual(["turn.transcript", "turn.started", "turn.progress"]);
    expect(r.events[0]?.data).toEqual(PING_TURN);
  });
});

describe("closedTurns", () => {
  const turn = (user: string, assistant: string, extra: object = {}) => ({
    user,
    assistant,
    at: 1,
    endLine: 1,
    ...extra,
  });
  const a = turn("a", "x");
  const b = turn("b", "y");
  const due = wordsDigest("y");
  it("all of them at a session's end, or for a harness that names no last words", () => {
    expect(closedTurns({ turns: [a, b], line: 9, tail: { start: 4 } }, { all: true })).toEqual({
      turns: [a, b],
      line: 9,
      waiting: false,
    });
    expect(closedTurns({ turns: [], line: 3 }, { all: true })).toEqual({ turns: [], line: 3, waiting: false });
  });
  it("the last one only once its last words are the ones named, the cursor before it until then", () => {
    expect(closedTurns({ turns: [a, b], line: 9, tail: { start: 4, said: "y" } }, { due })).toEqual({
      turns: [a, b],
      line: 9,
      waiting: false,
    });
    expect(closedTurns({ turns: [a, b], line: 9, tail: { start: 4, said: "so far" } }, { due })).toEqual({
      turns: [a],
      line: 4,
      waiting: true,
    });
    expect(closedTurns({ turns: [a, b], line: 9, tail: { start: 4 } }, { due })).toMatchObject({ turns: [a], line: 4 });
    // No words named (a look for an interrupted turn): the last may be running, and nothing waits.
    expect(closedTurns({ turns: [a, b], line: 9, tail: { start: 4, said: "y" } }, {})).toEqual({
      turns: [a],
      line: 4,
      waiting: false,
    });
  });
  it("a turn a later prompt closed, or the person interrupted, is whole whatever was named", () => {
    const open = { user: "c", at: 2 };
    expect(closedTurns({ turns: [a, b], line: 6, open, tail: { start: 4, said: "y" } }, { due: "other" })).toEqual({
      turns: [a, b],
      line: 6,
      waiting: true,
    });
    const cut = turn("b", "", { interrupted: true as const });
    expect(closedTurns({ turns: [a, cut], line: 9, tail: { start: 4 } }, {})).toEqual({
      turns: [a, cut],
      line: 9,
      waiting: false,
    });
    expect(closedTurns({ turns: [], line: 2, open }, { due })).toEqual({ turns: [], line: 2, waiting: true });
  });
  it("a reader that does not say where its last turn starts sends nothing but at a session's end", () => {
    expect(closedTurns({ turns: [a, b], line: 9 }, {})).toEqual({ turns: [], line: 9, waiting: false });
    expect(closedTurns({ turns: [a, b], line: 6, open: { user: "c", at: 2 } }, {}).turns).toEqual([]);
    expect(closedTurns({ turns: [a, b], line: 9 }, { all: true }).turns).toEqual([a, b]);
  });
  it("the digest of a turn's words does not depend on how their whitespace was written", () => {
    expect(wordsDigest("Done.\n\nAll  three merged. ")).toBe(wordsDigest(" Done. All three merged."));
    expect(wordsDigest("Done.")).not.toBe(wordsDigest("Done"));
    expect(wordsDigest("SIX")).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("openTurn", () => {
  it("an interrupted turn is not the one running", () => {
    const cut = { user: "a", assistant: "so far", at: 1, endLine: 2, interrupted: true as const };
    expect(openTurn({ turns: [cut], line: 3 }, { base: 0, at: 5 })).toBeNull();
    expect(openTurn({ turns: [cut], line: 3 }, { base: 0, at: 5, prompt: "next" })).toMatchObject({
      turn: 1,
      user: "next",
    });
  });
});
