// SPDX-License-Identifier: Apache-2.0
// `cancel` (CONTROL.md §6): what a Stop stops. A headless turn the daemon is running
// as its own child process is ended (a resume, a copy, a start, a Codex turn), the
// message queued behind it still runs, and the turn's own message says it was
// cancelled; a turn in a process the daemon did not start is never signalled, and the
// ack says who has the session; a session nothing runs in is `expired`. Stand-in
// `claude` and `codex` binaries run as real child processes, so the stop is a real one.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { acpControl, claudeControl, type RunResult } from "@sessionpipe/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Carried, ControlDaemon, type DaemonDeps } from "../src/control/daemon.js";
import { ask } from "../src/control/local.js";
import { CANCEL, type CancelView, routeCancel } from "../src/control/route.js";
import type { ControlConfig, PairedReceiver } from "../src/control/store.js";
import { FakeReceiver, type Queued } from "./helpers/receiver.js";

const { CANCELLED_NOTE } = acpControl;

// Every case runs a stand-in harness as a real child process.
vi.setConfig({ testTimeout: 30_000 });

const SID = "8c132906-8c3f-4814-870a-afc3d05e1d2e";
const SESSION = `claude-code:${SID}`;
const OTHER = "5e0d1c2b-3a49-4857-9665-74839201aabb";
const COPY = "0b6f2c7e-3d4a-4f1b-9c8e-2a1d5e6f7a8b";
const NEW = "0b6f2c7e-3d4a-4f1b-9c8e-2a1d5e6f7c01";
const THREAD = "0199b6f2-7c1d-7e3a-9b4c-5d6e7f8a9b0c";
const unix = process.platform !== "win32";

let tmp: string;
let rx: FakeReceiver;
let d: ControlDaemon | null = null;
let env: NodeJS.ProcessEnv;
let sock: string;
let project: string;
let configDir: string;
let fakeClaude: string;
let fakeCodex: string;
let calls: string;
let log: string[];
let clock: () => number;

const transcriptFile = (sid: string) =>
  path.join(configDir, "projects", project.replace(/[^a-zA-Z0-9]/g, "-"), `${sid}.jsonl`);

/** A session's transcript, old enough not to read as freshly written. */
function transcript(sid: string): void {
  const f = transcriptFile(sid);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, `${JSON.stringify({ type: "user", cwd: project, message: { content: "hi" } })}\n`);
  const past = new Date(Date.now() - 600_000);
  utimesSync(f, past, past);
}

/** Every run of a stand-in harness, in the order they began. */
const runs = (): { bin: string; argv: string[]; pid: number }[] =>
  existsSync(calls)
    ? readFileSync(calls, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { bin: string; argv: string[]; pid: number })
    : [];

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const until = async (what: () => boolean, ms = 10_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error("waited too long");
    await new Promise((r) => setTimeout(r, 20));
  }
};

/** A registry row for a live process holding `sid`: this test's own pid, so it is alive. */
function holds(sid: string, kind: string | null): void {
  writeFileSync(
    path.join(configDir, "sessions", `${process.pid}.json`),
    JSON.stringify({ sessionId: sid, pid: process.pid, ...(kind ? { kind } : {}) }),
  );
}

function cfg(over: Partial<ControlConfig> = {}): ControlConfig {
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
    ...over,
  };
}

let receiver: PairedReceiver;

async function startDaemon(o: { cfg?: Partial<ControlConfig>; extra?: Partial<DaemonDeps> } = {}): Promise<void> {
  const c = cfg(o.cfg);
  receiver = c.receivers[0] as PairedReceiver;
  d = new ControlDaemon(c, path.join(tmp, "state", "control"), sock, {
    now: () => clock(),
    fetch,
    log: (s) => log.push(s),
    claudeDirs: () => [configDir],
    claude: () => ({
      bin: fakeClaude,
      caps: { hasMode: true, modes: ["default", "dontAsk"], promptsNone: false, fork: true, stream: true },
    }),
    codex: () => fakeCodex,
    run: claudeControl.runClaude,
    sdk: null,
    env,
    ...o.extra,
  });
  await d.start();
}

const cancel = (session: string) => rx.send({ kind: "cancel", session, text: undefined });
const acksOf = (id: string) => rx.acks.filter((a) => a.id === id).map((a) => a.outcome);
/** A signed command handed to the daemon this instant, as a poll would hand it: the poll
 *  loop's own timing (it looks again two seconds after a message it already has) would
 *  decide when a Stop lands, and these cases are about exactly when it lands. */
