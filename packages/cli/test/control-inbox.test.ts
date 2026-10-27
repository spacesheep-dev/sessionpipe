// SPDX-License-Identifier: Apache-2.0
// The `inbox` delivery mode through the daemon (CONTROL.md §6.3): a message written into
// a live Claude Code's own local inbox, the delivery proved by the turn it caused, the
// honest `held` ack when the session doesn't take it, and every gate that sends the
// message down the ladder instead. The registry rows, the transcripts and the inbox are
// real files and a real Unix socket in a temp dir; the live pid is this process's own.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { claudeControl } from "@sessionpipe/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlDaemon, type DaemonDeps } from "../src/control/daemon.js";
import { ask } from "../src/control/local.js";
import type { ControlConfig } from "../src/control/store.js";
import { FakeReceiver } from "./helpers/receiver.js";

// A copy is a real headless run of a stand-in `claude`; several cases make one.
vi.setConfig({ testTimeout: 30_000 });

const SID = "8c132906-8c3f-4814-870a-afc3d05e1d2e";
const SESSION = `claude-code:${SID}`;
const unix = process.platform !== "win32";
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

let tmp: string;
let rx: FakeReceiver;
let d: ControlDaemon | null = null;
let env: NodeJS.ProcessEnv;
let sock: string;
let project: string;
let configDir: string;
let fakeClaude: string;
let claudeLog: string;
let log: string[];
let clock: number;
let inboxPath: string;
let inbox: net.Server;
let written: string[];

/** A stand-in for Claude Code's own local inbox: every line it is handed. */
async function openInbox(): Promise<void> {
  inbox = net.createServer((s) => {
    let buf = "";
    s.on("data", (c) => {
      buf += c.toString("utf8");
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        written.push(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    s.on("error", () => {});
  });
  await new Promise<void>((r) => inbox.listen(inboxPath, () => r()));
}

const transcriptFile = (sid: string, dir = configDir) =>
  path.join(dir, "projects", project.replace(/[^a-zA-Z0-9]/g, "-"), `${sid}.jsonl`);

/** A session's transcript, old enough not to read as freshly written. */
function transcript(sid: string, dir = configDir): void {
  const f = transcriptFile(sid, dir);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, `${JSON.stringify({ type: "user", cwd: project, message: { content: "hi" } })}\n`);
  const past = new Date(Date.now() - 600_000);
  utimesSync(f, past, past);
}

/** A registry row for a live, idle, interactive session with an inbox. */
function row(o: Record<string, unknown> = {}, dir = configDir): void {
  mkdirSync(path.join(dir, "sessions"), { recursive: true });
  writeFileSync(
    path.join(dir, "sessions", `${process.pid}.json`),
    JSON.stringify({
      sessionId: SID,
      pid: process.pid,
      kind: "interactive",
      entrypoint: "cli",
      status: "idle",
      peerProtocol: 1,
      messagingSocketPath: inboxPath,
      ...o,
    }),
  );
}

/** The account's own default mode, which is what makes this machine's class `bypass`. */
function homeDefault(mode: string | null, extra: Record<string, unknown> = {}, dir = configDir): void {
  writeFileSync(
    path.join(dir, "settings.json"),
    JSON.stringify({ permissions: { ...(mode ? { defaultMode: mode } : {}), ...extra } }),
  );
}

/** What the session writes when it takes the message: the peer row the daemon matches
 *  on, then the turn's own answer and its end. */
function answered(mark: string, text = "all three are merged"): void {
  const f = transcriptFile(SID);
  const rows = [
    {
      type: "user",
      isMeta: true,
      origin: { kind: "peer", body: `Message via localhost (sessionpipe control, …; ${mark}):\n\nare we done?` },
      message: { content: [{ type: "text", text: "Another Claude session sent a message: …" }] },
    },
    { type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "text", text }] } },
  ];
  writeFileSync(f, readFileSync(f, "utf8") + rows.map((r) => `${JSON.stringify(r)}\n`).join(""));
}

