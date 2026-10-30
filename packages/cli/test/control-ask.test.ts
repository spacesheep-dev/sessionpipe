// SPDX-License-Identifier: Apache-2.0
// A session asking another agent through the daemon (CONTROL.md §13) and a handoff's
// `reply_to` (§6): the ask op on the local socket and its wire (askMany), every refusal
// in order with its code, a new Codex session and an existing one through the same
// runs a receiver's start and prompt take, the child's framing and environment, the
// events on the asking session through its own outbox to a sink, and the relay of a
// command's reply into another session. The agents are stand-ins: control-harnesses'
// `codex exec` and control-daemon's `claude -p`, both recording how they were run.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, Outbox, runHeadless, shortId, takeLock, writeConfig } from "@sessionpipe/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { askCode, askProblem, ControlDaemon, type DaemonDeps, type SdkHost } from "../src/control/daemon.js";
import { type AskRequest, ask, askMany, type LocalReply } from "../src/control/local.js";
import { frameAsk, frameHandoff } from "../src/control/route.js";
import type { ControlConfig, ControlMode } from "../src/control/store.js";
import { waitForMessage } from "../src/control/wait.js";
import { factsState } from "../src/run.js";
import { FakeReceiver } from "./helpers/receiver.js";

const THREAD = "0199b6f2-7c1d-7e3a-9b4c-5d6e7f8a9b0c"; // the thread a new `codex exec` picks
const SID = "8c132906-8c3f-4814-870a-afc3d05e1d2e"; // a Claude Code session with a transcript here
const ASKER = `claude-code:${SID}`;
const RECV = "0b6f2c7e-3d4a-4f1b-9c8e-2a1d5e6f7e01"; // the id a receiver's start names
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const unix = process.platform !== "win32";

let tmp: string;
let rx: FakeReceiver;
let d: ControlDaemon | null = null;
let env: NodeJS.ProcessEnv;
let sock: string;
let project: string;
let configDir: string;
let calls: string;
let sinkFile: string;
let fakeCodex: string;
let fakeClaude: string;

/** Both stand-ins log how they were run, and what an asked child sees in its env. */
function writeFakes(): void {
  const head = `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const a = process.argv.slice(2);
const log = (o) => fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(o) + "\\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
log({ bin: path.basename(process.argv[1]), argv: a, cwd: process.cwd(), job: process.env.SESSIONPIPE_CONTROL_JOB || null,
  asked_by: process.env.SESSIONPIPE_ASKED_BY || null, chain: process.env.SESSIONPIPE_ASK_CHAIN || null,
  launched_by: process.env.SESSIONPIPE_LAUNCHED_BY || null });
`;
  writeFileSync(
    fakeCodex,
    `${head}
const resume = a[1] === "resume";
const id = resume ? a[a.indexOf("--") + 1] : ${JSON.stringify(THREAD)};
const prompt = a[a.length - 1];
if (!resume) {
  const day = path.join(process.env.CODEX_HOME, "sessions", "2026", "10", "28");
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, "rollout-2026-10-28T10-00-00-" + id + ".jsonl"),
    JSON.stringify({ type: "session_meta", payload: { id, cwd: process.cwd() } }) + "\\n");
}
out({ type: "thread.started", thread_id: id });
out({ type: "turn.started" });
out({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "On it." } });
setTimeout(() => {
  out({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: "codex did: " + prompt.replace(/\\n/g, " | ") } });
  out({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
}, 600);
`,
  );
  writeFileSync(
    fakeClaude,
    `${head}
const i = a.indexOf("--resume"), j = a.indexOf("--session-id");
const sid = i >= 0 ? a[i + 1] : j >= 0 ? a[j + 1] : "x";
process.stdout.write(JSON.stringify({ type: "result", result: "claude did: " + a[a.length - 1].split("\\n")[0], session_id: sid, is_error: false }));
`,
  );
  chmodSync(fakeCodex, 0o755);
  chmodSync(fakeClaude, 0o755);
}

interface Run {
  bin: string;
  argv: string[];
  cwd: string;
  job: string | null;
  asked_by: string | null;
  chain: string | null;
  launched_by: string | null;
}
const runs = (): Run[] =>
  existsSync(calls)
    ? readFileSync(calls, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Run)
    : [];

/** A Claude Code transcript for SID in `cwd`, written ten minutes ago (so not live). */
function transcript(sid: string, cwd: string): void {
  const dir = path.join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${sid}.jsonl`);
  writeFileSync(f, `${JSON.stringify({ type: "user", cwd, message: { content: "hi" } })}\n`);
  const past = new Date(Date.now() - 600_000);
  utimesSync(f, past, past);
}

/** The session answers in its own turn, as the daemon reads it from the transcript. */
function answer(sid: string, cwd: string, text: string): void {
  const f = path.join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sid}.jsonl`);
  writeFileSync(
    f,
    `${JSON.stringify({ type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "text", text }] } })}\n`,
    { flag: "a" },
  );
}

interface Setup {
  receivers?: boolean;
  ask?: boolean;
  mode?: ControlMode;
  limits?: ControlConfig["limits"];
  extra?: Partial<DaemonDeps>;
}

