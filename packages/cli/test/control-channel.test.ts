// SPDX-License-Identifier: Apache-2.0
// `sessionpipe channel` (CONTROL.md §8): the waiter as a Claude Code channel. What it
// answers over MCP, what a message becomes, when it parks on the daemon's socket and
// parks again, and how it ends.
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  answer,
  CHANNEL_INSTRUCTIONS,
  namedAsChannel,
  notification,
  parentArgv,
  runChannel,
} from "../src/control/channel.js";
import { channelIo, channelMain } from "../src/control/cli.js";
import type { LocalReply, LocalRequest } from "../src/control/local.js";
import { frame, unframe } from "../src/control/route.js";

const SESSION = "claude-code:8c132906-8c3f-4814-870a-afc3d05e1d2e";
const unix = process.platform !== "win32";

describe("unframe", () => {
  it("undoes frame: the person's words and the host; other text comes back whole", () => {
    expect(unframe(frame("yes, correct it", "https://spacesheep.dev"))).toEqual({
      text: "yes, correct it",
      via: "spacesheep.dev",
    });
    expect(unframe(frame("two\n\nparagraphs", "receiver.example"))).toEqual({
      text: "two\n\nparagraphs",
      via: "receiver.example",
    });
    expect(unframe("typed by hand")).toEqual({ text: "typed by hand", via: null });
  });
});

describe("answer", () => {
  it("initialize says it is a channel, with its instructions, in the revision the client asked for", () => {
    const r = answer(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } },
      "9.9.9",
    );
    expect(r).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { experimental: { "claude/channel": {} }, tools: {} },
        serverInfo: { name: "sessionpipe", version: "9.9.9" },
        instructions: CHANNEL_INSTRUCTIONS,
      },
    });
    expect(CHANNEL_INSTRUCTIONS).toContain("sent back to them automatically");
    const bare = answer({ id: "a", method: "initialize" }, "1") as { result: { protocolVersion: string } };
    expect(bare.result.protocolVersion).toBe("2025-06-18");
  });
  it("ping and the empty tool list are answered; another request is not found", () => {
    expect(answer({ id: 2, method: "ping" }, "1")).toEqual({ jsonrpc: "2.0", id: 2, result: {} });
    expect(answer({ id: 3, method: "tools/list" }, "1")).toEqual({ jsonrpc: "2.0", id: 3, result: { tools: [] } });
    expect(answer({ id: 4, method: "tools/call" }, "1")).toEqual({
      jsonrpc: "2.0",
      id: 4,
      error: { code: -32601, message: "method not found: tools/call" },
    });
  });
  it("a notification, a reply, or a line that isn't a request gets nothing", () => {
    expect(answer({ method: "notifications/initialized" }, "1")).toBeNull();
    expect(answer({ id: null, method: "ping" }, "1")).toBeNull();
    expect(answer({ id: 5, result: {} }, "1")).toBeNull();
    expect(answer(null, "1")).toBeNull();
    expect(answer("ping", "1")).toBeNull();
  });
});

describe("notification", () => {
  it("the person's words are the content; the host and the message's id ride on the tag", () => {
    expect(notification(frame("yes, correct it", "https://spacesheep.dev"), "01K")).toEqual({
      jsonrpc: "2.0",
      method: "notifications/claude/channel",
      params: { content: "yes, correct it", meta: { via: "spacesheep.dev", message_id: "01K" } },
    });
    expect(notification("unframed", "01L")).toEqual({
      jsonrpc: "2.0",
      method: "notifications/claude/channel",
      params: { content: "unframed", meta: { message_id: "01L" } },
    });
  });
});

/** A channel on a pipe, with a scripted daemon: each wait gets the next reply in turn
 *  (a reply that is a promise is one the test resolves itself). */
