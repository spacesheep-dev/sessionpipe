// SPDX-License-Identifier: Apache-2.0
// The control daemon driving Codex and Antigravity (CONTROL.md §6): new sessions and
// resumes through stand-in `codex` and `agy` binaries that print the harnesses' own
// stream shapes (codex-cli 0.160.0, agy 1.2.16) and record how they were run. Both pick
// their own session ids, so the session goes by the start's id everywhere.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { runHeadless } from "@sessionpipe/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ControlDaemon, type DaemonDeps } from "../src/control/daemon.js";
import { ask } from "../src/control/local.js";
import { kindPath } from "../src/control/route.js";
import type { ControlConfig } from "../src/control/store.js";
import { FakeReceiver } from "./helpers/receiver.js";

const THREAD = "0199b6f2-7c1d-7e3a-9b4c-5d6e7f8a9b0c"; // the thread a new `codex exec` picks
const CONV = "5d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6"; // the conversation a new `agy -p` picks
const UNKNOWN = "11111111-2222-4333-8444-555555555555"; // an id agy doesn't know
const FRESH = "9e8d7c6b-5a49-4382-b1a0-f9e8d7c6b5a4"; // …so it starts this one instead
const RECV = "0b6f2c7e-3d4a-4f1b-9c8e-2a1d5e6f7e01"; // the id the receiver's start names
const DELAY = 700; // between the first words and the answer: a progress ack goes out

let tmp: string;
let rx: FakeReceiver;
let d: ControlDaemon | null = null;
let env: NodeJS.ProcessEnv;
let sock: string;
let project: string;
let calls: string;
let fakeCodex: string;
let fakeAgy: string;

const unix = process.platform !== "win32";

function writeFakes(): void {
  const head = `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const a = process.argv.slice(2);
const log = (o) => fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(o) + "\\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
log({ bin: path.basename(process.argv[1]), argv: a, cwd: process.cwd(), job: process.env.SESSIONPIPE_CONTROL_JOB || null, start: Date.now() });
`;
  writeFileSync(
    fakeCodex,
    `${head}
const resume = a[1] === "resume";
const id = resume ? a[a.indexOf("--") + 1] : ${JSON.stringify(THREAD)};
const prompt = a[a.length - 1];
process.stderr.write("Reading additional input from stdin...\\n");
if (!resume) {
  const day = path.join(process.env.CODEX_HOME, "sessions", "2026", "10", "04");
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, "rollout-2026-10-04T10-00-00-" + id + ".jsonl"),
    JSON.stringify({ type: "session_meta", payload: { id, cwd: process.cwd() } }) + "\\n");
}
out({ type: "thread.started", thread_id: id });
out({ type: "item.completed", item: { id: "item_0", type: "error", message: "clamping SessionEnd hook timeout to 3s in hooks.json" } });
out({ type: "turn.started" });
out({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "On it." } });
setTimeout(() => {
  out({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: "codex did: " + prompt.replace(/\\n/g, " | ") } });
  out({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
  log({ end: Date.now() });
}, ${DELAY});
`,
  );
  writeFileSync(
    fakeAgy,
    `${head}
const c = a.indexOf("--conversation");
let id = c >= 0 ? a[c + 1] : ${JSON.stringify(CONV)};
if (id === ${JSON.stringify(UNKNOWN)}) { process.stderr.write('warning: conversation "' + id + '" not found\\n'); id = ${JSON.stringify(FRESH)}; }
const prompt = a[a.indexOf("-p") + 1];
const step = (i, type, text) => out({ event: "step_update", step_update: { conversation_id: id, step_index: i, state: "DONE", step_type: type, ...(text ? { text_delta: text } : {}) } });
out({ event: "init", conversation_id: id, init: { cwd: process.cwd(), permission_mode: "default" } });
step(0, "user_input");
step(1, "agent_response", "Hel");
step(1, "agent_response", "lo.");
setTimeout(() => {
  step(2, "tool");
  const said = "agy did: " + prompt.replace(/\\n/g, " | ");
  step(3, "agent_response", said);
  out({ event: "result", result: { conversation_id: id, status: "SUCCESS", response: "Hello.\\n\\n" + said, error: "", denied_actions: [{ tool_name: "run_command" }], usage: {} } });
  log({ end: Date.now() });
}, ${DELAY});
`,
  );
  chmodSync(fakeCodex, 0o755);
  chmodSync(fakeAgy, 0o755);
}

