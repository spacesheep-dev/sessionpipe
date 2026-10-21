// SPDX-License-Identifier: Apache-2.0
// Antigravity's adapter beyond the fixtures: the hook's edge cases, the transcript
// reader, facts (title, remote URL through the installation id and the projects
// registry), backfill from the data dirs, and the hooks.json paths install can take.
// Everything runs in a temp home; the real ~/.gemini is never written.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agMatchProject,
  agPath,
  agWorkspaces,
  antigravity,
  antigravityFacts,
  antigravityRemoteUrl,
} from "../src/adapters/antigravity.js";
import type { FactsState, HookCommand } from "../src/adapters/types.js";

const CONV = "6f1c2a9e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
const INSTALL = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const cmd: HookCommand = (a) => ({
  argv: ["/usr/local/bin/node", "/opt/sessionpipe/dist/hook.js", ...a],
  command: `"/usr/local/bin/node" "/opt/sessionpipe/dist/hook.js" ${a.join(" ")}`,
});
const noState: FactsState = { get: () => ({}), save: () => {} };
const hook = (event: string, payload: unknown, cwd = "/") =>
  antigravity.fromHook({
    argv: ["antigravity", event],
    stdin: typeof payload === "string" ? payload : JSON.stringify(payload),
    env: {},
    cwd,
  });

let home: string;
let gemini: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "sp-ag-"));
  gemini = path.join(home, ".gemini");
  env = { HOME: home, GEMINI_CLI_HOME: gemini };
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** A data dir with one conversation's transcript, its installation id, and a project. */
function dataDir(name = "antigravity", lines: string[] = TRANSCRIPT): string {
  const data = path.join(gemini, name);
  const logs = path.join(data, "brain", CONV, ".system_generated", "logs");
  mkdirSync(logs, { recursive: true });
  writeFileSync(path.join(logs, "transcript.jsonl"), `${lines.join("\n")}\n`);
  writeFileSync(path.join(data, "antigravity_state.pbtxt"), `version: 3\ninstallation_uuid: "${INSTALL}"\n`);
  return path.join(logs, "transcript.jsonl");
}
const TRANSCRIPT = [
  JSON.stringify({
    type: "USER_INPUT",
    created_at: "2026-10-05T10:00:00.000Z",
    content: "<USER_REQUEST>\nAdd a README to this project\n</USER_REQUEST>",
  }),
  JSON.stringify({ type: "PLANNER_RESPONSE", created_at: "2026-10-05T10:00:04.000Z", content: "Adding one now." }),
  JSON.stringify({ type: "TOOL_CALL", created_at: "2026-10-05T10:00:05.000Z", content: { name: "write_file" } }),
  JSON.stringify({ type: "PLANNER_RESPONSE", timestamp: "2026-10-05T10:00:09.000Z", content: "Done." }),
];
function project(id: string, folders: string[]) {
  const dir = path.join(gemini, "config", "projects");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({ projectResources: { resources: folders.map((f) => ({ folderUri: f })) } }),
  );
}

describe("antigravity fromHook", () => {
  it("answers {} with no session when the payload names no conversation", () => {
    expect(hook("Stop", {})).toEqual({ session: { id: "" }, events: [], stdout: "{}\n" });
    expect(hook("Stop", "")).toEqual({ session: { id: "" }, events: [], stdout: "{}\n" });
    expect(hook("Stop", "null")).toEqual({ session: { id: "" }, events: [], stdout: "{}\n" });
  });
  it("takes the id from conversationId, session_id or sessionId, the folder from the first workspace", () => {
    expect(hook("Stop", { session_id: "s1" })?.session).toEqual({ id: "s1", cwd: "/" });
    expect(hook("Stop", { sessionId: "s2" }, "/work")?.session).toEqual({ id: "s2", cwd: "/work" });
    const r = hook("Stop", {
      conversationId: CONV,
      workspacePaths: ["file:///a/b", "/a/b", "relative", "https://x.test/y", 3, "file:///c"],
      modelName: "gemini-3-pro",
      transcriptPath: "/t.jsonl",
    });
    // A workspace path is resolved by the host OS (D:\a\b on Windows), so the expectation is too.
    expect(r?.session).toEqual({ id: CONV, cwd: path.resolve("/a/b"), model: "gemini-3-pro" });
    expect(r?.hints).toEqual({ workspaces: [path.resolve("/a/b"), path.resolve("/c")] });
    expect(r?.transcript).toBe("/t.jsonl");
    expect(hook("Stop", { conversationId: CONV, modelName: "auto" })?.session.model).toBeUndefined();
  });
  it("PreInvocation without an invocationNum is the first; PostInvocation says nothing", () => {
    expect(hook("PreInvocation", { conversationId: CONV })?.events.map((e) => e.type)).toEqual([
      "session.started",
      "turn.started",
    ]);
    expect(hook("PreInvocation", { conversationId: CONV, invocationNum: "2" })?.events.map((e) => e.type)).toEqual([
      "session.heartbeat",
    ]);
    const post = hook("PostInvocation", { conversationId: CONV, invocationNum: 0 });
    expect(post?.events).toEqual([]);
    expect(post?.stdout).toBe("{}\n");
  });
  it("an event it never registered still gets {} and no events", () => {
    expect(hook("SomethingNew", { conversationId: CONV })).toEqual({
      session: { id: CONV, cwd: "/" },
      events: [],
      stdout: "{}\n",
    });
  });
  it("a tool name may also come as toolName; an invalid one is no tool", () => {
    expect(hook("PostToolUse", { conversationId: CONV, toolName: "view_file" })?.events[0]).toMatchObject({
      type: "tool.ended",
      data: { tool: "view_file", ok: true },
    });
    expect(hook("PostToolUse", { conversationId: CONV, toolName: "bad tool!" })?.events[0]?.type).toBe(
      "session.heartbeat",
    );
    expect(hook("PreToolUse", { conversationId: CONV, toolCall: { name: "" } })?.events).toEqual([]);
    const long = hook("PostToolUse", {
      conversationId: CONV,
      toolCall: { name: "run_command" },
      error: "x".repeat(3000),
    });
    expect(long!.events[0]!.data.error).toHaveLength(2000);
    expect(
      hook("PostToolUse", { conversationId: CONV, toolCall: { name: "run_command" }, error: 7 })?.events[0]?.data,
    ).toEqual({
      tool: "run_command",
      ok: false,
    });
  });
});

