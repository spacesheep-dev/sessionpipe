// SPDX-License-Identifier: Apache-2.0
// The delivery ladder (CONTROL.md §6) where the main suite doesn't go: a harness with
// no headless path (Gemini CLI, placed by its hooks' cwd), an SDK session that errors
// or can't be interrupted, a streamed headless answer and its progress acks, the
// receiver's session tools, a key.add at its edges, a start refused for its folder or
// its id, a login asked once and remembered, and a session that moves between a
// message's two looks at it.
import { spawn } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeControl } from "@sessionpipe/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ControlDaemon, type DaemonDeps, type SdkHost } from "../src/control/daemon.js";
import { ask } from "../src/control/local.js";
import { type ControlConfig, readControl, writeState } from "../src/control/store.js";
import { waitForMessage } from "../src/control/wait.js";
import { FakeReceiver } from "./helpers/receiver.js";

const SID = "8c132906-8c3f-4814-870a-afc3d05e1d2e";
const SESSION = `claude-code:${SID}`;
const NEW = "0b6f2c7e-3d4a-4f1b-9c8e-2a1d5e6f7a8c";
const KIRO = "kiro:g-1";
const unix = process.platform !== "win32";
const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));

let tmp: string;
let rx: FakeReceiver;
let d: ControlDaemon | null = null;
let env: NodeJS.ProcessEnv;
let sock: string;
let project: string;
let configDir: string;
let claudeLog: string;
let fakeClaude: string;
let log: string[];
let clock = 0;

/** The daemon as it is now (a `d = null` above narrows the variable for the checker). */
const running = () => d;

const transcriptFile = (sid: string, cwd = project) =>
  path.join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sid}.jsonl`);

function transcript(sid: string, cwd = project): void {
  const f = transcriptFile(sid, cwd);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, `${JSON.stringify({ type: "user", cwd, message: { content: "hi" } })}\n`);
  const past = new Date(Date.now() - 600_000);
  utimesSync(f, past, past);
}

/** The session's answer, written as a turn is: its first words, then the end of the turn. */
function answer(sid: string, text: string, stop = "end_turn"): void {
  appendFileSync(
    transcriptFile(sid),
    `${JSON.stringify({ type: "assistant", message: { stop_reason: stop, content: [{ type: "text", text }] } })}\n`,
  );
}

/** A stand-in `claude -p` that streams its answer a word at a time, then the result. */
function streamingClaude(): void {
  writeFileSync(
    fakeClaude,
    `#!/usr/bin/env node
const a = process.argv.slice(2);
require("fs").appendFileSync(${JSON.stringify(claudeLog)}, JSON.stringify(a) + "\\n");
const i = a.indexOf("--resume"), j = a.indexOf("--session-id");
const sid = i >= 0 ? a[i + 1] : j >= 0 ? a[j + 1] : "x";
const ev = (event) => process.stdout.write(JSON.stringify({ type: "stream_event", event }) + "\\n");
ev({ type: "message_start" });
ev({ type: "content_block_delta", delta: { type: "text_delta", text: "On " } });
setTimeout(() => {
  ev({ type: "content_block_delta", delta: { type: "text_delta", text: "it." } });
  process.stdout.write(JSON.stringify({ type: "result", result: "On it.", session_id: sid, is_error: false }) + "\\n");
}, 600);
`,
  );
  chmodSync(fakeClaude, 0o755);
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

async function startDaemon(
  o: {
    cfg?: Partial<ControlConfig>;
    sdk?: SdkHost | null;
    caps?: Partial<claudeControl.Caps>;
    claude?: DaemonDeps["claude"];
    extra?: Partial<DaemonDeps>;
  } = {},
) {
  d = new ControlDaemon(cfg(o.cfg), path.join(tmp, "state", "control"), sock, {
    now: () => Date.now() + clock,
    fetch,
    log: (s) => log.push(s),
    claudeDirs: () => [configDir],
    claude:
      o.claude ??
      (() => ({
        bin: fakeClaude,
        caps: { hasMode: true, modes: ["default", "dontAsk"], promptsNone: false, fork: true, ...o.caps },
      })),
    run: claudeControl.runClaude,
    sdk: o.sdk ?? null,
    env,
    answerWaitMs: 1500,
    ...o.extra,
  });
  await d.start();
}

/** An SDK host whose sessions fail on cue. */
function sdkHost(): SdkHost & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    start: () => ({
      send: async (t: string) => {
        sent.push(t);
        if (t.includes("explode")) return { reply: "", error: "the SDK gave up" };
        return { reply: `sdk: ${t.split("\n")[0]}` };
      },
      interrupt: async () => {
        if (sent.some((t) => t.includes("raw"))) throw "not now";
        throw new Error("nothing to interrupt");
      },
      close: () => {},
      busy: false,
      lastUsed: Date.now(),
    }),
  };
}

beforeAll(async () => {
  rx = new FakeReceiver();
  await rx.start();
});
afterAll(async () => {
  await rx.stop();
});
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "sp-ladder-"));
  project = path.join(tmp, "project");
  configDir = path.join(tmp, "claude-config");
  mkdirSync(project, { recursive: true });
  mkdirSync(path.join(configDir, "sessions"), { recursive: true });
  sock = path.join(tmp, "control.sock");
  claudeLog = path.join(tmp, "claude-calls.jsonl");
  fakeClaude = path.join(tmp, "claude");
  writeFileSync(
    fakeClaude,
    `#!/usr/bin/env node
