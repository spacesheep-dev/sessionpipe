// SPDX-License-Identifier: Apache-2.0
// What an ask does when something goes wrong around it (CONTROL.md §13): the daemon
// stopped while a child still runs, a child that exits without a word, the headless slot
// and the start caps shared with a receiver's commands, an asker whose process went away
// mid-run or that nobody here knows, two asks at once from one session, asking turned
// off while one is in hand, and a receiver that tries to carry an ask as a command.
// control-ask.test.ts pins the happy paths and the refusals in order; this file pins
// that none of these leave the daemon stuck, crashed or holding a message it can't
// finish. The Codex stand-in takes its behaviour from a file beside it, so one fake
// serves every case.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, Outbox, runHeadless, writeConfig } from "@sessionpipe/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ControlDaemon, type DaemonDeps } from "../src/control/daemon.js";
import { type AskRequest, ask, askMany, type LocalReply } from "../src/control/local.js";
import type { ControlConfig } from "../src/control/store.js";
import { FakeReceiver } from "./helpers/receiver.js";

const THREAD = "0199b6f2-7c1d-7e3a-9b4c-5d6e7f8a9b0c";
const SID = "8c132906-8c3f-4814-870a-afc3d05e1d2e";
const ASKER = `claude-code:${SID}`;
const RECV = "0b6f2c7e-3d4a-4f1b-9c8e-2a1d5e6f7e01";
const unix = process.platform !== "win32";

/** How the stand-in behaves, read from `modeFile` when it starts. */
type Mode = "answer" | "silent-fail" | "silent-ok" | "killed";

let tmp: string;
let rx: FakeReceiver;
let d: ControlDaemon | null = null;
let env: NodeJS.ProcessEnv;
let sock: string;
let project: string;
let configDir: string;
let calls: string;
let modeFile: string;
let fakeCodex: string;
let fakeClaude: string;

/** The Codex stand-in logs how and when it was run; the turn takes 600 ms in `answer`
 *  mode, so a run is in flight long enough to meet whatever arrives meanwhile. */
