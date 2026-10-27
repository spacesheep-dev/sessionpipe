// SPDX-License-Identifier: Apache-2.0
// What a cold run of a session it did not start is launched with (CONTROL.md §6
// `prompt`): no mode of ours, except a narrowing the session itself chose, read from
// what its own hooks reported. And what a copy is owed: the harness's own
// source-is-alive contract, a note saying it is a copy, a link back on the ack, a cap
// per day, and never a copy of a copy.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeControl } from "@sessionpipe/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlDaemon, type DaemonDeps } from "../src/control/daemon.js";
import { ask } from "../src/control/local.js";
import type { ControlConfig } from "../src/control/store.js";
import { FakeReceiver } from "./helpers/receiver.js";

// Every case runs a stand-in `claude` as a real child process.
vi.setConfig({ testTimeout: 30_000 });

const SID = "8c132906-8c3f-4814-870a-afc3d05e1d2e";
const SESSION = `claude-code:${SID}`;
const COPY = "0b6f2c7e-3d4a-4f1b-9c8e-2a1d5e6f7a8b";
const unix = process.platform !== "win32";

let tmp: string;
let rx: FakeReceiver;
let d: ControlDaemon | null = null;
let env: NodeJS.ProcessEnv;
let sock: string;
let project: string;
let configDir: string;
let fakeClaude: string;
let claudeLog: string;
let log: string[];

const transcriptFile = (sid: string) =>
  path.join(configDir, "projects", project.replace(/[^a-zA-Z0-9]/g, "-"), `${sid}.jsonl`);

/** A session's transcript, old enough not to read as freshly written. */
function transcript(sid: string): void {
  const f = transcriptFile(sid);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, `${JSON.stringify({ type: "user", cwd: project, message: { content: "hi" } })}\n`);
  const past = new Date(Date.now() - 600_000);
  utimesSync(f, past, past);
}

function homeDefault(mode: string | null, extra: Record<string, unknown> = {}): void {
  writeFileSync(
    path.join(configDir, "settings.json"),
    JSON.stringify({ permissions: { ...(mode ? { defaultMode: mode } : {}), ...extra } }),
  );
}

/** Every run of the stand-in `claude`: its argv and the one env var a copy needs. */
const runs = (): { argv: string[]; alive: string | null }[] =>
  readFileSync(claudeLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { argv: string[]; alive: string | null });

const modeFlag = (argv: string[]) =>
  argv.includes("--permission-mode") ? argv[argv.indexOf("--permission-mode") + 1] : null;

function cfg(over: Partial<ControlConfig> = {}): ControlConfig {
  return {
    name: "testbox",
    folders: [project],
    mode: "inherit",
    receivers: [
      {
        url: rx.url,
        control: `${rx.url}/api/sessionpipe/v1/control`,
        rpId: "localhost",
        machine: rx.machine,
        token: rx.token,
        keys: [{ ...rx.passkey.key, added_at: new Date().toISOString() }],
        paired_at: new Date().toISOString(),
      },
    ],
    ...over,
  };
}

async function startDaemon(o: { cfg?: Partial<ControlConfig>; extra?: Partial<DaemonDeps> } = {}): Promise<void> {
  d = new ControlDaemon(cfg(o.cfg), path.join(tmp, "state", "control"), sock, {
    now: () => Date.now(),
    fetch,
    log: (s) => log.push(s),
    claudeDirs: () => [configDir],
    claude: () => ({
      bin: fakeClaude,
      caps: {
        hasMode: true,
        modes: ["plan", "default", "dontAsk", "acceptEdits", "auto"],
        promptsNone: false,
        fork: true,
      },
    }),
    run: claudeControl.runClaude,
    sdk: null,
    env,
    answerWaitMs: 2000,
    ...o.extra,
  });
  await d.start();
}

/** Say what the session's own hooks reported its permission mode to be. */
const sawMode = (mode: string, session = SESSION) =>
  ask(sock, { op: "event", session, event: "PostToolUse", mode }, 500);