const a = process.argv.slice(2);
require("fs").appendFileSync(${JSON.stringify(claudeLog)}, JSON.stringify(a) + "\\n");
const i = a.indexOf("--resume"), j = a.indexOf("--session-id");
const sid = i >= 0 ? a[i + 1] : j >= 0 ? a[j + 1] : "x";
process.stdout.write(JSON.stringify({ type: "result", result: "did it", session_id: sid, is_error: false }));
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
  rx.queue.clear();
  rx.acks.length = 0;
  rx.hellos.length = 0;
  rx.sessionTools = undefined;
  rx.wellKnownStatus = 200;
});
afterEach(async () => {
  await d?.stop();
  d = null;
  rmSync(tmp, { recursive: true, force: true });
});

describe.runIf(unix)("a harness with no headless path (Kiro)", () => {
  it("is placed by its hooks' cwd: in place at its next Stop when mid-turn, else unsupported", {
    timeout: 30_000,
  }, async () => {
    await startDaemon();
    // Nothing known about it yet.
    const none = await rx.send({ session: KIRO, text: "hi" });
    expect(await rx.waitAck(none.id)).toMatchObject({ outcome: "refused", code: "no_session" });
    // A folder off the list, a path that isn't absolute, a file rather than a folder, a folder that is gone.
    for (const cwd of [tmp, "relative/dir", fakeClaude, path.join(tmp, "gone")]) {
      await ask(sock, { op: "event", session: KIRO, event: "SessionStart", cwd }, 500);
      const q = await rx.send({ session: KIRO, text: "hi" });
      expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "refused", code: "folder" });
    }
    await ask(sock, { op: "event", session: KIRO, event: "SessionStart", cwd: project }, 500);
    const idle = await rx.send({ session: KIRO, text: "hi" });
    expect(await rx.waitAck(idle.id)).toMatchObject({
      outcome: "unsupported",
      detail: "no idle delivery for kiro yet",
    });
    await ask(sock, { op: "event", session: KIRO, event: "UserPromptSubmit", cwd: project }, 500);
    const q = await rx.send({ session: KIRO, text: "while you're at it" });
    for (let i = 0; i < 100 && !rx.acks.some((a) => a.id === q.id); i++) await settle(20);
    const r = await ask(sock, { op: "stop", session: KIRO, active: false }, 500);
    expect(r).toMatchObject({ op: "block" });
    // No transcript to read an answer from: delivered, without one.
    const ack = await rx.waitAck(q.id);
    expect(ack).toMatchObject({ outcome: "delivered", mode: "turn" });
    expect(ack).not.toHaveProperty("reply");
  });

  it("a folder allowed with a trailing slash that doesn't exist is matched as written", async () => {
    await startDaemon({ cfg: { folders: [`${path.join(tmp, "gone")}/`, project] } });
    await ask(sock, { op: "event", session: KIRO, event: "UserPromptSubmit", cwd: project }, 500);
    const q = await rx.send({ session: KIRO, text: "hi" });
    for (let i = 0; i < 100 && !rx.acks.some((a) => a.id === q.id); i++) await settle(20);
    expect(rx.acks.find((a) => a.id === q.id)?.outcome).toBe("taken");
  });
});

