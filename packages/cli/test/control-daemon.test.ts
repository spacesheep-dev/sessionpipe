// SPDX-License-Identifier: Apache-2.0
// The control daemon end to end against an in-process receiver: pairing with a
// proof, every delivery mode, permission answers, refusals, acks — and the built
// hook answering a Stop and a PermissionRequest through the socket.
import { spawn } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Carried, ControlDaemon, type DaemonDeps, DaemonRunning, type SdkHost } from "../src/control/daemon.js";
import { ask } from "../src/control/local.js";
import { pair } from "../src/control/pair.js";
import { routePrompt } from "../src/control/route.js";
import { type ControlConfig, readControl } from "../src/control/store.js";
import { waitForMessage } from "../src/control/wait.js";
import { FakeReceiver } from "./helpers/receiver.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SID = "8c132906-8c3f-4814-870a-afc3d05e1d2e";
const SESSION = `claude-code:${SID}`;

let tmp: string;
let rx: FakeReceiver;
let d: ControlDaemon | null = null;
let env: NodeJS.ProcessEnv;
let sock: string;
let project: string;
let configDir: string;
let claudeLog: string;
let fakeClaude: string;

/** The session answers in its own turn: a tool step, then its words and end_turn. */
function answer(sid: string, cwd: string, text: string): void {
  const f = path.join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sid}.jsonl`);
  const rec = (stop: string, content: unknown[]) =>
    `${JSON.stringify({ type: "assistant", message: { stop_reason: stop, content } })}\n`;
  appendFileSync(f, rec("tool_use", [{ type: "tool_use", name: "Edit" }]) + rec("end_turn", [{ type: "text", text }]));
}

function transcript(sid: string, cwd: string): void {
  const dir = path.join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${sid}.jsonl`);
  writeFileSync(f, `${JSON.stringify({ type: "user", cwd, message: { content: "hi" } })}\n`);
  // Written ten minutes ago: a transcript written in the last 90 s counts as live.
  const past = new Date(Date.now() - 600_000);
  utimesSync(f, past, past);
}