const runs = (): {
  bin?: string;
  argv?: string[];
  cwd?: string;
  job?: string | null;
  start?: number;
  end?: number;
}[] =>
  existsSync(calls)
    ? readFileSync(calls, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
    : [];
const started = () => runs().filter((r) => r.argv);

function cfg(mode: "safe" | "auto" = "safe"): ControlConfig {
  return {
    name: "testbox",
    folders: [project],
    mode,
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
  };
}

async function startDaemon(o: { mode?: "safe" | "auto"; extra?: Partial<DaemonDeps> } = {}) {
  d = new ControlDaemon(cfg(o.mode), path.join(tmp, "state", "control"), sock, {
    now: Date.now,
    fetch,
    log: process.env.SP_DEBUG ? (s: string) => console.error(`[daemon] ${s}`) : () => {},
    claudeDirs: () => [path.join(tmp, "claude-config")],
    claude: () => null,
    codex: () => fakeCodex,
    agy: () => fakeAgy,
    run: runHeadless,
    env,
    ...o.extra,
  });
  await d.start();
}

const aliases = () =>
  JSON.parse(readFileSync(path.join(tmp, "state", "control", "aliases.json"), "utf8")) as Record<
    string,
    { id: string; cwd: string }
  >;

beforeAll(async () => {
  rx = new FakeReceiver();
  await rx.start();
});
afterAll(async () => {
  await rx.stop();
});
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "sp-harness-"));
  project = path.join(tmp, "project");
  mkdirSync(project, { recursive: true });
  sock = path.join(tmp, "control.sock");
  calls = path.join(tmp, "calls.jsonl");
  mkdirSync(path.join(tmp, "bin"));
  fakeCodex = path.join(tmp, "bin", "codex");
  fakeAgy = path.join(tmp, "bin", "agy");
  writeFakes();
  env = {
    ...process.env,
    SESSIONPIPE_STATE: path.join(tmp, "state"),
    SESSIONPIPE_CONFIG: path.join(tmp, "config", "config.json"),
    SESSIONPIPE_SOCKET: sock,
    CODEX_HOME: path.join(tmp, "codex-home"),
  };
  delete env.CODEX_API_KEY;
  rx.queue.clear();
  rx.acks.length = 0;
  rx.hellos.length = 0;
});
afterEach(async () => {
  await d?.stop();
  d = null;
  rmSync(tmp, { recursive: true, force: true });
});

describe("which kinds go where", () => {
  it("Codex and Antigravity can be started; a harness the daemon can't drive can't", () => {
    expect(kindPath("start", "codex")).toBe("start");
    expect(kindPath("start", "antigravity")).toBe("start");
    expect(kindPath("start", "claude-code")).toBe("start");
    expect(kindPath("start", "gemini-cli")).toHaveProperty("unsupported");
  });
  it("a permission answer goes to the hook, except where the hook never prints", () => {
    expect(kindPath("permission.answer", "claude-code")).toBe("permission");
    expect(kindPath("permission.answer", "gemini-cli")).toHaveProperty("unsupported");
    expect(kindPath("permission.answer", "devin")).toHaveProperty("unsupported");
  });
});