describe("antigravity paths", () => {
  it("agPath: file URIs and absolute paths only", () => {
    expect(agPath("file:///Users/dev/a%20b")).toBe(path.resolve("/Users/dev/a b"));
    expect(agPath("/x/../y")).toBe(path.resolve("/y"));
    expect(agPath("file:///%E0%A4%A")).toBeNull();
    expect(agPath("https://example.test/repo")).toBeNull();
    expect(agPath("relative/dir")).toBeNull();
    expect(agPath("")).toBeNull();
    expect(agPath(42)).toBeNull();
    expect(agWorkspaces("not a list")).toEqual([]);
  });
  it("agMatchProject: the deepest folder that holds the workspace wins", () => {
    const projects = [
      // Folders come from agProjects already resolved by the host OS; one keeps a trailing separator.
      { id: "root", folders: [path.resolve("/w")] },
      { id: "app", folders: [path.resolve("/w/app") + path.sep] },
      { id: "other", folders: [path.resolve("/elsewhere")] },
    ];
    expect(agMatchProject(projects, ["/w/app/src"])).toBe("app");
    expect(agMatchProject(projects, ["/w"])).toBe("root");
    expect(agMatchProject(projects, ["/www"])).toBeNull();
    expect(agMatchProject(projects, ["nope", "file:///elsewhere"])).toBe("other");
  });
});

