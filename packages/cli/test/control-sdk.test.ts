// SPDX-License-Identifier: Apache-2.0
// The `sdk` delivery mode (CONTROL.md §6) against a stand-in Agent SDK: how the SDK is
// found (beside sessionpipe, or where SESSIONPIPE_AGENT_SDK points), what a session
// is started with, and how its streaming results become replies, errors and a close.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSdk } from "../src/control/sdk.js";

type Msg = { type: string; result?: unknown; is_error?: boolean };
type Prompt = AsyncIterable<{ message: { content: string } }>;

/** What the stand-in `query` was asked for, and what it was told to do. */
const seen = vi.hoisted(() => ({ options: [] as Record<string, unknown>[], calls: [] as string[] }));

/** The stand-in SDK: one result per message, with a few words that mean trouble. */
function fakeQuery(p: { prompt: Prompt; options: Record<string, unknown> }) {
  seen.options.push(p.options);
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<Msg> {
      yield { type: "system" };
      // A result nobody asked for (an init turn of the SDK's own): nothing waits for it.
      if ((p.options.allowedTools as string[] | undefined)?.[0] === "stray") yield { type: "result", result: "stray" };
      for await (const m of p.prompt) {
        const text = m.message.content;
        if (text === "fail") yield { type: "result", result: "it broke", is_error: true };
        else if (text === "silent") yield { type: "result", result: "   " };
        else if (text === "crash") throw new Error("stream died");
        else if (text === "crash-raw") throw "raw";
        else yield { type: "result", result: `reply: ${text}` };
      }
    },
    interrupt: async () => {
      seen.calls.push("interrupt");
    },
    close: () => {
      seen.calls.push("close");
      if (p.options.throwOnClose) throw new Error("already closed");
    },
  };
}

// The package sessionpipe looks for first, when nothing names another.
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: fakeQuery }));

