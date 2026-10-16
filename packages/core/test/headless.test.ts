// SPDX-License-Identifier: Apache-2.0
// The spawner every headless turn goes through: what it does with a binary that
// isn't there, a run that says too much, a line that never ends, a turn that
// overstays.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { deniedNote, findBinary, isExe, runFailure, runHeadless, stderrTail } from "../src/adapters/headless.js";

// Every case spawns a shell; under a full parallel run that can take seconds.
vi.setConfig({ testTimeout: 30_000 });

const tmp = mkdtempSync(path.join(os.tmpdir(), "sp-headless-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const script = (name: string, body: string) => {
  const p = path.join(tmp, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
};
const posix = it.runIf(process.platform !== "win32");

describe("binaries", () => {
  posix(
    "isExe wants an executable file; findBinary an override that is one, else PATH's absolute entries, else the dirs",
    () => {
      const dir = path.join(tmp, "a-dir");
      mkdirSync(dir);
      expect(isExe(dir)).toBe(false);
      expect(isExe(path.join(tmp, "none"))).toBe(false);
      const bin = script("tool", "");
      expect(
        findBinary({ override: path.join(tmp, "none"), names: ["tool"], dirs: [], env: { PATH: `rel:${tmp}` } }),
      ).toBe(bin);
      expect(findBinary({ names: ["tool"], dirs: [dir, tmp], env: { PATH: "" } })).toBe(bin);
      expect(findBinary({ names: ["other"], dirs: [tmp] })).toBeNull();
    },
  );
});

describe("runHeadless", () => {
  it("a binary that cannot be spawned is an error, not a throw", async () => {
    expect(await runHeadless("", [], { cwd: tmp, env: {} })).toHaveProperty("error");
    const r = await runHeadless(path.join(tmp, "no-such-binary"), [], { cwd: tmp, env: {} });
    expect(r.error).toMatch(/ENOENT/);
  });
  posix("holds at most 1 MB of stdout, and says when a run said more", async () => {
    const big = script("big", "head -c 1200000 /dev/zero | tr '\\0' 'x'");
    const r = await runHeadless(big, [], { cwd: tmp, env: process.env });
    expect(r).toMatchObject({ code: 0, tooBig: true, stdout: null });
    const small = script("small", "printf 'hi'; echo 'warn' >&2");
    const blank = script("blank", "printf '\\n\\n  \\nx\\n'");
    const lines: string[] = [];
    await runHeadless(blank, [], { cwd: tmp, env: process.env, onLine: (l) => lines.push(l) });
    expect(lines).toEqual(["x"]);
    expect(await runHeadless(small, [], { cwd: tmp, env: process.env })).toMatchObject({
      code: 0,
      stdout: "hi",
      stderr: "warn\n",
      tooBig: false,
    });
  });
  posix(
    "streaming: a line over the cap never breaks the stream, a listener that throws is survived, the last line needs no newline",
    async () => {
      // How much of the 1.1 MB line survives depends on how the OS chunks the pipe (whole
      // on one, nothing on another): only what holds for any chunking is asserted.
      const bin = script("lines", "head -c 1100000 /dev/zero | tr '\\0' 'y'; printf '\\nlast'");
      const lines: string[] = [];
      const r = await runHeadless(bin, [], {
        cwd: tmp,
        env: process.env,
        onLine: (l) => {
          lines.push(l);
          throw new Error("listener bug");
        },
        keep: (l) => l === "last",
      });
      expect(lines.at(-1)).toBe("last");
      expect(lines.filter((l) => l === "last")).toHaveLength(1);
      for (const l of lines.slice(0, -1)) expect(l).toMatch(/^y+$/);
      expect(r.stdout).toBe("last");
    },
  );
  posix("a turn still running at the timeout is stopped and says so", async () => {
    const sleep = script("sleepy", "sleep 20");
    const r = await runHeadless(sleep, [], { cwd: tmp, env: process.env, timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(r.signal).toBe("SIGTERM");
    expect(runFailure("Claude", r)).toContain("still working after 30 minutes");
    expect(runFailure("Claude", { error: "nope" })).toBe("couldn't start Claude: nope");
    expect(runFailure("Claude", { code: 1 })).toBeNull();
  });
});

describe("words", () => {
  it("stderrTail keeps the last lines on one; deniedNote names the actions or counts them", () => {
    expect(stderrTail("a\nb\nc\nd\n")).toBe("b c d");
    expect(stderrTail(undefined)).toBe("");
    expect(deniedNote([], 0)).toBe("");
    expect(deniedNote([], 2)).toContain("2 action(s)");
    expect(deniedNote(["run_command"], 1)).toContain("run_command");
  });
});
