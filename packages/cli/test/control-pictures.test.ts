// SPDX-License-Identifier: Apache-2.0
// A command's pictures, handed over natively as well as listed in the text (CONTROL.md §6
// `start`, Pictures): Codex's `--image` on a start and a resume, and a Codex that has no
// such flag run again without it; nothing new for Antigravity or `claude -p`. The log's
// counts on each. Stand-in `codex` and `agy` record what they were given; the receiver is
// the fake one, so the files travel the whole way. The project's folder has a space and
// an accent in its name.
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type RunResult, runHeadless } from "@sessionpipe/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ControlDaemon, type DaemonDeps } from "../src/control/daemon.js";
import type { ControlConfig } from "../src/control/store.js";
import { jsonLines } from "./helpers/lines.js";
import { FakeReceiver } from "./helpers/receiver.js";

const THREAD = "0199b6f2-7c1d-7e3a-9b4c-5d6e7f8a9b0c"; // the thread a new `codex exec` picks
const RECV = "0b6f2c7e-3d4a-4f1b-9c8e-2a1d5e6f7e01"; // the id a receiver's start names
const AGENT = "01a15fcd-05fc-78f3-83d7-6cc03f65676c"; // the session an ACP agent names
const unix = process.platform !== "win32";

/** A PNG as far as its header: enough for the machine to know it for one. */
function png(w: number, h: number): Uint8Array {
  const b = Buffer.alloc(40);
  Buffer.from("\x89PNG\r\n\x1a\n\0\0\0\rIHDR", "latin1").copy(b);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
/** A JPEG as far as its first frame. */
function jpeg(w: number, h: number): Uint8Array {
  const sof = Buffer.from([
    0xff,
    0xc0,
    0,
    17,
    8,
    h >> 8,
    h & 255,
    w >> 8,
    w & 255,
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
  ]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof]);
}

let tmp: string;
let rx: FakeReceiver;
let d: ControlDaemon | null = null;
let env: NodeJS.ProcessEnv;
let sock: string;
let project: string;
let calls: string;
let fakeCodex: string;
let fakeAgy: string;
let fakeAcp: string;
let logs: string[];

function writeFakes(): void {
  const head = `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const a = process.argv.slice(2);
const log = (o) => fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(o) + "\\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
`;
  // codex: what it was given, and for each --image whether the file was there to read.
  // With an \`old\` file beside it, it is a Codex from before --image.
  writeFileSync(
    fakeCodex,
    `${head}
const images = a.flatMap((x, i) => (x === "--image" ? [a[i + 1]] : []));
log({ bin: "codex", argv: a, images: images.map((p) => ({ p, there: fs.existsSync(p) })) });
if (images.length && fs.existsSync(path.join(__dirname, "old"))) {
  process.stderr.write("error: unexpected argument '--image' found\\n\\nUsage: codex exec [OPTIONS] [PROMPT]\\n\\nFor more information, try '--help'.\\n");
  process.exit(2);
}
const resume = a[1] === "resume";
const id = resume ? a[a.indexOf("--") + 1] : ${JSON.stringify(THREAD)};
if (!resume) {
  const day = path.join(process.env.CODEX_HOME, "sessions", "2026", "11", "19");
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, "rollout-2026-11-19T10-00-00-" + id + ".jsonl"),
    JSON.stringify({ type: "session_meta", payload: { id, cwd: process.cwd() } }) + "\\n");
}
out({ type: "thread.started", thread_id: id });
out({ type: "turn.started" });
out({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "I see " + images.length + " picture(s)." } });
out({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
`,
  );
  writeFileSync(
    fakeAgy,
    `${head}
log({ bin: "agy", argv: a });
out({ event: "init", conversation_id: "c1", init: { cwd: process.cwd() } });
out({ event: "result", result: { conversation_id: "c1", status: "SUCCESS", response: "agy read the list", error: "", denied_actions: [] } });
`,
  );
  // An ACP agent that takes images, and says what it was given.
  writeFileSync(
    fakeAcp,
    `const fs = require("fs");
const log = (o) => fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(o) + "\\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let session = ${JSON.stringify(AGENT)};
let buf = "";
process.stdin.on("data", (b) => {
  buf += b.toString();
  const lines = buf.split("\\n");
  buf = lines.pop();
  for (const line of lines) if (line.trim()) handle(JSON.parse(line));
});
process.stdin.on("end", () => setTimeout(() => process.exit(0), 20));
function handle(m) {
  if (m.method === "initialize")
    return out({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true } }, authMethods: [] } });
  if (m.method === "session/new") return out({ jsonrpc: "2.0", id: m.id, result: { sessionId: session } });
  if (m.method === "session/load") { session = m.params.sessionId; return out({ jsonrpc: "2.0", id: m.id, result: {} }); }
  if (m.method !== "session/prompt") return;
  const blocks = m.params.prompt.map((b) => b.type === "image" ? { type: b.type, mimeType: b.mimeType, uri: b.uri, bytes: Buffer.from(b.data, "base64").length } : { type: b.type });
  log({ bin: "acp", blocks });
  out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: session, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "I see " + (blocks.length - 1) + " picture(s)." } } } });
  out({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn" } });
}
`,
  );
  chmodSync(fakeCodex, 0o755);
  chmodSync(fakeAgy, 0o755);
}