describe("antigravity remote URL", () => {
  it("is null without an installation id, the base without a project, and names the project section", () => {
    const t = path.join(gemini, "antigravity", "brain", CONV, ".system_generated", "logs", "transcript.jsonl");
    expect(antigravityRemoteUrl(t, { env })).toBeNull();
    const file = dataDir();
    const base = `https://antigravity.google.com/r/${INSTALL}-v2`;
    expect(antigravityRemoteUrl(file, { env })).toBe(base);
    expect(antigravityRemoteUrl(file, { env, conversation: CONV, workspaces: [] })).toBe(base);
    expect(antigravityRemoteUrl(file, { env, conversation: "bad id!", workspaces: ["/w"] })).toBe(base);
    expect(antigravityRemoteUrl(file, { env, conversation: CONV, workspaces: ["/w/app"] })).toBe(base);
    project("proj-1", ["file:///w"]);
    expect(antigravityRemoteUrl(file, { env, conversation: CONV, workspaces: ["/w/app"] })).toBe(
      `${base}?p=${encodeURIComponent(`c/${CONV}?section=proj-1`)}`,
    );
  });
  it("skips a state file without an id and looks in every data dir; the projects dir may be given", () => {
    const cli = path.join(gemini, "antigravity-cli");
    mkdirSync(cli, { recursive: true });
    writeFileSync(path.join(cli, "antigravity_state.pbtxt"), "version: 3\n");
    const ide = path.join(gemini, "antigravity-ide");
    mkdirSync(ide, { recursive: true });
    writeFileSync(path.join(ide, "antigravity_state.pbtxt"), `installation_uuid: "${INSTALL}"`);
    const projects = path.join(home, "projects");
    mkdirSync(projects);
    writeFileSync(
      path.join(projects, "ok.json"),
      JSON.stringify({ projectResources: { resources: [{ folderUri: "/w" }] } }),
    );
    writeFileSync(path.join(projects, "bad id!.json"), "{}");
    writeFileSync(path.join(projects, "broken.json"), "{ not json");
    writeFileSync(path.join(projects, "empty.json"), JSON.stringify({ projectResources: { resources: [{}, null] } }));
    writeFileSync(path.join(projects, "bare.json"), "{}");
    writeFileSync(path.join(projects, "null.json"), "null");
    writeFileSync(path.join(projects, "notes.txt"), "");
    expect(
      antigravityRemoteUrl("/nowhere/transcript.jsonl", {
        env,
        conversation: CONV,
        workspaces: ["/w/x"],
        projectsDir: projects,
      }),
    ).toBe(`https://antigravity.google.com/r/${INSTALL}-v2?p=${encodeURIComponent(`c/${CONV}?section=ok`)}`);
    expect(
      antigravityRemoteUrl("/nowhere/t.jsonl", { env, conversation: CONV, workspaces: ["/w"], projectsDir: "/none" }),
    ).toBe(`https://antigravity.google.com/r/${INSTALL}-v2`);
  });
  it.runIf(process.platform !== "win32")("a project folder behind a symlink matches by its real path too", () => {
    const real = path.join(home, "real");
    mkdirSync(path.join(real, "src"), { recursive: true });
    symlinkSync(real, path.join(home, "link"));
    const projects = path.join(home, "projects");
    mkdirSync(projects);
    writeFileSync(
      path.join(projects, "p.json"),
      JSON.stringify({ projectResources: { resources: [{ folderUri: `file://${path.join(home, "link")}` }] } }),
    );
    dataDir();
    const url = antigravityRemoteUrl(path.join(gemini, "antigravity", "brain", CONV, "x.jsonl"), {
      env,
      conversation: CONV,
      workspaces: [path.join(real, "src")],
      projectsDir: projects,
    });
    expect(url).toContain(encodeURIComponent("section=p"));
  });
});

describe("antigravity facts and transcript", () => {
  it("titles after the first USER_REQUEST, with the url and the first and last times", () => {
    const file = dataDir();
    project("proj-1", ["/w"]);
    const facts = antigravityFacts(file, { conversation: CONV, workspaces: ["/w"], env });
    expect(facts).toEqual({
      url: `https://antigravity.google.com/r/${INSTALL}-v2?p=${encodeURIComponent(`c/${CONV}?section=proj-1`)}`,
      title: "Add a README to this project",
      title_source: "first-ask",
      started_at: Date.parse("2026-10-05T10:00:00.000Z"),
      last_at: Date.parse("2026-10-05T10:00:09.000Z"),
    });
  });
  it("cuts a long first line at a word, skips an injected tag and a non-string content, and no times is no times", () => {
    const long = `${"word ".repeat(30)}end`;
    const file = dataDir("antigravity", [
      JSON.stringify({ type: "USER_INPUT", content: { nested: true } }),
      JSON.stringify({ type: "USER_INPUT", content: "<system>injected</system>" }),
      JSON.stringify({ type: "USER_INPUT", content: "   \n" }),
      JSON.stringify({ type: "USER_INPUT", content: long }),
    ]);
    const facts = antigravityFacts(file, { conversation: CONV, workspaces: [], env });
    expect(facts.title?.endsWith("…")).toBe(true);
    expect(facts.title?.length).toBeLessThanOrEqual(81);
    expect(facts.started_at).toBeUndefined();
    // A transcript outside every data dir still gets the url the data dirs' state files name.
    expect(antigravityFacts("/nowhere.jsonl", { conversation: CONV, workspaces: [], env })).toEqual({
      url: `https://antigravity.google.com/r/${INSTALL}-v2`,
    });
    // Without an installation id anywhere there is no url, and the rest stands.
    rmSync(path.join(gemini, "antigravity", "antigravity_state.pbtxt"));
    const noUrl = antigravityFacts(file, { conversation: CONV, workspaces: [], env });
    expect(noUrl.url).toBeUndefined();
    expect(noUrl.title_source).toBe("first-ask");
  });
  it("the adapter's facts take the workspaces from the hints, else the session's folder", () => {
    expect(antigravity.facts({ id: CONV }, undefined, {}, noState)).toEqual({});
    const file = dataDir();
    const prev = process.env.GEMINI_CLI_HOME;
    process.env.GEMINI_CLI_HOME = gemini;
    try {
      project("proj-1", ["/w"]);
      const url = `https://antigravity.google.com/r/${INSTALL}-v2?p=${encodeURIComponent(`c/${CONV}?section=proj-1`)}`;
      expect(antigravity.facts({ id: CONV }, file, { workspaces: ["/w/app"] }, noState).url).toBe(url);
      expect(antigravity.facts({ id: CONV, cwd: "/w" }, file, {}, noState).url).toBe(url);
      expect(antigravity.facts({ id: CONV }, file, {}, noState).url).toBe(
        `https://antigravity.google.com/r/${INSTALL}-v2`,
      );
    } finally {
      if (prev === undefined) delete process.env.GEMINI_CLI_HOME;
      else process.env.GEMINI_CLI_HOME = prev;
    }
  });
  it("reads the transcript as turns, and a missing file as none", () => {
    const file = dataDir();
    const read = antigravity.readTranscript(file, 0);
    expect(read.turns.map((t) => [t.user, t.assistant])).toEqual([
      ["Add a README to this project", "Adding one now.\n\nDone."],
    ]);
    expect(antigravity.readTranscript(path.join(home, "none.jsonl"), 3)).toEqual({ turns: [], line: 3 });
  });
});