/** What the person writing their own prompt in the same second looks like. */
function typed(text: string): void {
  const f = transcriptFile(SID);
  const rows = [
    { type: "user", origin: { kind: "human" }, message: { content: [{ type: "text", text: "what is payroll?" }] } },
    { type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "text", text }] } },
  ];
  writeFileSync(f, readFileSync(f, "utf8") + rows.map((r) => `${JSON.stringify(r)}\n`).join(""));
}

function cfg(over: Partial<ControlConfig> = {}): ControlConfig {
  return {
    name: "testbox",
    folders: [project],
    mode: "inherit",
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

async function startDaemon(
  o: { cfg?: Partial<ControlConfig>; extra?: Partial<DaemonDeps>; realPlatform?: boolean } = {},
): Promise<void> {
  d = new ControlDaemon(cfg(o.cfg), path.join(tmp, "state", "control"), sock, {
    now: () => Date.now() + clock,
    fetch,
    log: (s) => log.push(s),
    claudeDirs: () => [configDir],
    claude: () => ({
      bin: fakeClaude,
      caps: { hasMode: true, modes: ["plan", "default", "acceptEdits", "auto"], promptsNone: false, fork: true },
    }),
    run: claudeControl.runClaude,
    sdk: null,
    env,
    answerWaitMs: 4000,
    ...(o.realPlatform ? {} : { platform: "darwin" as NodeJS.Platform }),
    ...o.extra,
  });
  await d.start();
}

/** Say what the session's own hooks would say about its permission mode. A tool event,
 *  not a prompt: a prompt would also mean the session is mid-turn. */
const sawMode = (mode: string, session = SESSION) =>
  ask(sock, { op: "event", session, event: "PostToolUse", mode }, 500);

/** The inbox has `n` lines in it. */
async function wrote(n: number): Promise<void> {
  for (let i = 0; i < 100 && written.length < n; i++) await settle(30);
  expect(written).toHaveLength(n);
}

/** The mark the daemon writes into the framed text, as the session would see it. */
const markOf = (id: string) => `message ${id.slice(-12)}`;

/** The one `user` frame in the inbox, as the session would read it. */
const frameIn = (n = 0) => (JSON.parse(written[n] as string) as { message: { content: string } }).message.content;

beforeAll(async () => {
  rx = new FakeReceiver();
  await rx.start();
});
afterAll(async () => {
  await rx.stop();
});
beforeEach(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "sp-inbox-"));
  project = path.join(tmp, "project");
  configDir = path.join(tmp, "home-a");
  mkdirSync(project, { recursive: true });
  mkdirSync(path.join(configDir, "sessions"), { recursive: true });
  // macOS caps a socket path at 104 bytes, so both sockets live in a short temp dir.
  sock = path.join(mkdtempSync(path.join(os.tmpdir(), "sp-s-")), "c.sock");
  inboxPath = path.join(path.dirname(sock), "i.sock");
  written = [];
  await openInbox();
  claudeLog = path.join(tmp, "claude-calls.jsonl");
  fakeClaude = path.join(tmp, "claude");
  writeFileSync(
    fakeClaude,
    `#!/usr/bin/env node
const a = process.argv.slice(2);
require("fs").appendFileSync(${JSON.stringify(claudeLog)}, JSON.stringify(a) + "\\n");
const i = a.indexOf("--resume");
process.stdout.write(JSON.stringify({ type: "result", result: "a copy answered", session_id: i >= 0 ? a[i + 1] : "x", is_error: false }));
`,
  );
  chmodSync(fakeClaude, 0o755);
  log = [];
  clock = 0;
  env = {
    ...process.env,
    SESSIONPIPE_STATE: path.join(tmp, "state"),
    SESSIONPIPE_CONFIG: path.join(tmp, "config", "config.json"),
    SESSIONPIPE_SOCKET: sock,
  };
  transcript(SID);
  homeDefault("bypassPermissions");
  rx.queue.clear();
  rx.acks.length = 0;
  rx.hellos.length = 0;
});
afterEach(async () => {
  await d?.stop();
  d = null;
  await new Promise<void>((r) => inbox.close(() => r()));
  rmSync(path.dirname(sock), { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});

describe.runIf(unix)("a message into a live session's own inbox", () => {
  it("is written once, declares the machine's class, and is delivered by the turn it caused", async () => {
    row();
    await startDaemon();
    await sawMode("bypassPermissions");
    const q = await rx.send({ session: SESSION, kind: "prompt", text: "are we done with the three PRs?" });
    await settle(200);
    expect(written).toHaveLength(1);
    const frame = frameIn();
    expect(frame).toContain('from-mode="bypass"');
    expect(frame).toContain(`from-name="${new URL(rx.url).host} board"`);
    expect(frame).toContain("are we done with the three PRs?");
    expect(frame).toContain(markOf(q.id));
    expect(JSON.parse(written[0] as string)).toMatchObject({ priority: "later" });
    // Not delivered until the session's own turn says this message asked for it.
    expect(rx.finalAck(q.id)).toBeUndefined();
    answered(markOf(q.id));
    await ask(sock, { op: "event", session: SESSION, event: "UserPromptSubmit", mode: "bypassPermissions" }, 500);
    expect(await rx.waitAck(q.id)).toMatchObject({
      outcome: "delivered",
      mode: "inbox",
      reply: "all three are merged",
    });
    // Nothing was started, and the session's mode is untouched.
    expect(() => readFileSync(claudeLog, "utf8")).toThrow();
    const state = JSON.parse(readFileSync(path.join(tmp, "state", "control", "state.json"), "utf8")) as {
      modes: Record<string, string>;
    };
    expect(state.modes[SESSION]).toBe("bypassPermissions");
    // And the hello says the lane exists here.
    expect(rx.hellos.at(-1)?.modes).toContain("inbox");
  });

  it("says nothing about the platform when nobody asked it to: this computer's own", async () => {
    row();
    await startDaemon({ realPlatform: true });
    await sawMode("bypassPermissions");
    const q = await rx.send({ session: SESSION, kind: "prompt", text: "on this Mac" });
    await wrote(1);
    // A Mac vets the sender by uid, so the line goes out on its own.
    expect(JSON.parse(written[0] as string)).toMatchObject({ type: "user" });
    answered(markOf(q.id), "right you are");
    await ask(sock, { op: "event", session: SESSION, event: "UserPromptSubmit", mode: "bypassPermissions" }, 500);
    expect(await rx.waitAck(q.id, 15_000)).toMatchObject({ outcome: "delivered", mode: "inbox" });
  });

  it("the machine's class and the session's must be the same: otherwise the message takes the next rung", async () => {
    row();
    await startDaemon();
    // The machine would declare bypass (inherit + a bypass default); the session itself
    // is in Accept edits. A declaration the receiver can't match is parked unread, so
    // the lane is not used at all.
    await sawMode("acceptEdits");
    const q = await rx.send({ session: SESSION, kind: "prompt", text: "which is it?" });
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered", mode: "fork" });
    expect(written).toEqual([]);
    expect(log.some((l) => l.includes("class_mismatch"))).toBe(true);
  });

  it("a mode with no class of its own is no lane either", async () => {
    row();
    await startDaemon();
    await sawMode("plan");
    const q = await rx.send({ session: SESSION, kind: "prompt", text: "planning?" });
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered", mode: "fork" });
    expect(log.some((l) => l.includes("class_unknown"))).toBe(true);
  });

  it("a machine that names a mode of its own is `prompting`, whatever the account defaults to", async () => {
    row();
    await startDaemon({ cfg: { mode: "auto" } });
    await sawMode("bypassPermissions");
    const q = await rx.send({ session: SESSION, kind: "prompt", text: "auto machine" });
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered", mode: "fork" });
    expect(written).toEqual([]);
  });

  it("an account that may not be in bypass at all makes the machine `prompting`", async () => {
    row();
    homeDefault("bypassPermissions", { disableBypassPermissionsMode: "disable" });
    await startDaemon();
    await sawMode("bypassPermissions");
    const q = await rx.send({ session: SESSION, kind: "prompt", text: "disabled" });
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered", mode: "fork" });
  });

  it("two prompting sides agree: an Accept-edits session on a machine with no bypass default", async () => {
    row();
    homeDefault("acceptEdits");
    await startDaemon();
    await sawMode("acceptEdits");
    const q = await rx.send({ session: SESSION, kind: "prompt", text: "edits both ways" });
    await settle(200);
    expect(frameIn()).toContain('from-mode="prompting"');
    answered(markOf(q.id), "done");
    await ask(sock, { op: "event", session: SESSION, event: "UserPromptSubmit", mode: "acceptEdits" }, 500);
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered", mode: "inbox", reply: "done" });
  });
});

describe.runIf(unix)("a message the session doesn't take", () => {
  it("is acked held, once, and is never written anywhere else", async () => {
    row();
    await startDaemon();
    await sawMode("bypassPermissions");
    const q = await rx.send({ session: SESSION, kind: "prompt", text: "did you see this?" });
    const ack = await rx.waitAck(q.id, 15_000);
    expect(ack).toMatchObject({ outcome: "failed", code: "held" });
    expect(String(ack.detail)).toContain("Nothing was duplicated");
    expect(ack).not.toHaveProperty("resend_as");
    expect(written).toHaveLength(1);
    // No second lane: nothing was started and no copy was made.
    expect(() => readFileSync(claudeLog, "utf8")).toThrow();
    expect(rx.acks.filter((a) => a.id === q.id && a.outcome === "failed")).toHaveLength(1);
  });

  it("a turn the person began themselves in the same window is not this message's delivery", async () => {
    row();
    await startDaemon();
    await sawMode("bypassPermissions");
    const q = await rx.send({ session: SESSION, kind: "prompt", text: "did you see this?" });
    await wrote(1);
    typed("payroll is in the private repo");
    await ask(sock, { op: "event", session: SESSION, event: "UserPromptSubmit", mode: "bypassPermissions" }, 500);
    const ack = await rx.waitAck(q.id, 15_000);
    expect(ack).toMatchObject({ outcome: "failed", code: "held" });
    // Their answer is theirs: it never reaches the receiver as the answer to this.
    expect(JSON.stringify(rx.acks)).not.toContain("payroll");
  });

  it("the same words again are not written in beside the copy already waiting, until it can't be", async () => {
    row();
    // No copies on this machine, so the second message stops at the rung below rather
    // than making one — which would move every later message to the copy.
    await startDaemon({ cfg: { limits: { copies_per_day: 0 } } });
    await sawMode("bypassPermissions");
    const first = await rx.send({ session: SESSION, kind: "prompt", text: "did you see this?" });
    await rx.waitAck(first.id, 15_000);
    const again = await rx.send({ session: SESSION, kind: "prompt", text: "did you see this?" });
    expect(await rx.waitAck(again.id)).toMatchObject({ outcome: "refused", code: "copy_limit" });
    expect(written).toHaveLength(1);
    expect(log.some((l) => l.includes("parked"))).toBe(true);
    // Once the session can no longer be handed that message, the lane is open again.
    clock += 301_000;
    // Signed by the clock the machine is now keeping: a message's own freshness is a
    // separate gate from the hold window, and this one is about the hold.
    const later = await rx.send({ session: SESSION, kind: "prompt", text: "a new one", iat: Date.now() + clock });
    await wrote(2);
    answered(markOf(later.id), "right, got it");
    await ask(sock, { op: "event", session: SESSION, event: "UserPromptSubmit", mode: "bypassPermissions" }, 500);
    expect(await rx.waitAck(later.id, 15_000)).toMatchObject({ outcome: "delivered", mode: "inbox" });
  });

  it("a turn that began with nothing written for it yet is not a delivery either", async () => {
    row();
    await startDaemon();
    await sawMode("bypassPermissions");
    const q = await rx.send({ session: SESSION, kind: "prompt", text: "did you see this?" });
    await wrote(1);
    // A turn began, and the harness has written no row for it: six looks, then held.
    await ask(sock, { op: "event", session: SESSION, event: "UserPromptSubmit", mode: "bypassPermissions" }, 500);
    expect(await rx.waitAck(q.id, 15_000)).toMatchObject({ outcome: "failed", code: "held" });
    expect(log.some((l) => l.includes("nothing was written for it yet"))).toBe(true);
  });

  it("a session that has ended isn't kept waiting for a message it can never take", async () => {
    row();
    await startDaemon();
    await sawMode("bypassPermissions");
    const first = await rx.send({ session: SESSION, kind: "prompt", text: "still there?" });
    await rx.waitAck(first.id, 15_000);
    await ask(sock, { op: "event", session: SESSION, event: "SessionEnd" }, 500);
    // The lane is open again (and refuses for its own reasons, not for the old write).
    const again = await rx.send({ session: SESSION, kind: "prompt", text: "still there?" });
    await rx.waitAck(again.id, 15_000);
    expect(written).toHaveLength(2);
  });
});

describe.runIf(unix)("what the lane will not write into", () => {
  const next = async (text: string) => {
    const q = await rx.send({ session: SESSION, kind: "prompt", text });
    const ack = await rx.waitAck(q.id, 15_000);
    return { ack, q };
  };

  it("a session mid-turn: that is the turn lane's message, not this one's", async () => {
    row();
    await startDaemon();
    await sawMode("bypassPermissions");
    await ask(sock, { op: "event", session: SESSION, event: "UserPromptSubmit", mode: "bypassPermissions" }, 500);
    const q = await rx.send({ session: SESSION, kind: "prompt", text: "mid-turn" });
    await settle(150);
    expect(written).toEqual([]);
    expect(rx.acks.find((a) => a.id === q.id)).toMatchObject({ outcome: "taken" });
  });

  it("a session the registry says is not idle", async () => {
    row({ status: "busy" });
    await startDaemon();
    await sawMode("bypassPermissions");
    expect((await next("busy")).ack).toMatchObject({ outcome: "delivered", mode: "fork" });
    expect(written).toEqual([]);
  });

  it("a process that isn't one of the harness's own windows", async () => {
    row({ kind: "print" });
    await startDaemon();
    await sawMode("bypassPermissions");
    expect((await next("print")).ack).toMatchObject({ outcome: "delivered", mode: "fork" });
  });

  it("an inbox protocol this daemon doesn't speak", async () => {
    row({ peerProtocol: 7 });
    await startDaemon();
    await sawMode("bypassPermissions");
    expect((await next("protocol")).ack).toMatchObject({ outcome: "delivered", mode: "fork" });
  });

  it("a recycled pid: the registry's start time and the process's disagree", async () => {
    row({ procStart: "Mon Oct 26 12:53:13 1999" });
    await startDaemon();
    await sawMode("bypassPermissions");
    expect((await next("recycled")).ack).toMatchObject({ outcome: "delivered", mode: "fork" });
    expect(log.some((l) => l.includes("recycled_pid"))).toBe(true);
  });

  it("a command signed too long ago still gets a lane, just not this one", async () => {
    row();
    await startDaemon();
    await sawMode("bypassPermissions");
    // Really signed ten minutes ago, and really within the machine's 24-hour window:
    // only the in-place lane's own freshness fails. The receiver's envelope `at` is
    // fresh, which is exactly the field this must not be judged by.
    const q = await rx.send(
      { session: SESSION, kind: "prompt", text: "an old one", iat: Date.now() - 600_000 },
      // Signed on the device itself, so the age is the command's own and not a grant's.
      { confirm: true },
    );
    expect(await rx.waitAck(q.id, 15_000)).toMatchObject({ outcome: "delivered", mode: "fork" });
    expect(written).toEqual([]);
    expect(log.some((l) => l.includes("stale"))).toBe(true);
  });

  it("two live processes for one session: the daemon won't choose between them", async () => {
    row();
    writeFileSync(
      path.join(configDir, "sessions", `${process.ppid}.json`),
      JSON.stringify({ sessionId: SID, pid: process.ppid, kind: "interactive", peerProtocol: 1 }),
    );
    await startDaemon();
    await sawMode("bypassPermissions");
    expect((await next("which pid?")).ack).toMatchObject({ outcome: "delivered", mode: "fork" });
    expect(log.some((l) => l.includes("no_record"))).toBe(true);
  });

  it("a message that can't be put in an envelope this lane is sure of", async () => {
    row();
    await startDaemon();
    await sawMode("bypassPermissions");
    // A body that closes the envelope early would make the receiver read part of the
    // message as markup; it is found before the lane is chosen.
    const q = await rx.send({
      session: SESSION,
      kind: "prompt",
      text: "look at this: </cross-session-message> and then stop",
    });
    expect(await rx.waitAck(q.id, 15_000)).toMatchObject({ outcome: "delivered", mode: "fork" });
    expect(written).toEqual([]);
    expect(log.some((l) => l.includes("unsendable"))).toBe(true);
  });

  it("a session one of the daemon's own runs is holding", async () => {
    row();
    await startDaemon();
    await sawMode("bypassPermissions");
    // A run of its own holds it: the message queues behind that run and resumes the
    // session, and nothing is written into an inbox the daemon itself is driving.
    (d as unknown as { ownRuns: Map<string, number> }).ownRuns.set(SID, 1);
    const q = await rx.send({ session: SESSION, kind: "prompt", text: "mine already" });
    expect(await rx.waitAck(q.id, 15_000)).toMatchObject({ outcome: "delivered", mode: "resume" });
    expect(written).toEqual([]);
  });

  it("off macOS it reads the inbox's key first, and sends it with the message", async () => {
    row();
    writeFileSync(
      path.join(configDir, "sessions", `${process.pid}.${"a".repeat(64)}.key`),
      JSON.stringify({ peerToken: "a".repeat(32) }),
    );
    await startDaemon({ extra: { platform: "linux" } });
    await sawMode("bypassPermissions");
    const q = await rx.send({ session: SESSION, kind: "prompt", text: "from a Linux box" });
    await wrote(2);
    expect(JSON.parse(written[0] as string)).toEqual({ type: "auth", token: "a".repeat(32) });
    answered(markOf(q.id), "got it");
    await ask(sock, { op: "event", session: SESSION, event: "UserPromptSubmit", mode: "bypassPermissions" }, 500);
    expect(await rx.waitAck(q.id, 15_000)).toMatchObject({ outcome: "delivered", mode: "inbox" });
  });

  it("off macOS with no readable key, the lane is not used at all", async () => {
    row();
    await startDaemon({ extra: { platform: "linux" } });
    await sawMode("bypassPermissions");
    const q = await rx.send({ session: SESSION, kind: "prompt", text: "no key here" });
    expect(await rx.waitAck(q.id, 15_000)).toMatchObject({ outcome: "delivered", mode: "fork" });
    expect(written).toEqual([]);
    expect(log.some((l) => l.includes("no_key"))).toBe(true);
  });

  it("a refusal between the look and the first byte takes the next rung, with nothing written", async () => {
    row();
    await startDaemon({
      extra: { writeInbox: async () => ({ code: "no_inbox", detail: "it went away (ENOENT)" }) },
    });
    await sawMode("bypassPermissions");
    expect((await next("gone in between")).ack).toMatchObject({ outcome: "delivered", mode: "fork" });
    expect(log.some((l) => l.includes("refused before writing"))).toBe(true);
  });
});
