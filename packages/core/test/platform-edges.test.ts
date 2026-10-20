// SPDX-License-Identifier: Apache-2.0
// The branches only another platform or a failing builtin reaches: Windows binary
// names, Linux's /proc parent lookup, a machine with no harness CLI at all, a stat
// that fails mid-scan, a process group that is already gone, a turn that ignores
// SIGTERM, and WebCrypto throwing instead of answering.
import { ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { agPath } from "../src/adapters/antigravity.js";
import { findAgy } from "../src/adapters/antigravity-control.js";
import { _resetClaudeCaches, claudeFacts, claudePid } from "../src/adapters/claude-code.js";
import { findClaude } from "../src/adapters/claude-code-control.js";
import { findCodex } from "../src/adapters/codex-control.js";
import { runHeadless } from "../src/adapters/headless.js";
import { drivableHarnesses } from "../src/adapters/index.js";
import type { FactsState } from "../src/adapters/types.js";
import { fromB64url, sha256, verifyAssertion } from "../src/control/verify.js";
import { Passkey } from "./helpers/authenticator.js";

/** What this file makes node:fs do: a /proc table to read, and stats that fail on cue. */
const fake = {
  proc: new Map<number, string>(),
  statFails: null as ((p: string) => boolean) | null,
};
vi.mock("node:fs", async (original) => {
  const m = await original<typeof import("node:fs")>();
  const readFileSync = ((p: unknown, ...rest: unknown[]) => {
    const pid = typeof p === "string" ? /^\/proc\/(\d+)\/stat$/.exec(p)?.[1] : undefined;
    if (pid !== undefined) {
      const stat = fake.proc.get(Number(pid));
      if (stat === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
      return stat;
    }
    return (m.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof m.readFileSync;
  const statSync = ((p: unknown, ...rest: unknown[]) => {
    if (typeof p === "string" && fake.statFails?.(p))
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
    return (m.statSync as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof m.statSync;
  return { ...m, readFileSync, statSync };
});

vi.setConfig({ testTimeout: 30_000 });
const tmp = mkdtempSync(path.join(os.tmpdir(), "sp-edges-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => {
  fake.proc.clear();
  fake.statFails = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Run `f` with process.platform reported as `p`; the real value is put back after. */
async function onPlatform<T>(p: NodeJS.Platform, f: () => T | Promise<T>): Promise<T> {
  const real = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
  Object.defineProperty(process, "platform", { value: p, configurable: true });
  try {
    return await f();
  } finally {
    Object.defineProperty(process, "platform", real);
  }
}
const script = (p: string, body: string) => {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
};
const posix = it.runIf(process.platform !== "win32");

describe("finding a harness CLI", () => {
  it("on Windows the names are claude.exe/.cmd, codex.exe/.cmd, agy.exe/.cmd", async () => {
    const bin = path.join(tmp, "win");
    for (const n of ["claude.cmd", "codex.exe", "agy.cmd"]) script(path.join(bin, n), "");
    const empty = path.join(tmp, "empty");
    mkdirSync(empty, { recursive: true });
    await onPlatform("win32", () => {
      expect(findClaude({ PATH: bin }, empty)).toBe(path.join(bin, "claude.cmd"));
      expect(findCodex({ PATH: bin }, empty, empty)).toBe(path.join(bin, "codex.exe"));
      expect(findAgy({ PATH: bin }, empty)).toBe(path.join(bin, "agy.cmd"));
    });
  });
  posix("findClaude looks under the real home when given none", () => {
    const home = path.join(tmp, "home");
    const claude = script(path.join(home, ".local", "bin", "claude"), "");
    vi.stubEnv("HOME", home);
    try {
      expect(findClaude({ PATH: "" })).toBe(claude);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("agPath on Windows drops the slash a file URI puts before the drive letter", async () => {
    await onPlatform("win32", () => {
      expect(agPath("file:///C:/w")).toBe(path.isAbsolute("C:/w") ? path.resolve("C:/w") : null);
      expect(agPath("file:///w")).toBe(path.resolve("/w"));
    });
  });
  it("drivableHarnesses: a machine with none of the CLIs drives nothing", () => {
    fake.statFails = (p) => /(?:^|[\\/])(?:claude|codex|agy)(?:\.exe|\.cmd)?$/.test(p);
    expect(drivableHarnesses({ PATH: path.join(tmp, "win") })).toEqual([]);
  });
});

describe("claudePid", () => {
  const env = () => {
    _resetClaudeCaches();
    const home = mkdtempSync(path.join(tmp, "home-"));
    const dir = path.join(home, ".claude");
    mkdirSync(path.join(dir, "sessions"), { recursive: true });
    return { env: { HOME: home, CLAUDE_CONFIG_DIR: dir }, dir };
  };
  it("on Linux walks /proc/<pid>/stat: a parent read from after the command's ')', none when the file is gone", async () => {
    const { env: e, dir } = env();
    writeFileSync(path.join(dir, "sessions", "4242.json"), JSON.stringify({ sessionId: "s" }));
    fake.proc.set(process.ppid, `${process.ppid} (my shell) S 4242 1 1 0 -1`);
    fake.proc.set(4242, "4242 (claude) S 1 1 1 0 -1");
    await onPlatform("linux", () => {
      expect(claudePid(e)).toBe(4242);
      // A stat with no parent field reads as 0: the walk stops.
      fake.proc.set(process.ppid, `${process.ppid} (my shell)`);
      expect(claudePid(e)).toBeNull();
      // No /proc entry at all: the same.
      fake.proc.clear();
      expect(claudePid(e)).toBeNull();
    });
  });
  posix("elsewhere it asks ps for the table", async () => {
    const { env: e } = env();
    await onPlatform("darwin", () => expect(claudePid(e)).toBeNull());
  });
});

describe("claude facts", () => {
  posix("a transcript whose stat fails mid-scan keeps what the scan already found", () => {
    _resetClaudeCaches();
    const home = mkdtempSync(path.join(tmp, "home-"));
    const dir = path.join(home, ".claude", "projects", "-w-app");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "ed6c7665-589f-40c7-b7b4-e38ee662b7bc.jsonl");
    const pad = Array(400).fill(JSON.stringify({ type: "progress", pad: "x".repeat(1000) }));
    writeFileSync(
      file,
      `${pad.join("\n")}\n${JSON.stringify({ type: "custom-title", customTitle: "T" })}\n${pad.join("\n")}\n`,
    );
    const mem: Record<string, unknown> = {};
    const state: FactsState = { get: () => mem, save: (_h, _s, patch) => Object.assign(mem, patch) };
    let stats = 0;
    fake.statFails = (p) => p === file && ++stats === 2;
    expect(claudeFacts(file, "", {}, state).title).toBeUndefined();
    expect(mem).toMatchObject({ scan_upto: 0, scan_custom: null, scan_ai: null });
    expect(stats).toBe(2);
  });
});

describe("runHeadless stopping a turn", () => {
  const sleepy = () => script(path.join(tmp, "bin", "sleepy"), "sleep 20");
  posix("a process group that is already gone: the child itself is signalled", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    });
    const r = await runHeadless(sleepy(), [], { cwd: tmp, env: process.env, timeoutMs: 100 });
    expect(r).toMatchObject({ timedOut: true, signal: "SIGTERM" });
  });
  posix("a child that cannot be signalled either is left to finish on its own", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    vi.spyOn(ChildProcess.prototype, "kill").mockImplementation(() => {
      throw new Error("EPERM");
    });
    const brief = script(path.join(tmp, "bin", "brief"), "sleep 0.5; echo done");
    const r = await runHeadless(brief, [], { cwd: tmp, env: process.env, timeoutMs: 100 });
    expect(r).toMatchObject({ timedOut: true, code: 0, stdout: "done\n" });
  });
  posix("on Windows there is no process group: the child is signalled directly", async () => {
    const r = await onPlatform("win32", () =>
      runHeadless(sleepy(), [], { cwd: tmp, env: process.env, timeoutMs: 100 }),
    );
    expect(r).toMatchObject({ timedOut: true, signal: "SIGTERM" });
  });
  posix("a turn that ignores SIGTERM gets SIGKILL ten seconds later (clock faked)", async () => {
    const stubborn = script(
      path.join(tmp, "bin", "stubborn"),
      "trap 'echo trapped' TERM\necho ready\nwhile :; do sleep 1; done",
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let ready = () => {};
    const isReady = new Promise<void>((r) => {
      ready = r;
    });
    const lines: string[] = [];
    const run = runHeadless(stubborn, [], {
      cwd: tmp,
      env: process.env,
      timeoutMs: 100,
      onLine: (l) => {
        lines.push(l);
        if (l === "ready") ready();
      },
    });
    await isReady;
    await vi.advanceTimersByTimeAsync(100); // SIGTERM: trapped
    await vi.advanceTimersByTimeAsync(10_000); // SIGKILL
    vi.useRealTimers();
    const r = await run;
    expect(r).toMatchObject({ timedOut: true, signal: "SIGKILL" });
    expect(lines[0]).toBe("ready");
  });
});

describe("WebCrypto that throws", () => {
  it("fromB64url: an atob that throws is null, not a crash", () => {
    vi.spyOn(globalThis, "atob").mockImplementation(() => {
      throw new Error("not base64");
    });
    expect(fromB64url("AAAA")).toBeNull();
  });
  it("verifyAssertion: a subtle.verify that throws is a signature that doesn't verify", async () => {
    const rp = "control.example";
    const pk = await Passkey.create({ rpId: rp });
    const challenge = await sha256("c");
    const good = await pk.assert(challenge);
    vi.spyOn(crypto.subtle, "verify").mockRejectedValue(new Error("boom"));
    expect(await verifyAssertion(challenge, good, pk.key, rp)).toEqual({
      ok: false,
      why: "the passkey signature doesn't verify",
    });
  });
});
