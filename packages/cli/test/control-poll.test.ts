// SPDX-License-Identifier: Apache-2.0
// Fake time and HTTP handlers only: the existing receiver signs the messages,
// but never listens on TCP. The daemon uses its real local IPC socket.
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DayKey, Passkey } from "../../core/test/helpers/authenticator.js";
import { ControlDaemon, type DaemonDeps, type SdkHost } from "../src/control/daemon.js";
import { ask } from "../src/control/local.js";
import type { ControlConfig } from "../src/control/store.js";
import { FakeReceiver } from "./helpers/receiver.js";

const MINUTE = 60_000;
const SID = "8c132906-8c3f-4814-870a-afc3d05e1d2e";
let tmp: string;
let rx: FakeReceiver;
let daemon: ControlDaemon;
let config: ControlConfig;
const poll = vi.fn<typeof fetch>();
const hello = vi.fn<typeof fetch>();
const run = vi.fn<DaemonDeps["run"]>();
const log = vi.fn();
const state = () => daemon.status().receivers[0]!;

// An ordinary empty long-poll, including the daemon's shutdown/timeout abort.
const emptyPoll: typeof fetch = (_url, init) =>
  new Promise((resolve, reject) => {
    const finish = () => {
      init?.signal?.removeEventListener("abort", abort);
      resolve(new Response(null, { status: 204 }));
    };
    const timer = setTimeout(finish, 25_000);
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    init?.signal?.addEventListener("abort", abort, { once: true });
  });

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-10-19T00:00:00Z"));
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  tmp = mkdtempSync(path.join(os.tmpdir(), "sp-poll-"));
  rx = new FakeReceiver();
  rx.url = "https://receiver.test";
  rx.passkey = await Passkey.create({ rpId: "receiver.test", origin: rx.url });
  rx.day = await DayKey.create();
  poll.mockReset().mockImplementation(emptyPoll);
  hello.mockReset().mockImplementation(async () => new Response(null, { status: 401 }));
  log.mockReset();
  run.mockReset().mockResolvedValue({
    code: 0,
    signal: null,
    stdout: JSON.stringify({ type: "result", result: "delivered", session_id: SID, is_error: false }),
    stderr: "",
    tooBig: false,
    timedOut: false,
  });
  config = {
    name: "testbox",
    folders: [tmp],
    mode: "safe",
    receivers: [
      {
        url: rx.url,
        control: `${rx.url}/control`,
        rpId: "receiver.test",
        machine: rx.machine,
        token: rx.token,
        keys: [{ ...rx.passkey.key, added_at: new Date().toISOString() }],
        paired_at: new Date().toISOString(),
      },
    ],
  };
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    if (u.pathname === "/.well-known/sessionpipe") return Response.json({});
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${rx.token}`);
    if (u.pathname === "/control/hello") return hello(url, init);
    if (u.pathname === "/control/ack") {
      const status = ackStatus.shift() ?? 202;
      if (status === 0) throw new Error("ECONNRESET");
      if (status === 202) rx.acks.push(...JSON.parse(String(init?.body)).acks);
      return new Response(null, { status });
    }
    expect(u.pathname).toBe("/control");
    return poll(url, init);
  };
  ackStatus.length = 0;
  deps = {
    now: Date.now,
    fetch,
    log,
    claudeDirs: () => [path.join(tmp, "claude")],
    accounts: () => [],
    claude: () => ({
      bin: "fake-claude",
      caps: { hasMode: true, modes: ["dontAsk"], promptsNone: false, fork: true },
    }),
    run,
  };
  daemon = new ControlDaemon(config, path.join(tmp, "control"), sock(), deps);
});
const sock = () =>
  process.platform === "win32" ? `\\\\.\\pipe\\${path.basename(tmp)}` : path.join(tmp, "control.sock");
/** What the ack endpoint answers next, in order (0: the connection fails); 202 when the list is empty. */
const ackStatus: number[] = [];
let deps: DaemonDeps;
/** The session's transcript in the daemon's Claude Code config dir, in the allowed folder. */
function transcript(sid = SID): string {
  const dir = path.join(tmp, "claude", "projects", tmp.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${sid}.jsonl`);
  writeFileSync(f, `${JSON.stringify({ type: "user", cwd: tmp })}\n`);
  // Written ten minutes ago by the daemon's (fake) clock: idle, not someone's live session.
  const past = new Date(Date.now() - 10 * MINUTE);
  utimesSync(f, past, past);
  return f;
}
/** A run that answers as `claude -p --output-format json` does. */
const result = (over: Record<string, unknown> = {}) => ({
  code: 0,
  signal: null,
  stdout: JSON.stringify({ type: "result", result: "delivered", session_id: SID, is_error: false, ...over }),
  stderr: "",
  tooBig: false,
  timedOut: false,
});