describe.runIf(unix)("the Agent SDK session", () => {
  it("a prompt the SDK fails is `failed`; a cancel it can't carry out is `failed` in its words", {
    timeout: 30_000,
  }, async () => {
    const host = sdkHost();
    await startDaemon({ sdk: host });
    const s = await rx.send({ kind: "start", session: `claude-code:${NEW}`, cwd: project, text: "go" });
    expect(await rx.waitAck(s.id)).toMatchObject({ outcome: "delivered", mode: "sdk" });
    transcript(NEW);
    const q = await rx.send({ session: `claude-code:${NEW}`, text: "explode" });
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "failed", detail: "the SDK gave up" });
    const c = await rx.send({ kind: "cancel", session: `claude-code:${NEW}`, text: undefined });
    expect(await rx.waitAck(c.id)).toMatchObject({ outcome: "failed", detail: "nothing to interrupt" });
    await rx.send({ session: `claude-code:${NEW}`, text: "raw" }).then((m) => rx.waitAck(m.id));
    const c2 = await rx.send({ kind: "cancel", session: `claude-code:${NEW}`, text: undefined });
    expect(await rx.waitAck(c2.id)).toMatchObject({ outcome: "failed", detail: "not now" });
  });

  it("a start the SDK fails is `failed`; a second start for the same id in the same poll is refused", {
    timeout: 20_000,
  }, async () => {
    const host = sdkHost();
    await startDaemon({ sdk: host });
    const s = await rx.send({ kind: "start", session: `claude-code:${NEW}`, cwd: project, text: "explode" });
    expect(await rx.waitAck(s.id)).toMatchObject({ outcome: "failed", detail: "the SDK gave up" });
    const OTHER = "0b6f2c7e-3d4a-4f1b-9c8e-2a1d5e6f7a8e";
    const a = await rx.send(
      { kind: "start", session: `claude-code:${OTHER}`, cwd: project, text: "one" },
      { hold: true },
    );
    const b = await rx.send(
      { kind: "start", session: `claude-code:${OTHER}`, cwd: project, text: "two" },
      { hold: true },
    );
    rx.enqueue(a);
    rx.enqueue(b);
    const acks = [await rx.waitAck(a.id), await rx.waitAck(b.id)].map((x) => x.outcome).sort();
    expect(acks).toEqual(["delivered", "refused"]);
    expect(rx.acks.find((x) => x.outcome === "refused")).toMatchObject({ code: "bad_session" });
  });

  it("the receiver's session tools reach an SDK start, a headless start and a resume; a changed list is said once", {
    timeout: 30_000,
  }, async () => {
    rx.sessionTools = ["mcp__spacesheep", "Bash"];
    const host = sdkHost();
    const starts: unknown[] = [];
    const spy: SdkHost = {
      start: (o) => {
        starts.push(o);
        return host.start(o);
      },
    };
    await startDaemon({ sdk: spy });
    const s = await rx.send({ kind: "start", session: `claude-code:${NEW}`, cwd: project, text: "go" });
    await rx.waitAck(s.id);
    expect(starts[0]).toMatchObject({ allowedTools: ["mcp__spacesheep"] });
    const q = await rx.send({ session: SESSION, text: "resume me" });
    await rx.waitAck(q.id);
    expect(JSON.parse(readFileSync(claudeLog, "utf8").trim())).toContain("--allowedTools=mcp__spacesheep");
    expect(log.filter((l) => l.includes("may use mcp__spacesheep without asking"))).toHaveLength(1);
    // The next hello reads the same list: nothing new to say. Then none at all.
    const w = waitForMessage(SESSION, { env });
    for (let i = 0; i < 100 && rx.hellos.length < 2; i++) await settle(20);
    expect(log.filter((l) => l.includes("without asking"))).toHaveLength(1);
    rx.sessionTools = [];
    const w2 = waitForMessage(SESSION, { env });
    await w;
    for (let i = 0; i < 100 && rx.hellos.length < 3; i++) await settle(20);
    for (let i = 0; i < 50 && !log.some((l) => l.includes("nothing extra")); i++) await settle(20);
    expect(log.some((l) => l.includes("may use nothing extra without asking"))).toBe(true);
    const bye = await rx.send({ session: SESSION, text: "bye" });
    expect(await w2).toContain("bye");
    await rx.waitAck(bye.id);
    await d?.stop();
    d = null;
    // Without the SDK, a start is a headless run with the same tools.
    rx.sessionTools = ["mcp__spacesheep"];
    await startDaemon();
    const h = await rx.send({ kind: "start", session: `claude-code:${NEW}`, cwd: project, text: "with tools" });
    await rx.waitAck(h.id);
    expect(readFileSync(claudeLog, "utf8").trim().split("\n").at(-1)).toContain("--allowedTools=mcp__spacesheep");
    await running()?.stop();
    d = null;
    rx.wellKnownStatus = 503;
    const OTHER = "0b6f2c7e-3d4a-4f1b-9c8e-2a1d5e6f7a8f";
    await startDaemon();
    const n = await rx.send({ kind: "start", session: `claude-code:${OTHER}`, cwd: project, text: "no tools" });
    await rx.waitAck(n.id);
    const calls = readFileSync(claudeLog, "utf8").trim().split("\n");
    expect(calls.at(-1)).not.toContain("--allowedTools");
  });
});

