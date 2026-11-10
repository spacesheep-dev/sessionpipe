// SPDX-License-Identifier: Apache-2.0
// One session's messages run one at a time, in the order they were sent (CONTROL.md §6
// `prompt`): by the signed `iat`, then by arrival. On 2026-11-10 three messages sent half
// a second apart behind a running turn ran bravo, delta, charlie: the two that arrived in
// one poll were verified side by side, and the one whose verification finished first took
// the earlier place. Here the messages are handed to the daemon as a poll hands them (side
// by side, in one tick), the earlier one's verification is made to finish last, and
// stand-in `claude` runs record the order things really ran in.
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

// Every case runs a stand-in `claude` as a real child process.
vi.setConfig({ testTimeout: 30_000 });

const SID = "ea78dd7f-6d2d-4537-9d12-35f146effa4a";
const SESSION = `claude-code:${SID}`;
const OTHER = "5e0d1c2b-3a49-4857-9665-74839201aabb";
const COPY = "0b6f2c7e-3d4a-4f1b-9c8e-2a1d5e6f7a8b";
const NEW = "0b6f2c7e-3d4a-4f1b-9c8e-2a1d5e6f7c02";
const unix = process.platform !== "win32";

let tmp: string;
let rx: FakeReceiver;
let d: ControlDaemon | null = null;
let env: NodeJS.ProcessEnv;
let sock: string;
let project: string;
let configDir: string;
let fakeClaude: string;
let calls: string;
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

/** The word each run of the stand-in was asked for, in the order the runs BEGAN. */
const ran = (): string[] =>
  existsSync(calls)
    ? readFileSync(calls, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => (JSON.parse(l) as { word: string }).word)
    : [];
/** …and every run's argv, in the same order. */
const argvs = (): string[][] =>
  readFileSync(calls, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => (JSON.parse(l) as { argv: string[] }).argv);

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (what: () => boolean, ms = 15_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error(`waited too long; ran: ${JSON.stringify(ran())}`);
    await settle(20);
  }
};

function cfg(over: Partial<ControlConfig> = {}): ControlConfig {
  return {
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
    ...over,
  };
}
let receiver: PairedReceiver;

async function startDaemon(o: { cfg?: Partial<ControlConfig>; extra?: Partial<DaemonDeps> } = {}): Promise<void> {
  const c = cfg(o.cfg);
  receiver = c.receivers[0] as PairedReceiver;
  d = new ControlDaemon(c, path.join(tmp, "state", "control"), sock, {
    now: Date.now,
    fetch,
    log: (s) => log.push(s),
    claudeDirs: () => [configDir],
    claude: () => ({
      bin: fakeClaude,
      caps: { hasMode: true, modes: ["default", "dontAsk"], promptsNone: false, fork: true },
    }),
    run: claudeControl.runClaude,
    sdk: null,
    env,
    ...o.extra,
  });
  await d.start();
}

/** A signed message the receiver has not queued: handed to the daemon by `poll()`. */
const sign = (text: string, o: { session?: string; iat?: number; files?: unknown[] } = {}) =>
  rx.send(
    {
      session: o.session ?? SESSION,
      text,
      ...(o.iat ? { iat: o.iat } : {}),
      ...(o.files ? { files: o.files } : {}),
    },
    { hold: true },
  );

/** One poll's answer, as the daemon's poll loop hands it out: every message of it side
 *  by side, in the order the receiver listed them, none awaited. */
function poll(...messages: Queued[]): void {
  for (const m of messages) void (d as ControlDaemon).handle(receiver, m as Carried);
}

/** Make the verification of every command whose text holds `word` finish late: its day
 *  key's signature is over the command's own bytes, so that check can be told apart. */
function verifiedLate(word: string, ms = 250): void {
  const real = crypto.subtle.verify.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "verify").mockImplementation(async (alg, key, sig, data) => {
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (Buffer.from(bytes).toString("utf8").includes(word)) await settle(ms);
    return real(alg, key, sig, data);
  });
}

const reply = async (m: Queued) =>
  (await rx.waitAck(m.id, 20_000)) as { outcome: string; mode?: string; reply?: string };

