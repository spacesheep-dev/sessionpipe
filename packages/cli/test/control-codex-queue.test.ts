// SPDX-License-Identifier: Apache-2.0
// A message for a Codex session a live Codex process has open (CONTROL.md §6.4). Codex
// locks an open thread itself and turns a headless resume away at once; the message then
// goes into Codex's own queue for that process, and its answer is read from the rollout.
// The stand-in `codex` answers as codex-cli 0.171.0 did on 2026-11-24: the refusal's exit
// code and stderr, `codex queue`'s two lines, and the rows a window writes for a queued
// message (conformance/transcripts/codex/queued.jsonl).
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, Outbox, runHeadless, writeConfig } from "@sessionpipe/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ControlDaemon, type DaemonDeps } from "../src/control/daemon.js";
import { type AskRequest, ask, askMany, type LocalReply } from "../src/control/local.js";
import { frameHandoff, IN_PLACE_ANSWER } from "../src/control/route.js";
import type { ControlConfig } from "../src/control/store.js";
import { jsonLines } from "./helpers/lines.js";
import { FakeReceiver } from "./helpers/receiver.js";

const THREAD = "0199b6f2-7c1d-7e3a-9b4c-5d6e7f8a9b0c"; // the thread a new `codex exec` picks
const OWN = "0199c0de-1111-7222-8333-944455556666"; // a thread the person began in a window
const RECV = "0b6f2c7e-3d4a-4f1b-9c8e-2a1d5e6f7e01"; // the id a receiver's start names
const unix = process.platform !== "win32";

let tmp: string;
let rx: FakeReceiver;
let d: ControlDaemon | null = null;
let env: NodeJS.ProcessEnv;
let sock: string;
let project: string;
let calls: string;
let fakeCodex: string;
let logs: string[];

/** What the stand-in does, read by it at each run: `held` names the thread a live process
 *  has; `queue` says how `codex queue` goes (`fails`, or `nobody`: queued, taken by no
 *  one); `slow` is how long a resume takes to be refused; `version` is what it says it is. */
const say = (name: "held" | "queue" | "slow" | "version", value: string) => writeFileSync(path.join(tmp, name), value);

/** A live Codex process has the thread: its resume is refused, and its lock file is there. */
function hold(thread: string): void {
  say("held", thread);
  lockFile(thread);
}
const locks = () => path.join(tmp, "codex-home", "thread-writer-locks");
function lockFile(thread: string): void {
  mkdirSync(locks(), { recursive: true });
  writeFileSync(path.join(locks(), `${thread}.lock`), "");
}

