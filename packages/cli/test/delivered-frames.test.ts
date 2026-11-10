// SPDX-License-Identifier: Apache-2.0
// Every sentence the control daemon puts around a message it delivers (control/route.ts,
// control/wait.ts, control/files.ts) against what the transcript readers take off again
// (sessionpipe-core/control `deliveredWords`). The daemon builds its frames with core's
// own builders, so the words cannot differ; what can is the way the daemon puts them
// together for a lane, and a lane the readers don't know is left in a turn's `user`
// text, where a receiver draws it as the person's own words. The first group builds
// each lane as control/daemon.ts builds it; the second takes what a running daemon
// really hands a live session (into its inbox, at its Stop, to its waiter) and reads it
// back from the transcript the session would write.
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { claudeControl, readClaude, shortId } from "@sessionpipe/core";
import * as core from "@sessionpipe/core/control";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ControlDaemon } from "../src/control/daemon.js";
import { withFiles } from "../src/control/files.js";
import { readEnvelope } from "../src/control/inbox.js";
import { ask } from "../src/control/local.js";
import * as route from "../src/control/route.js";
import { RE_ARM, waitForMessage } from "../src/control/wait.js";
import { FakeReceiver } from "./helpers/receiver.js";

const R = "https://spacesheep.dev/api/control";
const ID = "01K8ZC3W5Q7RN4XJ1V2B6T9M0D";
const WORDS = "Rebase the branch.\n\nThen run the tests.";

describe("the daemon's frames and core's", () => {
  it("are one definition", () => {
    expect(route.IN_PLACE_ANSWER).toBe(core.IN_PLACE_ANSWER);
    expect(RE_ARM).toBe(core.RE_ARM);
    expect(route.hostOf).toBe(core.hostOf);
    expect(route.frame).toBe(core.frame);
    expect(route.frameMarked).toBe(core.frameMarked);
    expect(route.messageMark).toBe(core.messageMark);
    expect(route.frameStart).toBe(core.frameStart);
    expect(route.frameAsk).toBe(core.frameAsk);
    expect(route.copyNote).toBe(core.copyNote);
    expect(route.unframe).toBe(core.unframe);
    // What a copy of a session that is open in a window is told has not changed.
    expect(route.copyNote("open")).toBe(
      "You are a copy of that session, started because the original is open in a window, and you have its conversation, folder and tools. Do what the message asks the way the original would: edits, commands and publishing all take effect for real. Only this conversation stays here, so the person reads your reply and not the original's window: say what you did, then stop.",
    );
    expect(route.messageMark(ID)).toBe("message XJ1V2B6T9M0D");
    // A handoff's answer names who answered by the short id the receivers label sessions by.
    const from = { harness: "codex", id: "01a10860-a43f-7ce2-b12f-a7911ae8a880" };
    expect(route.frameHandoff(from, R, WORDS)).toBe(
      core.frameHandoff(`codex:${shortId(from.harness, from.id)}`, R, WORDS),
    );
  });

  // Each text below is built as control/daemon.ts builds it for a lane.
  it("come off every text the daemon hands a session, leaving the person's words", () => {
    const files = withFiles(
      WORDS,
      [{ file: { type: "image/png", size: 183_402 } }] as Parameters<typeof withFiles>[1],
      [".sessionpipe/files/s1/shot.png"],
    );
    const lanes: Record<string, [string, string]> = {
      "a new session's first message": [route.frameStart(WORDS, R), WORDS],
      "a new session's first message, with files": [route.frameStart(files, R), files],
      "a headless resume": [route.frame(WORDS, R), WORDS],
      "a copy of a session open in a window": [`${route.frame(WORDS, R)}\n\n${route.copyNote("open")}`, WORDS],
      "a copy of a session another process is running": [
        `${route.frame(WORDS, R)}\n\n${route.copyNote("running")}`,
        WORDS,
      ],
      "a copy of a session something wrote to a moment ago": [
        `${route.frame(WORDS, R)}\n\n${route.copyNote("recent")}`,
        WORDS,
      ],
      // The in-place lanes name the message: that is how its answer is found again.
      "a Stop hook's block": [`${route.frameMarked(WORDS, R, ID)}\n\n${route.IN_PLACE_ANSWER}`, WORDS],
      "the inbox": [`${route.frameMarked(WORDS, R, ID)}\n\n${route.IN_PLACE_ANSWER}`, WORDS],
      "a waiter": [`${route.frameMarked(WORDS, R, ID)}\n\n${RE_ARM}`, WORDS],
      "a message with files, at a Stop": [`${route.frameMarked(files, R, ID)}\n\n${route.IN_PLACE_ANSWER}`, files],
    };
    // Another session's ask keeps the paragraph that says who asked, whichever way it
    // arrives: a receiver has nothing else to tell an agent's task from the person's words.
    // Handed over in place it names its message too, and comes back as the plain paragraph.
    const from = "claude-code:8c132906-8c3f-4814-870a-afc3d05e1d2e";
    const asked = route.frameAsk(WORDS, from);
    const marked = route.frameAsk(WORDS, from, route.messageMark(ID));
    Object.assign(lanes, {
      "an ask: a new session, an idle one resumed": [asked, asked],
      "an ask to a copy of a session open in a window": [`${asked}\n\n${route.copyNote("open")}`, asked],
      "an ask to a copy of a session in use": [`${asked}\n\n${route.copyNote("recent")}`, asked],
      "an ask at a Stop hook's block": [marked, asked],
      "an ask through a waiter": [`${marked}\n\n${RE_ARM}`, asked],
    });
    for (const [lane, [given, words]] of Object.entries(lanes))
      expect(core.deliveredWords(given), lane).toMatchObject({ text: words, delivered: true });
    // What a channel is handed, undone for its tag (`unframe`): the same words, from the
    // same host, as a reader finds — with the message's mark in the header or without.
    for (const given of [route.frame(WORDS, R), route.frameMarked(WORDS, R, ID)])
      expect(core.deliveredWords(given)).toMatchObject(route.unframe(given));
    // A handoff's answer keeps its first line: it is what says whose words follow. It
    // carries no mark of its own, whatever lane it lands by.
    const handoff = route.frameHandoff({ harness: "codex", id: "x" }, R, WORDS);
    for (const given of [handoff, `${handoff}\n\n${route.copyNote("running")}`, `${handoff}\n\n${RE_ARM}`])
      expect(core.deliveredWords(given)).toEqual({ text: handoff, via: null, delivered: true });
  });
});

