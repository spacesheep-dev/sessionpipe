// SPDX-License-Identifier: Apache-2.0
// `sessionpipe ask` at the terminal against the real control daemon (CONTROL.md §13),
// where ask.test.ts uses a stand-in on the socket: from a plain terminal with no session
// in its environment, from inside a Claude Code session, and when the daemon stops
// before the child answers. Then `ask on` run twice, and `on` after `off`: control.json
// ends up the same, and the folder it allowed isn't allowed twice. The Codex stand-in
// is control-ask.test.ts's, answering after 600 ms.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, Outbox, runHeadless, writeConfig } from "@sessionpipe/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { askMain } from "../src/ask.js";
import { ControlDaemon } from "../src/control/daemon.js";
import { installService, uninstallService } from "../src/control/pair.js";
import { readControl } from "../src/control/store.js";

vi.mock("../src/control/pair.js", async (original) => ({
  ...(await original<typeof import("../src/control/pair.js")>()),
  installService: vi.fn(() => "launchd agent (stand-in)"),
  uninstallService: vi.fn(),
}));

const THREAD = "0199b6f2-7c1d-7e3a-9b4c-5d6e7f8a9b0c";
const SID = "8c132906-8c3f-4814-870a-afc3d05e1d2e";
const unix = process.platform !== "win32";

let tmp: string;
let home: string;
let project: string;
let sock: string;
let calls: string;
let fakeCodex: string;
let env: NodeJS.ProcessEnv;
let d: ControlDaemon | null = null;

function writeFake(): void {
  writeFileSync(
    fakeCodex,
    `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ cwd: process.cwd(),
  asked_by: process.env.SESSIONPIPE_ASKED_BY || null, chain: process.env.SESSIONPIPE_ASK_CHAIN || null }) + "\\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const day = path.join(process.env.CODEX_HOME, "sessions", "2026", "10", "28");
fs.mkdirSync(day, { recursive: true });
fs.writeFileSync(path.join(day, "rollout-2026-10-28T10-00-00-${THREAD}.jsonl"),
  JSON.stringify({ type: "session_meta", payload: { id: ${JSON.stringify(THREAD)}, cwd: process.cwd() } }) + "\\n");
out({ type: "thread.started", thread_id: ${JSON.stringify(THREAD)} });
out({ type: "turn.started" });
setTimeout(() => {
  out({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "codex did: " + a[a.length - 1].split("\\n")[0] } });
  out({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
}, 600);
`,
  );
  chmodSync(fakeCodex, 0o755);
}

const runs = () =>
  existsSync(calls)
    ? readFileSync(calls, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { cwd: string; asked_by: string | null; chain: string | null })
    : [];

async function startDaemon(): Promise<ControlDaemon> {
  const daemon = new ControlDaemon(
    { name: "testbox", folders: [project], mode: "safe", receivers: [] },
    path.join(tmp, "state", "control"),
    sock,
    {
      now: Date.now,
      fetch,
      log: () => {},
      claudeDirs: () => [path.join(tmp, "claude-config")],
      claude: () => null,
      codex: () => fakeCodex,
      run: runHeadless,
      env,
    },
  );
  await daemon.start();
  d = daemon;
  return daemon;
}

/** The command as the terminal runs it: stdout lines, stderr raw, the exit code. */
const run = (argv: string[], e: NodeJS.ProcessEnv = env) => {
  const out: string[] = [];
  const err: string[] = [];
  return askMain(
    ["ask", ...argv],
    { out: (s = "") => void out.push(s), err: (s) => void err.push(s) },
    { env: e, harnesses: () => ["codex"], distDir: path.join(tmp, "dist") },
  ).then((code) => ({ code, out: out.join("\n"), err: err.join("") }));
};

const events = (harness: string, id: string) =>
  new Outbox(path.join(tmp, "state")).read({ harness, session: id }, 0).events;

