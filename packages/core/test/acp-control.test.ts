// SPDX-License-Identifier: Apache-2.0
// Any ACP agent as the control daemon drives it (CONTROL.md §6, ADAPTERS.md "Agents
// driven through ACP"): which agents and how they are found, and one JSON-RPC client
// against a stand-in agent that speaks the protocol's own shapes (initialize,
// session/new, session/load, session/prompt, session/update, session/request_permission,
// session/cancel), as recorded from codex-acp 2.2.2 on 2026-10-22; the texts in them are
// made up. The stand-in reads the prompt's text for what to do next.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  ACP_AGENTS,
  ACP_HARNESSES,
  type AcpHeld,
  acpAgent,
  acpHarnesses,
  acpOverride,
  findAcpAgent,
  permissionChoice,
  startAcp,
} from "../src/adapters/acp-control.js";
import { drivableHarnesses, HELLO_HARNESSES_MAX } from "../src/adapters/index.js";

const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sp-acp-")));
const project = path.join(tmp, "project");
mkdirSync(project, { recursive: true });
// A stand-in still leaving may hold the folder for a moment (Windows).
afterAll(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 }));

const SESSION = "01a15fcd-05fc-78f3-83d7-6cc03f65676c"; // what codex-acp named a new session
const fake = path.join(tmp, "fake-acp.cjs");
const calls = path.join(tmp, "calls.jsonl");

/** The stand-in agent: codex-acp 2.2.2's shapes, driven by FAKE_ACP (how it opens) and
 *  by each prompt's first word (how it answers). */
