// SPDX-License-Identifier: Apache-2.0
// The Autopilot adapter: where its hooks go (Autopilot's own settings shape), how a payload
// maps, the transcript it reads for tier 2 and the facts it reads from it. Payloads are the
// ones recorded from Autopilot (conformance/harness/autopilot), cut to what a test reads.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AUTOPILOT_EVENTS,
  autopilot,
  autopilotConfigDir,
  isAutopilotPayload,
  protocolId,
} from "../src/adapters/autopilot.js";
import { claudeCode, notClaudeCode } from "../src/adapters/claude-code.js";
import { adapterByName } from "../src/adapters/index.js";
import type { HookCommand } from "../src/adapters/types.js";

const cmd: HookCommand = (a) => ({
  argv: ["/usr/local/bin/node", "/opt/sessionpipe/dist/hook.js", ...a],
  command: `"/usr/local/bin/node" "/opt/sessionpipe/dist/hook.js" ${a.join(" ")}`,
});
const cmd2: HookCommand = (a) => ({
  argv: ["/new/node", "/new/sessionpipe/dist/hook.js", ...a],
  command: `"/new/node" "/new/sessionpipe/dist/hook.js" ${a.join(" ")}`,
});

const RAW_ID = "2026-11-18T02-41-18-962Z_work-read-note-txt-run-ls-write-out-txt";
const ID = "2026-11-18T02-41-18-962Z.work-read-note-txt-run-ls-write-out-txt";
let home: string;
let env: NodeJS.ProcessEnv;
let file: string;

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "sp-autopilot-"));
  // Its own HOME and XDG_CONFIG_HOME: nothing here may reach the real ~/.config/autopilot.
  env = { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") };
  file = autopilot.configFiles(env)[0] as string;
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** What Autopilot puts in every payload. */
const common = (event: string, more: Record<string, unknown> = {}) => ({
  event,
  hook_event_name: event,
  session_id: RAW_ID,
  cwd: "/home/rec/ap-proj",
  client: "autopilot",
  "beacon.harness.name": "autopilot",
  autopilot_version: "3.27.0",
  hook_payload_version: 1,
  transcript_path: `/home/rec/.local/share/autopilot/sessions/${RAW_ID}.jsonl`,
  transcript_format: "claude-jsonl",
  ...more,
});
const hook = (event: string, payload: unknown, cwd = "/elsewhere") =>
  autopilot.fromHook({
    argv: ["autopilot", event],
    stdin: typeof payload === "string" ? payload : JSON.stringify(payload),
    env: {},
    cwd,
  });
const read = () => JSON.parse(readFileSync(file, "utf8"));

describe("autopilot: where it lives", () => {
  it("is ~/.config/autopilot, or under XDG_CONFIG_HOME, and is here once that folder is", () => {
    expect(autopilotConfigDir(env)).toBe(path.join(home, ".config", "autopilot"));
    expect(autopilotConfigDir({ XDG_CONFIG_HOME: " /x ", HOME: "/h" })).toBe(path.join("/x", "autopilot"));
    expect(autopilotConfigDir({ XDG_CONFIG_HOME: " ", HOME: "/h" })).toBe(path.join("/h", ".config", "autopilot"));
    expect(autopilotConfigDir({})).toBe(path.join(os.homedir(), ".config", "autopilot"));
    expect(typeof autopilotConfigDir()).toBe("string");
    expect(autopilot.detect(env)).toBe(false);
    mkdirSync(path.join(home, ".config", "autopilot"), { recursive: true });
    expect(autopilot.detect(env)).toBe(true);
    expect(typeof autopilot.detect()).toBe("boolean");
    expect(autopilot.configFiles()).toHaveLength(1);
    expect(file).toBe(path.join(home, ".config", "autopilot", "settings.json"));
    expect(autopilot.events).toBe(AUTOPILOT_EVENTS);
    expect(adapterByName("autopilot")).toBe(autopilot);
  });
});

describe("autopilot: install / uninstall / installed", () => {
  it("writes one flat entry per event, id sessionpipe, timeouts in ms, and removes it again", () => {
    expect(autopilot.installed(cmd, env)[0]).toEqual({ file, state: "missing" });
    const r = autopilot.install(cmd, env);
    expect(r[0]).toMatchObject({ file, changed: true, created: true });
    const f = read();
    expect(Object.keys(f.hooks).sort()).toEqual([...AUTOPILOT_EVENTS].sort());
    expect(f.hooks.Stop).toEqual([
      {
        id: "sessionpipe",
        command: `"/usr/local/bin/node" "/opt/sessionpipe/dist/hook.js" autopilot Stop`,
        timeoutMs: 5000,
      },
    ]);
    // PostToolUseFailure fires beside PostToolUse for the same call: not hooked.
    expect(f.hooks.PostToolUseFailure).toBeUndefined();
    expect(autopilot.install(cmd, env)[0]).toEqual({ file, changed: false });
    expect(autopilot.installed(cmd, env)[0]).toEqual({ file, state: "current" });
    expect(autopilot.installed(cmd2, env)[0]?.state).toBe("stale");
    // A new node path replaces our entry, in place of a second one.
    expect(autopilot.install(cmd2, env)[0]?.changed).toBe(true);
    expect(read().hooks.Stop).toHaveLength(1);
    expect(autopilot.uninstall(env, { created: [file] })[0]?.changed).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(autopilot.uninstall(env)[0]).toEqual({ file, changed: false });
  });

  it("keeps everyone else's hooks and settings, and its own file's shape", () => {
    mkdirSync(path.dirname(file), { recursive: true });
    const theirs = { id: "beacon-stop", command: "beacon-hooks --platform claude stop" };
    writeFileSync(
      file,
      `${JSON.stringify({ theme: "dark", hooks: { Stop: [theirs], Custom: "not a list", PreToolUse: [null, "x"] } }, null, 4)}\n`,
    );
    expect(autopilot.install(cmd, env)[0]).toMatchObject({ changed: true, created: false });
    const raw = readFileSync(file, "utf8");
    expect(raw).toMatch(/^ {4}"theme"/m);
    const f = JSON.parse(raw);
    expect(f.theme).toBe("dark");
    expect(f.hooks.Stop[0]).toEqual(theirs);
    expect(f.hooks.Stop[1].id).toBe("sessionpipe");
    expect(f.hooks.PreToolUse.slice(0, 2)).toEqual([null, "x"]);
    expect(autopilot.installed(cmd, env)[0]?.state).toBe("current");
    expect(autopilot.uninstall(env)[0]?.changed).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      theme: "dark",
      hooks: { Stop: [theirs], Custom: "not a list", PreToolUse: [null, "x"] },
    });
  });

  it("knows an entry of ours by its id, or by our hook command under another id", () => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        hooks: {
          Stop: [{ id: "renamed", command: cmd(["autopilot", "Stop"]).command }],
          SessionEnd: [{ id: "x", command: 7 }],
        },
      }),
    );
    expect(autopilot.installed(cmd, env)[0]?.state).toBe("stale");
    autopilot.install(cmd, env);
    const f = read();
    expect(f.hooks.Stop).toHaveLength(1);
    expect(f.hooks.Stop[0].id).toBe("sessionpipe");
    expect(f.hooks.SessionEnd).toHaveLength(2);
  });

  it("a lean install hooks no PreToolUse, and a full one after it is stale until reinstalled", () => {
    autopilot.install(cmd, env);
    expect(autopilot.install(cmd, env, { lean: true })[0]?.changed).toBe(true);
    expect(read().hooks.PreToolUse).toBeUndefined();
    expect(autopilot.installed(cmd, env, { lean: true })[0]?.state).toBe("current");
    expect(autopilot.installed(cmd, env)[0]?.state).toBe("stale");
    // Someone else's PreToolUse hook survives a lean install.
    autopilot.install(cmd, env);
    const f = read();
    f.hooks.PreToolUse.unshift({ id: "guard", command: "guard.sh" });
    writeFileSync(file, JSON.stringify(f));
    autopilot.install(cmd, env, { lean: true });
    expect(read().hooks.PreToolUse).toEqual([{ id: "guard", command: "guard.sh" }]);
    // A full install's entries read as stray to a lean check.
    autopilot.install(cmd, env);
    expect(autopilot.installed(cmd, env, { lean: true })[0]?.state).toBe("stale");
  });

  it("switched off in Autopilot (/hooks disable sessionpipe) is inactive, and a reinstall keeps it off", () => {
    autopilot.install(cmd, env);
    const f = read();
    for (const list of Object.values(f.hooks) as { enabled?: boolean }[][]) list[0]!.enabled = false;
    writeFileSync(file, JSON.stringify(f));
    expect(autopilot.installed(cmd, env)[0]).toEqual({
      file,
      state: "inactive",
      note: "switched off in Autopilot (/hooks enable sessionpipe)",
    });
    // Nothing to change: the entries are current, only off.
    expect(autopilot.install(cmd, env)[0]?.changed).toBe(false);
    // A new node path rewrites them, still off: the person's switch is theirs to undo.
    expect(autopilot.install(cmd2, env)[0]?.changed).toBe(true);
    expect(read().hooks.Stop).toEqual([
      { id: "sessionpipe", command: cmd2(["autopilot", "Stop"]).command, timeoutMs: 5000, enabled: false },
    ]);
    expect(autopilot.installed(cmd2, env)[0]?.state).toBe("inactive");
    // Stale wins over off: the entries need rewriting first.
    expect(autopilot.installed(cmd, env)[0]?.state).toBe("stale");
  });

  it("an entry of ours on an event it doesn't hook is stale", () => {
    autopilot.install(cmd, env);
    const f = read();
    f.hooks.PostToolUseFailure = [{ id: "sessionpipe", command: "old", enabled: false }];
    writeFileSync(file, JSON.stringify(f));
    expect(autopilot.installed(cmd, env)[0]?.state).toBe("stale");
    autopilot.install(cmd, env);
    expect(read().hooks.PostToolUseFailure).toBeUndefined();
  });

  it("never touches a file that is not plain JSON, nor one whose hooks are not an object", () => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "{ // a comment\n}");
    expect(autopilot.install(cmd, env)[0]).toMatchObject({ changed: false, skipped: true });
    expect(autopilot.uninstall(env)[0]).toMatchObject({ changed: false, skipped: true });
    expect(autopilot.installed(cmd, env)[0]?.state).toBe("missing");
    writeFileSync(file, JSON.stringify({ hooks: "nope" }));
    expect(autopilot.uninstall(env)[0]).toEqual({ file, changed: false });
    expect(autopilot.installed(cmd, env)[0]?.state).toBe("missing");
    expect(autopilot.install(cmd, env)[0]?.changed).toBe(true);
    expect(Object.keys(read().hooks)).toHaveLength(AUTOPILOT_EVENTS.length);
    writeFileSync(file, JSON.stringify({ hooks: { Stop: [{ id: "theirs", command: "x" }] } }));
    expect(autopilot.uninstall(env)[0]).toEqual({ file, changed: false });
  });

  it("a file it can't write is reported, not thrown", () => {
    // The config folder is a file: neither the folder nor the settings can be made.
    writeFileSync(path.join(home, "cfg"), "");
    const bad = { HOME: home, XDG_CONFIG_HOME: path.join(home, "cfg") };
    expect(autopilot.install(cmd, bad)[0]).toMatchObject({ changed: false, skipped: true });
  });

  it("installs with the process's own environment when none is given", () => {
    const was = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = path.join(home, "own");
    try {
      expect(autopilot.install(cmd)[0]?.created).toBe(true);
      expect(autopilot.installed(cmd)[0]?.state).toBe("current");
      expect(autopilot.uninstall()[0]?.changed).toBe(true);
    } finally {
      if (was === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = was;
    }
  });
});

