// SPDX-License-Identifier: Apache-2.0
// The daemon's local socket (CONTROL.md §8) and its lifecycle at the edges: frames it
// won't read, waiters and hooks that replace each other, events that only touch state,
// what `busy()` says for each thing in hand, a socket path that is taken, blocked or
// lost, and a daemon told to stop at every point.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlDaemon, type DaemonDeps, DaemonRunning, type SdkHost } from "../src/control/daemon.js";

// The build bakes the version in; the daemon reports that one.
vi.hoisted(() => {
  (globalThis as { __SESSIONPIPE_VERSION__?: string }).__SESSIONPIPE_VERSION__ = "9.9.9";
});

import { ask } from "../src/control/local.js";
import type { ControlConfig } from "../src/control/store.js";
import { waitForMessage } from "../src/control/wait.js";
import { FakeReceiver } from "./helpers/receiver.js";

const SID = "8c132906-8c3f-4814-870a-afc3d05e1d2e";
const SESSION = `claude-code:${SID}`;
const unix = process.platform !== "win32";

let tmp: string;
let rx: FakeReceiver;
let d: ControlDaemon | null = null;
let env: NodeJS.ProcessEnv;
let sock: string;
let project: string;
let log: string[];

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

function make(o: { extra?: Partial<DaemonDeps>; cfg?: Partial<ControlConfig>; sock?: string } = {}): ControlDaemon {
  d = new ControlDaemon(cfg(o.cfg), path.join(tmp, "state", "control"), o.sock ?? sock, {
    now: Date.now,
    fetch,
    log: (s) => log.push(s),
    claudeDirs: () => [path.join(tmp, "claude-config")],
    claude: () => null,
    run: async () => ({ code: 0, signal: null, stdout: "", stderr: "", tooBig: false, timedOut: false }),
    env,
    // Nobody answers in these sessions: a turn's answer is waited for only briefly.
    answerWaitMs: 200,
    ...o.extra,
  });
  return d;
}

