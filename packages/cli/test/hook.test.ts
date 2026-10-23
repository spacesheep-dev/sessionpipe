// SPDX-License-Identifier: Apache-2.0
// The hook path in-process (launcher.test.ts and the bench spawn the real binary):
// every branch of hook.ts under a temp SESSIONPIPE_STATE, the worker spawn mocked,
// the control daemon played by a small node:net server.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AG_STALE_PRETOOL } from "@sessionpipe/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawned = vi.hoisted(() => ({ spawn: vi.fn(), unref: vi.fn() }));
vi.mock("node:child_process", async (orig) => ({
  ...(await orig<typeof import("node:child_process")>()),
  spawn: (...a: unknown[]) => {
    spawned.spawn(...a);
    return { unref: spawned.unref };
  },
}));

import { hookMain } from "../src/hook.js";

const here = path.dirname(fileURLToPath(import.meta.url));
let state: string;
let config: string;
let out: string[];
let base: NodeJS.ProcessEnv;
beforeEach(() => {
  state = mkdtempSync(path.join(os.tmpdir(), "sp-hook-"));
  config = path.join(state, "config.json");
  out = [];
  base = { SESSIONPIPE_STATE: state, SESSIONPIPE_CONFIG: config };
  spawned.spawn.mockClear();
  spawned.unref.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(state, { recursive: true, force: true });
});