function cfg(o: Setup) {
  const c: ControlConfig = {
    name: "testbox",
    folders: [project],
    mode: o.mode ?? "safe",
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
  return c;
}

async function startDaemon(o: Setup = {}) {
  d = new ControlDaemon(cfg(o), path.join(tmp, "state", "control"), sock, {
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
    // Nobody answers in a session with no process: a turn's answer is waited for briefly.
    answerWaitMs: 5000,
    ...o.extra,
  });
  await d.start();
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
async function askIt(r: AskRequest) {
  const got: LocalReply[] = [];
  const end = await askMany(sock, r, (x) => got.push(x), 15_000);
  return { got, end };
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

const aliases = () =>
  JSON.parse(readFileSync(path.join(tmp, "state", "control", "aliases.json"), "utf8")) as Record<
    string,
    { id: string; cwd: string }
  >;

beforeAll(async () => {
  rx = new FakeReceiver();
  await rx.start();
});
afterAll(async () => {
  await rx.stop();
});
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sp-ask-")));
  project = path.join(tmp, "project");
  configDir = path.join(tmp, "claude-config");
  mkdirSync(project, { recursive: true });
  mkdirSync(path.join(configDir, "sessions"), { recursive: true });
  mkdirSync(path.join(tmp, "bin"));
  sock = path.join(tmp, "control.sock");
  calls = path.join(tmp, "calls.jsonl");
  sinkFile = path.join(tmp, "sink.jsonl");
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
  // A sink at tier 1: what the daemon records on the asking session must reach it. The
  // machine's name is the one the hooks' events carry (config.json), not the hello's.
  writeConfig(
    { ...DEFAULT_CONFIG, machine: "testbox", sinks: [{ name: "file", url: `file:${sinkFile}`, tier: 1, pii: false }] },
    env.SESSIONPIPE_CONFIG,
  );
  transcript(SID, project);
  rx.queue.clear();
  rx.acks.length = 0;
  rx.hellos.length = 0;
});
afterEach(async () => {
  await d?.stop();
  d = null;
  rmSync(tmp, { recursive: true, force: true });
});

describe("the wire (local.ts askMany)", () => {
  let server: net.Server | null = null;
  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = null;
  });
  /** A daemon that answers each connection with the next handler. */
  function serve(handlers: ((s: net.Socket) => void)[]): Promise<void> {
    return new Promise((resolve) => {
      server = net.createServer((s) => {
        s.on("data", () => handlers.shift()?.(s));
        s.on("error", () => {});
      });
      server.listen(sock, resolve);
    });
  }
  const line = (o: unknown) => `${JSON.stringify(o)}\n`;

  it.runIf(unix)("every reply in order, then the one that ends it; the connection may split a line", async () => {
    await serve([
      (s) => {
        s.write(line({ op: "asked", ask_id: "01K", session: "codex:x" }));
        s.write(`${line({ op: "progress", text: "On", seq: 1 }).slice(0, 10)}`);
        setTimeout(() => {
          s.write(line({ op: "progress", text: "On", seq: 1 }).slice(10));
          s.end(line({ op: "answer", ask_id: "01K", session: "codex:x", text: "done", ms: 5 }));
        }, 20);
      },
    ]);
    const got: LocalReply[] = [];
    const end = await askMany(sock, req(), (r) => got.push(r), 2000);
    expect(got.map((r) => r.op)).toEqual(["asked", "progress", "answer"]);
    expect(end).toEqual({ op: "answer", ask_id: "01K", session: "codex:x", text: "done", ms: 5 });
  });

  it.runIf(unix)("a garbled line, a connection that closes before the end, no daemon, a timeout: nothing", async () => {
    await serve([(s) => s.end("not json\n"), (s) => s.end(line({ op: "asked", ask_id: "01K" })), () => {}]);
    const seen: string[] = [];
    expect(await askMany(sock, req(), (r) => seen.push(r.op), 2000)).toBeNull();
    expect(await askMany(sock, req(), (r) => seen.push(r.op), 2000)).toBeNull();
    expect(await askMany(sock, req(), (r) => seen.push(r.op), 150)).toBeNull();
    expect(seen).toEqual(["asked"]);
    expect(await askMany(path.join(tmp, "nobody.sock"), req(), (r) => seen.push(r.op), 500)).toBeNull();
  });
});