function writeFake(): void {
  writeFileSync(
    fakeCodex,
    `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const a = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const told = (f) => { try { return fs.readFileSync(path.join(${JSON.stringify(tmp)}, f), "utf8").trim(); } catch { return ""; } };
if (a[0] === "--version") { process.stdout.write("codex-cli " + (told("version") || "0.171.0") + "\\n"); process.exit(0); }
// A turn the queue began, the message as an ordinary prompt, the answer, the turn's end.
const take = (f, text) => {
  const row = (type, payload) => fs.appendFileSync(f, JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + "\\n");
  const said = "the window says: " + (text.split("\\n\\n")[/^Message via /.test(text) ? 1 : 0] || "").trim();
  row("event_msg", { type: "task_started", turn_id: "tq", turn_attribution: { turn_trigger: "queue" } });
  row("response_item", { type: "message", role: "user", content: [{ type: "input_text", text }] });
  row("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: said }] });
  row("event_msg", { type: "task_complete", turn_id: "tq", last_agent_message: said });
};
const rolloutOf = (thread) => {
  const found = [];
  const walk = (dir) => { for (const n of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const p = path.join(dir, n);
    if (fs.statSync(p).isDirectory()) walk(p); else if (n.endsWith("-" + thread + ".jsonl")) found.push(p);
  } };
  walk(path.join(process.env.CODEX_HOME, "sessions"));
  return found[0] || null;
};
if (a[0] === "__take") { take(rolloutOf(a[1]), a[2]); process.exit(0); }
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ argv: a, cwd: process.cwd(), home: process.env.CODEX_HOME || null }) + "\\n");
if (a[0] === "queue") {
  const thread = a[a.indexOf("--thread") + 1], text = a.find((x) => x.startsWith("--message=")).slice(10);
  if (told("queue") === "fails") { process.stderr.write("Error: thread " + thread + " not found\\n"); process.exit(1); }
  const f = rolloutOf(thread);
  if (f && told("queue") !== "nobody") take(f, text);
  process.stdout.write("Queued message 01a20f72-ce2c-7b53-ae19-98e81248ae3d for thread " + thread + ".\\n");
  process.stderr.write("Warning: message was queued, but could not resume thread " + thread + ": start a local daemon or specify a server with --remote\\n");
  process.exit(0);
}
const resume = a[1] === "resume";
const id = resume ? a[a.indexOf("--") + 1] : ${JSON.stringify(THREAD)};
const go = () => {
  if (resume && told("held") === id) {
    process.stderr.write([
      "2026-11-24T21:25:11.777334Z ERROR codex_core::session::session: failed to initialize thread persistence: thread-store conflict: thread " + id + " already has an active writer",
      "2026-11-24T21:25:11.777398Z ERROR codex_core::session: Failed to create session: thread-store conflict: thread " + id + " already has an active writer",
      "Error: thread/resume: thread/resume failed: thread " + id + " already has an active writer (code -32600)",
    ].join("\\n") + "\\n");
    process.exit(1);
  }
  if (!resume) {
    const day = path.join(process.env.CODEX_HOME, "sessions", "2026", "11", "24");
    fs.mkdirSync(day, { recursive: true });
    fs.writeFileSync(path.join(day, "rollout-2026-11-24T10-00-00-" + id + ".jsonl"),
      JSON.stringify({ type: "session_meta", payload: { id, cwd: process.cwd() } }) + "\\n");
  }
  out({ type: "thread.started", thread_id: id });
  out({ type: "turn.started" });
  // The person's words: after the header of a later message, before the note of a first one.
  const paras = a[a.length - 1].split("\\n\\n");
  out({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "codex did: " + paras[/^Message via /.test(paras[0]) ? 1 : 0] } });
  out({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
};
setTimeout(go, Number(told("slow")) || 0);
`,
  );
  chmodSync(fakeCodex, 0o755);
}

/** The window takes a queued message now: the stand-in writes the rows a window writes
 *  for one (0.171.0), as it does by itself when `codex queue` is run and it is idle. */
const takeNow = (thread: string, text: string) =>
  execFileSync(process.execPath, [fakeCodex, "__take", thread, text], { env, stdio: "ignore" });

const runs = (): { argv: string[]; cwd: string; home: string | null }[] => jsonLines(calls);
const queued = () => runs().filter((r) => r.argv[0] === "queue");
const messageOf = (run: { argv: string[] } | undefined) => (run?.argv[3] ?? "").slice("--message=".length);
const event = (type: string, payload: Record<string, unknown>, at = Date.now()) => ({
  timestamp: new Date(at).toISOString(),
  type,
  payload,
});
const began = (turn_trigger: string, at = Date.now()) =>
  event("event_msg", { type: "task_started", turn_attribution: { turn_trigger } }, at);

