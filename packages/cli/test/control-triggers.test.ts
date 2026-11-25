// SPDX-License-Identifier: Apache-2.0
// The person's trigger rules in the daemon (CONTROL.md §14): a clock rule's run goes down the
// same start path an ask takes, at the rule's narrowed level, with the rule's MCP tools, its
// framed words and SESSIONPIPE_TRIGGERED_BY; a rule that continues a session waits while a
// window holds it and is then resumed, never forked; the machine's caps on starts make it
// wait; a session that is gone pauses the rule in the daemon's own record, and `trigger
// resume` lets go of that pause; `triggers off` stops a running triggered turn; a permission
// prompt a triggered run raises is answered by nothing; and an ask from a triggered session is
// an ask like any other (§13), `safe` at most. The agent is a stand-in `claude` that logs how
// it was run.
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { runHeadless, type TriggerRule, type TriggersFile } from "@sessionpipe/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlDaemon, type DaemonDeps, type SdkHost } from "../src/control/daemon.js";
import { ask, askMany, type LocalReply } from "../src/control/local.js";
import type { ControlConfig, ControlMode } from "../src/control/store.js";
import type { TriggerState } from "../src/control/triggers.js";
import { jsonLines } from "./helpers/lines.js";

const SID = "8c132906-8c3f-4814-870a-afc3d05e1d2e";
const MON_0900 = Date.parse("2026-11-23T09:00:10.000Z");
const unix = process.platform !== "win32";

let tmp: string;
let d: ControlDaemon | null = null;
let sock: string;
let project: string;
let configDir: string;
let calls: string;
let fakeClaude: string;
let clock: number;
let file: TriggersFile | null;
let logs: string[];

interface Run {
  argv: string[];
  cwd: string;
  triggered_by: string | null;
  asked_by: string | null;
}
const runs = (): Run[] => jsonLines<Run>(calls);
const record = (): TriggerState =>
  JSON.parse(readFileSync(path.join(tmp, "state", "control", "triggers-state.json"), "utf8"));
const until = async (ok: () => boolean, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 25))) if (ok()) return;
  throw new Error("waited too long");
};

/** The stand-in `claude`. It logs how it was run; `slow` makes its turn take that long. A
 *  triggered run (SESSIONPIPE_TRIGGERED_BY in its environment) may also, as `act` says: raise a
 *  permission prompt over the daemon's socket as Claude Code's hook does, and answer from what
 *  came back (`permission`); or ask another agent from its own environment (`ask`). */
function writeFake(slow = 0, act: "permission" | "ask" | null = null): void {
  writeFileSync(
    fakeClaude,
    `#!/usr/bin/env node
const fs = require("fs"), net = require("net");
const a = process.argv.slice(2);
const log = (o) => fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(o) + "\\n");
log({ argv: a, cwd: process.cwd(), triggered_by: process.env.SESSIONPIPE_TRIGGERED_BY || null, asked_by: process.env.SESSIONPIPE_ASKED_BY || null });
const i = a.indexOf("--resume"), j = a.indexOf("--session-id");
const sid = i >= 0 ? a[i + 1] : j >= 0 ? a[j + 1] : "x";
const done = (result) => setTimeout(() => process.stdout.write(JSON.stringify({ type: "result", result, session_id: sid, is_error: false })), ${slow});
const act = process.env.SESSIONPIPE_TRIGGERED_BY ? ${JSON.stringify(act)} : null;
const talk = (req, ms, then) => {
  const c = net.connect(${JSON.stringify(sock)}); let got = "";
  c.on("data", (b) => { got += b; }); c.on("error", () => then(null));
  c.write(JSON.stringify(req) + "\\n");
  setTimeout(() => { c.destroy(); then(got || null); }, ms);
};
if (act === "permission")
  talk({ op: "permission", session: "claude-code:" + sid, attention: "perm-1", tool: "Bash" }, 1500, (got) => {
    const reply = got && got.includes("allow") ? "ran Bash" : "denied: Bash (git push), which needs a person's approval";
    log({ permission_answer: got, reply });
    done(reply);
  });
else if (act === "ask")
  talk({ op: "ask", harness: "claude-code", text: "check this", cwd: process.cwd(), from: "claude-code:" + sid,
    chain: (process.env.SESSIONPIPE_ASK_CHAIN || "").split(",").filter(Boolean) }, 4000, (got) => { log({ asked: got }); done("asked"); });
else done("done");
`,
  );
  chmodSync(fakeClaude, 0o755);
}

