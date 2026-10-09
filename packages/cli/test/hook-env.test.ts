// SPDX-License-Identifier: Apache-2.0
// What the hook carries into the job file. The worker that runs a job is not always the
// one that was spawned for it (sweepJobs runs any stale job file), so every variable a
// harness's own paths are resolved from has to ride in the job — the same reason
// CLAUDE_CONFIG_DIR, CODEX_HOME and GEMINI_CLI_HOME are already there.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "../dist/hook.js");
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "sp-hookenv-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function runHook(harness: string, event: string, stdin: object, extra: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [dist, harness, event], {
      env: {
        PATH: process.env.PATH,
        HOME: tmp,
        SESSIONPIPE_STATE: path.join(tmp, "state"),
        SESSIONPIPE_CONFIG: path.join(tmp, "config.json"),
        SESSIONPIPE_NO_WORKER: "1",
        ...extra,
      },
      stdio: ["pipe", "ignore", "ignore"],
    });
    c.on("close", () => resolve());
    c.stdin.end(JSON.stringify(stdin));
  });
}
function oneJob(): { harness: string; event: string; env: Record<string, string> } {
  const dir = path.join(tmp, "state", "jobs");
  const names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  expect(names).toHaveLength(1);
  return JSON.parse(readFileSync(path.join(dir, names[0] as string), "utf8"));
}

describe.skipIf(process.platform === "win32" || !existsSync(dist))("the job file's environment", () => {
  it("carries the variables a harness's config and session store are resolved from", async () => {
    await runHook(
      "devin",
      "SessionStart",
      { session_id: "zest-lantana", source: "startup" },
      {
        DEVIN_PROJECT_DIR: "/work/proj",
        XDG_CONFIG_HOME: path.join(tmp, "cfg"),
        XDG_DATA_HOME: path.join(tmp, "data"),
        CLAUDE_CONFIG_DIR: path.join(tmp, "claude"),
        CODEX_HOME: path.join(tmp, "codex"),
        GEMINI_CLI_HOME: path.join(tmp, "gemini"),
      },
    );
    const job = oneJob();
    expect(job.harness).toBe("devin");
    expect(job.env.DEVIN_PROJECT_DIR).toBe("/work/proj");
    // These two are what devin resolves ~/.config/devin/config.json and
    // ~/.local/share/devin/cli/sessions.db from; without them a swept job addresses
    // the wrong store and tier 2 silently returns no turns.
    expect(job.env.XDG_CONFIG_HOME).toBe(path.join(tmp, "cfg"));
    expect(job.env.XDG_DATA_HOME).toBe(path.join(tmp, "data"));
    expect(job.env.CLAUDE_CONFIG_DIR).toBe(path.join(tmp, "claude"));
    expect(job.env.CODEX_HOME).toBe(path.join(tmp, "codex"));
    expect(job.env.GEMINI_CLI_HOME).toBe(path.join(tmp, "gemini"));
  });

  it("carries nothing that was not set", async () => {
    await runHook("devin", "SessionStart", { session_id: "zest-lantana", source: "startup" }, {});
    expect(Object.keys(oneJob().env)).toEqual([]);
  });
});