/** A thread's rollout as its own Codex left it: ten minutes old unless `fresh`. */
function rollout(id: string, o: { fresh?: boolean; rows?: unknown[] } = {}): string {
  const day = path.join(tmp, "codex-home", "sessions", "2026", "11", "23");
  mkdirSync(day, { recursive: true });
  const f = path.join(day, `rollout-2026-11-23T09-00-00-${id}.jsonl`);
  const rows = [{ type: "session_meta", payload: { id, cwd: project, cli_version: "0.171.0" } }, ...(o.rows ?? [])];
  writeFileSync(f, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
  if (!o.fresh) utimesSync(f, new Date(Date.now() - 600_000), new Date(Date.now() - 600_000));
  return f;
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

/** `takenMs`: how long an idle holder is given to begin a queued message's turn (null:
 *  the daemon's own patience). */
async function startDaemon(extra: Partial<DaemonDeps> = {}, takenMs: number | null = 400) {
  d = new ControlDaemon(cfg(), path.join(tmp, "state", "control"), sock, {
    now: Date.now,
    fetch,
    log: (s: string) => logs.push(s),
    claudeDirs: () => [path.join(tmp, "claude-config")],
    claude: () => null,
    codex: () => fakeCodex,
    run: runHeadless,
    env,
    answerWaitMs: 5000,
    ...(takenMs === null ? {} : { queueTakenMs: takenMs }),
    ...extra,
  });
  await d.start();
}

async function until<T>(fn: () => T | undefined | false | null, ms = 10_000): Promise<T> {
  const stop = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > stop) throw new Error("gave up waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeAll(async () => {
  rx = new FakeReceiver();
  await rx.start();
});
afterAll(async () => {
  await rx.stop();
});
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sp-codex-queue-")));
  project = path.join(tmp, "project");
  mkdirSync(project, { recursive: true });
  mkdirSync(path.join(tmp, "bin"));
  sock = path.join(tmp, "control.sock");
  calls = path.join(tmp, "calls.jsonl");
  fakeCodex = path.join(tmp, "bin", "codex");
  logs = [];
  writeFake();
  env = {
    ...process.env,
    SESSIONPIPE_STATE: path.join(tmp, "state"),
    SESSIONPIPE_CONFIG: path.join(tmp, "config", "config.json"),
    SESSIONPIPE_SOCKET: sock,
    CODEX_HOME: path.join(tmp, "codex-home"),
  };
  delete env.CODEX_API_KEY;
  delete env.SESSIONPIPE_ASKED_BY;
  delete env.SESSIONPIPE_ASK_CHAIN;
  // A sink at tier 1, so what the daemon records on a session (a handoff's events) is kept.
  writeConfig(
    {
      ...DEFAULT_CONFIG,
      machine: "testbox",
      sinks: [{ name: "file", url: `file:${path.join(tmp, "sink.jsonl")}`, tier: 1, pii: false }],
    },
    env.SESSIONPIPE_CONFIG,
  );
  rx.queue.clear();
  rx.acks.length = 0;
  rx.hellos.length = 0;
});
afterEach(async () => {
  await d?.stop();
  d = null;
  rmSync(tmp, { recursive: true, force: true });
});