describe("antigravity backfill", () => {
  it("lists conversations whose transcript changed since, from every data dir", () => {
    const file = dataDir();
    const stale = dataDir("antigravity-cli");
    const old = new Date(Date.now() - 86_400_000);
    utimesSync(stale, old, old);
    // Odd entries under one brain, and a data dir with no brain at all.
    const ide = path.join(gemini, "antigravity-cli", "brain");
    mkdirSync(path.join(ide, "not-a-conversation"), { recursive: true });
    mkdirSync(path.join(ide, "1b2c3d4e-0000-4000-8000-000000000000"), { recursive: true });
    mkdirSync(path.join(gemini, "antigravity-ide"));
    const empty = path.join(
      gemini,
      "antigravity",
      "brain",
      "2b2c3d4e-0000-4000-8000-000000000000",
      ".system_generated",
      "logs",
    );
    mkdirSync(empty, { recursive: true });
    writeFileSync(
      path.join(empty, "transcript.jsonl"),
      `${JSON.stringify({ type: "USER_INPUT", content: "no time" })}\n`,
    );
    const rows = antigravity.backfill(Date.now() - 3_600_000, env);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      session: {
        id: CONV,
        url: `https://antigravity.google.com/r/${INSTALL}-v2`,
        title: "Add a README to this project",
        title_source: "first-ask",
      },
      started_at: Date.parse("2026-10-05T10:00:00.000Z"),
      last_at: Date.parse("2026-10-05T10:00:09.000Z"),
    });
    expect(file).toContain(CONV);
    expect(antigravity.backfill(Date.now() + 1e9)).toEqual([]);
  });
});

describe("antigravity detect, install and uninstall", () => {
  it("detects a config dir or a data dir, and names its one config file", () => {
    expect(antigravity.detect(env)).toBe(false);
    mkdirSync(path.join(gemini, "antigravity-ide"), { recursive: true });
    expect(antigravity.detect(env)).toBe(true);
    expect(antigravity.configFiles(env)).toEqual([path.join(gemini, "config", "hooks.json")]);
    // No GEMINI_CLI_HOME: ~/.gemini under the home (HOME here, USERPROFILE on Windows).
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    try {
      expect(antigravity.detect({})).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(typeof antigravity.detect()).toBe("boolean");
    expect(antigravity.configFiles()).toHaveLength(1);
  });
  it("creates hooks.json, reports it created, and a second install changes nothing", () => {
    const file = path.join(gemini, "config", "hooks.json");
    const r1 = antigravity.install(cmd, env)[0]!;
    expect(r1).toMatchObject({ file, changed: true, created: true });
    expect(antigravity.install(cmd, env)).toEqual([{ file, changed: false }]);
    expect(antigravity.installed(cmd, env)[0]?.state).toBe("current");
    expect(antigravity.uninstall(env, { created: [file] })).toEqual([
      { file, changed: true, note: "removed (sessionpipe created it)" },
    ]);
    expect(antigravity.installed(cmd, env)[0]?.state).toBe("missing");
    expect(antigravity.uninstall(env)).toEqual([{ file, changed: false }]);
  });
  it("leaves a hooks.json that is not plain JSON alone, on install and uninstall", () => {
    const file = path.join(gemini, "config", "hooks.json");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "[1, 2]");
    expect(antigravity.install(cmd, env)[0]).toMatchObject({ skipped: true, note: "not a JSON object; not touched" });
    expect(antigravity.uninstall(env)[0]).toMatchObject({ skipped: true });
    expect(antigravity.installed(cmd, env)[0]?.state).toBe("missing");
    writeFileSync(file, JSON.stringify({ other: { enabled: true } }));
    expect(antigravity.uninstall(env)).toEqual([{ file, changed: false }]);
  });
});
