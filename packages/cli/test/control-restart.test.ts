// SPDX-License-Identifier: Apache-2.0
// What a restart of the daemon must not cost. An update restarts it the moment the
// daemon itself holds nothing, which is the moment its own turn in a session ends, and
// the person's reply comes seconds later: to a daemon that knows what the last one knew,
// or the reply is answered in a copy and every later message goes there.
//
// A real ControlDaemon on its local socket, stopped, and a second one on the same state
// directory. The receiver signs the messages and never listens (its HTTP is a handler
// here), `claude` is a function, and the clock is the test's: no case waits on real time.
import {
  appendFileSync,
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DayKey, Passkey } from "../../core/test/helpers/authenticator.js";
import { type Carried, ControlDaemon, type DaemonDeps, DaemonRunning } from "../src/control/daemon.js";
import { ask } from "../src/control/local.js";
import { HOOKS_WORD_MS } from "../src/control/route.js";
import type { ControlConfig, PairedReceiver } from "../src/control/store.js";
import { FakeReceiver, type Queued } from "./helpers/receiver.js";

// Nothing here waits on real time, but each case signs with real keys and talks over a
// real socket: on a busy machine that is not to be what fails it.
vi.setConfig({ testTimeout: 30_000 });

const SID = "3b6d4b30-20f0-4628-acdd-e3b0b37dccca";
/** The id the stand-in gives a copy it makes. */
const COPY = "c0000001-3d4a-4f1b-9c8e-2a1d5e6f7a8b";
const cc = (id: string) => `claude-code:${id}`;
const MINUTE = 60_000;
const unix = process.platform !== "win32"; // the daemon's socket is a Unix socket here

let tmp: string;
let dir: string;
let sock: string;
let project: string;
let configDir: string;
let rx: FakeReceiver;
let config: ControlConfig;
let receiver: PairedReceiver;
let log: string[];
let open: ControlDaemon[];
/** Every `claude -p` the daemons ran, by its arguments. */
let runs: string[][];
/** How the stand-in `claude` behaves: `ignoresFork`, it takes no notice of
 *  --fork-session and runs as the session it was told to copy; `hooks`, its hooks report
 *  to the daemon as a real one's do. */
let claude: { ignoresFork: boolean; hooks: boolean };

const stateFile = () => path.join(dir, "state.json");
const onFile = () =>
  JSON.parse(readFileSync(stateFile(), "utf8")) as {
    copies_v2?: Record<string, { id: string; why?: string }>;
    mid_turn?: Record<string, unknown>;
    ended?: Record<string, string>;
    strays?: Record<string, string>;
  };
const iso = (ms: number) => new Date(ms).toISOString();
const transcriptFile = (sid: string) =>
  path.join(configDir, "projects", project.replace(/[^a-zA-Z0-9]/g, "-"), `${sid}.jsonl`);
/** A row lands in the session's transcript, `agoMs` ago by the daemon's clock. */
function written(sid: string, agoMs = 0): void {
  const f = transcriptFile(sid);
  mkdirSync(path.dirname(f), { recursive: true });
  appendFileSync(f, `${JSON.stringify({ type: "user", cwd: project, message: { content: "hi" } })}\n`);
  const at = new Date(Date.now() - agoMs);
  utimesSync(f, at, at);
}
const event = (session: string, name: string) => ask(sock, { op: "event", session, event: name }, 2000);

/** A long-poll with nothing in it, ended by the daemon's own abort. */
const emptyPoll: typeof fetch = (_url, init) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(new Response(null, { status: 204 })), 25_000);
    init?.signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
const http: typeof fetch = async (url, init) => {
  const u = new URL(String(url));
  if (u.pathname === "/.well-known/sessionpipe") return Response.json({});
  if (u.pathname === "/control/hello") return new Response(null, { status: 204 });
  if (u.pathname === "/control/ack") {
    rx.acks.push(...(JSON.parse(String(init?.body)) as { acks: Record<string, unknown>[] }).acks);
    return new Response(null, { status: 202 });
  }
  return emptyPoll(url, init);
};

/** A stand-in for `claude -p`: it runs in the session it is told to resume, or in a copy
 *  of it, writes a row there and answers. */
