// SPDX-License-Identifier: Apache-2.0
// The real control-run timer and delivery path, with control polling, updates and
// OS secret-store commands stubbed. No new hook is needed after the final refusal.
import { existsSync, mkdtempSync, rmSync, statSync, unwatchFile } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Cursors,
  type Event,
  Outbox,
  readConfig,
  type SinkConfig,
  takeLock,
  ulid,
  writeConfig,
} from "@sessionpipe/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutoUpdater } from "../src/control/autoupdate.js";
import { controlMain } from "../src/control/cli.js";
import { ControlDaemon } from "../src/control/daemon.js";
import { controlFile, writeControl } from "../src/control/store.js";
import { drain, readBackoff } from "../src/run.js";
import { type Runner, sinkAccount } from "../src/secrets.js";

const { secretCommand } = vi.hoisted(() => ({ secretCommand: vi.fn<Runner>() }));
vi.mock("../src/secrets.js", async (original) => {
  const secrets = await original<typeof import("../src/secrets.js")>();
  return { ...secrets, sinkWithSecrets: (s: SinkConfig) => secrets.sinkWithSecrets(s, secretCommand) };
});
vi.mock("../src/control/sdk.js", () => ({ loadSdk: async () => null }));

const ref = { harness: "codex", session: "finished" };
const stores = ["file", "keychain", "secret-service"] as const;
let tmp: string;
let state: string;
let outbox: Outbox;
let signals: Map<"SIGTERM" | "SIGINT", ReturnType<typeof process.listeners>>;
const post = vi.fn<typeof fetch>();

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "sp-control-drain-"));
  state = path.join(tmp, "state");
  vi.stubEnv("SESSIONPIPE_CONFIG", path.join(tmp, "config.json"));
  vi.stubEnv("SESSIONPIPE_STATE", state);
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-10-14T00:00:00Z"));
  vi.spyOn(ControlDaemon.prototype, "start").mockResolvedValue(undefined);
  vi.spyOn(AutoUpdater.prototype, "start").mockImplementation(() => {});
  signals = new Map(["SIGTERM", "SIGINT"].map((sig) => [sig as "SIGTERM" | "SIGINT", process.listeners(sig)]));
  post.mockReset().mockResolvedValue(new Response("{}", { status: 202 }));
  vi.stubGlobal("fetch", post);
  secretCommand
    .mockReset()
    .mockImplementation((_cmd, args) =>
      args.includes(sinkAccount("s")) ? { status: 0, stdout: "test-token\n" } : { status: 1, stdout: "" },
    );
  writeControl({
    name: "test-machine",
    mode: "safe",
    folders: [tmp],
    receivers: [
      {
        url: "https://receiver.test",
        control: "https://receiver.test/control",
        rpId: "receiver.test",
        machine: "m",
        token: "control-token",
        keys: [],
        paired_at: new Date().toISOString(),
      },
    ],
  });
  outbox = new Outbox(state);
  const event: Event = {
    protocol: 1,
    id: ulid(),
    type: "session.ended",
    time: new Date().toISOString(),
    tier: 3,
    harness: { name: ref.harness },
    session: { id: ref.session, seq: 0 },
    privacy: { rulesets: [], pii: false },
    data: { reason: "other" },
  };
  outbox.append(ref, [event]);
});