describe.runIf(unix)("Codex (codex exec)", () => {
  it("start: a new session in the folder, named after the start; the next message resumes Codex's thread", {
    timeout: 20_000,
  }, async () => {
    await startDaemon();
    const q = await rx.send({ kind: "start", session: `codex:${RECV}`, cwd: project, text: "build the thing" });
    const ack = await rx.waitAck(q.id);
    expect(ack).toMatchObject({ outcome: "delivered", mode: "resume" });
    expect(ack).not.toHaveProperty("session");
    expect(ack.reply).toMatch(/^On it\.\n\ncodex did: build the thing \| {2}\| \(Sent via localhost:\d+/);
    // taken at once, then the answer as it was written, then the final ack.
    const mine = rx.acks.filter((a) => a.id === q.id).map((a) => a.outcome);
    expect(mine[0]).toBe("taken");
    expect(rx.progress(q.id)[0]).toMatchObject({ seq: 1, reply: "On it." });
    const [first] = started();
    expect(first).toMatchObject({ bin: "codex", cwd: realpathSync(project), job: "1" });
    expect(first?.argv).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-C",
      realpathSync(project),
      "-s",
      "workspace-write",
      "--",
      expect.stringMatching(/^build the thing\n\n\(Sent via localhost:\d+ with sessionpipe control/),
    ]);
    // The thread Codex picked, under the start's name, 0600.
    expect(aliases()[`codex:${RECV}`]).toMatchObject({ id: THREAD, cwd: realpathSync(project) });
    expect(statSync(path.join(tmp, "state", "control", "aliases.json")).mode & 0o777).toBe(0o600);

    const q2 = await rx.send({ session: `codex:${RECV}`, text: "and test it" });
    expect(await rx.waitAck(q2.id)).toMatchObject({
      outcome: "delivered",
      mode: "resume",
      reply: expect.stringContaining("and test it"),
    });
    expect(started()[1]?.argv).toEqual([
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      "-c",
      'sandbox_mode="workspace-write"',
      "--",
      THREAD,
      expect.stringMatching(/^Message via localhost:\d+ \(sessionpipe control[^\n]*\n\nand test it/),
    ]);
    // A hook event that still names Codex's thread is the start's session to the daemon.
    await ask(sock, { op: "event", session: `codex:${THREAD}`, event: "UserPromptSubmit", cwd: project }, 500);
    expect(d?.status().mid_turn).toEqual([`codex:${RECV}`]);
    // The start's id is taken now.
    const again = await rx.send({ kind: "start", session: `codex:${RECV}`, cwd: project, text: "again" });
    expect(await rx.waitAck(again.id)).toMatchObject({ outcome: "refused", code: "bad_session" });
  });

  it("start with files: they land in the folder before codex runs, and the prompt lists them", {
    timeout: 20_000,
  }, async () => {
    await startDaemon();
    const png = await rx.upload("shot.png", "image/png", new Uint8Array(2048).fill(7));
    const q = await rx.send({ kind: "start", session: `codex:${RECV}`, cwd: project, text: "look", files: [png] });
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered", mode: "resume" });
    const saved = path.join(project, ".sessionpipe", "files", RECV, "shot.png");
    expect(readFileSync(saved)).toEqual(Buffer.from(new Uint8Array(2048).fill(7)));
    expect(statSync(saved).mode & 0o777).toBe(0o600);
    expect(started()[0]?.argv?.at(-1)).toMatch(
      new RegExp(
        `^look\n\nAttached files \\(saved in this folder\\):\n- \\.sessionpipe/files/${RECV}/shot\\.png \\(image/png, 2 KB\\)\n\n\\(Sent via`,
      ),
    );
    // A file that fails: no codex run at all.
    rx.files.clear();
    const q2 = await rx.send({ kind: "start", session: `codex:${FRESH}`, cwd: project, text: "look", files: [png] });
    expect(await rx.waitAck(q2.id)).toMatchObject({ outcome: "failed", code: "file" });
    expect(started()).toHaveLength(1);
  });

  it("auto mode: --approve-for-me, never a bypass flag", { timeout: 20_000 }, async () => {
    await startDaemon({ mode: "auto" });
    const q = await rx.send({ kind: "start", session: `codex:${RECV}`, cwd: project, text: "go" });
    await rx.waitAck(q.id);
    const argv = started()[0]?.argv ?? [];
    expect(argv).toContain("--approve-for-me");
    expect(argv.join(" ")).not.toMatch(/dangerously|workspace-write/);
  });

  it("a session the hooks reported: its folder from the rollout, resumed under its own id", {
    timeout: 20_000,
  }, async () => {
    const OWN = "0199c0de-1111-7222-8333-944455556666";
    const rollout = (id: string, cwd: string, fresh = false) => {
      const day = path.join(tmp, "codex-home", "sessions", "2026", "10", "03");
      mkdirSync(day, { recursive: true });
      const f = path.join(day, `rollout-2026-10-03T09-00-00-${id}.jsonl`);
      writeFileSync(f, `${JSON.stringify({ type: "session_meta", payload: { id, cwd, cli_version: "0.160.0" } })}\n`);
      if (!fresh) utimesSync(f, new Date(Date.now() - 600_000), new Date(Date.now() - 600_000));
    };
    rollout(OWN, project);
    await startDaemon();
    const q = await rx.send({ session: `codex:${OWN}`, text: "summarize" });
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered", mode: "resume" });
    expect(started()[0]).toMatchObject({ cwd: realpathSync(project) });
    expect(started()[0]?.argv?.slice(0, 8)).toEqual([
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      "-c",
      'sandbox_mode="workspace-write"',
      "--",
      OWN,
    ]);
    // Nothing to rename: Codex kept its id.
    expect(existsSync(path.join(tmp, "state", "control", "aliases.json"))).toBe(false);

    // Someone's open Codex wrote it a moment ago: never a second writer.
    const OPEN = "0199c0de-1111-7222-8333-944455557777";
    rollout(OPEN, project, true);
    const open = await rx.send({ session: `codex:${OPEN}`, text: "hi" });
    expect(await rx.waitAck(open.id)).toMatchObject({ outcome: "unsupported" });
    // A folder off the list, and no such thread.
    const ELSE = "0199c0de-1111-7222-8333-944455558888";
    mkdirSync(path.join(tmp, "elsewhere"));
    rollout(ELSE, path.join(tmp, "elsewhere"));
    const far = await rx.send({ session: `codex:${ELSE}`, text: "hi" });
    expect(await rx.waitAck(far.id)).toMatchObject({ outcome: "refused", code: "folder" });
    const none = await rx.send({ session: "codex:0199c0de-1111-7222-8333-944455559999", text: "hi" });
    expect(await rx.waitAck(none.id)).toMatchObject({ outcome: "refused", code: "no_session" });
    expect(started()).toHaveLength(1);
  });

  it("signed out as the daemon sees it: failed with the command to run, and Codex never runs", async () => {
    await startDaemon({ extra: { codexLogin: async () => ({ loggedIn: false }) } });
    const q = await rx.send({ kind: "start", session: `codex:${RECV}`, cwd: project, text: "go" });
    const ack = await rx.waitAck(q.id);
    expect(ack).toMatchObject({ outcome: "failed" });
    expect(String(ack.detail)).toContain("codex login --device-auth");
    expect(started()).toHaveLength(0);
  });

  it("not installed: failed in words, for a start and for a resume", async () => {
    await startDaemon({ extra: { codex: () => null, agy: () => null } });
    const none = await rx.send({ kind: "start", session: `antigravity:${RECV}`, cwd: project, text: "go" });
    expect(await rx.waitAck(none.id)).toMatchObject({
      outcome: "failed",
      detail: "Antigravity isn't installed on this machine",
    });
    const q = await rx.send({ kind: "start", session: `codex:${RECV}`, cwd: project, text: "go" });
    expect(await rx.waitAck(q.id)).toMatchObject({
      outcome: "failed",
      detail: "Codex isn't installed on this machine",
    });
    const OWN = "0199c0de-1111-7222-8333-944455556666";
    const day = path.join(tmp, "codex-home", "sessions", "2026", "10", "03");
    mkdirSync(day, { recursive: true });
    const f = path.join(day, `rollout-2026-10-03T09-00-00-${OWN}.jsonl`);
    writeFileSync(f, `${JSON.stringify({ type: "session_meta", payload: { id: OWN, cwd: project } })}\n`);
    utimesSync(f, new Date(Date.now() - 600_000), new Date(Date.now() - 600_000));
    const r = await rx.send({ session: `codex:${OWN}`, text: "hi" });
    expect(await rx.waitAck(r.id)).toMatchObject({
      outcome: "failed",
      detail: "Codex isn't installed on this machine",
    });
  });

  it("a thread id that isn't a UUID is nothing to resume; a start whose folder was never recorded has no folder", async () => {
    mkdirSync(path.join(tmp, "state", "control"), { recursive: true });
    writeFileSync(
      path.join(tmp, "state", "control", "aliases.json"),
      JSON.stringify({ "codex:named": { id: "thread-named", cwd: "", at: "" } }),
    );
    await startDaemon();
    const none = await rx.send({ session: "codex:thread-1", text: "hi" });
    expect(await rx.waitAck(none.id)).toMatchObject({ outcome: "refused", code: "no_session" });
    const bare = await rx.send({ session: "codex:named", text: "hi" });
    expect(await rx.waitAck(bare.id)).toMatchObject({
      outcome: "refused",
      code: "no_session",
      detail: expect.stringMatching(/^no folder known for Codex session /),
    });
  });

  it("a runner that hands the whole output over at the end is read the same way; one that fails is failed", {
    timeout: 20_000,
  }, async () => {
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: THREAD }),
      "",
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "item.completed", item: { id: "i1", type: "agent_message", text: "all at once" } }),
      JSON.stringify({ type: "turn.completed", usage: {} }),
    ];
    const answers: DaemonDeps["run"][] = [
      async () => ({
        code: 0,
        signal: null,
        stdout: `${lines.join("\n")}\n`,
        stderr: "",
        tooBig: false,
        timedOut: false,
      }),
      async () => ({ code: 1, signal: null, stdout: "", stderr: "", tooBig: false, timedOut: false }),
      async () => ({ error: "spawn EACCES" }),
    ];
    await startDaemon({ extra: { run: (...a) => answers.shift()!(...a) } });
    const q = await rx.send({ kind: "start", session: `codex:${RECV}`, cwd: project, text: "go" });
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered", mode: "resume", reply: "all at once" });
    expect(aliases()[`codex:${RECV}`]).toMatchObject({ id: THREAD });
    const q2 = await rx.send({ session: `codex:${RECV}`, text: "again" });
    expect(await rx.waitAck(q2.id)).toMatchObject({
      outcome: "failed",
      detail: "Codex exited (code 1) without an answer",
    });
    const q3 = await rx.send({ session: `codex:${RECV}`, text: "once more" });
    expect(await rx.waitAck(q3.id)).toMatchObject({ outcome: "failed", detail: "couldn't start Codex: spawn EACCES" });
  });

  it("a start whose alias can't be recorded still delivers, and says so", { timeout: 20_000 }, async () => {
    mkdirSync(path.join(tmp, "state", "control", "aliases.json"), { recursive: true });
    const log: string[] = [];
    await startDaemon({ extra: { log: (s) => log.push(s) } });
    const q = await rx.send({ kind: "start", session: `codex:${RECV}`, cwd: project, text: "go" });
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered", mode: "resume" });
    expect(log.find((l) => l.startsWith("couldn't record codex:"))).toMatch(/→ 0199b6f2: /);
  });

  it("a waiter whose socket died before its close was seen doesn't count as one", { timeout: 20_000 }, async () => {
    await startDaemon();
    const q = await rx.send({ kind: "start", session: `codex:${RECV}`, cwd: project, text: "go" });
    await rx.waitAck(q.id);
    const live = (d as unknown as { liveOf(s: string): { waiter: unknown } }).liveOf(`codex:${RECV}`);
    const dead = new net.Socket();
    dead.destroy();
    live.waiter = dead;
    const q2 = await rx.send({ session: `codex:${RECV}`, text: "again" });
    expect(await rx.waitAck(q2.id)).toMatchObject({ outcome: "delivered", mode: "resume" });
  });
});

