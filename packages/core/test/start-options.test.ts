// SPDX-License-Identifier: Apache-2.0
// A start's options (CONTROL.md §3.1, §6; ADAPTERS.md "Start options"): each level and
// model as each harness's own flags, for a new session, a resume and a fork. The levels
// a machine offers are capped by its mode and by what the binary lists, no level ever
// writes a flag that turns approval off, and a start without options runs exactly as
// it did in 0.9.0 (the snapshot below was taken from the 0.9.0 build).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { antigravityControl, claudeControl, codexControl } from "../src/adapters/index.js";
import { START_PERMISSIONS, type StartPermission } from "../src/control/verify.js";

const { claudeArgs, modeFlags } = claudeControl;
const { codexArgs, codexModels } = codexControl;
const { agyArgs, agyModeFlags } = antigravityControl;

/** Every mode `claude --help` lists today (2.1.296), and a build that lists none of the new ones. */
const CAPS = {
  hasMode: true,
  modes: ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"],
  promptsNone: true,
  fork: true,
};
const OLD = { hasMode: true, modes: ["default"], promptsNone: true, fork: true };
const FORBIDDEN = /bypass|dangerously|danger-full-access|yolo|--force|skip-permissions/;

describe("compatibility: a start without options is 0.9.0's argv", () => {
  // From the 0.9.0 build, `codexArgs({ mode, … })` and friends, before this change.
  const V090 = {
    "codex start safe": ["exec", "--json", "--skip-git-repo-check", "-C", "/w", "-s", "workspace-write", "--", "P"],
    "codex resume safe": [
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      "-c",
      'sandbox_mode="workspace-write"',
      "--",
      "T",
      "P",
    ],
    "codex start auto": ["exec", "--json", "--skip-git-repo-check", "-C", "/w", "--approve-for-me", "--", "P"],
    "codex resume auto": [
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      "-c",
      'sandbox_mode="workspace-write"',
      "-c",
      'approval_policy="on-request"',
      "-c",
      'approvals_reviewer="auto_review"',
      "--",
      "T",
      "P",
    ],
    "agy start safe": ["-p", "P", "--output-format", "stream-json"],
    "agy resume safe": ["--conversation", "C", "-p", "P", "--output-format", "stream-json"],
    "agy start auto": ["-p", "P", "--output-format", "stream-json", "--mode", "accept-edits"],
    "agy resume auto": ["--conversation", "C", "-p", "P", "--output-format", "stream-json", "--mode", "accept-edits"],
    "claude flags safe": { args: ["--permission-mode", "dontAsk"] },
    "claude flags auto": { args: ["--permission-mode", "auto"] },
    "claude flags old safe": { args: ["--permission-mode", "default", "--permission-prompts", "none"] },
    "claude flags old auto": { error: "this machine is in auto mode, but its Claude Code has no auto permission mode" },
  };
  it("the default level of each mode gives the same flags as the mode did", () => {
    for (const mode of ["safe", "auto"] as const) {
      const c = codexControl.defaultLevel(mode);
      const a = antigravityControl.defaultLevel(mode);
      expect(codexArgs({ permission: c, prompt: "P", cwd: "/w" })).toEqual(V090[`codex start ${mode}`]);
      expect(codexArgs({ permission: c, prompt: "P", resume: "T" })).toEqual(V090[`codex resume ${mode}`]);
      expect(agyArgs({ permission: a, prompt: "P" })).toEqual(V090[`agy start ${mode}`]);
      expect(agyArgs({ permission: a, prompt: "P", resume: "C" })).toEqual(V090[`agy resume ${mode}`]);
      const k = claudeControl.defaultLevel(mode);
      expect(modeFlags(k, CAPS)).toEqual(V090[`claude flags ${mode}`]);
      expect(modeFlags(k, OLD)).toEqual(V090[`claude flags old ${mode}`]);
    }
  });
  it("Claude Code's whole argv, as the daemon built it in 0.9.0", () => {
    const caps = { hasMode: true, modes: ["default", "dontAsk"], promptsNone: false, fork: true };
    expect(claudeArgs({ caps, level: "safe", prompt: "P", session: "S" })).toEqual({
      args: ["-p", "--output-format", "json", "--permission-mode", "dontAsk", "--session-id", "S", "P"],
    });
    expect(
      claudeArgs({
        caps: { ...caps, stream: true },
        level: "safe",
        prompt: "P",
        resume: "T",
        fork: true,
        allowedTools: ["mcp__a", "mcp__b"],
      }),
    ).toEqual({
      args: [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-mode",
        "dontAsk",
        "--allowedTools=mcp__a,mcp__b",
        "--resume",
        "T",
        "--fork-session",
        "P",
      ],
    });
  });
});