const run: DaemonDeps["run"] = async (_bin, args) => {
  runs.push(args);
  const asked = args[args.indexOf("--resume") + 1] as string;
  const sid = args.includes("--fork-session") && !claude.ignoresFork ? COPY : asked;
  if (claude.hooks) await event(cc(sid), "UserPromptSubmit");
  written(sid);
  if (claude.hooks) {
    await event(cc(sid), "Stop");
    await event(cc(sid), "SessionEnd");
  }
  return {
    code: 0,
    signal: null,
    stdout: JSON.stringify({ type: "result", result: "did it", session_id: sid, is_error: false }),
    stderr: "",
  };
};
/** How each run was asked to run, in order: in place, or as a copy. */
const ran = () =>
  runs.map((a) => `${a.includes("--fork-session") ? "fork" : "resume"} ${a[a.indexOf("--resume") + 1]}`);

/** A daemon on the state directory, started. `at`: another socket than the usual one. */
async function daemon(at = sock): Promise<ControlDaemon> {
  const d = new ControlDaemon(config, dir, at, {
    now: Date.now,
    fetch: http,
    log: (l) => log.push(l),
    claudeDirs: () => [configDir],
    accounts: () => [],
    claude: () => ({
      bin: "fake-claude",
      caps: { hasMode: true, modes: ["default", "dontAsk"], promptsNone: false, fork: true },
    }),
    run,
  });
  open.push(d);
  await d.start();
  return d;
}
/** A stop as an update's restart makes it: with nothing in hand. */
async function stop(d: ControlDaemon): Promise<void> {
  await vi.waitFor(() => expect(d.busy()).toBeNull(), { timeout: 10_000, interval: 10 });
  await d.stop();
}
/** A signed message handed to the daemon this instant, as a poll would hand it. */
async function hand(d: ControlDaemon, text: string, session = cc(SID)): Promise<Queued> {
  const q = await rx.send({ session, text }, { hold: true });
  void d.handle(receiver, q as Carried);
  return q;
}
const acksOf = (id: string) => rx.acks.filter((a) => a.id === id).map((a) => a.outcome);
/** The message is acked `taken` and nothing more: it waits. */
const taken = (id: string) =>
  vi.waitFor(() => expect(acksOf(id)).toEqual(["taken"]), { timeout: 10_000, interval: 10 });
/** The Stop hook of a session asks the daemon for a message, as its turn ends. */
const stopHook = (session: string) => ask(sock, { op: "stop", session, active: false }, 2000);
const finalAck = (id: string): Promise<Record<string, unknown>> =>
  vi.waitFor(
    () => {
      const a = rx.finalAck(id);
      if (!a) throw new Error(`no final ack for ${id} yet: ${JSON.stringify(acksOf(id))}`);
      return a;
    },
    { timeout: 10_000, interval: 10 },
  );

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-11-12T10:00:00Z"));
  tmp = mkdtempSync(path.join(os.tmpdir(), "sp-restart-"));
  dir = path.join(tmp, "state", "control");
  sock = path.join(tmp, "c.sock");
  project = path.join(tmp, "project");
  configDir = path.join(tmp, "claude");
  mkdirSync(project, { recursive: true });
  mkdirSync(path.join(configDir, "sessions"), { recursive: true });
  rx = new FakeReceiver();
  rx.url = "https://receiver.test";
  rx.passkey = await Passkey.create({ rpId: "receiver.test", origin: rx.url });
  rx.day = await DayKey.create();
  config = {
    name: "testbox",
    folders: [project],
    mode: "safe",
    receivers: [
      {
        url: rx.url,
        control: `${rx.url}/control`,
        rpId: "receiver.test",
        machine: rx.machine,
        token: rx.token,
        keys: [{ ...rx.passkey.key, added_at: new Date().toISOString() }],
        paired_at: new Date().toISOString(),
      },
    ],
  };
  receiver = config.receivers[0] as PairedReceiver;
  log = [];
  open = [];
  runs = [];
  claude = { ignoresFork: false, hooks: false };
});
afterEach(async () => {
  for (const d of open) await d.stop();
  vi.clearAllTimers();
  vi.useRealTimers();
  rmSync(tmp, { recursive: true, force: true });
});