/** A raw client on the socket: writes what it is told, keeps what comes back. */
function raw(): Promise<{ s: net.Socket; got: () => string; closed: () => boolean }> {
  return new Promise((resolve) => {
    let got = "";
    let closed = false;
    const s = net.connect(sock);
    s.on("data", (b) => {
      got += b;
    });
    s.on("close", () => {
      closed = true;
    });
    s.on("error", () => {});
    s.on("connect", () => resolve({ s, got: () => got, closed: () => closed }));
  });
}
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  rx = new FakeReceiver();
  await rx.start();
});
afterAll(async () => {
  await rx.stop();
});
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "sp-sock-"));
  project = path.join(tmp, "project");
  mkdirSync(project, { recursive: true });
  sock = path.join(tmp, "control.sock");
  log = [];
  env = {
    ...process.env,
    SESSIONPIPE_STATE: path.join(tmp, "state"),
    SESSIONPIPE_CONFIG: path.join(tmp, "config", "config.json"),
    SESSIONPIPE_SOCKET: sock,
  };
  // The session's transcript, written ten minutes ago: idle, and in the allowed folder.
  const dir = path.join(tmp, "claude-config", "projects", project.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${SID}.jsonl`);
  writeFileSync(f, `${JSON.stringify({ type: "user", cwd: project, message: { content: "hi" } })}\n`);
  const past = new Date(Date.now() - 600_000);
  utimesSync(f, past, past);
  rx.queue.clear();
  rx.acks.length = 0;
  rx.hellos.length = 0;
});
afterEach(async () => {
  await d?.stop();
  d = null;
  rmSync(tmp, { recursive: true, force: true });
});

describe.runIf(unix)("frames on the socket", () => {
  it("a frame that isn't a line of JSON closes the connection", async () => {
    await make().start();
    const bad = await raw();
    bad.s.write("not json\n");
    await settle();
    expect(bad.closed()).toBe(true);
    // No newline yet: the daemon waits for the rest of the line.
    const slow = await raw();
    slow.s.write('{"op":"sta');
    await settle();
    expect(slow.closed()).toBe(false);
    slow.s.write('tus"}\n');
    await settle();
    expect(JSON.parse(slow.got().trim())).toMatchObject({ op: "status" });
    // A line that never ends is cut off at 64 KiB.
    const flood = await raw();
    flood.s.write("x".repeat(70 * 1024));
    await settle();
    expect(flood.closed()).toBe(true);
    // Whatever follows the one request a connection carries is ignored.
    const twice = await raw();
    twice.s.write(`${JSON.stringify({ op: "wait", session: SESSION })}\n`);
    await settle();
    twice.s.write("{garbage\n");
    await settle();
    expect(twice.closed()).toBe(false);
    expect(d?.status().waiting).toEqual([SESSION]);
    twice.s.destroy();
  });

  it("a waiter for a session that isn't one is answered nothing; the newest waiter for a session wins", async () => {
    await make().start();
    expect(await ask(sock, { op: "wait", session: "nope" }, 500)).toEqual({ op: "none" });
    const first = waitForMessage(SESSION, { env });
    await settle();
    const second = waitForMessage(SESSION, { env });
    expect(await first).toContain("took over");
    await settle();
    expect(d?.status().waiting).toEqual([SESSION]);
    // The old waiter's socket closing doesn't unseat the new one.
    const q = await rx.send({ session: SESSION, text: "to the new one" });
    expect(await second).toContain("to the new one");
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered", mode: "waiter" });
  });

  it("a hook that gives up on its own is forgotten; a client that vanishes mid-reply is no trouble", async () => {
    await make().start();
    const ATT = "perm-5f1c0e9a2b7d4c31";
    expect(await ask(sock, { op: "permission", session: SESSION, attention: ATT }, 100)).toBeNull();
    await settle();
    expect(d?.status().attentions).toEqual([]);
    const gone = await raw();
    gone.s.write(`${JSON.stringify({ op: "status" })}\n`);
    gone.s.destroy();
    await settle();
    expect(await ask(sock, { op: "status" }, 500)).toMatchObject({ op: "status", status: { version: "9.9.9" } });
  });

  it("stopping the daemon lets a parked hook go, with no answer (nothing is ever auto-allowed)", async () => {
    const dm = make();
    await dm.start();
    const hook = ask(sock, { op: "permission", session: SESSION, attention: "perm-5f1c0e9a2b7d4c31" }, 5000);
    await settle();
    expect(dm.status().attentions).toHaveLength(1);
    await dm.stop();
    d = null;
    expect(await hook).toBeNull();
  });

  it("a second hook for the same attention releases the first; the first's close leaves the second in place", async () => {
    await make().start();
    const ATT = "perm-5f1c0e9a2b7d4c31";
    const first = ask(sock, { op: "permission", session: SESSION, attention: ATT }, 5000);
    await settle();
    const second = ask(sock, { op: "permission", session: SESSION, attention: ATT }, 5000);
    expect(await first).toEqual({ op: "none" });
    await settle();
    expect(d?.status().attentions).toEqual([{ session: SESSION, id: ATT }]);
    await ask(sock, { op: "event", session: SESSION, event: "PostToolUse" }, 500);
    expect(await second).toEqual({ op: "none" });
  });

  it("events: a transcript and a folder are remembered, SessionStart isn't a turn, a name without a harness is kept as is", async () => {
    await make().start();
    await ask(
      sock,
      { op: "event", session: SESSION, event: "SessionStart", transcript: "/t.jsonl", cwd: project },
      500,
    );
    expect(d?.status().mid_turn).toEqual([]);
    await ask(sock, { op: "event", session: "nocolon", event: "UserPromptSubmit" }, 500);
    expect(d?.status().mid_turn).toEqual(["nocolon"]);
    expect(await ask(sock, { op: "restart" }, 500)).toEqual({ op: "none" });
  });

  it("a Stop skips a queued message that was already acked some other way", async () => {
    await make().start();
    const live = (d as unknown as { liveOf(s: string): { turnQueue: unknown[] } }).liveOf(SESSION);
    live.turnQueue.push({ receiver: cfg().receivers[0], msgId: "01STALE", text: "old", session: SESSION, queuedAt: 0 });
    expect(await ask(sock, { op: "stop", session: SESSION, active: false }, 500)).toEqual({ op: "none" });
    live.turnQueue.push({ receiver: cfg().receivers[0], msgId: "01STALE", text: "old", session: SESSION, queuedAt: 0 });
    await ask(sock, { op: "event", session: SESSION, event: "Stop" }, 500);
    expect(live.turnQueue).toEqual([]);
    expect(rx.acks).toEqual([]);
  });
});

describe.runIf(unix)("what is in hand", () => {
  it("names each thing the updater must wait for", async () => {
    const dm = make({
      extra: {
        sdk: {
          start: () => ({
            send: async () => ({ reply: "" }),
            interrupt: async () => {},
            close: () => {},
            busy: true,
            lastUsed: 0,
          }),
        } as SdkHost,
      },
    });
    await dm.start();
    const priv = dm as unknown as {
      slot<T>(fn: () => Promise<T>): Promise<T>;
      owning<T>(s: string, fn: () => Promise<T>): Promise<T>;
      startsRunning: number;
      sdkSessions: Map<string, unknown>;
      receiving: number;
      flushing: boolean;
    };
    expect(await priv.slot(async () => dm.busy())).toBe("a headless agent run");
    expect(await priv.owning(SID, async () => dm.busy())).toBe("a headless agent run");
    priv.startsRunning = 1;
    expect(dm.busy()).toBe("a session starting");
    priv.startsRunning = 0;
    priv.sdkSessions.set(
      SID,
      (dm as unknown as { deps: DaemonDeps }).deps.sdk!.start({ session: SID, cwd: project, mode: "safe" }),
    );
    expect(dm.busy()).toBe("an Agent SDK session mid-turn");
    priv.sdkSessions.clear();
    priv.receiving = 1;
    expect(dm.busy()).toBe("messages just received");
    priv.receiving = 0;
    priv.flushing = true;
    expect(dm.busy()).toBe("acks being sent");
    priv.flushing = false;
    expect(dm.busy()).toBeNull();
    // Pausing twice is pausing once.
    dm.pauseIntake();
    dm.pauseIntake();
    dm.resumeIntake();
  });
});

describe.runIf(unix)("the socket path", () => {
  it("before start: no receiver polls; a stale status answer with no body is still another daemon", async () => {
    const dm = make();
    expect(dm.status().receivers[0]).toMatchObject({ polling: false, last_poll: null, last_poll_age_ms: 0 });
    const other = net.createServer((c) => c.once("data", () => c.end(`${JSON.stringify({ op: "status" })}\n`)));
    await new Promise<void>((r) => other.listen(sock, () => r()));
    try {
      const err = await dm.start().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(DaemonRunning);
      expect((err as Error).message).toBe("another control daemon already serves this machine (sessionpipe ?)");
      expect(new DaemonRunning({ pid: 3 }).message).toBe(
        "another control daemon already serves this machine (pid 3, sessionpipe ?)",
      );
    } finally {
      await new Promise<void>((r) => other.close(() => r()));
    }
  });

  it("a Windows-shaped start keeps no socket file to watch, and stop leaves the path alone", async () => {
    const real = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const dm = make();
    try {
      await dm.start();
    } finally {
      Object.defineProperty(process, "platform", real);
    }
    expect(await ask(sock, { op: "status" }, 500)).toMatchObject({ op: "status" });
    await dm.stop();
    d = null;
    // Nothing was ever checked, so nothing is unlinked by the daemon; Node did it on close.
    expect(log.some((l) => l.includes("took over"))).toBe(false);
  });

  it("after stop, the socket check is a no-op; a path that can't be listened on again is logged", async () => {
    const dir = path.join(tmp, "sockdir");
    mkdirSync(dir);
    const dm = make({ sock: path.join(dir, "control.sock") });
    await dm.start();
    const check = () => (dm as unknown as { checkSocket(): Promise<void> }).checkSocket();
    // The whole folder went: listening again fails, and the daemon says so.
    rmSync(dir, { recursive: true, force: true });
    await check();
    expect(log.some((l) => l.startsWith("the socket") && l.endsWith("vanished; listening again"))).toBe(true);
    expect(log.some((l) => l.startsWith("couldn't listen again: "))).toBe(true);
    await dm.stop();
    const n = log.length;
    await check();
    expect(log).toHaveLength(n);
  });

  it("a receiver added to control.json while it runs gets its own poll loop", async () => {
    const dm = make();
    await dm.start();
    const second = {
      ...cfg().receivers[0]!,
      machine: "m_second000000000000002",
      control: `${rx.url}/api/sessionpipe/v1/control`,
    };
    dm.reload({ ...cfg(), receivers: [cfg().receivers[0]!, second] });
    expect(dm.status().receivers.map((r) => r.machine)).toEqual([rx.machine, second.machine]);
    expect(dm.status().receivers[1]?.polling).toBe(true);
  });

  it("a poll that answers after the daemon stopped ends its loop quietly; a failed poll says why", async () => {
    let resolveLate!: (r: Response) => void;
    let polls = 0;
    const dm = make({
      extra: {
        fetch: async (u, init) => {
          const url = String(u);
          if (url.includes("/control?")) {
            polls++;
            if (polls === 1) return Promise.reject("the network went away");
            // The second poll ignores the abort and answers after stop().
            return new Promise<Response>((r) => {
              resolveLate = r;
            });
          }
          return fetch(u, init);
        },
      },
    });
    await dm.start();
    for (let i = 0; i < 100 && polls < 2; i++) await settle(20);
    expect(dm.status().receivers[0]?.last_error).toBe("the network went away");
    await dm.stop();
    resolveLate(new Response(null, { status: 503 }));
    await settle();
    expect(polls).toBe(2);
    expect(dm.status().receivers[0]?.polling).toBe(false);
  });

  it("while a poll's body is being read, and while acks go out, the daemon is busy", async () => {
    let releaseAck: (() => void) | null = null;
    const dm = make({
      extra: {
        fetch: async (u, init) => {
          const url = String(u);
          const r = await fetch(u, init);
          if (url.includes("/control?") && r.status === 200) {
            const body = await r.json();
            return {
              status: 200,
              headers: r.headers,
              json: () => new Promise((res) => setTimeout(() => res(body), 150)),
            } as Response;
          }
          if (url.endsWith("/ack") && releaseAck === null) await new Promise<void>((res) => (releaseAck = res));
          return r;
        },
      },
    });
    await dm.start();
    await rx.send({ session: SESSION, text: "hi" });
    for (let i = 0; i < 100 && dm.busy() !== "messages just received"; i++) await settle(10);
    expect(dm.busy()).toBe("messages just received");
    for (let i = 0; i < 100 && !releaseAck; i++) await settle(10);
    // Nothing in hand but the ack on its way.
    for (let i = 0; i < 100 && dm.busy() !== "acks being sent"; i++) await settle(10);
    expect(dm.busy()).toBe("acks being sent");
    releaseAck!();
  });
});

describe.runIf(unix)("messages the daemon can't take in", () => {
  it("not a message, a start it can't read, a message dated nonsense; a handler that throws is logged", async () => {
    const dm = make();
    await dm.start();
    const r = cfg().receivers[0]!;
    await dm.handle(r, null as never);
    await dm.handle(r, { id: 5 } as never);
    expect(rx.acks).toEqual([]);
    const q = await rx.send({ session: SESSION, text: "hi" }, { hold: true });
    await dm.handle(r, { ...q, at: "garbage", cmd: '{"kind":"start"' } as never);
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "refused", code: "malformed" });
    const q2 = await rx.send({ session: SESSION, text: "hi" }, { hold: true });
    await dm.handle(r, { ...q2, cmd: '{"kind":"start","session":5}' } as never);
    expect(await rx.waitAck(q2.id)).toMatchObject({ outcome: "refused", code: "not_a_command" });
    // The acks file can't be appended to: the handler throws, and the poll loop says so.
    rmSync(path.join(tmp, "state", "control", "acks.jsonl"), { force: true });
    mkdirSync(path.join(tmp, "state", "control", "acks.jsonl"));
    const q3 = await rx.send({ session: SESSION, text: "hi" });
    for (let i = 0; i < 100 && !log.some((l) => l.startsWith("handle ")); i++) await settle(20);
    expect(log.find((l) => l.startsWith("handle "))).toMatch(new RegExp(`^handle ${q3.id.slice(-8)}: EISDIR`));
  });

  it("a nonce that can't be recorded refuses the command (CONTROL.md §5 step 5: nonce_store)", async () => {
    const dm = make();
    await dm.start();
    mkdirSync(path.join(tmp, "state", "control", "nonces.jsonl"), { recursive: true });
    const q = await rx.send({ session: SESSION, text: "hi" });
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "refused", code: "nonce_store" });
  });

  it("a start for a harness the daemon can't drive is unsupported; a bad .claude.json names nobody", async () => {
    const dm = make({
      extra: {
        accounts: () => {
          throw new Error("EACCES");
        },
        harnesses: () => ["claude-code"],
      },
    });
    await dm.start();
    const q = await rx.send({ kind: "start", session: "gemini-cli:abc", cwd: project, text: "hi" });
    expect(await rx.waitAck(q.id)).toMatchObject({
      outcome: "unsupported",
      detail: "can't start a gemini-cli session",
    });
    for (let i = 0; i < 100 && !rx.hellos.length; i++) await settle(20);
    expect(rx.hellos[0]).toMatchObject({ harnesses: ["claude-code"] });
    expect(rx.hellos[0]).not.toHaveProperty("accounts");
    // A folder entry with a trailing slash that doesn't exist is compared as written.
    chmodSync(project, 0o700);
  });
});