const hand = async (fields: Record<string, unknown>): Promise<Queued> => {
  const q = await rx.send(fields, { hold: true });
  void (d as ControlDaemon).handle(receiver, q as Carried);
  return q;
};
const stopNow = (session: string) => hand({ kind: "cancel", session, text: undefined });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  rx = new FakeReceiver();
  await rx.start();
});
afterAll(async () => {
  await rx.stop();
});
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "sp-cancel-"));
  project = path.join(tmp, "project");
  configDir = path.join(tmp, "claude-config");
  mkdirSync(project, { recursive: true });
  mkdirSync(path.join(configDir, "sessions"), { recursive: true });
  mkdirSync(path.join(tmp, "bin"));
  sock = path.join(mkdtempSync(path.join(os.tmpdir(), "sp-sc-")), "c.sock");
  calls = path.join(tmp, "calls.jsonl");
  fakeClaude = path.join(tmp, "bin", "claude");
  fakeCodex = path.join(tmp, "bin", "codex");
  const head = `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const a = process.argv.slice(2);
const prompt = a[a.length - 1];
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ bin: path.basename(process.argv[1]), argv: a, pid: process.pid }) + "\\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
// A turn that never ends by itself: it works until it is stopped.
const work = () => setInterval(() => {}, 1000);
// The harness's own hooks, as its worker reports them to the daemon: a turn begins, and
// ends when it ends. A child that is killed reports nothing more.
const hook = (session, event) => new Promise((done) => {
  const s = require("net").connect(process.env.SESSIONPIPE_SOCKET);
  s.on("connect", () => s.write(JSON.stringify({ op: "event", session, event }) + "\\n"));
  s.on("data", () => { s.destroy(); done(); });
  s.on("error", () => done());
});
`;
  // `claude -p --output-format stream-json`: its init line names the session (a copy's
  // new id for --fork-session), then the answer streams. "long" in the prompt is a turn
  // that says a word and keeps working; "silent" one that names nothing and says nothing.
  writeFileSync(
    fakeClaude,
    `${head}
const i = a.indexOf("--resume"), j = a.indexOf("--session-id");
const sid = a.includes("--fork-session") ? ${JSON.stringify(COPY)} : i >= 0 ? a[i + 1] : a[j + 1];
const me = "claude-code:" + sid;
// Its row in Claude Code's own session registry, as every \`claude -p\` files one.
const row = path.join(${JSON.stringify(configDir)}, "sessions", process.pid + ".json");
fs.writeFileSync(row, JSON.stringify({ pid: process.pid, sessionId: sid, kind: "print" }));
(async () => {
  await hook(me, "SessionStart");
  await hook(me, "UserPromptSubmit");
  if (/silent/.test(prompt)) return work();
  out({ type: "system", subtype: "init", session_id: sid });
  if (/long/.test(prompt)) {
    // A copy's own transcript is there once its turn is under way; "unwritten" is a copy
    // stopped before that, with nothing of it on disk.
    if (a.includes("--fork-session") && !/unwritten/.test(prompt)) {
      const file = path.join(${JSON.stringify(configDir)}, "projects", ${JSON.stringify(project)}.replace(/[^a-zA-Z0-9]/g, "-"), sid + ".jsonl");
      fs.writeFileSync(file, JSON.stringify({ type: "user", cwd: ${JSON.stringify(project)} }) + "\\n");
      const past = new Date(Date.now() - 600000);
      fs.utimesSync(file, past, past);
    }
    out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Pinging" } } });
    return work();
  }
  await hook(me, "Stop");
  await hook(me, "SessionEnd");
  fs.rmSync(row);
  out({ type: "result", result: "did it", session_id: sid, is_error: false });
})();
`,
  );
  // `codex exec --json`: the thread it picked, a first message, then work.
  writeFileSync(
    fakeCodex,
    `${head}
(async () => {
  out({ type: "thread.started", thread_id: ${JSON.stringify(THREAD)} });
  await hook("codex:" + ${JSON.stringify(THREAD)}, "UserPromptSubmit");
  out({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "On it." } });
  work();
})();
`,
  );
  chmodSync(fakeClaude, 0o755);
  chmodSync(fakeCodex, 0o755);
  log = [];
  clock = Date.now;
  env = {
    ...process.env,
    SESSIONPIPE_STATE: path.join(tmp, "state"),
    SESSIONPIPE_CONFIG: path.join(tmp, "config", "config.json"),
    SESSIONPIPE_SOCKET: sock,
    CODEX_HOME: path.join(tmp, "codex-home"),
  };
  transcript(SID);
  rx.queue.clear();
  rx.acks.length = 0;
});
afterEach(async () => {
  await d?.stop();
  d = null;
  // A run a failed case left behind is not left running.
  for (const r of runs()) if (alive(r.pid)) process.kill(r.pid, "SIGKILL");
  rmSync(path.dirname(sock), { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});

describe("what a cancel does (CONTROL.md §6)", () => {
  const view: CancelView = {
    harness: "claude-code",
    held: false,
    own: false,
    open: false,
    foreign: null,
    midTurn: false,
  };
  it("stops what is the daemon's own, in this order; says who has the rest; expires on nothing", () => {
    expect(routeCancel({ ...view, held: true, own: true, open: true })).toEqual({ stop: "held" });
    expect(routeCancel({ ...view, own: true, open: true, foreign: 7, midTurn: true })).toEqual({ stop: "own" });
    expect(routeCancel({ ...view, open: true, foreign: 7, midTurn: true })).toEqual({
      outcome: "unsupported",
      detail:
        "that session is open in Claude Code on this computer (a terminal window or the Claude app), and a turn there can only be stopped in its own window: press Esc there",
    });
    expect(routeCancel({ ...view, foreign: 4242, midTurn: true })).toEqual({
      outcome: "unsupported",
      detail:
        "a Claude Code process this computer's daemon didn't start is running that session (pid 4242), and the daemon only stops turns it runs itself: stop it where it was started",
    });
    expect(routeCancel({ ...view, midTurn: true })).toEqual({
      outcome: "unsupported",
      detail:
        "a turn is running in that session, in a process this computer's daemon didn't start and can't find: stop it where it runs",
    });
    expect(routeCancel(view)).toEqual({
      outcome: "expired",
      detail: "nothing is running in that session as far as this computer can tell, so there was nothing to stop",
    });
    // No other harness files a registry to read: its hooks' last word is not proof.
    for (const midTurn of [true, false])
      expect(routeCancel({ ...view, harness: "gemini-cli", midTurn })).toEqual({
        outcome: "unsupported",
        detail:
          "this computer's daemon isn't running that gemini-cli session, and it has no way to stop a turn it didn't start: stop it in gemini-cli itself",
      });
    expect(routeCancel({ ...view, harness: "codex", own: true })).toEqual({ stop: "own" });
  });
});

describe.runIf(unix)("a turn the daemon is running as its own child", () => {
  it("a resume: the child is ended, the turn says it was cancelled, the message queued behind it runs", async () => {
    await startDaemon();
    const long = await rx.send({ session: SESSION, text: "a long one" });
    await until(() => rx.progress(long.id).length > 0);
    // In hand behind the running turn (its own `taken` comes when its turn does).
    const queued = await rx.send({ session: SESSION, text: "and then this" });
    await new Promise((r) => setTimeout(r, 400));
    expect(acksOf(queued.id)).toEqual([]);
    const stop = await cancel(SESSION);
    // The Stop: taken while the process is ended, delivered once it is gone.
    expect(await rx.waitAck(stop.id)).toMatchObject({
      outcome: "delivered",
      mode: "resume",
      detail: "stopped the turn this computer was running for that session",
    });
    expect(acksOf(stop.id)).toEqual(["taken", "delivered"]);
    const [first] = runs();
    expect(alive(first?.pid as number)).toBe(false);
    // The turn's own message: one final ack, with what it had written.
    expect(await rx.waitAck(long.id)).toMatchObject({
      outcome: "delivered",
      mode: "resume",
      reply: `Pinging\n\n${CANCELLED_NOTE}`,
    });
    expect(CANCELLED_NOTE).toBe("(The turn was cancelled.)");
    expect(rx.acks.filter((a) => a.id === long.id && a.outcome === "delivered")).toHaveLength(1);
    // The queued message: once, after, in place.
    expect(await rx.waitAck(queued.id)).toMatchObject({ outcome: "delivered", mode: "resume", reply: "did it" });
    const all = runs();
    expect(all).toHaveLength(2);
    expect(all[1]?.argv).toEqual(expect.arrayContaining(["--resume", SID]));
    expect(all[1]?.argv).not.toContain("--fork-session");
    expect(log.some((l) => l.includes(`stopping ${long.id.slice(-8)}`))).toBe(true);
    // Nothing is running now: a second Stop finds nothing to stop.
    const again = await cancel(SESSION);
    expect(await rx.waitAck(again.id)).toMatchObject({ outcome: "expired", detail: CANCEL.nothing });
  });

  it("the stopped child reports no end, and the session is not left mid-turn: a message for it goes straight through, and so does one that was already waiting for its Stop", async () => {
    // The daemon's own run in a session's copy, with the hooks a real child fires: its
    // UserPromptSubmit marks the copy mid-turn, and a child that is killed never unmarks it.
    transcript(COPY);
    mkdirSync(path.join(tmp, "state", "control"), { recursive: true });
    writeFileSync(
      path.join(tmp, "state", "control", "state.json"),
      JSON.stringify({ copies: { [SID]: COPY }, copies_v2: { [SID]: { id: COPY, at: "", reason: "" } } }),
    );
    await startDaemon();
    const long = await hand({ session: SESSION, text: "a long one" });
    await until(() => rx.progress(long.id).length > 0);
    expect(d?.status().mid_turn).toEqual([`claude-code:${COPY}`]);
    // Sent to the copy by its own name while that turn runs: it waits for the copy's Stop.
    const forCopy = await hand({ session: `claude-code:${COPY}`, text: "to the copy itself" });
    await until(() => acksOf(forCopy.id).includes("taken"));
    const stop = await stopNow(SESSION);
    expect(await rx.waitAck(stop.id)).toMatchObject({ outcome: "delivered", mode: "resume" });
    expect(await rx.waitAck(long.id)).toMatchObject({ outcome: "delivered", reply: `Pinging\n\n${CANCELLED_NOTE}` });
    // No Stop is coming. The message that waited for one runs now, not in half an hour…
    expect(await rx.waitAck(forCopy.id)).toMatchObject({ outcome: "delivered", mode: "resume", reply: "did it" });
    expect(d?.status().mid_turn).toEqual([]);
    // …the next one is not parked behind a turn that is over…
    const next = await hand({ session: SESSION, text: "and this" });
    expect(await rx.waitAck(next.id)).toMatchObject({ outcome: "delivered", mode: "resume", reply: "did it" });
    // …and a Stop now finds nothing running, not a turn in a process nobody can find.
    const again = await stopNow(SESSION);
    expect(await rx.waitAck(again.id)).toMatchObject({ outcome: "expired", detail: CANCEL.nothing });
    expect(runs().map((x) => x.argv[x.argv.indexOf("--resume") + 1])).toEqual([COPY, COPY, COPY]);
  });

  it("a Stop addressed to the copy the turn runs in stops it: the copy is where the person was sent", async () => {
    // The fork's ack names the copy in `session`, and its hooks put it on the board
    // under its own id: that is the page a person presses Stop on.
    transcript(COPY);
    mkdirSync(path.join(tmp, "state", "control"), { recursive: true });
    writeFileSync(
      path.join(tmp, "state", "control", "state.json"),
      JSON.stringify({ copies: { [SID]: COPY }, copies_v2: { [SID]: { id: COPY, at: "", reason: "" } } }),
    );
    await startDaemon();
    const long = await hand({ session: SESSION, text: "a long one" });
    await until(() => rx.progress(long.id).length > 0);
    const child = runs()[0]?.pid as number;
    const stop = await stopNow(`claude-code:${COPY}`);
    const ack = await rx.waitAck(stop.id);
    // Not "a Claude Code process this computer's daemon didn't start (pid …)": it is its own.
    expect(ack).toMatchObject({ outcome: "delivered", mode: "resume", detail: CANCEL.stopped });
    expect(String(ack.detail)).not.toContain(String(child));
    expect(alive(child)).toBe(false);
    expect(await rx.waitAck(long.id)).toMatchObject({ outcome: "delivered", reply: `Pinging\n\n${CANCELLED_NOTE}` });
  });

  it("a Stop addressed to a copy that is still being made stops the run that is making it", async () => {
    holds(SID, "interactive");
    await startDaemon();
    const long = await hand({ session: SESSION, text: "a long one" });
    // The new copy has named itself (its init line), and its hooks have reported under that name.
    await until(() => rx.progress(long.id).length > 0);
    const stop = await stopNow(`claude-code:${COPY}`);
    expect(await rx.waitAck(stop.id)).toMatchObject({ outcome: "delivered", mode: "fork", detail: CANCEL.stopped });
    expect(await rx.waitAck(long.id)).toMatchObject({
      outcome: "delivered",
      mode: "fork",
      session: `claude-code:${COPY}`,
      reply: `Pinging\n\n${CANCELLED_NOTE}`,
    });
  });

  it("a turn that said nothing yet answers with the note alone; a turn waiting for its slot never starts", async () => {
    transcript(OTHER);
    await startDaemon({ cfg: { limits: { headless: 1 } } });
    const busy = await rx.send({ session: SESSION, text: "silent work" });
    await until(() => runs().length === 1);
    // The one slot is taken: this one waits for it, and is stopped there.
    const waiting = await rx.send({ session: `claude-code:${OTHER}`, text: "a long one" });
    await until(() => acksOf(waiting.id).includes("taken"));
    // Stopped at once, not when the slot comes free.
    const stopWaiting = await cancel(`claude-code:${OTHER}`);
    expect(await rx.waitAck(stopWaiting.id)).toMatchObject({ outcome: "delivered", mode: "resume" });
    expect(await rx.waitAck(waiting.id)).toMatchObject({ outcome: "delivered", mode: "resume", reply: CANCELLED_NOTE });
    expect(alive(runs()[0]?.pid as number)).toBe(true);
    const stopBusy = await cancel(SESSION);
    expect(await rx.waitAck(stopBusy.id)).toMatchObject({ outcome: "delivered", mode: "resume" });
    expect(await rx.waitAck(busy.id)).toMatchObject({ outcome: "delivered", mode: "resume", reply: CANCELLED_NOTE });
    // The slot it never used went back: the next turn runs.
    const next = await rx.send({ session: `claude-code:${OTHER}`, text: "now" });
    expect(await rx.waitAck(next.id)).toMatchObject({ outcome: "delivered", mode: "resume", reply: "did it" });
    expect(runs().map((x) => x.argv[x.argv.indexOf("--resume") + 1])).toEqual([SID, OTHER]);
  });

  it("a copy stopped after it named itself is still the session's copy, and the ack says so", async () => {
    holds(SID, "interactive");
    await startDaemon();
    const long = await rx.send({ session: SESSION, text: "a long one" });
    await until(() => rx.progress(long.id).length > 0);
    const stop = await cancel(SESSION);
    expect(await rx.waitAck(stop.id)).toMatchObject({ outcome: "delivered", mode: "fork", detail: CANCEL.stopped });
    const ack = await rx.waitAck(long.id);
    expect(ack).toMatchObject({
      outcome: "delivered",
      mode: "fork",
      session: `claude-code:${COPY}`,
      copy_of: SESSION,
      reply: `Pinging\n\n${CANCELLED_NOTE}`,
    });
    // The next message goes to that copy: not a second one.
    const next = await rx.send({ session: SESSION, text: "carry on" });
    expect(await rx.waitAck(next.id)).toMatchObject({ outcome: "delivered", mode: "resume" });
    expect(runs()[1]?.argv).toEqual(expect.arrayContaining(["--resume", COPY]));
  });

  it("a copy that named itself and was stopped before it wrote anything is not the session's copy: there is nothing to resume", async () => {
    holds(SID, "interactive");
    await startDaemon();
    const long = await hand({ session: SESSION, text: "a long unwritten one" });
    await until(() => rx.progress(long.id).length > 0);
    const stop = await stopNow(SESSION);
    expect(await rx.waitAck(stop.id)).toMatchObject({ outcome: "delivered", mode: "fork" });
    const ack = await rx.waitAck(long.id);
    expect(ack).toMatchObject({ outcome: "delivered", mode: "fork", reply: `Pinging\n\n${CANCELLED_NOTE}` });
    // No copy is named: none exists on this machine.
    expect(ack.session).toBeUndefined();
    expect(ack.copy_of).toBeUndefined();
    expect(existsSync(path.join(tmp, "state", "control", "state.json"))).toBe(false);
    // The next message is not sent to resume a session that is not there (every message
    // after it would fail the same way): the session is still open, so it is copied afresh.
    const next = await hand({ session: SESSION, text: "carry on" });
    expect(await rx.waitAck(next.id)).toMatchObject({ outcome: "delivered", mode: "fork", copy_of: SESSION });
    expect(runs()[1]?.argv).toEqual(expect.arrayContaining(["--resume", SID, "--fork-session"]));
  });

  it("a copy stopped before it named itself made none that anything knows of", async () => {
    holds(SID, "interactive");
    await startDaemon();
    const silent = await rx.send({ session: SESSION, text: "silent work" });
    await until(() => runs().length === 1);
    const stop = await cancel(SESSION);
    expect(await rx.waitAck(stop.id)).toMatchObject({ outcome: "delivered", mode: "fork" });
    const ack = await rx.waitAck(silent.id);
    expect(ack).toMatchObject({ outcome: "delivered", mode: "fork", reply: CANCELLED_NOTE });
    expect(ack.session).toBeUndefined();
    expect(ack.copy_of).toBeUndefined();
    expect(ack.detail).toBeUndefined();
  });

  it("a start: the new session's first turn is stopped, and its start is acked with what it ran with", async () => {
    await startDaemon();
    const start = await rx.send({ kind: "start", session: `claude-code:${NEW}`, cwd: project, text: "a long one" });
    await until(() => rx.progress(start.id).length > 0);
    const stop = await cancel(`claude-code:${NEW}`);
    // No transcript yet (the stand-in writes none): the Stop still finds the run.
    expect(await rx.waitAck(stop.id)).toMatchObject({ outcome: "delivered", mode: "resume", detail: CANCEL.stopped });
    expect(await rx.waitAck(start.id)).toMatchObject({
      outcome: "delivered",
      mode: "resume",
      reply: `Pinging\n\n${CANCELLED_NOTE}`,
      applied: { permission: "safe" },
    });
  });

  it("a Codex turn: stopped the same way, with the messages it had finished", async () => {
    await startDaemon();
    const RECV = "0b6f2c7e-3d4a-4f1b-9c8e-2a1d5e6f7e01";
    const start = await rx.send({ kind: "start", session: `codex:${RECV}`, cwd: project, text: "go" });
    await until(() => rx.progress(start.id).length > 0);
    const stop = await cancel(`codex:${RECV}`);
    expect(await rx.waitAck(stop.id)).toMatchObject({ outcome: "delivered", mode: "resume", detail: CANCEL.stopped });
    expect(await rx.waitAck(start.id)).toMatchObject({
      outcome: "delivered",
      mode: "resume",
      reply: `On it.\n\n${CANCELLED_NOTE}`,
    });
    expect(alive(runs()[0]?.pid as number)).toBe(false);
  });

  it("a turn that ended by itself before the stop took effect: the cancel expired, the answer stands", async () => {
    // A runner that cannot be stopped (it never looks at the signal), ending on its own.
    let asked = false;
    await startDaemon({
      extra: {
        run: (_bin, _args, o) =>
          new Promise<RunResult>((resolve) => {
            asked = true;
            o.signal?.addEventListener("abort", () =>
              setTimeout(() => resolve({ code: 0, signal: null, stdout: '{"type":"result","result":"all done"}' }), 50),
            );
          }),
      },
    });
    const q = await rx.send({ session: SESSION, text: "nearly there" });
    await until(() => asked);
    const stop = await cancel(SESSION);
    expect(await rx.waitAck(stop.id)).toMatchObject({
      outcome: "expired",
      detail: "the turn this computer was running for that session finished before it could be stopped",
    });
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered", mode: "resume", reply: "all done" });
  });
});

describe.runIf(unix)("a turn the daemon has in hand and has not started yet", () => {
  /** A login check that takes its time, as an uncached `claude auth status` does. */
  const slowLogin = (asked: { n: number }) => async () => {
    asked.n++;
    await sleep(700);
    return { loggedIn: true };
  };

  it("a Stop while a message's turn is being prepared: the turn never starts, and the Stop says it stopped it", async () => {
    const asked = { n: 0 };
    await startDaemon({ extra: { login: slowLogin(asked) } });
    const q = await hand({ session: SESSION, text: "a long one" });
    await until(() => asked.n === 1);
    const stop = await stopNow(SESSION);
    // At once: not when the login check comes back.
    const t0 = Date.now();
    expect(await rx.waitAck(stop.id)).toMatchObject({ outcome: "delivered", detail: CANCEL.stopped });
    expect(Date.now() - t0).toBeLessThan(500);
    expect(acksOf(stop.id)).toEqual(["taken", "delivered"]);
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered", reply: CANCELLED_NOTE });
    // The check answers, and nothing runs after all.
    await sleep(1000);
    expect(runs()).toEqual([]);
    expect(rx.acks.filter((a) => a.id === q.id && a.outcome !== "taken")).toHaveLength(1);
    // The session is as it was: the next message runs in it.
    const next = await hand({ session: SESSION, text: "and now" });
    expect(await rx.waitAck(next.id)).toMatchObject({ outcome: "delivered", mode: "resume", reply: "did it" });
    expect(runs()).toHaveLength(1);
  });

  it("a Stop while a message's files are being fetched: the same, and nothing is handed to the session", async () => {
    const png = await rx.upload("shot.png", "image/png", new Uint8Array(1024).fill(3));
    const slowFiles: typeof fetch = async (input, init) => {
      if (String(input instanceof Request ? input.url : input).includes("/files/")) await sleep(700);
      return fetch(input, init);
    };
    await startDaemon({ extra: { fetch: slowFiles } });
    const q = await hand({ session: SESSION, text: "look at this", files: [png] });
    await until(() => acksOf(q.id).includes("taken"));
    const stop = await stopNow(SESSION);
    expect(await rx.waitAck(stop.id)).toMatchObject({ outcome: "delivered", detail: CANCEL.stopped });
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered", reply: CANCELLED_NOTE });
    await sleep(1000);
    expect(runs()).toEqual([]);
  });

  it("a Stop while a new session's start is being prepared: no session is created, and the start says so", async () => {
    const asked = { n: 0 };
    await startDaemon({ extra: { login: slowLogin(asked) } });
    const start = await hand({ kind: "start", session: `claude-code:${NEW}`, cwd: project, text: "a long one" });
    await until(() => asked.n === 1);
    const stop = await stopNow(`claude-code:${NEW}`);
    expect(await rx.waitAck(stop.id)).toMatchObject({ outcome: "delivered", detail: CANCEL.stopped });
    // Nothing began, so nothing was delivered: the receiver's page must not show a
    // session at work that was never created.
    expect(await rx.waitAck(start.id)).toMatchObject({
      outcome: "failed",
      code: "cancelled",
      detail: "stopped before it started, as asked: no session was created",
    });
    await sleep(1000);
    expect(runs()).toEqual([]);
    const next = await hand({ session: `claude-code:${NEW}`, text: "are you there?" });
    expect(await rx.waitAck(next.id)).toMatchObject({ outcome: "refused", code: "no_session" });
  });

  it("the same for a Codex start, and for a start whose files are still on their way", async () => {
    const png = await rx.upload("shot.png", "image/png", new Uint8Array(1024).fill(3));
    const slowFiles: typeof fetch = async (input, init) => {
      if (String(input instanceof Request ? input.url : input).includes("/files/")) await sleep(700);
      return fetch(input, init);
    };
    let asked = 0;
    await startDaemon({
      extra: {
        fetch: slowFiles,
        codexLogin: async () => {
          asked++;
          await sleep(700);
          return { loggedIn: true };
        },
      },
    });
    const RECV = "0b6f2c7e-3d4a-4f1b-9c8e-2a1d5e6f7e02";
    const codex = await hand({ kind: "start", session: `codex:${RECV}`, cwd: project, text: "go" });
    await until(() => asked === 1);
    const stopCodex = await stopNow(`codex:${RECV}`);
    expect(await rx.waitAck(stopCodex.id)).toMatchObject({ outcome: "delivered", detail: CANCEL.stopped });
    expect(await rx.waitAck(codex.id)).toMatchObject({ outcome: "failed", code: "cancelled" });
    const withFile = await hand({
      kind: "start",
      session: `claude-code:${NEW}`,
      cwd: project,
      text: "a long one",
      files: [png],
    });
    await until(() => acksOf(withFile.id).includes("taken"));
    const stop = await stopNow(`claude-code:${NEW}`);
    expect(await rx.waitAck(stop.id)).toMatchObject({ outcome: "delivered", detail: CANCEL.stopped });
    expect(await rx.waitAck(withFile.id)).toMatchObject({ outcome: "failed", code: "cancelled" });
    await sleep(1000);
    expect(runs()).toEqual([]);
  });

  it("starts that wait for a slot, and a Codex start waiting for its files: stopped there, nothing started", async () => {
    const png = await rx.upload("shot.png", "image/png", new Uint8Array(1024).fill(3));
    const slowFiles: typeof fetch = async (input, init) => {
      if (String(input instanceof Request ? input.url : input).includes("/files/")) await sleep(700);
      return fetch(input, init);
    };
    await startDaemon({ cfg: { limits: { headless: 1 } }, extra: { fetch: slowFiles } });
    const RECV = "0b6f2c7e-3d4a-4f1b-9c8e-2a1d5e6f7e03";
    // Its files are still on their way.
    const withFile = await hand({ kind: "start", session: `codex:${RECV}`, cwd: project, text: "go", files: [png] });
    await until(() => acksOf(withFile.id).includes("taken"));
    const stopFile = await stopNow(`codex:${RECV}`);
    expect(await rx.waitAck(stopFile.id)).toMatchObject({ outcome: "delivered", detail: CANCEL.stopped });
    expect(await rx.waitAck(withFile.id)).toMatchObject({ outcome: "failed", code: "cancelled" });
    // The one slot is taken by another session's turn: both starts wait for it.
    const busy = await hand({ session: SESSION, text: "silent work" });
    await until(() => runs().length === 1);
    const claude = await hand({ kind: "start", session: `claude-code:${NEW}`, cwd: project, text: "a long one" });
    const OTHER_RECV = "0b6f2c7e-3d4a-4f1b-9c8e-2a1d5e6f7e04";
    const codex = await hand({ kind: "start", session: `codex:${OTHER_RECV}`, cwd: project, text: "go" });
    await until(() => acksOf(claude.id).includes("taken") && acksOf(codex.id).includes("taken"));
    for (const [start, session] of [
      [claude, `claude-code:${NEW}`],
      [codex, `codex:${OTHER_RECV}`],
    ] as const) {
      const stop = await stopNow(session);
      expect(await rx.waitAck(stop.id)).toMatchObject({ outcome: "delivered", mode: "resume", detail: CANCEL.stopped });
      expect(await rx.waitAck(start.id)).toMatchObject({
        outcome: "failed",
        code: "cancelled",
        detail: CANCEL.unstarted,
      });
    }
    expect(runs()).toHaveLength(1);
    const stopBusy = await stopNow(SESSION);
    expect(await rx.waitAck(stopBusy.id)).toMatchObject({ outcome: "delivered" });
    expect(await rx.waitAck(busy.id)).toMatchObject({ outcome: "delivered", reply: CANCELLED_NOTE });
  });

  it("a message to a Codex session, stopped while Codex's login is checked: it never runs", async () => {
    let now = Date.now();
    clock = () => now;
    let slow = false;
    let asked = 0;
    await startDaemon({
      extra: {
        codexLogin: async () => {
          asked++;
          if (slow) await sleep(700);
          return { loggedIn: true };
        },
      },
    });
    const RECV = "0b6f2c7e-3d4a-4f1b-9c8e-2a1d5e6f7e05";
    const start = await hand({ kind: "start", session: `codex:${RECV}`, cwd: project, text: "go" });
    await until(() => rx.progress(start.id).length > 0);
    const stopStart = await stopNow(`codex:${RECV}`);
    expect(await rx.waitAck(stopStart.id)).toMatchObject({ outcome: "delivered" });
    expect(await rx.waitAck(start.id)).toMatchObject({ outcome: "delivered", reply: `On it.\n\n${CANCELLED_NOTE}` });
    // The login is asked about again after ten minutes, and this time it takes a while.
    now += 11 * 60_000;
    slow = true;
    const q = await hand({ session: `codex:${RECV}`, text: "and now this" });
    await until(() => asked === 2);
    const stop = await stopNow(`codex:${RECV}`);
    expect(await rx.waitAck(stop.id)).toMatchObject({ outcome: "delivered", mode: "resume", detail: CANCEL.stopped });
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered", mode: "resume", reply: CANCELLED_NOTE });
    await sleep(1000);
    expect(runs()).toHaveLength(1);
  });

  it("a Stop for a session being started goes to the start that is running, not to the message waiting behind it", async () => {
    await startDaemon();
    const start = await hand({ kind: "start", session: `claude-code:${NEW}`, cwd: project, text: "a long one" });
    await until(() => rx.progress(start.id).length > 0);
    // The stand-in writes no transcript: the message waits for the start to say where it is.
    const waiting = await hand({ session: `claude-code:${NEW}`, text: "and then this" });
    await until(() => acksOf(waiting.id).includes("taken"));
    const stop = await stopNow(`claude-code:${NEW}`);
    expect(await rx.waitAck(stop.id)).toMatchObject({ outcome: "delivered", mode: "resume", detail: CANCEL.stopped });
    expect(acksOf(stop.id)).toEqual(["taken", "delivered"]);
    expect(await rx.waitAck(start.id)).toMatchObject({ outcome: "delivered", reply: `Pinging\n\n${CANCELLED_NOTE}` });
    // The message behind it was not cancelled; the start left no session for it.
    expect(await rx.waitAck(waiting.id)).toMatchObject({ outcome: "refused", code: "no_session" });
  });
});

describe.runIf(unix)("a turn in a process the daemon did not start", () => {
  it("open in its own window: unsupported, with the way to stop it; nothing is signalled", async () => {
    holds(SID, "interactive");
    await startDaemon();
    await ask(sock, { op: "event", session: SESSION, event: "UserPromptSubmit" }, 500);
    const kill = vi.spyOn(process, "kill");
    const stop = await cancel(SESSION);
    expect(await rx.waitAck(stop.id)).toMatchObject({ outcome: "unsupported", detail: CANCEL.open });
    expect(acksOf(stop.id)).toEqual(["unsupported"]);
    // Only ever asked whether a pid is alive (signal 0).
    expect(kill.mock.calls.every((c) => c[1] === 0)).toBe(true);
    kill.mockRestore();
    expect(log.some((l) => l.includes("nothing stopped") && l.includes("press Esc"))).toBe(true);
  });

  it("someone else's headless run: unsupported, naming the process", async () => {
    holds(SID, null);
    await startDaemon();
    const stop = await cancel(SESSION);
    expect(await rx.waitAck(stop.id)).toMatchObject({
      outcome: "unsupported",
      detail: CANCEL.foreign(process.pid),
    });
  });

  it("the copy is the one open: the Stop for its session says so too", async () => {
    transcript(COPY);
    mkdirSync(path.join(tmp, "state", "control"), { recursive: true });
    writeFileSync(
      path.join(tmp, "state", "control", "state.json"),
      JSON.stringify({ copies: { [SID]: COPY }, copies_v2: { [SID]: { id: COPY, at: "", reason: "" } } }),
    );
    holds(COPY, "interactive");
    await startDaemon();
    const stop = await cancel(SESSION);
    expect(await rx.waitAck(stop.id)).toMatchObject({ outcome: "unsupported", detail: CANCEL.open });
  });

  it("a turn its hooks reported and no process to be found: unsupported; silent for ten minutes: nothing runs", async () => {
    let now = Date.now();
    clock = () => now;
    await startDaemon();
    await ask(sock, { op: "event", session: SESSION, event: "UserPromptSubmit" }, 500);
    const stop = await cancel(SESSION);
    expect(await rx.waitAck(stop.id)).toMatchObject({ outcome: "unsupported", detail: CANCEL.unseen });
    // A session killed mid-turn never sends its Stop: ten silent minutes later it is not one.
    now += 10 * 60_000 + 1;
    const later = await cancel(SESSION);
    expect(await rx.waitAck(later.id)).toMatchObject({ outcome: "expired", detail: CANCEL.nothing });
  });

  it("another harness's session: unsupported, in its own name", async () => {
    await startDaemon();
    await ask(sock, { op: "event", session: "gemini-cli:conf-1", event: "BeforeAgent", cwd: project }, 500);
    const stop = await cancel("gemini-cli:conf-1");
    expect(await rx.waitAck(stop.id)).toMatchObject({ outcome: "unsupported", detail: CANCEL.other("gemini-cli") });
  });
});
