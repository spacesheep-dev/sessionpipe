// SPDX-License-Identifier: Apache-2.0
// Antigravity's adapter beyond the fixtures: the hook's edge cases, the transcript
// reader, facts (title, remote URL through the installation id and the projects
// registry), backfill from the data dirs, and the hooks.json paths install can take.
// Everything runs in a temp home; the real ~/.gemini is never written.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
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
import { sqliteInProcess } from "../src/readers/sqlite.js";
import { validate } from "../src/schema/index.js";

const CONV = "6f1c2a9e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
const PARENT = "8f78dc26-6620-41cd-bf87-91c7a3dde24e";
const CHILD = "d95faf0d-8a5f-488a-91a5-9ee266db2276";
const INSTALL = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

const sqlite3Cli = (() => {
  try {
    execFileSync("sqlite3", ["-version"], { stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch {
    return false;
  }
})();
const canMakeDb = sqliteInProcess() || sqlite3Cli;

function execSql(file: string, stmts: string[]): boolean {
  if (sqliteInProcess()) {
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (p: string) => { exec(s: string): void; close(): void };
    };
    const db = new DatabaseSync(file);
    db.exec("BEGIN");
    for (const s of stmts) db.exec(s);
    db.exec("COMMIT");
    db.close();
    return true;
  }
  if (!sqlite3Cli) return false;
  execFileSync("sqlite3", [file], {
    input: `BEGIN;\n${stmts.map((s) => `${s};`).join("\n")}\nCOMMIT;\n`,
    stdio: ["pipe", "ignore", "ignore"],
    timeout: 30_000,
  });
  return true;
}

const SUMMARY_SCHEMA = [
  `CREATE TABLE conversation_summaries (
    conversation_id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT "",
    agent_name TEXT NOT NULL DEFAULT "",
    parent_conversation_id TEXT NOT NULL DEFAULT ""
  )`,
  "CREATE TABLE conversation_parents (conversation_id TEXT PRIMARY KEY, parent_id TEXT NOT NULL) WITHOUT ROWID",
];
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
function dataDir(name = "antigravity", lines: string[] = TRANSCRIPT, convId = CONV): string {
  const data = path.join(gemini, name);
  const logs = path.join(data, "brain", convId, ".system_generated", "logs");
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
  it("extracts parent_id from hook parent fields, rejects invalid or self-parenting, and fits the protocol schema", () => {
    expect(hook("PreInvocation", { conversationId: CONV, parentConversationId: PARENT })?.session.parent_id).toBe(
      PARENT,
    );
    expect(hook("Stop", { conversationId: CONV, parent_conversation_id: PARENT })?.session.parent_id).toBe(PARENT);
    expect(hook("Stop", { conversationId: CONV, parentId: "parent_1" })?.session.parent_id).toBe("parent_1");
    expect(hook("Stop", { conversationId: CONV, parent_id: PARENT })?.session.parent_id).toBe(PARENT);

    // Self-parenting (exact and case-insensitive UUID) and malformed values are rejected.
    expect(hook("Stop", { conversationId: CONV, parentConversationId: CONV })?.session.parent_id).toBeUndefined();
    expect(
      hook("Stop", { conversationId: CONV, parentConversationId: CONV.toUpperCase() })?.session.parent_id,
    ).toBeUndefined();
    expect(hook("Stop", { conversationId: CONV, parentConversationId: "" })?.session.parent_id).toBeUndefined();
    expect(hook("Stop", { conversationId: CONV, parentConversationId: 42 })?.session.parent_id).toBeUndefined();
    expect(hook("Stop", { conversationId: CONV, parentConversationId: "bad id!" })?.session.parent_id).toBeUndefined();
    expect(
      hook("Stop", { conversationId: CONV, parentConversationId: "a".repeat(129) })?.session.parent_id,
    ).toBeUndefined();

    // Schema validation of emitted event carrying parent_id.
    const r = hook("PreInvocation", { conversationId: CONV, parentConversationId: PARENT, invocationNum: 0 });
    expect(r?.events).toHaveLength(2);
    const ev = {
      protocol: 1,
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      time: "2026-10-05T10:00:00.000Z",
      type: r!.events[0]!.type,
      tier: 0,
      harness: { name: "antigravity", event: r!.events[0]!.harnessEvent },
      session: { ...r!.session, seq: 0 },
      privacy: { rulesets: ["secrets@1"], pii: false },
      data: r!.events[0]!.data,
    };
    expect(validate("event", ev)).toEqual([]);
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

  it("preserves parent_id and fallback title for subagents while top-level rows keep no parent_id", () => {
    dataDir("antigravity", TRANSCRIPT, PARENT);
    dataDir(
      "antigravity",
      [
        JSON.stringify({
          type: "SYSTEM_MESSAGE",
          created_at: "2026-10-05T10:01:00.000Z",
          content: [
            "The following is a <SYSTEM_MESSAGE> not actually sent by the user.",
            "<SYSTEM_MESSAGE>",
            `[Message] timestamp=2026-10-05T10:01:00Z sender=${PARENT} priority=MESSAGE_PRIORITY_HIGH content=You are the **QA Auditor**. Verify the adapter.`,
            "</SYSTEM_MESSAGE>",
          ].join("\n"),
        }),
        JSON.stringify({ type: "PLANNER_RESPONSE", created_at: "2026-10-05T10:01:05.000Z", content: "All good." }),
      ],
      CHILD,
    );
    const rows = antigravity.backfill(Date.now() - 3_600_000, env);
    const parentRow = rows.find((r) => r.session.id === PARENT);
    const childRow = rows.find((r) => r.session.id === CHILD);
    expect(parentRow?.session.parent_id).toBeUndefined();
    expect(parentRow?.session.title).toBe("Add a README to this project");
    expect(childRow).toEqual({
      session: {
        id: CHILD,
        parent_id: PARENT,
        url: `https://antigravity.google.com/r/${INSTALL}-v2`,
        title: "QA Auditor. Verify the adapter.",
        title_source: "first-ask",
      },
      started_at: Date.parse("2026-10-05T10:01:00.000Z"),
      last_at: Date.parse("2026-10-05T10:01:05.000Z"),
    });
  });
});

describe("antigravity subagent parent linking and fallback titles", () => {
  it("layer (a): extracts parent_id and cleaned fallback title from opening SYSTEM_MESSAGE before any USER_INPUT", () => {
    const file = dataDir(
      "antigravity-cli",
      [
        JSON.stringify({
          type: "SYSTEM_MESSAGE",
          created_at: "2026-11-26T12:30:01Z",
          content: [
            "The following is a <SYSTEM_MESSAGE> not actually sent by the user.",
            "",
            "<SYSTEM_MESSAGE>",
            `[Message] timestamp=2026-11-26T12:30:01Z sender=${PARENT} priority=MESSAGE_PRIORITY_HIGH content=<task>\nYou are the **Sessionpipe Antigravity Subagent Engineer**. Fix parent linking across all three layers cleanly.`,
            "</SYSTEM_MESSAGE>",
          ].join("\n"),
        }),
        JSON.stringify({ type: "PLANNER_RESPONSE", created_at: "2026-11-26T12:30:05Z", content: "Working on it." }),
      ],
      CHILD,
    );
    const facts = antigravityFacts(file, { conversation: CHILD, workspaces: [], env });
    expect(facts.parent_id).toBe(PARENT);
    expect(facts.title_source).toBe("first-ask");
    expect(facts.title).toBe("Sessionpipe Antigravity Subagent Engineer. Fix parent linking across all three…");
    expect(facts.title!.length).toBeLessThanOrEqual(81);
  });

  it("layer (a): ignores SYSTEM_MESSAGE appearing after USER_INPUT (e.g. subagent replying to a top-level parent)", () => {
    const file = dataDir(
      "antigravity-cli",
      [
        JSON.stringify({
          type: "USER_INPUT",
          created_at: "2026-11-26T12:00:00Z",
          content: "<USER_REQUEST>\nFix subagent linking\n</USER_REQUEST>",
        }),
        JSON.stringify({
          type: "SYSTEM_MESSAGE",
          created_at: "2026-11-26T12:05:00Z",
          content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-26T12:05:00Z sender=${CHILD} content=Done!\n</SYSTEM_MESSAGE>`,
        }),
      ],
      PARENT,
    );
    const facts = antigravityFacts(file, { conversation: PARENT, workspaces: [], env });
    expect(facts.parent_id).toBeUndefined();
    expect(facts.title).toBe("Fix subagent linking");
  });

  it("layer (b): resolves parent_id and fallback title from sibling .system_generated/messages/*.json", () => {
    const file = dataDir(
      "antigravity-cli",
      [JSON.stringify({ type: "PLANNER_RESPONSE", created_at: "2026-11-26T12:30:05Z", content: "On it." })],
      CHILD,
    );
    const msgDir = path.join(gemini, "antigravity-cli", "brain", CHILD, ".system_generated", "messages");
    mkdirSync(path.join(msgDir, "undelivered"), { recursive: true });
    writeFileSync(path.join(msgDir, "read.json"), JSON.stringify({ m1: true }));
    writeFileSync(path.join(msgDir, "broken.json"), "{not json");
    // Oversized file (> 256 KB) is skipped.
    writeFileSync(
      path.join(msgDir, "00-huge.json"),
      JSON.stringify({
        sender: "11111111-1111-4111-8111-111111111111",
        renderDetails: { messageTitle: "Message from Parent Agent" },
        content: "x".repeat(300 * 1024),
      }),
    );
    // Task notification sender (<conv>/task-1) is ignored.
    const taskFile = path.join(msgDir, "01-task.json");
    writeFileSync(
      taskFile,
      JSON.stringify({
        sender: `${CHILD}/task-1`,
        renderDetails: { messageTitle: "Build finished" },
        content: "ok",
      }),
    );
    // Genuine parent message (older mtime than later messages).
    const parentMsg = path.join(msgDir, "zz-parent.json");
    writeFileSync(
      parentMsg,
      JSON.stringify({
        id: "m1",
        recipient: CHILD,
        sender: PARENT,
        renderDetails: { messageTitle: "Message from Parent Agent" },
        content: "# Audit **SQLite** fallback\n\nCheck read-only queries.",
      }),
    );
    const older = new Date(Date.now() - 60_000);
    utimesSync(parentMsg, older, older);

    const facts = antigravityFacts(file, { conversation: CHILD, workspaces: [], env });
    expect(facts.parent_id).toBe(PARENT);
    expect(facts.title).toBe("Audit SQLite fallback");
    expect(facts.title_source).toBe("first-ask");
  });

  it("layer (b): top-level parent receiving subagent replies never gets a false-positive parent_id", () => {
    const file = dataDir("antigravity-cli", TRANSCRIPT, PARENT);
    const msgDir = path.join(gemini, "antigravity-cli", "brain", PARENT, ".system_generated", "messages");
    mkdirSync(msgDir, { recursive: true });
    writeFileSync(
      path.join(msgDir, "reply-1.json"),
      JSON.stringify({
        sender: CHILD,
        renderDetails: { messageTitle: "Message from Phase B Design Architect (research)" },
        content: "Architecture report",
      }),
    );
    // Even an unlabeled message JSON must not link a parent that has USER_INPUT.
    writeFileSync(path.join(msgDir, "reply-2.json"), JSON.stringify({ sender: CHILD, content: "Unlabeled reply" }));

    const facts = antigravityFacts(file, { conversation: PARENT, workspaces: [], env });
    expect(facts.parent_id).toBeUndefined();
    expect(facts.title).toBe("Add a README to this project");
  });

  it("layer (b): supports unlabeled message JSON when there is no USER_INPUT, and Parent Agent title even with USER_INPUT", () => {
    // Unlabeled message with no USER_INPUT -> links parent.
    const subFile = dataDir(
      "antigravity-cli",
      [JSON.stringify({ type: "PLANNER_RESPONSE", created_at: "2026-11-26T12:30:05Z", content: "Done." })],
      CHILD,
    );
    const subMsgDir = path.join(gemini, "antigravity-cli", "brain", CHILD, ".system_generated", "messages");
    mkdirSync(subMsgDir, { recursive: true });
    writeFileSync(
      path.join(subMsgDir, "msg.json"),
      JSON.stringify({ sender: PARENT, content: "You are **Codebase Researcher**: map adapters" }),
    );
    const subFacts = antigravityFacts(subFile, { conversation: CHILD, workspaces: [], env });
    expect(subFacts.parent_id).toBe(PARENT);
    expect(subFacts.title).toBe("Codebase Researcher: map adapters");
    expect(subFacts.title_source).toBe("first-ask");

    // Forked conversation with copied USER_INPUT + explicit "Message from Parent Agent" -> links parent.
    const forkId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const forkFile = dataDir("antigravity-cli", TRANSCRIPT, forkId);
    const forkMsgDir = path.join(gemini, "antigravity-cli", "brain", forkId, ".system_generated", "messages");
    mkdirSync(forkMsgDir, { recursive: true });
    writeFileSync(
      path.join(forkMsgDir, "msg.json"),
      JSON.stringify({
        sender: PARENT,
        renderDetails: { messageTitle: "Message from Parent Agent" },
        content: "Swarm worker brief",
      }),
    );
    const forkFacts = antigravityFacts(forkFile, { conversation: forkId, workspaces: [], env });
    expect(forkFacts.parent_id).toBe(PARENT);
    expect(forkFacts.title).toBe("Add a README to this project");
  });

  it("rejects self-parenting in transcript SYSTEM_MESSAGE and sibling messages JSON", () => {
    const file = dataDir(
      "antigravity-cli",
      [
        JSON.stringify({
          type: "SYSTEM_MESSAGE",
          created_at: "2026-11-26T12:30:01Z",
          content: `[Message] sender=${CHILD} content=Self message`,
        }),
      ],
      CHILD,
    );
    const msgDir = path.join(gemini, "antigravity-cli", "brain", CHILD, ".system_generated", "messages");
    mkdirSync(msgDir, { recursive: true });
    writeFileSync(
      path.join(msgDir, "self.json"),
      JSON.stringify({
        sender: CHILD.toUpperCase(),
        renderDetails: { messageTitle: "Message from Parent Agent" },
        content: "Self message",
      }),
    );
    const facts = antigravityFacts(file, { conversation: CHILD, workspaces: [], env });
    expect(facts.parent_id).toBeUndefined();
    expect(facts.title).toBeUndefined();
  });

  it("adapter.facts preserves parent_id from fromHook even without a transcript, and respects passed env", () => {
    expect(antigravity.facts({ id: CHILD, parent_id: PARENT }, undefined, {}, noState, env)).toEqual({
      parent_id: PARENT,
    });
    expect(antigravity.facts({ id: CHILD, parent_id: CHILD }, undefined, {}, noState, env)).toEqual({});
    const file = dataDir("antigravity-cli", TRANSCRIPT, CHILD);
    const facts = antigravity.facts({ id: CHILD, parent_id: PARENT }, file, {}, noState, env);
    expect(facts.parent_id).toBe(PARENT);
    expect(facts.url).toBe(`https://antigravity.google.com/r/${INSTALL}-v2`);
  });

  it.runIf(canMakeDb)(
    "layer (c): reads conversation_summaries.db for forked workers, conversation_parents fallback, harness title, and agent_name",
    () => {
      const dbFile = path.join(gemini, "antigravity-cli", "conversation_summaries.db");
      const forkId = "11111111-2222-4333-8444-555555555555";
      const parentsOnlyId = "22222222-3333-4444-8555-666666666666";
      const titledSubId = "33333333-4444-4555-8666-777777777777";
      const namedSubId = "44444444-5555-4666-8777-888888888888";
      const selfId = "55555555-6666-4777-8888-999999999999";

      const forkFile = dataDir("antigravity-cli", TRANSCRIPT, forkId);
      const parentsOnlyFile = dataDir(
        "antigravity-cli",
        [JSON.stringify({ type: "PLANNER_RESPONSE", created_at: "2026-11-26T12:30:05Z", content: "ok" })],
        parentsOnlyId,
      );
      const titledSubFile = dataDir(
        "antigravity-cli",
        [
          JSON.stringify({
            type: "SYSTEM_MESSAGE",
            created_at: "2026-11-26T12:30:01Z",
            content: `[Message] sender=${PARENT} content=You are the **Engineer**. Do work.`,
          }),
        ],
        titledSubId,
      );
      const namedSubFile = dataDir(
        "antigravity-cli",
        [JSON.stringify({ type: "PLANNER_RESPONSE", created_at: "2026-11-26T12:30:05Z", content: "ok" })],
        namedSubId,
      );
      const selfFile = dataDir("antigravity-cli", TRANSCRIPT, selfId);
      const topFile = dataDir("antigravity-cli", TRANSCRIPT, PARENT);

      expect(
        execSql(dbFile, [
          ...SUMMARY_SCHEMA,
          `INSERT INTO conversation_summaries VALUES ('${forkId}', 'Swarm Worker', 'self', '${PARENT}')`,
          `INSERT INTO conversation_summaries VALUES ('${parentsOnlyId}', '', 'research', '')`,
          `INSERT INTO conversation_parents VALUES ('${parentsOnlyId}', '${PARENT}')`,
          `INSERT INTO conversation_summaries VALUES ('${titledSubId}', 'Harness Subagent Title', 'self', '${PARENT}')`,
          `INSERT INTO conversation_summaries VALUES ('${namedSubId}', '', 'research', '${PARENT}')`,
          `INSERT INTO conversation_summaries VALUES ('${selfId}', '', 'self', '${selfId}')`,
          `INSERT INTO conversation_summaries VALUES ('${PARENT}', 'Top Level', '', '')`,
        ]),
      ).toBe(true);

      // Forked worker: line 0 is coordinator's USER_INPUT, DB still links parent_id.
      const forkFacts = antigravityFacts(forkFile, { conversation: forkId, workspaces: [], env });
      expect(forkFacts.parent_id).toBe(PARENT);
      expect(forkFacts.title).toBe("Add a README to this project");
      expect(forkFacts.title_source).toBe("first-ask");

      // Empty parent_conversation_id falls back to conversation_parents table; empty title falls back to agent_name.
      const pFacts = antigravityFacts(parentsOnlyFile, { conversation: parentsOnlyId, workspaces: [], env });
      expect(pFacts.parent_id).toBe(PARENT);
      expect(pFacts.title).toBe("research");
      expect(pFacts.title_source).toBe("harness");

      // Non-empty conversation_summaries.title takes precedence over delegated prompt when no USER_INPUT exists.
      const titledFacts = antigravityFacts(titledSubFile, { conversation: titledSubId, workspaces: [], env });
      expect(titledFacts.parent_id).toBe(PARENT);
      expect(titledFacts.title).toBe("Harness Subagent Title");
      expect(titledFacts.title_source).toBe("harness");

      // Empty title + no delegated prompt -> falls back to agent_name.
      const namedFacts = antigravityFacts(namedSubFile, { conversation: namedSubId, workspaces: [], env });
      expect(namedFacts.parent_id).toBe(PARENT);
      expect(namedFacts.title).toBe("research");
      expect(namedFacts.title_source).toBe("harness");

      // Self-parenting in DB is rejected; top-level session with empty parent_conversation_id has no parent_id.
      expect(antigravityFacts(selfFile, { conversation: selfId, workspaces: [], env }).parent_id).toBeUndefined();
      expect(antigravityFacts(topFile, { conversation: PARENT, workspaces: [], env }).parent_id).toBeUndefined();
    },
  );

  it("layer (c): a corrupt conversation_summaries.db never throws and leaves parent_id undefined", () => {
    const file = dataDir("antigravity-cli", TRANSCRIPT, CONV);
    writeFileSync(path.join(gemini, "antigravity-cli", "conversation_summaries.db"), "not a sqlite database");
    const facts = antigravityFacts(file, { conversation: CONV, workspaces: [], env });
    expect(facts.parent_id).toBeUndefined();
    expect(facts.title).toBe("Add a README to this project");
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
