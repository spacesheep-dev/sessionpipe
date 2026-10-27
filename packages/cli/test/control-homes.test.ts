// SPDX-License-Identifier: Apache-2.0
// Which Claude Code account a message is for, when one session id is filed in more
// than one of them (CONTROL.md §6, Homes). The home that holds the session open wins;
// nothing live, or two of them live, is refused `ambiguous_home` rather than guessed —
// a guess put a message into an account that was signed out.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeControl } from "@sessionpipe/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ControlDaemon } from "../src/control/daemon.js";
import type { ControlConfig } from "../src/control/store.js";
import { FakeReceiver } from "./helpers/receiver.js";

const SID = "8c132906-8c3f-4814-870a-afc3d05e1d2e";
const SESSION = `claude-code:${SID}`;
const unix = process.platform !== "win32";

let tmp: string;
let rx: FakeReceiver;
let d: ControlDaemon | null = null;
let sock: string;
let project: string;
let fakeClaude: string;

/** A session's transcript in one account, old enough not to read as freshly written. */
function transcript(dir: string): void {
  const f = path.join(dir, "projects", project.replace(/[^a-zA-Z0-9]/g, "-"), `${SID}.jsonl`);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, `${JSON.stringify({ type: "user", cwd: project, message: { content: "hi" } })}\n`);
  const past = new Date(Date.now() - 600_000);
  utimesSync(f, past, past);
}

/** A registry row in one account saying a live process holds the session. */
function row(dir: string, pid: number): void {
  mkdirSync(path.join(dir, "sessions"), { recursive: true });
  writeFileSync(path.join(dir, "sessions", `${pid}.json`), JSON.stringify({ sessionId: SID, pid }));
}

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

async function startDaemon(dirs: string[]): Promise<void> {
  d = new ControlDaemon(cfg(), path.join(tmp, "state", "control"), sock, {
    now: () => Date.now(),
    fetch,
    log: () => {},
    claudeDirs: () => dirs,
    claude: () => ({
      bin: fakeClaude,
      caps: { hasMode: true, modes: ["default", "dontAsk"], promptsNone: false, fork: true },
    }),
    run: claudeControl.runClaude,
    sdk: null,
    env: {
      ...process.env,
      SESSIONPIPE_STATE: path.join(tmp, "state"),
      SESSIONPIPE_CONFIG: path.join(tmp, "config", "config.json"),
      SESSIONPIPE_SOCKET: sock,
    },
    answerWaitMs: 1500,
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
  tmp = mkdtempSync(path.join(os.tmpdir(), "sp-homes-"));
  project = path.join(tmp, "project");
  mkdirSync(project, { recursive: true });
  sock = path.join(mkdtempSync(path.join(os.tmpdir(), "sp-sh-")), "c.sock");
  fakeClaude = path.join(tmp, "claude");
  writeFileSync(
    fakeClaude,
    `#!/usr/bin/env node
const a = process.argv.slice(2);
const i = a.indexOf("--resume");
process.stdout.write(JSON.stringify({ type: "result", result: "did it", session_id: i >= 0 ? a[i + 1] : "x", is_error: false }));
`,
  );
  chmodSync(fakeClaude, 0o755);
  rx.queue.clear();
  rx.acks.length = 0;
});
afterEach(async () => {
  await d?.stop();
  d = null;
  rmSync(path.dirname(sock), { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});

describe.runIf(unix)("one session id, several accounts", () => {
  it("none of them holds it open: refused, naming the accounts by directory and nothing else", async () => {
    const a = path.join(tmp, "home-a");
    const b = path.join(tmp, "home-b");
    transcript(a);
    transcript(b);
    await startDaemon([b, a]);
    const q = await rx.send({ session: SESSION, kind: "prompt", text: "which one?" });
    const ack = await rx.waitAck(q.id);
    expect(ack).toMatchObject({ outcome: "refused", code: "ambiguous_home" });
    expect(String(ack.detail)).toContain("home-a, home-b");
    expect(String(ack.detail)).not.toContain(tmp);
  });

  it("two of them hold it open: refused too", async () => {
    const a = path.join(tmp, "home-a");
    const b = path.join(tmp, "home-b");
    transcript(a);
    transcript(b);
    row(a, process.pid);
    row(b, process.ppid);
    await startDaemon([a, b]);
    const q = await rx.send({ session: SESSION, kind: "prompt", text: "which one?" });
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "refused", code: "ambiguous_home" });
  });

  it("the one holding it open answers, whatever order the accounts are read in", async () => {
    const a = path.join(tmp, "home-a");
    const b = path.join(tmp, "home-b");
    transcript(a);
    transcript(b);
    row(b, process.pid);
    await startDaemon([a, b]);
    // Live, and nothing can reach it in place here: a copy, from the account that holds it.
    const q = await rx.send({ session: SESSION, kind: "prompt", text: "which one?" });
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered", mode: "fork" });
  });

  it("one account alone needs no live process", async () => {
    const a = path.join(tmp, "home-a");
    transcript(a);
    await startDaemon([a]);
    const q = await rx.send({ session: SESSION, kind: "prompt", text: "just you" });
    expect(await rx.waitAck(q.id)).toMatchObject({ outcome: "delivered", mode: "resume" });
  });
});