describe.runIf(unix)("a Codex session a live Codex process has open", () => {
  it("the resume Codex refuses is not the end: the message goes into Codex's own queue, and its answer comes back", {
    timeout: 20_000,
  }, async () => {
    rollout(OWN);
    hold(OWN);
    // With the daemon's own patience for an idle holder (the message is taken at once).
    await startDaemon({}, null);
    const q = await rx.send({ session: `codex:${OWN}`, text: "is the build green?" });
    const ack = await rx.waitAck(q.id);
    expect(ack).toMatchObject({ outcome: "delivered", mode: "inbox", reply: "the window says: is the build green?" });
    expect(ack).not.toHaveProperty("session");
    // Taken once, and one final ack.
    const mine = rx.acks.filter((a) => a.id === q.id && a.outcome !== "progress").map((a) => a.outcome);
    expect(mine).toEqual(["taken", "delivered"]);
    // The resume was tried first, as for any session nothing is known to hold; then the queue.
    expect(runs().map((r) => r.argv.slice(0, 2).join(" "))).toEqual(["exec resume", "queue --thread"]);
    const [one] = queued();
    expect(one?.home).toBe(path.join(tmp, "codex-home"));
    expect(one?.argv).toEqual(["queue", "--thread", OWN, expect.stringMatching(/^--message=Message via /), "--resume"]);
    // In sessionpipe's frame for a message handed over in place: it names the message,
    // which is how its answer is found, and says the answer goes back by itself.
    const text = messageOf(one);
    expect(text).toMatch(
      /^Message via localhost:\d+ \(sessionpipe control[^\n]*; message [0-9A-Z]{12}\):\n\nis the build green\?\n\n/,
    );
    expect(text.endsWith(IN_PLACE_ANSWER)).toBe(true);
    expect(logs.join("\n")).toMatch(/Codex has 0199c0de open; the message is in its own queue for it/);
    expect(logs.join("\n")).toMatch(/in codex:0199c0de\S* via inbox \d+ ms after send/);
    // The next one goes the same way, the binary asked for its version only once.
    const q2 = await rx.send({ session: `codex:${OWN}`, text: "and the tests?" });
    expect(await rx.waitAck(q2.id)).toMatchObject({ mode: "inbox", reply: "the window says: and the tests?" });
  });

  it("a thread nobody has is resumed as before, and nothing is queued", { timeout: 20_000 }, async () => {
    rollout(OWN);
    await startDaemon();
    const q = await rx.send({ session: `codex:${OWN}`, text: "summarize" });
    expect(await rx.waitAck(q.id)).toMatchObject({
      outcome: "delivered",
      mode: "resume",
      reply: "codex did: summarize",
    });
    expect(queued()).toHaveLength(0);
  });

  it("a rollout written a moment ago holds nothing by itself where Codex has the thread's lock file: Codex says who has it", {
    timeout: 20_000,
  }, async () => {
    // No lock file (an older Codex, or nothing of Codex's has it): a write this recent may
    // have a writer behind it, as before.
    rollout(OWN, { fresh: true });
    await startDaemon();
    const q = await rx.send({ session: `codex:${OWN}`, text: "hello" });
    expect(await rx.waitAck(q.id)).toMatchObject({
      outcome: "unsupported",
      detail: expect.stringContaining("written to in the last 90 seconds"),
    });
    expect(runs()).toHaveLength(0);
    // The file a holder left behind when it was killed: Codex's own answer decides, and
    // nothing has the thread.
    lockFile(OWN);
    rollout(OWN, { fresh: true });
    const q2 = await rx.send({ session: `codex:${OWN}`, text: "hello again" });
    expect(await rx.waitAck(q2.id)).toMatchObject({ outcome: "delivered", mode: "resume" });
    // And with a window on it, a moment after the window's own turn: into its queue.
    rollout(OWN, { fresh: true });
    hold(OWN);
    const q3 = await rx.send({ session: `codex:${OWN}`, text: "and now?" });
    expect(await rx.waitAck(q3.id)).toMatchObject({
      outcome: "delivered",
      mode: "inbox",
      reply: "the window says: and now?",
    });
  });

  it("a daemon whose own codex would not be stopped by the lock keeps the 90 seconds", {
    timeout: 20_000,
  }, async () => {
    // The window's Codex locks the thread; the one this daemon runs is older and would
    // write beside it.
    say("version", "0.170.2");
    rollout(OWN, { fresh: true });
    hold(OWN);
    await startDaemon();
    const q = await rx.send({ session: `codex:${OWN}`, text: "hello" });
    expect(await rx.waitAck(q.id)).toMatchObject({
      outcome: "unsupported",
      detail: expect.stringContaining("written to in the last 90 seconds"),
    });
    expect(runs()).toHaveLength(0);
    // No codex to ask at all: the same.
    await d?.stop();
    await startDaemon({ codex: () => path.join(tmp, "bin", "no-codex") });
    const q2 = await rx.send({ session: `codex:${OWN}`, text: "hello" });
    expect(await rx.waitAck(q2.id)).toMatchObject({ outcome: "unsupported" });
  });

  it("a headless run in the middle of a turn: nothing is queued for it, and the ack says so", {
    timeout: 20_000,
  }, async () => {
    rollout(OWN, { fresh: true, rows: [began("exec")] });
    hold(OWN);
    await startDaemon();
    const q = await rx.send({ session: `codex:${OWN}`, text: "hello" });
    expect(await rx.waitAck(q.id)).toMatchObject({
      outcome: "failed",
      detail: "a headless Codex run has that session and is in the middle of a turn: send it again when that is done",
    });
    expect(queued()).toHaveLength(0);
  });

  it("a headless turn with no end is not always one that is running: a killed run writes none", {
    timeout: 20_000,
  }, async () => {
    // Silent for ten minutes, with a window on the thread since: nobody's turn.
    rollout(OWN, { rows: [began("exec", Date.now() - 900_000)] });
    hold(OWN);
    await startDaemon();
    const q = await rx.send({ session: `codex:${OWN}`, text: "one" });
    expect(await rx.waitAck(q.id)).toMatchObject({
      outcome: "delivered",
      mode: "inbox",
      reply: "the window says: one",
    });
    // Written a moment ago, and the session's own hooks said it ended after that turn
    // began: the machine saw that run go.
    rollout(OWN, { fresh: true, rows: [began("exec", Date.now() - 5000)] });
    await ask(sock, { op: "event", session: `codex:${OWN}`, event: "SessionEnd", cwd: project }, 500);
    const q2 = await rx.send({ session: `codex:${OWN}`, text: "two" });
    expect(await rx.waitAck(q2.id)).toMatchObject({
      outcome: "delivered",
      mode: "inbox",
      reply: "the window says: two",
    });
    expect(queued()).toHaveLength(2);
  });

  it("Codex does not take the message: failed, with what Codex said, and never a second try", {
    timeout: 20_000,
  }, async () => {
    rollout(OWN);
    hold(OWN);
    say("queue", "fails");
    await startDaemon();
    const q = await rx.send({ session: `codex:${OWN}`, text: "hello" });
    expect(await rx.waitAck(q.id)).toMatchObject({
      outcome: "failed",
      detail: `Codex has that session open in another process and did not take the message into its queue: Error: thread ${OWN} not found`,
    });
    expect(queued()).toHaveLength(1);
  });

  it("the queue is the daemon's to stand in for, and a failure that says nothing is still a failure", {
    timeout: 20_000,
  }, async () => {
    rollout(OWN);
    hold(OWN);
    const asked: string[][] = [];
    await startDaemon({
      codexQueue: async (bin, thread, text) => {
        asked.push([bin, thread, text.split("\n\n")[1] as string]);
        return { ok: false, said: "" };
      },
    });
    const q = await rx.send({ session: `codex:${OWN}`, text: "hello" });
    expect(await rx.waitAck(q.id)).toMatchObject({
      outcome: "failed",
      detail: "Codex has that session open in another process and did not take the message into its queue",
    });
    expect(asked).toEqual([[fakeCodex, OWN, "hello"]]);
    expect(queued()).toHaveLength(0);
  });

  it("queued and taken by nobody: held, said as it is, and nothing more is queued behind it until it has run", {
    timeout: 30_000,
  }, async () => {
    rollout(OWN);
    hold(OWN);
    say("queue", "nobody");
    await startDaemon();
    const q = await rx.send({ session: `codex:${OWN}`, text: "first" });
    const ack = await rx.waitAck(q.id);
    expect(ack).toMatchObject({
      outcome: "failed",
      code: "held",
      detail:
        "put into Codex's own queue for that session, and no turn began for it: it may run when the session is next used. Nothing was duplicated, and nothing else was tried.",
    });
    expect(ack).not.toHaveProperty("mode");
    expect(logs.join("\n")).toMatch(/no turn began for it in codex:0199c0de\S*; acked held/);
    // A second message is not put behind one nobody is taking: a later run of the session
    // would take the first into its own turn and cut the next off.
    const q2 = await rx.send({ session: `codex:${OWN}`, text: "second" });
    expect(await rx.waitAck(q2.id)).toMatchObject({
      outcome: "failed",
      detail:
        "an earlier message is still waiting in Codex's own queue for that session, which has not begun a turn for it: nothing more is queued until it has",
    });
    expect(queued()).toHaveLength(1);
    // The session takes the first after all (the window was reopened): the way is open again.
    takeNow(OWN, messageOf(queued()[0]));
    say("queue", "takes");
    const q3 = await rx.send({ session: `codex:${OWN}`, text: "third" });
    expect(await rx.waitAck(q3.id)).toMatchObject({
      outcome: "delivered",
      mode: "inbox",
      reply: "the window says: third",
    });
    expect(queued()).toHaveLength(2);
  });

  it("a message nobody took is not waited on for ever: after as long as an answer is waited for, the next is queued", {
    timeout: 30_000,
  }, async () => {
    rollout(OWN);
    hold(OWN);
    say("queue", "nobody");
    await startDaemon({ answerWaitMs: 700, queueTakenMs: 100 });
    const q = await rx.send({ session: `codex:${OWN}`, text: "first" });
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "failed", code: "held" });
    await new Promise((r) => setTimeout(r, 800));
    const q2 = await rx.send({ session: `codex:${OWN}`, text: "second" });
    expect(await rx.waitAck(q2.id)).toMatchObject({ outcome: "failed", code: "held" });
    expect(queued()).toHaveLength(2);
  });

  it("Codex never says whether it took the message: still only delivered once a turn began for it", {
    timeout: 30_000,
  }, async () => {
    rollout(OWN);
    hold(OWN);
    let take = true;
    await startDaemon({
      codexQueue: async (_bin, _thread, text) => {
        if (take) takeNow(OWN, text);
        return { ok: null, said: "it did not answer in time" };
      },
    });
    const q = await rx.send({ session: `codex:${OWN}`, text: "one" });
    expect(await rx.waitAck(q.id)).toMatchObject({
      outcome: "delivered",
      mode: "inbox",
      reply: "the window says: one",
    });
    expect(logs.join("\n")).toMatch(/whether its queue has the message is not known \(it did not answer in time\)/);
    take = false;
    const q2 = await rx.send({ session: `codex:${OWN}`, text: "two" });
    expect(await rx.waitAck(q2.id)).toMatchObject({
      outcome: "failed",
      code: "held",
      detail:
        "Codex did not say whether it took the message into its queue for that session, and no turn began for it: it may run when the session is next used. Nothing was duplicated, and nothing else was tried.",
    });
  });

  it("a window in the middle of a turn takes it when that turn ends, and the next message waits its turn here", {
    timeout: 30_000,
  }, async () => {
    const f = rollout(OWN, { fresh: true, rows: [began("user")] });
    hold(OWN);
    say("queue", "nobody"); // the window is busy: the test writes what it does, when it does it
    await startDaemon();
    const q = await rx.send({ session: `codex:${OWN}`, text: "first" });
    await until(() => queued().length === 1);
    const q2 = await rx.send({ session: `codex:${OWN}`, text: "second" });
    // Longer than an idle holder is given: a turn is running and something has the thread.
    await new Promise((r) => setTimeout(r, 1200));
    expect(rx.finalAck(q.id)).toBeUndefined();
    // One message of the daemon's in Codex's queue at a time.
    expect(queued()).toHaveLength(1);
    const ended = JSON.stringify(event("event_msg", { type: "task_complete", turn_id: "t0" }));
    writeFileSync(f, `${ended}\n`, { flag: "a" });
    takeNow(OWN, messageOf(queued()[0]));
    expect(await rx.waitAck(q.id)).toMatchObject({
      outcome: "delivered",
      mode: "inbox",
      reply: "the window says: first",
    });
    say("queue", "takes");
    expect(await rx.waitAck(q2.id)).toMatchObject({
      outcome: "delivered",
      mode: "inbox",
      reply: "the window says: second",
    });
    expect(queued()).toHaveLength(2);
  });

  it("a window that is quit in the middle of its turn takes nothing: held, once its lock is gone", {
    timeout: 30_000,
  }, async () => {
    rollout(OWN, { fresh: true, rows: [began("user")] });
    hold(OWN);
    say("queue", "nobody");
    await startDaemon();
    const q = await rx.send({ session: `codex:${OWN}`, text: "first" });
    await until(() => queued().length === 1);
    await new Promise((r) => setTimeout(r, 700));
    expect(rx.finalAck(q.id)).toBeUndefined();
    rmSync(path.join(locks(), `${OWN}.lock`));
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "failed", code: "held" });
  });

  it("a Stop while Codex is being asked to take it takes nothing back: Codex is asked to the end, and the window runs it", {
    timeout: 20_000,
  }, async () => {
    rollout(OWN);
    hold(OWN);
    let asked = false;
    let answer: () => void = () => {};
    await startDaemon({
      codexQueue: (_bin, _thread, text) =>
        new Promise((resolve) => {
          asked = true;
          answer = () => {
            takeNow(OWN, text);
            resolve({ ok: true, said: "" });
          };
        }),
    });
    const q = await rx.send({ session: `codex:${OWN}`, text: "hello" });
    await until(() => asked);
    // The message is the live session's from the moment Codex is asked: nothing of this
    // daemon's own is running for a Stop to end.
    const stop = await rx.send({ kind: "cancel", session: `codex:${OWN}`, text: undefined });
    expect(await rx.waitAck(stop.id)).toMatchObject({
      outcome: "unsupported",
      detail: expect.stringContaining("stop it in codex itself"),
    });
    expect(rx.finalAck(q.id)).toBeUndefined();
    answer();
    expect(await rx.waitAck(q.id)).toMatchObject({
      outcome: "delivered",
      mode: "inbox",
      reply: "the window says: hello",
    });
    // And nothing holds the session afterwards.
    say("queue", "takes");
    await d?.stop();
    await startDaemon();
    const q2 = await rx.send({ session: `codex:${OWN}`, text: "again" });
    expect(await rx.waitAck(q2.id)).toMatchObject({ outcome: "delivered", mode: "inbox" });
  });

  it("a message whose words were changed while it waited in Codex's queue is still that message, by its mark", {
    timeout: 20_000,
  }, async () => {
    rollout(OWN);
    hold(OWN);
    await startDaemon({
      codexQueue: async (_bin, _thread, text) => {
        takeNow(OWN, text.replace("is the build green?", "is the build green or red?"));
        return { ok: true, said: "" };
      },
    });
    const q = await rx.send({ session: `codex:${OWN}`, text: "is the build green?" });
    expect(await rx.waitAck(q.id)).toMatchObject({
      outcome: "delivered",
      mode: "inbox",
      reply: "the window says: is the build green or red?",
    });
  });

  it("a message nobody took holds the session under both of its names", { timeout: 30_000 }, async () => {
    await startDaemon();
    const start = await rx.send({ kind: "start", session: `codex:${RECV}`, cwd: project, text: "build" });
    expect(await rx.waitAck(start.id)).toMatchObject({ outcome: "delivered", mode: "resume" });
    hold(THREAD);
    say("queue", "nobody");
    // By the name the start gave it…
    const q = await rx.send({ session: `codex:${RECV}`, text: "first" });
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "failed", code: "held" });
    // …and then by Codex's own id for it: the same thread, with the same message waiting.
    const q2 = await rx.send({ session: `codex:${THREAD}`, text: "second" });
    expect(await rx.waitAck(q2.id)).toMatchObject({
      outcome: "failed",
      detail: expect.stringMatching(/^an earlier message is still waiting in Codex's own queue/),
    });
    expect(queued()).toHaveLength(1);
  });

  it("a refused resume ran nothing: what the session's own hooks say of a turn in it stands", {
    timeout: 20_000,
  }, async () => {
    rollout(OWN);
    hold(OWN);
    say("slow", "500");
    await startDaemon();
    const q = await rx.send({ session: `codex:${OWN}`, text: "hello" });
    await until(() => runs().length === 1);
    // The window begins a turn of its own while the resume is on its way to being refused.
    await ask(sock, { op: "event", session: `codex:${OWN}`, event: "UserPromptSubmit", cwd: project }, 500);
    expect(d?.status().mid_turn).toEqual([`codex:${OWN}`]);
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered", mode: "inbox" });
    expect(d?.status().mid_turn).toEqual([`codex:${OWN}`]);
  });

  it("a session whose file cannot be found: nothing is queued blind", { timeout: 20_000 }, async () => {
    await startDaemon();
    const start = await rx.send({ kind: "start", session: `codex:${RECV}`, cwd: project, text: "build" });
    expect(await rx.waitAck(start.id)).toMatchObject({ outcome: "delivered", mode: "resume" });
    const day = path.join(tmp, "codex-home", "sessions", "2026", "11", "24");
    for (const n of readdirSync(day)) rmSync(path.join(day, n));
    hold(THREAD);
    const q = await rx.send({ session: `codex:${RECV}`, text: "and test it" });
    expect(await rx.waitAck(q.id)).toMatchObject({
      outcome: "failed",
      detail:
        "Codex has that session open in another process, and its session file was not found on this computer, so nothing was put into its queue",
    });
    expect(queued()).toHaveLength(0);
  });

  it("an ask is never queued: its own limits hold only in a turn the daemon runs", { timeout: 20_000 }, async () => {
    rollout(OWN);
    hold(OWN);
    await startDaemon();
    const got: LocalReply[] = [];
    const req: AskRequest = {
      op: "ask",
      harness: "codex",
      session: `codex:${OWN}`,
      text: "look again",
      cwd: project,
      chain: [],
    };
    const end = await askMany(sock, req, (x) => got.push(x), 15_000);
    expect(end).toEqual({
      op: "failed",
      detail:
        "Codex has that session open in another process, and an ask is not put into a live Codex session's own queue (the turn would begin there under that session's settings, not the ask's): ask again once that session is closed",
    });
    expect(queued()).toHaveLength(0);
    // The resume it tried ran under the ask's cap.
    expect(runs()[0]?.argv).toContain('sandbox_mode="workspace-write"');
  });

  it("a handoff's answer for a session a window has open goes into its queue as it is, and is relayed", {
    timeout: 20_000,
  }, async () => {
    rollout(OWN);
    hold(OWN);
    await startDaemon();
    const q = await rx.send({
      kind: "start",
      session: `codex:${RECV}`,
      cwd: project,
      text: "second opinion",
      reply_to: `codex:${OWN}`,
    });
    const ack = await rx.waitAck(q.id);
    expect(ack).toMatchObject({ outcome: "delivered", mode: "resume", reply: "codex did: second opinion" });
    const events = () => new Outbox(path.join(tmp, "state")).read({ harness: "codex", session: OWN }, 0).events;
    const ev = await until(() => (events().length === 2 ? events() : null));
    expect(ev[1]?.data).toMatchObject({ ok: true, relayed: "delivered" });
    // The answer in the handoff's own frame, with nothing of an in-place message's around it.
    expect(messageOf(queued()[0])).toBe(frameHandoff({ harness: "codex", id: RECV }, rx.url, ack.reply as string));
    // One final ack for the command, none for the relay.
    expect(rx.acks.every((a) => a.id === q.id)).toBe(true);
  });
});