describe.runIf(unix)("Antigravity (agy)", () => {
  it("start: agy -p in the folder, named after the start; the next message goes to --conversation", {
    timeout: 20_000,
  }, async () => {
    await startDaemon();
    const q = await rx.send({
      kind: "start",
      session: `antigravity:${RECV}`,
      cwd: project,
      text: "make a page",
    });
    const ack = await rx.waitAck(q.id);
    expect(ack).toMatchObject({ outcome: "delivered", mode: "resume" });
    expect(ack).not.toHaveProperty("session");
    // agy's own response, and what it wasn't allowed to do with nobody there.
    expect(ack.reply).toMatch(/^Hello\.\n\nagy did: make a page/);
    expect(ack.reply).toMatch(/\(Not allowed on this machine, since nobody was there to approve: run_command\.\)$/);
    expect(rx.acks.filter((a) => a.id === q.id)[0]?.outcome).toBe("taken");
    expect(rx.progress(q.id)[0]).toMatchObject({ seq: 1, reply: "Hello." });
    expect(started()[0]).toMatchObject({ bin: "agy", cwd: realpathSync(project), job: "1" });
    expect(started()[0]?.argv).toEqual([
      "-p",
      expect.stringMatching(/^make a page\n\n\(Sent via localhost:\d+/),
      "--output-format",
      "stream-json",
    ]);
    expect(aliases()[`antigravity:${RECV}`]).toMatchObject({ id: CONV, cwd: realpathSync(project) });

    const q2 = await rx.send({ session: `antigravity:${RECV}`, text: "now a second one" });
    expect(await rx.waitAck(q2.id)).toMatchObject({ outcome: "delivered", mode: "resume" });
    const argv = started()[1]?.argv ?? [];
    expect(argv.slice(0, 2)).toEqual(["--conversation", CONV]);
    expect(argv[3]).toMatch(/^Message via localhost:\d+[^\n]*\n\nnow a second one$/);
    expect(started()[1]?.cwd).toBe(realpathSync(project));
  });

  it("auto mode: --mode accept-edits, never --dangerously-skip-permissions", { timeout: 20_000 }, async () => {
    await startDaemon({ mode: "auto" });
    const q = await rx.send({ kind: "start", session: `antigravity:${RECV}`, cwd: project, text: "go" });
    await rx.waitAck(q.id);
    const argv = started()[0]?.argv ?? [];
    expect(argv.slice(-2)).toEqual(["--mode", "accept-edits"]);
    expect(argv.join(" ")).not.toMatch(/dangerously/);
  });

  it("a conversation the hooks reported: its folder from the hooks, and from the worker's facts after a restart", {
    timeout: 30_000,
  }, async () => {
    const OWN = "7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d";
    await startDaemon();
    // Unknown until a hook says where it runs.
    const before = await rx.send({ session: `antigravity:${OWN}`, text: "hi" });
    expect(await rx.waitAck(before.id)).toMatchObject({ outcome: "refused", code: "no_session" });
    await ask(sock, { op: "event", session: `antigravity:${OWN}`, event: "Stop", cwd: project }, 500);
    const q = await rx.send({ session: `antigravity:${OWN}`, text: "hi" });
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered", mode: "resume" });
    expect(started()[0]?.argv?.slice(0, 2)).toEqual(["--conversation", OWN]);
    // A restarted daemon has no hook events yet; the worker's facts still know the folder.
    await d?.stop();
    d = null;
    mkdirSync(path.join(tmp, "state", "facts", "antigravity"), { recursive: true });
    writeFileSync(path.join(tmp, "state", "facts", "antigravity", `${OWN}.json`), JSON.stringify({ cwd: project }));
    await startDaemon();
    const q2 = await rx.send({ session: `antigravity:${OWN}`, text: "again" });
    expect(await rx.waitAck(q2.id)).toMatchObject({ outcome: "delivered", mode: "resume" });
    expect(started()[1]?.argv?.slice(0, 2)).toEqual(["--conversation", OWN]);
    // Facts that name a folder that isn't a path name nothing.
    const ODD = "7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5e";
    writeFileSync(path.join(tmp, "state", "facts", "antigravity", `${ODD}.json`), JSON.stringify({ cwd: "relative" }));
    const q3 = await rx.send({ session: `antigravity:${ODD}`, text: "hi" });
    expect(await rx.waitAck(q3.id)).toMatchObject({ outcome: "refused", code: "no_session" });
  });

  it("a conversation agy doesn't know: it runs in a fresh one, says so, and the next message follows it", {
    timeout: 20_000,
  }, async () => {
    await startDaemon();
    await ask(sock, { op: "event", session: `antigravity:${UNKNOWN}`, event: "Stop", cwd: project }, 500);
    const q = await rx.send({ session: `antigravity:${UNKNOWN}`, text: "hi" });
    const ack = await rx.waitAck(q.id);
    expect(ack).toMatchObject({ outcome: "delivered", mode: "resume" });
    expect(ack.reply).toContain("didn't find that session on this machine");
    expect(aliases()[`antigravity:${UNKNOWN}`]).toMatchObject({ id: FRESH });
    const q2 = await rx.send({ session: `antigravity:${UNKNOWN}`, text: "again" });
    expect(await rx.waitAck(q2.id)).toMatchObject({ outcome: "delivered" });
    expect(started()[1]?.argv?.slice(0, 2)).toEqual(["--conversation", FRESH]);
  });
});

describe.runIf(unix)("a start and a prompt in the same poll", () => {
  for (const [harness, real] of [
    ["codex", THREAD],
    ["antigravity", CONV],
  ] as const)
    it(`${harness}: the prompt waits for its start, then resumes the session the start named`, {
      timeout: 30_000,
    }, async () => {
      await startDaemon();
      // Queued back to back, handed over together, handled side by side.
      const q1 = await rx.send(
        { kind: "start", session: `${harness}:${RECV}`, cwd: project, text: "build it" },
        { hold: true },
      );
      // Confirmed with one passkey assertion, it verifies faster than the start's grant
      // and day-key signature: the prompt is the first of the two to look for the session.
      const q2 = await rx.send({ session: `${harness}:${RECV}`, text: "and ship it" }, { hold: true, confirm: true });
      rx.enqueue(q1);
      rx.enqueue(q2);
      expect(await rx.waitAck(q1.id, 20_000)).toMatchObject({ outcome: "delivered", mode: "resume" });
      expect(await rx.waitAck(q2.id, 20_000)).toMatchObject({
        outcome: "delivered",
        mode: "resume",
        reply: expect.stringContaining("and ship it"),
      });
      expect(rx.acks.find((a) => a.id === q2.id)?.outcome).toBe("taken");
      const all = runs();
      const [start, resume] = started();
      expect(start?.argv).not.toContain(real);
      expect(resume?.argv).toContain(real);
      // One after the other: the resume began after the start ended.
      expect(resume?.start).toBeGreaterThanOrEqual(all.find((r) => r.end)?.end as number);
    });
});

describe.runIf(unix)("hello", () => {
  it("advertises the harnesses this machine can drive", async () => {
    await startDaemon();
    for (let i = 0; i < 100 && !rx.hellos.length; i++) await new Promise((r) => setTimeout(r, 20));
    expect(rx.hellos[0]).toMatchObject({ harnesses: ["codex", "antigravity"] });
    await d?.stop();
    rx.hellos.length = 0;
    await startDaemon({ extra: { agy: () => null } });
    for (let i = 0; i < 100 && !rx.hellos.length; i++) await new Promise((r) => setTimeout(r, 20));
    expect(rx.hellos[0]).toMatchObject({ harnesses: ["codex"] });
  });
  it("says a new folder list in a hello at once, and nothing when nothing it says changed", async () => {
    await startDaemon();
    for (let i = 0; i < 100 && !rx.hellos.length; i++) await new Promise((r) => setTimeout(r, 20));
    expect(rx.hellos).toHaveLength(1);
    const kimi = path.join(tmp, "claude-kimi");
    mkdirSync(kimi, { recursive: true });
    d?.reload({ ...cfg(), folders: [project, kimi] });
    for (let i = 0; i < 100 && rx.hellos.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    expect(rx.hellos[1]?.folders).toEqual([project, kimi]);
    d?.reload({ ...cfg(), folders: [project, kimi] });
    await new Promise((r) => setTimeout(r, 200));
    expect(rx.hellos).toHaveLength(2);
    // A rename (`--rename-machine`) is said at once too: the receiver shows one machine.
    d?.reload({ ...cfg(), folders: [project, kimi], name: "box-two" });
    for (let i = 0; i < 100 && rx.hellos.length < 3; i++) await new Promise((r) => setTimeout(r, 20));
    expect(rx.hellos[2]?.name).toBe("box-two");
  });
  it("names the accounts signed in, read again for each hello", async () => {
    const file = path.join(tmp, "claude-config", ".claude.json");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ oauthAccount: { accountUuid: "acct-a", emailAddress: "a@example.com" } }));
    await startDaemon();
    for (let i = 0; i < 100 && !rx.hellos.length; i++) await new Promise((r) => setTimeout(r, 20));
    expect(rx.hellos[0]?.accounts).toEqual([{ harness: "claude-code", id: "acct-a", email: "a@example.com" }]);
    await d?.stop();
    rx.hellos.length = 0;
    rmSync(file);
    await startDaemon();
    for (let i = 0; i < 100 && !rx.hellos.length; i++) await new Promise((r) => setTimeout(r, 20));
    expect(rx.hellos[0]).not.toHaveProperty("accounts");
  });
  it("names a home that runs on another API by its endpoint's host, never its token", async () => {
    const dir = path.join(tmp, "claude-config");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "settings.json"),
      JSON.stringify({
        env: { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic", ANTHROPIC_AUTH_TOKEN: "zai-secret-token" },
      }),
    );
    await startDaemon();
    for (let i = 0; i < 100 && !rx.hellos.length; i++) await new Promise((r) => setTimeout(r, 20));
    expect(rx.hellos[0]?.accounts).toEqual([
      { harness: "claude-code", id: expect.stringMatching(/^api-[0-9a-f]{16}$/), name: "api.z.ai" },
    ]);
    expect(JSON.stringify(rx.hellos[0])).not.toContain("zai-secret-token");
  });
});