describe.runIf(unix)("a run that has just ended, and a message after the restart", () => {
  it("the daemon's own turn: the reply to it is resumed in place, not answered in a copy", async () => {
    written(SID, 600_000);
    const first = await daemon();
    const one = await hand(first, "one");
    expect(await finalAck(one.id)).toMatchObject({ outcome: "delivered", mode: "resume", reply: "did it" });
    // The update's moment: the daemon holds nothing, so it is restarted.
    await stop(first);
    const ended = onFile().ended?.[cc(SID)] as string;
    expect(Date.parse(ended)).toBeGreaterThanOrEqual(Date.parse("2026-11-12T10:00:00Z"));
    expect(onFile()).toMatchObject({ mid_turn: {}, strays: {} });

    // The person answers half a minute later: the transcript was written 30 s ago.
    await vi.advanceTimersByTimeAsync(30_000);
    const second = await daemon();
    expect(log).toContain(
      "taken up from the daemon before this one: 0 session(s) mid-turn, 1 run(s) just ended, 0 copy run(s) that may have strayed",
    );
    // Taken up, and no longer on file: it was true of that stop.
    expect(onFile().ended).toBeUndefined();
    const two = await hand(second, "two");
    const ack = await finalAck(two.id);
    expect(ack).toMatchObject({ outcome: "delivered", mode: "resume", reply: "did it" });
    expect(ack.session).toBeUndefined();
    expect(ack.copy_of).toBeUndefined();
    expect(ran()).toEqual([`resume ${SID}`, `resume ${SID}`]);
    expect(onFile().copies_v2).toEqual({});
  });

  it("a session whose own hooks reported its end five seconds before: resumed in place", async () => {
    const first = await daemon();
    // A headless run someone started at a terminal: its last row, and its SessionEnd.
    written(SID);
    await event(cc(SID), "SessionEnd");
    await vi.advanceTimersByTimeAsync(5000);
    await stop(first);
    expect(Object.keys(onFile().ended ?? {})).toEqual([cc(SID)]);

    const second = await daemon();
    const q = await hand(second, "after it closed");
    const ack = await finalAck(q.id);
    expect(ack).toMatchObject({ outcome: "delivered", mode: "resume" });
    expect(ack.copy_of).toBeUndefined();
    expect(ran()).toEqual([`resume ${SID}`]);
    expect(onFile().copies_v2).toEqual({});
  });

  it("restarted twice inside the 90 seconds: the end is still known, as when it was heard", async () => {
    const first = await daemon();
    written(SID);
    await event(cc(SID), "SessionEnd");
    await stop(first);
    const ended = onFile().ended;
    await vi.advanceTimersByTimeAsync(20_000);
    await stop(await daemon());
    expect(onFile().ended).toEqual(ended);
    await vi.advanceTimersByTimeAsync(20_000);
    const third = await daemon();
    const q = await hand(third, "after two restarts");
    expect(await finalAck(q.id)).toMatchObject({ outcome: "delivered", mode: "resume" });
    expect(ran()).toEqual([`resume ${SID}`]);
  });

  describe("a run asked for a copy that ran as the original instead", () => {
    // A Claude Code that takes no notice of --fork-session runs in the session it was told
    // to copy, and its hooks report its Stop and SessionEnd under that session's id. They
    // are that run's, not the end of whatever held the session, so the session stays held
    // for 90 seconds after it (control-holds.test.ts). The SessionEnd is remembered across
    // a restart now, and by itself it would account for what that run wrote: the stray is
    // remembered with it, or the restart would be what lets the session be resumed.
    async function strayed(): Promise<void> {
      // Held by nothing but a write five seconds old: no registry row names it.
      written(SID, 5000);
      const first = await daemon();
      claude = { ignoresFork: true, hooks: true };
      const one = await hand(first, "one");
      const ack = await finalAck(one.id);
      expect(ack).toMatchObject({ outcome: "delivered", mode: "fork" });
      expect(ack.copy_of).toBeUndefined();
      await stop(first);
      expect(Object.keys(onFile().strays ?? {})).toEqual([cc(SID)]);
      expect(Object.keys(onFile().ended ?? {})).toEqual([cc(SID)]);
      claude = { ignoresFork: false, hooks: true };
    }

    it("the next message, after a restart, is not resumed in place: it is copied, as without one", async () => {
      await strayed();
      await vi.advanceTimersByTimeAsync(30_000);
      const second = await daemon();
      expect(log).toContain(
        "taken up from the daemon before this one: 0 session(s) mid-turn, 1 run(s) just ended, 1 copy run(s) that may have strayed",
      );
      const two = await hand(second, "two");
      expect(await finalAck(two.id)).toMatchObject({
        outcome: "delivered",
        mode: "fork",
        session: cc(COPY),
        copy_of: cc(SID),
      });
      expect(ran()).toEqual([`fork ${SID}`, `fork ${SID}`]);
      expect(onFile().copies_v2?.[SID]).toMatchObject({ id: COPY, why: "recent" });
    });

    it("and for no longer than the 90 seconds: after them it is resumed", async () => {
      await strayed();
      await vi.advanceTimersByTimeAsync(30_000);
      const second = await daemon();
      await vi.advanceTimersByTimeAsync(61_000);
      const two = await hand(second, "two");
      const ack = await finalAck(two.id);
      expect(ack).toMatchObject({ outcome: "delivered", mode: "resume" });
      expect(ack.copy_of).toBeUndefined();
      expect(ran()).toEqual([`fork ${SID}`, `resume ${SID}`]);
    });
  });

  it("an end and a stray older than the 90 seconds are not written, and nothing to say writes nothing", async () => {
    written(SID, 5000);
    const first = await daemon();
    claude = { ignoresFork: true, hooks: false };
    const one = await hand(first, "one");
    expect(await finalAck(one.id)).toMatchObject({ outcome: "delivered", mode: "fork" });
    await event(cc(SID), "SessionEnd");
    await vi.advanceTimersByTimeAsync(91_000);
    await stop(first);
    expect(existsSync(stateFile())).toBe(false);
    // An end heard a moment before the stop is written, by itself.
    const second = await daemon();
    await event(cc(SID), "SessionEnd");
    const heard = iso(Date.now());
    await stop(second);
    expect(onFile()).toMatchObject({ mid_turn: {}, ended: { [cc(SID)]: heard }, strays: {} });
  });
});