type Job = { harness: string; event: string; argv: string[]; stdin: string; env: Record<string, string> };
const jobs = (): Job[] => {
  const dir = path.join(state, "jobs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")) as Job);
};
const timing = (): Record<string, unknown>[] =>
  readFileSync(path.join(state, "timing.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
const io = (
  stdin: string | Buffer | (() => Buffer) = "{}",
  stdout: (t: string) => void = (t) => {
    out.push(t);
  },
) => ({
  stdin: typeof stdin === "function" ? stdin : () => Buffer.from(stdin),
  stdout,
});
const run = (
  argv: string[],
  stdin?: string | Buffer | (() => Buffer),
  env: NodeJS.ProcessEnv = {},
  stdout?: (t: string) => void,
) => hookMain(argv, { ...base, ...env }, io(stdin, stdout));
// A Claude Code session id is a UUID: the control wait refuses a payload with any other
// shape and no transcript_path (another harness running our settings.json entry).
const SID = "0b4a6e3c-1d2f-4a5b-8c6d-7e8f9a0b1c2d";
const claude = (extra: Record<string, unknown> = {}) => JSON.stringify({ session_id: SID, ...extra });

/** Run `f` with process.platform reported as `p`; the real value is put back after. */
async function onPlatform<T>(p: NodeJS.Platform, f: () => Promise<T>): Promise<T> {
  const real = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
  Object.defineProperty(process, "platform", { value: p, configurable: true });
  try {
    return await f();
  } finally {
    Object.defineProperty(process, "platform", real);
  }
}

/** A stand-in daemon on `sock`: answers every request with `reply`, keeps what it was asked. */
async function daemon(sock: string, reply: (req: Record<string, unknown>) => unknown) {
  const asked: Record<string, unknown>[] = [];
  const server = net.createServer((c) =>
    c.once("data", (d) => {
      const req = JSON.parse(d.toString("utf8").split("\n")[0] as string) as Record<string, unknown>;
      asked.push(req);
      c.end(`${JSON.stringify(reply(req))}\n`);
    }),
  );
  await new Promise<void>((r) => server.listen(sock, () => r()));
  return { asked, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe("the hook writes one job and spawns the worker", () => {
  it("the job carries argv, stdin, the six env keys and nothing else; the worker is detached", async () => {
    const env = {
      CLAUDE_CODE_HOST_SESSION_ID: "host-1",
      CLAUDE_CONFIG_DIR: "/c",
      CLAUDE_PROJECT_DIR: "/p",
      CODEX_HOME: "/x",
      GEMINI_CLI_HOME: "/g",
      SESSIONPIPE_LAUNCHED_BY: "claude-code:ed6c7665-589f-40c7-b7b4-e38ee662b7bc",
      HOME: "/not/copied",
    };
    await run(["claude-code", "UserPromptSubmit", "extra"], claude({ prompt: "hi" }), env);
    const [job] = jobs();
    expect(job).toMatchObject({
      harness: "claude-code",
      event: "UserPromptSubmit",
      argv: ["claude-code", "UserPromptSubmit", "extra"],
      stdin: claude({ prompt: "hi" }),
      env: expect.not.objectContaining({ HOME: "/not/copied" }),
      cwd: process.cwd(),
      ppid: process.ppid,
    });
    expect(Object.keys(job?.env ?? {})).toHaveLength(6);
    const jobFile = path.join(state, "jobs", readdirSync(path.join(state, "jobs"))[0] as string);
    expect(spawned.spawn).toHaveBeenCalledWith(process.execPath, [path.resolve(here, "../src/worker.js"), jobFile], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: expect.objectContaining(env),
    });
    expect(spawned.unref).toHaveBeenCalledTimes(1);
    expect(out).toEqual([]);
    expect(timing()).toEqual([
      expect.objectContaining({ harness: "claude-code", event: "UserPromptSubmit", spawned: true }),
    ]);
    expect(timing()[0]).not.toHaveProperty("control_wait_ms");
  });

  it("stdin is read once and capped at 1 MiB", async () => {
    const big = Buffer.alloc(2 * 1024 * 1024, "x");
    await run(["claude-code", "UserPromptSubmit"], big);
    expect(jobs()[0]?.stdin).toHaveLength(1024 * 1024);
  });

  it("a stdin that cannot be read is an empty one", async () => {
    await run(["claude-code", "UserPromptSubmit"], () => {
      throw new Error("EAGAIN");
    });
    expect(jobs()[0]?.stdin).toBe("");
    expect(timing()[0]).toMatchObject({ spawned: true });
  });

  it("Codex notify reads no stdin at all (Codex gives none; the payload is in argv)", async () => {
    const stdin = vi.fn(() => Buffer.from("{}"));
    await run(["codex", "notify", '{"type":"agent-turn-complete","thread-id":"t1"}'], stdin);
    expect(stdin).not.toHaveBeenCalled();
    expect(jobs()[0]).toMatchObject({
      stdin: "",
      argv: ["codex", "notify", '{"type":"agent-turn-complete","thread-id":"t1"}'],
    });
  });

  it("SESSIONPIPE_NO_WORKER writes the job and starts nothing", async () => {
    await run(["claude-code", "UserPromptSubmit"], claude(), { SESSIONPIPE_NO_WORKER: "1" });
    expect(jobs()).toHaveLength(1);
    expect(spawned.spawn).not.toHaveBeenCalled();
    expect(timing()[0]).toMatchObject({ spawned: true });
  });

  it("without a harness and event nothing is written but the timing line", async () => {
    await run(["claude-code"]);
    expect(jobs()).toEqual([]);
    expect(timing()).toEqual([expect.objectContaining({ harness: "claude-code", event: "", spawned: false })]);
  });

  it("an internal error ends the hook quietly, even when the timing line can't be written", async () => {
    const file = path.join(state, "a-file");
    writeFileSync(file, "");
    await expect(
      run(["claude-code", "UserPromptSubmit"], claude(), { SESSIONPIPE_STATE: file }),
    ).resolves.toBeUndefined();
    expect(existsSync(path.join(file, "timing.jsonl"))).toBe(false);
    expect(spawned.spawn).not.toHaveBeenCalled();
  });
});

describe("the heartbeat throttle: a tool event is a job once a minute when no sink takes tier ≥ 1", () => {
  const tool = (extra: Record<string, unknown> = {}) => run(["claude-code", "PostToolUse"], claude(extra));

  it("the first tool event of a session goes, the next within a minute does not, an old stamp lets one through", async () => {
    await tool();
    expect(jobs()).toHaveLength(1);
    await tool();
    expect(jobs()).toHaveLength(1);
    expect(timing().map((t) => t.spawned)).toEqual([true, false]);
    const stamp = path.join(state, "beats", `claude-code-${SID}`);
    expect(existsSync(stamp)).toBe(true);
    const old = new Date(Date.now() - 2 * 60_000);
    utimesSync(stamp, old, old);
    await tool();
    expect(jobs()).toHaveLength(2);
  });

  it("session ids are read from any harness's key and made safe for a file name", async () => {
    await run(["antigravity", "PostInvocation"], JSON.stringify({ conversationId: "a/b c" }));
    expect(readdirSync(path.join(state, "beats"))).toEqual(["antigravity-a_b_c"]);
    await run(["gemini-cli", "AfterTool"], JSON.stringify({ sessionId: "g1" }));
    expect(readdirSync(path.join(state, "beats")).sort()).toEqual(["antigravity-a_b_c", "gemini-cli-g1"]);
  });

  it("a tool event without a session id is nothing", async () => {
    await run(["claude-code", "PreToolUse"], JSON.stringify({ tool_name: "Bash" }));
    expect(jobs()).toEqual([]);
    expect(timing()[0]).toMatchObject({ spawned: false });
  });

  it("a sink at tier ≥ 1 wants every tool event; a paused one, or none, does not", async () => {
    writeFileSync(config, JSON.stringify({ sinks: [{ name: "a", url: "stdout", tier: 1 }] }));
    await tool();
    await tool();
    expect(jobs()).toHaveLength(2);
    writeFileSync(config, JSON.stringify({ sinks: [{ name: "a", url: "stdout", tier: 1, paused: "2026-10-20" }] }));
    await tool();
    expect(jobs()).toHaveLength(3); // the first beat of the session
    await tool();
    expect(jobs()).toHaveLength(3);
    writeFileSync(config, "{}");
    await tool();
    expect(jobs()).toHaveLength(3);
    writeFileSync(config, "not json");
    await tool();
    expect(jobs()).toHaveLength(3);
  });

  it("a stamp that cannot be written still lets the beat through", async () => {
    writeFileSync(path.join(state, "beats"), "");
    await tool();
    await tool();
    expect(jobs()).toHaveLength(2);
  });
});

describe("Antigravity reads stdout", () => {
  it("`{}` to what sessionpipe hooks, an ask to a leftover PreToolUse", async () => {
    const stdin = JSON.stringify({ conversationId: "c1", toolCall: { name: "run_command" } });
    await run(["antigravity", "PostInvocation"], stdin);
    expect(out).toEqual(["{}\n"]);
    out.length = 0;
    await run(["antigravity", "PreToolUse"], stdin);
    expect(out).toEqual([AG_STALE_PRETOOL]);
    expect(jobs()).toHaveLength(1); // the second tool event of the minute is only a beat
  });

  it("a stdout that is closed does not stop the job", async () => {
    await run(["antigravity", "Stop"], JSON.stringify({ conversationId: "c1" }), {}, () => {
      throw new Error("EPIPE");
    });
    expect(jobs()).toHaveLength(1);
    expect(timing()[0]).toMatchObject({ spawned: true });
  });
});

// A Unix socket: Windows has none, and the hook there looks for control.json instead (below).
describe.runIf(process.platform !== "win32")("control: the Stop hook asks the daemon for a queued message", () => {
  let sock: string;
  beforeEach(() => {
    sock = path.join(state, "control.sock");
  });

  it("no daemon socket: nothing asked, the job goes as usual", async () => {
    await run(["claude-code", "Stop"], claude());
    expect(out).toEqual([]);
    expect(jobs()).toHaveLength(1);
  });

  it("only claude-code's Stop asks; a turn the daemon itself runs never does", async () => {
    const d = await daemon(sock, () => ({ op: "block", reason: "x", id: "1" }));
    try {
      await run(["codex", "Stop"], claude());
      await run(["claude-code", "Stop"], claude(), { SESSIONPIPE_CONTROL_JOB: "job-1" });
      await run(["claude-code", "Stop"], "not json");
      await run(["claude-code", "Stop"], JSON.stringify({ session_id: 7 }));
      // Another harness running our settings.json entry: no transcript, no UUID.
      await run(["claude-code", "Stop"], JSON.stringify({ session_id: "zest-lantana" }));
      expect(d.asked).toEqual([]);
      expect(out).toEqual([]);
      expect(jobs()).toHaveLength(5);
    } finally {
      await d.close();
    }
  });

  it("a block comes back as the hook's answer, before the job is written; a none prints nothing", async () => {
    let reply: unknown = { op: "block", reason: "Do the thing", id: "m1" };
    const d = await daemon(sock, () => reply);
    try {
      await run(["claude-code", "Stop"], claude({ stop_hook_active: true }));
      expect(d.asked).toEqual([{ op: "stop", session: `claude-code:${SID}`, active: true }]);
      expect(out).toEqual([`${JSON.stringify({ decision: "block", reason: "Do the thing" })}\n`]);
      expect(jobs()).toHaveLength(1);
      reply = { op: "none" };
      await run(["claude-code", "Stop"], claude());
      expect(d.asked[1]).toEqual({ op: "stop", session: `claude-code:${SID}`, active: false });
      expect(out).toHaveLength(1);
      expect(jobs()).toHaveLength(2);
    } finally {
      await d.close();
    }
  });

  it("a closed stdout swallows the block; the job still goes", async () => {
    const d = await daemon(sock, () => ({ op: "block", reason: "x", id: "m1" }));
    try {
      await run(["claude-code", "Stop"], claude(), {}, () => {
        throw new Error("EPIPE");
      });
      expect(jobs()).toHaveLength(1);
      expect(timing()[0]).toMatchObject({ spawned: true });
    } finally {
      await d.close();
    }
  });

  it("SESSIONPIPE_SOCKET names the socket (tests, a daemon elsewhere)", async () => {
    const other = path.join(state, "other.sock");
    const d = await daemon(other, () => ({ op: "none" }));
    try {
      await run(["claude-code", "Stop"], claude(), { SESSIONPIPE_SOCKET: other });
      expect(d.asked).toHaveLength(1);
    } finally {
      await d.close();
    }
  });
});

describe.runIf(process.platform !== "win32")("control: the PermissionRequest hook waits for the owner's answer", () => {
  let sock: string;
  beforeEach(() => {
    sock = path.join(state, "control.sock");
  });
  const perm = (extra: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = {}, stdout?: (t: string) => void) =>
    run(["claude-code", "PermissionRequest"], claude(extra), env, stdout);
  const attention = (turn: string, tool: string, input: unknown) =>
    `perm-${createHash("sha256")
      .update(`${turn}|${tool}|${JSON.stringify(input)}`)
      .digest("hex")
      .slice(0, 16)}`;

  it("no daemon: the job goes, nothing is printed, no control wait is recorded", async () => {
    await perm({ tool_name: "Bash", tool_input: { command: "ls" } });
    expect(out).toEqual([]);
    expect(jobs()).toHaveLength(1);
    expect(timing()[0]).not.toHaveProperty("control_wait_ms");
  });

  it("asks after the job is on its way, naming the adapter's attention id, and prints an allow", async () => {
    const d = await daemon(sock, () => ({ op: "decision", behavior: "allow", id: "a1" }));
    try {
      await perm({ tool_name: "Bash", tool_input: { command: "ls" }, prompt_id: "p1" });
      expect(d.asked).toEqual([
        {
          op: "permission",
          session: `claude-code:${SID}`,
          attention: attention("p1", "Bash", { command: "ls" }),
          tool: "Bash",
        },
      ]);
      expect(out).toEqual([
        `${JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } })}\n`,
      ]);
      expect(jobs()).toHaveLength(1);
      const t = timing()[0] as { ms: number; control_wait_ms: number; spawned: boolean };
      expect(t.spawned).toBe(true);
      expect(t.control_wait_ms).toBeGreaterThanOrEqual(0);
    } finally {
      await d.close();
    }
  });

  it("a deny carries the owner's message, or the default one", async () => {
    let reply: unknown = { op: "decision", behavior: "deny", message: "Not that.", id: "d1" };
    const d = await daemon(sock, () => reply);
    try {
      await perm({ tool_name: "Bash", tool_input: {} });
      reply = { op: "decision", behavior: "deny", id: "d2" };
      await perm({ tool_name: "Bash", tool_input: {} });
      const decisions = out.map(
        (o) => (JSON.parse(o) as { hookSpecificOutput: { decision: unknown } }).hookSpecificOutput.decision,
      );
      expect(decisions).toEqual([
        { behavior: "deny", message: "Not that." },
        { behavior: "deny", message: "Denied by the owner (sessionpipe control)." },
      ]);
    } finally {
      await d.close();
    }
  });

  it("a tool name that is not a name is left out of the ask; a missing prompt id or input is empty", async () => {
    const d = await daemon(sock, () => ({ op: "none" }));
    try {
      await perm({ tool_name: "Bash; rm -rf /" });
      await perm({ tool_name: 5, tool_input: null });
      expect(d.asked).toEqual([
        { op: "permission", session: `claude-code:${SID}`, attention: attention("", "", null) },
        { op: "permission", session: `claude-code:${SID}`, attention: attention("", "", null) },
      ]);
      expect(out).toEqual([]);
    } finally {
      await d.close();
    }
  });

  it("a closed stdout swallows the answer", async () => {
    const d = await daemon(sock, () => ({ op: "decision", behavior: "allow", id: "a1" }));
    try {
      await perm({ tool_name: "Bash", tool_input: {} }, {}, () => {
        throw new Error("EPIPE");
      });
      expect(timing()[0]).toMatchObject({ spawned: true });
    } finally {
      await d.close();
    }
  });
});

describe("where the state and config live without SESSIONPIPE_STATE / SESSIONPIPE_CONFIG", () => {
  let home: string;
  beforeEach(() => {
    home = path.join(state, "home");
    mkdirSync(home);
    vi.spyOn(os, "homedir").mockReturnValue(home);
  });
  const bare = (env: NodeJS.ProcessEnv) => hookMain(["claude-code", "PostToolUse"], env, io(claude()));

  it("XDG_STATE_HOME / XDG_CONFIG_HOME, else ~/.local/state and ~/.config", () =>
    onPlatform("linux", async () => {
      await bare({});
      expect(existsSync(path.join(home, ".local", "state", "sessionpipe", "jobs"))).toBe(true);
      const xdg = path.join(state, "xdg");
      mkdirSync(path.join(xdg, "cfg", "sessionpipe"), { recursive: true });
      writeFileSync(
        path.join(xdg, "cfg", "sessionpipe", "config.json"),
        JSON.stringify({ sinks: [{ name: "a", url: "stdout", tier: 1 }] }),
      );
      await bare({ XDG_STATE_HOME: path.join(xdg, "st"), XDG_CONFIG_HOME: path.join(xdg, "cfg") });
      await bare({ XDG_STATE_HOME: path.join(xdg, "st"), XDG_CONFIG_HOME: path.join(xdg, "cfg") });
      // The tier-1 sink in that config was read: both tool events went, no throttle.
      expect(readdirSync(path.join(xdg, "st", "sessionpipe", "jobs"))).toHaveLength(2);
    }));

  it("on Windows: LOCALAPPDATA / APPDATA, else under the home folder", () =>
    onPlatform("win32", async () => {
      await bare({});
      expect(existsSync(path.join(home, "AppData", "Local", "sessionpipe", "jobs"))).toBe(true);
      const w = path.join(state, "win");
      mkdirSync(path.join(w, "roaming", "sessionpipe"), { recursive: true });
      writeFileSync(
        path.join(w, "roaming", "sessionpipe", "config.json"),
        JSON.stringify({ sinks: [{ name: "a", url: "stdout", tier: 1 }] }),
      );
      await bare({ LOCALAPPDATA: path.join(w, "local"), APPDATA: path.join(w, "roaming") });
      await bare({ LOCALAPPDATA: path.join(w, "local"), APPDATA: path.join(w, "roaming") });
      expect(readdirSync(path.join(w, "local", "sessionpipe", "jobs"))).toHaveLength(2);
    }));

  // Faked win32 on a POSIX host: the fake daemon is still a Unix socket.
  it.runIf(process.platform !== "win32")("on Windows the daemon is there when control.json is, beside the config", () =>
    onPlatform("win32", async () => {
      const sock = path.join(state, "control.sock");
      const d = await daemon(sock, () => ({ op: "block", reason: "go", id: "1" }));
      try {
        const env = { ...base, SESSIONPIPE_SOCKET: sock };
        await hookMain(["claude-code", "Stop"], env, io(claude()));
        expect(d.asked).toEqual([]);
        writeFileSync(path.join(state, "control.json"), "{}");
        await hookMain(["claude-code", "Stop"], env, io(claude()));
        expect(d.asked).toHaveLength(1);
        expect(out).toEqual([`${JSON.stringify({ decision: "block", reason: "go" })}\n`]);
      } finally {
        await d.close();
      }
    }),
  );
});

describe("run as the main module", () => {
  it("`node hook.js <harness> <event>` runs the hook and exits 0", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const argv = process.argv;
    const env = { ...process.env };
    process.argv = [process.execPath, path.resolve(here, "../src/hook.ts"), "codex", "notify"];
    process.env.SESSIONPIPE_STATE = state;
    process.env.SESSIONPIPE_NO_WORKER = "1";
    try {
      vi.resetModules();
      await import("../src/hook.js");
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
      expect(jobs()).toEqual([expect.objectContaining({ harness: "codex", event: "notify" })]);
    } finally {
      process.argv = argv;
      process.env = env;
    }
  });
});
