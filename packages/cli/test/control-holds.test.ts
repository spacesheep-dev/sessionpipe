// SPDX-License-Identifier: Apache-2.0
// "Never two writers on one transcript" (CONTROL.md §6, What counts as held), where the
// daemon decides whether a session may be resumed in place: what it knows a session by,
// what a run of its own does and does not account for, and what it looks at again when
// a message's turn finally comes. A real ControlDaemon, a stand-in `claude` that files
// its registry row, fires its hooks and writes its transcript as the real one does, and
// the question asked of every case: was anything run with `--resume <id>` and no
// `--fork-session` in a session something else had.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeControl } from "@sessionpipe/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Carried, ControlDaemon, type DaemonDeps } from "../src/control/daemon.js";
import { ask } from "../src/control/local.js";
import type { ControlConfig, PairedReceiver } from "../src/control/store.js";
import { FakeReceiver, type Queued } from "./helpers/receiver.js";

// Every case runs a stand-in harness as a real child process.
vi.setConfig({ testTimeout: 30_000 });

const O = "8c132906-8c3f-4814-870a-afc3d05e1d2e"; // the original
const C = "0b6f2c7e-3d4a-4f1b-9c8e-2a1d5e6f7a8b"; // the copy its messages go to
/** The ids the stand-in gives the copies it makes, in the order it makes them. */
const MADE = ["c0000001-3d4a-4f1b-9c8e-2a1d5e6f7a8b", "c0000002-3d4a-4f1b-9c8e-2a1d5e6f7a8b"];
const cc = (id: string) => `claude-code:${id}`;
const unix = process.platform !== "win32";

let rx: FakeReceiver;
let d: ControlDaemon | null = null;
let receiver: PairedReceiver;
let tmp: string;
let project: string;
let configDir: string;
let sock: string;
let calls: string;
let fakeClaude: string;
let env: NodeJS.ProcessEnv;
let log: string[];
let clock: () => number;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (what: () => boolean, ms = 10_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error("waited too long");
    await sleep(15);
  }
};
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const file = (sid: string) => path.join(configDir, "projects", project.replace(/[^a-zA-Z0-9]/g, "-"), `${sid}.jsonl`);
/** A session's transcript, last written `ageMs` ago. */
function transcript(sid: string, ageMs = 600_000): void {
  mkdirSync(path.dirname(file(sid)), { recursive: true });
  writeFileSync(file(sid), `${JSON.stringify({ type: "user", cwd: project, message: { content: "hi" } })}\n`);
  const at = new Date(Date.now() - ageMs);
  utimesSync(file(sid), at, at);
}
/** Something writes to it now. */
function touch(sid: string): void {
  const now = new Date();
  utimesSync(file(sid), now, now);
}
/** A registry row: a live process (this one) holds `sid`, as a window or as a run. */
function holds(sid: string, kind: string | null): void {
  writeFileSync(
    path.join(configDir, "sessions", `${process.pid}.json`),
    JSON.stringify({ sessionId: sid, pid: process.pid, ...(kind ? { kind } : {}) }),
  );
}
/** The daemon's state as one that made a copy of `orig` earlier left it. */
function copied(orig: string, copy: string): void {
  transcript(copy);
  mkdirSync(path.join(tmp, "state", "control"), { recursive: true });
  writeFileSync(
    path.join(tmp, "state", "control", "state.json"),
    JSON.stringify({ copies: { [orig]: copy }, copies_v2: { [orig]: { id: copy, at: "", reason: "" } } }),
  );
}

interface Run {
  argv: string[];
  pid: number;
}
const runs = (): Run[] =>
  existsSync(calls)
    ? readFileSync(calls, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Run)
    : [];
/** How each run was asked to run, in the order they began: `resume <id8>` is a run in
 *  place, `fork <id8>` a copy of that session, `new <id8>` a session of its own. */