/** A Claude Code transcript for `sid` in `cwd`, written long before the test's clock. */
function transcript(sid: string, cwd = project): void {
  const dir = path.join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${sid}.jsonl`);
  writeFileSync(f, `${JSON.stringify({ type: "user", cwd, message: { content: "hi" } })}\n`);
  const past = new Date("2026-01-01T00:00:00.000Z");
  utimesSync(f, past, past);
}

/** A window holding `sid`: a registry row with this test's own pid, which is alive. */
const holds = (sid: string) =>
  writeFileSync(
    path.join(configDir, "sessions", `${process.pid}.json`),
    JSON.stringify({ sessionId: sid, pid: process.pid, kind: "interactive" }),
  );

const rule = (over: Partial<TriggerRule> = {}): TriggerRule => ({
  name: "monday-report",
  paused: false,
  source: { every: "mon 09:00" },
  target: { start: "claude-code" },
  folder: project,
  level: "edits",
  tools: ["mcp__board"],
  cap: { per_day: 2 },
  words: "Make last week's report.",
  ...over,
});

async function startDaemon(
  o: { mode?: ControlMode; limits?: ControlConfig["limits"]; extra?: Partial<DaemonDeps> } = {},
) {
  const c: ControlConfig = {
    name: "studio-mac",
    folders: [project],
    mode: o.mode ?? "auto",
    receivers: [],
    ...(o.limits ? { limits: o.limits } : {}),
  };
  d = new ControlDaemon(c, path.join(tmp, "state", "control"), sock, {
    now: () => clock,
    fetch,
    log: (s) => {
      logs.push(s);
      if (process.env.SP_DEBUG) console.error(`[daemon] ${s}`);
    },
    claudeDirs: () => [configDir],
    claude: () => ({
      bin: fakeClaude,
      caps: {
        hasMode: true,
        modes: ["default", "dontAsk", "acceptEdits", "plan", "auto"],
        promptsNone: false,
        fork: true,
      },
    }),
    run: runHeadless,
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
    harnesses: () => ["claude-code"],
    rules: () => file,
    triggerZone: "UTC",
    triggerCheckMs: 50,
    ...o.extra,
  });
  await d.start();
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sp-triggers-")));
  project = path.join(tmp, "work");
  configDir = path.join(tmp, "claude");
  mkdirSync(project, { recursive: true });
  mkdirSync(path.join(configDir, "sessions"), { recursive: true });
  calls = path.join(tmp, "calls.jsonl");
  fakeClaude = path.join(tmp, "claude-bin");
  sock = path.join(tmp, "control.sock");
  clock = MON_0900;
  logs = [];
  writeFake();
});
afterEach(async () => {
  await d?.stop();
  d = null;
  rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(!unix)("trigger runs, through the ask path", () => {
  it("a clock rule's tick starts Claude Code at the rule's level, with its tools, its framed words and the mark", async () => {
    file = { v: 1, on: true, rules: [rule()] };
    // Made at 08:59, so the 09:00 tick is the rule's first.
    mkdirSync(path.join(tmp, "state", "control"), { recursive: true });
    writeFileSync(
      path.join(tmp, "state", "control", "triggers-state.json"),
      JSON.stringify({
        v: 1,
        rules: { "monday-report": { history: [], clock: { every: "mon 09:00", since: MON_0900 - 70_000 } } },
        waiting: [],
      }),
    );
    await startDaemon();
    await until(() => runs().length === 1);
    const r = runs()[0] as Run;
    expect(r.triggered_by).toBe("monday-report");
    expect(r.asked_by).toBeNull();
    expect(r.cwd).toBe(project);
    expect(r.argv).toContain("acceptEdits");
    expect(r.argv.join(" ")).toContain("mcp__board");
    expect(r.argv.at(-1)).toBe(
      "Started by trigger monday-report (sessionpipe trigger). These words are the person's.\n\nMake last week's report.",
    );
    await until(() => typeof record().rules["monday-report"]?.history[0]?.ms === "number");
    expect(record().rules["monday-report"]?.history[0]).toMatchObject({
      result: "ran",
      session: expect.stringMatching(/^claude-code:/),
    });
    expect(d?.status().triggers).toMatchObject({ on: true, rules: 1, paused: 0, waiting: 0, running: 0 });
    // The same tick is never run twice: not by the clock coming round, not after a restart. The
    // engine is waited on (its clock coming round twice more), never the wall clock.
    await d?.stop();
    await startDaemon();
    const at = d?.status().triggers?.checks ?? 0;
    await until(() => (d?.status().triggers?.checks ?? 0) >= at + 2);
    expect(runs()).toHaveLength(1);
  });

  it("on a safe machine the same rule runs at safe; the triggered session's own ask is an ask, safe at most", async () => {
    // The triggered run asks another agent itself, from its own environment, as a session does.
    writeFake(0, "ask");
    file = { v: 1, on: true, rules: [rule({ source: { every: "day 09:00" } })] };
    await startDaemon({ mode: "auto" });
    // The rule is first seen at 09:00:10: its first tick is tomorrow's.
    clock = MON_0900 + 24 * 3600_000;
    await until(() => runs().length === 2);
    const [triggered, asked] = runs() as [Run, Run];
    expect(triggered.triggered_by).toBe("monday-report");
    expect(triggered.argv).toContain("acceptEdits");
    const sid = triggered.argv[triggered.argv.indexOf("--session-id") + 1];
    // The ask: safe at most on this auto machine, no trigger mark, asked by the triggered session.
    expect(asked.argv).toContain("dontAsk");
    expect(asked.argv.join(" ")).not.toContain("mcp__board");
    expect(asked.triggered_by).toBeNull();
    expect(asked.asked_by).toBe(`claude-code:${sid}`);
    await until(() => jsonLines<{ asked?: string }>(calls).some((x) => x.asked));
    expect(jsonLines<{ asked?: string }>(calls).find((x) => x.asked)?.asked).toContain('"op":"answer"');
  });

  it("a rule that continues a session waits while a window holds it, then resumes it in place, never a copy", async () => {
    transcript(SID);
    holds(SID);
    file = {
      v: 1,
      on: true,
      rules: [rule({ name: "nightly", target: { continue: `claude-code:${SID}` }, source: { every: "day 09:00" } })],
    };
    await startDaemon();
    clock = MON_0900 + 24 * 3600_000;
    await until(() => d?.status().triggers?.waiting === 1);
    expect(runs()).toHaveLength(0);
    rmSync(path.join(configDir, "sessions", `${process.pid}.json`));
    await until(() => runs().length === 1);
    const r = runs()[0] as Run;
    expect(r.argv).toContain("--resume");
    expect(r.argv).toContain(SID);
    expect(r.argv).not.toContain("--fork-session");
    expect(r.argv.at(-1)?.startsWith("Sent by trigger nightly (sessionpipe trigger).")).toBe(true);
  });

  it("the machine's caps on starts make a run wait, and a session that is gone pauses its rule until resumed", async () => {
    file = {
      v: 1,
      on: true,
      rules: [
        rule({ source: { every: "day 09:00" } }),
        rule({ name: "gone", source: { every: "day 09:00" }, target: { continue: `claude-code:${SID}` } }),
      ],
    };
    await startDaemon({ limits: { start_concurrent: 0 } });
    clock = MON_0900 + 24 * 3600_000;
    await until(() => d?.status().triggers?.waiting === 1);
    expect(d?.status().triggers).toMatchObject({ paused: 1, waiting: 1 });
    expect(record().rules.gone?.paused).toMatchObject({ code: "no_session" });
    expect(record().rules.gone?.history[0]).toMatchObject({ result: "refused", code: "no_session" });
    // The rules file is the person's and stays as they confirmed it.
    expect(file.rules[1]?.paused).toBe(false);
    expect(await ask(sock, { op: "trigger", action: "resume", name: "gone" }, 2000)).toEqual({ op: "ok" });
    expect(record().rules.gone?.paused).toBeUndefined();
    expect(await ask(sock, { op: "trigger", action: "resume", name: "gone" }, 2000)).toEqual({ op: "none" });
    expect(await ask(sock, { op: "trigger", action: "pause", name: "gone" } as never, 2000)).toEqual({ op: "none" });
  });

  it("triggers off stops a running triggered turn, as a cancel would", async () => {
    writeFake(20_000);
    file = { v: 1, on: true, rules: [rule({ source: { every: "day 09:00" } })] };
    await startDaemon();
    clock = MON_0900 + 24 * 3600_000;
    await until(() => runs().length === 1 && d?.status().triggers?.running === 1);
    file = { ...file, on: false };
    d?.reloadRules();
    await until(() => d?.status().triggers?.running === 0);
    expect(d?.status().triggers).toMatchObject({ on: false, running: 0 });
    await until(() => typeof record().rules["monday-report"]?.history[0]?.ms === "number");
    expect(logs.some((l) => l.includes("trigger rules changed"))).toBe(true);
  });

  it("nothing answers a permission prompt a triggered run raises: it is denied, and the reply says what", async () => {
    // The stand-in raises the prompt itself, mid-turn, as Claude Code's PermissionRequest hook
    // does, and answers from what comes back: an allow from anywhere would show here.
    writeFake(0, "permission");
    file = { v: 1, on: true, rules: [rule({ source: { every: "day 09:00" } })] };
    await startDaemon();
    clock = MON_0900 + 24 * 3600_000;
    await until(() => jsonLines<{ permission_answer?: string | null }>(calls).some((x) => "permission_answer" in x));
    const answer = jsonLines<{ permission_answer?: string | null; reply?: string }>(calls).find(
      (x) => "permission_answer" in x,
    );
    expect(answer?.permission_answer ?? "").not.toContain("allow");
    expect(answer?.reply).toBe("denied: Bash (git push), which needs a person's approval");
    await until(() => logs.some((l) => /ack \S+ delivered/.test(l)));
    expect(logs.some((l) => l.includes("allow"))).toBe(false);
  });

  it("through the Agent SDK: no turn runs with another cause's tools, level or mark, either way", async () => {
    const opened: { session: string; permission: string; allowedTools?: string[]; env?: Record<string, string> }[] = [];
    const sent: string[] = [];
    let closed = 0;
    let slow = false;
    let interrupted = 0;
    const sdk: SdkHost = {
      start: (o) => {
        opened.push(o);
        transcript(o.session);
        const s = {
          busy: false,
          lastUsed: Date.now(),
          send: async (text: string) => {
            s.busy = true;
            sent.push(text);
            if (slow) await until(() => interrupted > 0 || !slow, 20_000);
            s.busy = false;
            return { reply: "done" };
          },
          interrupt: async () => {
            interrupted++;
          },
          close: () => {
            closed++;
          },
        };
        return s;
      },
    };
    const day = (name: string, over: Partial<TriggerRule> = {}) =>
      rule({ name, source: { every: "day 09:00" }, ...over });
    const next = () => {
      d?.reloadRules();
      clock += 24 * 3600_000;
    };
    file = { v: 1, on: true, rules: [day("a")] };
    await startDaemon({ extra: { sdk } });
    clock += 24 * 3600_000;
    await until(() => closed === 1);
    expect(opened[0]).toMatchObject({
      permission: "edits",
      allowedTools: ["mcp__board"],
      env: { SESSIONPIPE_TRIGGERED_BY: "a" },
    });
    // Rule a's session was closed with its turn. Rule b continues it at its own level, tools
    // and mark: a cold resume (claude -p), never a send into a's session.
    const aSession = `claude-code:${opened[0]?.session}`;
    file = { v: 1, on: true, rules: [day("b", { target: { continue: aSession }, level: "safe", tools: [] })] };
    next();
    await until(() => runs().length === 1);
    expect(sent).toHaveLength(1);
    const b = runs()[0] as Run;
    expect(b.argv).toContain("--resume");
    expect(b.argv).toContain("dontAsk");
    expect(b.argv.join(" ")).not.toContain("mcp__board");
    expect(b.triggered_by).toBe("b");
    // While rule c's own turn runs in a session it opened, an ask into that session is not sent
    // there; once c's turn is over, the ask resumes it cold, at safe, with no tools and no mark.
    slow = true;
    file = { v: 1, on: true, rules: [day("c")] };
    next();
    await until(() => sent.length === 2);
    await until(() => record().rules.c?.history[0]?.result === "ran");
    const cSession = `claude-code:${opened[1]?.session}`;
    const during = await ask(
      sock,
      { op: "ask", harness: "claude-code", text: "hi", cwd: project, chain: [], session: cSession },
      4000,
    );
    expect(during).toMatchObject({ op: "failed", detail: expect.stringContaining("for its own turn") });
    expect(sent).toHaveLength(2);
    // Turned off mid-turn: the held session is interrupted, and the run keeps its count.
    file = { ...file, on: false };
    d?.reloadRules();
    expect(interrupted).toBe(1);
    await until(() => closed === 2);
    expect(record().rules.c?.today?.runs).toBe(1);
    slow = false;
    const after: LocalReply[] = [];
    await askMany(
      sock,
      { op: "ask", harness: "claude-code", text: "hi", cwd: project, chain: [], session: cSession },
      (x) => after.push(x),
      8000,
    );
    expect(after.at(-1)).toMatchObject({ op: "answer" });
    const asked = runs().at(-1) as Run;
    expect(asked.argv).toContain("dontAsk");
    expect(asked.argv.join(" ")).not.toContain("mcp__board");
    expect(asked.triggered_by).toBeNull();
    expect(sent).toHaveLength(2);
    // A session someone else opened (an ask) and the daemon holds: a rule's turn never goes into
    // it. It waits, as for a window, and nothing is sent.
    const opener: LocalReply[] = [];
    await askMany(
      sock,
      { op: "ask", harness: "claude-code", text: "hi", cwd: project, chain: [] },
      (x) => opener.push(x),
      8000,
    );
    expect(sent).toHaveLength(3);
    const askSession = `claude-code:${opened[2]?.session}`;
    expect(opened[2]?.env?.SESSIONPIPE_TRIGGERED_BY).toBeUndefined();
    file = { v: 1, on: true, rules: [day("d", { target: { continue: askSession } })] };
    next();
    await until(() => d?.status().triggers?.waiting === 1);
    expect(sent).toHaveLength(3);
  });

  it("Codex: a session continued runs at the level its start recorded, and waits while Codex has the thread locked", async () => {
    const codexHome = path.join(tmp, "codex-home");
    const fakeCodex = path.join(tmp, "codex-bin");
    writeFileSync(
      fakeCodex,
      `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const a = process.argv.slice(2);
if (a[0] === "--version") { process.stdout.write("codex-cli 0.171.0\\n"); process.exit(0); }
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ argv: a, cwd: process.cwd(), triggered_by: process.env.SESSIONPIPE_TRIGGERED_BY || null, asked_by: null }) + "\\n");
const resume = a[1] === "resume";
const id = resume ? a[a.indexOf("--") + 1] : "0199b6f2-7c1d-7e3a-9b4c-5d6e7f8a9b0c";
if (!resume) {
  const day = path.join(process.env.CODEX_HOME, "sessions", "2026", "10", "28");
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, "rollout-2026-10-28T10-00-00-" + id + ".jsonl"), JSON.stringify({ type: "session_meta", payload: { id, cwd: process.cwd() } }) + "\\n");
}
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
out({ type: "thread.started", thread_id: id });
out({ type: "item.completed", item: { id: "i1", type: "agent_message", text: "done" } });
out({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
`,
    );
    chmodSync(fakeCodex, 0o755);
    file = {
      v: 1,
      on: true,
      rules: [
        rule({ name: "a", source: { every: "day 09:00" }, target: { start: "codex" }, level: "read", tools: [] }),
      ],
    };
    await startDaemon({
      extra: {
        codex: () => fakeCodex,
        harnesses: () => ["claude-code", "codex"],
        env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, CODEX_HOME: codexHome },
      },
    });
    clock = MON_0900 + 24 * 3600_000;
    await until(() => runs().length === 1);
    expect(runs()[0]?.argv.join(" ")).toContain("read-only");
    await until(() => typeof record().rules.a?.history[0]?.ms === "number");
    const aliases = JSON.parse(readFileSync(path.join(tmp, "state", "control", "aliases.json"), "utf8"));
    const name = (Object.keys(aliases)[0] as string).split(":").slice(1).join(":");
    const thread = "0199b6f2-7c1d-7e3a-9b4c-5d6e7f8a9b0c";
    mkdirSync(path.join(codexHome, "thread-writer-locks"), { recursive: true });
    writeFileSync(path.join(codexHome, "thread-writer-locks", `${thread}.lock`), "");
    file = {
      v: 1,
      on: true,
      rules: [
        rule({
          name: "b",
          source: { every: "day 09:00" },
          target: { continue: `codex:${name}` },
          level: "edits",
          tools: [],
        }),
      ],
    };
    d?.reloadRules();
    clock += 24 * 3600_000;
    await until(() => d?.status().triggers?.waiting === 1);
    rmSync(path.join(codexHome, "thread-writer-locks", `${thread}.lock`));
    // Its rollout last written long before the test's clock: nothing else has the thread.
    const day = path.join(codexHome, "sessions", "2026", "10", "28");
    const old = new Date("2026-01-01T00:00:00.000Z");
    for (const f of readdirSync(day)) utimesSync(path.join(day, f), old, old);
    await until(() => runs().length === 2);
    const r = runs()[1] as Run;
    expect(r.argv).toContain("resume");
    expect(r.argv.join(" ")).toContain("read-only");
    expect(r.triggered_by).toBe("b");
  });

  it("a session in a folder this computer doesn't allow is refused folder; with no Claude Code the run fails", async () => {
    const elsewhere = path.join(tmp, "elsewhere");
    mkdirSync(elsewhere);
    transcript(SID, elsewhere);
    file = {
      v: 1,
      on: true,
      rules: [rule({ name: "there", source: { every: "day 09:00" }, target: { continue: `claude-code:${SID}` } })],
    };
    await startDaemon();
    clock = MON_0900 + 24 * 3600_000;
    await until(() => record().rules.there?.history.length === 1);
    expect(record().rules.there?.history[0]).toMatchObject({ result: "refused", code: "folder" });
    await d?.stop();
    file = { v: 1, on: true, rules: [rule({ name: "nobody", source: { every: "day 09:00" } })] };
    clock = MON_0900;
    await startDaemon({ extra: { claude: () => null } });
    clock = MON_0900 + 24 * 3600_000;
    await until(() => record().rules.nobody?.history.length === 1);
    expect(record().rules.nobody?.history[0]).toMatchObject({ result: "failed" });
  });

  it("a run waiting for the headless slot has not begun: its history line comes when it has the slot", async () => {
    writeFake(1500);
    file = {
      v: 1,
      on: true,
      rules: [rule({ name: "a", source: { every: "day 09:00" } }), rule({ name: "b", source: { every: "day 09:00" } })],
    };
    await startDaemon({ limits: { headless: 1 } });
    clock = MON_0900 + 24 * 3600_000;
    await until(() => runs().length === 1 && d?.status().triggers?.running === 1);
    expect(d?.status().triggers?.waiting).toBe(1);
    // One has the slot and runs; the other is handed over and waits for it.
    const first = Object.entries(record().rules)
      .filter(([, st]) => st.history.length)
      .map(([n]) => n);
    expect(first).toHaveLength(1);
    await until(() => runs().length === 2);
    await until(() => Object.values(record().rules).every((st) => st.history[0]?.result === "ran"));
  });

  it("a continue rule waiting in its session's line, behind another turn, is a waiting run: off drops it", async () => {
    writeFake(1500);
    transcript(SID);
    file = {
      v: 1,
      on: true,
      rules: [rule({ name: "cont", source: { every: "day 09:00" }, target: { continue: `claude-code:${SID}` } })],
    };
    await startDaemon();
    // An ask into the same session: a turn the daemon runs itself, so the session's line is taken.
    const replies: LocalReply[] = [];
    const asking = askMany(
      sock,
      { op: "ask", harness: "claude-code", session: `claude-code:${SID}`, text: "long job", cwd: project, chain: [] },
      (x) => replies.push(x),
      15_000,
    );
    await until(() => runs().length === 1);
    clock = MON_0900 + 24 * 3600_000;
    await until(() => d?.status().triggers?.waiting === 1);
    expect(d?.status().triggers).toMatchObject({ waiting: 1, running: 0 });
    expect(record().rules.cont?.today?.runs).toBe(1);
    file = { ...file, on: false };
    d?.reloadRules();
    expect(d?.status().triggers).toMatchObject({ waiting: 0, running: 0 });
    expect(record().rules.cont?.history[0]).toMatchObject({ result: "refused", code: "triggers_off" });
    expect(record().rules.cont?.today?.runs).toBe(0);
    await asking;
    expect(replies.at(-1)).toMatchObject({ op: "answer" });
    // The session's line is free again, and the run it held never comes.
    const at = d?.status().triggers?.checks ?? 0;
    await until(() => (d?.status().triggers?.checks ?? 0) >= at + 2);
    expect(runs().map((r) => r.triggered_by)).toEqual([null]);
  });

  it("a window that takes the session while the run waits in its line: the run waits again, for the window", async () => {
    writeFake(1000);
    transcript(SID);
    file = {
      v: 1,
      on: true,
      rules: [rule({ name: "cont", source: { every: "day 09:00" }, target: { continue: `claude-code:${SID}` } })],
    };
    await startDaemon();
    const replies: LocalReply[] = [];
    const asking = askMany(
      sock,
      { op: "ask", harness: "claude-code", session: `claude-code:${SID}`, text: "long job", cwd: project, chain: [] },
      (x) => replies.push(x),
      15_000,
    );
    await until(() => runs().length === 1);
    clock = MON_0900 + 24 * 3600_000;
    await until(() => d?.status().triggers?.waiting === 1);
    // A window opens the session while the run waits behind the ask.
    holds(SID);
    await asking;
    await until(() => logs.some((l) => l.includes("trigger cont: the daemon said no (held)")));
    expect(d?.status().triggers).toMatchObject({ waiting: 1, running: 0 });
    expect(runs()).toHaveLength(1);
    rmSync(path.join(configDir, "sessions", `${process.pid}.json`));
    await until(() => runs().length === 2);
    expect(runs()[1]?.triggered_by).toBe("cont");
    expect(runs()[1]?.argv).not.toContain("--fork-session");
  });

  it("a session that goes while the run waits in its line: refused no_session, and the rule paused", async () => {
    writeFake(1000);
    transcript(SID);
    file = {
      v: 1,
      on: true,
      rules: [rule({ name: "cont", source: { every: "day 09:00" }, target: { continue: `claude-code:${SID}` } })],
    };
    await startDaemon();
    const asking = askMany(
      sock,
      { op: "ask", harness: "claude-code", session: `claude-code:${SID}`, text: "long job", cwd: project, chain: [] },
      () => {},
      15_000,
    );
    await until(() => runs().length === 1);
    clock = MON_0900 + 24 * 3600_000;
    await until(() => d?.status().triggers?.waiting === 1);
    rmSync(path.join(configDir, "projects"), { recursive: true });
    await asking;
    await until(() => record().rules.cont?.history[0]?.code === "no_session");
    expect(record().rules.cont?.paused).toMatchObject({ code: "no_session", why: "gone" });
    expect(runs()).toHaveLength(1);
  });

  it("a continue rule runs in its session's folder only when that is the rule's, allowed and over the floor", async () => {
    // The session's folder is not the rule's: refused folder, nothing runs.
    const sub = path.join(project, "sub");
    mkdirSync(sub);
    transcript(SID, sub);
    const cont = (folder: string) =>
      rule({ name: "cont", source: { every: "day 09:00" }, target: { continue: `claude-code:${SID}` }, folder });
    file = { v: 1, on: true, rules: [cont(project)] };
    await startDaemon();
    clock = MON_0900 + 24 * 3600_000;
    await until(() => record().rules.cont?.history.length === 1);
    expect(record().rules.cont?.history[0]).toMatchObject({ result: "refused", code: "folder" });
    // The session's folder is the rule's and allowed, but lies inside the harness's own folder.
    await d?.stop();
    rmSync(path.join(tmp, "state"), { recursive: true });
    const inside = path.join(configDir, "work");
    mkdirSync(inside);
    rmSync(path.join(configDir, "projects"), { recursive: true });
    transcript(SID, inside);
    file = { v: 1, on: true, rules: [cont(inside)] };
    clock = MON_0900;
    await startDaemon({ extra: {} });
    d?.reload({ name: "studio-mac", folders: [project, inside], mode: "auto", receivers: [] });
    d?.reloadRules();
    clock = MON_0900 + 24 * 3600_000;
    await until(() => record().rules.cont?.history.length === 1);
    expect(record().rules.cont?.history[0]).toMatchObject({ result: "refused", code: "folder" });
    expect(runs()).toHaveLength(0);
  });

  it("a rule named constructor is a rule like any other: it ticks, runs, is recorded and survives a restart", async () => {
    const CTOR: string = "constructor";
    file = { v: 1, on: true, rules: [rule({ name: "constructor", source: { every: "day 09:00" } })] };
    await startDaemon();
    clock = MON_0900 + 24 * 3600_000;
    await until(() => typeof record().rules[CTOR]?.history[0]?.ms === "number");
    expect(runs()[0]?.triggered_by).toBe("constructor");
    expect(Object.keys(record().rules)).toEqual(["constructor"]);
    await d?.stop();
    await startDaemon();
    const at = d?.status().triggers?.checks ?? 0;
    await until(() => (d?.status().triggers?.checks ?? 0) >= at + 2);
    expect(runs()).toHaveLength(1);
    expect(d?.status().triggers).toMatchObject({ on: true, rules: 1, waiting: 0 });
    expect(record().rules[CTOR]?.today?.runs).toBe(1);
  });

  it("a triggers' record of any wrong shape never stops the daemon: it starts and answers an ask", async () => {
    const dir = path.join(tmp, "state", "control");
    const shapes: string[] = [
      "not json",
      "[]",
      "null",
      '"v1"',
      JSON.stringify({ v: 2, rules: {}, waiting: [] }),
      JSON.stringify({ v: 1, rules: { "monday-report": { history: {} } }, waiting: [] }),
      JSON.stringify({ v: 1, rules: [], waiting: {} }),
      JSON.stringify({ v: 1, rules: { constructor: null, __proto__: { history: [] } }, waiting: [null, 1, "x"] }),
      JSON.stringify({
        v: 1,
        rules: { "monday-report": { history: [{ at: 5 }], today: { day: "x", runs: -9 }, clock: { since: "y" } } },
        waiting: [{ rule: "monday-report", cause: { kind: "tick", due: "z" }, until: 1e99, reason: "held" }],
      }),
      " ".repeat(4 * 1024 * 1024 + 1),
    ];
    // And a rules file no reader would have let through: the engine throws, the daemon goes on.
    mkdirSync(dir, { recursive: true });
    file = { v: 1, on: true, rules: [{ name: "x" } as never] };
    await startDaemon();
    expect(logs.some((l) => /^trigger rules: .+; the rest of this computer goes on$/.test(l))).toBe(true);
    const first: LocalReply[] = [];
    await askMany(
      sock,
      { op: "ask", harness: "claude-code", text: "hi", cwd: project, chain: [] },
      (x) => first.push(x),
      8000,
    );
    expect(first.at(-1)).toMatchObject({ op: "answer" });
    file = { v: 1, on: true, rules: [rule({ source: { every: "day 09:00" } })] };
    for (const shape of shapes) {
      // The one before stopped first: afterEach stops the last.
      await d?.stop();
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "triggers-state.json"), shape);
      clock = MON_0900;
      await startDaemon();
      const replies: LocalReply[] = [];
      await askMany(
        sock,
        { op: "ask", harness: "claude-code", text: "hi", cwd: project, chain: [] },
        (x) => replies.push(x),
        8000,
      );
      expect(replies.at(-1), shape.slice(0, 60)).toMatchObject({ op: "answer" });
      expect(d?.status().triggers, shape.slice(0, 60)).toMatchObject({ on: true, rules: 1, waiting: 0 });
    }
  });
});