function harness(replies: (LocalReply | null | Promise<LocalReply | null>)[], retryMs = 5) {
  const input = new PassThrough();
  const out: Record<string, unknown>[] = [];
  const calls: { sock: string; req: LocalRequest }[] = [];
  let n = 0;
  const ask = vi.fn(async (sock: string, req: LocalRequest) => {
    calls.push({ sock, req });
    const r = replies[n++];
    // Past the script: a wait that never ends, as a quiet daemon's.
    return r === undefined ? new Promise<LocalReply | null>(() => {}) : r;
  });
  const done = runChannel(SESSION, input, (line) => out.push(JSON.parse(line)), {
    version: "9.9.9",
    env: { SESSIONPIPE_SOCKET: "/tmp/sp-test.sock" },
    registered: () => true,
    retryMs,
    ask,
  });
  const say = (m: unknown) => input.write(`${typeof m === "string" ? m : JSON.stringify(m)}\n`);
  return { input, out, calls, ask, done, say };
}
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe("runChannel", () => {
  it("answers Claude Code and parks only once it is initialized; each message is a notification, then it parks again", async () => {
    const h = harness([{ op: "message", text: frame("yes, correct it", "https://spacesheep.dev"), id: "01K" }]);
    h.say({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    await settle();
    expect(h.calls).toEqual([]);
    expect(h.out[0]).toMatchObject({ id: 0, result: { capabilities: { experimental: { "claude/channel": {} } } } });
    h.say({ jsonrpc: "2.0", method: "notifications/initialized" });
    await settle();
    expect(h.calls[0]).toEqual({
      sock: "/tmp/sp-test.sock",
      req: { op: "wait", session: SESSION, pid: process.pid, channel: true },
    });
    expect(h.out[1]).toEqual({
      jsonrpc: "2.0",
      method: "notifications/claude/channel",
      params: { content: "yes, correct it", meta: { via: "spacesheep.dev", message_id: "01K" } },
    });
    // Parked again at once, for the next message.
    expect(h.calls).toHaveLength(2);
    h.input.end();
    await h.done;
  });

  it("a daemon away or a wait that took over: it parks again after a pause; a second initialized starts nothing", async () => {
    const h = harness([null, { op: "replaced" }, { op: "none" }]);
    h.say({ method: "notifications/initialized" });
    h.say({ method: "notifications/initialized" });
    h.say("not json");
    h.say({ id: 9, method: "ping" });
    await settle(60);
    expect(h.calls).toHaveLength(4);
    expect(h.out).toEqual([{ jsonrpc: "2.0", id: 9, result: {} }]);
    h.input.end();
    await h.done;
  });

  it("closed by Claude Code: a message the daemon hands over afterwards is not written", async () => {
    let hand: (r: LocalReply) => void = () => {};
    const h = harness([new Promise<LocalReply>((r) => (hand = r))]);
    h.say({ method: "notifications/initialized" });
    await settle();
    h.input.end();
    await h.done;
    hand({ op: "message", text: "late", id: "01Z" });
    await settle();
    expect(h.out).toEqual([]);
    expect(h.calls).toHaveLength(1);
  });

  it("a session that didn't take it as a channel: it answers Claude Code but never parks, and says why", async () => {
    const input = new PassThrough();
    const ask = vi.fn(async () => null);
    const logs: string[] = [];
    const quiet = runChannel(SESSION, input, () => {}, {
      version: "1",
      registered: () => false,
      ask,
      log: (l) => logs.push(l),
    });
    input.write('{"method":"notifications/initialized"}\n');
    await settle();
    expect(ask).not.toHaveBeenCalled();
    expect(logs.join("")).toContain("didn't take it as a channel");
    input.end();
    await quiet;
    // With no log to say it to, it is just as quiet.
    const again = new PassThrough();
    const silent = runChannel(SESSION, again, () => {}, { version: "1", registered: () => false, ask });
    again.write('{"method":"notifications/initialized"}\n');
    again.end();
    await silent;
    expect(ask).not.toHaveBeenCalled();
  });

  it("left to itself it parks again after a second", async () => {
    const input = new PassThrough();
    const ask = vi.fn(async () => null);
    const done = runChannel(SESSION, input, () => {}, { version: "1", env: {}, registered: () => true, ask });
    input.write('{"method":"notifications/initialized"}\n');
    await settle(1100);
    expect(ask.mock.calls.length).toBe(2);
    input.end();
    await done;
  });
});

describe.runIf(unix)("runChannel on a real socket", () => {
  let tmp: string;
  let server: net.Server | null = null;
  const conns: net.Socket[] = [];
  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "sp-channel-"));
  });
  afterEach(async () => {
    // The channel parks again after each message: that wait is still open.
    for (const c of conns.splice(0)) c.destroy();
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = null;
    rmSync(tmp, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("parks on the daemon's socket from the environment and hands its message to the session", async () => {
    const sock = path.join(tmp, "control.sock");
    const seen: LocalRequest[] = [];
    server = net.createServer((s) => {
      conns.push(s);
      s.once("data", (d) => {
        seen.push(JSON.parse(d.toString("utf8").split("\n")[0]!) as LocalRequest);
        if (seen.length === 1) s.end(`${JSON.stringify({ op: "message", text: "hi", id: "01K" })}\n`);
      });
    });
    await new Promise<void>((r) => server!.listen(sock, r));
    vi.stubEnv("SESSIONPIPE_SOCKET", sock);
    const input = new PassThrough();
    const out: string[] = [];
    const done = runChannel(SESSION, input, (l) => out.push(l), { version: "1", registered: () => true });
    input.write('{"method":"notifications/initialized"}\n');
    await settle(150);
    expect(seen[0]).toEqual({ op: "wait", session: SESSION, pid: process.pid, channel: true });
    expect(JSON.parse(out[0]!)).toMatchObject({ params: { content: "hi", meta: { message_id: "01K" } } });
    input.end();
    await done;
  });
});

describe("namedAsChannel", () => {
  const claude = (...a: string[]) => ["/Users/x/.local/bin/claude", "--model", "claude-haiku-5-5", ...a];
  it("named after either flag, as a server or as a plugin, in a list or after =", () => {
    expect(namedAsChannel(claude("--dangerously-load-development-channels", "server:sessionpipe"), "sessionpipe")).toBe(
      true,
    );
    expect(namedAsChannel(claude("--channels", "plugin:telegram@official", "server:sessionpipe"), "sessionpipe")).toBe(
      true,
    );
    expect(namedAsChannel(claude("--channels", "plugin:sessionpipe@spacesheep"), "sessionpipe")).toBe(true);
    expect(namedAsChannel(claude("--channels=server:sessionpipe"), "sessionpipe")).toBe(true);
    expect(namedAsChannel(claude("--channels", "server:sp"), "sp")).toBe(true);
  });
  it("not named: no flag, another server, the name outside the list, or a list that ended", () => {
    expect(namedAsChannel(claude(), "sessionpipe")).toBe(false);
    expect(namedAsChannel(claude("--channels", "plugin:telegram@official"), "sessionpipe")).toBe(false);
    expect(namedAsChannel(claude("--channels=server:other"), "sessionpipe")).toBe(false);
    expect(namedAsChannel(claude("--channels", "server:other", "--print", "server:sessionpipe"), "sessionpipe")).toBe(
      false,
    );
    expect(namedAsChannel(claude("server:sessionpipe"), "sessionpipe")).toBe(false);
    expect(namedAsChannel(claude("--channels", "server:sessionpipe-two"), "sessionpipe")).toBe(false);
  });
  it("not in a session that isn't interactive, named or not: Claude Code takes no channel there", () => {
    // A claude.ai worker's command line (2.1.314), and the other ways to run headless.
    const dev = ["--dangerously-load-development-channels", "server:sessionpipe"];
    expect(namedAsChannel(claude("--print", "--sdk-url", "wss://x", ...dev), "sessionpipe")).toBe(false);
    expect(namedAsChannel(claude("-p", ...dev), "sessionpipe")).toBe(false);
    expect(namedAsChannel(claude("--input-format=stream-json", ...dev), "sessionpipe")).toBe(false);
    expect(namedAsChannel(claude(...dev, "--output-format", "stream-json"), "sessionpipe")).toBe(false);
  });
});

describe.runIf(unix)("parentArgv", () => {
  it("reads the parent's command line, word by word; a process that isn't there has none", () => {
    expect(parentArgv().length).toBeGreaterThan(0);
    expect(parentArgv(process.pid).some((w) => /node|vitest/.test(w))).toBe(true);
    expect(parentArgv(2 ** 22 + 12345)).toEqual([]);
  });
});

describe("channelMain", () => {
  afterEach(() => vi.unstubAllEnvs());
  const io = (input = new PassThrough()) => {
    const err: string[] = [];
    const exits: number[] = [];
    return {
      input: () => input,
      write: vi.fn(),
      err: (s: string) => void err.push(s),
      exit: (c: number) => void exits.push(c),
      errs: err,
      exits,
    };
  };
  it("needs a session: it says so on stderr and exits 2", async () => {
    vi.stubEnv("CLAUDE_CODE_SESSION_ID", "");
    vi.stubEnv("CODEX_SESSION_ID", "");
    const o = io();
    await channelMain(["channel"], o);
    expect(o.errs.join("")).toContain("CLAUDE_CODE_SESSION_ID");
    expect(o.exits).toEqual([2]);
    expect(o.write).not.toHaveBeenCalled();
  });
  it("serves the session it was given until Claude Code closes it, then exits 0", async () => {
    const input = new PassThrough();
    const o = io(input);
    const parent = vi.fn(() => ["claude", "--dangerously-load-development-channels", "server:sessionpipe"]);
    const run = channelMain(["channel", "--session", SESSION], o, parent);
    input.write('{"id":1,"method":"ping"}\n');
    await settle();
    expect(o.write).toHaveBeenCalledWith('{"jsonrpc":"2.0","id":1,"result":{}}\n');
    input.end();
    await run;
    expect(o.exits).toEqual([0]);
  });
  it("--name is the name the session's list uses; unnamed there, it says so on stderr and doesn't park", async () => {
    for (const [argv, named] of [
      [["channel", "--session", SESSION, "--name", "sp"], true],
      [["channel", "--session", SESSION, "--name"], false],
      [["channel", "--session", SESSION], false],
    ] as const) {
      const input = new PassThrough();
      const o = io(input);
      const run = channelMain([...argv], o, () => ["claude", "--channels", "server:sp"]);
      input.write('{"method":"notifications/initialized"}\n');
      await settle();
      expect(o.errs.join("").includes("didn't take it as a channel")).toBe(!named);
      input.end();
      await run;
    }
  });
  it("the real process: stdin in, stdout for MCP, stderr for the person, a real exit", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      expect(channelIo.input()).toBe(process.stdin);
      channelIo.write("a");
      channelIo.err("b");
      channelIo.exit(3);
      expect(out).toHaveBeenCalledWith("a");
      expect(err).toHaveBeenCalledWith("b");
      expect(exit).toHaveBeenCalledWith(3);
    } finally {
      out.mockRestore();
      err.mockRestore();
      exit.mockRestore();
    }
  });
});