describe("the request's shape (askProblem)", () => {
  it("names the field that is out of shape, or nothing", () => {
    expect(askProblem(req())).toBeNull();
    expect(askProblem(req({ session: `codex:${THREAD}`, permission: "read", model: "o3", pid: 7 }))).toBeNull();
    expect(askProblem(req({ harness: "Codex!" }))).toMatch(/which agent/);
    expect(askProblem(req({ session: "nope" }))).toMatch(/<harness>:<id>/);
    expect(askProblem(req({ session: ASKER }))).toMatch(/isn't a codex session/);
    expect(askProblem(req({ from: "nope" }))).toMatch(/from is/);
    expect(askProblem(req({ text: "   " }))).toMatch(/needs text/);
    expect(askProblem(req({ text: "x".repeat(20_001) }))).toMatch(/20000 characters/);
    expect(askProblem(req({ cwd: "relative" }))).toMatch(/absolute folder/);
    expect(askProblem(req({ chain: "a" as unknown as string[] }))).toMatch(/chain is/);
    expect(askProblem(req({ chain: [""] }))).toMatch(/chain is/);
    expect(askProblem(req({ chain: ["not a ref\n"] }))).toMatch(/chain is a list of sessions/);
    expect(askProblem(req({ chain: Array.from({ length: 9 }, () => ASKER) }))).toMatch(/chain is/);
    expect(askProblem(req({ permission: "auto" as "read" }))).toMatch(/read or safe/);
    expect(askProblem(req({ model: "-bad" }))).toMatch(/a model is/);
    expect(askProblem(req({ pid: 1.5 }))).toMatch(/pid/);
  });
  it("a run's refusal in the ask's own words (askCode)", () => {
    expect(["no_session", "bad_session", "permission", "model", "start_limit", undefined].map(askCode)).toEqual([
      "harness",
      "harness",
      "bad_fields",
      "bad_fields",
      "start_limit",
      "failed",
    ]);
  });
});

describe("the framing (route.ts)", () => {
  it("an ask says who asked and that the answer goes back by itself; a handoff says who answered and via where", () => {
    expect(frameAsk("do it", ASKER)).toBe(
      `do it\n\n(Asked by ${ASKER} on this machine with sessionpipe ask. Answer here in full: your reply is returned to that session automatically. Don't run a command or call a tool just to send it.)`,
    );
    expect(frameAsk("do it", undefined)).toContain("(Asked by another session on this machine");
    expect(frameHandoff({ harness: "codex", id: RECV }, "https://spacesheep.dev", "Looks right.")).toBe(
      `Answer from codex:${shortId("codex", RECV)} (sessionpipe handoff, asked via spacesheep.dev):\n\nLooks right.`,
    );
    expect(frameHandoff({ harness: "codex", id: RECV }, "not a url", "x")).toContain("asked via not a url");
  });
});

describe.runIf(unix)("sessionpipe ask (CONTROL.md §13)", () => {
  it("a new Codex session: asked, the answer as it is written, the answer; the child is framed and knows who asked; the events reach the asker's sink", {
    timeout: 20_000,
  }, async () => {
    await startDaemon();
    // What the worker last learned of the asker goes on its events, as on a hook's.
    factsState(path.join(tmp, "state")).save("claude-code", SID, {
      session: { cwd: path.join(os.homedir(), "proj"), branch: "main" },
    });
    const { got, end } = await askIt(req({ text: "review this diff" }));
    expect(got.map((r) => r.op)).toEqual(["asked", "progress", "answer"]);
    const asked = got[0] as { op: "asked"; ask_id: string; session: string };
    expect(asked.ask_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(asked.session).toMatch(/^codex:/);
    expect(parseUuid(asked.session)).toBe(true);
    expect(got[1]).toMatchObject({ op: "progress", text: "On it.", seq: 1 });
    expect(end).toMatchObject({ op: "answer", ask_id: asked.ask_id, session: asked.session });
    const a = end as { text: string; ms: number };
    expect(a.text).toMatch(
      /^On it\.\n\ncodex did: review this diff \| {2}\| \(Asked by claude-code:8c132906-[^|]+ on this machine with sessionpipe ask\. Answer here in full: your reply is returned to that session automatically\. Don't run a command or call a tool just to send it\.\)$/,
    );
    expect(a.ms).toBeGreaterThan(0);
    // Run as a start is: in the folder, as a control job, at the machine's mode; with its lineage.
    const [run] = runs();
    expect(run).toMatchObject({ bin: "codex", cwd: project, job: "1", asked_by: ASKER, chain: ASKER });
    expect(run?.argv.slice(0, 7)).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-C",
      project,
      "-s",
      "workspace-write",
    ]);
    expect(run?.argv.at(-1)).toBe(frameAsk("review this diff", ASKER));
    // The thread Codex picked, under the ask's name: a later ask continues it.
    expect(aliases()[asked.session]).toMatchObject({ id: THREAD, cwd: project });
    // The events on the asker, through its own outbox with its own seq, then the sink.
    const ev = await until(() => (events("claude-code", SID).length === 2 ? events("claude-code", SID) : null));
    expect(ev.map((e) => [e.type, e.session.seq, e.harness.name, e.harness.event, e.session.machine])).toEqual([
      ["delegation.started", 0, "claude-code", "ask", "testbox"],
      ["delegation.ended", 1, "claude-code", "ask", "testbox"],
    ]);
    expect(ev[0]?.session).toMatchObject({ id: SID, cwd: "~/proj", branch: "main" });
    expect(ev[0]?.data).toEqual({
      ask_id: asked.ask_id,
      via: "ask",
      harness: "codex",
      to: asked.session,
      text: "review this diff",
    });
    expect(ev[1]?.data).toMatchObject({ ask_id: asked.ask_id, to: asked.session, ok: true, reply: a.text });
    expect(ev[1]?.data.ms).toBeGreaterThan(0);
    const sunk = await until(() => (existsSync(sinkFile) ? readFileSync(sinkFile, "utf8").trim().split("\n") : null));
    expect(sunk.map((l) => (JSON.parse(l) as { type: string }).type)).toEqual([
      "delegation.started",
      "delegation.ended",
    ]);
    expect(d?.status().ask).toEqual({ on: true, harnesses: ["claude-code", "codex"] });
    expect(d?.status().delivered).toEqual({ resume: 1 });
  });

  it("an existing session: the thread the daemon knows is resumed, under the ask's cap", {
    timeout: 20_000,
  }, async () => {
    await startDaemon();
    const first = await askIt(req({ text: "build it" }));
    const session = (first.end as { session: string }).session;
    const { got, end } = await askIt(req({ session, text: "and test it", permission: "read", from: "gemini-cli:g1" }));
    // The session is known at once: it is the one asked for.
    expect(got[0]).toEqual({ op: "asked", ask_id: expect.any(String), session });
    expect(end).toMatchObject({
      op: "answer",
      session,
      text: expect.stringMatching(/^On it\.\n\ncodex did: and test it/),
    });
    const second = runs()[1];
    expect(second?.argv).toEqual([
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      "-c",
      'sandbox_mode="read-only"',
      "--",
      THREAD,
      frameAsk("and test it", "gemini-cli:g1"),
    ]);
    expect(second).toMatchObject({ asked_by: "gemini-cli:g1", chain: "gemini-cli:g1" });
    const ev = await until(() => (events("gemini-cli", "g1").length === 2 ? events("gemini-cli", "g1") : null));
    expect(ev.map((e) => e.type)).toEqual(["delegation.started", "delegation.ended"]);
    expect(ev[0]?.data).toMatchObject({ via: "ask", harness: "codex", to: session });
  });

  it("an existing Claude Code session with a waiter: in place, as an ask, the answer read from its transcript", async () => {
    await startDaemon();
    const waited = waitForMessage(ASKER, { env });
    await new Promise((r) => setTimeout(r, 100));
    const pending = askIt(req({ harness: "claude-code", session: ASKER, from: `codex:${THREAD}`, text: "look again" }));
    const text = await waited;
    expect(text).toContain(frameAsk("look again", `codex:${THREAD}`));
    expect(text).not.toContain("Message via");
    answer(SID, project, "Looks right.");
    const { got, end } = await pending;
    expect(got[0]).toMatchObject({ op: "asked", session: ASKER });
    expect(end).toMatchObject({ op: "answer", session: ASKER, text: "Looks right." });
    expect(runs()).toEqual([]);
  });

  it("no asker named: no events; the chain still grows, so the child can't ask without end", {
    timeout: 20_000,
  }, async () => {
    await startDaemon();
    const anon = req({ chain: ["gemini-cli:g1"] });
    delete anon.from;
    const { end } = await askIt(anon);
    expect(end?.op).toBe("answer");
    expect(runs()[0]).toMatchObject({ asked_by: null, chain: "gemini-cli:g1,unknown" });
    expect(runs()[0]?.argv.at(-1)).toContain("(Asked by another session on this machine");
    expect(existsSync(path.join(tmp, "state", "outbox"))).toBe(false);
  });

  it("refusals, each with its code, in order: asking off, an agent it can't run, a session it can't reach, a folder off the list, two deep, fields out of shape, a loop, the start caps", {
    timeout: 30_000,
  }, async () => {
    // Two starts an hour: a refused start counts, as a receiver's does (CONTROL.md §6).
    await startDaemon({ ask: false, limits: { start_per_hour: 2 } });
    const refused = async (r: AskRequest) => {
      const { got, end } = await askIt(r);
      expect(got).toEqual([end]);
      expect(end?.op).toBe("refused");
      return end as { code: string; detail: string };
    };
    expect(await refused(req())).toMatchObject({
      code: "ask_off",
      detail: expect.stringContaining("sessionpipe ask on"),
    });
    d?.reload(cfg({ ask: true, limits: { start_per_hour: 2 } }));
    expect(await refused(req({ harness: "kiro" }))).toMatchObject({
      code: "harness",
      detail: "this machine can't start a kiro session; it can ask claude-code, codex",
    });
    const unknown = `claude-code:${SID.replace(/^8c/, "9d")}`;
    expect(await refused(req({ harness: "claude-code", session: unknown }))).toMatchObject({
      code: "harness",
      detail: expect.stringMatching(/no Claude Code session .* on this machine/),
    });
    // A session the hooks reported but no mode can reach.
    await ask(sock, { op: "event", session: "kiro:k1", event: "SessionStart", cwd: project }, 500);
    expect(await refused(req({ harness: "kiro", session: "kiro:k1" }))).toMatchObject({
      code: "harness",
      detail: "no idle delivery for kiro yet",
    });
    expect(await refused(req({ cwd: tmp }))).toMatchObject({ code: "folder", detail: expect.stringContaining(tmp) });
    const elsewhere = path.join(tmp, "elsewhere");
    mkdirSync(elsewhere);
    const OTHER = SID.replace(/^8c/, "7b");
    transcript(OTHER, elsewhere);
    expect(await refused(req({ harness: "claude-code", session: `claude-code:${OTHER}` }))).toMatchObject({
      code: "folder",
    });
    expect(await refused(req({ chain: ["gemini-cli:a1", "codex:b2"] }))).toMatchObject({
      code: "depth",
      detail: "an ask goes 2 deep at most: gemini-cli:a1 asked codex:b2, which asked this session, which can't ask on",
    });
    expect(await refused(req({ text: " " }))).toMatchObject({ code: "bad_fields" });
    expect(await refused({ ...req(), permission: "auto" as "read" })).toMatchObject({ code: "bad_fields" });
    // A level this machine's Claude Code can't start at: the request's fault, in the run's words.
    expect(await refused(req({ harness: "claude-code", permission: "read" }))).toMatchObject({
      code: "bad_fields",
      detail: expect.stringMatching(/read|plan/),
    });
    expect(runs()).toEqual([]);
    // One real ask takes the hour's one start…
    const first = await askIt(req({ chain: ["gemini-cli:g1"] }));
    const session = (first.end as { session: string }).session;
    expect(first.end?.op).toBe("answer");
    // …and the session it made can't be asked by itself, or by anyone waiting on it.
    expect(await refused(req({ session, from: session }))).toMatchObject({ code: "loop" });
    expect(await refused(req({ session, chain: [session] }))).toMatchObject({ code: "loop" });
    // The caps count an ask's start as a receiver's: the next new session is over budget,
    // refused before it began (no `asked`).
    const capped = await askIt(req({ text: "one more" }));
    expect(capped.got.map((r) => r.op)).toEqual(["refused"]);
    expect(capped.end).toMatchObject({ code: "start_limit", detail: expect.stringContaining("limit") });
    // Which the asker's events say too: every ask that passed the checks left a started
    // and an ended (the refused level, the real one, this one); the last says ok false.
    const ev = await until(() => (events("claude-code", SID).length === 6 ? events("claude-code", SID) : null));
    expect(ev.map((e) => e.type)).toEqual([
      "delegation.started",
      "delegation.ended",
      "delegation.started",
      "delegation.ended",
      "delegation.started",
      "delegation.ended",
    ]);
    expect(ev[1]?.data).toMatchObject({ ok: false, error: expect.stringMatching(/plan|read/) });
    expect(ev[3]?.data).toMatchObject({ ok: true });
    expect(ev[5]?.data).toMatchObject({ ok: false, error: expect.stringContaining("limit") });
    expect(ev[5]?.data).not.toHaveProperty("reply");
    expect(runs()).toHaveLength(1);
  });
});

describe.runIf(unix)("a handoff (CONTROL.md §6 reply_to)", () => {
  it("the reply follows into reply_to after the command's one final ack, framed as a handoff; the events on reply_to say relayed", {
    timeout: 20_000,
  }, async () => {
    await startDaemon({ receivers: true });
    const hello = await until(() => rx.hellos.at(-1));
    expect(hello).toMatchObject({ ask: true, handoff: true });
    const q = await rx.send({
      kind: "start",
      session: `codex:${RECV}`,
      cwd: project,
      text: "second opinion",
      reply_to: ASKER,
    });
    const ack = await rx.waitAck(q.id);
    expect(ack).toMatchObject({ outcome: "delivered", mode: "resume" });
    // The command's child was asked, as far as its hooks know, by reply_to.
    expect(runs()[0]).toMatchObject({ bin: "codex", asked_by: ASKER, chain: ASKER });
    // Then the reply into reply_to: a headless resume of SID, framed as a handoff, with no lineage of its own.
    const relay = await until(() => runs().find((r) => r.bin === "claude"));
    expect(relay).toMatchObject({ cwd: project, job: "1", asked_by: null, chain: null });
    expect(relay.argv).toContain("--resume");
    expect(relay.argv[relay.argv.indexOf("--resume") + 1]).toBe(SID);
    expect(relay.argv.at(-1)).toBe(frameHandoff({ harness: "codex", id: RECV }, rx.url, ack.reply as string));
    expect(relay.argv.at(-1)).toMatch(
      /^Answer from codex:[0-9a-f]{8} \(sessionpipe handoff, asked via localhost:\d+\):\n\nOn it\.\n\ncodex did: second opinion/,
    );
    const ev = await until(() => (events("claude-code", SID).length === 2 ? events("claude-code", SID) : null));
    expect(ev[0]?.data).toEqual({
      ask_id: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/),
      via: "handoff",
      harness: "codex",
      to: `codex:${RECV}`,
      text: "second opinion",
    });
    expect(ev[0]?.harness.event).toBe("handoff");
    expect(ev[1]?.data).toMatchObject({
      ask_id: ev[0]?.data.ask_id,
      to: `codex:${RECV}`,
      ok: true,
      relayed: "delivered",
      reply: ack.reply,
    });
    // Exactly one final ack for the command, and none at all for the relay.
    const finals = rx.acks.filter((a) => a.id === q.id && a.outcome !== "taken" && a.outcome !== "progress");
    expect(finals).toHaveLength(1);
    expect(rx.acks.every((a) => a.id === q.id)).toBe(true);
  });

  it("a session no mode fits: relayed unsupported, and why", { timeout: 20_000 }, async () => {
    await startDaemon({ receivers: true });
    await ask(sock, { op: "event", session: "kiro:k1", event: "SessionStart", cwd: project }, 500);
    const q = await rx.send({ kind: "start", session: `codex:${RECV}`, cwd: project, text: "go", reply_to: "kiro:k1" });
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered" });
    const ev = await until(() => (events("kiro", "k1").length === 2 ? events("kiro", "k1") : null));
    expect(ev[1]?.data).toMatchObject({ ok: true, relayed: "unsupported", error: "no idle delivery for kiro yet" });
    expect(runs().map((r) => r.bin)).toEqual(["codex"]);
  });

  it("reply_to in a folder the machine doesn't allow: no handoff at all — the command runs, nothing is relayed, nothing is written on that session; a folder that stops being allowed mid-run is unsupported at relay time", {
    timeout: 20_000,
  }, async () => {
    const log: string[] = [];
    await startDaemon({ receivers: true, extra: { log: (l) => log.push(l) } });
    const elsewhere = path.join(tmp, "elsewhere");
    mkdirSync(elsewhere);
    const OTHER = SID.replace(/^8c/, "7b");
    transcript(OTHER, elsewhere);
    const q = await rx.send({
      kind: "start",
      session: `codex:${RECV}`,
      cwd: project,
      text: "go",
      reply_to: `claude-code:${OTHER}`,
    });
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered" });
    expect(log.find((l) => l.includes("isn't a session this machine can place"))).toMatch(
      /reply_to claude-code:7b\S+ isn't a session this machine can place \(that session's folder isn't one this machine allows\); the command runs, nothing is relayed/,
    );
    expect(runs().map((r) => r.bin)).toEqual(["codex"]);
    expect(existsSync(path.join(tmp, "state", "outbox"))).toBe(false);
    // Allowed when the command arrives, not any more when the reply is ready: the started
    // event went out, and ended says unsupported, as for a session no mode fits.
    d?.reload({ ...cfg({ receivers: true }), folders: [project, elsewhere] });
    const q2 = await rx.send({
      kind: "start",
      session: `codex:${SID.replace(/^8c/, "5e")}`,
      cwd: project,
      text: "go again",
      reply_to: `claude-code:${OTHER}`,
    });
    await until(() => events("claude-code", OTHER).length === 1);
    d?.reload(cfg({ receivers: true }));
    expect(await rx.waitAck(q2.id)).toMatchObject({ outcome: "delivered" });
    const ev = await until(() => (events("claude-code", OTHER).length === 2 ? events("claude-code", OTHER) : null));
    expect(ev[1]?.data).toMatchObject({ ok: true, relayed: "unsupported", error: expect.stringContaining("folder") });
  });

  it("a command that is refused relays nothing: ended with ok false and the code, no relayed", async () => {
    await startDaemon({ receivers: true });
    const q = await rx.send({ kind: "start", session: `codex:${RECV}`, cwd: tmp, text: "go", reply_to: ASKER });
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "refused", code: "folder" });
    const ev = await until(() => (events("claude-code", SID).length === 2 ? events("claude-code", SID) : null));
    expect(ev[1]?.data).toMatchObject({ ok: false, error: expect.stringContaining("folder") });
    expect(ev[1]?.data).not.toHaveProperty("relayed");
    expect(runs()).toEqual([]);
  });

  it("`ask off` reaches the receiver in the next hello, at once; an ask is then refused", {
    timeout: 20_000,
  }, async () => {
    await startDaemon({ receivers: true });
    await until(() => rx.hellos.length >= 1);
    d?.reload(cfg({ receivers: true, ask: false }));
    const hello = await until(() => rx.hellos.find((h) => h.ask === false));
    expect(hello).toMatchObject({ ask: false, handoff: true });
    expect(d?.status().ask).toEqual({ on: false, harnesses: ["claude-code", "codex"] });
    expect((await askIt(req())).end).toMatchObject({ op: "refused", code: "ask_off" });
  });
});

