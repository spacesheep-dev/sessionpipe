// SPDX-License-Identifier: Apache-2.0
// The Devin adapter: where its hooks go, which events it may register, how a payload
// maps, and the session store it reads for tier 2 and for facts.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CHAIN_SQL,
  DEVIN_EVENTS,
  devin,
  devinAccount,
  devinConfigDir,
  devinDataDir,
  devinVersion,
  foreignEvent,
  readDevinChain,
  splitRef,
} from "../src/adapters/devin.js";
import type { HookCommand } from "../src/adapters/types.js";
import { inlineParams, querySqlite, sqliteInProcess } from "../src/readers/sqlite.js";

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

  it("reports inactive, not current, when one event name makes Devin drop the file", () => {
    // Devin refuses the whole hooks file over a key it does not know, so our eight
    // entries can be present and byte-current and still report nothing at all. A
    // `current` row there tells the person reporting is on while it is dead.
    const foreign = { hooks: { Notification: [{ hooks: [{ type: "command", command: "/other/tool notify" }] }] } };
    writeFileSync(configFile, JSON.stringify(foreign));
    // With none of ours in it, `missing` is the more useful answer.
    expect(devin.installed(cmd, env)[0]?.state).toBe("missing");
    const r = devin.install(cmd, env);
    expect(r[0]?.changed).toBe(true);
    expect(r[0]?.note).toMatch(/Notification/);
    // install keeps the foreign key (it only ever strips entries of ours), so the
    // install report has to say the file is dead rather than report plain success.
    expect(JSON.parse(readFileSync(configFile, "utf8")).hooks.Notification).toBeDefined();
    const st = devin.installed(cmd, env);
    expect(st[0]?.state).toBe("inactive");
    expect(st[0]?.note).toMatch(/Notification/);
    // Drop that one key and the very same entries are current again.
    const j = JSON.parse(readFileSync(configFile, "utf8")) as { hooks: Record<string, unknown> };
    delete j.hooks.Notification;
    writeFileSync(configFile, JSON.stringify(j));
    expect(devin.installed(cmd, env)[0]?.state).toBe("current");
    expect(foreignEvent(configFile)).toBeUndefined();
  });

  it("a hooks key that is not an object holds no event name to object to", () => {
    writeFileSync(configFile, JSON.stringify({ hooks: [] }));
    expect(foreignEvent(configFile)).toBeUndefined();
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
    // `tool_response` is free-form: a version or an MCP-style tool that sends a bare
    // string has no `success` and no `output` — the whole value IS the output, and it
    // must not be dropped. `ok` is required on tool.ended, so a response that says
    // nothing about failure still reads true.
    const raw = hook("PostToolUse", { ...base, tool_response: "plain text output" });
    expect(raw?.events[0]).toMatchObject({ type: "tool.ended", data: { ok: true, output: "plain text output" } });
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

  it("a tool_response error given as an object, or as nothing readable, still reads", () => {
    const err = (tool_response: unknown) =>
      hook("PostToolUse", { session_id: "s1", tool_name: "exec", tool_response })?.events[0]?.data;
    expect(err({ success: false, error: { message: "boom" } })).toMatchObject({ ok: false, error: "boom" });
    expect(err({ success: false, error: { error: "nested" } })).toMatchObject({ ok: false, error: "nested" });
    expect(err({ success: false, error: { message: "", error: 5 } })?.error).toBeUndefined();
    expect(err({ success: false, error: 7 })?.error).toBeUndefined();
    expect(err({ success: false, error: "" })?.error).toBeUndefined();
  });

  it("a PermissionRequest with no turn, no tool and no input still names one attention", () => {
    const a = hook("PermissionRequest", { session_id: "s1" });
    expect(a?.events[0]?.data.attention_id).toMatch(/^perm-[0-9a-f]{16}$/);
    expect(a?.events[0]?.data.tool).toBeUndefined();
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
/** A message's own time, which is what times a turn. The real store writes this inside
 *  `chat_message.metadata` and keeps `message_nodes.created_at` for the time the row
 *  batch was last saved — ONE value for the whole chain, rewritten on every save, and
 *  not monotonic along it. The fixture is built that way on purpose: every row's column
 *  reads T, every message carries its own second, so a reader that trusts the column
 *  reports every turn at the same wrong instant and is caught here. */
const msgAt = (node: number) => new Date((T - 40 + node) * 1000).toISOString();
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const msg = (node: number, role: string, content: string, userInput?: boolean) =>
  JSON.stringify({
    message_id: `m-${role}-${node}`,
    role,
    content,
    metadata: { ...(userInput !== undefined ? { is_user_input: userInput } : {}), created_at: msgAt(node) },
  });

const sqlite3Cli = (() => {
  try {
    execFileSync("sqlite3", ["-version"], { stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch {
    return false;
  }
})();
/** Build a fixture from SQL text: `node:sqlite` where this Node has it, the `sqlite3`
 *  binary where it does not. That is what lets the store tests run on the Node 20 leg
 *  of CI — the one leg where `cli` is the adapter's ONLY way into the database, and
 *  the leg that used to skip every test of the reader it depends on. */
function execSql(file: string, stmts: string[]): boolean {
  if (sqliteInProcess()) {
    // Only the reader is restricted to read-only; the fixture needs a writer.
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (p: string) => { exec(s: string): void; close(): void };
    };
    const db = new DatabaseSync(file);
    // One transaction: a commit per statement is thousands of fsyncs, which took the
    // 4300-node fixture past a minute on Windows.
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
/** Can a fixture be built at all here? Only a machine with neither node:sqlite nor
 *  sqlite3 skips these, and such a machine gets no tier 2 and no facts from Devin
 *  either (ADAPTERS.md says so). */
const canMakeDb = sqliteInProcess() || sqlite3Cli;

function makeDb(file: string): boolean {
  const s: string[] = [...SCHEMA];
  s.push(
    `INSERT INTO sessions VALUES ('frill-vulture','/work/proj','windsurf','swe-2-medium','normal',${T - 60},${T},'\`head -1 sample.txt\`',27,0,'{}')`,
    `INSERT INTO sessions VALUES ('hidden-one','/work/proj','windsurf','swe-2-high','normal',${T - 60},${T},'x',3,1,'{}')`,
    `INSERT INTO prompt_history (content,timestamp,session_id,is_shell) VALUES ('ls -la',${T - 70},'frill-vulture',1)`,
    `INSERT INTO prompt_history (content,timestamp,session_id,is_shell) VALUES ('Read sample.txt and reply with its first word',${T - 60},'frill-vulture',0)`,
    `INSERT INTO prompt_history (content,timestamp,session_id,is_shell) VALUES ('and now the second',${T - 10},'frill-vulture',0)`,
  );
  // The canonical chain: 20 → 23 → 25 → 27. 21/22 are an abandoned branch that a naive
  // read of message_nodes would deliver as a second, wrong turn. Every row's
  // `created_at` is the one batch time T, as the real store writes it.
  const node = (id: number, parent: number | null, role: string, content: string, userInput?: boolean) =>
    s.push(
      `INSERT INTO message_nodes (session_id,node_id,parent_node_id,chat_message,created_at) VALUES ('frill-vulture',${id},${parent === null ? "NULL" : parent},${lit(msg(id, role, content, userInput))},${T})`,
    );
  node(19, null, "system", "You are Devin, an interactive command line agent from Cognition.");
  node(20, 19, "user", "Read sample.txt and reply with its first word", true);
  node(21, 20, "assistant", "WRONG BRANCH: abandoned");
  node(22, 21, "user", "abandoned follow-up", true);
  node(23, 20, "assistant", "");
  node(24, 23, "tool", "alpha-token-marker-42");
  node(25, 24, "user", "and now the second", true);
  node(26, 25, "user", "<system_info>generated, not typed</system_info>", false);
  node(27, 26, "assistant", "alpha");
  return execSql(file, s);
}

/** One session whose canonical chain is longer than CHAIN_SQL's cap: odd ids are the
 *  person, even ids the assistant, 1 the root. */
function makeLongChain(file: string, last: number, from = 1): boolean {
  const s: string[] =
    from === 1
      ? [
          ...SCHEMA,
          `INSERT INTO sessions VALUES ('long-chain','/work/proj','windsurf','swe-2-medium','normal',${T - 60},${T},'x',${last},0,'{}')`,
        ]
      : [`UPDATE sessions SET main_chain_id = ${last} WHERE id = 'long-chain'`];
  for (let id = from; id <= last; id++) {
    const role = id % 2 === 1 ? "user" : "assistant";
    s.push(
      `INSERT INTO message_nodes (session_id,node_id,parent_node_id,chat_message,created_at) VALUES ('long-chain',${id},${id === 1 ? "NULL" : id - 1},${lit(msg(id, role, `m${id}`, role === "user" ? true : undefined))},${T})`,
    );
  }
  return execSql(file, s);
}

describe.runIf(canMakeDb)("devin: the session store", () => {
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
    // The message's own time, never `message_nodes.created_at`: that column is the time
    // the row batch was last saved, one value for the whole chain (T here, as in the
    // real store), so trusting it reports every turn at the same instant.
    expect(r.turns[0]?.at).toBe(Date.parse(msgAt(20)));
    expect(r.turns[0]?.at).not.toBe(T * 1000);
    // node_id is the cursor: past the deepest node of the chain.
    expect(r.line).toBe(28);
  });

  it("two turns in one chain are timed apart, not both at the row batch's time", () => {
    // The bug this catches: every node of a chain carries the same `created_at`, so a
    // reader that prefers the column gives both turns one timestamp and backdates or
    // postdates them by however long the session ran.
    const r = readDevinChain(dbFile, "frill-vulture", 0);
    const second = readDevinChain(dbFile, "frill-vulture", 21);
    expect(second.turns).toHaveLength(1);
    expect(second.turns[0]?.at).toBe(Date.parse(msgAt(25)));
    expect(second.turns[0]?.at).not.toBe(r.turns[0]?.at);
    expect((second.turns[0]?.at ?? 0) - (r.turns[0]?.at ?? 0)).toBe(5000);
  });

  it("a message with no time of its own falls back to the row's", () => {
    const only = path.join(home, "no-msg-time.db");
    expect(
      execSql(only, [
        ...SCHEMA,
        `INSERT INTO sessions VALUES ('t','/work/proj','windsurf','m','normal',${T},${T},'x',2,0,'{}')`,
        `INSERT INTO message_nodes (session_id,node_id,parent_node_id,chat_message,created_at) VALUES ('t',1,NULL,${lit(JSON.stringify({ role: "user", content: "hi", metadata: { is_user_input: true } }))},${T})`,
        `INSERT INTO message_nodes (session_id,node_id,parent_node_id,chat_message,created_at) VALUES ('t',2,1,${lit(JSON.stringify({ role: "assistant", content: "there" }))},${T})`,
      ]),
    ).toBe(true);
    expect(readDevinChain(only, "t", 0).turns[0]?.at).toBe(T * 1000);
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
      // The hook's environment, so nothing here reads the developer's real
      // ~/.config/devin or data dir — and so a swept job addresses the right store.
      env,
    );
    // The temp home has no _versions symlink and no org id: these must be absent, not
    // the live machine's version and account.
    expect(f.harness_version).toBeUndefined();
    expect(f.account_id).toBeUndefined();
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

  it("readTranscript takes the <db>#<session> address, and facts without one fall back to the store under the env", () => {
    expect(devin.readTranscript(`${dbFile}#frill-vulture`, 0).turns).toHaveLength(1);
    const state = { get: () => ({}), save: () => {} };
    expect(devin.facts({ id: "frill-vulture" }, undefined, {}, state, env).model).toBe("swe-2-medium");
    // A session id that is not one never reaches the query.
    expect(devin.facts({ id: "../etc/passwd" }, undefined, {}, state, env)).toEqual({});
    expect(splitRef(undefined)).toBeNull();
    expect(splitRef("#frill-vulture")).toBeNull();
    expect(splitRef(`${dbFile}#not a session`)).toBeNull();
  });

  it("rows that say nothing: no model, a relative folder, zero times, no ask or a blank one, an id that is not one", () => {
    expect(
      execSql(dbFile, [
        `INSERT INTO sessions VALUES ('bare-one','relative/dir','windsurf','','normal',0,0,NULL,1,0,'{}')`,
        `INSERT INTO sessions VALUES ('blank-ask','/work/proj','windsurf','m','normal',${T - 5},${T - 5},NULL,1,0,'{}')`,
        `INSERT INTO prompt_history (content,timestamp,session_id,is_shell) VALUES ('\n  \n',${T},'blank-ask',0)`,
        `INSERT INTO sessions VALUES ('not a session id','/work/proj','windsurf','m','normal',${T - 5},${T - 5},NULL,1,0,'{}')`,
        `INSERT INTO sessions VALUES (x'00','/work/proj','windsurf','m','normal',${T - 5},${T - 5},NULL,1,0,'{}')`,
        `INSERT INTO sessions VALUES ('long-ask','/work/proj','windsurf','m','normal',${T - 6},${T - 6},NULL,1,0,'{}')`,
        `INSERT INTO prompt_history (content,timestamp,session_id,is_shell) VALUES (${lit(`${"a word ".repeat(20)}end`)},${T},'long-ask',0)`,
      ]),
    ).toBe(true);
    const state = { get: () => ({}), save: () => {} };
    expect(devin.facts({ id: "bare-one" }, `${dbFile}#bare-one`, {}, state, env)).toEqual({});
    const blank = devin.facts({ id: "blank-ask" }, `${dbFile}#blank-ask`, {}, state, env);
    expect(blank.title).toBeUndefined();
    expect(blank.model).toBe("m");
    // A long first ask is cut at a word, 80 characters and an ellipsis.
    const long = devin.facts({ id: "long-ask" }, `${dbFile}#long-ask`, {}, state, env);
    expect(long.title).toMatch(/^a word .*\S…$/);
    expect(long.title).not.toContain("end");
    expect(long.title?.length).toBeLessThanOrEqual(81);
    // Backfill skips what it cannot place: no times, or no id a session ref could carry.
    expect(devin.backfill(0, env).map((r) => r.session.id)).toEqual(["frill-vulture", "blank-ask", "long-ask"]);
  });

  it("the version and the account ride along with the store's facts, and alone when the session is not in it", () => {
    writeFileSync(configFile, JSON.stringify({ version: 1, devin: { org_id: "org-f6a1d67f" } }));
    if (process.platform !== "win32") {
      const versions = path.join(path.dirname(dbFile), "_versions");
      mkdirSync(path.join(versions, "3000.11.3"), { recursive: true });
      symlinkSync("3000.11.3", path.join(versions, "current"));
    }
    const state = { get: () => ({}), save: () => {} };
    const f = devin.facts({ id: "frill-vulture" }, `${dbFile}#frill-vulture`, {}, state, env);
    expect(f.account_id).toBe("org-f6a1d67f");
    expect(f.model).toBe("swe-2-medium");
    if (process.platform !== "win32") expect(f.harness_version).toBe("3000.11.3");
    const none = devin.facts({ id: "no-such-session" }, `${dbFile}#no-such-session`, {}, state, env);
    expect(none.account_id).toBe("org-f6a1d67f");
    expect(none.model).toBeUndefined();
  });

  it("a chain whose nodes are not what the schema promises is skipped node by node, never thrown on", () => {
    const row = (session: string, id: string, parent: string, chat: string, at: number) =>
      `INSERT INTO message_nodes (session_id,node_id,parent_node_id,chat_message,created_at) VALUES ('${session}',${id},${parent},${lit(chat)},${at})`;
    expect(
      execSql(dbFile, [
        `INSERT INTO sessions VALUES ('odd-nodes','/work/proj','windsurf','m','normal',${T},${T},NULL,'abc',0,'{}')`,
        row("odd-nodes", "'abc'", "NULL", msg(1, "assistant", "unreachable"), T),
        `INSERT INTO sessions VALUES ('bad-json','/work/proj','windsurf','m','normal',${T},${T},NULL,5,0,'{}')`,
        row(
          "bad-json",
          "1",
          "NULL",
          JSON.stringify({ role: "user", content: 5, metadata: { is_user_input: true } }),
          T,
        ),
        row("bad-json", "2", "1", "not json", T),
        row(
          "bad-json",
          "3",
          "2",
          JSON.stringify({ role: "user", content: "hi", metadata: { is_user_input: true } }),
          0,
        ),
        row("bad-json", "4", "3", JSON.stringify({ role: "assistant", content: "hello" }), T),
        // A blob where the JSON should be: the reader reads it as null.
        `INSERT INTO message_nodes (session_id,node_id,parent_node_id,chat_message,created_at) VALUES ('bad-json',5,4,x'00',${T})`,
      ]),
    ).toBe(true);
    // A node id that is not a number is no cursor.
    expect(readDevinChain(dbFile, "odd-nodes", 0).turns).toEqual([]);
    const before = Date.now();
    const r = readDevinChain(dbFile, "bad-json", 0);
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0]?.user).toBe("hi");
    expect(r.turns[0]?.assistant).toBe("hello");
    // No time in the message and none on the row: now, rather than 1970.
    expect(r.turns[0]?.at).toBeGreaterThanOrEqual(before);
    expect(r.line).toBe(6);
  });

  it("a missing, unreadable or wrongly addressed store costs an empty read, never a throw", () => {
    expect(readDevinChain(path.join(home, "nope.db"), "frill-vulture", 4).line).toBe(4);
    expect(readDevinChain(dbFile, "no-such-session", 0).turns).toEqual([]);
    expect(readDevinChain(dbFile, "../etc/passwd", 0).turns).toEqual([]);
    expect(devin.readTranscript("no-hash-here", 7)).toEqual({ turns: [], line: 7 });
    const notADb = path.join(home, "text.db");
    writeFileSync(notADb, "this is not a database");
    expect(readDevinChain(notADb, "frill-vulture", 0).turns).toEqual([]);
    const gone = path.join(home, "gone");
    expect(devin.backfill(0, { ...env, XDG_DATA_HOME: gone, APPDATA: gone })).toEqual([]);
  });

  // The CI matrix runs Node 20, where node:sqlite does not exist and the child path
  // cannot work either (`node --experimental-sqlite` is not even a known flag there),
  // so `cli` is the only way in; aifoundry1 runs 22.11, where the flag is needed and
  // the worker spawns none, so `child` is its way in. Each engine is asserted where it
  // works, and skipped only for itself — never all three behind one gate.
  it("every SQLite engine this machine has reads the same rows", (ctx) => {
    const sql = "SELECT id, model FROM sessions WHERE hidden = 0";
    const want = [{ id: "frill-vulture", model: "swe-2-medium" }];
    const ran: string[] = [];
    for (const engine of ["node", "child", "cli"] as const) {
      const r = querySqlite(dbFile, sql, [], { engine });
      if (!r) continue;
      ran.push(engine);
      expect(r, engine).toEqual(want);
    }
    // A machine with none of the three gets no tier 2 and no facts from Devin at all
    // (ADAPTERS.md says so); there is nothing here to assert.
    if (!ran.length) ctx.skip();
  });

  it("the Node 20 path: the chain query itself runs through the sqlite3 CLI", (ctx) => {
    if (!sqlite3Cli) ctx.skip();
    // `cli` is the only engine on the declared Node floor, and it can only run a query
    // whose parameters `inlineParams` accepts — so the adapter's own SQL is what is
    // tested, not a stand-in.
    const params = ["frill-vulture", "frill-vulture", "frill-vulture", 0];
    expect(inlineParams(CHAIN_SQL, params)).toContain("'frill-vulture'");
    const cli = querySqlite(dbFile, CHAIN_SQL, params, { engine: "cli" });
    expect(cli?.map((r) => Number(r.node_id))).toEqual([27, 26, 25, 24, 23, 20, 19]);
    if (sqliteInProcess()) expect(querySqlite(dbFile, CHAIN_SQL, params, { engine: "node" })).toEqual(cli);
  });

  it("a forced engine that cannot work returns null, not an exception", () => {
    expect(querySqlite(path.join(home, "nope.db"), "SELECT 1", [], { engine: "child" })).toBeNull();
    expect(querySqlite(path.join(home, "nope.db"), "SELECT 1", [], { engine: "cli" })).toBeNull();
    expect(querySqlite(dbFile, "SELECT bad syntax here", [], { engine: "cli" })).toBeNull();
  });

  it("inlineParams writes plain scalars and refuses anything it cannot write safely", () => {
    expect(inlineParams("SELECT ?, ?", ["frill-vulture", 12])).toBe("SELECT 'frill-vulture', 12");
    expect(inlineParams("SELECT ?", ["it's"])).toBeNull(); // a quote
    expect(inlineParams("SELECT ?", ["a\nb"])).toBeNull(); // a newline
    expect(inlineParams("SELECT 'x', ?", ["a"])).toBeNull(); // a literal already in the SQL
    expect(inlineParams("SELECT ?, ?", ["a"])).toBeNull(); // the hole count disagrees
    expect(inlineParams("SELECT ?", [Number.NaN])).toBeNull();
  });
});

describe.runIf(canMakeDb)("devin: a chain longer than the cap", () => {
  const LAST = 4300; // past CHAIN_SQL's LIMIT 4000
  let longDb: string;
  beforeEach(() => {
    longDb = path.join(home, "long.db");
    expect(makeLongChain(longDb, LAST)).toBe(true);
  }, 60_000);

  it("delivers the NEWEST turns and keeps moving, instead of stalling for good", () => {
    // The bug this catches: an ascending `LIMIT 4000` keeps the 4000 OLDEST nodes and
    // the cursor jumps past them, so every later read returns nothing — permanently —
    // and the newest turns are never delivered at all.
    const first = readDevinChain(longDb, "long-chain", 0);
    expect(first.turns.length).toBeGreaterThan(0);
    expect(first.line).toBe(LAST + 1);
    // The last exchange in the chain is in this read, not left behind the cap.
    expect(first.turns.at(-1)).toMatchObject({ user: `m${LAST - 1}`, assistant: `m${LAST}` });
    // Nothing new yet: an empty read, with the cursor where it was.
    const again = readDevinChain(longDb, "long-chain", first.line);
    expect(again.turns).toEqual([]);
    expect(again.line).toBe(first.line);
    // Two more exchanges arrive and are delivered — the cursor is not wedged.
    expect(makeLongChain(longDb, LAST + 4, LAST + 1)).toBe(true);
    const next = readDevinChain(longDb, "long-chain", again.line);
    expect(next.turns).toHaveLength(2);
    expect(next.turns[0]).toMatchObject({ user: `m${LAST + 1}`, assistant: `m${LAST + 2}` });
    expect(next.line).toBe(LAST + 5);
  }, 60_000);

  it("the cursor bounds the walk, so a Stop does not re-read the whole chain", () => {
    const bounded = querySqlite(longDb, CHAIN_SQL, ["long-chain", "long-chain", "long-chain", LAST - 3]);
    expect(bounded?.map((r) => Number(r.node_id))).toEqual([LAST, LAST - 1, LAST - 2, LAST - 3]);
  }, 60_000);
});

describe("devin: version and account", () => {
  // A directory symlink needs a privilege Windows runners do not have.
  it.skipIf(process.platform === "win32")("the version comes from the _versions/current symlink", () => {
    const versions = path.join(path.dirname(dbFile), "_versions");
    mkdirSync(path.join(versions, "3000.11.3"), { recursive: true });
    symlinkSync("3000.11.3", path.join(versions, "current"));
    expect(devinVersion(env)).toBe("3000.11.3");
    // A link to something that is not a version number names none.
    unlinkSync(path.join(versions, "current"));
    symlinkSync("latest", path.join(versions, "current"));
    expect(devinVersion(env)).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("without XDG_* the config and the store live under the home", () => {
    expect(devinConfigDir({ HOME: home })).toBe(path.join(home, ".config", "devin"));
    expect(devinDataDir({ HOME: home })).toBe(path.join(home, ".local", "share", "devin", "cli"));
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