afterEach(() => {
  unwatchFile(controlFile());
  for (const [sig, before] of signals)
    for (const listener of process.listeners(sig)) if (!before.includes(listener)) process.off(sig, listener);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

function configure(store: (typeof stores)[number], paused?: string): void {
  writeConfig({
    sinks: [
      {
        name: "s",
        url: "https://receiver.test",
        tier: 3,
        ...(store === "file" ? { token: "test-token" } : { token_in: store }),
        ...(paused ? { paused } : {}),
      },
    ],
    harnesses: {},
  });
}

const pending = () => {
  const cursors = new Cursors(state, "s");
  return outbox.read(ref, cursors.read()[cursors.key(ref)] ?? 0).events;
};
const start = () => controlMain(["control", "run"], () => {}, tmp);

describe("the control daemon's once-a-minute drain", () => {
  it.each(stores)(
    "retries a %s-token sink's final 429 after the wait, once and outside the session lock",
    async (store) => {
      configure(store);
      const sinks = readConfig().sinks;
      post.mockResolvedValueOnce(new Response("{}", { status: 429, headers: { "retry-after": "120" } }));
      // The last delivery attempt fails. Nothing appends or runs another hook after this.
      expect(await drain(state, sinks, outbox)).toEqual({ s: 0 });
      expect(readBackoff(state, "s")?.until).toBe(Date.now() + 120_000);
      expect(pending()).toHaveLength(1);
      await start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(post).toHaveBeenCalledTimes(1);
      expect(pending()).toHaveLength(1);

      let accept!: (response: Response) => void;
      post.mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            accept = resolve;
          }),
      );
      await vi.advanceTimersByTimeAsync(60_000);
      expect(post).toHaveBeenCalledTimes(2);
      expect(pending()).toHaveLength(1); // The cursor cannot move before the 202.
      const release = takeLock(state, ref);
      expect(release).not.toBeNull(); // The POST holds no session lock.
      release?.();
      // A competing worker must leave delivery to the daemon already in the POST.
      expect(await drain(state, sinks, outbox)).toBeNull();
      expect(post).toHaveBeenCalledTimes(2);
      accept(new Response("{}", { status: 202 }));
      await vi.advanceTimersByTimeAsync(0);
      expect(pending()).toEqual([]);
      const cursors = new Cursors(state, "s");
      expect(cursors.read()[cursors.key(ref)]).toBe(statSync(outbox.file(ref)).size);
      expect(readBackoff(state, "s")).toBeNull();
      expect(existsSync(path.join(state, "locks", "flush.lock"))).toBe(false);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(post).toHaveBeenCalledTimes(2);
      for (const [url, init] of post.mock.calls) {
        expect(url).toBe("https://receiver.test/api/sessionpipe/v1/events");
        expect(init?.method).toBe("POST");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-token");
      }
      expect(post.mock.calls[1]?.[1]?.body).toBe(post.mock.calls[0]?.[1]?.body);
      if (store === "file") expect(secretCommand).not.toHaveBeenCalled();
      else expect(secretCommand).toHaveBeenCalled();
    },
  );

  it.each(stores)("skips a paused %s-token sink, then observes it being unpaused", async (store) => {
    configure(store, "paused by user");
    await start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(post).not.toHaveBeenCalled();
    expect(secretCommand).not.toHaveBeenCalled();
    expect(pending()).toHaveLength(1);
    configure(store);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(post).toHaveBeenCalledTimes(1);
    expect(pending()).toEqual([]);
  });

  it.each(["keychain", "secret-service"] as const)(
    "leaves a locked %s sink pending until its token can be read",
    async (store) => {
      configure(store);
      secretCommand.mockReturnValue({ status: 1, stdout: "" });
      await start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(post).not.toHaveBeenCalled();
      expect(pending()).toHaveLength(1);
      secretCommand.mockImplementation((_cmd, args) =>
        args.includes(sinkAccount("s")) ? { status: 0, stdout: "test-token\n" } : { status: 1, stdout: "" },
      );
      await vi.advanceTimersByTimeAsync(60_000);
      expect(post).toHaveBeenCalledTimes(1);
      expect(new Headers(post.mock.calls[0]?.[1]?.headers).get("authorization")).toBe("Bearer test-token");
      expect(pending()).toEqual([]);
    },
  );

  it.each(["keychain", "secret-service"] as const)(
    "delivers a %s sink whose store holds a signing secret and no token (sink add --secret), signed and without a bearer",
    async (store) => {
      configure(store);
      secretCommand.mockImplementation((_cmd, args) =>
        args.includes(sinkAccount("s", "secret"))
          ? { status: 0, stdout: "whsec_c2VjcmV0\n" }
          : { status: 1, stdout: "" },
      );
      await start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(post).toHaveBeenCalledTimes(1);
      const headers = new Headers(post.mock.calls[0]?.[1]?.headers);
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("webhook-signature")).toMatch(/^v1,/);
      expect(pending()).toEqual([]);
    },
  );
});
