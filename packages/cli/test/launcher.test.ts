// SPDX-License-Identifier: Apache-2.0
// The hook launcher: a copy of the hook outside every npm prefix, run with the node
// sessionpipe was installed with — and with PATH's node once that one is gone. With no
// node at all it still exits 0 (and Antigravity still gets its `{}`).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AG_STALE_PRETOOL } from "@sessionpipe/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dataDir,
  installLauncher,
  launcherPath,
  launcherScript,
  launcherState,
  removeLauncher,
  usesLauncher,
} from "../src/launcher.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "../dist");
let data: string;
let state: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  data = mkdtempSync(path.join(os.tmpdir(), "sp-data-"));
  state = mkdtempSync(path.join(os.tmpdir(), "sp-state-"));
  env = { ...process.env, SESSIONPIPE_DATA: data };
});
afterEach(() => {
  rmSync(data, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32" || !existsSync(path.join(dist, "hook.js")))("the launcher", () => {
  it("copies hook.js and worker.js beside an executable launcher; a second install changes nothing", () => {
    const a = installLauncher({ distDir: dist, node: process.execPath, version: "9.9.9", env });
    expect(a.changed).toBe(true);
    expect(statSync(a.launcher).mode & 0o111).not.toBe(0);
    expect(readFileSync(path.join(data, "hook.js"))).toEqual(readFileSync(path.join(dist, "hook.js")));
    expect(readFileSync(path.join(data, "worker.js"))).toEqual(readFileSync(path.join(dist, "worker.js")));
    expect(installLauncher({ distDir: dist, node: process.execPath, version: "9.9.9", env }).changed).toBe(false);
    expect(launcherState("9.9.9", env)).toMatchObject({ present: true, nodeOk: true, problems: [] });
    removeLauncher(env);
    expect(existsSync(a.launcher)).toBe(false);
  });

  it("runs the hook with PATH's node when the one it was written with is gone", () => {
    const { launcher } = installLauncher({ distDir: dist, node: "/nonexistent/v22/bin/node", version: "9.9.9", env });
    const r = spawnSync(launcher, ["claude-code", "PostToolUse"], {
      input: JSON.stringify({ session_id: "launcher-test", hook_event_name: "PostToolUse", tool_name: "Bash" }),
      env: {
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: state,
        SESSIONPIPE_STATE: state,
        SESSIONPIPE_CONFIG: path.join(state, "config.json"),
        SESSIONPIPE_NO_WORKER: "1",
      },
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(readFileSync(path.join(state, "timing.jsonl"), "utf8")).toContain('"event":"PostToolUse"');
    expect(launcherState("9.9.9", env).problems.join(" ")).toMatch(/is gone/);
  });

  it("the hook answers Antigravity: `{}` to what sessionpipe hooks, an ask (never a silent deny) to a leftover PreToolUse", {
    timeout: 30_000,
  }, () => {
    const { launcher } = installLauncher({ distDir: dist, node: process.execPath, version: "9.9.9", env });
    const run = (event: string) =>
      spawnSync(launcher, ["antigravity", event], {
        input: JSON.stringify({ conversationId: "ag-launcher-test", toolCall: { name: "run_command" }, stepIdx: 1 }),
        env: {
          PATH: "/usr/bin:/bin",
          HOME: state,
          SESSIONPIPE_STATE: state,
          SESSIONPIPE_CONFIG: path.join(state, "config.json"),
          SESSIONPIPE_NO_WORKER: "1",
        },
        encoding: "utf8",
      });
    const pre = run("PreToolUse");
    expect(pre.status).toBe(0);
    expect(pre.stdout).toBe(AG_STALE_PRETOOL);
    expect(JSON.parse(pre.stdout).decision).toBe("ask");
    for (const e of ["PreInvocation", "PostToolUse", "PostInvocation", "Stop"]) expect(run(e).stdout).toBe("{}\n");
  });

  it("no node anywhere: exit 0, and Antigravity still reads `{}`", () => {
    const { launcher } = installLauncher({ distDir: dist, node: "/nonexistent/node", version: "9.9.9", env });
    const r = spawnSync(launcher, ["antigravity", "PostInvocation"], {
      env: { PATH: "/nonexistent" },
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("{}\n");
    // `{}` to PreToolUse is a deny: a leftover entry asks instead, same bytes as the hook.
    const p = spawnSync(launcher, ["antigravity", "PreToolUse"], { env: { PATH: "/nonexistent" }, encoding: "utf8" });
    expect(p.status).toBe(0);
    expect(p.stdout).toBe(AG_STALE_PRETOOL);
    const c = spawnSync(launcher, ["claude-code", "Stop"], { env: { PATH: "/nonexistent" }, encoding: "utf8" });
    expect(c.status).toBe(0);
    expect(c.stdout).toBe("");
  });

  it("lives under SESSIONPIPE_DATA, else XDG_DATA_HOME, else ~/.local/share; Windows keeps the direct entry", () => {
    expect(dataDir({ SESSIONPIPE_DATA: path.join(data, "x", "..", "d") })).toBe(path.join(data, "d"));
    expect(dataDir({ XDG_DATA_HOME: "/xdg" })).toBe(path.join("/xdg", "sessionpipe"));
    expect(dataDir({})).toBe(path.join(os.homedir(), ".local", "share", "sessionpipe"));
    expect(launcherPath({ SESSIONPIPE_DATA: data })).toBe(path.join(data, "sessionpipe-hook"));
    expect(usesLauncher("win32")).toBe(false);
    expect(usesLauncher("linux")).toBe(true);
    expect(usesLauncher()).toBe(process.platform !== "win32");
  });

  it("doctor's view of a launcher that is missing, or missing its files, or whose node line is unreadable", () => {
    expect(launcherState("9.9.9", env)).toEqual({
      file: path.join(data, "sessionpipe-hook"),
      present: false,
      node: null,
      nodeOk: false,
      version: null,
      problems: ["the hook launcher is missing; run `sessionpipe install` again"],
    });
    installLauncher({ distDir: dist, node: process.execPath, version: "9.9.9", env });
    rmSync(path.join(data, "worker.js"));
    expect(launcherState("9.9.9", env).problems).toEqual([
      "worker.js is missing beside the hook launcher; run `sessionpipe install` again",
    ]);
    writeFileSync(path.join(data, "sessionpipe-hook"), "#!/bin/sh\nexit 0\n");
    const odd = launcherState("9.9.9", env);
    expect(odd).toMatchObject({ present: true, node: null, nodeOk: false, version: null });
    expect(odd.problems[0]).toContain("the node the hook launcher names (?) is gone");
    // The env is this process's by default.
    vi.stubEnv("SESSIONPIPE_DATA", data);
    try {
      expect(launcherState("9.9.9").file).toBe(path.join(data, "sessionpipe-hook"));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("an older launcher says so; a node path with a quote survives the round trip", () => {
    installLauncher({ distDir: dist, node: process.execPath, version: "0.4.2", env });
    expect(launcherState("0.5.0", env).problems.join(" ")).toMatch(/0\.4\.2/);
    const s = launcherScript("/opt/it's here/node", "/x/hook.js", "1.0.0");
    expect(s).toContain(`n='/opt/it'\\''s here/node'`);
  });
});