describe.runIf(unix)("headless runs", () => {
  it("a Claude Code that streams: the answer so far goes out as progress, then the whole as the reply", async () => {
    streamingClaude();
    await startDaemon({ caps: { stream: true } });
    const q = await rx.send({ session: SESSION, text: "resume" });
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered", mode: "resume", reply: "On it." });
    expect(rx.progress(q.id)[0]).toMatchObject({ seq: 1, reply: "On" });
    expect(JSON.parse(readFileSync(claudeLog, "utf8").trim())).toContain("--include-partial-messages");
    const s = await rx.send({ kind: "start", session: `claude-code:${NEW}`, cwd: project, text: "start" });
    expect(await rx.waitAck(s.id)).toMatchObject({ outcome: "delivered", mode: "resume", reply: "On it." });
    expect(rx.progress(s.id).length).toBeGreaterThan(0);
  });

  it("auto mode on a Claude Code without an auto permission mode is refused, for a resume and a start", async () => {
    await startDaemon({ cfg: { mode: "auto" } });
    const q = await rx.send({ session: SESSION, text: "resume" });
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "refused", code: "mode" });
    const s = await rx.send({ kind: "start", session: `claude-code:${NEW}`, cwd: project, text: "start" });
    expect(await rx.waitAck(s.id)).toMatchObject({ outcome: "refused", code: "mode" });
  });

  it("no Claude Code on this machine: a resume and a start fail in words", async () => {
    await startDaemon({ claude: () => null });
    const q = await rx.send({ session: SESSION, text: "resume" });
    expect(await rx.waitAck(q.id)).toMatchObject({
      outcome: "failed",
      detail: "Claude Code isn't installed on this machine",
    });
    const s = await rx.send({ kind: "start", session: `claude-code:${NEW}`, cwd: project, text: "start" });
    expect(await rx.waitAck(s.id)).toMatchObject({
      outcome: "failed",
      detail: "Claude Code isn't installed on this machine",
    });
  });

  it("a start is refused for a folder off the list, and for a session that already exists", async () => {
    await startDaemon();
    const q = await rx.send({ kind: "start", session: `claude-code:${NEW}`, cwd: tmp, text: "hi" });
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "refused", code: "folder" });
    const s = await rx.send({ kind: "start", session: SESSION, cwd: project, text: "hi" });
    expect(await rx.waitAck(s.id)).toMatchObject({ outcome: "refused", code: "bad_session" });
  });

  it("the login is asked once and remembered for ten minutes, thirty seconds after a no; an unanswerable one never blocks", {
    timeout: 30_000,
  }, async () => {
    const answers: (boolean | null | Error)[] = [true, false, new Error("keychain locked")];
    const asked: number[] = [];
    await startDaemon({
      extra: {
        login: async () => {
          asked.push(clock);
          const a = answers.shift();
          if (a instanceof Error) throw a;
          return { loggedIn: a ?? null };
        },
      },
    });
    const one = await rx.send({ session: SESSION, text: "one" });
    expect(await rx.waitAck(one.id)).toMatchObject({ outcome: "delivered" });
    clock = 9 * 60_000;
    const two = await rx.send({ session: SESSION, text: "two" });
    expect(await rx.waitAck(two.id)).toMatchObject({ outcome: "delivered" });
    expect(asked).toEqual([0]);
    clock = 11 * 60_000;
    const three = await rx.send({ session: SESSION, text: "three" });
    expect(await rx.waitAck(three.id)).toMatchObject({ outcome: "failed" });
    clock += 20_000;
    const four = await rx.send({ session: SESSION, text: "four" });
    expect(await rx.waitAck(four.id)).toMatchObject({ outcome: "failed" });
    expect(asked).toEqual([0, 11 * 60_000]);
    clock += 20_000;
    const five = await rx.send({ session: SESSION, text: "five" });
    expect(await rx.waitAck(five.id)).toMatchObject({ outcome: "delivered" });
    expect(asked).toHaveLength(3);
  });

  it("a session that goes away between a message's two looks at it is refused on the second", async () => {
    // A slow stand-in: the first message holds the session's queue while the second waits.
    writeFileSync(
      fakeClaude,
      `#!/usr/bin/env node
const a = process.argv.slice(2);
setTimeout(() => process.stdout.write(JSON.stringify({ type: "result", result: "slow", session_id: a[a.indexOf("--resume") + 1], is_error: false })), 700);
`,
    );
    chmodSync(fakeClaude, 0o755);
    await startDaemon();
    const a = await rx.send({ session: SESSION, text: "one" }, { hold: true });
    const b = await rx.send({ session: SESSION, text: "two" }, { hold: true, confirm: true });
    rx.enqueue(a);
    rx.enqueue(b);
    // Whichever verified first is taken (its run holds the session); the other has looked
    // once and waits its turn.
    for (let i = 0; i < 100 && !rx.acks.some((x) => x.outcome === "taken"); i++) await settle(20);
    await settle(150);
    rmSync(transcriptFile(SID));
    const first = rx.acks.find((x) => x.outcome === "taken")!.id === a.id ? a : b;
    const second = first === a ? b : a;
    expect(await rx.waitAck(first.id)).toMatchObject({ outcome: "delivered", mode: "resume" });
    expect(await rx.waitAck(second.id)).toMatchObject({ outcome: "refused", code: "no_session" });
  });
});