writeFileSync(
  fake,
  `const fs = require("fs");
const how = process.env.FAKE_ACP || "";
// The folder it was started in is what the client is checked on; holding it would keep
// Windows from removing the test's folder while a stand-in is still leaving.
const startCwd = process.cwd();
process.chdir(require("os").tmpdir());
const log = (o) => fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(o) + "\\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const raw = (s) => process.stdout.write(s);
const update = (update) => out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: ${JSON.stringify(SESSION)}, update } });
const chunk = (text, messageId = "msg_1") => update({ sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } });
const reply = (id, result) => out({ jsonrpc: "2.0", id, result });
let nextId = 100;
const waiting = new Map();
const ask = (method, params) => new Promise((res) => { const id = nextId++; waiting.set(id, res); out({ jsonrpc: "2.0", id, method, params }); });
const permission = (title) => ask("session/request_permission", {
  sessionId: ${JSON.stringify(SESSION)},
  toolCall: { toolCallId: "call_" + title, ...(title.startsWith("t:") ? {} : { title }) },
  options: [
    { optionId: "allow-once", name: "Allow", kind: "allow_once" },
    { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
    { optionId: "reject-once", name: "Reject", kind: "reject_once" },
  ],
});
if (how === "stubborn") process.on("SIGTERM", () => {});
let cancelled = null;
let buf = "";
process.stdin.on("data", (b) => {
  buf += b.toString();
  const lines = buf.split("\\n");
  buf = lines.pop();
  for (const line of lines) if (line.trim()) handle(JSON.parse(line));
});
process.stdin.on("end", () => { log({ stdin: "end" }); setTimeout(() => process.exit(0), 50); });
if (how !== "quiet") process.stderr.write("fake-acp starting\\n");
async function handle(m) {
  if (m.id !== undefined && m.method === undefined) { const w = waiting.get(m.id); waiting.delete(m.id); log({ answer: m }); w?.(m); return; }
  log({ method: m.method, params: m.params, job: process.env.SESSIONPIPE_CONTROL_JOB || null, cwd: startCwd });
  if (m.method === "initialize") {
    if (how === "mute") return;
    if (how === "garbage") return reply(m.id, null);
    return reply(m.id, {
      protocolVersion: 1,
      agentInfo: { name: "@agentclientprotocol/codex-acp", title: "Codex", version: "2.2.2" },
      agentCapabilities: { loadSession: how !== "noload", promptCapabilities: { embeddedContext: true, image: true } },
      authMethods: how === "auth" ? [{ id: "chat-gpt", name: "ChatGPT", description: "Use ChatGPT to authenticate" }] : how === "provider" ? [{ id: "goose-provider", name: "Configure Provider" }] : how === "authbare" ? [{ id: "x" }, "junk"] : [],
    });
  }
  if (m.method === "session/new") {
    if (how === "auth" || how === "authbare") return out({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "Authentication required" } });
    if (how === "provider") return out({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: "Internal error", data: "Failed to resolve provider: Configuration value not found: GOOSE_PROVIDER" } });
    if (how === "noid") return reply(m.id, {});
    return reply(m.id, { sessionId: ${JSON.stringify(SESSION)}, models: { availableModels: [] } });
  }
  if (m.method === "session/load") {
    if (how === "loadfail") return out({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "no such session" } });
    // The replay: history that is nobody's answer, and a question outside any turn.
    chunk("old words", "msg_old");
    update({ sessionUpdate: "tool_call", toolCallId: "exec-1", name: "exec_command", kind: "execute", title: "printf 'hi' > hello.txt", status: "completed" });
    await permission("replayed");
    return reply(m.id, {});
  }
  if (m.method === "session/cancel") { log({ cancel: m.params }); cancelled?.(); return; }
  if (m.method !== "session/prompt") return;
  const text = m.params.prompt[0].text;
  const word = text.split(/\\s/)[0];
  const done = (stopReason) => reply(m.id, stopReason === undefined ? {} : { stopReason, usage: null });
  update({ sessionUpdate: "session_info_update", _meta: { codex: { threadStatus: { type: "active" } } } });
  switch (word) {
    case "pong": chunk("pong"); return done("end_turn");
    case "two":
      chunk("I’ll create \`hello.txt\` in this folder.\\n", "msg_a");
      update({ sessionUpdate: "tool_call", toolCallId: "exec-2", name: "exec_command", kind: "execute", title: "printf 'hi' > hello.txt", status: "in_progress" });
      update({ sessionUpdate: "tool_call_update", toolCallId: "exec-2", status: "completed" });
      chunk("hello", "msg_b"); chunk(".txt", "msg_b"); return done("end_turn");
    case "three": chunk("one", "msg_a"); chunk("two", "msg_b"); chunk("three"); return done("end_turn");
    case "ask": {
      const a = await permission("rm -rf build");
      const b = await permission("rm -rf build");
      update({ sessionUpdate: "tool_call", toolCallId: "call_t:titled", title: "git push --force", status: "pending" });
      const c = await permission("t:titled");
      const d = await ask("session/request_permission", { sessionId: ${JSON.stringify(SESSION)}, toolCall: { toolCallId: "call_x", name: "shell" }, options: [] });
      const e = await ask("session/request_permission", { sessionId: ${JSON.stringify(SESSION)}, toolCall: { toolCallId: "" }, options: [{ optionId: "only", name: "x", kind: "reject_always" }] });
      const f = await ask("session/request_permission", { sessionId: ${JSON.stringify(SESSION)}, options: [{ optionId: "no", name: "x", kind: "reject_once" }] });
      chunk("asked: " + [a, b, c, d, e, f].map((r) => JSON.stringify(r.result.outcome)).join(" "));
      return done("end_turn");
    }
    case "many": { for (let i = 0; i < 25; i++) await permission("tool" + i); chunk("many"); return done("end_turn"); }
    case "fsreq": { const r = await ask("fs/read_text_file", { sessionId: ${JSON.stringify(SESSION)}, path: "/x" }); chunk("fs: " + JSON.stringify(r.error)); return done("end_turn"); }
    case "refuse": chunk("No."); return done("refusal");
    case "max": return done("max_tokens");
    case "weird": return done("max_turn_requests");
    case "nostop": return done(undefined);
    case "wait": cancelled = () => { chunk("partial"); done("cancelled"); }; return;
    case "err": return out({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "boom" } });
    case "errcode": return out({ jsonrpc: "2.0", id: m.id, error: { code: 5 } });
    case "errdata": return out({ jsonrpc: "2.0", id: m.id, error: { code: 5, data: { message: "the data says why" } } });
    case "errsame": return out({ jsonrpc: "2.0", id: m.id, error: { code: 5, message: "same", data: "same" } });
    case "errnothing": return out({ jsonrpc: "2.0", id: m.id, error: {} });
    case "die": process.stderr.write("fatal: out of credits\\n"); return process.exit(3);
    case "exit": return process.exit(0);
    case "junk":
      raw("\\n\\nnot json\\n[1,2]\\n\\"str\\"\\n{\\"jsonrpc\\":\\"2.0\\",\\"id\\":999,\\"result\\":{}}\\n{\\"jsonrpc\\":\\"2.0\\",\\"id\\":\\"s\\",\\"result\\":{}}\\n{\\"jsonrpc\\":\\"2.0\\",\\"method\\":\\"_auth/status_update\\",\\"params\\":{}}\\n{\\"jsonrpc\\":\\"2.0\\",\\"method\\":\\"session/update\\"}\\n");
      update({ sessionUpdate: "usage_update", used: 1, size: 2 });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "image", data: "" } });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } });
      update({ sessionUpdate: "tool_call", toolCallId: "", title: "no id" });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "first\\n" } });
      update({ sessionUpdate: "agent_message_chunk", messageId: "m2", content: { type: "text", text: "second" } });
      return done("end_turn");
    case "blank": {
      // One write: a message, an empty line, a line of spaces, a message. The reader
      // must drop the two blanks and deliver both (the blank-line branch, on purpose).
      const line = (text, messageId) => JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text }, ...(messageId ? { messageId } : {}) } } });
      raw(line("one\\n") + "\\n\\n   \\n" + line("two", "m-blank") + "\\n");
      return done("end_turn");
    }
    // Past 4 MB by more than one 64 KB pipe read: the read that crosses 4 MB can never also
    // hold the newline, however far behind the reader is (a 20 kB margin flaked under load).
    case "bigline": raw("x".repeat(4 * 1024 * 1024 + 256 * 1024)); setTimeout(() => { raw("y".repeat(10)); setTimeout(() => { raw("\\n"); chunk("after"); done("end_turn"); }, 50); }, 50); return;
    case "titles": { for (let i = 0; i < 201; i++) update({ sessionUpdate: "tool_call", toolCallId: "t" + i, title: "tool " + i }); chunk("titled"); return done("end_turn"); }
    default: return done("end_turn");
  }
}
`,
);