/** A live process holds the session, with no inbox: the only way in is a copy. */
function liveNoInbox(sid = SID): void {
  mkdirSync(path.join(configDir, "sessions"), { recursive: true });
  writeFileSync(
    path.join(configDir, "sessions", `${process.pid}.json`),
    JSON.stringify({ sessionId: sid, pid: process.pid, kind: "interactive" }),
  );
}

beforeAll(async () => {
  rx = new FakeReceiver();
  await rx.start();
});
afterAll(async () => {
  await rx.stop();
});
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "sp-relaunch-"));
  project = path.join(tmp, "project");
  configDir = path.join(tmp, "claude-config");
  mkdirSync(project, { recursive: true });
  mkdirSync(path.join(configDir, "sessions"), { recursive: true });
  sock = path.join(mkdtempSync(path.join(os.tmpdir(), "sp-sr-")), "c.sock");
  claudeLog = path.join(tmp, "claude-calls.jsonl");
  fakeClaude = path.join(tmp, "claude");
  writeFileSync(
    fakeClaude,
    `#!/usr/bin/env node
const fs = require("fs");
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(claudeLog)}, JSON.stringify({ argv: a, alive: process.env.CLAUDE_CODE_RESUME_SOURCE_ALIVE ?? null }) + "\\n");
const i = a.indexOf("--resume"), fork = a.includes("--fork-session");
const sid = fork ? ${JSON.stringify(COPY)} : (i >= 0 ? a[i + 1] : "x");
// The turn's own row, as the harness writes it: what it really ran in.
const m = a.indexOf("--permission-mode");
const dir = ${JSON.stringify(path.join(tmp, "x"))};
const t = process.env.SP_TRANSCRIPT;
if (t) fs.appendFileSync(t, JSON.stringify({ type: "user", permissionMode: m >= 0 ? a[m + 1] : (process.env.SP_HOME_DEFAULT || "default") }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", result: "did it", session_id: sid, is_error: false }));
`,
  );
  chmodSync(fakeClaude, 0o755);
  log = [];
  env = {
    ...process.env,
    SESSIONPIPE_STATE: path.join(tmp, "state"),
    SESSIONPIPE_CONFIG: path.join(tmp, "config", "config.json"),
    SESSIONPIPE_SOCKET: sock,
  };
  transcript(SID);
  homeDefault("bypassPermissions");
  rx.queue.clear();
  rx.acks.length = 0;
});
afterEach(async () => {
  await d?.stop();
  d = null;
  rmSync(path.dirname(sock), { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});

describe.runIf(unix)("the mode a cold run is launched with", () => {
  it("re-asserts a narrowing the session chose, and nothing else ever", async () => {
    const cases: [string, string | null][] = [
      ["plan", "plan"],
      ["dontAsk", "dontAsk"],
      ["acceptEdits", "acceptEdits"],
      ["bypassPermissions", null],
      ["default", null],
      ["auto", null],
      ["manual", null],
    ];
    for (const [recorded, want] of cases) {
      rmSync(claudeLog, { force: true });
      await startDaemon();
      await sawMode(recorded);
      const q = await rx.send({ session: SESSION, kind: "prompt", text: `was in ${recorded}` });
      expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered", mode: "resume" });
      expect(modeFlag(runs()[0]?.argv ?? [])).toBe(want);
      // Never the two values a setting can quietly turn into something else: the flags,
      // not the prompt, which is the person's own words.
      expect(JSON.stringify(runs().map((x) => x.argv.slice(0, -1)))).not.toContain("bypassPermissions");
      await d?.stop();
      d = null;
    }
  });

  it("acceptEdits is not re-asserted where the account's own default is narrower, or unreadable", async () => {
    for (const def of ["default", null]) {
      rmSync(claudeLog, { force: true });
      homeDefault(def);
      if (def === null) rmSync(path.join(configDir, "settings.json"), { force: true });
      await startDaemon();
      await sawMode("acceptEdits");
      const q = await rx.send({ session: SESSION, kind: "prompt", text: "edits?" });
      await rx.waitAck(q.id);
      expect(modeFlag(runs()[0]?.argv ?? [])).toBeNull();
      await d?.stop();
      d = null;
    }
  });

  it("a machine that names a mode of its own keeps naming it", async () => {
    await startDaemon({ cfg: { mode: "safe" } });
    await sawMode("acceptEdits");
    const q = await rx.send({ session: SESSION, kind: "prompt", text: "safe machine" });
    await rx.waitAck(q.id);
    expect(modeFlag(runs()[0]?.argv ?? [])).toBe("dontAsk");
  });

  it("a session this machine started is the start's to decide for, not the hooks'", async () => {
    // #138's record: a start that asked for read stays read, whatever the session's own
    // hooks have said since.
    mkdirSync(path.join(tmp, "state", "control"), { recursive: true });
    writeFileSync(
      path.join(tmp, "state", "control", "state.json"),
      JSON.stringify({ started: { [SID]: { permission: "read" } }, copies: {}, modes: {} }),
    );
    await startDaemon();
    await sawMode("dontAsk");
    const q = await rx.send({ session: SESSION, kind: "prompt", text: "a started session" });
    await rx.waitAck(q.id);
    expect(modeFlag(runs()[0]?.argv ?? [])).toBe("plan");
  });

  it("says in the ack what the turn really ran in", async () => {
    env.SP_TRANSCRIPT = transcriptFile(SID);
    await startDaemon();
    await sawMode("acceptEdits");
    const q = await rx.send({ session: SESSION, kind: "prompt", text: "what did it run in?" });
    const ack = await rx.waitAck(q.id);
    expect(String(ack.detail)).toBe("the turn ran in acceptEdits, the mode the session itself was in");
  });

  it("on an auto machine whose Claude Code has auto turned off, the turn still runs and the ack says so", async () => {
    homeDefault("bypassPermissions", { disableAutoMode: "disable" });
    await startDaemon({ cfg: { mode: "auto" } });
    const q = await rx.send({ session: SESSION, kind: "prompt", text: "auto, disabled" });
    const ack = await rx.waitAck(q.id);
    expect(ack).toMatchObject({ outcome: "delivered", mode: "resume" });
    expect(String(ack.detail)).toContain("ran in Manual mode");
    expect(String(ack.detail)).toContain("sessionpipe control mode inherit");
    expect(modeFlag(runs()[0]?.argv ?? [])).toBe("auto");
    // Said once in the log, however many acks carry it.
    const again = await rx.send({ session: SESSION, kind: "prompt", text: "again" });
    await rx.waitAck(again.id);
    expect(log.filter((l) => l.includes("ran in Manual mode"))).toHaveLength(1);
  });

  it("the same at the top level of the settings file, which is where it is written by hand", async () => {
    writeFileSync(
      path.join(configDir, "settings.json"),
      JSON.stringify({ disableAutoMode: "disable", permissions: { defaultMode: "bypassPermissions" } }),
    );
    await startDaemon({ cfg: { mode: "auto" } });
    const q = await rx.send({ session: SESSION, kind: "prompt", text: "auto, disabled up top" });
    expect(String((await rx.waitAck(q.id)).detail)).toContain("ran in Manual mode");
  });
});

describe.runIf(unix)("a copy, when nothing can reach the session", () => {
  it("is labelled, linked both ways, and told that the original is still open", async () => {
    liveNoInbox();
    await startDaemon();
    await sawMode("acceptEdits");
    const q = await rx.send({ session: SESSION, kind: "prompt", text: "answer in a copy" });
    const ack = await rx.waitAck(q.id);
    expect(ack).toMatchObject({
      outcome: "delivered",
      mode: "fork",
      session: `claude-code:${COPY}`,
      copy_of: SESSION,
    });
    const run = runs()[0] as { argv: string[]; alive: string | null };
    expect(run.argv).toContain("--fork-session");
    // The harness's own contract for a fork whose source is still open.
    expect(run.alive).toMatch(new RegExp(`^${SID}\\|.+Z\\|${SID}$`));
    expect(run.argv.at(-1)).toContain("You are a copy of that session");
    // And the copy is remembered with a date and a reason, beside the plain id map a
    // rollback would read.
    const state = JSON.parse(readFileSync(path.join(tmp, "state", "control", "state.json"), "utf8")) as {
      copies: Record<string, string>;
      copies_v2: Record<string, { id: string; at: string; reason: string }>;
    };
    expect(state.copies[SID]).toBe(COPY);
    expect(state.copies_v2[SID]).toMatchObject({ id: COPY, reason: expect.stringContaining("couldn't be reached") });
    expect(Date.parse(state.copies_v2[SID]?.at as string)).toBeGreaterThan(0);
  });

  it("is never itself copied: the next message resumes it", async () => {
    liveNoInbox();
    await startDaemon();
    const first = await rx.send({ session: SESSION, kind: "prompt", text: "make a copy" });
    await rx.waitAck(first.id);
    // The copy is live too, so a daemon that didn't know better would copy the copy.
    transcript(COPY);
    liveNoInbox(COPY);
    const again = await rx.send({ session: SESSION, kind: "prompt", text: "and again" });
    const ack = await rx.waitAck(again.id);
    expect(ack).toMatchObject({ outcome: "unsupported" });
    expect(String(ack.detail)).toContain("open");
    expect(runs()).toHaveLength(1);
  });

  it("a machine that makes no copies says that, and starts nothing", async () => {
    liveNoInbox();
    await startDaemon({ cfg: { limits: { copies_per_day: 0 } } });
    const q = await rx.send({ session: SESSION, kind: "prompt", text: "no copies here" });
    const ack = await rx.waitAck(q.id);
    expect(ack).toMatchObject({ outcome: "refused", code: "copy_limit" });
    expect(String(ack.detail)).toBe(
      "this machine doesn't make copies of sessions, and that session couldn't be reached in place",
    );
    expect(() => readFileSync(claudeLog, "utf8")).toThrow();
  });

  it("a day's copies already made: refused, with the count", async () => {
    mkdirSync(path.join(tmp, "state", "control"), { recursive: true });
    writeFileSync(
      path.join(tmp, "state", "control", "state.json"),
      JSON.stringify({
        started: {},
        modes: {},
        copies_v2: {
          "11111111-1111-4111-8111-111111111111": { id: "a", at: new Date().toISOString(), reason: "x" },
          // Yesterday's copy doesn't count against today.
          "22222222-2222-4222-8222-222222222222": {
            id: "b",
            at: new Date(Date.now() - 30 * 3600_000).toISOString(),
            reason: "x",
          },
        },
      }),
    );
    liveNoInbox();
    await startDaemon({ cfg: { limits: { copies_per_day: 1 } } });
    const q = await rx.send({ session: SESSION, kind: "prompt", text: "one too many" });
    const ack = await rx.waitAck(q.id);
    expect(ack).toMatchObject({ outcome: "refused", code: "copy_limit" });
    expect(String(ack.detail)).toContain("already made 1 copies");
  });

  it("a resume passes no source-is-alive contract: there is no source to keep alive", async () => {
    await startDaemon();
    const q = await rx.send({ session: SESSION, kind: "prompt", text: "plain resume" });
    await rx.waitAck(q.id);
    expect(runs()[0]?.alive).toBeNull();
    expect(runs()[0]?.argv.at(-1)).not.toContain("You are a copy");
  });
});

describe("the narrowing rule on its own", () => {
  const home = (defaultMode: string | null) => ({ defaultMode, disableAutoMode: false, disableBypass: false });
  it("is a closed list, and never the two modes a setting can change under it", () => {
    const { relaunchMode } = claudeControl;
    expect(relaunchMode("plan", home(null))).toBe("plan");
    expect(relaunchMode("dontAsk", home(null))).toBe("dontAsk");
    expect(relaunchMode("acceptEdits", home("acceptEdits"))).toBe("acceptEdits");
    expect(relaunchMode("acceptEdits", home("auto"))).toBe("acceptEdits");
    expect(relaunchMode("acceptEdits", home("bypassPermissions"))).toBe("acceptEdits");
    expect(relaunchMode("acceptEdits", home("default"))).toBeNull();
    expect(relaunchMode("acceptEdits", home("plan"))).toBeNull();
    expect(relaunchMode("acceptEdits", home(null))).toBeNull();
    for (const m of ["default", "manual", "auto", "bypassPermissions", "nonsense", null, undefined])
      expect(relaunchMode(m, home("bypassPermissions"))).toBeNull();
  });
});