beforeAll(async () => {
  rx = new FakeReceiver();
  await rx.start();
});
afterAll(async () => {
  await rx.stop();
});
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "sp-order-"));
  project = path.join(tmp, "project");
  configDir = path.join(tmp, "claude-config");
  mkdirSync(project, { recursive: true });
  mkdirSync(path.join(configDir, "sessions"), { recursive: true });
  mkdirSync(path.join(tmp, "bin"));
  sock = path.join(mkdtempSync(path.join(os.tmpdir(), "sp-so-")), "c.sock");
  calls = path.join(tmp, "calls.jsonl");
  fakeClaude = path.join(tmp, "bin", "claude");
  // `claude -p --output-format json`: records the word it was asked for the moment it
  // starts, then answers with it. "slowly" takes its time, "forever" works until it is
  // stopped, "badly" fails. A new session writes its transcript a moment after it starts.
  writeFileSync(
    fakeClaude,
    `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const a = process.argv.slice(2);
const prompt = a[a.length - 1];
const word = (/the word (\\w+)/.exec(prompt) || [, "?"])[1];
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ word, argv: a, pid: process.pid }) + "\\n");
const i = a.indexOf("--resume"), j = a.indexOf("--session-id");
const sid = a.includes("--fork-session") ? ${JSON.stringify(COPY)} : i >= 0 ? a[i + 1] : a[j + 1];
const file = path.join(${JSON.stringify(configDir)}, "projects", ${JSON.stringify(project)}.replace(/[^a-zA-Z0-9]/g, "-"), sid + ".jsonl");
const done = () => process.stdout.write(JSON.stringify({ type: "result", result: word, session_id: sid, is_error: false }));
if (j >= 0 || a.includes("--fork-session")) setTimeout(() => { fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ type: "user", cwd: ${JSON.stringify(project)} }) + "\\n"); }, j >= 0 ? 400 : 0);
if (/badly/.test(prompt)) { process.stderr.write("it broke\\n"); process.exit(3); }
else if (/forever/.test(prompt)) setInterval(() => {}, 1000);
else setTimeout(done, /slowly/.test(prompt) ? 1200 : 60);
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
  rx.queue.clear();
  rx.acks.length = 0;
  rx.files.clear();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await d?.stop();
  d = null;
  for (const l of existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean) : []) {
    try {
      process.kill((JSON.parse(l) as { pid: number }).pid, "SIGKILL");
    } catch {}
  }
  rmSync(path.dirname(sock), { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});

describe.runIf(unix)("messages for one session run in the order they were sent", () => {
  it("two of one poll behind a running turn: the earlier one is verified last and still runs first (resume)", async () => {
    // The three of 2026-11-10: bravo is running; charlie and delta arrive in one poll.
    await startDaemon();
    const bravo = await sign("slowly reply with just the word bravo1");
    poll(bravo);
    await until(() => ran().length === 1);
    const charlie = await sign("reply with just the word charlie1");
    await settle(5);
    const delta = await sign("reply with just the word delta1");
    verifiedLate("word charlie1");
    poll(charlie, delta);
    expect(await reply(delta)).toMatchObject({ outcome: "delivered", mode: "resume", reply: "delta1" });
    expect(await reply(charlie)).toMatchObject({ outcome: "delivered", mode: "resume", reply: "charlie1" });
    expect(ran()).toEqual(["bravo1", "charlie1", "delta1"]);
    // One at a time: each answer was out before the next run began.
    const finals = rx.acks.filter((a) => a.outcome === "delivered").map((a) => a.reply);
    expect(finals).toEqual(["bravo1", "charlie1", "delta1"]);
  });

  it("the same with nothing running: the first of a poll goes first however its verification goes", async () => {
    await startDaemon();
    const one = await sign("reply with just the word one");
    await settle(5);
    const two = await sign("reply with just the word two");
    await settle(5);
    const three = await sign("reply with just the word three");
    verifiedLate("word one", 300);
    poll(one, two, three);
    for (const m of [one, two, three]) expect(await reply(m)).toMatchObject({ outcome: "delivered" });
    expect(ran()).toEqual(["one", "two", "three"]);
  });

  it("by when they were signed, then by arrival: a poll that lists them the other way round, and a later poll that brings an earlier one", async () => {
    await startDaemon();
    const now = Date.now();
    const running = await sign("slowly reply with just the word first");
    poll(running);
    await until(() => ran().length === 1);
    // Signed in this order, a second apart…
    const second = await sign("reply with just the word second", { iat: now - 3000 });
    const third = await sign("reply with just the word third", { iat: now - 2000 });
    const fourth = await sign("reply with just the word fourth", { iat: now - 1000 });
    // …and two signed in the same millisecond: arrival decides between those.
    const fifth = await sign("reply with just the word fifth", { iat: now - 500 });
    const sixth = await sign("reply with just the word sixth", { iat: now - 500 });
    // One poll lists two of them backwards; the next brings the earliest of all.
    poll(fourth, third);
    await settle(100);
    poll(fifth, second, sixth);
    for (const m of [second, third, fourth, fifth, sixth])
      expect(await reply(m)).toMatchObject({ outcome: "delivered" });
    expect(ran()).toEqual(["first", "second", "third", "fourth", "fifth", "sixth"]);
  });

  it("a message that waits for its session's start is not passed by one that came after it", async () => {
    // The start's transcript is not there yet when the first message arrives, so that
    // one waits for the start; the second arrives once it is, and found another way in.
    await startDaemon();
    const start = await rx.send(
      { kind: "start", session: `claude-code:${NEW}`, cwd: project, text: "slowly reply with just the word started" },
      { hold: true },
    );
    poll(start);
    await until(() => ran().length === 1);
    expect(existsSync(transcriptFile(NEW))).toBe(false);
    const early = await sign("reply with just the word early", { session: `claude-code:${NEW}` });
    poll(early);
    await until(() => existsSync(transcriptFile(NEW)));
    await settle(50);
    const late = await sign("reply with just the word late", { session: `claude-code:${NEW}` });
    poll(late);
    for (const m of [start, early, late]) expect(await reply(m)).toMatchObject({ outcome: "delivered" });
    expect(ran()).toEqual(["started", "early", "late"]);
    expect(argvs()[1]).toEqual(expect.arrayContaining(["--resume", NEW]));
  });

  it("a message whose files are slow to fetch keeps its place: the one behind it waits for it", async () => {
    const png = await rx.upload("shot.png", "image/png", new Uint8Array(2048).fill(7));
    // The receiver takes its time over the file.
    const slowFiles: typeof fetch = async (input, init) => {
      if (String(input instanceof Request ? input.url : input).includes("/files/")) await settle(500);
      return fetch(input, init);
    };
    await startDaemon({ extra: { fetch: slowFiles } });
    const withFile = await sign("reply with just the word attached", { files: [png] });
    await settle(5);
    const plain = await sign("reply with just the word plain");
    poll(withFile, plain);
    for (const m of [withFile, plain]) expect(await reply(m)).toMatchObject({ outcome: "delivered" });
    expect(ran()).toEqual(["attached", "plain"]);
    expect(argvs()[0]?.at(-1)).toContain("Attached files");
  });

  it("a Stop for the running one, a failure, a refusal: the rest keep their order", async () => {
    await startDaemon();
    const running = await sign("forever reply with just the word running");
    poll(running);
    await until(() => ran().length === 1);
    const a = await sign("reply with just the word a");
    await settle(5);
    const broken = await sign("badly reply with just the word broken");
    await settle(5);
    // Signed, then altered on the way: refused when its signature is checked.
    const forged = await sign("reply with just the word forged");
    forged.cmd = forged.cmd.replace("forged", "f0rged");
    await settle(5);
    const b = await sign("reply with just the word b");
    await settle(5);
    const c = await sign("reply with just the word c");
    verifiedLate('word a"', 300);
    poll(a, broken, forged, b, c);
    await settle(500);
    // All of them wait behind the running turn; none has started.
    expect(ran()).toEqual(["running"]);
    const stop = await rx.send({ kind: "cancel", session: SESSION, text: undefined }, { hold: true });
    poll(stop);
    expect(await reply(stop)).toMatchObject({ outcome: "delivered", mode: "resume" });
    expect(await reply(running)).toMatchObject({ outcome: "delivered", reply: "(The turn was cancelled.)" });
    expect(await reply(a)).toMatchObject({ outcome: "delivered", reply: "a" });
    expect(await reply(broken)).toMatchObject({ outcome: "failed" });
    expect(await reply(forged)).toMatchObject({ outcome: "refused", code: "bad_csig" });
    expect(await reply(b)).toMatchObject({ outcome: "delivered", reply: "b" });
    expect(await reply(c)).toMatchObject({ outcome: "delivered", reply: "c" });
    expect(ran()).toEqual(["running", "a", "broken", "b", "c"]);
  });

  it("what isn't a prompt it can read takes no place in line, and holds nobody's up", async () => {
    await startDaemon();
    const real = await sign("reply with just the word real");
    // Says it is a prompt and is not JSON; and one that is, with no time on it.
    const cut = await sign("reply with just the word cut");
    cut.cmd = `{"kind":"prompt","session":"${SESSION}`;
    const undated = await sign("reply with just the word undated");
    undated.cmd = JSON.stringify({ ...JSON.parse(undated.cmd), iat: "now" });
    poll(cut, undated, real);
    expect(await reply(cut)).toMatchObject({ outcome: "refused", code: "malformed" });
    expect(await reply(undated)).toMatchObject({ outcome: "refused" });
    expect(await reply(real)).toMatchObject({ outcome: "delivered", reply: "real" });
    expect(ran()).toEqual(["real"]);
  });

  it("a message sent to a session's copy by its own name waits for the turn already running in that copy: never two at once in one transcript", async () => {
    // The session's messages go to its copy, and the copy is on the board under its own
    // id, so a person can message either. Both run in the copy's transcript.
    transcript(COPY);
    mkdirSync(path.join(tmp, "state", "control"), { recursive: true });
    writeFileSync(
      path.join(tmp, "state", "control", "state.json"),
      JSON.stringify({ copies: { [SID]: COPY }, copies_v2: { [SID]: { id: COPY, at: "", reason: "" } } }),
    );
    await startDaemon();
    const viaSession = await sign("forever reply with just the word first");
    poll(viaSession);
    await until(() => ran().length === 1);
    expect(argvs()[0]).toEqual(expect.arrayContaining(["--resume", COPY]));
    const toCopy = await sign("reply with just the word second", { session: `claude-code:${COPY}` });
    poll(toCopy);
    await settle(600);
    // Still only the first: the second has not been started beside it.
    expect(ran()).toEqual(["first"]);
    const stop = await rx.send({ kind: "cancel", session: SESSION, text: undefined }, { hold: true });
    poll(stop);
    expect(await reply(stop)).toMatchObject({ outcome: "delivered" });
    expect(await reply(toCopy)).toMatchObject({ outcome: "delivered", mode: "resume", reply: "second" });
    expect(ran()).toEqual(["first", "second"]);
    expect(argvs()[1]).toEqual(expect.arrayContaining(["--resume", COPY]));
  });

  it("another session's messages don't wait for this one's", async () => {
    transcript(OTHER);
    await startDaemon();
    const mine = await sign("forever reply with just the word mine");
    poll(mine);
    await until(() => ran().length === 1);
    const queued = await sign("reply with just the word queued");
    const theirs = await sign("reply with just the word theirs", { session: `claude-code:${OTHER}` });
    poll(queued, theirs);
    expect(await reply(theirs)).toMatchObject({ outcome: "delivered", reply: "theirs" });
    expect(ran()).toEqual(["mine", "theirs"]);
  });
});

