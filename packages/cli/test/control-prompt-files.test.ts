// SPDX-License-Identifier: Apache-2.0
// Files on a `prompt` (CONTROL.md §6 `prompt`): the hello says `prompt_files`; the files
// are fetched, checked and written to <cwd>/.sessionpipe/files/<session>/<nonce>/ before
// the message is handed over in any mode, and listed in its text; a file that fails is
// acked `failed` with code `file` and the message is never delivered. The harness is a
// stand-in `run` that records the argv, so no agent ever runs.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RunResult } from "@sessionpipe/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ControlDaemon, type DaemonDeps } from "../src/control/daemon.js";
import type { ControlConfig } from "../src/control/store.js";
import { waitForMessage } from "../src/control/wait.js";
import { FakeReceiver } from "./helpers/receiver.js";

const SID = "8c132906-8c3f-4814-870a-afc3d05e1d2e";
const SESSION = `claude-code:${SID}`;
const PNG = new Uint8Array(3000).fill(9);

let tmp: string;
let rx: FakeReceiver;
let d: ControlDaemon | null = null;
let project: string;
let configDir: string;
let sock: string;
let env: NodeJS.ProcessEnv;
let runs: string[][];

const unix = process.platform !== "win32";

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

async function startDaemon() {
  d = new ControlDaemon(cfg(), path.join(tmp, "state", "control"), sock, {
    now: Date.now,
    fetch,
    log: process.env.SP_DEBUG ? (s: string) => console.error(`[daemon] ${s}`) : () => {},
    claudeDirs: () => [configDir],
    claude: () => ({ bin: "claude", caps: { hasMode: true, modes: ["dontAsk"], promptsNone: false, fork: true } }),
    run: ((_bin: string, args: string[]) => {
      runs.push(args);
      return Promise.resolve({
        code: 0,
        signal: null,
        stdout: JSON.stringify({ type: "result", is_error: false, result: "seen it", session_id: SID }),
        stderr: "",
        tooBig: false,
        timedOut: false,
      } satisfies RunResult);
    }) as DaemonDeps["run"],
    env,
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
  tmp = mkdtempSync(path.join(os.tmpdir(), "sp-prompt-files-"));
  project = path.join(tmp, "project");
  configDir = path.join(tmp, "claude-config");
  sock = path.join(tmp, "control.sock");
  env = { ...process.env, SESSIONPIPE_STATE: path.join(tmp, "state"), SESSIONPIPE_SOCKET: sock };
  mkdirSync(project, { recursive: true });
  mkdirSync(path.join(configDir, "sessions"), { recursive: true });
  // The session's transcript, ten minutes old: idle, so a message resumes it.
  const dir = path.join(configDir, "projects", project.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${SID}.jsonl`);
  writeFileSync(f, `${JSON.stringify({ type: "user", cwd: project, message: { content: "hi" } })}\n`);
  utimesSync(f, new Date(Date.now() - 600_000), new Date(Date.now() - 600_000));
  runs = [];
  rx.queue.clear();
  rx.acks.length = 0;
  rx.hellos.length = 0;
  rx.files.clear();
});
afterEach(async () => {
  await d?.stop();
  d = null;
  rmSync(tmp, { recursive: true, force: true });
});

const nonceOf = (cmd: string) => (JSON.parse(cmd) as { nonce: string }).nonce;

describe.runIf(unix)("files on a prompt", { timeout: 30_000 }, () => {
  it("the hello says so", async () => {
    await startDaemon();
    for (let i = 0; i < 100 && !rx.hellos.length; i++) await new Promise((r) => setTimeout(r, 20));
    expect(rx.hellos.at(-1)).toMatchObject({ files: true, prompt_files: true });
  });

  it("a resume: written in the message's own folder first, then listed in the message the run gets", async () => {
    await startDaemon();
    const png = await rx.upload("shot.png", "image/png", PNG);
    const q = await rx.send({ session: SESSION, text: "what about this?", files: [png] });
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered", mode: "resume", reply: "seen it" });
    const rel = `.sessionpipe/files/${SID}/${nonceOf(q.cmd)}/shot.png`;
    const saved = path.join(project, rel);
    expect(readFileSync(saved)).toEqual(Buffer.from(PNG));
    expect(statSync(saved).mode & 0o777).toBe(0o600);
    expect(readFileSync(path.join(project, ".sessionpipe", ".gitignore"), "utf8")).toBe("*\n");
    expect(runs[0]?.at(-1)).toMatch(
      new RegExp(
        `^Message via [^\n]+\n\nwhat about this\\?\n\nAttached files \\(saved in this folder\\):\n- ${rel.replace(/\./g, "\\.")} \\(image/png, 3 KB\\)$`,
      ),
    );
    // A second message to the same session gets a folder of its own beside the first.
    const q2 = await rx.send({ session: SESSION, text: "and this", files: [png] });
    await rx.waitAck(q2.id);
    expect(readdirSync(path.join(project, ".sessionpipe", "files", SID)).sort()).toEqual(
      [nonceOf(q.cmd), nonceOf(q2.cmd)].sort(),
    );
  });

  it("a waiter: the files are on disk before the text is handed over", async () => {
    await startDaemon();
    const png = await rx.upload("shot.png", "image/png", PNG);
    const got = waitForMessage(SESSION, { env });
    await new Promise((r) => setTimeout(r, 100));
    const q = await rx.send({ session: SESSION, text: "look", files: [png] });
    const text = await got;
    const rel = `.sessionpipe/files/${SID}/${nonceOf(q.cmd)}/shot.png`;
    expect(text).toContain(`look\n\nAttached files (saved in this folder):\n- ${rel} (image/png, 3 KB)`);
    expect(statSync(path.join(project, rel)).size).toBe(PNG.length);
    expect(runs).toEqual([]);
  });

  it("a file that fails: failed with code file, nothing kept, and the message is never delivered", async () => {
    await startDaemon();
    const png = await rx.upload("shot.png", "image/png", PNG);
    // The receiver swaps the bytes: the signed hash no longer matches.
    const [h] = [...rx.files.keys()];
    rx.files.set(h as string, { bytes: new Uint8Array(3000).fill(1), type: "image/png" });
    const q = await rx.send({ session: SESSION, text: "look", files: [png] });
    expect(await rx.waitAck(q.id)).toMatchObject({
      outcome: "failed",
      code: "file",
      detail: '"shot.png" doesn\'t match its signed hash: it was changed',
    });
    expect(runs).toEqual([]);
    expect(existsSync(path.join(project, ".sessionpipe"))).toBe(false);
  });
});
