// SPDX-License-Identifier: Apache-2.0
// Gemini CLI's adapter beyond the fixtures: the hook's edge cases, whether hooks are
// active (tools.enableHooks, or a CLI from 0.46 on), the install notes that says so,
// the chat log reader and the facts it yields. Everything runs in a temp home with a
// fake `gemini` on PATH; the real ~/.gemini is never written.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { geminiCli, geminiHooksActive } from "../src/adapters/gemini-cli.js";
import type { FactsState, HookCommand } from "../src/adapters/types.js";

// The version checks spawn a shell each; under a full parallel run that can take seconds.
vi.setConfig({ testTimeout: 30_000 });

const SID = "a3f2c1d0-5e6b-4f7a-9c8d-1e2f3a4b5c6d";
const cmd: HookCommand = (a) => ({
  argv: ["/usr/local/bin/node", "/opt/sessionpipe/dist/hook.js", ...a],
  command: `"/usr/local/bin/node" "/opt/sessionpipe/dist/hook.js" ${a.join(" ")}`,
});
const noState: FactsState = { get: () => ({}), save: () => {} };
const hook = (event: string, payload: unknown, cwd = "/") =>
  geminiCli.fromHook({
    argv: ["gemini-cli", event],
    stdin: typeof payload === "string" ? payload : JSON.stringify({ session_id: SID, ...(payload as object) }),
    env: {},
    cwd,
  });

let home: string;
let gemini: string;
let settings: string;
let env: NodeJS.ProcessEnv;
const PATH0 = process.env.PATH;
/** A `gemini` on PATH that prints `version` (none when null). */
function fakeGemini(version: string | null) {
  const bin = path.join(home, "bin");
  mkdirSync(bin, { recursive: true });
  rmSync(path.join(bin, "gemini"), { force: true });
  if (version !== null) {
    writeFileSync(path.join(bin, "gemini"), `#!/bin/sh\nprintf '%s' "${version}"\n`);
    chmodSync(path.join(bin, "gemini"), 0o755);
  }
  process.env.PATH = bin;
}
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "sp-gemini-"));
  gemini = path.join(home, ".gemini");
  settings = path.join(gemini, "settings.json");
  mkdirSync(gemini, { recursive: true });
  env = { HOME: home, GEMINI_CLI_HOME: gemini };
});
afterEach(() => {
  process.env.PATH = PATH0;
  rmSync(home, { recursive: true, force: true });
});

describe("gemini-cli fromHook", () => {
  it("needs a session id and a known event; the folder comes from cwd, the transcript from transcript_path", () => {
    expect(hook("SessionStart", "{}")).toBeNull();
    expect(hook("SessionStart", "null")).toBeNull();
    expect(hook("SomethingNew", {})).toBeNull();
    const r = hook("SessionStart", { cwd: "/w", transcript_path: "/t.jsonl", source: "weird" });
    expect(r?.session).toEqual({ id: SID, cwd: "/w" });
    expect(r?.transcript).toBe("/t.jsonl");
    expect(r?.events[0]?.data).toEqual({ source: "unknown" });
    expect(hook("SessionStart", { cwd: 7 }, "/from-argv")?.session.cwd).toBe("/from-argv");
  });
  it("a tool event without a valid tool name is no event", () => {
    expect(hook("BeforeTool", {})?.events).toEqual([]);
    expect(hook("AfterTool", { tool_name: "no spaces allowed" })?.events).toEqual([]);
    expect(hook("BeforeAgent", { prompt: 3 })?.events[0]?.data).toEqual({});
  });
  it("AfterTool: the whole response is the output when it has no llmContent; a long error is cut", () => {
    const r = hook("AfterTool", { tool_name: "t", tool_response: "plain text" });
    expect(r?.events[0]?.data).toEqual({ tool: "t", ok: true, output: "plain text" });
    const err = hook("AfterTool", { tool_name: "t", tool_response: { error: "x".repeat(3000) } });
    expect(err!.events[0]!.data.error).toHaveLength(2000);
    expect(hook("AfterTool", { tool_name: "t", tool_response: { error: "" } })?.events[0]?.data.ok).toBe(true);
  });
  it("Notification: anything but ToolPermission is a question; a long message is cut, a missing one absent", () => {
    const q = hook("Notification", { notification_type: "Other", message: "m".repeat(300) });
    expect(q?.events[0]?.data).toMatchObject({ kind: "question" });
    expect(q!.events[0]!.data.message).toHaveLength(200);
    expect(q?.events[0]?.data.attention_id).toMatch(/^notif-\d+$/);
    expect(hook("Notification", {})?.events[0]?.data).not.toHaveProperty("message");
  });
  it("PreCompress defaults to auto; SessionEnd keeps clear, logout and exit, folds the rest", () => {
    expect(hook("PreCompress", {})?.events[0]?.data).toEqual({ trigger: "auto" });
    for (const [reason, want] of [
      ["clear", "clear"],
      ["logout", "logout"],
      ["exit", "exit"],
      ["prompt_input_exit", "exit"],
      ["crash", "other"],
      [undefined, "other"],
    ])
      expect(hook("SessionEnd", { reason })?.events[0]?.data).toEqual({ reason: want });
  });
});