function writeFakes(): void {
  writeFileSync(
    fakeCodex,
    `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const a = process.argv.slice(2);
const mode = fs.existsSync(${JSON.stringify(modeFile)}) ? fs.readFileSync(${JSON.stringify(modeFile)}, "utf8").trim() : "answer";
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ bin: "codex", t: Date.now(), cwd: process.cwd(),
  asked_by: process.env.SESSIONPIPE_ASKED_BY || null, chain: process.env.SESSIONPIPE_ASK_CHAIN || null }) + "\\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const resume = a[1] === "resume";
const id = resume ? a[a.indexOf("--") + 1] : ${JSON.stringify(THREAD)};
if (mode === "silent-fail") { process.stderr.write("no model available\\n"); process.exit(1); }
if (mode === "silent-ok") process.exit(0);
if (mode === "killed") process.kill(process.pid, "SIGTERM");
if (!resume) {
  const day = path.join(process.env.CODEX_HOME, "sessions", "2026", "10", "28");
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, "rollout-2026-10-28T10-00-00-" + id + ".jsonl"),
    JSON.stringify({ type: "session_meta", payload: { id, cwd: process.cwd() } }) + "\\n");
}
out({ type: "thread.started", thread_id: id });
out({ type: "turn.started" });
setTimeout(() => {
  out({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "codex did: " + a[a.length - 1].split("\\n")[0] } });
  out({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
}, 600);
`,
  );
  writeFileSync(
    fakeClaude,
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "result", result: "claude did it", session_id: "x", is_error: false }));
`,
  );
  chmodSync(fakeCodex, 0o755);
  chmodSync(fakeClaude, 0o755);
}

interface Run {
  bin: string;
  t: number;
  cwd: string;
  asked_by: string | null;
  chain: string | null;
}
const runs = (): Run[] =>
  existsSync(calls)
    ? readFileSync(calls, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Run)
    : [];
const mode = (m: Mode) => writeFileSync(modeFile, m);

interface Setup {
  receivers?: boolean;
  ask?: boolean;
  limits?: ControlConfig["limits"];
  extra?: Partial<DaemonDeps>;
}

function cfg(o: Setup): ControlConfig {
  return {
    name: "testbox",
    folders: [project],
    mode: "safe",
    receivers: o.receivers
      ? [
          {
            url: rx.url,
            control: `${rx.url}/api/sessionpipe/v1/control`,
            rpId: "localhost",
            machine: rx.machine,
            token: rx.token,
            keys: [{ ...rx.passkey.key, added_at: new Date().toISOString() }],
            paired_at: new Date().toISOString(),
          },
        ]
      : [],
    ...(o.ask !== undefined ? { ask: o.ask } : {}),
    ...(o.limits ? { limits: o.limits } : {}),
  };
}

async function startDaemon(o: Setup = {}): Promise<ControlDaemon> {
  const daemon = new ControlDaemon(cfg(o), path.join(tmp, "state", "control"), sock, {
    now: Date.now,
    fetch,
    log: process.env.SP_DEBUG ? (s: string) => console.error(`[daemon] ${s}`) : () => {},
    claudeDirs: () => [configDir],
    claude: () => ({
      bin: fakeClaude,
      caps: { hasMode: true, modes: ["default", "dontAsk"], promptsNone: false, fork: true },
    }),
    codex: () => fakeCodex,
    run: runHeadless,
    env,
    answerWaitMs: 5000,
    ...o.extra,
  });
  await daemon.start();
  d = daemon;
  return daemon;
}

const req = (over: Partial<AskRequest> = {}): AskRequest => ({
  op: "ask",
  harness: "codex",
  text: "review this",
  cwd: project,
  chain: [],
  from: ASKER,
  ...over,
});

/** One ask, every reply in order, and the one that ended it. */
async function askIt(r: AskRequest, timeoutMs = 15_000) {
  const got: LocalReply[] = [];
  const end = await askMany(sock, r, (x) => got.push(x), timeoutMs);
  return { got, end };
}

/** An ask whose first reply is awaited apart from its end: the run is in flight between. */
function askUntilTaken(r: AskRequest) {
  let begun!: (v: LocalReply) => void;
  const taken = new Promise<LocalReply>((res) => {
    begun = res;
  });
  const got: LocalReply[] = [];
  const end = askMany(
    sock,
    r,
    (x) => {
      got.push(x);
      if (x.op === "asked") begun(x);
    },
    15_000,
  );
  return { taken, end, got };
}

const events = (harness: string, id: string) =>
  new Outbox(path.join(tmp, "state")).read({ harness, session: id }, 0).events;

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
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sp-askf-")));
  project = path.join(tmp, "project");
  configDir = path.join(tmp, "claude-config");
  mkdirSync(project, { recursive: true });
  mkdirSync(path.join(configDir, "sessions"), { recursive: true });
  mkdirSync(path.join(tmp, "bin"));
  sock = path.join(tmp, "control.sock");
  calls = path.join(tmp, "calls.jsonl");
  modeFile = path.join(tmp, "mode");
  fakeCodex = path.join(tmp, "bin", "codex");
  fakeClaude = path.join(tmp, "bin", "claude");
  writeFakes();
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
  writeConfig({ ...DEFAULT_CONFIG, machine: "testbox", sinks: [] }, env.SESSIONPIPE_CONFIG);
  rx.queue.clear();
  rx.acks.length = 0;
  rx.hellos.length = 0;
});
afterEach(async () => {
  await d?.stop();
  d = null;
  // A child the stand-in left running (a stopped daemon's) ends within its 600 ms turn.
  await new Promise((r) => setTimeout(r, 700));
  rmSync(tmp, { recursive: true, force: true });
});

describe.runIf(unix)("the child exits without an answer", () => {
  it("exit 1 having said nothing: failed, with the exit and stderr's tail; the asker's events say so; nothing stays in hand", async () => {
    const daemon = await startDaemon();
    mode("silent-fail");
    const { got, end } = await askIt(req());
    expect(got.map((r) => r.op)).toEqual(["asked", "failed"]);
    expect(end).toEqual({ op: "failed", detail: "Codex exited (code 1) without an answer: no model available" });
    const ev = await until(() => (events("claude-code", SID).length === 2 ? events("claude-code", SID) : null));
    expect(ev[1]?.data).toMatchObject({
      ok: false,
      error: "Codex exited (code 1) without an answer: no model available",
    });
    expect(ev[1]?.data).not.toHaveProperty("reply");
    expect(daemon.busy()).toBeNull();
    expect(daemon.status().delivered).toEqual({ failed: 1 });
    expect(daemon.status().acks_pending).toBe(0);
  });

  it("exit 0 having said nothing: an answer that says so, as a receiver's delivered ack would carry it", async () => {
    await startDaemon();
    mode("silent-ok");
    const { got, end } = await askIt(req());
    expect(got.map((r) => r.op)).toEqual(["asked", "answer"]);
    expect(end).toMatchObject({ op: "answer", text: "(Codex finished without a written reply.)" });
    expect(d?.busy()).toBeNull();
  });

  it("killed by a signal: failed, naming the signal; the next ask runs as if nothing happened", async () => {
    await startDaemon();
    mode("killed");
    const { end } = await askIt(req());
    expect(end).toMatchObject({
      op: "failed",
      detail: expect.stringMatching(/^Codex exited \(SIGTERM\) without an answer/),
    });
    mode("answer");
    expect((await askIt(req())).end).toMatchObject({ op: "answer", text: expect.stringContaining("codex did:") });
    expect(d?.status().delivered).toEqual({ failed: 1, resume: 1 });
  });
});

describe.runIf(unix)("the daemon stops mid-ask", () => {
  it("the asker's connection ends at once with no final reply; stop() doesn't wait on the child; a new daemon on the same socket serves the next ask", async () => {
    const first = await startDaemon();
    const pending = askUntilTaken(req());
    await pending.taken;
    await until(() => runs().length === 1);
    expect(first.busy()).toBe("1 message(s) in hand");
    const t0 = Date.now();
    await first.stop();
    expect(Date.now() - t0).toBeLessThan(500);
    // Nothing ended the ask: the wire says null, and the CLI turns that into "the daemon went away".
    expect(await pending.end).toBeNull();
    expect(pending.got.map((r) => r.op)).toEqual(["asked"]);
    // The orphaned child ends its turn; the old daemon's bookkeeping lands without throwing.
    const ev = await until(() => (events("claude-code", SID).length === 2 ? events("claude-code", SID) : null));
    expect(ev[1]?.data).toMatchObject({ ask_id: (pending.got[0] as { ask_id: string }).ask_id, ok: true });
    const second = await startDaemon();
    const { end } = await askIt(req({ text: "again" }));
    expect(end).toMatchObject({ op: "answer", text: expect.stringContaining("codex did: again") });
    expect(second.busy()).toBeNull();
    expect(runs()).toHaveLength(2);
  });

  it("asking turned off while one is in hand: that one finishes; the next is refused", async () => {
    const daemon = await startDaemon();
    const pending = askUntilTaken(req());
    await pending.taken;
    daemon.reload(cfg({ ask: false }));
    expect(daemon.status().ask.on).toBe(false);
    expect(await pending.end).toMatchObject({ op: "answer" });
    expect((await askIt(req())).end).toMatchObject({ op: "refused", code: "ask_off" });
    expect(runs()).toHaveLength(1);
  });
});

describe.runIf(unix)("the headless slot and the start caps are the receiver's", () => {
  it("a receiver's start holds the one slot: the ask is taken at once, its child starts when that one ends", {
    timeout: 20_000,
  }, async () => {
    await startDaemon({ receivers: true, limits: { headless: 1 } });
    const q = await rx.send({ kind: "start", session: `codex:${RECV}`, cwd: project, text: "first" });
    await until(() => runs().length === 1);
    const pending = askUntilTaken(req({ text: "second" }));
    const asked = await pending.taken;
    expect(asked.op).toBe("asked");
    // Taken, but not running: the slot is the receiver's until its child exits.
    await new Promise((r) => setTimeout(r, 200));
    expect(runs()).toHaveLength(1);
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered" });
    expect(await pending.end).toMatchObject({ op: "answer", text: expect.stringContaining("codex did: second") });
    const [a, b] = runs();
    expect(b!.t - a!.t).toBeGreaterThanOrEqual(550);
    expect(d?.busy()).toBeNull();
  });

  it("start_concurrent reached by a receiver's start: the ask is refused start_limit before it begins, and counted on the asker", {
    timeout: 20_000,
  }, async () => {
    await startDaemon({ receivers: true, limits: { start_concurrent: 1 } });
    const q = await rx.send({ kind: "start", session: `codex:${RECV}`, cwd: project, text: "first" });
    await until(() => runs().length === 1);
    const { got, end } = await askIt(req());
    expect(got.map((r) => r.op)).toEqual(["refused"]);
    expect(end).toMatchObject({
      code: "start_limit",
      detail: "this machine is already starting 1 new session(s); it starts at most 1 at once",
    });
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered" });
    const ev = await until(() => (events("claude-code", SID).length === 2 ? events("claude-code", SID) : null));
    expect(ev[1]?.data).toMatchObject({ ok: false, error: expect.stringContaining("at most 1 at once") });
    // Once that start is done the cap is free again.
    expect((await askIt(req())).end?.op).toBe("answer");
    expect(runs()).toHaveLength(2);
  });

  it("a receiver can't carry an ask as a command: the kind is refused before any rule runs", async () => {
    await startDaemon({ receivers: true });
    const q = await rx.send({ kind: "ask", harness: "codex", session: `codex:${RECV}`, cwd: project, text: "go" });
    const ack = await rx.waitAck(q.id);
    expect(ack).toMatchObject({ outcome: "refused", code: "unknown_kind" });
    expect(runs()).toEqual([]);
    expect(existsSync(path.join(tmp, "state", "outbox"))).toBe(false);
  });
});

describe.runIf(unix)("two asks at once from one session", () => {
  it("two new sessions: both run side by side and answer; the asker's events pair up by ask_id with one seq counter", {
    timeout: 20_000,
  }, async () => {
    await startDaemon();
    const [a, b] = await Promise.all([askIt(req({ text: "one" })), askIt(req({ text: "two" }))]);
    expect(a.end).toMatchObject({ op: "answer", text: expect.stringContaining("codex did: one") });
    expect(b.end).toMatchObject({ op: "answer", text: expect.stringContaining("codex did: two") });
    const ids = [a.end, b.end].map((e) => (e as { ask_id: string }).ask_id);
    expect(new Set(ids).size).toBe(2);
    const sessions = [a.end, b.end].map((e) => (e as { session: string }).session);
    expect(new Set(sessions).size).toBe(2);
    // Side by side, not one after the other: the second child started within the first's turn.
    const [r1, r2] = runs();
    expect(r2!.t - r1!.t).toBeLessThan(550);
    const ev = await until(() => (events("claude-code", SID).length === 4 ? events("claude-code", SID) : null));
    expect(ev.map((e) => e.session.seq)).toEqual([0, 1, 2, 3]);
    for (const id of ids) {
      const mine = ev.filter((e) => e.data.ask_id === id).map((e) => e.type);
      expect(mine).toEqual(["delegation.started", "delegation.ended"]);
    }
    expect(d?.busy()).toBeNull();
    expect(d?.status().delivered).toEqual({ resume: 2 });
  });

  it("the same existing session twice: one agent on it at a time, the second message after the first's turn", {
    timeout: 20_000,
  }, async () => {
    await startDaemon();
    const first = await askIt(req({ text: "open it" }));
    const session = (first.end as { session: string }).session;
    const [a, b] = await Promise.all([
      askIt(req({ session, text: "then this" })),
      askIt(req({ session, text: "and this" })),
    ]);
    expect(a.end).toMatchObject({ op: "answer", session });
    expect(b.end).toMatchObject({ op: "answer", session });
    const [, r2, r3] = runs();
    expect(r3!.t - r2!.t).toBeGreaterThanOrEqual(550);
    expect(d?.busy()).toBeNull();
  });
});

describe.runIf(unix)("the asker is gone", () => {
  it("the asker's process went away mid-run: the run finishes, its events land, nothing is held", async () => {
    const daemon = await startDaemon();
    const s = net.connect(sock);
    s.on("error", () => {});
    const asked = new Promise<void>((res) => {
      let buf = "";
      s.on("data", (b) => {
        buf += b.toString("utf8");
        if (buf.includes('"asked"')) res();
      });
    });
    s.on("connect", () => s.write(`${JSON.stringify(req({ text: "nobody waits" }))}\n`));
    await asked;
    await until(() => runs().length === 1);
    s.destroy();
    expect(daemon.busy()).toBe("1 message(s) in hand");
    const ev = await until(() => (events("claude-code", SID).length === 2 ? events("claude-code", SID) : null));
    expect(ev[1]?.data).toMatchObject({ ok: true, reply: expect.stringContaining("codex did: nobody waits") });
    expect(daemon.busy()).toBeNull();
    expect(daemon.status().delivered).toEqual({ resume: 1 });
    // The daemon is whole: the next ask goes through on a fresh connection.
    expect((await askIt(req())).end?.op).toBe("answer");
  });

  it("an asker nobody here knows: the ask runs, the events go on that session with no facts of its own", async () => {
    await startDaemon();
    const ghost = `codex:${THREAD.replace(/^0199/, "0177")}`;
    const { end } = await askIt(req({ from: ghost }));
    expect(end?.op).toBe("answer");
    expect(runs()[0]).toMatchObject({ asked_by: ghost, chain: ghost });
    const id = ghost.slice("codex:".length);
    const ev = await until(() => (events("codex", id).length === 2 ? events("codex", id) : null));
    expect(ev[0]?.session).toMatchObject({ id, seq: 0 });
    expect(ev[0]?.session).not.toHaveProperty("cwd");
    expect(ev[0]?.data).toMatchObject({ via: "ask", harness: "codex" });
  });

  it("no session in the caller's environment: no from, no chain, no events; the child's chain still says unknown", async () => {
    await startDaemon();
    const bare = req();
    delete bare.from;
    const { got, end } = await askIt(bare);
    expect(got.map((r) => r.op)).toEqual(["asked", "answer"]);
    expect(end?.op).toBe("answer");
    expect(runs()[0]).toMatchObject({ asked_by: null, chain: "unknown" });
    expect(existsSync(path.join(tmp, "state", "outbox"))).toBe(false);
    expect(await ask(sock, { op: "status" }, 1000)).toMatchObject({ op: "status" });
  });
});