const ran = (): string[] =>
  runs().map((r) => {
    const i = r.argv.indexOf("--resume");
    if (i < 0) return `new ${r.argv[r.argv.indexOf("--session-id") + 1]?.slice(0, 8)}`;
    return `${r.argv.includes("--fork-session") ? "fork" : "resume"} ${r.argv[i + 1]?.slice(0, 8)}`;
  });

async function startDaemon(o: { cfg?: Partial<ControlConfig>; extra?: Partial<DaemonDeps> } = {}): Promise<void> {
  const c: ControlConfig = {
    name: "testbox",
    folders: [project],
    mode: "safe",
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
    ...o.cfg,
  };
  receiver = c.receivers[0] as PairedReceiver;
  d = new ControlDaemon(c, path.join(tmp, "state", "control"), sock, {
    now: () => clock(),
    fetch,
    log: (s) => log.push(s),
    claudeDirs: () => [configDir],
    claude: () => ({
      bin: fakeClaude,
      caps: { hasMode: true, modes: ["default", "dontAsk"], promptsNone: false, fork: true, stream: true },
    }),
    run: claudeControl.runClaude,
    sdk: null,
    env,
    ...o.extra,
  });
  await d.start();
}

/** A signed command handed to the daemon this instant, as a poll would hand it. */
async function hand(fields: Record<string, unknown>): Promise<Queued> {
  const q = await rx.send(fields, { hold: true });
  void (d as ControlDaemon).handle(receiver, q as Carried);
  return q;
}
const stopNow = (session: string) => hand({ kind: "cancel", session, text: undefined });
/** Every ack of a message but its progress, in order. */
const acksOf = (id: string) => rx.acks.filter((a) => a.id === id && a.outcome !== "progress").map((a) => a.outcome);
const event = (session: string, name: string) => ask(sock, { op: "event", session, event: name }, 800);
const midTurn = () => d?.status().mid_turn ?? [];

