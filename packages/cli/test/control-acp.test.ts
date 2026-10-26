// SPDX-License-Identifier: Apache-2.0
// The control daemon driving an agent through ACP (CONTROL.md §6, `api` mode): a start
// that runs the agent's CLI and keeps it, the next message through the same process, a
// cancel as session/cancel, an idle close and the reopening (session/load) after it,
// and what is said when the agent isn't there, can't reopen, or dies. The agent is a
// stand-in in codex-acp 2.2.2's shapes (recorded 2026-10-22) that logs how it was run.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { acpControl, runHeadless } from "@sessionpipe/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ControlDaemon, type DaemonDeps } from "../src/control/daemon.js";
import { ask } from "../src/control/local.js";
import { HEADLESS, kindPath } from "../src/control/route.js";
import type { ControlConfig } from "../src/control/store.js";
import { FakeReceiver } from "./helpers/receiver.js";

const SESSION = "01a15fcd-05fc-78f3-83d7-6cc03f65676c"; // what the agent names a new session
const RECV = "0b6f2c7e-3d4a-4f1b-9c8e-2a1d5e6f7e01"; // the id the receiver's start names
const HOOKED = "7f2c1b3a-9d8e-4c5f-a1b2-c3d4e5f6a7b8"; // a session the agent's own hooks reported
const unix = process.platform !== "win32"; // the daemon's socket is a Unix socket here

let tmp: string;
let rx: FakeReceiver;
let d: ControlDaemon | null = null;
let env: NodeJS.ProcessEnv;
let sock: string;
let project: string;
let calls: string;
let fake: string;

function writeFake(): void {
  writeFileSync(
    fake,
    `const fs = require("fs");
const how = process.env.FAKE_ACP || "";
const log = (o) => fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(o) + "\\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let session = ${JSON.stringify(SESSION)};
const update = (update) => out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: session, update } });
const chunk = (text) => update({ sessionUpdate: "agent_message_chunk", messageId: "msg_1", content: { type: "text", text } });
const reply = (id, result) => out({ jsonrpc: "2.0", id, result });
let cancelled = null;
let buf = "";
process.stdin.on("data", (b) => {
  buf += b.toString();
  const lines = buf.split("\\n");
  buf = lines.pop();
  for (const line of lines) if (line.trim()) handle(JSON.parse(line));
});
process.stdin.on("end", () => setTimeout(() => process.exit(0), 20));
function handle(m) {
  log({ method: m.method, params: m.params, job: process.env.SESSIONPIPE_CONTROL_JOB || null, cwd: process.cwd(), start: Date.now() });
  if (m.method === "initialize")
    return reply(m.id, { protocolVersion: 1, agentInfo: { name: "fake-acp", version: "1" }, agentCapabilities: { loadSession: how !== "noload" }, authMethods: [] });
  if (m.method === "session/new") return reply(m.id, { sessionId: session });
  if (m.method === "session/load") {
    if (how === "loadfail") return out({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "no such session" } });
    session = m.params.sessionId;
    return reply(m.id, {});
  }
  if (m.method === "session/cancel") { cancelled?.(); return; }
  if (m.method !== "session/prompt") return;
  const text = m.params.prompt[0].text;
  const done = (stopReason) => reply(m.id, { stopReason });
  if (text.includes("die")) { process.stderr.write("fatal: out of credits\\n"); return process.exit(3); }
  if (text.includes("wait")) { chunk("waiting"); cancelled = () => { chunk(" — stopped"); done("cancelled"); }; return; }
  chunk("On it.");
  setTimeout(() => { chunk("\\n\\nagent did: " + text.replace(/\\n/g, " | ")); done("end_turn"); }, 700);
}
`,
  );
}