describe("autopilot: a payload becomes events", () => {
  it("only Autopilot's own payload, with an id the protocol can carry", () => {
    expect(isAutopilotPayload({ client: "autopilot" })).toBe(true);
    expect(isAutopilotPayload({ "beacon.harness.name": "autopilot" })).toBe(false);
    expect(hook("Stop", { ...common("Stop"), client: "claude-code" })).toBeNull();
    expect(hook("Stop", "not json")).toBeNull();
    expect(hook("Stop", "null")).toBeNull();
    expect(hook("Stop", "[]")).toBeNull();
    expect(hook("Stop", "")).toBeNull();
    expect(hook("Stop", { ...common("Stop"), session_id: "" })).toBeNull();
    expect(hook("Stop", { ...common("Stop"), session_id: 7 })).toBeNull();
    expect(hook("Stop", { ...common("Stop"), session_id: "a b" })).toBeNull();
    expect(hook("Stop", { ...common("Stop"), session_id: "x".repeat(129) })).toBeNull();
    expect(hook("Nope", common("Nope"))).toBeNull();
    expect(
      autopilot.fromHook({ argv: ["autopilot"], stdin: JSON.stringify(common("Stop")), env: {}, cwd: "/" }),
    ).toBeNull();
  });

  it("writes Autopilot's `_` as `.`, which its ids never hold", () => {
    expect(protocolId(RAW_ID)).toBe(ID);
    expect(protocolId("0b6c4a1e-2f7d-4c3e-9a51-7d2c8e0f1b23")).toBe("0b6c4a1e-2f7d-4c3e-9a51-7d2c8e0f1b23");
    expect(hook("Stop", common("Stop"))?.session.id).toBe(ID);
  });

  it("a session starts new or resumed, with its model, and ends", () => {
    expect(hook("SessionStart", common("SessionStart", { source: "startup", model: "m/x" }))).toMatchObject({
      session: { id: ID, cwd: "/home/rec/ap-proj", model: "m/x" },
      events: [{ type: "session.started", data: { source: "startup" }, harnessEvent: "SessionStart" }],
    });
    const resumed = hook("SessionStart", common("SessionStart", { source: "resume", model: "" }));
    expect(resumed?.events[0]?.data).toEqual({ source: "resume" });
    expect(resumed?.session.model).toBeUndefined();
    // A model on any other event is not the session's (none is sent there today).
    expect(hook("Stop", common("Stop", { model: "m/y" }))?.session.model).toBeUndefined();
    const end = (reason: unknown) => hook("SessionEnd", common("SessionEnd", { reason }))?.events[0]?.data;
    expect(end("exit")).toEqual({ reason: "exit" });
    expect(end("clear")).toEqual({ reason: "clear" });
    expect(end("something new")).toEqual({ reason: "other" });
  });

  it("a prompt starts a turn; its words ride as a hint only", () => {
    const r = hook("UserPromptSubmit", common("UserPromptSubmit", { prompt: "héllo 👋", tier: "light" }));
    expect(r?.events).toEqual([{ type: "turn.started", data: { prompt_chars: 7 }, harnessEvent: "UserPromptSubmit" }]);
    expect(r?.hints).toEqual({ prompt: "héllo 👋", version: "3.27.0" });
    const bare = hook("UserPromptSubmit", common("UserPromptSubmit", { prompt: 3 }));
    expect(bare?.events[0]?.data).toEqual({});
    expect(bare?.hints).toEqual({ version: "3.27.0" });
  });

  it("a tool starts and ends, ok or failed, under Claude Code's name", () => {
    const pre = hook(
      "PreToolUse",
      common("PreToolUse", { tool_name: "Bash", tool_use_id: "call_1", tool_input: { command: "ls" } }),
    );
    expect(pre?.events).toEqual([
      {
        type: "tool.started",
        data: { tool: "Bash", call_id: "call_1", input: { command: "ls" } },
        harnessEvent: "PreToolUse",
      },
    ]);
    const ok = hook(
      "PostToolUse",
      common("PostToolUse", {
        tool_name: "Read",
        tool_use_id: "call_0",
        tool_input: { file_path: "/a" },
        tool_response: { ok: true, content: "1\tx", success: true, is_error: false },
      }),
    );
    expect(ok?.events[0]?.data).toEqual({
      tool: "Read",
      call_id: "call_0",
      ok: true,
      input: { file_path: "/a" },
      output: { ok: true, content: "1\tx", success: true, is_error: false },
    });
    const failed = hook(
      "PostToolUse",
      common("PostToolUse", {
        tool_name: "Bash",
        tool_input: { command: "cat missing" },
        tool_response: { ok: true, is_error: true },
        error: `Exit code 1\n${"e".repeat(3000)}`,
      }),
    );
    expect(failed?.events[0]?.data).toMatchObject({ tool: "Bash", ok: false });
    expect(String(failed?.events[0]?.data.error).length).toBe(2000);
    // A failure with no text, and a call with no response at all: nothing guessed.
    expect(
      hook("PostToolUse", common("PostToolUse", { tool_name: "Bash", tool_response: { is_error: true } }))?.events[0]
        ?.data,
    ).toEqual({ tool: "Bash", ok: false, output: { is_error: true } });
    expect(hook("PostToolUse", common("PostToolUse", { tool_name: "x" }))?.events[0]?.data).toEqual({
      tool: "x",
      ok: true,
    });
    // No tool name the protocol can carry: no tool event.
    expect(hook("PreToolUse", common("PreToolUse", { tool_name: "a b" }))?.events).toEqual([]);
    expect(hook("PostToolUse", common("PostToolUse"))?.events).toEqual([]);
    // PostToolUseFailure is not hooked; if it arrives anyway, it reports nothing.
    expect(hook("PostToolUseFailure", common("PostToolUseFailure", { tool_name: "Bash" }))).toBeNull();
  });

  it("a permission prompt needs the person, named by the call's id", () => {
    const r = hook(
      "PermissionRequest",
      common("PermissionRequest", {
        tool_name: "Write",
        tool_use_id: "call_2",
        tool_input: { file_path: "/a/out.txt", content: "done" },
        permission_mode: "default",
      }),
    );
    expect(r?.events).toEqual([
      {
        type: "attention.needed",
        data: { attention_id: "call_2", kind: "permission", tool: "Write", message: "Write /a/out.txt" },
        harnessEvent: "PermissionRequest",
      },
    ]);
    const msg = (tool_input: unknown) =>
      hook("PermissionRequest", common("PermissionRequest", { tool_name: "T", tool_use_id: "c", tool_input }))
        ?.events[0]?.data.message;
    expect(msg({ command: "x".repeat(200) })).toBe(`T ${"x".repeat(120)}`);
    expect(msg({ url: "https://e.x" })).toBe("T https://e.x");
    expect(msg({ pattern: "*.ts" })).toBe("T *.ts");
    expect(msg({ query: "q" })).toBe("T q");
    expect(msg({ path: "/p" })).toBe("T /p");
    expect(msg({ other: 1 })).toBe("T");
    expect(msg("text")).toBe("T");
    expect(msg(null)).toBe("T");
    // No call id and no tool: an id is minted, nothing else guessed.
    const bare = hook("PermissionRequest", common("PermissionRequest"));
    expect(bare?.events[0]?.data).toEqual({ attention_id: expect.stringMatching(/^perm-\d+$/), kind: "permission" });
  });

  it("a turn ends: Stop, or StopFailure interrupted or failed", () => {
    const stop = hook("Stop", common("Stop", { last_assistant_message: "Done." }));
    expect(stop?.events).toEqual([{ type: "turn.ended", data: { reason: "stop" }, harnessEvent: "Stop" }]);
    expect(stop?.hints).toEqual({ final: "Done.", version: "3.27.0" });
    expect(hook("Stop", common("Stop", { last_assistant_message: "  " }))?.hints).toEqual({ version: "3.27.0" });
    const fail = (more: Record<string, unknown>) => hook("StopFailure", common("StopFailure", more))?.events[0]?.data;
    expect(fail({ error: "interrupted", is_interrupt: true })).toEqual({ reason: "interrupt" });
    expect(fail({ error: "model_error", is_interrupt: false })).toEqual({ reason: "error", error: "model_error" });
    expect(fail({ error: "x".repeat(300) })).toEqual({ reason: "error", error: "x".repeat(200) });
    expect(fail({})).toEqual({ reason: "error" });
  });

  it("a compaction says what started it", () => {
    expect(hook("PreCompact", common("PreCompact", { trigger: "manual" }))?.events[0]).toEqual({
      type: "context.compacted",
      data: { trigger: "manual" },
      harnessEvent: "PreCompact",
    });
    expect(hook("PreCompact", common("PreCompact", { trigger: "auto" }))?.events[0]?.data).toEqual({ trigger: "auto" });
    // An Autopilot before `trigger`: its PreCompact fired only for auto-compaction.
    expect(hook("PreCompact", common("PreCompact"))?.events[0]?.data).toEqual({ trigger: "auto" });
  });

  it("names the Claude Code-format transcript only, and the folder the hook ran in when the payload has none", () => {
    expect(hook("Stop", common("Stop"))?.transcript).toBe(`/home/rec/.local/share/autopilot/sessions/${RAW_ID}.jsonl`);
    expect(
      hook("Stop", common("Stop", { transcript_format: "autopilot-json", transcript_path: "/s.json" }))?.transcript,
    ).toBeUndefined();
    expect(hook("Stop", common("Stop", { transcript_path: "" }))?.transcript).toBeUndefined();
    const { cwd: _cwd, ...noCwd } = common("Stop");
    expect(hook("Stop", noCwd, "/hook/ran/here")?.session.cwd).toBe("/hook/ran/here");
    // A version that isn't one is not passed on.
    expect(hook("Stop", common("Stop", { autopilot_version: "../x" }))?.hints).toEqual({});
    expect(hook("Stop", common("Stop", { autopilot_version: 3 }))?.hints).toEqual({});
  });

  it("Claude Code's entry, run inside Autopilot, stays out", () => {
    const s = common("Stop");
    expect(notClaudeCode(RAW_ID, s)).toBe(true);
    expect(
      claudeCode.fromHook({ argv: ["claude-code", "Stop"], stdin: JSON.stringify(s), env: {}, cwd: "/" }),
    ).toBeNull();
  });
});