describe.runIf(unix)("a session mid-turn in its own window, and a message after the restart", () => {
  const LAPSED = `${cc(SID).slice(0, 24)} was mid-turn before this daemon started and has said nothing for ten minutes: it is not taken to be mid-turn any more`;
  /** The session begins a turn, the daemon is restarted a minute into it, and a message
   *  for the session arrives: it waits for the turn's Stop. `heard`: when the session's
   *  hooks last said anything to the daemon that stopped. */
  async function restartedMidTurn(): Promise<{ d: ControlDaemon; q: Queued; heard: number }> {
    written(SID, 10 * MINUTE);
    const first = await daemon();
    await event(cc(SID), "UserPromptSubmit");
    const heard = Date.now();
    await vi.advanceTimersByTimeAsync(MINUTE);
    await stop(first);
    expect(onFile().mid_turn).toEqual({ [cc(SID)]: { at: iso(heard) } });
    const d = await daemon();
    expect(d.status().mid_turn).toEqual([cc(SID)]);
    const q = await hand(d, "while you are at it");
    await taken(q.id);
    return { d, q, heard };
  }

  it("its Stop comes after the restart: the message is handed over there, and nothing is run", async () => {
    const { d, q } = await restartedMidTurn();
    const r = await stopHook(cc(SID));
    expect(r).toMatchObject({ op: "block", id: q.id });
    expect(String((r as { reason: string }).reason)).toContain("while you are at it");
    expect(runs).toEqual([]);
    // The turn goes on with the message under this daemon's eyes: it is mid-turn by
    // what this daemon saw, however long it says nothing.
    await vi.advanceTimersByTimeAsync(11 * MINUTE);
    expect(d.status().mid_turn).toEqual([cc(SID)]);
    expect(log).not.toContain(LAPSED);
  });

  it("its Stop came while no daemon listened: the message waits out the ten minutes since the session was last heard from, then goes as for a session that is not mid-turn", async () => {
    // (The turn ended between the two daemons: its Stop hook found no socket.)
    const { d, q, heard } = await restartedMidTurn();
    await vi.advanceTimersByTimeAsync(heard + HOOKS_WORD_MS - Date.now() - 1000);
    expect(acksOf(q.id)).toEqual(["taken"]);
    expect(runs).toEqual([]);
    expect(d.status().mid_turn).toEqual([cc(SID)]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(log).toContain(LAPSED);
    expect(d.status().mid_turn).toEqual([]);
    expect(await finalAck(q.id)).toMatchObject({ outcome: "delivered", mode: "resume", reply: "did it" });
    expect(ran()).toEqual([`resume ${SID}`]);
  });

  it("heard from meanwhile: the ten minutes count from then", async () => {
    const { q, heard } = await restartedMidTurn();
    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    await event(cc(SID), "PostToolUse");
    const again = Date.now();
    // Ten minutes after the last word the stopped daemon heard: the message waits on.
    await vi.advanceTimersByTimeAsync(heard + HOOKS_WORD_MS - Date.now() + 1000);
    expect(acksOf(q.id)).toEqual(["taken"]);
    expect(log).not.toContain(LAPSED);
    await vi.advanceTimersByTimeAsync(again + HOOKS_WORD_MS - Date.now() - 1000);
    expect(acksOf(q.id)).toEqual(["taken"]);
    expect(runs).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(log).toContain(LAPSED);
    expect(await finalAck(q.id)).toMatchObject({ outcome: "delivered", mode: "resume" });
  });

  it("a turn of its own begun under this daemon: it is that turn's Stop the message waits for, as any message does", async () => {
    const { d, q } = await restartedMidTurn();
    // The Stop was missed and the person typed again.
    await event(cc(SID), "UserPromptSubmit");
    await vi.advanceTimersByTimeAsync(11 * MINUTE);
    expect(log).not.toContain(LAPSED);
    expect(acksOf(q.id)).toEqual(["taken"]);
    expect(d.status().mid_turn).toEqual([cc(SID)]);
    expect(await stopHook(cc(SID))).toMatchObject({ op: "block", id: q.id });
    expect(runs).toEqual([]);
  });

  it("the clock is past the ten minutes before any timer is (a computer that slept): a message is not made to wait", async () => {
    written(SID, 10 * MINUTE);
    const first = await daemon();
    await event(cc(SID), "UserPromptSubmit");
    await stop(first);
    const second = await daemon();
    vi.setSystemTime(Date.now() + 11 * MINUTE);
    expect(log).not.toContain(LAPSED);
    const q = await hand(second, "after the sleep");
    expect(await finalAck(q.id)).toMatchObject({ outcome: "delivered", mode: "resume" });
    expect(ran()).toEqual([`resume ${SID}`]);
  });

  it("a daemon that stopped before the ten minutes were out lets go of nothing afterwards", async () => {
    const first = await daemon();
    await event(cc(SID), "UserPromptSubmit");
    await stop(first);
    const second = await daemon();
    await stop(second);
    await vi.advanceTimersByTimeAsync(11 * MINUTE);
    expect(second.status().mid_turn).toEqual([cc(SID)]);
    expect(log).not.toContain(LAPSED);
  });

  it("a daemon that dies without a stop does not hand the last stop's words to the next start", async () => {
    written(SID, 10 * MINUTE);
    const first = await daemon();
    await event(cc(SID), "UserPromptSubmit");
    await stop(first);
    expect(Object.keys(onFile().mid_turn ?? {})).toEqual([cc(SID)]);
    // The next daemon takes it up, hears the turn end, and is killed: no stop of its own.
    const killed = await daemon();
    expect(onFile().mid_turn).toEqual({});
    await event(cc(SID), "Stop");
    // (Its socket stays behind in this process, so the one after it listens elsewhere.)
    const third = await daemon(path.join(tmp, "next.sock"));
    expect(killed.status().mid_turn).toEqual([]);
    expect(third.status().mid_turn).toEqual([]);
    const q = await hand(third, "after the crash");
    expect(await finalAck(q.id)).toMatchObject({ outcome: "delivered", mode: "resume" });
  });
});

describe.runIf(unix)("what the last daemon left is taken up by the daemon that has the socket", () => {
  it("one that finds another already answering takes nothing, and writes nothing as it goes", async () => {
    const serving = await daemon();
    // What a stop would leave, on file while that daemon serves the machine.
    const at = iso(Date.now());
    const left = JSON.stringify({ mid_turn: { [cc(SID)]: { at } }, ended: { [cc(COPY)]: at } });
    writeFileSync(stateFile(), left);
    // A second `control run`: it is constructed, finds the socket answered, and exits.
    const late = new ControlDaemon(config, dir, sock, {
      now: Date.now,
      fetch: http,
      log: (l) => log.push(l),
      claudeDirs: () => [configDir],
      claude: () => null,
      run,
    });
    await expect(late.start()).rejects.toBeInstanceOf(DaemonRunning);
    expect(late.status().mid_turn).toEqual([]);
    await late.stop();
    expect(readFileSync(stateFile(), "utf8")).toBe(left);
    expect(serving.status().mid_turn).toEqual([]);
  });
});