describe.runIf(process.platform !== "win32")("what a running daemon hands a live session, read back", () => {
  const SID = "8c132906-8c3f-4814-870a-afc3d05e1d2e";
  const SESSION = `claude-code:${SID}`;
  let rx: FakeReceiver;
  let d: ControlDaemon | null = null;
  let tmp: string;
  let sock: string;
  let file: string;
  let inbox: net.Server;
  let env: NodeJS.ProcessEnv;
  /** Every line the session's own inbox was handed. */
  let handed: string[];

  const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async <T>(what: () => T | undefined | null | false): Promise<T> => {
    for (let i = 0; i < 500; i++) {
      const v = what();
      if (v) return v;
      await settle(20);
    }
    throw new Error("waited too long");
  };
  const row = (o: Record<string, unknown>) => appendFileSync(file, `${JSON.stringify(o)}\n`);
  const says = (text: string) =>
    row({
      type: "assistant",
      timestamp: new Date().toISOString(),
      message: { stop_reason: "end_turn", content: [{ type: "text", text }] },
    });
  const event = (name: string) =>
    ask(sock, { op: "event", session: SESSION, event: name, mode: "bypassPermissions" }, 500);
  /** What the reader makes of the transcript since it was opened here: each turn's
   *  `user` side, as a receiver shows it. */
  const asked = () =>
    readClaude(readFileSync(file, "utf8").split("\n"), 0)
      .turns.map((t) => t.user)
      .slice(1);

  beforeAll(async () => {
    rx = new FakeReceiver();
    await rx.start();
  });
  afterAll(async () => {
    await rx.stop();
  });
  beforeEach(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "sp-frames-"));
    const project = path.join(tmp, "project");
    const configDir = path.join(tmp, "home");
    mkdirSync(project, { recursive: true });
    mkdirSync(path.join(configDir, "sessions"), { recursive: true });
    // macOS caps a socket path at 104 bytes: both sockets live in a short temp dir.
    sock = path.join(mkdtempSync(path.join(os.tmpdir(), "sp-f-")), "c.sock");
    const inboxPath = path.join(path.dirname(sock), "i.sock");
    handed = [];
    inbox = net.createServer((s) => {
      let buf = "";
      s.on("data", (c) => {
        buf += c.toString("utf8");
        for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
          handed.push(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      });
      s.on("error", () => {});
    });
    await new Promise<void>((r) => inbox.listen(inboxPath, () => r()));
    // A session open in its own window, idle, in an account whose default is bypass: the
    // one the inbox lane writes into (CONTROL.md §6.3).
    file = path.join(configDir, "projects", project.replace(/[^a-zA-Z0-9]/g, "-"), `${SID}.jsonl`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ type: "user", cwd: project, message: { content: "hi" } })}\n`);
    says("Hello.");
    const past = new Date(Date.now() - 600_000);
    utimesSync(file, past, past);
    writeFileSync(
      path.join(configDir, "settings.json"),
      JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } }),
    );
    writeFileSync(
      path.join(configDir, "sessions", `${process.pid}.json`),
      JSON.stringify({
        sessionId: SID,
        pid: process.pid,
        kind: "interactive",
        entrypoint: "cli",
        status: "idle",
        peerProtocol: 1,
        messagingSocketPath: inboxPath,
      }),
    );
    env = {
      ...process.env,
      SESSIONPIPE_STATE: path.join(tmp, "state"),
      SESSIONPIPE_CONFIG: path.join(tmp, "config", "config.json"),
      SESSIONPIPE_SOCKET: sock,
    };
    rx.queue.clear();
    rx.acks.length = 0;
    d = new ControlDaemon(
      {
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
      },
      path.join(tmp, "state", "control"),
      sock,
      {
        now: Date.now,
        fetch,
        log: () => {},
        claudeDirs: () => [configDir],
        claude: () => ({
          bin: path.join(tmp, "no-claude"),
          caps: { hasMode: true, modes: ["default", "acceptEdits"], promptsNone: false, fork: true },
        }),
        run: claudeControl.runClaude,
        sdk: null,
        env,
        platform: "darwin",
        answerWaitMs: 20_000,
        answerGraceMs: 200,
      },
    );
    await d.start();
  });
  afterEach(async () => {
    await d?.stop();
    d = null;
    await new Promise<void>((r) => inbox.close(() => r()));
    rmSync(path.dirname(sock), { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  });

  it("its inbox, a Stop hook's block, its waiter: each turn's `user` side is the person's words, and each answer goes back", async () => {
    const host = new URL(rx.url).host;
    // --- Into its inbox, while it sits idle in its own window.
    await ask(sock, { op: "event", session: SESSION, event: "PostToolUse", mode: "bypassPermissions" }, 500);
    const one = await rx.send({ session: SESSION, text: WORDS });
    const envelope = await until(() =>
      handed.map((l) => (JSON.parse(l) as { message?: { content?: string } }).message?.content).find(Boolean),
    );
    const body = readEnvelope(envelope)?.body as string;
    // The header names the message: that is what the daemon finds its turn by.
    expect(body).toBe(`${route.frameMarked(WORDS, rx.url, one.id)}\n\n${route.IN_PLACE_ANSWER}`);
    expect(core.deliveredWords(body)).toEqual({ text: WORDS, via: host, delivered: true });
    // As Claude Code records a message from another session: its own preamble around
    // the envelope, and the body it parsed out of it on the row's origin.
    row({
      type: "user",
      isMeta: true,
      origin: { kind: "peer", body },
      message: {
        content: [
          {
            type: "text",
            text: `Another Claude session sent a message:\n${envelope}\n\nThis came from another Claude session.`,
          },
        ],
      },
    });
    await event("UserPromptSubmit");
    says("Rebased, and the tests pass.");
    expect(await rx.waitAck(one.id)).toMatchObject({
      outcome: "delivered",
      mode: "inbox",
      reply: "Rebased, and the tests pass.",
    });
    expect(asked()).toEqual([WORDS]);

    // --- At its Stop: the session is mid-turn now, so the next message waits for one.
    const two = await rx.send({ session: SESSION, text: "And then deploy it." });
    await until(() => rx.acks.some((a) => a.id === two.id && a.outcome === "taken"));
    const block = (await ask(sock, { op: "stop", session: SESSION, active: false }, 500)) as { reason: string };
    await event("Stop");
    expect(block.reason).toBe(
      `${route.frameMarked("And then deploy it.", rx.url, two.id)}\n\n${route.IN_PLACE_ANSWER}`,
    );
    // As Claude Code 2.1.322 records a Stop hook's block (conformance/transcripts/claude-code/stop-block.jsonl).
    row({ type: "user", isMeta: true, message: { content: `Stop hook feedback:\n${block.reason}` } });
    row({
      type: "attachment",
      attachment: { type: "hook_blocking_error", blockingError: { blockingError: block.reason } },
    });
    row({ type: "system", subtype: "stop_hook_summary", hookErrors: [block.reason] });
    says("Deployed.");
    expect(await rx.waitAck(two.id)).toMatchObject({ outcome: "delivered", mode: "turn", reply: "Deployed." });
    expect(asked()).toEqual([WORDS, "And then deploy it."]);
    expect(await ask(sock, { op: "stop", session: SESSION, active: true }, 500)).toMatchObject({ op: "none" });
    await event("Stop");

    // --- To its waiter: `sessionpipe wait` prints the message for the session to read.
    const waiting = waitForMessage(SESSION, { env });
    await settle(100);
    const three = await rx.send({ session: SESSION, text: "One more thing." });
    const printed = await waiting;
    expect(printed).toBe(`${route.frameMarked("One more thing.", rx.url, three.id)}\n\n${RE_ARM}`);
    expect(core.deliveredWords(printed)).toEqual({ text: "One more thing.", via: host, delivered: true });
    row({ type: "user", message: { content: [{ type: "tool_result", content: `1\t${printed}` }] } });
    says("Noted.");
    await ask(sock, { op: "stop", session: SESSION, active: false }, 500);
    expect(await rx.waitAck(three.id)).toMatchObject({ outcome: "delivered", mode: "waiter", reply: "Noted." });
  });
});
