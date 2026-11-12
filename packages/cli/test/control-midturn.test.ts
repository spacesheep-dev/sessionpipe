// SPDX-License-Identifier: Apache-2.0
// A restart of the daemon is held back only by what the daemon itself holds. A session
// someone is working in, mid-turn in its own window, is not waited for: that it is
// mid-turn is written down at a stop and read back at the next start. (What a message
// sent after the restart then does is control-restart.test.ts.)
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlDaemon, type DaemonDeps } from "../src/control/daemon.js";
import { ask } from "../src/control/local.js";
import { HOOKS_WORD_MS } from "../src/control/route.js";
import { readState } from "../src/control/store.js";

const A = "claude-code:11111111-2222-4333-8444-555555555555";
const B = "claude-code:66666666-7777-4888-8999-aaaaaaaaaaaa";
const unix = process.platform !== "win32"; // the daemon's socket is a Unix socket here
let tmp: string;
let dir: string;
let sock: string;
let clock: number;
let open: ControlDaemon[];

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "sp-mid-"));
  dir = path.join(tmp, "state", "control");
  sock = path.join(tmp, "c.sock");
  clock = Date.parse("2026-11-12T10:00:00.000Z");
  open = [];
});
afterEach(async () => {
  for (const d of open) await d.stop();
  rmSync(tmp, { recursive: true, force: true });
});

function daemon(over: Partial<DaemonDeps> = {}): ControlDaemon {
  const d = new ControlDaemon({ name: "lab", folders: [], mode: "safe", receivers: [] }, dir, sock, {
    now: () => clock,
    fetch,
    log: () => {},
    claudeDirs: () => [],
    claude: () => null,
    run: (async () => {
      throw new Error("no run in this test");
    }) as DaemonDeps["run"],
    sdk: null,
    ...over,
  });
  open.push(d);
  return d;
}
const event = (session: string, name: string, more: Record<string, string> = {}) =>
  ask(sock, { op: "event", session, event: name, ...more }, 2000);
const onFile = () => JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8")) as { mid_turn?: unknown };

describe.runIf(unix)("a session mid-turn in someone's own window", () => {
  it("is known, and doesn't hold a restart back", async () => {
    const d = daemon();
    await d.start();
    expect((await event(A, "UserPromptSubmit"))?.op).toBe("ok");
    expect(d.status().mid_turn).toEqual([A]);
    expect(d.busy()).toBeNull();
    expect(d.status().busy).toBeNull();
  });

  it("is still mid-turn for the daemon that starts after a stop, with where it runs", async () => {
    const first = daemon();
    await first.start();
    await event(A, "UserPromptSubmit", { cwd: "/work/a", transcript: "/t/a.jsonl" });
    await event(B, "UserPromptSubmit");
    await event(B, "Stop");
    clock += 30_000;
    await first.stop();
    expect(onFile().mid_turn).toEqual({
      [A]: { at: "2026-11-12T10:00:00.000Z", cwd: "/work/a", transcript: "/t/a.jsonl" },
    });

    clock += 5_000;
    const second = daemon();
    await second.start();
    expect(second.status().mid_turn).toEqual([A]);
    // Its Stop ends it, as if the daemon had never been away.
    await event(A, "Stop");
    expect(second.status().mid_turn).toEqual([]);
    await second.stop();
    // And what the file said is taken back.
    expect(onFile().mid_turn).toEqual({});
  });

  it("a session with nothing to say about where it runs is remembered by its time alone", async () => {
    const first = daemon();
    await first.start();
    await event(B, "UserPromptSubmit");
    await first.stop();
    expect(onFile().mid_turn).toEqual({ [B]: { at: "2026-11-12T10:00:00.000Z" } });
    const second = daemon();
    await second.start();
    expect(second.status().mid_turn).toEqual([B]);
  });

  it("silent for longer than its hooks' word is good for: not written, and not read back", async () => {
    const first = daemon();
    await first.start();
    await event(A, "UserPromptSubmit");
    clock += HOOKS_WORD_MS;
    await first.stop();
    expect(existsSync(path.join(dir, "state.json"))).toBe(false);

    // Written a moment before the word ran out, read after it had.
    const at = new Date(clock).toISOString();
    writeFileSync(path.join(dir, "state.json"), JSON.stringify({ mid_turn: { [A]: { at } } }));
    expect(readState(path.join(dir, "state.json"), clock + HOOKS_WORD_MS - 1).mid_turn).toEqual({ [A]: { at } });
    expect(readState(path.join(dir, "state.json"), clock + HOOKS_WORD_MS).mid_turn).toEqual({});
  });

  it("a daemon that only steps aside for another writes nothing", async () => {
    const d = daemon();
    await d.start();
    await event(A, "UserPromptSubmit");
    await d.stop({ leaveSocket: true });
    expect(existsSync(path.join(dir, "state.json"))).toBe(false);
  });
});

describe("state.json's `mid_turn`, read defensively", () => {
  it("a file that says something else than sessions and times is read as nothing", () => {
    const file = path.join(tmp, "state.json");
    const at = new Date(clock).toISOString();
    writeFileSync(
      file,
      JSON.stringify({
        mid_turn: { a: null, b: "x", c: { at: 5 }, d: { at: "not a time" }, e: { at, cwd: 7, transcript: [] } },
      }),
    );
    expect(readState(file, clock).mid_turn).toEqual({ e: { at } });
    writeFileSync(file, JSON.stringify({ mid_turn: "nope" }));
    expect(readState(file, clock).mid_turn).toEqual({});
  });
});

describe.runIf(unix)("what the daemon says of itself to doctor and update", () => {
  it("names the copy it runs and who restarts it, where it knows", async () => {
    const d = daemon({ copy: () => ({ cli: "/p/lib/node_modules/sessionpipe/dist/cli.js", via: "launchd" }) });
    await d.start();
    expect(await ask(sock, { op: "health" }, 2000)).toEqual({
      op: "health",
      health: { accounts: [], copy: { cli: "/p/lib/node_modules/sessionpipe/dist/cli.js", via: "launchd" } },
    });
  });
});
