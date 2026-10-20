// SPDX-License-Identifier: Apache-2.0
// `sessionpipe wait` (CONTROL.md §8) and the local socket it blocks on: which session
// it waits for, how it reconnects in silence when the daemon is away, what it prints,
// and how `ask` treats a reply it can't read.
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ask, type LocalRequest, socketPath } from "../src/control/local.js";
import { RE_ARM, waitForMessage, waitSession } from "../src/control/wait.js";

const SESSION = "claude-code:8c132906-8c3f-4814-870a-afc3d05e1d2e";
const unix = process.platform !== "win32";

describe("waitSession", () => {
  it("takes --session when it is a well-formed <harness>:<id>, else nothing", () => {
    expect(waitSession(SESSION, {})).toBe(SESSION);
    expect(waitSession("claude-code:not-a-uuid", {})).toBeNull();
    expect(waitSession("nocolon", {})).toBeNull();
  });
  it("without the flag, the harness's own env names the session", () => {
    const id = "8c132906-8c3f-4814-870a-afc3d05e1d2e";
    expect(waitSession(undefined, { CLAUDE_CODE_SESSION_ID: id })).toBe(`claude-code:${id}`);
    expect(waitSession(undefined, { CODEX_SESSION_ID: "thread-1" })).toBe("codex:thread-1");
    expect(waitSession(undefined, {})).toBeNull();
  });
  it("reads process.env by default", () => {
    const had = process.env.CLAUDE_CODE_SESSION_ID;
    process.env.CLAUDE_CODE_SESSION_ID = "0b6f2c7e-3d4a-4f1b-9c8e-2a1d5e6f7a8b";
    try {
      expect(waitSession(undefined)).toBe("claude-code:0b6f2c7e-3d4a-4f1b-9c8e-2a1d5e6f7a8b");
    } finally {
      if (had === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
      else process.env.CLAUDE_CODE_SESSION_ID = had;
    }
  });
});

describe("socketPath", () => {
  it("SESSIONPIPE_SOCKET wins; otherwise the state dir's control.sock, or a per-user pipe on Windows", () => {
    expect(socketPath("/state", { SESSIONPIPE_SOCKET: "/x/s.sock" })).toBe("/x/s.sock");
    const real = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
    try {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      expect(socketPath("/state", {})).toBe(path.join("/state", "control.sock"));
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      expect(socketPath("/state", {})).toBe(`\\\\.\\pipe\\sessionpipe-control-${os.userInfo().username}`);
    } finally {
      Object.defineProperty(process, "platform", real);
    }
  });
});

describe.runIf(unix)("on the socket", () => {
  let tmp: string;
  let sock: string;
  let server: net.Server | null = null;
  /** A stand-in daemon: one scripted answer per connection, in order. */
  const serve = (answers: ((s: net.Socket, req: LocalRequest) => void)[]) =>
    new Promise<void>((r) => {
      let n = 0;
      server = net.createServer((s) => {
        s.once("data", (d) => {
          const line = d.toString("utf8").split("\n")[0]!;
          answers[Math.min(n++, answers.length - 1)]!(s, JSON.parse(line) as LocalRequest);
        });
      });
      server.listen(sock, r);
    });

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "sp-wait-"));
    sock = path.join(tmp, "control.sock");
  });
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = null;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("prints the framed message with the re-arm note, after waiting out a daemon that was away", async () => {
    // First connection: the daemon drops it (a restart); the waiter tries again later.
    await serve([
      (s) => s.destroy(),
      (s, req) => {
        expect(req).toMatchObject({ op: "wait", session: SESSION, pid: process.pid });
        s.end(`${JSON.stringify({ op: "message", text: "hello from the phone", id: "01K" })}\n`);
      },
    ]);
    const text = await waitForMessage(SESSION, { env: { SESSIONPIPE_SOCKET: sock }, retryMs: 20 });
    expect(text).toBe(`hello from the phone\n\n${RE_ARM}`);
    expect(RE_ARM).toContain("start `sessionpipe wait` again");
  });

  it("a newer waiter took over: this one says so and stops", async () => {
    await serve([(s) => s.end(`${JSON.stringify({ op: "replaced" })}\n`)]);
    expect(await waitForMessage(SESSION, { env: { SESSIONPIPE_SOCKET: sock }, retryMs: 20 })).toContain(
      "took over; this one stopped",
    );
  });

  it("left to itself it tries again after a second", async () => {
    await serve([(s) => s.destroy(), (s) => s.end(`${JSON.stringify({ op: "replaced" })}\n`)]);
    const t0 = Date.now();
    await waitForMessage(SESSION, { env: { SESSIONPIPE_SOCKET: sock } });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(990);
  });

  it("ask: a reply arrives in pieces; one that isn't JSON is nothing", async () => {
    await serve([
      (s) => {
        s.write('{"op":"o');
        setTimeout(() => s.end('k"}\n'), 30);
      },
      (s) => s.end("not json\n"),
    ]);
    expect(await ask(sock, { op: "status" }, 2000)).toEqual({ op: "ok" });
    expect(await ask(sock, { op: "status" }, 2000)).toBeNull();
  });
});