describe("each level as each harness's flags", () => {
  const CLAUDE: Record<StartPermission, string> = { read: "plan", safe: "dontAsk", edits: "acceptEdits", auto: "auto" };
  it("Claude Code: one --permission-mode per level, --model as its own argument; start, resume and fork", () => {
    for (const level of START_PERMISSIONS)
      for (const model of [undefined, "opus[1m]"])
        for (const where of [{ session: "S" }, { resume: "T" }, { resume: "T", fork: true }]) {
          const r = claudeArgs({ caps: CAPS, level, prompt: "P", ...where, ...(model ? { model } : {}) });
          if (!("args" in r)) throw new Error(r.error);
          const a = r.args;
          expect(a[a.indexOf("--permission-mode") + 1]).toBe(CLAUDE[level]);
          if (model) expect(a.slice(a.indexOf("--model"), a.indexOf("--model") + 2)).toEqual(["--model", model]);
          else expect(a).not.toContain("--model");
          expect(a.at(-1)).toBe("P");
          expect(a.join(" ")).not.toMatch(FORBIDDEN);
        }
  });
  it("Claude Code: a level its --help doesn't list is a refusal, never another level", () => {
    for (const level of ["read", "edits", "auto"] as const) expect(modeFlags(level, OLD)).toHaveProperty("error");
    expect(modeFlags("read", OLD)).toEqual({ error: "this machine's Claude Code has no plan permission mode" });
    expect(claudeArgs({ caps: OLD, level: "edits", prompt: "P", session: "S" })).toEqual({
      error: "this machine's Claude Code has no acceptEdits permission mode",
    });
  });
  it("Claude Code: a prompt that starts with a dash is never read as a flag", () => {
    const r = claudeArgs({ caps: CAPS, level: "safe", prompt: "--allowedTools=Bash\n\n(Sent via x)", session: "S" });
    expect("args" in r && r.args.at(-1)).toBe(" --allowedTools=Bash\n\n(Sent via x)");
  });
  it("Codex: read-only, workspace-write, automatic review; -m as its own argument; start and resume", () => {
    const sandbox = { read: "read-only", safe: "workspace-write", edits: "workspace-write", auto: "workspace-write" };
    for (const permission of START_PERMISSIONS)
      for (const model of [undefined, "gpt-5.6-sol"]) {
        const start = codexArgs({ permission, prompt: "P", cwd: "/w", ...(model ? { model } : {}) });
        const resume = codexArgs({ permission, prompt: "P", resume: "T", ...(model ? { model } : {}) });
        if (permission === "auto") expect(start).toContain("--approve-for-me");
        else expect(start.slice(start.indexOf("-s"), start.indexOf("-s") + 2)).toEqual(["-s", sandbox[permission]]);
        expect(resume).toContain(`sandbox_mode="${sandbox[permission]}"`);
        expect(resume.includes('approvals_reviewer="auto_review"')).toBe(permission === "auto");
        for (const a of [start, resume]) {
          if (model) expect(a.slice(a.indexOf("-m"), a.indexOf("-m") + 2)).toEqual(["-m", model]);
          else expect(a).not.toContain("-m");
          // The model, like every flag, comes before `--`.
          expect(a.indexOf("--")).toBeGreaterThan(model ? a.indexOf("-m") : -1);
          expect(a.at(-1)).toBe("P");
          expect(a.join(" ")).not.toMatch(FORBIDDEN);
        }
      }
  });
  it("Antigravity: no flag for safe, accept-edits for edits; no read-only mode", () => {
    for (const resume of [undefined, "C"]) {
      expect(agyArgs({ permission: "safe", prompt: "P", ...(resume ? { resume } : {}) })).not.toContain("--mode");
      expect(agyArgs({ permission: "edits", prompt: "P", ...(resume ? { resume } : {}) }).slice(-2)).toEqual([
        "--mode",
        "accept-edits",
      ]);
      for (const permission of ["safe", "edits", "auto"] as const)
        expect(agyArgs({ permission, prompt: "P" }).join(" ")).not.toMatch(FORBIDDEN);
    }
    expect(() => agyModeFlags("read")).toThrow("Antigravity has no read-only mode");
  });
});