describe.runIf(unix)("sessionpipe ask (CONTROL.md §13): the other modes and edges", () => {
  it("mid-turn: the Stop hook's block is the ask alone, without the receiver's note; the answer follows", async () => {
    await startDaemon();
    await ask(sock, { op: "event", session: ASKER, event: "UserPromptSubmit", cwd: project }, 500);
    let begun!: () => void;
    const asked = new Promise<void>((r) => {
      begun = r;
    });
    const done = askMany(
      sock,
      req({ harness: "claude-code", session: ASKER, from: `codex:${THREAD}`, text: "also this" }),
      (r) => r.op === "asked" && begun(),
      15_000,
    );
    await asked;
    const stop = await ask(sock, { op: "stop", session: ASKER, active: false }, 500);
    expect(stop).toMatchObject({ op: "block", reason: frameAsk("also this", `codex:${THREAD}`) });
    answer(SID, project, "And that.");
    expect(await done).toMatchObject({ op: "answer", session: ASKER, text: "And that." });
  });

  it("through the Agent SDK: the held session gets the ask, with its lineage in the env", async () => {
    const starts: Record<string, unknown>[] = [];
    const host: SdkHost = {
      start: (o) => {
        starts.push(o);
        return {
          send: async (t: string) => ({ reply: `sdk: ${t.split("\n")[0]}` }),
          interrupt: async () => {},
          close: () => {},
          busy: false,
          lastUsed: Date.now(),
        };
      },
    };
    await startDaemon({ extra: { sdk: host } });
    const { end } = await askIt(req({ harness: "claude-code", text: "plan it" }));
    expect(end).toMatchObject({ op: "answer", text: "sdk: plan it" });
    expect(starts[0]).toMatchObject({
      cwd: project,
      permission: "safe",
      env: { SESSIONPIPE_ASKED_BY: ASKER, SESSIONPIPE_ASK_CHAIN: ASKER },
    });
  });

  it("on an inherit machine an ask runs at safe, the one level a message may name there; a model goes to the start", {
    timeout: 20_000,
  }, async () => {
    await startDaemon({ mode: "inherit" });
    const first = await askIt(req({ text: "build it", model: "o3" }));
    expect(first.end?.op).toBe("answer");
    expect(runs()[0]?.argv).toContain("o3");
    expect(runs()[0]?.argv.slice(5, 7)).toEqual(["-s", "workspace-write"]);
    expect(runs()[0]?.argv.join(" ")).not.toMatch(/approve/);
    const session = (first.end as { session: string }).session;
    expect((await askIt(req({ session, text: "read it", permission: "read" }))).end?.op).toBe("answer");
    expect(runs()[1]?.argv).toContain('sandbox_mode="read-only"');
  });

  it("an ask that names no level runs at safe, on an auto machine too; a session a receiver started at auto takes the ask at safe; wider than safe can't be named", {
    timeout: 20_000,
  }, async () => {
    await startDaemon({ mode: "auto", receivers: true });
    // A receiver's start with no level runs at the machine's mode, auto…
    const q = await rx.send({ kind: "start", session: `codex:${RECV}`, cwd: project, text: "go" });
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered" });
    expect(runs()[0]?.argv).toContain("--approve-for-me");
    // …an ask's new session at safe, the workspace sandbox: an ask is a model's doing, not the person's…
    const fresh = await askIt(req({ text: "review" }));
    expect(fresh.end?.op).toBe("answer");
    expect(runs()[1]?.argv.slice(5, 7)).toEqual(["-s", "workspace-write"]);
    // …and an ask into the receiver's auto session runs that turn at safe, narrower than its own level.
    const into = await askIt(req({ session: `codex:${RECV}`, text: "and this" }));
    expect(into.end?.op).toBe("answer");
    expect(runs()[2]?.argv).toContain('sandbox_mode="workspace-write"');
    expect(runs()[2]?.argv.join(" ")).not.toMatch(/approve|auto_review/);
    expect(runs()[2]?.argv.at(-1)).toBe(frameAsk("and this", ASKER));
    // Read narrows further; anything wider than safe is out of shape, whatever the machine's mode.
    expect((await askIt(req({ session: `codex:${RECV}`, text: "look", permission: "read" }))).end?.op).toBe("answer");
    expect(runs()[3]?.argv).toContain('sandbox_mode="read-only"');
    expect((await askIt({ ...req(), permission: "auto" as "read" })).end).toMatchObject({ code: "bad_fields" });
    expect(runs()).toHaveLength(4);
  });

  it("the daemon counts depth and loops for itself: a session waiting on an ask can't be asked from a clean environment, and the session it asked can't ask on", {
    timeout: 20_000,
  }, async () => {
    await startDaemon();
    // G asks A (the Claude Code session here, a waiter parked): in hand until A answers.
    const waited = waitForMessage(ASKER, { env });
    await new Promise((r) => setTimeout(r, 100));
    const first = askIt(req({ harness: "claude-code", session: ASKER, from: "gemini-cli:g1", text: "think" }));
    await waited;
    // A asks B, a new Codex session, with a chain that says nothing: counted all the same.
    const second = askIt(req({ text: "help", chain: [] }));
    await until(
      () => existsSync(path.join(tmp, "state", "control", "aliases.json")) && Object.keys(aliases()).length === 1,
    );
    const b = `codex:${THREAD}`;
    // B, under its own id and with no chain, can't ask on: the daemon knows B answers A, which answers G.
    expect((await askIt(req({ from: b, chain: [], text: "more" }))).end).toMatchObject({
      code: "depth",
      detail: `an ask goes 2 deep at most: ${b} is answering an ask nested in another one here, so it can't ask on`,
    });
    // Nobody can ask A while A waits on B — not a process with no name, not a stranger, and not
    // B (two deep already, so depth says so first): A's turn ends only when B's answer is back.
    const anon = req({ harness: "claude-code", session: ASKER, text: "ping" });
    delete anon.from;
    expect((await askIt(anon)).end).toMatchObject({
      code: "loop",
      detail: expect.stringContaining("is waiting on an ask of its own"),
    });
    expect(
      (await askIt(req({ harness: "claude-code", session: ASKER, from: "gemini-cli:g7", text: "ping" }))).end,
    ).toMatchObject({ code: "loop" });
    expect((await askIt(req({ harness: "claude-code", session: ASKER, from: b, text: "ping" }))).end).toMatchObject({
      code: "depth",
    });
    expect((await second).end?.op).toBe("answer");
    answer(SID, project, "Done.");
    expect((await first).end).toMatchObject({ op: "answer", text: "Done." });
    // Nothing in hand any more: the same asks go through.
    expect(d?.busy()).toBeNull();
    expect((await askIt(req({ from: b, chain: [], text: "more" }))).end?.op).toBe("answer");
  });

  it("a session takes three asks at a time, as asker and as asked: the fourth is refused start_limit before it begins", {
    timeout: 20_000,
  }, async () => {
    await startDaemon();
    const first = await askIt(req({ text: "open" }));
    const session = (first.end as { session: string }).session;
    const three = [1, 2, 3].map((n) => askIt(req({ session, text: `turn ${n}` })));
    await new Promise((r) => setTimeout(r, 100));
    // The session asked is full: a fourth, from anyone, is refused at once.
    const onTarget = await askIt(req({ session, text: "turn 4", from: "gemini-cli:g4" }));
    expect(onTarget.got).toEqual([onTarget.end]);
    expect(onTarget.end).toMatchObject({
      op: "refused",
      code: "start_limit",
      detail: `${session.slice(0, 24)} has 3 asks waiting on it already; a session takes 3 at a time`,
    });
    // The asker is full too: not even a new session for it, until one of its three is answered.
    expect((await askIt(req({ text: "a fourth" }))).end).toMatchObject({
      code: "start_limit",
      detail: `${ASKER} has 3 asks in hand already; a session asks 3 at a time`,
    });
    expect((await Promise.all(three)).map((r) => r.end?.op)).toEqual(["answer", "answer", "answer"]);
    expect((await askIt(req({ session, text: "turn 5" }))).end?.op).toBe("answer");
    expect(runs()).toHaveLength(5);
  });

  it("the daemon's own lineage never reaches a child: a receiver's start and an ask from nobody start clean", {
    timeout: 20_000,
  }, async () => {
    // A daemon started from a shell that was itself asked (`control run` inside a session).
    const stale = {
      SESSIONPIPE_ASKED_BY: "codex:stale",
      SESSIONPIPE_ASK_CHAIN: "codex:stale",
      SESSIONPIPE_LAUNCHED_BY: "codex:stale",
    };
    await startDaemon({ receivers: true, extra: { env: { ...env, ...stale } } });
    const q = await rx.send({ kind: "start", session: `codex:${RECV}`, cwd: project, text: "go" });
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered" });
    expect(runs()[0]).toMatchObject({ job: "1", asked_by: null, chain: null, launched_by: null });
    const anon = req();
    delete anon.from;
    expect((await askIt(anon)).end?.op).toBe("answer");
    expect(runs()[1]).toMatchObject({ job: "1", asked_by: null, chain: "unknown", launched_by: null });
    // And a child the daemon runs for an asker carries that asker, nothing older.
    const into = await askIt(req({ session: `codex:${RECV}`, from: ASKER }));
    expect(into.end, JSON.stringify(into.end)).toMatchObject({ op: "answer" });
    expect(runs()[2]).toMatchObject({ asked_by: ASKER, chain: ASKER, launched_by: null });
  });

  it("an ACP session takes no level or model; with no agent here there is nothing to ask", async () => {
    await startDaemon();
    await ask(sock, { op: "event", session: "gemini-cli:g1", event: "SessionStart", cwd: project }, 500);
    const { end } = await askIt(req({ harness: "gemini-cli", session: "gemini-cli:g1", permission: "read" }));
    expect(end).toMatchObject({
      op: "refused",
      code: "bad_fields",
      detail: expect.stringMatching(/takes no permission/),
    });
    await d?.stop();
    await startDaemon({ extra: { claude: () => null, codex: () => null } });
    expect((await askIt(req())).end).toMatchObject({
      code: "harness",
      detail: "this machine can't start a codex session; it can ask no agent",
    });
  });

  it("a run that throws: failed, in its words, and the asker's events say so", async () => {
    await startDaemon({
      extra: {
        run: async () => {
          throw new Error("boom");
        },
      },
    });
    const { got, end } = await askIt(req());
    expect(got.map((r) => r.op)).toEqual(["asked", "failed"]);
    expect(end).toEqual({ op: "failed", detail: "boom" });
    const ev = await until(() => (events("claude-code", SID).length === 2 ? events("claude-code", SID) : null));
    expect(ev[1]?.data).toMatchObject({ ok: false, error: "boom" });
  });

  it("a waiter that never answers: delivered all the same, with nothing to say", async () => {
    await startDaemon({ extra: { answerWaitMs: 300 } });
    const waited = waitForMessage(ASKER, { env });
    await new Promise((r) => setTimeout(r, 100));
    const { end } = await askIt(
      req({ harness: "claude-code", session: ASKER, from: `codex:${THREAD}`, text: "hello?" }),
    );
    await waited;
    expect(end).toMatchObject({ op: "answer", session: ASKER, text: "" });
    const ev = await until(() => (events("codex", THREAD).length === 2 ? events("codex", THREAD) : null));
    expect(ev[1]?.data).toMatchObject({ ok: true, reply: "" });
  });

  it("the asker's outbox locked: recorded once the lock is free, logged when it never is", {
    timeout: 20_000,
  }, async () => {
    const logs: string[] = [];
    await startDaemon({ extra: { log: (s) => logs.push(s) } });
    const state = path.join(tmp, "state");
    const ref = { harness: "claude-code", session: SID };
    let release = takeLock(state, ref)!;
    setTimeout(() => release(), 300);
    const pending = askIt(req());
    await until(() => events("claude-code", SID).length === 1);
    release = takeLock(state, ref)!;
    expect((await pending).end?.op).toBe("answer");
    const line = await until(() => logs.find((l) => l.startsWith("couldn't record delegation.ended")));
    expect(line).toContain("stayed locked");
    release();
    expect(events("claude-code", SID)).toHaveLength(1);
  });
});