beforeAll(async () => {
  rx = new FakeReceiver();
  await rx.start();
});
afterAll(async () => {
  await rx.stop();
});
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "sp-holds-"));
  project = path.join(tmp, "project");
  configDir = path.join(tmp, "claude-config");
  mkdirSync(project, { recursive: true });
  mkdirSync(path.join(configDir, "sessions"), { recursive: true });
  mkdirSync(path.join(tmp, "bin"));
  sock = path.join(mkdtempSync(path.join(os.tmpdir(), "sp-sh-")), "c.sock");
  calls = path.join(tmp, "calls.jsonl");
  fakeClaude = path.join(tmp, "bin", "claude");
  const made = path.join(tmp, "made.count");
  // `claude -p --output-format stream-json`. A word in square brackets in the prompt says
  // how this run goes: [long] works until it is stopped, [slow] takes a moment and ends
  // by itself, [broken] dies without an answer, [ignorefork] takes no notice of
  // --fork-session and runs as the session it was told to copy.
  writeFileSync(
    fakeClaude,
    `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const a = process.argv.slice(2);
const prompt = a[a.length - 1];
const has = (w) => prompt.includes("[" + w + "]");
const CONFIG = ${JSON.stringify(configDir)}, PROJECT = ${JSON.stringify(project)};
const i = a.indexOf("--resume"), j = a.indexOf("--session-id");
let sid;
if (a.includes("--fork-session") && !has("ignorefork")) {
  let n = 0; try { n = Number(fs.readFileSync(${JSON.stringify(made)}, "utf8")) || 0; } catch {}
  fs.writeFileSync(${JSON.stringify(made)}, String(n + 1));
  sid = ${JSON.stringify(MADE)}[n];
} else sid = i >= 0 ? a[i + 1] : a[j + 1];
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ argv: a, pid: process.pid }) + "\\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const me = "claude-code:" + sid;
const file = path.join(CONFIG, "projects", PROJECT.replace(/[^a-zA-Z0-9]/g, "-"), sid + ".jsonl");
const row = path.join(CONFIG, "sessions", process.pid + ".json");
const hook = (event) => new Promise((done) => {
  const s = require("net").connect(process.env.SESSIONPIPE_SOCKET);
  s.on("connect", () => s.write(JSON.stringify({ op: "event", session: me, event }) + "\\n"));
  s.on("data", () => { s.destroy(); done(); });
  s.on("error", () => done());
});
fs.writeFileSync(row, JSON.stringify({ pid: process.pid, sessionId: sid, kind: "print" }));
(async () => {
  await hook("SessionStart");
  await hook("UserPromptSubmit");
  out({ type: "system", subtype: "init", session_id: sid });
  fs.appendFileSync(file, JSON.stringify({ type: "user", cwd: PROJECT, message: { content: "asked" } }) + "\\n");
  if (has("long")) {
    out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Pinging" } } });
    return setInterval(() => {}, 1000);
  }
  if (has("slow")) await new Promise((r) => setTimeout(r, 700));
  if (has("broken")) { fs.rmSync(row); process.stderr.write("it broke\\n"); process.exit(3); }
  fs.appendFileSync(file, JSON.stringify({ type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "text", text: "did it" }] } }) + "\\n");
  await hook("Stop");
  await hook("SessionEnd");
  fs.rmSync(row);
  out({ type: "result", result: "did it", session_id: sid, is_error: false });
})();
`,
  );
  chmodSync(fakeClaude, 0o755);
  log = [];
  clock = Date.now;
  env = {
    ...process.env,
    SESSIONPIPE_STATE: path.join(tmp, "state"),
    SESSIONPIPE_CONFIG: path.join(tmp, "config", "config.json"),
    SESSIONPIPE_SOCKET: sock,
    CODEX_HOME: path.join(tmp, "codex-home"),
  };
  transcript(O);
  rx.queue.clear();
  rx.acks.length = 0;
});
afterEach(async () => {
  await d?.stop();
  d = null;
  for (const r of runs()) if (alive(r.pid)) process.kill(r.pid, "SIGKILL");
  rmSync(path.dirname(sock), { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});

describe.runIf(unix)("a session is known by the id its harness gave it, exactly", () => {
  it("named in another case it is no session of this machine's, whatever the disk answers: nothing is run in the one a window has", async () => {
    holds(O, "interactive");
    await startDaemon();
    await event(cc(O), "UserPromptSubmit");
    // On a disk that ignores case the transcript opens under this spelling too; the
    // registry row and the hooks' state, which are what say it is open and mid-turn, do
    // not. It was resumed in place: `claude -p --resume 8C132906-…`.
    const shouted = await hand({ session: cc(O.toUpperCase()), text: "hello" });
    expect(await rx.waitAck(shouted.id)).toMatchObject({
      outcome: "refused",
      code: "no_session",
      detail: "no Claude Code session 8C132906 on this machine",
    });
    expect(runs()).toEqual([]);
    // Named as it is, it waits for the turn the person is in.
    const named = await hand({ session: cc(O), text: "hello" });
    await until(() => acksOf(named.id).includes("taken"));
    await sleep(300);
    expect(acksOf(named.id)).toEqual(["taken"]);
    expect(runs()).toEqual([]);
    expect(midTurn()).toEqual([cc(O)]);
  });

  it("an id that differs from a session's only by case is not free for a new session: it would be written into that session's file", async () => {
    await startDaemon();
    const start = await hand({ kind: "start", session: cc(O.toUpperCase()), cwd: project, text: "a new one" });
    expect(await rx.waitAck(start.id)).toMatchObject({
      outcome: "refused",
      code: "bad_session",
      detail: "that new session's id is already taken",
    });
    expect(runs()).toEqual([]);
  });
});

// The helpers the later groups use.
void [C, MADE, touch, copied, ran, stopNow, expect];