type Call = {
  bin: string;
  argv?: string[];
  images?: { p: string; there: boolean }[];
  blocks?: { type: string; mimeType?: string; uri?: string; bytes?: number }[];
};
const runs = (): Call[] => jsonLines(calls) as Call[];
const ran = (bin: string) => runs().filter((r) => r.bin === bin);

function cfg(): ControlConfig {
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
  };
}

async function startDaemon(extra: Partial<DaemonDeps> = {}) {
  d = new ControlDaemon(cfg(), path.join(tmp, "state", "control"), sock, {
    now: Date.now,
    fetch,
    log: (s: string) => {
      logs.push(s);
      if (process.env.SP_DEBUG) console.error(`[daemon] ${s}`);
    },
    claudeDirs: () => [path.join(tmp, "claude-config")],
    claude: () => null,
    codex: () => fakeCodex,
    agy: () => fakeAgy,
    acp: (h) => (h === "goose" ? { bin: process.execPath, args: [fakeAcp] } : null),
    run: runHeadless,
    env,
    ...extra,
  });
  await d.start();
}

beforeAll(async () => {
  rx = new FakeReceiver();
  await rx.start();
});
afterAll(async () => {
  await rx.stop();
});
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sp-pictures-")));
  project = path.join(tmp, "my project é");
  mkdirSync(project, { recursive: true });
  sock = path.join(tmp, "control.sock");
  calls = path.join(tmp, "calls.jsonl");
  mkdirSync(path.join(tmp, "bin"));
  fakeCodex = path.join(tmp, "bin", "codex");
  fakeAgy = path.join(tmp, "bin", "agy");
  fakeAcp = path.join(tmp, "bin", "acp.cjs");
  writeFakes();
  env = {
    ...process.env,
    SESSIONPIPE_STATE: path.join(tmp, "state"),
    SESSIONPIPE_CONFIG: path.join(tmp, "config", "config.json"),
    SESSIONPIPE_SOCKET: sock,
    CODEX_HOME: path.join(tmp, "codex-home"),
  };
  delete env.CODEX_API_KEY;
  logs = [];
  rx.queue.clear();
  rx.acks.length = 0;
  rx.files.clear();
});
afterEach(async () => {
  await d?.stop();
  d = null;
  rmSync(tmp, { recursive: true, force: true });
});

/** What the daemon logged about pictures, without the message's id. */
const said = () => logs.filter((l) => l.includes(": pictures: ")).map((l) => l.slice(l.indexOf("pictures: ")));

/** Where a start's file is saved, and a prompt's. */
const startFile = (name: string) => path.join(project, ".sessionpipe", "files", RECV, name);
const promptFile = (cmd: string, name: string) =>
  path.join(project, ".sessionpipe", "files", RECV, (JSON.parse(cmd) as { nonce: string }).nonce, name);