describe.runIf(unix)("a message waiting for a Stop", () => {
  it("rerouted after the turn, it is refused when its session has gone, and failed when routing throws", {
    timeout: 20_000,
  }, async () => {
    let boom = false;
    await startDaemon({
      claude: () => {
        if (boom) throw "claude exploded";
        return { bin: fakeClaude, caps: { hasMode: true, modes: ["dontAsk"], promptsNone: false, fork: true } };
      },
    });
    await ask(sock, { op: "event", session: SESSION, event: "UserPromptSubmit" }, 500);
    const q = await rx.send({ session: SESSION, text: "late" });
    for (let i = 0; i < 100 && !rx.acks.some((a) => a.id === q.id); i++) await settle(20);
    rmSync(transcriptFile(SID));
    await ask(sock, { op: "event", session: SESSION, event: "Stop" }, 500);
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "refused", code: "no_session" });
    transcript(SID);
    await ask(sock, { op: "event", session: SESSION, event: "UserPromptSubmit" }, 500);
    const q2 = await rx.send({ session: SESSION, text: "later" });
    for (let i = 0; i < 100 && !rx.acks.some((a) => a.id === q2.id); i++) await settle(20);
    boom = true;
    await ask(sock, { op: "event", session: SESSION, event: "Stop" }, 500);
    expect(await rx.waitAck(q2.id)).toMatchObject({ outcome: "failed", detail: "claude exploded" });
  });
});

