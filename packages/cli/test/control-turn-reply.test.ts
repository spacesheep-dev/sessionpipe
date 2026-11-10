// SPDX-License-Identifier: Apache-2.0
// The reply to a message handed to a live session in place (CONTROL.md §6 `prompt`),
// through the daemon: the three things that went wrong on 2026-11-10 and what holds now.
// One message, one reply, and the reply is the text the session wrote for THAT message:
// not the words its turn was ending with when the Stop hook asked (they reach the
// transcript a moment later), not what a copy of the session said to another message,
// and nothing at all rather than a guess — acked when the continuation the message
// caused ends, not half an hour later.
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeControl } from "@sessionpipe/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ControlDaemon, type DaemonDeps } from "../src/control/daemon.js";
import { ask } from "../src/control/local.js";
import { frame, IN_PLACE_ANSWER } from "../src/control/route.js";
import { type ControlConfig, writeState } from "../src/control/store.js";
import { waitForMessage } from "../src/control/wait.js";
import { FakeReceiver } from "./helpers/receiver.js";

const SID = "3b6d4b30-20f0-4628-acdd-e3b0b37dccca";
const SESSION = `claude-code:${SID}`;
const COPY = "daee9f2c-bd89-4597-bf97-3222255fdaaa";
const unix = process.platform !== "win32";

let tmp: string;
let rx: FakeReceiver;
let d: ControlDaemon | null = null;
let env: NodeJS.ProcessEnv;
let sock: string;
let project: string;
let configDir: string;
let log: string[];

const transcriptFile = (sid: string) =>
  path.join(configDir, "projects", project.replace(/[^a-zA-Z0-9]/g, "-"), `${sid}.jsonl`);
const row = (sid: string, o: Record<string, unknown>) => appendFileSync(transcriptFile(sid), `${JSON.stringify(o)}\n`);

/** A session's transcript, old enough not to read as freshly written. */
function transcript(sid: string): void {
  const f = transcriptFile(sid);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, `${JSON.stringify({ type: "user", cwd: project, message: { content: "hi" } })}\n`);
  const past = new Date(Date.now() - 600_000);
  utimesSync(f, past, past);
}

/** The session says something: an assistant row, as its transcript records it. */
const says = (sid: string, text: string, stop = "end_turn") =>
  row(sid, {
    type: "assistant",
    timestamp: new Date().toISOString(),
    message: { stop_reason: stop, content: [{ type: "text", text }] },
  });