describe.runIf(unix)("Codex: --image beside the list", { timeout: 30_000 }, () => {
  it("a start: each picture its own --image, in order; a PDF and a file that only says it is a PNG are listed only", async () => {
    await startDaemon();
    const shot = await rx.upload("shot é 1.png", "image/png", png(396, 132));
    const notes = await rx.upload("notes.pdf", "application/pdf", Buffer.from("%PDF-1.7\n"));
    const fake = await rx.upload("not really.png", "image/png", new Uint8Array(64).fill(7));
    const photo = await rx.upload("photo.JPG", "IMAGE/JPEG", jpeg(3024, 1964));
    const q = await rx.send({
      kind: "start",
      session: `codex:${RECV}`,
      cwd: project,
      text: "what's in these?",
      files: [shot, notes, fake, photo],
    });
    expect(await rx.waitAck(q.id)).toMatchObject({
      outcome: "delivered",
      mode: "resume",
      reply: "I see 2 picture(s).",
    });
    const [run] = ran("codex");
    const dash = run!.argv!.indexOf("--");
    expect(run!.argv!.slice(dash - 4, dash)).toEqual([
      "--image",
      startFile("shot é 1.png"),
      "--image",
      startFile("photo.JPG"),
    ]);
    expect(run!.images!.every((i) => i.there)).toBe(true);
    // The list is the same as ever: all four files, the text's last words before the frame.
    expect(run!.argv!.at(-1)).toMatch(
      /^what's in these\?\n\nAttached files \(saved in this folder\):\n- \.sessionpipe\/files\/[^/]+\/shot é 1\.png \(image\/png, 40 B\)\n- [^\n]+notes\.pdf[^\n]+\n- [^\n]+not really\.png[^\n]+\n- [^\n]+photo\.JPG \(IMAGE\/JPEG, 21 B\)\n\n\(Sent via/,
    );
    // Counts only: never a name.
    expect(said()).toEqual(["pictures: 2 natively (codex --image), 0 in the list only"]);
  });

  it("a resume: the message's pictures from its own folder; a message without files has none", async () => {
    await startDaemon();
    const q = await rx.send({ kind: "start", session: `codex:${RECV}`, cwd: project, text: "hello" });
    await rx.waitAck(q.id);
    const a = await rx.upload("a.png", "image/png", png(10, 10));
    const b = await rx.upload("b.png", "image/png", png(20, 20));
    const q2 = await rx.send({ session: `codex:${RECV}`, text: "and these", files: [b, a] });
    expect(await rx.waitAck(q2.id)).toMatchObject({ outcome: "delivered", reply: "I see 2 picture(s)." });
    const q3 = await rx.send({ session: `codex:${RECV}`, text: "and nothing" });
    expect(await rx.waitAck(q3.id)).toMatchObject({ outcome: "delivered", reply: "I see 0 picture(s)." });
    const [start, resume, plain] = ran("codex");
    expect(start!.argv).not.toContain("--image");
    expect(resume!.argv!.slice(0, 2)).toEqual(["exec", "resume"]);
    const dash = resume!.argv!.indexOf("--");
    expect(resume!.argv!.slice(dash - 4)).toEqual([
      "--image",
      promptFile(q2.cmd, "b.png"),
      "--image",
      promptFile(q2.cmd, "a.png"),
      "--",
      THREAD,
      expect.stringContaining("and these"),
    ]);
    expect(plain!.argv).not.toContain("--image");
  });

  it("a Codex from before --image: refused at once, so run again with the list alone, and delivered", async () => {
    writeFileSync(path.join(tmp, "bin", "old"), "");
    await startDaemon();
    const shot = await rx.upload("shot.png", "image/png", png(10, 10));
    const q = await rx.send({ kind: "start", session: `codex:${RECV}`, cwd: project, text: "look", files: [shot] });
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered", reply: "I see 0 picture(s)." });
    const [refused, again] = ran("codex");
    expect(refused!.argv).toContain("--image");
    expect(again!.argv).toEqual(refused!.argv!.filter((x, i, all) => x !== "--image" && all[i - 1] !== "--image"));
    expect(again!.argv!.at(-1)).toContain("Attached files (saved in this folder):\n- .sessionpipe/files/");
    expect(logs).toContainEqual(
      expect.stringMatching(
        /codex doesn't take pictures as arguments \(error: unexpected argument '--image' found\); run again with the list in the text alone$/,
      ),
    );
    expect(ran("codex")).toHaveLength(2);
    expect(said()).toEqual([
      "pictures: 1 natively (codex --image), 0 in the list only",
      "pictures: 0 natively (codex refused --image), 1 in the list only",
    ]);
  });

  it("a picture whose name has a comma: listed only, never an --image Codex would split", async () => {
    await startDaemon();
    const comma = await rx.upload("x,README.png", "image/png", png(10, 10));
    const plain = await rx.upload("plain.png", "image/png", png(10, 10));
    const q = await rx.send({
      kind: "start",
      session: `codex:${RECV}`,
      cwd: project,
      text: "look",
      files: [comma, plain],
    });
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered", reply: "I see 1 picture(s)." });
    const [run] = ran("codex");
    expect(run!.images).toEqual([{ p: startFile("plain.png"), there: true }]);
    expect(run!.argv!.at(-1)).toContain("/x,README.png (image/png, 40 B)");
    expect(said()).toEqual(["pictures: 1 natively (codex --image), 1 in the list only"]);
  });

  it("a run that fails some other way with its pictures is not run again", async () => {
    // A stand-in run: exit 2, but not over --image (and one that said something first).
    const seen: string[][] = [];
    const answers: RunResult[] = [
      { code: 2, signal: null, stdout: "", stderr: "error: unexpected argument '--frobnicate' found\n" },
      {
        code: 2,
        signal: null,
        stdout: `${JSON.stringify({ type: "thread.started", thread_id: THREAD })}\n`,
        stderr: "error: unexpected argument '--image' found\n",
      },
    ];
    await startDaemon({
      run: ((_bin: string, args: string[]) => {
        seen.push(args);
        return Promise.resolve(answers.shift() as RunResult);
      }) as DaemonDeps["run"],
    });
    const shot = await rx.upload("shot.png", "image/png", png(10, 10));
    for (const id of [RECV, THREAD]) {
      const q = await rx.send({ kind: "start", session: `codex:${id}`, cwd: project, text: "look", files: [shot] });
      expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "failed" });
    }
    expect(seen).toHaveLength(2);
    expect(seen.every((a) => a.includes("--image"))).toBe(true);
  });
});