function cfg(folders = [project]): ControlConfig {
  return {
    name: "testbox",
    folders,
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

async function startDaemon(
  o: {
    folders?: string[];
    sdk?: SdkHost;
    fork?: boolean;
    limits?: ControlConfig["limits"];
    login?: DaemonDeps["login"];
    /** The token as control.json gave it ("" = in a keychain that was locked). */
    token?: string;
    reread?: DaemonDeps["token"];
    /** Anything else the daemon is handed (the updater's hooks). */
    extra?: Partial<DaemonDeps>;
  } = {},
) {
  const c = cfg(o.folders);
  if (o.token !== undefined)
    c.receivers = c.receivers.map((r) => ({ ...r, token: o.token as string, token_in: "keychain" as const }));
  d = new ControlDaemon({ ...c, ...(o.limits ? { limits: o.limits } : {}) }, path.join(tmp, "state", "control"), sock, {
    now: Date.now,
    fetch,
    log: process.env.SP_DEBUG ? (s: string) => console.error(`[daemon] ${s}`) : () => {},
    claudeDirs: () => [configDir],
    claude: () => ({
      bin: fakeClaude,
      caps: { hasMode: true, modes: ["default", "dontAsk"], promptsNone: false, fork: o.fork ?? true },
    }),
    run: (bin, args, opts) =>
      new Promise((resolve) => {
        const c = spawn(bin, args, { cwd: opts.cwd, env: opts.env });
        let out = "";
        c.stdout.on("data", (b) => {
          out += b;
        });
        c.on("close", (code) =>
          resolve({ code, signal: null, stdout: out, tooBig: false, stderr: "", timedOut: false }),
        );
      }),
    sdk: o.sdk ?? null,
    env,
    ...(o.login ? { login: o.login } : {}),
    ...(o.reread ? { token: o.reread } : {}),
    ...o.extra,
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
  tmp = mkdtempSync(path.join(os.tmpdir(), "sp-control-"));
  project = path.join(tmp, "project");
  configDir = path.join(tmp, "claude-config");
  mkdirSync(project, { recursive: true });
  mkdirSync(path.join(configDir, "sessions"), { recursive: true });
  sock = path.join(tmp, "control.sock");
  claudeLog = path.join(tmp, "claude-calls.jsonl");
  fakeClaude = path.join(tmp, "claude");
  // A stand-in `claude -p`: records its argv and answers like --output-format json.
  writeFileSync(
    fakeClaude,
    `#!/usr/bin/env node
const a = process.argv.slice(2);
require("fs").appendFileSync(${JSON.stringify(claudeLog)}, JSON.stringify(a) + "\\n");
const i = a.indexOf("--resume"), j = a.indexOf("--session-id");
let sid = i >= 0 ? a[i + 1] : j >= 0 ? a[j + 1] : "x";
if (a.includes("--fork-session")) sid = "0b6f2c7e-3d4a-4f1b-9c8e-2a1d5e6f7a8b";
process.stdout.write(JSON.stringify({ type: "result", result: "did it: " + a[a.length - 1].split("\\n").pop(), session_id: sid, is_error: false }));
`,
  );
  chmodSync(fakeClaude, 0o755);
  env = {
    ...process.env,
    SESSIONPIPE_STATE: path.join(tmp, "state"),
    SESSIONPIPE_CONFIG: path.join(tmp, "config", "config.json"),
    SESSIONPIPE_SOCKET: sock,
  };
  transcript(SID, project);
  rx.queue.clear();
  rx.acks.length = 0;
});

afterEach(async () => {
  await d?.stop();
  d = null;
  rmSync(tmp, { recursive: true, force: true });
});

describe("routing (CONTROL.md §6)", () => {
  const base = {
    harness: "claude-code",
    sdk: false,
    waiter: false,
    midTurn: false,
    live: false,
    known: true,
    canFork: true,
    api: false,
  };
  it("takes the first mode that fits", () => {
    expect(routePrompt({ ...base, sdk: true, waiter: true })).toEqual({ mode: "sdk" });
    expect(routePrompt({ ...base, waiter: true, midTurn: true })).toEqual({ mode: "waiter" });
    expect(routePrompt({ ...base, midTurn: true, live: true })).toEqual({ mode: "turn" });
    expect(routePrompt({ ...base })).toEqual({ mode: "resume" });
    expect(routePrompt({ ...base, live: true })).toEqual({ mode: "fork" });
    expect(routePrompt({ ...base, live: true, canFork: false })).toHaveProperty("unsupported");
    expect(routePrompt({ ...base, known: false })).toEqual({ refused: "no_session" });
    expect(routePrompt({ ...base, harness: "gemini-cli" })).toHaveProperty("unsupported");
    expect(routePrompt({ ...base, harness: "codex", midTurn: true })).toEqual({ mode: "turn" });
    // Codex and Antigravity: resumed headlessly when idle, never copied when open.
    for (const harness of ["codex", "antigravity"]) {
      expect(routePrompt({ ...base, harness, canFork: false })).toEqual({ mode: "resume" });
      expect(routePrompt({ ...base, harness, canFork: false, live: true })).toHaveProperty("unsupported");
    }
  });
});

describe("pairing (CONTROL.md §2)", () => {
  it("trusts the key only after its proof verifies here", async () => {
    rx.paired = true;
    rx.handKey = "same";
    const out: string[] = [];
    const c = await pair({
      url: rx.url,
      token: rx.sinkToken,
      folders: [project],
      mode: "safe",
      name: "testbox",
      out: (s) => out.push(s),
      sleep: async () => {},
      env,
    });
    expect(c.receivers[0]?.keys.map((k) => k.id)).toEqual([rx.passkey.key.id]);
    expect(c.receivers[0]?.token).toBe(rx.token);
    expect(readControl(env)?.receivers[0]?.machine).toBe(rx.machine);
    expect(out.join("\n")).toContain("123456");
    // The machine says it takes attachments, so the receiver may send it files.
    expect(rx.pairs.at(-1)).toMatchObject({ files: true });
  });
  it("names the Claude Code accounts signed in here, so the board can label each account_id", async () => {
    rx.paired = true;
    rx.handKey = "same";
    rx.pairs.length = 0;
    const home = path.join(tmp, "home");
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({ oauthAccount: { accountUuid: "acct-home", emailAddress: "me@example.com" } }),
    );
    const out: string[] = [];
    await pair({
      url: rx.url,
      token: rx.sinkToken,
      folders: [project],
      mode: "safe",
      name: "testbox",
      out: (s) => out.push(s),
      sleep: async () => {},
      env: { ...env, HOME: home, CLAUDE_CONFIG_DIR: "" },
    });
    expect(rx.pairs[0]?.accounts).toEqual([{ harness: "claude-code", id: "acct-home", email: "me@example.com" }]);
    expect(out.join("\n")).toContain("names your Claude Code account: me@example.com");
  });
  it("a code nobody approved in time is renewed in place: fresh digits, the same machine, no second row", async () => {
    rx.paired = true;
    rx.handKey = "same";
    rx.expireFirst = true;
    rx.codesIssued = 0;
    rx.pairs.length = 0;
    const out: string[] = [];
    try {
      const c = await pair({
        url: rx.url,
        token: rx.sinkToken,
        folders: [project],
        mode: "safe",
        name: "testbox",
        out: (s) => out.push(s),
        sleep: async () => {},
        env,
      });
      expect(rx.pairs).toHaveLength(2);
      expect(rx.pairs[1]?.machine).toBe(rx.machine);
      expect(out.join("\n")).toContain("Here is a fresh one");
      expect(out.join("\n")).toContain("good for 10 minutes");
      expect(c.receivers[0]?.keys.map((k) => k.id)).toEqual([rx.passkey.key.id]);
    } finally {
      rx.expireFirst = false;
    }
  });
  it("renewal has an end: past it, an expired code is the error it always was", async () => {
    rx.expireFirst = true;
    rx.codesIssued = 0;
    try {
      await expect(
        pair({
          url: rx.url,
          token: rx.sinkToken,
          folders: [project],
          mode: "safe",
          name: "testbox",
          out: () => {},
          sleep: async () => {},
          env,
          renewFor: 0,
        }),
      ).rejects.toThrow("the pairing link expired");
    } finally {
      rx.expireFirst = false;
    }
  });
  it("open pairing: no token, the poll key gets the token, the sink key is handed over, the approver is named", async () => {
    rx.paired = true;
    rx.handKey = "same";
    rx.openPairing = true;
    rx.pollKey = null;
    const out: string[] = [];
    let sink: string | null = null;
    try {
      const c = await pair({
        url: rx.url,
        token: null,
        folders: [project],
        mode: "safe",
        name: "testbox",
        out: (s) => out.push(s),
        sleep: async () => {},
        env,
        addSink: (t) => {
          sink = t;
        },
      });
      expect(rx.pollKey).toMatch(/^[A-Za-z0-9_-]{40,}$/);
      expect(c.receivers[0]?.token).toBe(rx.token);
      expect(sink).toBe("sink_from_pairing_0123456789");
      expect(out.join("\n")).toContain("Approved by @fake on localhost");
      // The link is not a credential: a status poll without the poll key is refused.
      const r = await fetch(`${rx.url}/api/sessionpipe/v1/control/pair?code=${rx.pairCode}`);
      expect(r.status).toBe(401);
    } finally {
      rx.openPairing = false;
      rx.pollKey = null;
    }
  });
  it("without open pairing, no token is an error in words", async () => {
    await expect(
      pair({
        url: rx.url,
        token: null,
        folders: [project],
        mode: "safe",
        name: "x",
        out: () => {},
        sleep: async () => {},
        env,
      }),
    ).rejects.toThrow(/needs a key to pair/);
  });
  it("refuses a key swapped in by the receiver", async () => {
    rx.paired = true;
    rx.handKey = "other";
    await expect(
      pair({
        url: rx.url,
        token: rx.sinkToken,
        folders: [project],
        mode: "safe",
        name: "x",
        out: () => {},
        sleep: async () => {},
        env,
      }),
    ).rejects.toThrow(/didn't prove itself/);
    expect(readControl(env)).toBeNull();
    rx.handKey = "same";
  });
});

// The daemon itself is Unix-only for now (a Windows daemon is M7): Unix sockets and a
// shebang stand-in for claude.
const unix = process.platform !== "win32";

describe.runIf(unix)("delivery", () => {
  it("waiter: in place, in milliseconds, framed", async () => {
    await startDaemon();
    const got = waitForMessage(SESSION, { env });
    await new Promise((r) => setTimeout(r, 100));
    const q = await rx.send({ session: SESSION, text: "Add the Oct 8 row" });
    const text = await got;
    expect(text).toContain("Add the Oct 8 row");
    expect(text).toContain("sessionpipe control");
    expect(text).toContain("start `sessionpipe wait` again");
    expect(text).toContain("sent back to them automatically");
    // Taken at once; the session's own answer, read from its transcript, is the reply.
    for (let i = 0; i < 100 && !rx.acks.some((a) => a.id === q.id); i++) await new Promise((r) => setTimeout(r, 20));
    const taken = rx.acks.find((a) => a.id === q.id);
    expect(taken).toMatchObject({ outcome: "taken" });
    expect(Date.parse(taken?.at as string) - Date.parse(q.at)).toBeLessThan(2000);
    answer(SID, project, "Added the Oct 8 row.");
    expect(await rx.waitAck(q.id)).toMatchObject({
      outcome: "delivered",
      mode: "waiter",
      reply: "Added the Oct 8 row.",
    });
  });

  it("turn: a message for a session mid-turn is the Stop hook's block, once", async () => {
    await startDaemon();
    await ask(sock, { op: "event", session: SESSION, event: "UserPromptSubmit" }, 500);
    const q = await rx.send({ session: SESSION, text: "also write pong" });
    // Taken on the next long-poll; wait for the ack rather than a fixed sleep (a loaded CI
    // runner took longer than 300 ms once, 2026-10-05, ubuntu/node 20).
    for (let i = 0; i < 100 && !rx.acks.some((a) => a.id === q.id); i++) await new Promise((r) => setTimeout(r, 20));
    expect(rx.finalAck(q.id)).toBeUndefined();
    expect(rx.acks.find((a) => a.id === q.id)?.outcome).toBe("taken");
    // Taken, so the receiver stops handing it back: the long-poll doesn't spin.
    const polls = rx.polls.length;
    await new Promise((r) => setTimeout(r, 500));
    expect(rx.polls.length - polls).toBeLessThanOrEqual(2);
    const r = await ask(sock, { op: "stop", session: SESSION, active: false }, 500);
    expect(r).toMatchObject({ op: "block" });
    expect((r as { reason: string }).reason).toContain("also write pong");
    expect((r as { reason: string }).reason).toContain("sent back to them automatically");
    answer(SID, project, "pong");
    await ask(sock, { op: "event", session: SESSION, event: "Stop" }, 500);
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered", mode: "turn", reply: "pong" });
    expect(await ask(sock, { op: "stop", session: SESSION, active: true }, 500)).toEqual({ op: "none" });
  });

  it("turn: a Stop that didn't take it (it came after the hook asked) reroutes to a resume", async () => {
    await startDaemon();
    await ask(sock, { op: "event", session: SESSION, event: "UserPromptSubmit" }, 500);
    const q = await rx.send({ session: SESSION, text: "late" });
    await new Promise((r) => setTimeout(r, 300));
    await ask(sock, { op: "event", session: SESSION, event: "Stop" }, 500);
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered", mode: "resume" });
  });

  it("resume: no live process — a headless turn, acked taken then delivered with the reply", async () => {
    await startDaemon();
    const q = await rx.send({ session: SESSION, text: "summarize" });
    const ack = await rx.waitAck(q.id);
    expect(ack).toMatchObject({ outcome: "delivered", mode: "resume" });
    expect(ack.reply).toContain("did it: summarize");
    expect(rx.acks.find((a) => a.id === q.id)?.outcome).toBe("taken");
    const call = JSON.parse(readFileSync(claudeLog, "utf8").trim()) as string[];
    expect(call).toEqual(expect.arrayContaining(["-p", "--resume", SID, "--permission-mode", "dontAsk"]));
    expect(call).not.toContain("--fork-session");
  });

  it("signed out as the daemon sees it: the resume fails with what to do, and Claude Code never runs", async () => {
    const asked: (string | undefined)[] = [];
    await startDaemon({
      login: async (dir) => {
        asked.push(dir);
        return { loggedIn: false };
      },
    });
    const q = await rx.send({ session: SESSION, text: "summarize" });
    const ack = await rx.waitAck(q.id);
    expect(ack).toMatchObject({ outcome: "failed" });
    expect(String(ack.detail)).toMatch(/claude auth login/);
    expect(existsSync(claudeLog)).toBe(false);
    // The account asked about is the session's own.
    expect(asked).toEqual([configDir]);
  });

  it("signed out: a new session fails the same way; a Claude Code that can't say never blocks", async () => {
    await startDaemon({ login: async () => ({ loggedIn: false }) });
    const NEW = "0b6f2c7e-3d4a-4f1b-9c8e-2a1d5e6f7a91";
    const q = await rx.send({ kind: "start", session: `claude-code:${NEW}`, cwd: project, text: "hello" });
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "failed" });
    expect(existsSync(claudeLog)).toBe(false);
    await d?.stop();
    d = null;
    await startDaemon({ login: async () => ({ loggedIn: null }) });
    const q2 = await rx.send({ session: SESSION, text: "summarize" });
    expect(await rx.waitAck(q2.id)).toMatchObject({ outcome: "delivered", mode: "resume" });
  });

  it("a token that was locked in the keychain at start is read again before the first poll", async () => {
    let reads = 0;
    await startDaemon({
      token: "",
      reread: () => {
        reads++;
        return rx.token;
      },
    });
    const q = await rx.send({ session: SESSION, text: "summarize" });
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered", mode: "resume" });
    expect(reads).toBe(1);
  });

  it("fork: a live session is copied, never resumed twice, and later messages go to the copy", async () => {
    writeFileSync(
      path.join(configDir, "sessions", `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, sessionId: SID }),
    );
    await startDaemon();
    const q = await rx.send({ session: SESSION, text: "one" });
    const ack = await rx.waitAck(q.id);
    expect(ack).toMatchObject({
      outcome: "delivered",
      mode: "fork",
      session: "claude-code:0b6f2c7e-3d4a-4f1b-9c8e-2a1d5e6f7a8b",
    });
    transcript("0b6f2c7e-3d4a-4f1b-9c8e-2a1d5e6f7a8b", project);
    const q2 = await rx.send({ session: SESSION, text: "two" });
    await rx.waitAck(q2.id);
    const calls = readFileSync(claudeLog, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as string[]);
    expect(calls[1]).toEqual(expect.arrayContaining(["--resume", "0b6f2c7e-3d4a-4f1b-9c8e-2a1d5e6f7a8b"]));
  });

  it("sdk: start goes through the Agent SDK host, and the next prompt lands in the held session", async () => {
    const sent: string[] = [];
    const host: SdkHost = {
      start: () => ({
        send: async (t: string) => {
          sent.push(t);
          return { reply: `sdk: ${t.split("\n").pop()}` };
        },
        interrupt: async () => {
          sent.push("<interrupt>");
        },
        close: () => {},
        busy: false,
        lastUsed: Date.now(),
      }),
    };
    await startDaemon({ sdk: host });
    const NEW = "0b6f2c7e-3d4a-4f1b-9c8e-2a1d5e6f7a8c";
    const q = await rx.send({ kind: "start", session: `claude-code:${NEW}`, cwd: project, text: "fix the test" });
    expect(await rx.waitAck(q.id)).toMatchObject({
      outcome: "delivered",
      mode: "sdk",
      reply: expect.stringMatching(/^sdk: \(Sent via localhost:\d+ with sessionpipe control/),
    });
    transcript(NEW, project);
    const q2 = await rx.send({ session: `claude-code:${NEW}`, text: "and push it" });
    expect(await rx.waitAck(q2.id)).toMatchObject({ outcome: "delivered", mode: "sdk" });
    const q3 = await rx.send({ kind: "cancel", session: `claude-code:${NEW}`, text: undefined });
    expect(await rx.waitAck(q3.id)).toMatchObject({ outcome: "delivered", mode: "sdk" });
    expect(sent.at(-1)).toBe("<interrupt>");
  });

  it("start caps: at most N at once and M an hour, whatever the receiver sends", { timeout: 30_000 }, async () => {
    const release: (() => void)[] = [];
    let running = 0;
    let most = 0;
    const host: SdkHost = {
      start: () => ({
        send: async (t: string) => {
          running++;
          most = Math.max(most, running);
          await new Promise<void>((r) => release.push(r));
          running--;
          return { reply: `ok: ${t.split("\n").pop()}` };
        },
        interrupt: async () => {},
        close: () => {},
        busy: false,
        lastUsed: Date.now(),
      }),
    };
    await startDaemon({ sdk: host, limits: { start_concurrent: 2, start_per_hour: 3, headless: 5 } });
    const id = (n: number) => `0b6f2c7e-3d4a-4f1b-9c8e-2a1d5e6f7b0${n}`;
    const start = (n: number) =>
      rx.send({ kind: "start", session: `claude-code:${id(n)}`, cwd: project, text: `job ${n}` });
    const three = [await start(1), await start(2), await start(3)];
    // Two run and one is refused at once, not queued behind them. Which one is the
    // order they finish verifying in, when they arrive in the same poll.
    while (release.length < 2) await new Promise((r) => setTimeout(r, 10));
    const refusedNow = () => three.filter((q) => rx.finalAck(q.id)?.code === "start_limit");
    for (let i = 0; i < 300 && !refusedNow().length; i++) await new Promise((r) => setTimeout(r, 20));
    const refused = refusedNow();
    expect(refused).toHaveLength(1);
    for (const r of release.splice(0)) r();
    for (const q of three.filter((q) => !refused.includes(q)))
      expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered", mode: "sdk" });
    // The hour's budget is 3 accepted starts: one more goes, the next is refused.
    const e = await start(4);
    while (release.length < 1) await new Promise((r) => setTimeout(r, 10));
    release.splice(0)[0]?.();
    expect(await rx.waitAck(e.id)).toMatchObject({ outcome: "delivered" });
    const f = await start(5);
    expect(await rx.waitAck(f.id)).toMatchObject({ outcome: "refused", code: "start_limit" });
    expect(most).toBe(2);
  });

  it("headless runs wait their turn: never more Claude Code processes than the cap", { timeout: 30_000 }, async () => {
    await startDaemon({ limits: { headless: 1 } });
    // A slow stand-in claude that records how many run at once.
    const marks = path.join(tmp, "concurrency.log");
    writeFileSync(
      fakeClaude,
      `#!/usr/bin/env node
const fs = require("fs"); const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(marks)}, "+\\n");
setTimeout(() => { fs.appendFileSync(${JSON.stringify(marks)}, "-\\n");
  const j = a.indexOf("--session-id");
  process.stdout.write(JSON.stringify({ type: "result", result: "done", session_id: a[j + 1], is_error: false })); }, 150);
`,
    );
    chmodSync(fakeClaude, 0o755);
    const qs = [];
    for (const n of [1, 2, 3])
      qs.push(
        await rx.send({
          kind: "start",
          session: `claude-code:0b6f2c7e-3d4a-4f1b-9c8e-2a1d5e6f7c0${n}`,
          cwd: project,
          text: "hi",
        }),
      );
    for (const q of qs)
      expect(await rx.waitAck(q.id)).toMatchObject({ outcome: expect.stringMatching(/delivered|refused/) });
    const seq = readFileSync(marks, "utf8").trim().split("\n");
    let now = 0;
    let most = 0;
    for (const m of seq) {
      now += m === "+" ? 1 : -1;
      most = Math.max(most, now);
    }
    expect(most).toBe(1);
  });

  it("key.add: a trusted device vouches for a new one, which can then sign on its own", async () => {
    await startDaemon();
    // Before: the other passkey is a stranger here.
    const before = await rx.send({ session: SESSION, text: "from the phone" }, { as: rx.other, confirm: true });
    expect(await rx.waitAck(before.id)).toMatchObject({ outcome: "refused", code: "untrusted_key" });
    const add = await rx.send(
      { kind: "key.add", session: "sessionpipe:keys", text: undefined, key: rx.other.key, name: "iPhone" },
      { confirm: true },
    );
    expect(await rx.waitAck(add.id)).toMatchObject({ outcome: "delivered", detail: "trusted iPhone" });
    expect(readControl(env)?.receivers[0]?.keys.map((k) => k.id)).toContain(rx.other.key.id);
    // After: the phone's own signature is enough.
    const got = waitForMessage(SESSION, { env });
    await new Promise((r) => setTimeout(r, 100));
    const after = await rx.send({ session: SESSION, text: "now it works" }, { as: rx.other, confirm: true });
    expect(await got).toContain("now it works");
    for (let i = 0; i < 100 && !rx.acks.some((a) => a.id === after.id); i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(rx.acks.find((a) => a.id === after.id)?.outcome).toBe("taken");
  });

  it("a message while the daemon's own start still runs waits and resumes it, never forks", {
    timeout: 30_000,
  }, async () => {
    await startDaemon();
    const marks = path.join(tmp, "runs.log");
    // A slow stand-in claude: writes the transcript at once (as a real run does), then works.
    writeFileSync(
      fakeClaude,
      `#!/usr/bin/env node
const fs = require("fs"), path = require("path"); const a = process.argv.slice(2);
const i = a.indexOf("--resume"), j = a.indexOf("--session-id");
const sid = i >= 0 ? a[i + 1] : a[j + 1];
fs.appendFileSync(${JSON.stringify(marks)}, JSON.stringify({ start: Date.now(), args: a.slice(0, -1) }) + "\\n");
const dir = path.join(${JSON.stringify(configDir)}, "projects", ${JSON.stringify(project)}.replace(/[^a-zA-Z0-9]/g, "-"));
fs.mkdirSync(dir, { recursive: true });
fs.appendFileSync(path.join(dir, sid + ".jsonl"), JSON.stringify({ type: "user", cwd: ${JSON.stringify(project)} }) + "\\n");
setTimeout(() => { fs.appendFileSync(${JSON.stringify(marks)}, JSON.stringify({ end: Date.now() }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", result: "done " + a.includes("--resume"), session_id: sid, is_error: false })); }, 1500);
`,
    );
    chmodSync(fakeClaude, 0o755);
    const NEW = "0b6f2c7e-3d4a-4f1b-9c8e-2a1d5e6f7d01";
    const q1 = await rx.send({ kind: "start", session: `claude-code:${NEW}`, cwd: project, text: "build it" });
    await new Promise((r) => setTimeout(r, 400));
    const q2 = await rx.send({ session: `claude-code:${NEW}`, text: "just merge when ready" });
    expect(await rx.waitAck(q1.id, 20_000)).toMatchObject({ outcome: "delivered" });
    expect(await rx.waitAck(q2.id, 20_000)).toMatchObject({ outcome: "delivered", mode: "resume" });
    const runs = readFileSync(marks, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const starts = runs.filter((x) => x.start);
    expect(starts).toHaveLength(2);
    expect(starts[1].args).toContain("--resume");
    expect(starts[1].args).not.toContain("--fork-session");
    // One after the other: the resume began after the start ended.
    expect(starts[1].start).toBeGreaterThanOrEqual(runs.find((x) => x.end).end);
  });

  it("start without the SDK is a headless claude -p --session-id", async () => {
    await startDaemon();
    const NEW = "0b6f2c7e-3d4a-4f1b-9c8e-2a1d5e6f7a8d";
    const q = await rx.send({ kind: "start", session: `claude-code:${NEW}`, cwd: project, text: "hello" });
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered", mode: "resume" });
    expect(readFileSync(claudeLog, "utf8")).toContain("--session-id");
    // The person's words come first: Claude Code names the session from them.
    const first = JSON.parse(readFileSync(claudeLog, "utf8").trim().split("\n")[0]!) as string[];
    expect(first.at(-1)).toMatch(/^hello\n\n\(Sent via localhost:\d+ with sessionpipe control/);
    // The next message resumes it: the transcript the start just wrote is the daemon's own.
    const dir = path.join(configDir, "projects", project.replace(/[^a-zA-Z0-9]/g, "-"));
    writeFileSync(path.join(dir, `${NEW}.jsonl`), `${JSON.stringify({ type: "user", cwd: project })}\n`);
    const q2 = await rx.send({ session: `claude-code:${NEW}`, text: "again" });
    expect(await rx.waitAck(q2.id)).toMatchObject({ outcome: "delivered", mode: "resume" });
  });

  it("a key added while it runs (control pair again) is trusted on the next poll", async () => {
    await startDaemon();
    const first = rx.passkey;
    rx.passkey = await (await import("../../core/test/helpers/authenticator.js")).Passkey.create({
      rpId: "localhost",
      origin: rx.url,
    });
    try {
      const c = cfg();
      c.receivers[0]!.keys.push({ ...rx.passkey.key, added_at: new Date().toISOString() });
      d!.reload(c);
      const q = await rx.send({ session: SESSION, text: "with the new key" });
      expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered" });
    } finally {
      rx.passkey = first;
    }
  });

  it("cancel with no held session is unsupported", async () => {
    await startDaemon();
    const q = await rx.send({ kind: "cancel", session: SESSION, text: undefined });
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "unsupported" });
  });
});

describe.runIf(unix)("the local socket (CONTROL.md §8)", () => {
  it("is this user's alone: mode 0600, whatever the umask", async () => {
    await startDaemon();
    expect(statSync(sock).mode & 0o777).toBe(0o600);
  });
});

describe.runIf(unix)("permission answers (CONTROL.md §6, §7)", () => {
  const ATT = "perm-5f1c0e9a2b7d4c31";
  it("an open prompt takes the signed answer", async () => {
    await startDaemon();
    const hook = ask(sock, { op: "permission", session: SESSION, attention: ATT, tool: "Bash" }, 10_000);
    await new Promise((r) => setTimeout(r, 100));
    const q = await rx.send({
      kind: "permission.answer",
      session: SESSION,
      text: undefined,
      for: ATT,
      decision: "deny",
      note: "Not on main.",
    });
    expect(await hook).toMatchObject({ op: "decision", behavior: "deny", message: "Not on main." });
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered" });
  });
  it("nothing is auto-allowed: an allow with no open prompt is refused, a deny expires", async () => {
    await startDaemon();
    const a = await rx.send({
      kind: "permission.answer",
      session: SESSION,
      text: undefined,
      for: ATT,
      decision: "allow",
    });
    expect(await rx.waitAck(a.id)).toMatchObject({ outcome: "refused", code: "no_attention" });
    const b = await rx.send({
      kind: "permission.answer",
      session: SESSION,
      text: undefined,
      for: ATT,
      decision: "deny",
    });
    expect(await rx.waitAck(b.id)).toMatchObject({ outcome: "expired" });
  });
  it("the terminal answered first: the next event releases the hook and a later answer expires", async () => {
    await startDaemon();
    const hook = ask(sock, { op: "permission", session: SESSION, attention: ATT }, 10_000);
    await new Promise((r) => setTimeout(r, 100));
    await ask(sock, { op: "event", session: SESSION, event: "PostToolUse" }, 500);
    expect(await hook).toEqual({ op: "none" });
    const q = await rx.send({
      kind: "permission.answer",
      session: SESSION,
      text: undefined,
      for: ATT,
      decision: "deny",
    });
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "expired" });
  });
});

describe.runIf(unix)("attachments on a start (CONTROL.md §6)", () => {
  const NEW = "0b6f2c7e-3d4a-4f1b-9c8e-2a1d5e6f7a8e";
  const bytes = (n: number, seed: number, head = "") => {
    const b = new Uint8Array(n);
    for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 0xff;
    b.set(new TextEncoder().encode(head));
    return b;
  };
  const filesDir = () => path.join(project, ".sessionpipe", "files", NEW);
  const start = (files: unknown[], text = "What's wrong here?") =>
    rx.send({ kind: "start", session: `claude-code:${NEW}`, cwd: project, text, files });
  const claudeRan = () => existsSync(claudeLog);
  /** The ack a file problem ends in: failed, code file, the reason; nothing kept, nothing run. */
  const failed = async (id: string, why: RegExp) => {
    const a = await rx.waitAck(id);
    expect(a).toMatchObject({ outcome: "failed", code: "file" });
    expect(String(a.detail)).toMatch(why);
    expect(existsSync(filesDir())).toBe(false);
    expect(claudeRan()).toBe(false);
    return a;
  };

  beforeEach(() => {
    rx.files.clear();
    rx.fileGets.length = 0;
    rx.fileMode = "plain";
  });

  it("downloads, checks and saves each file, then starts the session with their paths", async () => {
    await startDaemon();
    const png = await rx.upload("screenshot.png", "image/png", bytes(183_402, 1, "\x89PNG\r\n\x1a\n"));
    const pdf = await rx.upload("notes.pdf", "application/pdf", bytes(1_258_291, 2, "%PDF-1.7\n"));
    const q = await start([png, pdf]);
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered", mode: "resume" });
    // taken before the download, so the receiver doesn't redeliver meanwhile.
    expect(rx.acks.filter((a) => a.id === q.id).map((a) => a.outcome)).toEqual(["taken", "delivered"]);
    expect(rx.fileGets).toEqual([png.sha256, pdf.sha256]);
    for (const [f, b] of [
      [png, rx.files.get(png.sha256)!.bytes],
      [pdf, rx.files.get(pdf.sha256)!.bytes],
    ] as const) {
      const p = path.join(filesDir(), f.name);
      expect(Buffer.compare(readFileSync(p), Buffer.from(b))).toBe(0);
      expect(statSync(p).mode & 0o777).toBe(0o600);
    }
    expect(readFileSync(path.join(project, ".sessionpipe", ".gitignore"), "utf8")).toBe("*\n");
    // The stand-in claude got the text, then the files, relative to the session's folder,
    // then the start's own trailer.
    const args = JSON.parse(readFileSync(claudeLog, "utf8").trim().split("\n").pop()!) as string[];
    expect(args).toEqual(expect.arrayContaining(["--session-id", NEW]));
    const prompt = args.at(-1) ?? "";
    expect(
      prompt.startsWith(
        [
          "What's wrong here?",
          "",
          "Attached files (saved in this folder):",
          `- .sessionpipe/files/${NEW}/screenshot.png (image/png, 179 KB)`,
          `- .sessionpipe/files/${NEW}/notes.pdf (application/pdf, 1.2 MB)`,
          "",
          "(Sent via localhost:",
        ].join("\n"),
      ),
    ).toBe(true);
    // Hello says this daemon takes files.
    for (let i = 0; i < 100 && !rx.hellos.some((h) => h.files === true); i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(rx.hellos.some((h) => h.files === true)).toBe(true);
  });

  it("a second session in the same folder: the .gitignore is already there and stays as it is", async () => {
    await startDaemon();
    mkdirSync(path.join(project, ".sessionpipe"));
    writeFileSync(path.join(project, ".sessionpipe", ".gitignore"), "# mine\n*\n");
    const txt = await rx.upload("a.txt", "text/plain", bytes(10, 11));
    const q = await start([txt]);
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered" });
    expect(readFileSync(path.join(project, ".sessionpipe", ".gitignore"), "utf8")).toBe("# mine\n*\n");
    expect(readdirSync(filesDir())).toEqual(["a.txt"]);
  });

  it("a file whose bytes don't match the signed hash: failed, nothing kept, nothing started", async () => {
    await startDaemon();
    const png = await rx.upload("screenshot.png", "image/png", bytes(4096, 3));
    // The receiver swaps the bytes (same length): the signed hash catches it.
    rx.files.set(png.sha256, { bytes: bytes(4096, 4), type: "image/png" });
    const q = await start([png]);
    await failed(q.id, /screenshot\.png.*hash/);
  });

  it("a file shorter than its signed size: failed before the hash is even looked at", async () => {
    await startDaemon();
    const png = await rx.upload("screenshot.png", "image/png", bytes(4096, 3));
    rx.files.set(png.sha256, { bytes: bytes(4000, 3), type: "image/png" });
    const q = await start([png]);
    await failed(q.id, /screenshot\.png.*4000 bytes, not its signed 4096/);
  });

  it("a content-length past the signed size: not a byte of the body is read", async () => {
    await startDaemon();
    const png = await rx.upload("screenshot.png", "image/png", bytes(4096, 3));
    rx.files.set(png.sha256, { bytes: bytes(4097, 3), type: "image/png" });
    const q = await start([png]);
    await failed(q.id, /larger than its signed size \(4096 bytes\)/);
  });

  it("a stream longer than the signed size is cut off at the size", async () => {
    await startDaemon();
    rx.fileMode = "chunked"; // no content-length: the machine has to count
    const small = await rx.upload("a.png", "image/png", bytes(100_000, 5));
    const huge = bytes(8 * 1_048_576, 6);
    rx.files.set(small.sha256, { bytes: huge, type: "image/png" });
    const q = await start([small]);
    await failed(q.id, /larger than its signed size/);
    await new Promise((r) => setTimeout(r, 300));
    expect(rx.lastFileSent).toBeLessThan(huge.length / 2);
  });

  it("a file the receiver doesn't have (404): failed, and the files before it aren't kept", async () => {
    await startDaemon();
    const ok = await rx.upload("ok.png", "image/png", bytes(1000, 7));
    const gone = await rx.upload("gone.pdf", "application/pdf", bytes(1000, 8));
    rx.files.delete(gone.sha256);
    const q = await start([ok, gone]);
    await failed(q.id, /gone\.pdf.*isn't on the receiver/);
    expect(rx.fileGets).toEqual([ok.sha256, gone.sha256]);
    expect(existsSync(path.join(project, ".sessionpipe"))).toBe(false);
  });

  it("a receiver error (500) on a file: failed with the status", async () => {
    await startDaemon();
    rx.fileMode = "error";
    const png = await rx.upload("screenshot.png", "image/png", bytes(1000, 9));
    const q = await start([png]);
    await failed(q.id, /couldn't download "screenshot\.png": HTTP 500/);
  });

  it("a receiver that never answers, or stops mid-body: the download is abandoned at the timeout", async () => {
    await startDaemon({ extra: { fileTimeoutMs: 300 } });
    const png = await rx.upload("screenshot.png", "image/png", bytes(1000, 9));
    rx.fileMode = "stall-headers";
    const q = await start([png]);
    await failed(q.id, /couldn't download "screenshot\.png": .*abort/i);
    rx.fileMode = "stall-body";
    const q2 = await start([png]);
    await failed(q2.id, /couldn't download "screenshot\.png": .*abort/i);
  });

  it("a .sessionpipe that is a symlink is refused, and nothing is written through it", async () => {
    await startDaemon();
    const elsewhere = path.join(tmp, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, path.join(project, ".sessionpipe"));
    const png = await rx.upload("screenshot.png", "image/png", bytes(1000, 9));
    const q = await start([png]);
    await failed(q.id, /\.sessionpipe is a symlink/);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("a symlink further down (.sessionpipe/files) is refused too", async () => {
    await startDaemon();
    const elsewhere = path.join(tmp, "elsewhere2");
    mkdirSync(elsewhere);
    mkdirSync(path.join(project, ".sessionpipe"));
    symlinkSync(elsewhere, path.join(project, ".sessionpipe", "files"));
    const png = await rx.upload("screenshot.png", "image/png", bytes(1000, 10));
    const q = await start([png]);
    await failed(q.id, /\.sessionpipe\/files is a symlink/);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("a .sessionpipe that is a file, or a session folder that already exists: failed, nothing started", async () => {
    await startDaemon();
    writeFileSync(path.join(project, ".sessionpipe"), "not a folder");
    const png = await rx.upload("screenshot.png", "image/png", bytes(1000, 12));
    const q = await start([png]);
    await failed(q.id, /couldn't save the files: EEXIST/);
    rmSync(path.join(project, ".sessionpipe"));
    mkdirSync(filesDir(), { recursive: true });
    const q2 = await start([png]);
    const a = await rx.waitAck(q2.id);
    expect(a).toMatchObject({ outcome: "failed", code: "file" });
    expect(String(a.detail)).toMatch(/already exists/);
    expect(readdirSync(filesDir())).toEqual([]);
    expect(claudeRan()).toBe(false);
  });
});

describe.runIf(unix)("refusals (CONTROL.md §5)", () => {
  it("a tampered command, a replay, a folder off the list, an expired message", { timeout: 20_000 }, async () => {
    await startDaemon({ folders: [path.join(tmp, "elsewhere")] });
    mkdirSync(path.join(tmp, "elsewhere"));
    const bad = await rx.send(
      { session: SESSION, text: "hi" },
      { tamper: (c) => c.replace('"text":"hi"', '"text":"rm"') },
    );
    expect(await rx.waitAck(bad.id)).toMatchObject({ outcome: "refused", code: "bad_csig" });
    const f = await rx.send({ session: SESSION, text: "hi" });
    expect(await rx.waitAck(f.id)).toMatchObject({ outcome: "refused", code: "folder" });
    // The same signed bytes under a new receiver id: the nonce is the dedup key.
    rx.enqueue({ ...f, id: `${f.id.slice(0, -1)}Z`, takenAt: undefined } as never);
    expect(await rx.waitAck(`${f.id.slice(0, -1)}Z`)).toMatchObject({ outcome: "refused", code: "replay" });
    // A receiver drops an expired message itself; one that still hands it over gets `expired`.
    const q = await rx.send({ session: SESSION, text: "hi" });
    rx.queue.clear();
    await d!.handle(cfg().receivers[0]!, {
      ...(q as unknown as Carried),
      id: `${q.id.slice(0, -1)}Y`,
      expires_at: new Date(Date.now() - 1).toISOString(),
    });
    expect(await rx.waitAck(`${q.id.slice(0, -1)}Y`)).toMatchObject({ outcome: "expired" });
  });
  it("a command for no session on this machine", async () => {
    await startDaemon();
    const q = await rx.send({ session: "claude-code:00000000-0000-4000-8000-000000000000", text: "hi" });
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "refused", code: "no_session" });
  });
});

describe.runIf(unix)("the built hook talks to the daemon", () => {
  const dist = path.resolve(here, "../dist/hook.js");
  const runHook = (event: string, stdin: object) =>
    new Promise<string>((resolve) => {
      const c = spawn(process.execPath, [dist, "claude-code", event], {
        env: { ...env, SESSIONPIPE_NO_WORKER: "1" },
        cwd: project,
      });
      let out = "";
      c.stdout.on("data", (b) => {
        out += b;
      });
      c.on("close", () => resolve(out));
      c.stdin.end(JSON.stringify(stdin));
    });

  it.runIf(existsSync(dist))(
    "Stop prints a block for a queued message; PermissionRequest prints the signed decision",
    async () => {
      await startDaemon();
      await ask(sock, { op: "event", session: SESSION, event: "UserPromptSubmit" }, 500);
      const q = await rx.send({ session: SESSION, text: "from the phone" });
      await new Promise((r) => setTimeout(r, 300));
      const out = await runHook("Stop", { session_id: SID, stop_hook_active: false, cwd: project });
      expect(JSON.parse(out)).toMatchObject({ decision: "block" });
      expect(JSON.parse(out).reason).toContain("from the phone");
      answer(SID, project, "got it");
      expect(await rx.waitAck(q.id)).toMatchObject({ mode: "turn", reply: "got it" });

      const input = {
        session_id: SID,
        prompt_id: "p1",
        tool_name: "Bash",
        tool_input: { command: "rm -rf build" },
        cwd: project,
      };
      const hook = runHook("PermissionRequest", input);
      // The hook names the attention exactly as the adapter does on attention.needed.
      const att = `perm-${(await import("node:crypto"))
        .createHash("sha256")
        .update(`p1|Bash|${JSON.stringify(input.tool_input)}`)
        .digest("hex")
        .slice(0, 16)}`;
      await new Promise((r) => setTimeout(r, 400));
      const a = await rx.send({
        kind: "permission.answer",
        session: SESSION,
        text: undefined,
        for: att,
        decision: "allow",
      });
      expect(JSON.parse(await hook)).toEqual({
        hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
      });
      expect(await rx.waitAck(a.id)).toMatchObject({ outcome: "delivered" });
    },
  );

  it.runIf(existsSync(dist))("with no daemon the hook prints nothing and exits at once", async () => {
    const t = Date.now();
    const out = await runHook("PermissionRequest", { session_id: SID, tool_name: "Bash", tool_input: {} });
    expect(out).toBe("");
    expect(Date.now() - t).toBeLessThan(3000);
  });

  // Our entry in ~/.claude/settings.json is run by every harness that imports that
  // file, under the claude-code name, and the PermissionRequest wait is up to 125 s.
  // A payload that is not Claude Code's must never be parked in it: Devin's names no
  // transcript and its session id is a word-word slug, so this is the shape to refuse.
  it.runIf(existsSync(dist))(
    "a payload another harness ran is not parked in the control wait",
    async () => {
      await startDaemon();
      const t = Date.now();
      const out = await runHook("PermissionRequest", {
        session_id: "zest-lantana",
        prompt_id: "p1",
        tool_name: "exec",
        tool_input: { command: "ls" },
      });
      expect(out).toBe("");
      expect(Date.now() - t).toBeLessThan(3000);
      // A Stop from the same payload is not parked either (it waits before the event).
      const stop = await runHook("Stop", { session_id: "zest-lantana", stop_hook_active: false });
      expect(stop).toBe("");
      // That the Claude Code shape DOES go into the wait, and is answered, is the test
      // above — nothing is started here that would outlive this one.
    },
    20_000,
  );
});

describe.runIf(unix)("one daemon, and when it may restart (autoupdate.ts)", () => {
  /** A stand-in claude that takes its time, so a run is in hand for a while. */
  function slowClaude(ms: number): void {
    writeFileSync(
      fakeClaude,
      `#!/usr/bin/env node
const a = process.argv.slice(2);
setTimeout(() => process.stdout.write(JSON.stringify({ type: "result", result: "slow", session_id: a[a.indexOf("--resume") + 1], is_error: false })), ${ms});
`,
    );
    chmodSync(fakeClaude, 0o755);
  }

  it("busy while a headless run is in hand, idle once it is acked", async () => {
    slowClaude(600);
    await startDaemon();
    expect(d?.busy()).toBeNull();
    const q = await rx.send({ session: SESSION, text: "take your time" });
    let seen: string | null = null;
    for (let i = 0; i < 50 && !seen; i++) {
      seen = d?.busy() ?? null;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(seen).toMatch(/message\(s\) in hand|headless/);
    expect(rx.finalAck(q.id)).toBeUndefined();
    await rx.waitAck(q.id);
    for (let i = 0; i < 50 && d?.busy(); i++) await new Promise((r) => setTimeout(r, 20));
    expect(d?.busy()).toBeNull();
    expect(((await ask(sock, { op: "status" }, 500)) as { status: { busy: unknown } }).status.busy).toBeNull();
  });

  it("busy while a permission prompt waits for an answer", async () => {
    await startDaemon();
    const hook = ask(sock, { op: "permission", session: SESSION, attention: "perm-0123456789abcdef" }, 5000);
    await new Promise((r) => setTimeout(r, 100));
    expect(d?.busy()).toMatch(/permission prompt/);
    await ask(sock, { op: "event", session: SESSION, event: "PostToolUse" }, 500);
    await hook;
    expect(d?.busy()).toBeNull();
  });

  it("busy while someone's session is mid-turn, until its Stop", async () => {
    await startDaemon();
    await ask(sock, { op: "event", session: SESSION, event: "UserPromptSubmit" }, 500);
    expect(d?.busy()).toMatch(/mid-turn/);
    await ask(sock, { op: "event", session: SESSION, event: "Stop" }, 500);
    expect(d?.busy()).toBeNull();
  });

  it("paused intake leaves new messages with the receiver until it resumes", async () => {
    await startDaemon();
    await new Promise((r) => setTimeout(r, 100));
    d?.pauseIntake();
    await new Promise((r) => setTimeout(r, 300));
    const polls = rx.polls.length;
    const q = await rx.send({ session: SESSION, text: "after the update" });
    await new Promise((r) => setTimeout(r, 500));
    expect(rx.acks.some((a) => a.id === q.id)).toBe(false);
    expect(rx.polls.length).toBe(polls);
    d?.resumeIntake();
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered", mode: "resume" });
  });

  it("a second daemon on the same socket doesn't start; the first keeps serving", async () => {
    await startDaemon();
    const second = new ControlDaemon(cfg(), path.join(tmp, "state", "control2"), sock, {
      now: Date.now,
      fetch,
      log: () => {},
      claudeDirs: () => [configDir],
      claude: () => null,
      run: async () => ({ code: 0, signal: null, stdout: "", stderr: "", tooBig: false, timedOut: false }),
    });
    const err = await second.start().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DaemonRunning);
    expect(String((err as Error).message)).toMatch(new RegExp(`pid ${process.pid}`));
    await second.stop();
    expect(existsSync(sock)).toBe(true);
    expect(await ask(sock, { op: "status" }, 500)).toMatchObject({ op: "status" });
  });

  it("a dead daemon's socket file is taken over; stepping aside never removes another daemon's", async () => {
    // What a crashed daemon leaves: a socket file with nobody listening.
    writeFileSync(sock, "");
    let lost = 0;
    await startDaemon({ extra: { onLostSocket: () => lost++ } });
    expect(await ask(sock, { op: "status" }, 500)).toMatchObject({ op: "status" });
    // Another daemon replaces the file (two started at once): this one steps aside...
    const net = await import("node:net");
    rmSync(sock);
    const other = net.createServer((c) => c.once("data", () => c.end(`${JSON.stringify({ op: "none" })}\n`)));
    await new Promise<void>((r) => other.listen(sock, () => r()));
    await (d as unknown as { checkSocket(): Promise<void> }).checkSocket();
    expect(lost).toBe(1);
    // ...and leaves the other's socket where it is, answering.
    expect(existsSync(sock)).toBe(true);
    expect(await ask(sock, { op: "status" }, 500)).toEqual({ op: "none" });
    await new Promise<void>((r) => other.close(() => r()));
  });

  it("a socket file someone deleted is made again", async () => {
    await startDaemon();
    rmSync(sock);
    expect(await ask(sock, { op: "status" }, 300)).toBeNull();
    await (d as unknown as { checkSocket(): Promise<void> }).checkSocket();
    expect(await ask(sock, { op: "status" }, 500)).toMatchObject({ op: "status" });
  });

  it("restart: `sessionpipe update` asks over the socket; the updater decides", async () => {
    let asked = 0;
    await startDaemon({
      extra: {
        onRestart: () => {
          asked++;
          return true;
        },
        updateStatus: () => ({ latest: "9.9.9" }),
      },
    });
    expect(await ask(sock, { op: "restart" }, 500)).toEqual({ op: "ok" });
    expect(asked).toBe(1);
    const st = (await ask(sock, { op: "status" }, 500)) as { status: { pid: number; update: unknown } };
    expect(st.status).toMatchObject({ pid: process.pid, update: { latest: "9.9.9" } });
    // An op it doesn't know closes the connection rather than leaving it open.
    expect(await ask(sock, { op: "nope" } as never, 500)).toBeNull();
  });
});