describe.runIf(unix)("the same order on the other rungs", () => {
  it("turn: they are handed to the session's Stops in sent order, and if no Stop takes them they resume in it", async () => {
    await startDaemon();
    await ask(sock, { op: "event", session: SESSION, event: "UserPromptSubmit" }, 500);
    const now = Date.now();
    const one = await sign("reply with just the word one", { iat: now - 3000 });
    const two = await sign("reply with just the word two", { iat: now - 2000 });
    const three = await sign("reply with just the word three", { iat: now - 1000 });
    const four = await sign("reply with just the word four", { iat: now - 500 });
    verifiedLate("word one");
    poll(one, three);
    // A later poll brings one signed between them.
    await until(() => rx.acks.filter((x) => x.outcome === "taken").length === 2);
    poll(four, two);
    await until(() => rx.acks.filter((x) => x.outcome === "taken").length === 4);
    const handed: string[] = [];
    for (let i = 0; i < 2; i++) {
      const r = await ask(sock, { op: "stop", session: SESSION, active: i > 0 }, 500);
      handed.push((/the word (\w+)/.exec((r as { reason: string }).reason) as RegExpExecArray)[1] as string);
      await ask(sock, { op: "event", session: SESSION, event: "Stop" }, 500);
    }
    expect(handed).toEqual(["one", "two"]);
    // The session ends its turn without asking again: the two still waiting go another
    // way, in the same order.
    await ask(sock, { op: "event", session: SESSION, event: "Stop" }, 500);
    expect(await reply(three)).toMatchObject({ outcome: "delivered", mode: "resume", reply: "three" });
    expect(await reply(four)).toMatchObject({ outcome: "delivered", mode: "resume", reply: "four" });
    expect(ran()).toEqual(["three", "four"]);
  });

  it("fork: the first makes the copy, the second resumes it, whichever was verified first", async () => {
    // A window holds the session, with no inbox: the only way in is a copy.
    writeFileSync(
      path.join(configDir, "sessions", `${process.pid}.json`),
      JSON.stringify({ sessionId: SID, pid: process.pid, kind: "interactive" }),
    );
    await startDaemon();
    const first = await sign("slowly reply with just the word first");
    await settle(5);
    const second = await sign("reply with just the word second");
    verifiedLate("word first");
    poll(first, second);
    expect(await reply(first)).toMatchObject({ outcome: "delivered", mode: "fork", reply: "first" });
    expect(await reply(second)).toMatchObject({ outcome: "delivered", mode: "resume", reply: "second" });
    expect(ran()).toEqual(["first", "second"]);
    expect(argvs()[0]).toContain("--fork-session");
    expect(argvs()[1]).toEqual(expect.arrayContaining(["--resume", COPY]));
    expect(argvs()[1]).not.toContain("--fork-session");
  });
});