describe.runIf(unix)("Antigravity: the list alone, as before", { timeout: 30_000 }, () => {
  it("a picture changes nothing in agy's arguments", async () => {
    await startDaemon();
    const shot = await rx.upload("shot.png", "image/png", png(10, 10));
    const q = await rx.send({
      kind: "start",
      session: `antigravity:${RECV}`,
      cwd: project,
      text: "look",
      files: [shot],
    });
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered", reply: "agy read the list" });
    const [run] = ran("agy");
    expect(run!.argv).toEqual([
      "-p",
      expect.stringMatching(
        /^look\n\nAttached files \(saved in this folder\):\n- \.sessionpipe\/files\/[^\n]+shot\.png/,
      ),
      "--output-format",
      "stream-json",
    ]);
    expect(said()).toEqual(["pictures: 0 natively (agy takes none), 1 in the list only"]);
  });
});

describe.runIf(unix)("Claude Code through claude -p: the list alone, and the log says so", { timeout: 30_000 }, () => {
  it("a start and a resume with a picture each: claude -p takes none, Claude Code opens them", async () => {
    const SID = "8c132906-8c3f-4814-870a-afc3d05e1d2e";
    const argv: string[][] = [];
    await startDaemon({
      claude: () => ({ bin: "claude", caps: { hasMode: true, modes: ["dontAsk"], promptsNone: false, fork: true } }),
      run: ((_bin: string, args: string[]) => {
        argv.push(args);
        return Promise.resolve({
          code: 0,
          signal: null,
          stdout: JSON.stringify({ type: "result", is_error: false, result: "seen", session_id: SID }),
          stderr: "",
        } satisfies RunResult);
      }) as DaemonDeps["run"],
    });
    const shot = await rx.upload("shot.png", "image/png", png(10, 10));
    const q = await rx.send({
      kind: "start",
      session: `claude-code:${SID}`,
      cwd: project,
      text: "look",
      files: [shot],
    });
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered", reply: "seen" });
    // The session's transcript, ten minutes old: idle, so the next message resumes it.
    const dir = path.join(tmp, "claude-config", "projects", project.replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(dir, { recursive: true });
    const t = path.join(dir, `${SID}.jsonl`);
    writeFileSync(t, `${JSON.stringify({ type: "user", cwd: project, message: { content: "look" } })}\n`);
    utimesSync(t, new Date(Date.now() - 600_000), new Date(Date.now() - 600_000));
    const q2 = await rx.send({ session: `claude-code:${SID}`, text: "and this", files: [shot] });
    expect(await rx.waitAck(q2.id)).toMatchObject({ outcome: "delivered", mode: "resume" });
    expect(argv).toHaveLength(2);
    expect(argv.flat().some((a) => a.includes("--image"))).toBe(false);
    expect(said()).toEqual([
      "pictures: 0 natively (claude -p takes none; Claude Code opens them), 1 in the list only",
      "pictures: 0 natively (claude -p takes none; Claude Code opens them), 1 in the list only",
    ]);
  });
});