let tmp: string;
let sdkFile: string;
const log: string[] = [];

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "sp-sdk-"));
  mkdirSync(tmp, { recursive: true });
  sdkFile = path.join(tmp, "fake-sdk.mjs");
  // The same stand-in, as a file SESSIONPIPE_AGENT_SDK can name.
  writeFileSync(
    sdkFile,
    `const seen = globalThis.__spSdkSeen;
export function query(p) {
  seen.options.push(p.options);
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "system" };
      if (p.options.allowedTools?.[0] === "stray") yield { type: "result", result: "stray" };
      for await (const m of p.prompt) {
        const text = m.message.content;
        if (text === "fail") yield { type: "result", result: "it broke", is_error: true };
        else if (text === "silent") yield { type: "result", result: "   " };
        else if (text === "crash") throw new Error("stream died");
        else if (text === "crash-raw") throw "raw";
        else yield { type: "result", result: "reply: " + text };
      }
    },
    interrupt: async () => { seen.calls.push("interrupt"); },
    close: () => { seen.calls.push("close"); if (p.options.throwOnClose) throw new Error("already closed"); },
  };
}
`,
  );
  (globalThis as { __spSdkSeen?: typeof seen }).__spSdkSeen = seen;
  seen.options.length = 0;
  seen.calls.length = 0;
  log.length = 0;
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("loadSdk", () => {
  it("no SDK where it was told to look, or one without `query`: null, and `start` stays headless", async () => {
    expect(
      await loadSdk({
        claudeBin: null,
        env: { SESSIONPIPE_AGENT_SDK: path.join(tmp, "nope.mjs") },
        log: (s) => log.push(s),
      }),
    ).toBeNull();
    const bare = path.join(tmp, "bare.mjs");
    writeFileSync(bare, "export const version = '1';\n");
    expect(
      await loadSdk({ claudeBin: null, env: { SESSIONPIPE_AGENT_SDK: bare }, log: (s) => log.push(s) }),
    ).toBeNull();
    expect(log).toEqual([]);
  });

  it("found beside sessionpipe (no env at all): says so once, and runs with this process's env", async () => {
    const host = await loadSdk({ claudeBin: null, log: (s) => log.push(s) });
    expect(host).not.toBeNull();
    expect(log).toEqual(["Agent SDK found (@anthropic-ai/claude-agent-sdk): new sessions start in place"]);
    const s = host!.start({ session: "sid", cwd: tmp, permission: "safe" });
    expect(await s.send("hi")).toEqual({ reply: "reply: hi" });
    const o = seen.options[0]!;
    expect(o).toMatchObject({ sessionId: "sid", cwd: tmp, permissionMode: "dontAsk" });
    expect(o).not.toHaveProperty("allowedTools");
    expect(o).not.toHaveProperty("pathToClaudeCodeExecutable");
    expect((o.env as NodeJS.ProcessEnv).SESSIONPIPE_CONTROL_JOB).toBe("1");
    expect((o.env as NodeJS.ProcessEnv).PATH).toBe(process.env.PATH);
    s.close();
  });

  it("named by SESSIONPIPE_AGENT_SDK: auto mode, the receiver's MCP servers and this machine's claude", async () => {
    const env = { SESSIONPIPE_AGENT_SDK: sdkFile, HOME: tmp };
    const host = await loadSdk({ claudeBin: "/opt/claude", env, log: (s) => log.push(s) });
    expect(log[0]).toContain(sdkFile);
    const s = host!.start({ session: "sid", cwd: tmp, permission: "auto", allowedTools: ["mcp__spacesheep"] });
    expect(await s.send("go")).toEqual({ reply: "reply: go" });
    expect(seen.options[0]).toMatchObject({
      permissionMode: "auto",
      allowedTools: ["mcp__spacesheep"],
      pathToClaudeCodeExecutable: "/opt/claude",
      env: { HOME: tmp, SESSIONPIPE_CONTROL_JOB: "1" },
    });
    // An empty tool list is no list at all.
    host!.start({ session: "s2", cwd: tmp, permission: "safe", allowedTools: [] }).close();
    expect(seen.options[1]).not.toHaveProperty("allowedTools");
    expect(seen.options[1]).not.toHaveProperty("model");
    // Each level as its permissionMode, and the model when one was asked for; never bypass.
    host!.start({ session: "s3", cwd: tmp, permission: "read", model: "opus[1m]" }).close();
    host!.start({ session: "s4", cwd: tmp, permission: "edits" }).close();
    expect(seen.options[2]).toMatchObject({ permissionMode: "plan", model: "opus[1m]" });
    expect(seen.options[3]).toMatchObject({ permissionMode: "acceptEdits" });
    expect(seen.options[1]).toMatchObject({ permissionMode: "dontAsk" });
    expect(JSON.stringify(seen.options)).not.toContain("bypass");
    // Inherit: no permission mode at all, so the SDK starts in the settings' defaultMode.
    host!.start({ session: "s5", cwd: tmp, permission: "inherit" }).close();
    expect(seen.options[4]).toMatchObject({ sessionId: "s5", cwd: tmp });
    expect(seen.options[4]).not.toHaveProperty("permissionMode");
    expect(seen.options[4]).not.toHaveProperty("allowDangerouslySkipPermissions");
    s.close();
  });

  it("replies, errors and silence: each result answers the message that waited for it", async () => {
    const host = await loadSdk({ claudeBin: null, env: { SESSIONPIPE_AGENT_SDK: sdkFile }, log: () => {} });
    const s = host!.start({ session: "sid", cwd: tmp, permission: "safe" });
    const t0 = s.lastUsed;
    expect(s.busy).toBe(false);
    const a = s.send("one");
    const b = s.send("two");
    expect(s.busy).toBe(true);
    expect(await a).toEqual({ reply: "reply: one" });
    // One answered, one still waiting: still busy.
    expect(s.busy).toBe(true);
    expect(await b).toEqual({ reply: "reply: two" });
    expect(s.busy).toBe(false);
    expect(s.lastUsed).toBeGreaterThanOrEqual(t0);
    expect(await s.send("fail")).toEqual({ reply: "", error: "it broke" });
    expect(await s.send("silent")).toEqual({ reply: "(finished without a written reply)" });
    await s.interrupt();
    expect(seen.calls).toEqual(["interrupt"]);
    s.close();
    expect(seen.calls).toEqual(["interrupt", "close"]);
  });

  it("a stream that dies fails every message still waiting, in the SDK's words", async () => {
    const host = await loadSdk({ claudeBin: null, env: { SESSIONPIPE_AGENT_SDK: sdkFile }, log: () => {} });
    const s = host!.start({ session: "sid", cwd: tmp, permission: "safe" });
    const first = s.send("crash");
    const second = s.send("never read");
    expect(await first).toEqual({ reply: "", error: "stream died" });
    expect(await second).toEqual({ reply: "", error: "stream died" });
    s.close();
    // A rejection that isn't an Error is still a reason.
    const t = host!.start({ session: "sid2", cwd: tmp, permission: "safe" });
    expect(await t.send("crash-raw")).toEqual({ reply: "", error: "raw" });
    t.close();
  });

  it("close is final and never throws, even when the SDK's own close does", async () => {
    const host = await loadSdk({ claudeBin: null, env: { SESSIONPIPE_AGENT_SDK: sdkFile }, log: () => {} });
    const s = host!.start({ session: "sid", cwd: tmp, permission: "safe", allowedTools: ["mcp__x"] });
    seen.options[0]!.throwOnClose = true;
    expect(() => s.close()).not.toThrow();
    expect(seen.calls).toEqual(["close"]);
  });

  it("a result nobody asked for is let go; the next message still gets its own", async () => {
    const host = await loadSdk({ claudeBin: null, env: { SESSIONPIPE_AGENT_SDK: sdkFile }, log: () => {} });
    // The stand-in reads this tool name as its cue to answer before being asked.
    const s = host!.start({ session: "sid", cwd: tmp, permission: "safe", allowedTools: ["stray"] });
    await new Promise((r) => setTimeout(r, 20));
    expect(await s.send("after")).toEqual({ reply: "reply: after" });
    s.close();
  });
});