describe.runIf(unix)("a handoff (CONTROL.md §6 reply_to): the other modes and edges", () => {
  it("reply_to with a waiter parked: in place, relayed the moment it is handed over", { timeout: 20_000 }, async () => {
    await startDaemon({ receivers: true });
    const waited = waitForMessage(ASKER, { env });
    await new Promise((r) => setTimeout(r, 100));
    const q = await rx.send({ kind: "start", session: `codex:${RECV}`, cwd: project, text: "go", reply_to: ASKER });
    const ack = await rx.waitAck(q.id);
    expect(await waited).toContain(frameHandoff({ harness: "codex", id: RECV }, rx.url, ack.reply as string));
    const ev = await until(() => (events("claude-code", SID).length === 2 ? events("claude-code", SID) : null));
    expect(ev[1]?.data).toMatchObject({ relayed: "delivered" });
    expect(runs().map((r) => r.bin)).toEqual(["codex"]);
  });

  it("reply_to a Codex session the hooks reported: its thread resumed, the answer on the way", {
    timeout: 20_000,
  }, async () => {
    const OWN = "0199c0de-1111-7222-8333-944455556666";
    const day = path.join(tmp, "codex-home", "sessions", "2026", "10", "03");
    mkdirSync(day, { recursive: true });
    const f = path.join(day, `rollout-2026-10-03T09-00-00-${OWN}.jsonl`);
    writeFileSync(f, `${JSON.stringify({ type: "session_meta", payload: { id: OWN, cwd: project } })}\n`);
    utimesSync(f, new Date(Date.now() - 600_000), new Date(Date.now() - 600_000));
    await startDaemon({ receivers: true });
    const q = await rx.send({
      kind: "start",
      session: `codex:${RECV}`,
      cwd: project,
      text: "two",
      reply_to: `codex:${OWN}`,
    });
    await rx.waitAck(q.id);
    const relay = await until(() => runs()[1]);
    expect(relay.argv.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(relay.argv).toContain(OWN);
    expect(relay.argv.at(-1)).toMatch(/^Answer from codex:[0-9a-f]{8} \(sessionpipe handoff/);
    const ev = await until(() => (events("codex", OWN).length === 2 ? events("codex", OWN) : null));
    expect(ev[1]?.data).toMatchObject({ relayed: "delivered", to: `codex:${RECV}` });
  });

  it("a session that answered nothing in writing: nothing to relay, and the events say failed", async () => {
    await startDaemon({ receivers: true, extra: { answerWaitMs: 300 } });
    const OTHER = SID.replace(/^8c/, "7b");
    transcript(OTHER, project);
    const waited = waitForMessage(ASKER, { env });
    await new Promise((r) => setTimeout(r, 100));
    const q = await rx.send({ session: ASKER, text: "say nothing", reply_to: `claude-code:${OTHER}` });
    await waited;
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered", mode: "waiter" });
    const ev = await until(() => (events("claude-code", OTHER).length === 2 ? events("claude-code", OTHER) : null));
    expect(ev[1]?.data).toMatchObject({
      ok: true,
      relayed: "failed",
      error: "the session finished its turn without a written reply",
      reply: "",
    });
    expect(runs()).toEqual([]);
  });

  it("reply_to no session on this machine: no handoff — the command runs and is acked as usual, nothing is relayed, no event and no outbox for a session a signer made up", {
    timeout: 20_000,
  }, async () => {
    const log: string[] = [];
    await startDaemon({ receivers: true, extra: { log: (l) => log.push(l) } });
    const NOBODY = SID.replace(/^8c/, "6a");
    const q = await rx.send({
      kind: "start",
      session: `codex:${RECV}`,
      cwd: project,
      text: "go",
      reply_to: `claude-code:${NOBODY}`,
    });
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered" });
    expect(log.find((l) => l.includes("isn't a session this machine can place"))).toMatch(/no Claude Code session/);
    expect(runs().map((r) => r.bin)).toEqual(["codex"]);
    expect(existsSync(path.join(tmp, "state", "outbox"))).toBe(false);
    expect(existsSync(path.join(tmp, "state", "facts"))).toBe(false);
    // Exactly one final ack, as ever: the relay's fate is never a second one.
    expect(rx.acks.filter((a) => a.id === q.id && a.outcome !== "taken" && a.outcome !== "progress")).toHaveLength(1);
  });

  it("a relay whose run throws: relayed failed, in its words", { timeout: 20_000 }, async () => {
    await startDaemon({
      receivers: true,
      extra: {
        run: (bin, args, o) => (bin === fakeClaude ? Promise.reject(new Error("boom")) : runHeadless(bin, args, o)),
      },
    });
    const q = await rx.send({ kind: "start", session: `codex:${RECV}`, cwd: project, text: "go", reply_to: ASKER });
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered" });
    const ev = await until(() => (events("claude-code", SID).length === 2 ? events("claude-code", SID) : null));
    expect(ev[1]?.data).toMatchObject({ ok: true, relayed: "failed", error: "boom" });
  });
});

describe("ask coverage: the level a child runs at, and depth from a terminal ask", () => {
  it("an existing Claude Code session on an inherit machine runs at the ask's cap, not the machine's default", async () => {
    // laterOptions on an inherit machine with no record is `inherit`; capped() replaces it
    // with the ask's own level (safe), not the machine's default.
    await startDaemon({ mode: "inherit" });
    const { end } = await askIt(
      req({ harness: "claude-code", session: ASKER, text: "look", permission: "safe", from: "gemini-cli:g1" }),
    );
    expect(end?.op).toBe("answer");
    const run = runs().find((r) => r.argv.includes("--resume"));
    // safe → the machine's dontAsk mode (the fake caps have default + dontAsk), never the inherit default.
    expect(run?.argv).toContain("dontAsk");
  });

  it("asking an existing ACP session with no level reaches it: no level is named, and it is not bad_fields", async () => {
    await startDaemon();
    await ask(sock, { op: "event", session: "gemini-cli:g1", event: "SessionStart", cwd: project }, 500);
    // No permission and no model: it passes the ACP level/model guard and the child's level is {}.
    const { end } = await askIt(req({ harness: "gemini-cli", session: "gemini-cli:g1", text: "look" }));
    expect(end?.op).not.toBe(undefined);
    if (end?.op === "refused") expect(end.code).not.toBe("bad_fields");
  });

  it("the daemon counts depth from a terminal ask it has in hand (no asker named)", async () => {
    await startDaemon();
    // A terminal ask (no `from`) parks on ASKER: in hand with from = null until ASKER answers.
    const waited = waitForMessage(ASKER, { env });
    await new Promise((r) => setTimeout(r, 100));
    const anon = req({ harness: "claude-code", session: ASKER, text: "think" });
    delete anon.from;
    const first = askIt(anon);
    await waited;
    // From ASKER, a new Codex session: askDepth(ASKER) walks the terminal ask, whose `from`
    // is null — the branch an ask with a named asker never reaches. Allowed (one deep).
    const second = askIt(req({ from: ASKER, text: "help", chain: [] }));
    expect((await second).end?.op).toBe("answer");
    answer(SID, project, "done");
    expect((await first).end).toMatchObject({ op: "answer", text: "done" });
  });
});

function parseUuid(session: string): boolean {
  return UUID.test(session.slice(session.indexOf(":") + 1));
}