describe("what a machine offers", () => {
  it("never above its mode, and only what the harness has", () => {
    expect(claudeControl.offeredLevels("safe", CAPS)).toEqual(["read", "safe"]);
    expect(claudeControl.offeredLevels("auto", CAPS)).toEqual(["read", "safe", "edits", "auto"]);
    expect(claudeControl.offeredLevels("auto", OLD)).toEqual(["safe"]);
    expect(claudeControl.offeredLevels("auto", { ...OLD, modes: ["acceptEdits", "dontAsk"] })).toEqual([
      "safe",
      "edits",
    ]);
    expect(codexControl.offeredLevels("safe")).toEqual(["read", "safe"]);
    expect(codexControl.offeredLevels("auto")).toEqual(["read", "safe", "auto"]);
    expect(antigravityControl.offeredLevels("safe")).toEqual(["safe"]);
    expect(antigravityControl.offeredLevels("auto")).toEqual(["safe", "edits"]);
    // Antigravity's default on an auto machine is said as what it is.
    expect(antigravityControl.defaultLevel("auto")).toBe("edits");
    expect(claudeControl.defaultLevel("auto")).toBe("auto");
    expect(codexControl.defaultLevel("safe")).toBe("safe");
  });
});

describe("Codex's models", () => {
  let tmp = "";
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });
  it("the slugs its own picker lists, hidden ones left out, at most 50", () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "sp-models-"));
    expect(codexModels({ CODEX_HOME: tmp })).toEqual([]);
    const cache = (models: unknown) => writeFileSync(path.join(tmp, "models_cache.json"), JSON.stringify({ models }));
    cache([
      { slug: "gpt-6-astra", visibility: "list" },
      { slug: "gpt-reserve", visibility: "hide" },
      { slug: "gpt-5.6-sol", visibility: "list" },
      { slug: "codex-auto-review", visibility: "hide" },
      { slug: "gpt-6-astra", visibility: "list" },
      { slug: "-x", visibility: "list" },
      { slug: 5, visibility: "list" },
      null,
    ]);
    expect(codexModels({ CODEX_HOME: tmp })).toEqual(["gpt-6-astra", "gpt-5.6-sol"]);
    cache(Array.from({ length: 60 }, (_, i) => ({ slug: `m${i}`, visibility: "list" })));
    expect(codexModels({ CODEX_HOME: tmp })).toHaveLength(50);
    cache("not a list");
    expect(codexModels({ CODEX_HOME: tmp })).toEqual([]);
    // No CODEX_HOME: ~/.codex under the home it is given.
    mkdirSync(path.join(tmp, ".codex"));
    writeFileSync(
      path.join(tmp, ".codex", "models_cache.json"),
      JSON.stringify({ models: [{ slug: "o", visibility: "list" }] }),
    );
    expect(codexModels({}, tmp)).toEqual(["o"]);
  });
});