describe("autopilot: transcript and facts", () => {
  const lines = (rows: unknown[]) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
  const base = { sessionId: RAW_ID, cwd: "/a", isSidechain: false, userType: "external", entrypoint: "autopilot" };
  const rows = [
    {
      ...base,
      type: "user",
      message: { role: "user", content: "fix the bug" },
      promptId: "p1",
      timestamp: "2026-11-18T02:41:19.100Z",
    },
    {
      ...base,
      type: "assistant",
      message: { role: "assistant", model: "m/a", content: [{ type: "text", text: "Fixed." }] },
      timestamp: "2026-11-18T02:41:21.000Z",
    },
  ];

  it("reads Claude Code's JSONL for tier 2", () => {
    const t = path.join(home, "t.jsonl");
    writeFileSync(t, lines(rows));
    const r = autopilot.readTranscript(t, 0);
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0]).toMatchObject({ user: "fix the bug", assistant: "Fixed.", id: "p1" });
    expect(autopilot.readTranscript(path.join(home, "missing.jsonl"), 3)).toEqual({ turns: [], line: 3 });
  });

  it("facts: the version from the hook, title, model and times from the transcript", () => {
    const t = path.join(home, "t.jsonl");
    writeFileSync(t, lines(rows));
    const state = { get: () => ({}), save: () => {} };
    expect(autopilot.facts({ id: ID }, t, { version: "3.27.0" }, state)).toEqual({
      harness_version: "3.27.0",
      title: "fix the bug",
      title_source: "first-ask",
      model: "m/a",
      started_at: Date.parse("2026-11-18T02:41:19.100Z"),
      last_at: Date.parse("2026-11-18T02:41:21.000Z"),
    });
    expect(autopilot.facts({ id: ID }, undefined, {}, state)).toEqual({});
    // A long first line is cut at a word; a prompt that is not a string (images) is no title.
    writeFileSync(
      t,
      lines([
        { ...base, type: "user", message: { role: "user", content: [{ type: "text", text: "x" }] } },
        { ...base, type: "user", message: { role: "user", content: `  ${"word ".repeat(30)}\nsecond line` } },
        { ...base, type: "assistant", message: { role: "assistant", content: [] } },
        { ...base, type: "user" },
      ]),
    );
    const f = autopilot.facts({ id: ID }, t, {}, state);
    expect(f.title?.endsWith("…")).toBe(true);
    expect((f.title as string).length).toBeLessThanOrEqual(81);
    expect(f.model).toBeUndefined();
    expect(f.started_at).toBeUndefined();
    // No transcript at all: nothing but the version.
    expect(autopilot.facts({ id: ID }, path.join(home, "none.jsonl"), { version: "1.0.0" }, state)).toEqual({
      harness_version: "1.0.0",
    });
  });

  it("has no backfill yet", () => {
    expect(autopilot.backfill(0)).toEqual([]);
  });
});