async function until<T>(fn: () => T | undefined | false | null, ms = 10_000): Promise<T> {
  const stop = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > stop) throw new Error("gave up waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sp-askd-")));
  home = path.join(tmp, "home");
  project = path.join(home, "project");
  mkdirSync(project, { recursive: true });
  mkdirSync(path.join(tmp, "bin"));
  mkdirSync(path.join(tmp, "dist"));
  writeFileSync(path.join(tmp, "dist", "cli.js"), "");
  sock = path.join(tmp, "control.sock");
  calls = path.join(tmp, "calls.jsonl");
  fakeCodex = path.join(tmp, "bin", "codex");
  writeFake();
  // A terminal's environment: no harness put a session id in it, no ask put a chain.
  env = {
    ...process.env,
    HOME: home,
    SESSIONPIPE_STATE: path.join(tmp, "state"),
    SESSIONPIPE_CONFIG: path.join(tmp, "config", "config.json"),
    SESSIONPIPE_SOCKET: sock,
    CODEX_HOME: path.join(tmp, "codex-home"),
  };
  for (const k of ["CLAUDE_CODE_SESSION_ID", "CODEX_SESSION_ID", "SESSIONPIPE_ASK_CHAIN", "SESSIONPIPE_ASKED_BY"])
    delete env[k];
  writeConfig({ ...DEFAULT_CONFIG, machine: "testbox", sinks: [] }, env.SESSIONPIPE_CONFIG);
  vi.spyOn(os, "homedir").mockReturnValue(home);
  vi.spyOn(os, "hostname").mockReturnValue("Box.local");
  vi.spyOn(process, "cwd").mockReturnValue(project);
  vi.mocked(installService).mockClear();
  vi.mocked(uninstallService).mockClear();
});
afterEach(async () => {
  await d?.stop();
  d = null;
  vi.restoreAllMocks();
  await new Promise((r) => setTimeout(r, 700));
  rmSync(tmp, { recursive: true, force: true });
});

describe.runIf(unix)("sessionpipe ask against the daemon", () => {
  it("from a plain terminal: the answer alone on stdout, exit 0; no asker, so no events; the child is told it was asked by another session", async () => {
    await startDaemon();
    const r = await run(["codex", "say hi"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe("codex did: say hi");
    expect(r.err).toMatch(/^sessionpipe ask: codex:[0-9a-f-]{36} is on it \(ask [0-9A-Z]{26}\)\n/);
    expect(r.err).toMatch(/answered in \d+\.\d s\n$/);
    expect(runs()).toEqual([{ cwd: project, asked_by: null, chain: "unknown" }]);
    expect(existsSync(path.join(tmp, "state", "outbox"))).toBe(false);
    expect(d?.busy()).toBeNull();
  });

  it("from inside a Claude Code session: the asker is read from its environment; the events land on it", async () => {
    await startDaemon();
    const r = await run(["codex", "review it", "--json"], { ...env, CLAUDE_CODE_SESSION_ID: SID });
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out) as { ask_id: string; session: string; reply: string; ms: number };
    expect(j.reply).toBe("codex did: review it");
    expect(j.session).toMatch(/^codex:/);
    expect(runs()[0]).toMatchObject({ asked_by: `claude-code:${SID}`, chain: `claude-code:${SID}` });
    const ev = await until(() => (events("claude-code", SID).length === 2 ? events("claude-code", SID) : null));
    expect(ev[0]?.data).toMatchObject({ ask_id: j.ask_id, via: "ask", harness: "codex", to: j.session });
    expect(ev[1]?.data).toMatchObject({ ask_id: j.ask_id, ok: true, reply: "codex did: review it" });
  });

  it("the daemon stops before the child answers: exit 1 and one line saying so, nothing on stdout", async () => {
    const daemon = await startDaemon();
    const pending = run(["codex", "slow one"]);
    await until(() => runs().length === 1);
    await daemon.stop();
    const r = await pending;
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toMatch(/\nsessionpipe ask: the control daemon went away before codex answered\n$/);
  });

  it("no daemon on the socket: exit 1 and what to run", async () => {
    const r = await run(["codex", "anyone?"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Run `sessionpipe ask on` once at its terminal");
    expect(runs()).toEqual([]);
  });
});

describe("ask on, twice", () => {
  it("the second run changes nothing: the same control.json, the folder allowed once, the service pointed at the same cli.js", async () => {
    const first = await run(["on"]);
    expect(first.code).toBe(0);
    const written = readFileSync(env.SESSIONPIPE_CONFIG!.replace(/config\.json$/, "control.json"), "utf8");
    const again = await run(["on"]);
    expect(again.code).toBe(0);
    expect(readFileSync(env.SESSIONPIPE_CONFIG!.replace(/config\.json$/, "control.json"), "utf8")).toBe(written);
    expect(readControl(env)).toEqual({ name: "Box", folders: [project], mode: "safe", receivers: [], ask: true });
    expect(installService).toHaveBeenCalledTimes(2);
    expect(vi.mocked(installService).mock.calls[0]?.[0].cli).toBe(vi.mocked(installService).mock.calls[1]?.[0].cli);
    expect(again.out).not.toContain("Allowed ");
  });

  it("on after off keeps what on allowed: the switch flips back, the folders stay", async () => {
    await run(["on"]);
    expect((await run(["off"])).code).toBe(0);
    expect(readControl(env)).toMatchObject({ ask: false, folders: [project] });
    expect(uninstallService).toHaveBeenCalledTimes(1);
    expect((await run(["on"])).code).toBe(0);
    expect(readControl(env)).toEqual({ name: "Box", folders: [project], mode: "safe", receivers: [], ask: true });
    expect(installService).toHaveBeenCalledTimes(2);
  });
});
