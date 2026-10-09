// SPDX-License-Identifier: Apache-2.0
// `sessionpipe uninstall` is scoped, the way `install` has always been. The gap this
// covers was measured on a reporting machine (8 Oct 2026): a devin-only run of
// `uninstall` with SESSIONPIPE_CONFIG/STATE/XDG_* all pointed at a temp dir still
// emptied the sessionpipe entries out of ~/.claude/settings.json, ~/.codex/hooks.json,
// ~/.codex/config.toml, ~/.gemini/settings.json and ~/.gemini/config/hooks.json —
// because those four adapters resolve from HOME, which the isolation vars never cover.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, "../dist/cli.js");
let tmp: string;
let home: string;
let env: NodeJS.ProcessEnv;
let claudeSettings: string;
let devinConfig: string;

function run(args: string[], extra: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [cli, ...args], {
      cwd: home,
      env: { ...env, ...extra },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    c.stdout.on("data", (b) => {
      out += b;
    });
    c.stderr.on("data", (b) => {
      out += b;
    });
    c.on("close", (code) => resolve({ code, out }));
  });
}
const hooksOf = (file: string): string[] => {
  const j = JSON.parse(readFileSync(file, "utf8")) as { hooks?: Record<string, unknown> };
  return Object.keys(j.hooks ?? {});
};

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "sp-uninst-"));
  home = path.join(tmp, "home");
  mkdirSync(path.join(home, ".claude"), { recursive: true });
  mkdirSync(path.join(home, ".config", "devin"), { recursive: true });
  claudeSettings = path.join(home, ".claude", "settings.json");
  devinConfig = path.join(home, ".config", "devin", "config.json");
  env = {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    SESSIONPIPE_CONFIG: path.join(tmp, "config", "config.json"),
    SESSIONPIPE_STATE: path.join(tmp, "state"),
    SESSIONPIPE_DATA: path.join(tmp, "data"),
    SESSIONPIPE_SECRETS: "file",
    SESSIONPIPE_NO_UPDATE_CHECK: "1",
  };
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe.skipIf(process.platform === "win32" || !existsSync(cli))("uninstall is scoped", () => {
  it("--devin removes Devin's entries and leaves Claude Code's alone", async () => {
    expect((await run(["install", "--claude-code", "--devin", "--backfill", "0"])).code).toBe(0);
    expect(hooksOf(claudeSettings).length).toBeGreaterThan(0);
    expect(hooksOf(devinConfig).length).toBeGreaterThan(0);

    const r = await run(["uninstall", "--devin"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("devin");
    expect(r.out).not.toContain("claude-code:");
    // Devin's file is gone (sessionpipe created it); Claude Code's is untouched.
    expect(existsSync(devinConfig)).toBe(false);
    expect(hooksOf(claudeSettings).length).toBeGreaterThan(0);
    // And the shared launcher survives, because claude-code's entries still name it.
    const cfg = JSON.parse(readFileSync(env.SESSIONPIPE_CONFIG as string, "utf8")) as {
      harnesses: Record<string, unknown>;
    };
    expect(Object.keys(cfg.harnesses)).toEqual(["claude-code"]);
    expect(r.out).toContain("Still installed: claude-code");
  }, 60_000);

  it("refuses an all-harnesses uninstall that would reach outside the isolation vars", async () => {
    expect((await run(["install", "--claude-code", "--devin", "--backfill", "0"])).code).toBe(0);
    const before = readFileSync(claudeSettings, "utf8");

    const r = await run(["uninstall"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("Refusing");
    expect(r.out).toContain("claude-code");
    expect(r.out).toContain("--all");
    // Nothing was touched, which is the whole point.
    expect(readFileSync(claudeSettings, "utf8")).toBe(before);
    expect(hooksOf(devinConfig).length).toBeGreaterThan(0);

    // --all is the way to say you meant it.
    const forced = await run(["uninstall", "--all"]);
    expect(forced.code, forced.out).toBe(0);
    // Both files are gone: sessionpipe created each of them.
    expect(existsSync(claudeSettings)).toBe(false);
    expect(existsSync(devinConfig)).toBe(false);
  }, 60_000);

  it("with no isolation vars at all, an unscoped uninstall just runs", async () => {
    // Empty is unset as far as every reader of these is concerned.
    const plain = { SESSIONPIPE_CONFIG: "", SESSIONPIPE_STATE: "" };
    // Keep sessionpipe's own files inside the sandbox by HOME alone.
    const r0 = await run(["install", "--devin", "--backfill", "0"], plain);
    expect(r0.code, r0.out).toBe(0);
    const r = await run(["uninstall"], plain);
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toContain("Refusing");
    expect(existsSync(devinConfig)).toBe(false);
  }, 60_000);
});