const runs = (): Record<string, unknown>[] => {
  try {
    return readFileSync(calls, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
};
const held: AcpHeld[] = [];
afterEach(() => {
  for (const h of held.splice(0)) h.close();
  rmSync(calls, { force: true });
});

const base = (extra: Partial<Parameters<typeof startAcp>[0]> = {}) => ({
  bin: process.execPath,
  args: [fake],
  cwd: project,
  mode: "safe" as const,
  label: "Codex",
  env: { ...process.env },
  closeGraceMs: 100,
  ...extra,
});

/** A session opened in the stand-in, kept for the afterEach close. */
async function open(extra: Partial<Parameters<typeof startAcp>[0]> = {}, how = ""): Promise<AcpHeld> {
  const r = await startAcp(base({ env: { ...process.env, FAKE_ACP: how }, ...extra }));
  if (!("held" in r)) throw new Error(JSON.stringify(r));
  held.push(r.held);
  return r.held;
}

/** Run `f` with process.platform reported as `p`; the real value is put back after. */
async function onPlatform<T>(p: NodeJS.Platform, f: () => T | Promise<T>): Promise<T> {
  const real = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
  Object.defineProperty(process, "platform", { value: p, configurable: true });
  try {
    return await f();
  } finally {
    Object.defineProperty(process, "platform", real);
  }
}
const script = (p: string) => {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, "#!/bin/sh\n");
  chmodSync(p, 0o755);
  return p;
};

describe("the agents and where they are", () => {
  it("every agent has a harness name, a registry id and a launch line; names are unique", () => {
    expect(ACP_AGENTS.length).toBeGreaterThan(20);
    expect(new Set(ACP_HARNESSES).size).toBe(ACP_AGENTS.length);
    for (const a of ACP_AGENTS) {
      expect(a.harness).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(a.registry).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(a.bin).toMatch(/^[a-z][a-z0-9-]*$/);
    }
    expect(acpAgent("gemini-cli")).toMatchObject({ registry: "gemini", bin: "gemini", args: ["--acp"] });
    expect(acpAgent("claude-code")).toBeUndefined();
    expect(acpOverride("gemini-cli")).toBe("SESSIONPIPE_ACP_GEMINI_CLI");
  });
  it("found by the override, on PATH, or in an installer's folder; a harness that isn't an agent is never found", async () => {
    const ext = process.platform === "win32" ? ".cmd" : "";
    const bin = path.join(tmp, "bin");
    const gemini = script(path.join(bin, `gemini${ext}`));
    const home = path.join(tmp, "home");
    const goose = script(path.join(home, ".local", "bin", `goose${ext}`));
    const empty = path.join(tmp, "empty");
    mkdirSync(empty, { recursive: true });
    expect(findAcpAgent("gemini-cli", { PATH: bin }, home, empty)).toEqual({ bin: gemini, args: ["--acp"] });
    expect(findAcpAgent("goose", { PATH: empty }, home, empty)).toEqual({ bin: goose, args: ["acp"] });
    expect(findAcpAgent("goose", { PATH: empty, SESSIONPIPE_ACP_GOOSE: gemini }, empty, empty)).toEqual({
      bin: gemini,
      args: ["acp"],
    });
    expect(findAcpAgent("kilo", { PATH: bin }, home, empty)).toBeNull();
    expect(findAcpAgent("codex", { PATH: bin }, home, empty)).toBeNull();
    expect(acpHarnesses({ PATH: bin, HOME: empty })).toContain("gemini-cli");
    expect(drivableHarnesses({ PATH: bin })).toContain("gemini-cli");
    await onPlatform("win32", () => {
      script(path.join(bin, "opencode.cmd"));
      expect(findAcpAgent("opencode", { PATH: bin }, empty, empty)).toEqual({
        bin: path.join(bin, "opencode.cmd"),
        args: ["acp"],
      });
    });
  });
  it.runIf(process.platform !== "win32")(
    "a machine with every agent installed lists 20: the three with their own drivers first, then the registry's order",
    () => {
      const all = path.join(tmp, "all");
      for (const n of ["claude", "codex", "agy", ...ACP_AGENTS.map((a) => a.bin)]) script(path.join(all, n));
      const listed = drivableHarnesses({ PATH: all, SESSIONPIPE_CLAUDE: path.join(all, "claude") });
      expect(listed).toHaveLength(HELLO_HARNESSES_MAX);
      expect(listed).toEqual([
        "claude-code",
        "codex",
        "antigravity",
        ...ACP_HARNESSES.slice(0, HELLO_HARNESSES_MAX - 3),
      ]);
    },
  );
  it("permissionChoice: safe refuses, auto allows, once before always, and nothing fitting is null", () => {
    const opts = [
      { optionId: "a", kind: "allow_always" },
      { optionId: "b", kind: "allow_once" },
      { optionId: "c", kind: "reject_always" },
      "junk",
      { kind: "reject_once" },
      { optionId: "d", kind: "reject_once" },
    ];
    expect(permissionChoice(opts, "safe")).toEqual({ optionId: "d", kind: "reject_once" });
    expect(permissionChoice(opts, "auto")).toEqual({ optionId: "b", kind: "allow_once" });
    // Inherit answers as safe: the agent asked because its own settings want a person.
    expect(permissionChoice(opts, "inherit")).toEqual({ optionId: "d", kind: "reject_once" });
    expect(permissionChoice(opts.slice(0, 1), "auto")).toEqual({ optionId: "a", kind: "allow_always" });
    expect(permissionChoice(opts.slice(2, 3), "safe")).toEqual({ optionId: "c", kind: "reject_always" });
    expect(permissionChoice(opts.slice(0, 2), "safe")).toBeNull();
    expect(permissionChoice("nope", "auto")).toBeNull();
  });
});

describe("one agent, driven", () => {
  it("initialize, session/new in the folder, then a turn: the chunks are the reply, in SESSIONPIPE_CONTROL_JOB", async () => {
    const seen: string[] = [];
    const log: string[] = [];
    const h = await open({ onText: (t) => seen.push(t), log: (l) => log.push(l) });
    expect(h.session).toBe(SESSION);
    expect(h.mode).toBe("api");
    expect(h.busy).toBe(false);
    expect(h.closed).toBe(false);
    expect(log).toEqual(["Codex: @agentclientprotocol/codex-acp 2.2.2 (ACP 1)"]);
    const p = h.send("pong please");
    expect(h.busy).toBe(true);
    expect(await p).toEqual({ reply: "pong" });
    expect(h.busy).toBe(false);
    expect(seen).toEqual(["pong"]);
    const [init, fresh, prompt] = runs();
    expect(init).toMatchObject({
      method: "initialize",
      job: "1",
      cwd: project,
      params: {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "sessionpipe" },
      },
    });
    expect(fresh).toMatchObject({ method: "session/new", params: { cwd: project, mcpServers: [] } });
    expect(prompt).toMatchObject({
      method: "session/prompt",
      params: { sessionId: SESSION, prompt: [{ type: "text", text: "pong please" }] },
    });
    // The next turn in the same process.
    expect(await h.send("two")).toEqual({ reply: "I’ll create `hello.txt` in this folder.\n\nhello.txt" });
    expect(await h.send("three")).toEqual({ reply: "one\n\ntwo\n\nthree" });
    expect(await h.send("silent")).toEqual({ reply: "(Codex finished without a written reply.)" });
  });
  it("permissions: safe refuses and the reply lists what, auto allows; anything else the agent asks is not found", async () => {
    const h = await open();
    expect(await h.send("ask")).toEqual({
      reply:
        'asked: {"outcome":"selected","optionId":"reject-once"} {"outcome":"selected","optionId":"reject-once"} {"outcome":"selected","optionId":"reject-once"} {"outcome":"cancelled"} {"outcome":"selected","optionId":"only"} {"outcome":"selected","optionId":"no"}' +
        "\n\n(Not allowed on this machine, since nobody was there to approve: rm -rf build, git push --force, shell.)",
    });
    expect(await h.send("many")).toEqual({
      reply: `many\n\n(Not allowed on this machine, since nobody was there to approve: ${Array.from({ length: 20 }, (_, i) => `tool${i}`).join(", ")}.)`,
    });
    expect(await h.send("fsreq")).toEqual({
      reply: 'fs: {"code":-32601,"message":"Method not found: fs/read_text_file"}',
    });
    const auto = await open({ mode: "auto" });
    expect(await auto.send("ask")).toEqual({
      reply:
        'asked: {"outcome":"selected","optionId":"allow-once"} {"outcome":"selected","optionId":"allow-once"} {"outcome":"selected","optionId":"allow-once"} {"outcome":"cancelled"} {"outcome":"cancelled"} {"outcome":"cancelled"}' +
        "\n\n(Not allowed on this machine, since nobody was there to approve: shell.)",
    });
  });
  it("how a turn ends: refusal and a cancel say so, max_tokens is an answer, anything else is an error", async () => {
    const h = await open();
    expect(await h.send("refuse")).toEqual({ reply: "No.\n\n(Codex refused the request.)" });
    expect(await h.send("max")).toEqual({ reply: "(Codex finished without a written reply.)" });
    expect(await h.send("weird")).toEqual({ reply: "", error: "Codex ended the turn with max_turn_requests" });
    expect(await h.send("nostop")).toEqual({ reply: "", error: "Codex ended the turn with no stop reason" });
    expect(await h.send("err")).toEqual({ reply: "", error: "boom" });
    expect(await h.send("errcode")).toEqual({ reply: "", error: "Codex returned error 5" });
    expect(await h.send("errdata")).toEqual({ reply: "", error: "the data says why" });
    expect(await h.send("errsame")).toEqual({ reply: "", error: "same" });
    expect(await h.send("errnothing")).toEqual({ reply: "", error: "Codex returned error ?" });
    const p = h.send("wait for it");
    await new Promise((r) => setTimeout(r, 100));
    await h.interrupt();
    expect(await p).toEqual({ reply: "partial\n\n(The turn was cancelled.)" });
    expect(runs().filter((r) => r.cancel)).toHaveLength(1);
  });
  it("a turn over its time is cancelled, then the agent is closed", async () => {
    const h = await open({ timeoutMs: 200 });
    expect(await h.send("wait")).toEqual({
      reply: "",
      error: "Codex was still working after 0 minutes, so it was stopped",
    });
    expect(runs().filter((r) => r.cancel)).toHaveLength(1);
  });
  it("lines that aren't the protocol's are skipped, a line over 4 MB is dropped, titles are kept for 200 tool calls", async () => {
    const h = await open();
    expect(await h.send("junk")).toEqual({ reply: "first\n\nsecond" });
    expect(await h.send("blank")).toEqual({ reply: "one\n\ntwo" });
    expect(await h.send("bigline")).toEqual({ reply: "after" });
    expect(await h.send("titles")).toEqual({ reply: "titled" });
  }, 20_000);
  it("the agent dies mid-turn: the error names the exit and stderr's tail, and nothing more can be sent", async () => {
    const h = await open();
    expect(await h.send("die")).toEqual({
      reply: "",
      error: "Codex exited (code 3): fake-acp starting fatal: out of credits",
    });
    expect(h.closed).toBe(true);
    expect(await h.send("pong")).toEqual({
      reply: "",
      error: "Codex exited (code 3): fake-acp starting fatal: out of credits",
    });
    await h.interrupt();
    const quiet = await open({}, "quiet");
    const before = quiet.lastUsed;
    expect(await quiet.send("exit")).toEqual({ reply: "", error: "Codex exited (code 0)" });
    expect(quiet.lastUsed).toBeGreaterThanOrEqual(before);
  });
  it("close ends stdin, then SIGTERM, then SIGKILL for an agent that ignores it; closing twice is nothing", async () => {
    const h = await open({ closeGraceMs: 50 }, "stubborn");
    h.close();
    h.close();
    await new Promise((r) => setTimeout(r, 700));
    expect(h.closed).toBe(true);
    expect(await h.send("pong")).toEqual({ reply: "", error: "Codex was closed" });
    // A close after the process left: the kill finds nobody and says nothing.
    const g = await open({ closeGraceMs: 50 });
    await g.send("die");
    g.close();
    await new Promise((r) => setTimeout(r, 150));
    await onPlatform("win32", async () => {
      const w = await open({ closeGraceMs: 50 }, "stubborn");
      w.close();
      await new Promise((r) => setTimeout(r, 500));
      expect(w.closed).toBe(true);
    });
  });
  it("reopening: session/load where the agent can, its replay is nobody's answer; an agent that can't is unsupported", async () => {
    const seen: string[] = [];
    const h = await open({ load: SESSION, onText: (t) => seen.push(t) });
    expect(h.session).toBe(SESSION);
    expect(runs()[1]).toMatchObject({
      method: "session/load",
      params: { sessionId: SESSION, cwd: project, mcpServers: [] },
    });
    expect(seen).toEqual([]);
    expect(await h.send("pong")).toEqual({ reply: "pong" });
    const { closeGraceMs: _, ...defaultGrace } = base({ load: SESSION, env: { ...process.env, FAKE_ACP: "noload" } });
    expect(await startAcp(defaultGrace)).toEqual({
      unsupported: "Codex can't reopen a session once it has been closed (no session/load)",
    });
    expect(await startAcp(base({ load: SESSION, env: { ...process.env, FAKE_ACP: "loadfail" } }))).toEqual({
      failed: "no such session",
    });
  });
  it("opening fails in words: not signed in, no session id, an agent that says nothing, one that can't start", async () => {
    expect(await startAcp(base({ env: { ...process.env, FAKE_ACP: "auth" } }))).toEqual({
      failed:
        "Authentication required (if Codex wants a sign-in, do it at the machine's terminal: Use ChatGPT to authenticate)",
    });
    expect(await startAcp(base({ env: { ...process.env, FAKE_ACP: "authbare" } }))).toEqual({
      failed: "Authentication required (if Codex wants a sign-in, do it at the machine's terminal)",
    });
    // goose 1.55: the reason in the error's data, the way in the auth method's name.
    expect(await startAcp(base({ label: "goose", env: { ...process.env, FAKE_ACP: "provider" } }))).toEqual({
      failed:
        "Internal error: Failed to resolve provider: Configuration value not found: GOOSE_PROVIDER (if goose wants a sign-in, do it at the machine's terminal: Configure Provider)",
    });
    expect(await startAcp(base({ env: { ...process.env, FAKE_ACP: "noid" } }))).toEqual({
      failed: "Codex opened a session without naming it",
    });
    // An initialize answer that is no object says nothing about the agent, and the session still opens.
    const log: string[] = [];
    const g = await open({ log: (l) => log.push(l) }, "garbage");
    expect(log).toEqual(["Codex: agent  (ACP ?)"]);
    expect(await g.send("pong")).toEqual({ reply: "pong" });
    expect(await startAcp(base({ env: { ...process.env, FAKE_ACP: "mute" }, openTimeoutMs: 100 }))).toEqual({
      failed: "Codex didn't answer initialize in 0 s",
    });
    expect(await startAcp(base({ bin: "" }))).toMatchObject({
      failed: expect.stringMatching(/^couldn't start Codex: /),
    });
    expect(await startAcp(base({ bin: path.join(tmp, "no-such-agent") }))).toMatchObject({
      failed: expect.stringMatching(/^couldn't start Codex: spawn .* ENOENT/),
    });
  });
});