describe("gemini-cli hooks active?", () => {
  it("tools.enableHooks in settings.json decides outright", () => {
    writeFileSync(settings, JSON.stringify({ tools: { enableHooks: true } }));
    expect(geminiHooksActive(settings)).toEqual({ active: true });
    writeFileSync(settings, JSON.stringify({ tools: { enableHooks: false } }));
    expect(geminiHooksActive(settings)).toEqual({
      active: false,
      note: "inactive: tools.enableHooks is false in settings.json",
    });
  });
  it.runIf(process.platform !== "win32")(
    "else the CLI's version: 0.46 and 1.x run hooks, 0.45 does not, no answer is a note",
    () => {
      fakeGemini("0.46.1");
      expect(geminiHooksActive(settings)).toEqual({ active: true });
      fakeGemini("1.0.0");
      expect(geminiHooksActive(settings)).toEqual({ active: true });
      fakeGemini("0.45.2");
      expect(geminiHooksActive(settings)).toEqual({
        active: false,
        note: 'inactive: Gemini CLI 0.45.2 runs hooks only with "tools": {"enableHooks": true} in settings.json',
      });
      fakeGemini("");
      expect(geminiHooksActive(settings).note).toContain("Gemini CLI ?");
      fakeGemini(null);
      expect(geminiHooksActive(settings)).toEqual({
        active: true,
        note: "could not run `gemini --version`; hooks need tools.enableHooks on versions before 0.46",
      });
      writeFileSync(settings, "{ not json");
      expect(geminiHooksActive(settings).active).toBe(true);
    },
  );
});

describe("gemini-cli install and installed", () => {
  it.runIf(process.platform !== "win32")(
    "install carries the activity note; installed is inactive on an old CLI",
    () => {
      fakeGemini("0.45.0");
      const r = geminiCli.install(cmd, env)[0]!;
      expect(r.changed).toBe(true);
      expect(r.note).toContain("inactive: Gemini CLI 0.45.0");
      const i = geminiCli.installed(cmd, env)[0]!;
      expect(i).toMatchObject({ file: settings, state: "inactive" });
      expect(i.note).toContain("inactive");
      fakeGemini("0.46.0");
      expect(geminiCli.installed(cmd, env)).toEqual([{ file: settings, state: "current" }]);
      expect(geminiCli.install(cmd, env)).toEqual([{ file: settings, changed: false, created: false }]);
      expect(geminiCli.installed(cmd, env, { lean: true })[0]?.state).toBe("stale");
      geminiCli.uninstall(env, { created: [settings] });
      expect(geminiCli.installed(cmd, env)[0]?.state).toBe("missing");
    },
  );
  it.runIf(process.platform !== "win32")("a lean install skips BeforeTool", () => {
    fakeGemini("1.0.0");
    geminiCli.install(cmd, env, { lean: true });
    const s = JSON.parse(readFileSync(settings, "utf8"));
    expect(s.hooks.BeforeTool).toBeUndefined();
    expect(s.hooks.AfterTool).toBeDefined();
    expect(geminiCli.installed(cmd, env, { lean: true })[0]?.state).toBe("current");
  });
  it("detects its settings or its chat logs, and names its one config file", () => {
    expect(geminiCli.detect(env)).toBe(false);
    mkdirSync(path.join(gemini, "tmp"));
    expect(geminiCli.detect(env)).toBe(true);
    expect(geminiCli.configFiles(env)).toEqual([settings]);
    expect(typeof geminiCli.detect()).toBe("boolean");
    expect(geminiCli.configFiles()).toHaveLength(1);
    expect(geminiCli.backfill(0, env)).toEqual([]);
  });
});

describe("gemini-cli transcript and facts", () => {
  const LOG = [
    JSON.stringify({ type: "user", timestamp: "2026-10-05T14:22:11.000Z", content: "List the files in this folder" }),
    JSON.stringify({ type: "gemini", timestamp: "2026-10-05T14:22:14.000Z", content: "Two: a.txt and b.txt." }),
    JSON.stringify({ type: "user", timestamp: "2026-10-05T14:23:00.000Z", message: "Thanks" }),
    JSON.stringify({ type: "model", timestamp: "2026-10-05T14:23:02.000Z", text: "Any time." }),
  ];
  it("reads turns, and a missing file as none", () => {
    const file = path.join(home, "session.jsonl");
    writeFileSync(file, `${LOG.join("\n")}\n`);
    expect(geminiCli.readTranscript(file, 0).turns.map((t) => [t.user, t.assistant])).toEqual([
      ["List the files in this folder", "Two: a.txt and b.txt."],
      ["Thanks", "Any time."],
    ]);
    expect(geminiCli.readTranscript(path.join(home, "none.jsonl"), 2)).toEqual({ turns: [], line: 2 });
  });
  it("titles after the first user record, whichever field holds it, with the first and last times", () => {
    const file = path.join(home, "session.jsonl");
    writeFileSync(file, `${LOG.join("\n")}\n`);
    expect(geminiCli.facts({ id: SID }, file, {}, noState)).toEqual({
      title: "List the files in this folder",
      title_source: "first-ask",
      started_at: Date.parse("2026-10-05T14:22:11.000Z"),
      last_at: Date.parse("2026-10-05T14:23:02.000Z"),
    });
    expect(geminiCli.facts({ id: SID }, undefined, {}, noState)).toEqual({});
    writeFileSync(
      file,
      `${[
        JSON.stringify({ type: "gemini", content: "hello" }),
        JSON.stringify({ type: "user", content: ["not", "a", "string"] }),
      ].join("\n")}\n`,
    );
    expect(geminiCli.facts({ id: SID }, file, {}, noState)).toEqual({});
    writeFileSync(file, `${JSON.stringify({ type: "user", message: "from message" })}\n`);
    expect(geminiCli.facts({ id: SID }, file, {}, noState).title).toBe("from message");
    writeFileSync(file, `${JSON.stringify({ type: "user", text: `\n\n${"word ".repeat(30)}end` })}\n`);
    const long = geminiCli.facts({ id: SID }, file, {}, noState);
    expect(long.title?.endsWith("…")).toBe(true);
    expect(long.title?.length).toBeLessThanOrEqual(81);
  });
});
