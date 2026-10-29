// SPDX-License-Identifier: Apache-2.0
// The spawner every headless turn goes through: what it does with a binary that
// isn't there, a run that says too much, a line that never ends, a turn that
// overstays.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  deniedNote,
  findBinary,
  isExe,
  probe,
  runFailure,
  runHeadless,
  shimNote,
  shimTarget,
  spawnable,
  stderrTail,
} from "../src/adapters/headless.js";

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
      // How much of the 1.2 MB line survives depends on how the OS chunks the pipe (whole
      // on one, nothing on another): only what holds for any chunking is asserted. The
      // line is over the cap by more than two 64 KiB reads, so some read sees it over.
      const bin = script("lines", "head -c 1200000 /dev/zero | tr '\\0' 'y'; printf '\\nlast'");
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
  posix(
    "a tool left holding stdout after the harness exits does not hold the result past two seconds",
    { timeout: 30_000 },
    async () => {
      // The grandchild keeps stdout for 12 s; the result comes on the 2 s timer. The upper bound
      // only has to stay under the hold, so a loaded machine gets seconds of room, not tenths.
      const leaves = script("leaves", "sleep 12 &\nprintf 'bye'");
      const t0 = Date.now();
      const r = await runHeadless(leaves, [], { cwd: tmp, env: process.env });
      expect(r).toMatchObject({ code: 0, signal: null, stdout: "bye", timedOut: false });
      const ms = Date.now() - t0;
      expect(ms).toBeGreaterThanOrEqual(1900);
      expect(ms).toBeLessThan(9000);
    },
  );
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

/** An npm `.cmd` shim as cmd-shim writes it (new shape), running `rel` beside it. */
const NPM_SHIM = (rel: string) =>
  `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${rel}" %*\r\n`;
/** The older shape, with `%~dp0` and no `_prog`. */
const OLD_SHIM = (rel: string) =>
  `@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\${rel}" %*\r\n) ELSE (\r\n  @SETLOCAL\r\n  @SET PATHEXT=%PATHEXT:;.JS;=;%\r\n  node  "%~dp0\\${rel}" %*\r\n)\r\n`;

describe("launcher shims (#165)", () => {
  const dir = path.join(tmp, "shims");
  const rel = "node_modules\\@anthropic-ai\\claude-code\\cli.js";
  const cli = path.join(dir, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
  mkdirSync(path.dirname(cli), { recursive: true });
  // The script prints its arguments back, one JSON array, so every byte can be checked.
  writeFileSync(cli, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
  const shim = path.join(dir, "claude.cmd");
  writeFileSync(shim, NPM_SHIM(rel));
  const old = path.join(dir, "codex.CMD");
  writeFileSync(old, OLD_SHIM(rel));

  it("shimTarget reads npm's shim, old and new, and nothing that isn't one", () => {
    expect(shimTarget(shim)).toBe(cli);
    expect(shimTarget(old)).toBe(cli);
    const gone = path.join(dir, "gone.cmd");
    writeFileSync(gone, NPM_SHIM("node_modules\\gone\\cli.js"));
    expect(shimTarget(gone)).toBeNull();
    const folder = path.join(dir, "folder.cmd");
    writeFileSync(folder, NPM_SHIM("node_modules"));
    expect(shimTarget(folder)).toBeNull();
    const other = path.join(dir, "other.bat");
    writeFileSync(other, "@echo off\r\nsomething.exe %*\r\n");
    expect(shimTarget(other)).toBeNull();
    expect(shimTarget(path.join(dir, "missing.cmd"))).toBeNull();
  });

  it("spawnable runs a shim's script under this node, a plain binary as it is, and nothing it can't read", () => {
    expect(spawnable(shim, ["--help"])).toEqual({ file: process.execPath, args: [cli, "--help"] });
    expect(spawnable(old, [])).toEqual({ file: process.execPath, args: [cli] });
    expect(spawnable("/usr/local/bin/claude", ["-p", "hi"])).toEqual({
      file: "/usr/local/bin/claude",
      args: ["-p", "hi"],
    });
    expect(spawnable(path.join(dir, "other.bat"), [])).toBeNull();
    expect(shimNote(path.join(dir, "other.bat"))).toMatch(/^other\.bat is a launcher script .*SESSIONPIPE_CLAUDE/);
  });

  it("probe keeps a readable shim off the shell, and runs one it can't read as one quoted command", () => {
    expect(probe(shim, ["auth", "status"])).toEqual({
      file: process.execPath,
      args: [cli, "auth", "status"],
      shell: false,
    });
    expect(probe("claude", ["--help"])).toEqual({ file: "claude", args: ["--help"], shell: false });
    expect(probe(path.join(dir, "other.bat"), ["--version"])).toEqual({
      file: `"${path.join(dir, "other.bat")}" --version`,
      args: [],
      shell: true,
    });
  });

  it("runHeadless runs a shim with no shell: a prompt's every character arrives as typed", async () => {
    const prompt = 'say "hi" & echo %PATH% | !x! ^ <b>\nsecond line';
    const r = await runHeadless(shim, ["-p", prompt], { cwd: tmp, env: process.env });
    expect(r).toMatchObject({ code: 0 });
    expect(JSON.parse(String(r.stdout))).toEqual(["-p", prompt]);
  });

  it("runHeadless says why a launcher it can't read doesn't run, instead of spawning it", async () => {
    const r = await runHeadless(path.join(dir, "other.bat"), ["-p", "hi"], { cwd: tmp, env: process.env });
    expect(r).toEqual({ error: shimNote(path.join(dir, "other.bat")) });
  });
});