describe.runIf(unix)("the answer read from a live session", () => {
  it("goes out as progress while the turn runs; the end of the turn is the reply", async () => {
    await startDaemon({ extra: { answerWaitMs: 5000 } });
    const got = waitForMessage(SESSION, { env });
    await settle(100);
    const q = await rx.send({ session: SESSION, text: "think" });
    await got;
    answer(SID, "Looking.", "tool_use");
    for (let i = 0; i < 100 && !rx.progress(q.id).length; i++) await settle(20);
    expect(rx.progress(q.id)[0]).toMatchObject({ seq: 1, reply: "Looking." });
    answer(SID, "Found it.");
    expect(await rx.waitAck(q.id)).toMatchObject({
      outcome: "delivered",
      mode: "waiter",
      reply: "Looking.\n\nFound it.",
    });
  });

  it("a transcript that can't be read any more: delivered, with the reason, never stuck", async () => {
    await startDaemon();
    const got = waitForMessage(SESSION, { env });
    await settle(100);
    const q = await rx.send({ session: SESSION, text: "go" });
    await got;
    answer(SID, "partial", "tool_use");
    chmodSync(transcriptFile(SID), 0o000);
    const ack = await rx.waitAck(q.id);
    expect(ack).toMatchObject({ outcome: "delivered", mode: "waiter" });
    expect(String(ack.detail)).toMatch(/EACCES/);
  });

  it("a fork whose copy has no transcript yet: delivered to the waiter, without a reply", async () => {
    const COPY = "0b6f2c7e-3d4a-4f1b-9c8e-2a1d5e6f7a8b";
    writeState(path.join(tmp, "state", "control", "state.json"), { copies: { [SID]: COPY } });
    await startDaemon();
    const got = waitForMessage(SESSION, { env });
    await settle(100);
    const q = await rx.send({ session: SESSION, text: "go" });
    expect(await got).toContain("go");
    const ack = await rx.waitAck(q.id);
    expect(ack).toMatchObject({ outcome: "delivered", mode: "waiter" });
    expect(ack).not.toHaveProperty("reply");
  });
});

describe.runIf(unix)("key.add (CONTROL.md §2)", () => {
  const add = (over: Record<string, unknown> = {}) =>
    rx.send(
      { kind: "key.add", session: "sessionpipe:keys", text: undefined, key: rx.other.key, ...over },
      { confirm: true },
    );

  it("a device without a name; the same device twice; a store that can't be written", { timeout: 20_000 }, async () => {
    await startDaemon();
    const q = await add();
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered", detail: "trusted a new device" });
    expect(log.at(-2)).toMatch(/^trusted a new device on http/);
    expect(readControl(env)?.receivers[0]?.keys.at(-1)).not.toHaveProperty("name");
    const again = await add({ name: "iPhone" });
    expect(await rx.waitAck(again.id)).toMatchObject({
      outcome: "delivered",
      detail: "that device was already trusted",
    });
    expect(readControl(env)?.receivers[0]?.keys).toHaveLength(2);
    await d?.stop();
    d = null;
    // control.json's folder is a file: nothing can be saved, so nothing is trusted.
    const third = rx.other;
    rx.other = await (await import("../../core/test/helpers/authenticator.js")).Passkey.create({
      rpId: "localhost",
      origin: rx.url,
    });
    writeFileSync(path.join(tmp, "cfgfile"), "");
    env.SESSIONPIPE_CONFIG = path.join(tmp, "cfgfile", "config.json");
    await startDaemon();
    const bad = await add({ name: "iPad" });
    const ack = await rx.waitAck(bad.id);
    expect(ack).toMatchObject({ outcome: "failed" });
    expect(String(ack.detail)).toMatch(/^couldn't save the key: /);
    expect(running()?.status().receivers[0]?.keys).toBe(1);
    rx.other = third;
  });
});

describe.runIf(unix)("sessions this daemon runs", () => {
  it("one run after another on the same session is counted, not confused", async () => {
    // Codex and Antigravity nest a start's hold inside the run's own; here the same shape, directly.
    await startDaemon();
    const priv = d as unknown as {
      owning<T>(s: string, fn: () => Promise<T>): Promise<T>;
      ownRuns: Map<string, number>;
    };
    await priv.owning(SID, async () => {
      await priv.owning(SID, async () => expect(priv.ownRuns.get(SID)).toBe(2));
      expect(priv.ownRuns.get(SID)).toBe(1);
    });
    expect(priv.ownRuns.has(SID)).toBe(false);
    expect(spawn).toBeDefined();
  });
});
