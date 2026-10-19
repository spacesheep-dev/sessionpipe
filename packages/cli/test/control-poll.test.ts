// SPDX-License-Identifier: Apache-2.0
// Fake time and HTTP handlers only: the existing receiver signs the messages,
// but never listens on TCP. The daemon uses its real local IPC socket.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DayKey, Passkey } from "../../core/test/helpers/authenticator.js";
import { ControlDaemon, type DaemonDeps } from "../src/control/daemon.js";
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
      rx.acks.push(...JSON.parse(String(init?.body)).acks);
      return new Response(null, { status: 202 });
    }
    expect(u.pathname).toBe("/control");
    return poll(url, init);
  };
  daemon = new ControlDaemon(
    config,
    path.join(tmp, "control"),
    process.platform === "win32" ? `\\\\.\\pipe\\${path.basename(tmp)}` : path.join(tmp, "control.sock"),
    {
      now: Date.now,
      fetch,
      log,
      claudeDirs: () => [],
      accounts: () => [],
      claude: () => ({
        bin: "fake-claude",
        caps: { hasMode: true, modes: ["dontAsk"], promptsNone: false, fork: true },
      }),
      run,
    },
  );
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