const runs = (): { method?: string; params?: Record<string, unknown>; cwd?: string; job?: string | null }[] =>
  existsSync(calls)
    ? readFileSync(calls, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
    : [];
const methods = () => runs().map((r) => r.method);

function cfg(mode: "safe" | "auto" = "safe"): ControlConfig {
  return {
    name: "testbox",
    folders: [project],
    mode,
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

async function startDaemon(
  o: { mode?: "safe" | "auto"; extra?: Partial<DaemonDeps>; noAcp?: boolean; noEnv?: boolean } = {},
) {
  const deps: DaemonDeps = {
    now: Date.now,
    fetch,
    log: process.env.SP_DEBUG ? (s: string) => console.error(`[daemon] ${s}`) : () => {},
    claudeDirs: () => [path.join(tmp, "claude-config")],
    claude: () => null,
    acp: (h) => (h === "goose" || h === "gemini-cli" ? { bin: process.execPath, args: [fake] } : null),
    run: runHeadless,
    env,
    ...o.extra,
  };
  if (o.noAcp) delete deps.acp;
  if (o.noEnv) delete deps.env;
  d = new ControlDaemon(cfg(o.mode), path.join(tmp, "state", "control"), sock, deps);
  await d.start();
}

const aliases = () =>
  JSON.parse(readFileSync(path.join(tmp, "state", "control", "aliases.json"), "utf8")) as Record<
    string,
    { id: string; cwd: string }
  >;
const hello = async () => {
  for (let i = 0; i < 100 && !rx.hellos.length; i++) await new Promise((r) => setTimeout(r, 20));
  return rx.hellos[0];
};

beforeAll(async () => {
  rx = new FakeReceiver();
  await rx.start();
});
afterAll(async () => {
  await rx.stop();
});
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sp-acp-daemon-")));
  project = path.join(tmp, "project");
  mkdirSync(project, { recursive: true });
  sock = path.join(tmp, "control.sock");
  calls = path.join(tmp, "calls.jsonl");
  fake = path.join(tmp, "fake-acp.cjs");
  writeFake();
  env = {
    ...process.env,
    SESSIONPIPE_STATE: path.join(tmp, "state"),
    SESSIONPIPE_CONFIG: path.join(tmp, "config", "config.json"),
    SESSIONPIPE_SOCKET: sock,
  };
  delete env.FAKE_ACP;
  rx.queue.clear();
  rx.acks.length = 0;
  rx.hellos.length = 0;
});
afterEach(async () => {
  await d?.stop();
  d = null;
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("which kinds go where", () => {
  it("every ACP agent can be started; one that isn't an agent can't", () => {
    expect(HEADLESS.has("goose")).toBe(true);
    expect(kindPath("start", "goose")).toBe("start");
    expect(kindPath("start", "gemini-cli")).toBe("start");
    expect(kindPath("start", "kiro")).toEqual({ unsupported: "can't start a kiro session" });
  });
});

const { ACP_HARNESSES } = acpControl;

describe.runIf(unix)("hello", () => {
  it("advertises the agents installed here, and the `api` mode their turns are acked in", async () => {
    await startDaemon();
    expect(await hello()).toMatchObject({ harnesses: ["gemini-cli", "goose"] });
    expect(rx.hellos[0]?.modes).toContain("api");
    await d?.stop();
    rx.hellos.length = 0;
    await startDaemon({ noAcp: true });
    expect(await hello()).toMatchObject({ harnesses: [] });
    expect(rx.hellos[0]?.modes).not.toContain("api");
  });
  it("lists at most 20 harnesses, the first 20 it is given (control-hello.json)", async () => {
    await startDaemon({ noAcp: true, extra: { harnesses: () => ["claude-code", ...ACP_HARNESSES] } });
    const h = (await hello()) as { harnesses: string[]; modes: string[] };
    expect(h.harnesses).toEqual(["claude-code", ...ACP_HARNESSES.slice(0, 19)]);
    expect(h.modes).toContain("api");
    await d?.stop();
    rx.hellos.length = 0;
    // Every agent installed, none of the three: still 20, in the registry's order.
    await startDaemon({ extra: { acp: () => ({ bin: process.execPath, args: [fake] }) } });
    expect(((await hello()) as { harnesses: string[] }).harnesses).toEqual(ACP_HARNESSES.slice(0, 20));
  });
});

describe.runIf(unix)("an agent, driven", () => {
  it("start: the agent in the folder, held; the next message through the same process; cancel is session/cancel", {
    timeout: 20_000,
  }, async () => {
    await startDaemon();
    // A start whose file is gone: failed before any agent runs.
    const png = await rx.upload("shot.png", "image/png", new Uint8Array(16).fill(7));
    rx.files.clear();
    const bad = await rx.send({ kind: "start", session: `goose:${HOOKED}`, cwd: project, text: "look", files: [png] });
    expect(await rx.waitAck(bad.id)).toMatchObject({ outcome: "failed", code: "file" });
    expect(runs()).toEqual([]);
    const q = await rx.send({ kind: "start", session: `goose:${RECV}`, cwd: project, text: "build the thing" });
    const ack = await rx.waitAck(q.id);
    expect(ack).toMatchObject({ outcome: "delivered", mode: "api" });
    expect(ack).not.toHaveProperty("session");
    expect(ack.reply).toMatch(/^On it\.\n\nagent did: build the thing \| {2}\| \(Sent via localhost:\d+/);
    const mine = rx.acks.filter((a) => a.id === q.id).map((a) => a.outcome);
    expect(mine[0]).toBe("taken");
    expect(rx.progress(q.id)[0]).toMatchObject({ seq: 1, reply: "On it." });
    expect(methods()).toEqual(["initialize", "session/new", "session/prompt"]);
    expect(runs()[0]).toMatchObject({ cwd: project, job: "1" });
    expect(runs()[1]?.params).toEqual({ cwd: project, mcpServers: [] });
    expect(runs()[2]?.params).toMatchObject({
      sessionId: SESSION,
      prompt: [
        {
          type: "text",
          text: expect.stringMatching(/^build the thing\n\n\(Sent via localhost:\d+ with sessionpipe control/),
        },
      ],
    });
    // The id the agent picked, under the start's name.
    expect(aliases()[`goose:${RECV}`]).toMatchObject({ id: SESSION, cwd: project });
    expect(d?.status().sdk).toEqual([RECV]);

    const q2 = await rx.send({ session: `goose:${RECV}`, text: "and test it" });
    expect(await rx.waitAck(q2.id)).toMatchObject({
      outcome: "delivered",
      mode: "api",
      reply: expect.stringContaining("and test it"),
    });
    expect(methods()).toEqual(["initialize", "session/new", "session/prompt", "session/prompt"]);
    expect(runs()[3]?.params).toMatchObject({
      prompt: [
        {
          type: "text",
          text: expect.stringMatching(/^Message via localhost:\d+ \(sessionpipe control[^\n]*\n\nand test it/),
        },
      ],
    });

    // A cancel mid-turn ends the turn, and says so in the turn's own reply.
    const q3 = await rx.send({ session: `goose:${RECV}`, text: "wait for me" });
    for (let i = 0; i < 100 && !rx.progress(q3.id).length; i++) await new Promise((r) => setTimeout(r, 20));
    const c = await rx.send({ kind: "cancel", session: `goose:${RECV}`, text: undefined });
    expect(await rx.waitAck(c.id)).toMatchObject({ outcome: "delivered", mode: "api" });
    expect(await rx.waitAck(q3.id)).toMatchObject({
      outcome: "delivered",
      mode: "api",
      reply: "waiting — stopped\n\n(The turn was cancelled.)",
    });
    expect(methods()).toContain("session/cancel");

    // The start's id is taken now.
    const again = await rx.send({ kind: "start", session: `goose:${RECV}`, cwd: project, text: "again" });
    expect(await rx.waitAck(again.id)).toMatchObject({ outcome: "refused", code: "bad_session" });
  });
  it("idle: the agent is closed, and the next message reopens the session in a new run (session/load)", {
    timeout: 20_000,
  }, async () => {
    await startDaemon({ extra: { sdkIdleMs: 2000 } });
    const q = await rx.send({ kind: "start", session: `goose:${RECV}`, cwd: project, text: "build" });
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered", mode: "api" });
    for (let i = 0; i < 200 && d?.status().sdk.length; i++) await new Promise((r) => setTimeout(r, 50));
    expect(d?.status().sdk).toEqual([]);
    const q2 = await rx.send({ session: `goose:${RECV}`, text: "more" });
    expect(await rx.waitAck(q2.id)).toMatchObject({
      outcome: "delivered",
      mode: "resume",
      reply: expect.stringContaining("agent did: Message via"),
    });
    expect(methods()).toEqual([
      "initialize",
      "session/new",
      "session/prompt",
      "initialize",
      "session/load",
      "session/prompt",
    ]);
    expect(runs()[4]?.params).toEqual({ sessionId: SESSION, cwd: project, mcpServers: [] });
    expect(runs()[4]).toMatchObject({ cwd: project, job: "1" });
    // Held again: the one after goes through that process.
    const q3 = await rx.send({ session: `goose:${RECV}`, text: "again" });
    expect(await rx.waitAck(q3.id)).toMatchObject({ outcome: "delivered", mode: "api" });
    expect(methods()).toHaveLength(7);
  });
  it("a session the agent's own hooks reported: reopened by its own id, in the folder the hooks gave", {
    timeout: 20_000,
  }, async () => {
    await startDaemon();
    await ask(sock, { op: "event", session: `gemini-cli:${HOOKED}`, event: "SessionStart", cwd: project }, 500);
    const q = await rx.send({ session: `gemini-cli:${HOOKED}`, text: "hello there" });
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered", mode: "resume" });
    expect(runs()[1]?.params).toEqual({ sessionId: HOOKED, cwd: project, mcpServers: [] });
    // Nobody told the daemon where this one lives.
    const nowhere = await rx.send({ session: `goose:${HOOKED}`, text: "hello?" });
    expect(await rx.waitAck(nowhere.id)).toMatchObject({ outcome: "refused", code: "no_session" });
  });
  it("an agent that can't reopen a session is unsupported once its process is gone", { timeout: 20_000 }, async () => {
    env.FAKE_ACP = "noload";
    await startDaemon({ extra: { sdkIdleMs: 2000 } });
    const q = await rx.send({ kind: "start", session: `goose:${RECV}`, cwd: project, text: "build" });
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered", mode: "api" });
    for (let i = 0; i < 200 && d?.status().sdk.length; i++) await new Promise((r) => setTimeout(r, 50));
    const q2 = await rx.send({ session: `goose:${RECV}`, text: "more" });
    expect(await rx.waitAck(q2.id)).toMatchObject({
      outcome: "unsupported",
      detail: "goose can't reopen a session once it has been closed (no session/load)",
    });
    // One that says it can and then can't: failed, in its words.
    await d?.stop();
    env.FAKE_ACP = "loadfail";
    await startDaemon();
    const q3 = await rx.send({ session: `goose:${RECV}`, text: "more" });
    expect(await rx.waitAck(q3.id)).toMatchObject({ outcome: "failed", detail: "no such session" });
  });
  it("the agent dies mid-turn: failed, let go of, and the next message reopens it", { timeout: 20_000 }, async () => {
    await startDaemon({ noEnv: true });
    const q = await rx.send({ kind: "start", session: `goose:${RECV}`, cwd: project, text: "build" });
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered", mode: "api" });
    const q2 = await rx.send({ session: `goose:${RECV}`, text: "die now" });
    expect(await rx.waitAck(q2.id)).toMatchObject({
      outcome: "failed",
      detail: "goose exited (code 3): fatal: out of credits",
    });
    expect(d?.status().sdk).toEqual([]);
    const q3 = await rx.send({ session: `goose:${RECV}`, text: "back?" });
    expect(await rx.waitAck(q3.id)).toMatchObject({ outcome: "delivered", mode: "resume" });
    // A start whose first turn fails is failed too.
    const q4 = await rx.send({ kind: "start", session: `goose:${HOOKED}`, cwd: project, text: "die at once" });
    expect(await rx.waitAck(q4.id)).toMatchObject({
      outcome: "failed",
      detail: expect.stringMatching(/^goose exited/),
    });
  });
  it("not installed: failed in words, for a start and for a resume; a start that can't open is failed", {
    timeout: 20_000,
  }, async () => {
    await startDaemon();
    const q = await rx.send({ kind: "start", session: `kilo:${RECV}`, cwd: project, text: "build" });
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "failed", detail: "Kilo isn't installed on this machine" });
    await ask(sock, { op: "event", session: `kilo:${HOOKED}`, event: "SessionStart", cwd: project }, 500);
    const q2 = await rx.send({ session: `kilo:${HOOKED}`, text: "hello" });
    expect(await rx.waitAck(q2.id)).toMatchObject({
      outcome: "failed",
      detail: "Kilo isn't installed on this machine",
    });
    await d?.stop();
    await startDaemon({ extra: { acp: () => ({ bin: path.join(tmp, "no-such-agent"), args: [] }) } });
    const q3 = await rx.send({ kind: "start", session: `goose:${RECV}`, cwd: project, text: "build" });
    expect(await rx.waitAck(q3.id)).toMatchObject({
      outcome: "failed",
      detail: expect.stringMatching(/^couldn't start goose: spawn .*ENOENT/),
    });
    expect(d?.status().sdk).toEqual([]);
  });
});
