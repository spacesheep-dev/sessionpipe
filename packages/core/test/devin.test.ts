// SPDX-License-Identifier: Apache-2.0
// The Devin adapter: where its hooks go, which events it may register, how a payload
// maps, and the session store it reads for tier 2 and for facts.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEVIN_EVENTS, devin, devinAccount, devinVersion, readDevinChain } from "../src/adapters/devin.js";
import type { HookCommand } from "../src/adapters/types.js";
import { querySqlite, sqliteInProcess } from "../src/readers/sqlite.js";

const cmd: HookCommand = (a) => ({
  argv: ["/usr/local/bin/node", "/opt/sessionpipe/dist/hook.js", ...a],
  command: `"/usr/local/bin/node" "/opt/sessionpipe/dist/hook.js" ${a.join(" ")}`,
});
const cmd2: HookCommand = (a) => ({
  argv: ["/new/node", "/new/sessionpipe/dist/hook.js", ...a],
  command: `"/new/node" "/new/sessionpipe/dist/hook.js" ${a.join(" ")}`,
});

let home: string;
let env: NodeJS.ProcessEnv;
let configFile: string;
let dbFile: string;

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "sp-devin-"));
  // Its own HOME and its own XDG roots: nothing here may reach the real ~/.config/devin.
  env = {
    HOME: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
  };
  configFile = devin.configFiles(env)[0] as string;
  mkdirSync(path.dirname(configFile), { recursive: true });
  dbFile = path.join(
    process.platform === "win32"
      ? path.join(home, "AppData", "Roaming", "devin", "cli")
      : path.join(home, ".local", "share", "devin", "cli"),
    "sessions.db",
  );
  mkdirSync(path.dirname(dbFile), { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("devin: the event list", () => {
  // Devin's hook loader refuses the WHOLE file on one event name it does not know
  // ("unknown variant `Notification`, expected one of PreToolUse, PostToolUse,
  // UserPromptSubmit, Stop, PostCompaction, SessionStart, SessionEnd,
  // PermissionRequest" — measured on 3000.11.3 against ~/.claude/settings.json, whose
  // Claude-only keys are why none of the claude-code entries there ever fire inside
  // Devin). One name added here therefore does not add an event: it silently turns off
  // every Devin hook. This list is exact.
  it("is exactly the eight names Devin accepts", () => {
    expect([...DEVIN_EVENTS].sort()).toEqual(
      [
        "PermissionRequest",
        "PostCompaction",
        "PostToolUse",
        "PreToolUse",
        "SessionEnd",
        "SessionStart",
        "Stop",
        "UserPromptSubmit",
      ].sort(),
    );
    expect(devin.events).toBe(DEVIN_EVENTS);
  });
});

describe("devin: install / uninstall / installed", () => {
  it("writes one entry per event under the config file's hooks key and leaves the rest alone", () => {
    const before = `${JSON.stringify({ version: 1, theme_mode: "dark", hooks: { Stop: [{ hooks: [{ type: "command", command: "/other/tool stop", timeout: 10 }] }] } }, null, 2)}\n`;
    writeFileSync(configFile, before);
    const r = devin.install(cmd, env);
    expect(r[0]?.changed).toBe(true);
    expect(r[0]?.note).toMatch(/whole/);
    const after = JSON.parse(readFileSync(configFile, "utf8"));
    expect(after.version).toBe(1);
    expect(after.theme_mode).toBe("dark");
    expect(Object.keys(after.hooks).sort()).toEqual([...DEVIN_EVENTS].sort());
    // The other tool's Stop entry is still there, ours beside it.
    expect(after.hooks.Stop).toHaveLength(2);
    expect(after.hooks.Stop[0].hooks[0].command).toBe("/other/tool stop");
    // Timeouts are SECONDS, and only tool/permission events take a matcher.
    expect(after.hooks.PreToolUse[0].matcher).toBe("");
    expect(after.hooks.PermissionRequest[0].matcher).toBe("");
    expect(after.hooks.PreToolUse[0].hooks[0].timeout).toBe(5);
    expect(after.hooks.Stop[1].matcher).toBeUndefined();
    expect(devin.install(cmd, env)[0]?.changed).toBe(false);
    expect(devin.installed(cmd, env)[0]?.state).toBe("current");
    expect(devin.installed(cmd2, env)[0]?.state).toBe("stale");
    devin.uninstall(env);
    expect(readFileSync(configFile, "utf8")).toBe(before);
  });

  it("creates the config file holding only hooks, and removes it again", () => {
    expect(existsSync(configFile)).toBe(false);
    const r = devin.install(cmd, env);
    expect(r[0]?.created).toBe(true);
    // Devin runs happily off a config.json that holds nothing but hooks (verified
    // against devin 3000.11.3: "hooks discovery: … loaded=1 (global=1 …)").
    expect(Object.keys(JSON.parse(readFileSync(configFile, "utf8")))).toEqual(["hooks"]);
    devin.uninstall(env, { created: [configFile] });
    expect(existsSync(configFile)).toBe(false);
  });

  it("a lean install drops PreToolUse and a later full install adds it back", () => {
    devin.install(cmd, env, { lean: true });
    const lean = JSON.parse(readFileSync(configFile, "utf8"));
    expect(lean.hooks.PreToolUse).toBeUndefined();
    expect(lean.hooks.PostToolUse).toBeDefined();
    expect(devin.installed(cmd, env, { lean: true })[0]?.state).toBe("current");
    expect(devin.installed(cmd, env)[0]?.state).toBe("stale");
    devin.install(cmd, env);
    expect(JSON.parse(readFileSync(configFile, "utf8")).hooks.PreToolUse).toBeDefined();
  });

  it("never writes a config file with comments (Devin's are JSON-with-comments)", () => {
    const text = '{\n  // my setup\n  "version": 1\n}\n';
    writeFileSync(configFile, text);
    const r = devin.install(cmd, env);
    expect(r[0]?.skipped).toBe(true);
    expect(r[0]?.note).toMatch(/comments/);
    expect(readFileSync(configFile, "utf8")).toBe(text);
  });

  it("detect() needs a Devin directory, and names the user config file", () => {
    expect(devin.detect(env)).toBe(true); // beforeEach made the config dir
    expect(configFile.endsWith(path.join("devin", "config.json"))).toBe(true);
    const empty = {
      HOME: path.join(home, "nobody"),
      APPDATA: path.join(home, "nobody"),
      XDG_CONFIG_HOME: path.join(home, "nobody", "c"),
      XDG_DATA_HOME: path.join(home, "nobody", "d"),
    };
    expect(devin.detect(empty)).toBe(false);
  });
});

const hook = (event: string, payload: Record<string, unknown>, cwd = "/tmp/rec/devin-proj") =>
  devin.fromHook({
    argv: ["devin", event],
    stdin: JSON.stringify(payload),
    env: { DEVIN_PROJECT_DIR: cwd, HOME: home, XDG_DATA_HOME: path.join(home, ".local", "share") },
    cwd: "/somewhere/else",
  });

describe("devin: fromHook", () => {
  it("takes the folder from DEVIN_PROJECT_DIR, the only thing that names it", () => {
    const r = hook("SessionStart", { hook_event_name: "SessionStart", session_id: "frill-vulture", source: "startup" });
    expect(r?.session.cwd).toBe("/tmp/rec/devin-proj");
    const noEnv = devin.fromHook({
      argv: ["devin", "SessionStart"],
      stdin: JSON.stringify({ session_id: "frill-vulture", source: "startup" }),
      env: {},
      cwd: "/fallback",
    });
    expect(noEnv?.session.cwd).toBe("/fallback");
  });

  it("drops a payload with no session id, and an event it does not know", () => {
    expect(hook("SessionStart", { hook_event_name: "SessionStart" })).toBeNull();
    expect(hook("Notification", { session_id: "frill-vulture" })).toBeNull();
    expect(devin.fromHook({ argv: ["devin", "Stop"], stdin: "not json", env: {}, cwd: "/" })).toBeNull();
  });

  it("never prints: Devin reads a decision from stdout", () => {
    for (const e of DEVIN_EVENTS) {
      const r = hook(e, { session_id: "frill-vulture", tool_name: "exec", tool_input: { command: "ls" } });
      expect(r?.stdout).toBeUndefined();
    }
  });

  it("PostToolUse carries tool_response.success, the one harness that says so", () => {
    const base = { session_id: "s1", prompt_id: "p1", tool_name: "exec", tool_input: { command: "ls" } };
    const ok = hook("PostToolUse", { ...base, tool_response: { success: true, output: "a\n", error: null } });
    expect(ok?.events[0]).toMatchObject({ type: "tool.ended", data: { ok: true, output: "a\n" } });
    expect(ok?.events[0]?.data.error).toBeUndefined();
    const bad = hook("PostToolUse", { ...base, tool_response: { success: false, output: "", error: "no such file" } });
    expect(bad?.events[0]).toMatchObject({ type: "tool.ended", data: { ok: false, error: "no such file" } });
    // A payload with no tool_response at all is still a tool that ended.
    const bare = hook("PostToolUse", base);
    expect(bare?.events[0]).toMatchObject({ type: "tool.ended", data: { ok: true } });
  });

  it("PermissionRequest uses the tool-use id it carries, and hashes one that is missing", () => {
    const input = { command: "printf 'x' > out.txt" };
    const withId = hook("PermissionRequest", {
      session_id: "s1",
      prompt_id: "p1",
      tool_name: "exec",
      tool_input: input,
      tool_use_id: "call_abc#def",
    });
    expect(withId?.events[0]?.data.attention_id).toBe("call_abc#def");
    const a = hook("PermissionRequest", { session_id: "s1", prompt_id: "p1", tool_name: "exec", tool_input: input });
    const b = hook("PermissionRequest", { session_id: "s1", prompt_id: "p1", tool_name: "exec", tool_input: input });
    // The same request must always name the same attention (CONTROL.md §6).
    expect(a?.events[0]?.data.attention_id).toMatch(/^perm-[0-9a-f]{16}$/);
    expect(a?.events[0]?.data.attention_id).toBe(b?.events[0]?.data.attention_id);
    const other = hook("PermissionRequest", {
      session_id: "s1",
      prompt_id: "p1",
      tool_name: "exec",
      tool_input: { command: "rm -rf /" },
    });
    expect(other?.events[0]?.data.attention_id).not.toBe(a?.events[0]?.data.attention_id);
  });

  it("an unknown SessionStart source and an unknown SessionEnd reason fall back", () => {
    expect(hook("SessionStart", { session_id: "s1", source: "wormhole" })?.events[0]?.data.source).toBe("unknown");
    expect(hook("SessionStart", { session_id: "s1", source: "resume" })?.events[0]?.data.source).toBe("resume");
    expect(hook("SessionEnd", { session_id: "s1", reason: "other" })?.events[0]?.data.reason).toBe("other");
    expect(hook("SessionEnd", { session_id: "s1", reason: "clear" })?.events[0]?.data.reason).toBe("clear");
  });

  it("PostCompaction is a compaction, and the transcript is addressed as <db>#<session>", () => {
    const r = hook("PostCompaction", { session_id: "frill-vulture", summary: "…" });
    expect(r?.events[0]).toMatchObject({ type: "context.compacted", data: { trigger: "auto" } });
    expect(r?.transcript).toBe(`${dbFile}#frill-vulture`);
  });
});

// --- the session store ----------------------------------------------------------------

/** Devin's own schema (3000.11.3, migrations V1–V17), as the adapter reads it. */
const SCHEMA = [
  `CREATE TABLE sessions (id TEXT PRIMARY KEY, working_directory TEXT NOT NULL, backend_type TEXT NOT NULL,
     model TEXT NOT NULL, agent_mode TEXT NOT NULL, created_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL,
     title TEXT, main_chain_id INTEGER, hidden INTEGER NOT NULL DEFAULT 0, metadata TEXT)`,
  `CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
     node_id INTEGER NOT NULL, parent_node_id INTEGER, chat_message TEXT NOT NULL, created_at INTEGER NOT NULL,
     metadata TEXT, UNIQUE(session_id, node_id))`,
  `CREATE TABLE prompt_history (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL,
     timestamp INTEGER NOT NULL, session_id TEXT NOT NULL, is_shell INTEGER NOT NULL DEFAULT 0)`,
];
const T = 1791498423; // unix SECONDS, as this store keeps them
const msg = (role: string, content: string, userInput?: boolean) =>
  JSON.stringify({
    message_id: `m-${role}-${content.slice(0, 4)}`,
    role,
    content,
    metadata: { ...(userInput !== undefined ? { is_user_input: userInput } : {}) },
  });

/** The real schema, filled through node:sqlite. Returns null when this Node has no
 *  node:sqlite (Node 20, or 22.5–22.12 unflagged) — those runs skip the db tests. */
function makeDb(file: string): boolean {
  if (!sqliteInProcess()) return false;
  // Only the reader is restricted to read-only; the fixture needs a writer.
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
    DatabaseSync: new (p: string) => { exec(s: string): void; close(): void };
  };
  const db = new DatabaseSync(file);
  for (const s of SCHEMA) db.exec(s);
  const q = (s: string) => db.exec(s);
  q(
    `INSERT INTO sessions VALUES ('frill-vulture','/work/proj','windsurf','swe-2-medium','normal',${T - 60},${T},'\`head -1 sample.txt\`',27,0,'{}')`,
  );
  q(
    `INSERT INTO sessions VALUES ('hidden-one','/work/proj','windsurf','swe-2-high','normal',${T - 60},${T},'x',3,1,'{}')`,
  );
  q(`INSERT INTO prompt_history (content,timestamp,session_id,is_shell) VALUES ('ls -la',${T - 70},'frill-vulture',1)`);
  q(
    `INSERT INTO prompt_history (content,timestamp,session_id,is_shell) VALUES ('Read sample.txt and reply with its first word',${T - 60},'frill-vulture',0)`,
  );
  q(
    `INSERT INTO prompt_history (content,timestamp,session_id,is_shell) VALUES ('and now the second',${T - 10},'frill-vulture',0)`,
  );
  // The canonical chain: 20 → 23 → 25 → 27. 21/22 are an abandoned branch that a naive
  // read of message_nodes would deliver as a second, wrong turn.
  const node = (id: number, parent: number | null, m: string, at = T) =>
    q(
      `INSERT INTO message_nodes (session_id,node_id,parent_node_id,chat_message,created_at) VALUES ('frill-vulture',${id},${parent === null ? "NULL" : parent},'${m.replace(/'/g, "''")}',${at})`,
    );
  node(19, null, msg("system", "You are Devin, an interactive command line agent from Cognition."));
  node(20, 19, msg("user", "Read sample.txt and reply with its first word", true));
  node(21, 20, msg("assistant", "WRONG BRANCH: abandoned"));
  node(22, 21, msg("user", "abandoned follow-up", true));
  node(23, 20, msg("assistant", ""));
  node(24, 23, msg("tool", "alpha-token-marker-42"));
  node(25, 24, msg("user", "and now the second", true));
  node(26, 25, msg("user", "<system_info>generated, not typed</system_info>", false));
  node(27, 26, msg("assistant", "alpha"));
  db.close();
  return true;
}

describe.runIf(sqliteInProcess())("devin: the session store", () => {
  beforeEach(() => {
    expect(makeDb(dbFile)).toBe(true);
  });

  it("reads the one chain that ends at main_chain_id, never the whole forest", () => {
    const r = readDevinChain(dbFile, "frill-vulture", 0);
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0]?.user).toBe("Read sample.txt and reply with its first word\n\nand now the second");
    expect(r.turns[0]?.assistant).toBe("alpha");
    expect(r.turns[0]?.user).not.toMatch(/abandoned/);
    // The vendor's own system prompt and the generated system_info are never a turn.
    expect(r.turns[0]?.user).not.toMatch(/Cognition|system_info/);
    expect(r.turns[0]?.at).toBe(T * 1000);
    // node_id is the cursor: past the deepest node of the chain.
    expect(r.line).toBe(28);
  });

  it("the cursor stops a second read from re-sending a turn", () => {
    const first = readDevinChain(dbFile, "frill-vulture", 0);
    expect(readDevinChain(dbFile, "frill-vulture", first.line).turns).toHaveLength(0);
  });

  it("facts: model, folder, times in ms, the first ask as the title", () => {
    const f = devin.facts(
      { id: "frill-vulture" },
      `${dbFile}#frill-vulture`,
      {},
      {
        get: () => ({}),
        save: () => {},
      },
    );
    expect(f.model).toBe("swe-2-medium");
    expect(f.cwd).toBe("/work/proj");
    expect(f.started_at).toBe((T - 60) * 1000);
    expect(f.last_at).toBe(T * 1000);
    // Not sessions.title, which holds the titler's own `head -1 sample.txt`; not the
    // shell-history row either.
    expect(f.title).toBe("Read sample.txt and reply with its first word");
    expect(f.title_source).toBe("first-ask");
  });

  it("backfill: visible sessions only, newest first, with their first ask", () => {
    const rows = devin.backfill((T - 3600) * 1000, env);
    expect(rows.map((r) => r.session.id)).toEqual(["frill-vulture"]);
    expect(rows[0]?.session.title).toBe("Read sample.txt and reply with its first word");
    expect(rows[0]?.started_at).toBe((T - 60) * 1000);
    expect(devin.backfill((T + 3600) * 1000, env)).toEqual([]);
  });

  it("a missing, unreadable or wrongly addressed store costs an empty read, never a throw", () => {
    expect(readDevinChain(path.join(home, "nope.db"), "frill-vulture", 4).line).toBe(4);
    expect(readDevinChain(dbFile, "no-such-session", 0).turns).toEqual([]);
    expect(readDevinChain(dbFile, "../etc/passwd", 0).turns).toEqual([]);
    expect(devin.readTranscript("no-hash-here", 7)).toEqual({ turns: [], line: 7 });
    const notADb = path.join(home, "text.db");
    writeFileSync(notADb, "this is not a database");
    expect(readDevinChain(notADb, "frill-vulture", 0).turns).toEqual([]);
    expect(devin.backfill(0, { ...env, XDG_DATA_HOME: path.join(home, "gone") })).toEqual([]);
  });

  // The CI matrix runs Node 20, where node:sqlite does not exist, and aifoundry1 runs
  // 22.11, where it is behind --experimental-sqlite and the worker spawns no flags. The
  // child path is what those machines use, so it is tested here on every machine.
  it("the child-process path reads the same rows as the in-process one", () => {
    const sql = "SELECT id, model FROM sessions WHERE hidden = 0";
    const direct = querySqlite(dbFile, sql, [], { engine: "node" });
    const child = querySqlite(dbFile, sql, [], { engine: "child" });
    expect(direct).toEqual([{ id: "frill-vulture", model: "swe-2-medium" }]);
    expect(child).toEqual(direct);
  });

  it("a forced engine that cannot work returns null, not an exception", () => {
    expect(querySqlite(path.join(home, "nope.db"), "SELECT 1", [], { engine: "child" })).toBeNull();
    expect(querySqlite(dbFile, "SELECT bad syntax here", [], { engine: "node" })).toBeNull();
  });
});

describe("devin: version and account", () => {
  // A directory symlink needs a privilege Windows runners do not have.
  it.skipIf(process.platform === "win32")("the version comes from the _versions/current symlink", () => {
    const versions = path.join(path.dirname(dbFile), "_versions");
    mkdirSync(path.join(versions, "3000.11.3"), { recursive: true });
    symlinkSync("3000.11.3", path.join(versions, "current"));
    expect(devinVersion(env)).toBe("3000.11.3");
  });

  it("the account id is the org from the user config, never an email or a credential", () => {
    writeFileSync(configFile, JSON.stringify({ version: 1, devin: { org_id: "org-f6a1d67f" } }));
    expect(devinAccount(env)).toBe("org-f6a1d67f");
    writeFileSync(configFile, JSON.stringify({ version: 1, devin: { org_id: "someone@example.com" } }));
    expect(devinAccount(env)).toBeUndefined();
    writeFileSync(configFile, JSON.stringify({ version: 1 }));
    expect(devinAccount(env)).toBeUndefined();
  });
});