afterEach(async () => {
  await daemon.stop();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

async function start(): Promise<void> {
  await daemon.start();
  await vi.advanceTimersByTimeAsync(0);
}

describe("control poll recovery", () => {
  it("retries a single 401 and delivers a signed message without restarting or re-pairing", async () => {
    const message = await rx.send({ kind: "start", session: `claude-code:${SID}`, cwd: tmp, text: "hello" });
    poll
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ messages: [message] }));
    await start();
    expect(state()).toMatchObject({ polling: false, last_poll: null, last_error: expect.stringContaining("401") });
    await vi.advanceTimersByTimeAsync(MINUTE - 1);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(rx.finalAck(message.id)).toMatchObject({ outcome: "delivered", reply: "delivered" }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(state()).toMatchObject({ polling: true, last_error: null });
    expect(state().last_poll).not.toBeNull();
    expect(config.receivers[0]?.token).toBe(rx.token);
  });

  it("keeps retrying persistent 401s at 1, 2, 4, 8, 16, then at most every 30 minutes", async () => {
    const began = Date.now();
    const times: number[] = [];
    poll.mockImplementation(async () => {
      times.push((Date.now() - began) / MINUTE);
      return new Response(null, { status: 401 });
    });
    await start();
    await vi.advanceTimersByTimeAsync(120 * MINUTE);
    expect(times).toEqual([0, 1, 3, 7, 15, 31, 61, 91]);
    expect(poll).toHaveBeenCalledTimes(8);
    expect(state()).toMatchObject({ polling: false, last_poll: null, last_poll_age_ms: 120 * MINUTE });
    expect(state().last_error).toContain("sessionpipe control pair");
    expect(log.mock.calls.filter(([line]) => line.includes("(401)"))).toHaveLength(8);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(times.at(-1)).toBe(121);
  });

  it("an accepted hello clears the 401 error and wakes the same loop immediately", async () => {
    let accept!: (r: Response) => void;
    hello.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          accept = resolve;
        }),
    );
    poll.mockResolvedValueOnce(new Response(null, { status: 401 }));
    await start();
    await vi.advanceTimersByTimeAsync(10_000);
    accept(new Response(null, { status: 204 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(2);
    expect(state()).toMatchObject({ polling: true, last_error: null, last_poll: null, last_poll_age_ms: 10_000 });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(state().last_poll_age_ms).toBe(0);
  });

  it("a periodic accepted hello resets an already rising 401 backoff", async () => {
    poll.mockResolvedValue(new Response(null, { status: 401 }));
    await start();
    await vi.advanceTimersByTimeAsync(9 * MINUTE);
    expect(poll).toHaveBeenCalledTimes(4); // 0, 1, 3, 7; next would be 15.
    hello.mockResolvedValue(new Response(null, { status: 204 }));
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(poll).toHaveBeenCalledTimes(5); // The ten-minute hello wakes it now.
    await vi.advanceTimersByTimeAsync(MINUTE - 1);
    expect(poll).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(6); // A new 401 starts again at one minute.
  });

  it("an accepted hello wakes only its own receiver", async () => {
    config.receivers.push({
      ...config.receivers[0]!,
      url: "https://second.test",
      control: "https://second.test/control",
      machine: "second",
    });
    let accept!: (r: Response) => void;
    hello.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          accept = resolve;
        }),
    );
    poll.mockResolvedValue(new Response(null, { status: 401 }));
    await start();
    expect(poll).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    accept(new Response(null, { status: 204 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(3);
    expect(new URL(String(poll.mock.calls[2]?.[0])).host).toBe("receiver.test");
    expect(daemon.status().receivers[1]).toMatchObject({ polling: false, last_error: expect.stringContaining("401") });
  });

  it.each([401, 503])("a failed hello (%s) leaves the 401 backoff alone", async (status) => {
    hello.mockResolvedValue(new Response(null, { status }));
    poll.mockResolvedValue(new Response(null, { status: 401 }));
    await start();
    await vi.advanceTimersByTimeAsync(MINUTE - 1);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(state().last_error).toContain("401");
    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it.each([200, 204])("a successful %s poll resets the 401 backoff", async (status) => {
    poll
      .mockResolvedValue(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(status === 200 ? Response.json({ messages: [] }) : new Response(null, { status }));
    await start();
    await vi.advanceTimersByTimeAsync(MINUTE + (status === 200 ? 2000 : 0));
    expect(poll).toHaveBeenCalledTimes(3);
    const last = state().last_poll;
    await vi.advanceTimersByTimeAsync(MINUTE - 1);
    expect(poll).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(4);
    expect(state().last_poll).toBe(last);
  });

  it.each(["seconds", "date"])(
    "honours 503 Retry-After as %s, without a pairing error or hello shortcut",
    async (format) => {
      const after = format === "seconds" ? "120" : new Date(Date.now() + 120_000).toUTCString();
      poll.mockResolvedValueOnce(new Response(null, { status: 503, headers: { "Retry-After": after } }));
      hello.mockResolvedValue(new Response(null, { status: 204 }));
      await start();
      expect(state()).toMatchObject({ polling: false, last_poll: null, last_error: "HTTP 503" });
      await vi.advanceTimersByTimeAsync(120_000 - 1);
      expect(poll).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(poll).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(25_000);
      expect(state().last_error).toBeNull();
    },
  );

  it.each([null, "invalid", "0", "-1", "Mon, 19 Oct 2026 00:00:00 GMT"])(
    "503s still back off when Retry-After is %s",
    async (after) => {
      poll.mockImplementation(
        async () =>
          new Response(null, {
            status: 503,
            headers: after === null ? {} : { "Retry-After": after },
          }),
      );
      await start();
      await vi.advanceTimersByTimeAsync(999);
      expect(poll).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(poll).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1999);
      expect(poll).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(poll).toHaveBeenCalledTimes(3);
    },
  );

  it("shutdown interrupts a long backoff and cannot restart polling", async () => {
    poll.mockResolvedValue(new Response(null, { status: 401 }));
    await start();
    await daemon.stop();
    await vi.advanceTimersByTimeAsync(120 * MINUTE);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(state().polling).toBe(false);
  });

  it("hello recovery respects intake paused for an update", async () => {
    let accept!: (r: Response) => void;
    hello.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          accept = resolve;
        }),
    );
    poll.mockResolvedValueOnce(new Response(null, { status: 401 }));
    await start();
    daemon.pauseIntake();
    accept(new Response(null, { status: 204 }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(state()).toMatchObject({ polling: false, last_error: null });
    daemon.resumeIntake();
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(2);
  });
});

describe("the machine's token", () => {
  it("unreadable at start: said once, asked again every 30 s, polled with as soon as it reads", async () => {
    config.receivers[0]!.token = "";
    config.receivers[0]!.token_in = "keychain";
    const token = vi
      .fn<NonNullable<DaemonDeps["token"]>>()
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(null)
      .mockReturnValue(rx.token);
    deps.token = token;
    await start();
    expect(poll).not.toHaveBeenCalled();
    expect(state().last_error).toBe("can't read this machine's token from keychain (locked?); retrying every 30 s");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(log.mock.calls.filter(([l]) => String(l).includes("can't read"))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(log).toHaveBeenCalledWith(`${rx.url}: machine token readable again`);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(config.receivers[0]?.token).toBe(rx.token);
  });

  it("with no store to ask, a missing token is named as its store", async () => {
    config.receivers[0]!.token = "";
    await start();
    expect(state().last_error).toContain("from its store (locked?)");
    expect(log).toHaveBeenCalledWith(`${rx.url}: can't read this machine's token from its store; retrying`);
  });
});

describe("what a poll can answer", () => {
  it("a 200 with no messages, and a 500: back off like any failure", async () => {
    poll.mockResolvedValueOnce(Response.json({})).mockResolvedValueOnce(new Response(null, { status: 500 }));
    await start();
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(poll).toHaveBeenCalledTimes(2);
    expect(state()).toMatchObject({ polling: false, last_error: "HTTP 500" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(poll).toHaveBeenCalledTimes(3);
  });

  it("a receiver unpaired while its poll was parked: what that poll brought is still handled; its ack has nowhere to go; the loop ends", async () => {
    transcript();
    let answer!: (r: Response) => void;
    const message = await rx.send({ session: `claude-code:${SID}`, text: "last words" });
    poll.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    await start();
    daemon.reload({ ...config, receivers: [] });
    answer(Response.json({ messages: [message] }));
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(daemon.status().busy).toBeNull());
    expect(rx.acks).toEqual([]);
    expect(daemon.status().acks_pending).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(daemon.status().receivers).toEqual([]);
  });

  it("a start for a harness this daemon doesn't drive, with no env of its own", async () => {
    vi.stubEnv("CODEX_HOME", path.join(tmp, "codex-home"));
    const agy = await rx.send({ kind: "start", session: "antigravity:conv-1", cwd: tmp, text: "hi" });
    const codex = await rx.send({ kind: "start", session: "codex:thread-1", cwd: tmp, text: "hi" });
    const thread = await rx.send({ session: "codex:0199c0de-1111-7222-8333-944455556666", text: "hi" });
    poll.mockResolvedValueOnce(Response.json({ messages: [agy, codex, thread] }));
    await start();
    await vi.waitFor(() =>
      expect(rx.finalAck(agy.id)).toMatchObject({
        outcome: "failed",
        detail: "Antigravity isn't installed on this machine",
      }),
    );
    await vi.waitFor(() =>
      expect(rx.finalAck(codex.id)).toMatchObject({
        outcome: "failed",
        detail: "Codex isn't installed on this machine",
      }),
    );
    await vi.waitFor(() => expect(rx.finalAck(thread.id)).toMatchObject({ outcome: "refused", code: "no_session" }));
    vi.unstubAllEnvs();
  });

  it("a poll held past its deadline, and a hello that never answers, are given up on", async () => {
    const hang: typeof fetch = (_u, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    poll.mockImplementationOnce(hang);
    hello.mockImplementationOnce(hang);
    await start();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_001);
    expect(state().last_error).toBe("aborted");
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(poll).toHaveBeenCalledTimes(2);
  });
});

describe("acks (CONTROL.md §10)", () => {
  it("kept and sent again, with a growing pause, until the receiver accepts them; a receiver with none is skipped", async () => {
    config.receivers.push({
      ...config.receivers[0]!,
      url: "https://second.test",
      control: "https://second.test/control",
      machine: "second",
    });
    transcript();
    // Refused once, unreachable once, then accepted.
    ackStatus.push(500, 0);
    const message = await rx.send({ session: `claude-code:${SID}`, text: "hi" });
    poll.mockResolvedValueOnce(Response.json({ messages: [message] }));
    await start();
    await vi.waitFor(() => expect(daemon.status().acks_pending).toBeGreaterThan(0));
    expect(rx.acks).toEqual([]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(rx.acks).toEqual([]);
    await vi.advanceTimersByTimeAsync(4000);
    await vi.waitFor(() => expect(rx.finalAck(message.id)).toMatchObject({ outcome: "delivered" }));
    expect(daemon.status().acks_pending).toBe(0);
  });
});

describe("a message queued for a Stop (CONTROL.md §6 `turn`)", () => {
  it("goes another way after thirty minutes without a Stop; one the Stop took is left alone", async () => {
    transcript();
    run.mockResolvedValue(result());
    await start();
    await ask(sock(), { op: "event", session: `claude-code:${SID}`, event: "UserPromptSubmit" }, 500);
    const late = await rx.send({ session: `claude-code:${SID}`, text: "late" });
    poll.mockResolvedValueOnce(Response.json({ messages: [late] }));
    await vi.advanceTimersByTimeAsync(25_000);
    await vi.waitFor(() => expect(rx.acks.find((a) => a.id === late.id)).toMatchObject({ outcome: "taken" }));
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    await vi.waitFor(() => expect(rx.finalAck(late.id)).toMatchObject({ outcome: "delivered", mode: "resume" }));
    // The next one is taken by the Stop hook in time: the fallback finds nothing to do.
    await ask(sock(), { op: "event", session: `claude-code:${SID}`, event: "UserPromptSubmit" }, 500);
    const taken = await rx.send({ session: `claude-code:${SID}`, text: "in time" });
    poll.mockResolvedValueOnce(Response.json({ messages: [taken] }));
    await vi.advanceTimersByTimeAsync(25_000);
    await vi.waitFor(() => expect(rx.acks.find((a) => a.id === taken.id)).toMatchObject({ outcome: "taken" }));
    expect(await ask(sock(), { op: "stop", session: `claude-code:${SID}`, active: false }, 500)).toMatchObject({
      op: "block",
    });
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    await vi.waitFor(() => expect(rx.finalAck(taken.id)).toMatchObject({ outcome: "delivered", mode: "turn" }));
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("an Agent SDK session held idle", () => {
  it("is closed after its idle time, unless mid-turn or just used, and a later message resumes it", async () => {
    await daemon.stop();
    let busy = false;
    const host: SdkHost = {
      start: () => ({
        send: async () => ({ reply: "ok" }),
        interrupt: async () => {},
        close: () => {},
        get busy() {
          return busy;
        },
        lastUsed: Date.now(),
      }),
    };
    daemon = new ControlDaemon(config, path.join(tmp, "control"), sock(), {
      ...deps,
      sdk: host,
      sdkIdleMs: 5 * MINUTE,
    });
    const message = await rx.send({ kind: "start", session: `claude-code:${SID}`, cwd: tmp, text: "hi" });
    poll.mockResolvedValueOnce(Response.json({ messages: [message] }));
    await start();
    await vi.waitFor(() => expect(rx.finalAck(message.id)).toMatchObject({ outcome: "delivered", mode: "sdk" }));
    expect(daemon.status().sdk).toEqual([SID]);
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(daemon.status().sdk).toEqual([SID]);
    busy = true;
    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    expect(daemon.status().sdk).toEqual([SID]);
    busy = false;
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(daemon.status().sdk).toEqual([]);
    expect(log).toHaveBeenCalledWith(
      `sdk session ${SID.slice(0, 8)} closed after 5 min idle (it resumes on the next message)`,
    );
  });
});

describe("what a headless run's end means (outcome)", () => {
  const cases: [string, Record<string, unknown>, Record<string, unknown>][] = [
    [
      "couldn't start",
      { error: "spawn ENOENT" },
      { outcome: "failed", detail: "couldn't start Claude Code: spawn ENOENT" },
    ],
    [
      "timed out",
      { timedOut: true },
      { outcome: "failed", detail: "Claude Code was still working after 30 minutes, so it was stopped" },
    ],
    ["too big", { tooBig: true }, { outcome: "failed", detail: "Claude Code's answer was too large to read" }],
    [
      "no result, a stderr tail",
      { stdout: "", code: 1, stderr: "a\nb\nc\nd\n" },
      { outcome: "failed", detail: "Claude Code exited (code 1) without an answer: b c d" },
    ],
    [
      "no result, killed",
      { stdout: null, signal: "SIGKILL", stderr: "" },
      { outcome: "failed", detail: "Claude Code exited (SIGKILL) without an answer" },
    ],
    [
      "an error with a result",
      { stdout: JSON.stringify({ type: "result", is_error: true, result: "rate limited" }) },
      { outcome: "failed", detail: "rate limited" },
    ],
    [
      "an error with a subtype",
      { stdout: JSON.stringify({ type: "result", is_error: true, subtype: "error_max_turns" }) },
      { outcome: "failed", detail: "error_max_turns" },
    ],
    [
      "an error with nothing",
      { stdout: JSON.stringify({ type: "result", is_error: true }) },
      { outcome: "failed", detail: "Claude Code reported an error" },
    ],
    [
      "denials by name",
      {
        stdout: JSON.stringify({
          type: "result",
          result: "did it",
          permission_denials: [{ tool_name: "Bash" }, { tool_name: "Bash" }, {}],
        }),
      },
      {
        outcome: "delivered",
        reply: "did it\n\n(Not allowed on this machine, since nobody was there to approve: Bash.)",
      },
    ],
    [
      "denials without names",
      { stdout: JSON.stringify({ type: "result", result: "did it", permission_denials: [{}] }) },
      {
        outcome: "delivered",
        reply: "did it\n\n(Not allowed on this machine, since nobody was there to approve: 1 action(s).)",
      },
    ],
    [
      "no words",
      { stdout: JSON.stringify({ type: "result", result: "  " }) },
      { outcome: "delivered", reply: "(Claude Code finished without a written reply.)" },
    ],
    [
      "a session id that isn't one",
      { stdout: JSON.stringify({ type: "result", result: "ok", session_id: "nope" }) },
      { outcome: "delivered", reply: "ok", mode: "resume" },
    ],
  ];
  it.each(cases)("%s", async (_name, res, ack) => {
    transcript();
    run.mockResolvedValue({ ...result(), ...res } as never);
    const message = await rx.send({ session: `claude-code:${SID}`, text: "hi" });
    poll.mockResolvedValueOnce(Response.json({ messages: [message] }));
    await start();
    await vi.waitFor(() => expect(rx.finalAck(message.id)).toMatchObject(ack));
    expect(rx.finalAck(message.id)).not.toHaveProperty("session");
  });
  it("a start that ends badly is failed the same way", async () => {
    run.mockResolvedValue({ ...result(), stdout: "", code: 2, stderr: "boom" } as never);
    const message = await rx.send({ kind: "start", session: `claude-code:${SID}`, cwd: tmp, text: "hi" });
    poll.mockResolvedValueOnce(Response.json({ messages: [message] }));
    await start();
    await vi.waitFor(() =>
      expect(rx.finalAck(message.id)).toMatchObject({
        outcome: "failed",
        detail: "Claude Code exited (code 2) without an answer: boom",
      }),
    );
  });
});