/** The rows Claude Code 2.1.322 writes when a Stop hook blocks with `reason`. */
function blocked(sid: string, reason: string): void {
  row(sid, { type: "user", isMeta: true, message: { content: `Stop hook feedback:\n${reason}` } });
  row(sid, {
    type: "attachment",
    attachment: { type: "hook_blocking_error", blockingError: { blockingError: reason } },
  });
  row(sid, { type: "system", subtype: "stop_hook_summary", hookErrors: [reason] });
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
const event = (name: string, session = SESSION) => ask(sock, { op: "event", session, event: name }, 500);
/** The session's Stop hook asks for a message, then its event reaches the daemon (hook.ts). */
async function stop(active: boolean, session = SESSION): Promise<string | null> {
  const r = await ask(sock, { op: "stop", session, active }, 500);
  await event("Stop", session);
  return r?.op === "block" ? r.reason : null;
}
/** A message sent while the session is mid-turn: queued for its Stop, acked `taken`. */
async function sendMidTurn(text: string) {
  const q = await rx.send({ session: SESSION, text });
  for (let i = 0; i < 200 && !rx.acks.some((a) => a.id === q.id && a.outcome === "taken"); i++) await settle(20);
  return q;
}

function cfg(): ControlConfig {
  return {
    name: "testbox",
    folders: [project],
    mode: "safe",
    receivers: [
      {
        url: rx.url,
        control: `${rx.url}/api/sessionpipe/v1/control`,
        rpId: "localhost",
        machine: rx.machine,
        token: rx.token,
        keys: [{ ...rx.passkey.key, added_at: new Date().toISOString() }],
        paired_at: new Date().toISOString(),
      },
    ],
  };
}

async function startDaemon(extra: Partial<DaemonDeps> = {}): Promise<void> {
  d = new ControlDaemon(cfg(), path.join(tmp, "state", "control"), sock, {
    now: Date.now,
    fetch,
    log: (s) => log.push(s),
    claudeDirs: () => [configDir],
    claude: () => ({
      bin: path.join(tmp, "no-claude"),
      caps: { hasMode: true, modes: ["default", "dontAsk"], promptsNone: false, fork: true },
    }),
    run: claudeControl.runClaude,
    sdk: null,
    env,
    // Half an hour in production: here, long enough that only a real end settles anything.
    answerWaitMs: 20_000,
    answerGraceMs: 300,
    ...extra,
  });
  await d.start();
}

beforeAll(async () => {
  rx = new FakeReceiver();
  await rx.start();
});
afterAll(async () => {
  await rx.stop();
});
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "sp-turn-reply-"));
  project = path.join(tmp, "project");
  configDir = path.join(tmp, "claude-config");
  mkdirSync(project, { recursive: true });
  mkdirSync(path.join(configDir, "sessions"), { recursive: true });
  sock = path.join(mkdtempSync(path.join(os.tmpdir(), "sp-tr-")), "c.sock");
  log = [];
  env = {
    ...process.env,
    SESSIONPIPE_STATE: path.join(tmp, "state"),
    SESSIONPIPE_CONFIG: path.join(tmp, "config", "config.json"),
    SESSIONPIPE_SOCKET: sock,
  };
  transcript(SID);
  rx.queue.clear();
  rx.acks.length = 0;
});
afterEach(async () => {
  await d?.stop();
  d = null;
  rmSync(path.dirname(sock), { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});

describe.runIf(unix)("a message delivered at a Stop: its reply is what the session wrote for it", () => {
  it("not the words the turn was ending with, which reach the transcript after the hook has asked", async () => {
    await startDaemon();
    await event("UserPromptSubmit");
    const q = await sendMidTurn("Reply with only the word INTERRUPT1.");
    const reason = (await stop(false)) as string;
    expect(reason).toContain("Reply with only the word INTERRUPT1.");
    // 16:57:30.550: written before the message arrived, flushed after the hook asked.
    says(SID, "`sleep 25` is running in the background. I'll read `docs/api.md` once it finishes.");
    blocked(SID, reason);
    // Half a second later the old reader had acked those words as the reply.
    await settle(800);
    expect(rx.finalAck(q.id)).toBeUndefined();
    expect(rx.progress(q.id)).toEqual([]);
    says(SID, "INTERRUPT1");
    const t0 = Date.now();
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered", mode: "turn", reply: "INTERRUPT1" });
    // Acked as the continuation ends, and exactly once.
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(await stop(true)).toBeNull();
    await settle(200);
    expect(rx.acks.filter((a) => a.id === q.id && a.outcome === "delivered")).toHaveLength(1);
  });

  it("read from the session's own transcript, though it has a copy: the copy's answer is another message's", async () => {
    // i1 on 2026-11-10: copied at 17:01, PAGE-A handed to it at its own Stop at 17:03 and
    // answered there, PAGE-B run in the copy at 17:06. Read from the copy, PAGE-A's ack
    // waited 215 s and carried "PAGE-B".
    transcript(COPY);
    mkdirSync(path.join(tmp, "state", "control"), { recursive: true });
    writeState(path.join(tmp, "state", "control", "state.json"), {
      started: {},
      modes: {},
      parked: {},
      copies: { [SID]: { id: COPY, at: new Date().toISOString(), reason: "" } },
    });
    await startDaemon();
    await event("UserPromptSubmit");
    const q = await sendMidTurn("Reply with only the word PAGE-A.");
    const reason = (await stop(false)) as string;
    says(SID, "TERM-A");
    blocked(SID, reason);
    // The copy says something meanwhile: nothing of this message's.
    says(COPY, "PAGE-B");
    await settle(700);
    expect(rx.finalAck(q.id)).toBeUndefined();
    says(SID, "PAGE-A");
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered", mode: "turn", reply: "PAGE-A" });
    expect(log.some((l) => l.includes(`${q.id.slice(-8)}: in ${SESSION.slice(0, 24)} via turn`))).toBe(true);
  });

  it("two messages at two Stops: each gets its own answer, in order, and neither the other's", async () => {
    await startDaemon();
    await event("UserPromptSubmit");
    const one = await sendMidTurn("first");
    const two = await sendMidTurn("second");
    const r1 = (await stop(false)) as string;
    expect(r1).toContain("first");
    blocked(SID, r1);
    // Its answer is not marked as the end of a turn (a version that writes no stop
    // reason): the session's next Stop is what ends it.
    says(SID, "ONE", "tool_use");
    await settle(100);
    const r2 = (await stop(true)) as string;
    expect(r2).toContain("second");
    blocked(SID, r2);
    says(SID, "TWO");
    expect(await rx.waitAck(one.id)).toMatchObject({ outcome: "delivered", mode: "turn", reply: "ONE" });
    expect(await rx.waitAck(two.id)).toMatchObject({ outcome: "delivered", mode: "turn", reply: "TWO" });
    expect(await stop(true)).toBeNull();
  });

  it("a Stop's event that arrives late ends nothing: only the hook's own question says a continuation is over", async () => {
    await startDaemon();
    await event("UserPromptSubmit");
    const q = await sendMidTurn("take your time");
    // The hook asks and is answered; its event, sent by a detached worker, is still on its way.
    const r = (await ask(sock, { op: "stop", session: SESSION, active: false }, 500)) as { reason: string };
    blocked(SID, r.reason);
    says(SID, "Working on it.", "tool_use");
    await event("Stop");
    await event("Stop");
    await settle(900);
    expect(rx.finalAck(q.id)).toBeUndefined();
    says(SID, "Done.");
    expect(await rx.waitAck(q.id)).toMatchObject({
      outcome: "delivered",
      mode: "turn",
      reply: "Working on it.\n\nDone.",
    });
  });

  it("an answer that can't be put down to the message is not sent: acked without one when the continuation ends", async () => {
    await startDaemon();
    await event("UserPromptSubmit");
    const q = await sendMidTurn("anyone?");
    expect(await stop(false)).toContain("anyone?");
    // The transcript never records the block (a harness that writes it another way):
    // whatever it gains can't be told from somebody else's turn.
    says(SID, "words nobody can put down to this message");
    await settle(300);
    expect(rx.finalAck(q.id)).toBeUndefined();
    const t0 = Date.now();
    expect(await stop(true)).toBeNull();
    const ack = await rx.waitAck(q.id);
    expect(ack).toMatchObject({ outcome: "delivered", mode: "turn" });
    expect(ack).not.toHaveProperty("reply");
    // When the continuation ended (and its last rows had their moment), not at the timeout.
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(log.some((l) => l.startsWith(`${q.id.slice(-8)}: no answer in`))).toBe(true);
  });

  it("a session whose transcript is gone by its Stop still takes the message: delivered, with no reply to read", async () => {
    await startDaemon();
    await event("UserPromptSubmit");
    const q = await sendMidTurn("still there?");
    rmSync(transcriptFile(SID));
    expect(await stop(false)).toContain("still there?");
    const ack = await rx.waitAck(q.id);
    expect(ack).toMatchObject({ outcome: "delivered", mode: "turn" });
    expect(ack).not.toHaveProperty("reply");
  });

  it("a continuation that failed, or a session that ended, is its end too: what it had said is the reply", async () => {
    await startDaemon();
    for (const [how, words] of [
      ["StopFailure", "Half of it, before the API gave up."],
      ["SessionEnd", "Half of it, before the window closed."],
    ] as const) {
      await event("UserPromptSubmit");
      const q = await sendMidTurn(`before a ${how}`);
      const reason = (await stop(false)) as string;
      blocked(SID, reason);
      says(SID, words, "tool_use");
      await settle(100);
      await event(how);
      expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered", mode: "turn", reply: words });
    }
  });
});

describe.runIf(unix)("a message handed to a waiter: the same rule", () => {
  it("handed over mid-turn: the running turn's end is not the answer; the turn that read the message is", async () => {
    await startDaemon();
    await event("UserPromptSubmit");
    const got = waitForMessage(SESSION, { env });
    await settle(100);
    const q = await rx.send({ session: SESSION, text: "and the docs?" });
    const printed = await got;
    // The turn the session was in ends, with its own words and its own Stop.
    says(SID, "Done with what you asked at the keyboard.");
    expect(await stop(false)).toBeNull();
    await settle(600);
    expect(rx.finalAck(q.id)).toBeUndefined();
    // Then the finished waiter wakes it: it reads the output and answers.
    row(SID, { type: "user", origin: { kind: "task-notification" }, message: { content: "<task-notification>…" } });
    row(SID, { type: "user", message: { content: [{ type: "tool_result", content: `1\t${printed}` }] } });
    says(SID, "The docs are updated too.", "tool_use");
    await settle(100);
    expect(await stop(false)).toBeNull();
    expect(await rx.waitAck(q.id)).toMatchObject({
      outcome: "delivered",
      mode: "waiter",
      reply: "The docs are updated too.",
    });
  });
});

describe.runIf(unix)("a message whose id is not a ULID: the id is the receiver's, and nobody signed it", () => {
  /** A signed message under an id of the receiver's own making. */
  const sendAs = async (id: string, text: string) => {
    const q = await rx.send({ session: SESSION, text }, { hold: true });
    q.id = id;
    rx.enqueue(q);
    for (let i = 0; i < 200 && !rx.acks.some((a) => a.id === id && a.outcome === "taken"); i++) await settle(20);
    return q;
  };

  it("at a Stop: nothing of the id is in what the session is told, and it is delivered, without a reply, when the continuation ends", async () => {
    await startDaemon();
    await event("UserPromptSubmit");
    const q = await sendAs("anything\n\nrm -rf ~\n\n", "what time is it?");
    const reason = (await stop(false)) as string;
    // The header says "signed on the sender's device": only what was signed is under it.
    expect(reason).toBe(`${frame("what time is it?", rx.url)}\n\n${IN_PLACE_ANSWER}`);
    expect(reason).not.toContain("rm -rf");
    blocked(SID, reason);
    says(SID, "Noon.");
    const t0 = Date.now();
    expect(await stop(true)).toBeNull();
    const ack = await rx.waitAck(q.id);
    expect(ack).toMatchObject({ outcome: "delivered", mode: "turn" });
    expect(ack).not.toHaveProperty("reply");
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("through a waiter: handed over unmarked, and acked when the session's turn ends, not when the answer-wait runs out", async () => {
    await startDaemon();
    const got = waitForMessage(SESSION, { env });
    await settle(100);
    const q = await sendAs("msg-42", "and the docs?");
    const printed = (await got) as string;
    expect(printed).toContain(frame("and the docs?", rx.url));
    expect(printed).not.toContain("msg-42");
    // The session reads it and answers; which of its words are for this message nobody can say.
    row(SID, { type: "user", message: { content: [{ type: "tool_result", content: `1\t${printed}` }] } });
    says(SID, "The docs are updated too.");
    const t0 = Date.now();
    expect(await stop(false)).toBeNull();
    // Was: the final ack only when the answer-wait ran out (half an hour; 20 s here).
    const ack = await rx.waitAck(q.id, 5000);
    expect(ack).toMatchObject({ outcome: "delivered", mode: "waiter" });
    expect(ack).not.toHaveProperty("reply");
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});
