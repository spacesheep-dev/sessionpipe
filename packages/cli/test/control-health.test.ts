// SPDX-License-Identifier: Apache-2.0
// control/health.ts and control/view.ts: what doctor finds out about the background
// service, and `control status` as a terminal shows it. Whose service it is, and the
// look at launchd and systemd, are in control-service-world.test.ts, where nothing can
// reach a real service manager.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Status } from "../src/control/daemon.js";
import { askHealth, freeBytes, logTroubles, serviceLog, tailOf } from "../src/control/health.js";
import { heardAgo, hostOf, isLive, statusView } from "../src/control/view.js";
import { makeUi, PLAIN, plain } from "../src/style.js";

// Nothing here starts a real launchctl, systemctl or journalctl: where the code would
// run one with nothing stood in, this is what it gets.
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFileSync: vi.fn(),
}));

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "sp-health-"));
  vi.mocked(execFileSync).mockReset();
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// A Unix socket in a temp folder: where there is one (the repo's other socket tests are
// skipped on Windows the same way).
describe.runIf(process.platform !== "win32")("what the service sees", () => {
  const serve = (answer: (req: { op: string }) => string | null): Promise<{ sock: string; close: () => void }> =>
    new Promise((resolve) => {
      const sock = path.join(tmp, "s.sock");
      const server = net.createServer((c) => {
        c.on("data", (d) => {
          const a = answer(JSON.parse(String(d)) as { op: string });
          if (a === null) c.destroy();
          else c.end(`${a}\n`);
        });
      });
      server.listen(sock, () => resolve({ sock, close: () => server.close() }));
    });

  it("is its answer to `health`", async () => {
    const health = { accounts: [{ dir: "/h/.claude", signed_in: true }] };
    const s = await serve((req) => (req.op === "health" ? JSON.stringify({ op: "health", health }) : null));
    expect(await askHealth(s.sock, 2000)).toEqual(health);
    s.close();
  });

  it("is null from a service too old to know the question, or from none", async () => {
    const old = await serve(() => null);
    expect(await askHealth(old.sock, 2000)).toBeNull();
    old.close();
    const other = await serve(() => JSON.stringify({ op: "none" }));
    expect(await askHealth(other.sock, 2000)).toBeNull();
    other.close();
    expect(await askHealth(path.join(tmp, "nobody.sock"))).toBeNull();
  });
});

describe("trouble only the log knew", () => {
  const now = Date.parse("2026-11-12T10:00:00.000Z");
  const at = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();

  it("finds a full disk and a pool with no account to try, counted, with when it last happened", () => {
    const log = [
      `${at(50)} request failed: ENOSPC: no space left on device, write`,
      `${at(40)} no account could be tried (session 1234abcd)`,
      `${at(30)} pool state not saved: No space left on device`,
      `${at(5)} no account could be tried (session 99aa)`,
      `${at(4)} https://r.example: back after 12 s (1 failed tries)`,
      "not a dated line at all",
      "",
    ].join("\n");
    expect(logTroubles(log, now)).toEqual([
      { kind: "disk", times: 2, last: now - 30 * 60_000 },
      { kind: "pool", times: 2, last: now - 5 * 60_000 },
    ]);
  });

  it("looks only at the last hour, and only at the service that is running now", () => {
    expect(logTroubles(`${at(61)} ENOSPC: no space left on device`, now)).toEqual([]);
    const log = [
      `${at(20)} ENOSPC: no space left on device`,
      `${at(10)} control daemon 0.14.2 up · pid 42 · 1 receiver(s) · socket /x`,
      `${at(9)} no account could be tried (session 1)`,
    ].join("\n");
    expect(logTroubles(log, now)).toEqual([{ kind: "pool", times: 1, last: now - 9 * 60_000 }]);
    expect(logTroubles("", now)).toEqual([]);
  });
});

describe("reading the log", () => {
  it("takes the end of a file, and nothing from one that isn't there", () => {
    const f = path.join(tmp, "daemon.log");
    writeFileSync(f, "0123456789");
    expect(tailOf(f)).toBe("0123456789");
    expect(tailOf(f, 4)).toBe("6789");
    expect(tailOf(path.join(tmp, "none.log"))).toBe("");
  });

  it("is the file launchd writes; under systemd, what journald kept for the unit", () => {
    const env = { SESSIONPIPE_STATE: tmp, SESSIONPIPE_SERVICE_LABEL: "org.sessionpipe.racetest" };
    const asked: string[][] = [];
    const journal = (cmd: string, args: string[]) => {
      asked.push([cmd, ...args]);
      return "from the journal\n";
    };
    expect(serviceLog({ env, platform: "linux", exec: journal })).toBe("from the journal\n");
    expect(asked[0]?.slice(0, 4)).toEqual(["journalctl", "--user", "-u", "org.sessionpipe.racetest.service"]);
    expect(
      serviceLog({
        env,
        platform: "linux",
        exec: () => {
          throw new Error("no journal");
        },
      }),
    ).toBe("");
    // Nothing to ask on a Mac, nor in a world with no service of its own.
    expect(serviceLog({ env, platform: "darwin", exec: journal })).toBe("");
    expect(serviceLog({ env: { SESSIONPIPE_STATE: tmp }, platform: "linux", exec: journal })).toBe("");
    mkdirSync(path.join(tmp, "control"), { recursive: true });
    writeFileSync(path.join(tmp, "control", "daemon.log"), "from the file\n");
    expect(serviceLog({ env, platform: "linux", exec: journal })).toBe("from the file\n");
    expect(asked).toHaveLength(1);
    expect(serviceLog({ env: { SESSIONPIPE_STATE: path.join(tmp, "empty") } })).toBe("");
    expect(serviceLog()).toBe("");
    // None of that started a program of its own.
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("with nothing stood in it asks journalctl itself: the last hour, quietly, for five seconds at most", () => {
    const empty = { SESSIONPIPE_STATE: path.join(tmp, "empty"), SESSIONPIPE_SERVICE_LABEL: "org.sessionpipe.racetest" };
    vi.mocked(execFileSync).mockReturnValueOnce("what journald kept\n");
    expect(serviceLog({ env: empty, platform: "linux" })).toBe("what journald kept\n");
    expect(vi.mocked(execFileSync).mock.calls).toEqual([
      [
        "journalctl",
        ["--user", "-u", "org.sessionpipe.racetest.service", "--since", "-1h", "-o", "cat", "--no-pager"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 },
      ],
    ]);
    // No journalctl on this computer, or one that fails: nothing to read, and no throw.
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("spawnSync journalctl ENOENT"), { code: "ENOENT" });
    });
    expect(serviceLog({ env: empty, platform: "linux" })).toBe("");
    expect(execFileSync).toHaveBeenCalledTimes(2);
  });
});

describe("room on the disk", () => {
  it("is what the system says is free, asked of the nearest folder that exists", () => {
    expect(freeBytes(tmp)).toBeGreaterThan(0);
    expect(freeBytes(path.join(tmp, "not", "there", "yet"))).toBeGreaterThan(0);
    const asked: string[] = [];
    const fake = ((d: string) => {
      asked.push(d);
      if (d !== path.parse(d).root && asked.length < 2) throw new Error("ENOENT");
      return { bavail: 10n, bsize: 4096n };
    }) as unknown as typeof import("node:fs").statfsSync;
    expect(freeBytes(path.join(tmp, "a"), fake)).toBe(40960);
    expect(asked).toEqual([path.join(tmp, "a"), tmp]);
  });

  it("is null when the system won't say", () => {
    const never = (() => {
      throw new Error("no");
    }) as unknown as typeof import("node:fs").statfsSync;
    expect(freeBytes(tmp, never)).toBeNull();
  });
});

describe("control status, as a terminal shows it", () => {
  const now = Date.parse("2026-11-12T10:00:00.000Z");
  const base: Status = {
    version: "1.2.3",
    pid: 4242,
    name: "lab-box",
    receivers: [
      {
        url: "https://r.example",
        machine: "m_1",
        keys: 2,
        polling: true,
        last_poll: now - 12_000,
        last_poll_age_ms: 12_000,
        last_error: null,
      },
    ],
    waiting: ["claude-code:a"],
    mid_turn: ["claude-code:b", "codex:c"],
    attentions: [{ session: "claude-code:b", id: "x" }],
    sdk: [],
    nonces: 3,
    acks_pending: 0,
    delivered: {},
    start: { "claude-code": {}, codex: {} } as unknown as Status["start"],
    ask: { on: true, harnesses: ["claude-code", "codex"] },
    busy: null,
  };

  it("says it is running, who it hears, what it holds and what it can do", () => {
    expect(statusView(PLAIN, base, now)).toEqual([
      "✓ The background service is running",
      "  sessionpipe 1.2.3 · pid 4242 · lab-box",
      "",
      "Messages from",
      "  ✓ r.example  live · heard 12 s ago · 2 keys trusted",
      "",
      "Right now",
      "  · in hand   nothing: it could restart at any moment",
      "  · sessions  2 mid-turn · 1 waiting for a message · 1 question held",
      "",
      "It can",
      "  · start a session in     claude-code, codex",
      "  · let agents ask agents  yes: claude-code, codex",
      "",
      "  Every field: sessionpipe control status --json",
    ]);
  });

  it("fits 80 columns", () => {
    const u = makeUi({ isTTY: true, columns: 80, env: {}, platform: "darwin" });
    for (const l of statusView(u, base, now)) expect(plain(l).length).toBeLessThan(80);
  });

  it("says what is wrong with a receiver it doesn't hear", () => {
    const view = (r: Partial<Status["receivers"][number]>) =>
      statusView(
        PLAIN,
        { ...base, receivers: [{ ...(base.receivers[0] as Status["receivers"][number]), ...r }] },
        now,
      )[4];
    expect(view({ last_poll: null, last_poll_age_ms: 3000 })).toBe(
      "  ✓ r.example  live · just connected · 1 key trusted".replace("1 key", "2 keys"),
    );
    expect(view({ keys: 1 })).toContain("1 key trusted");
    // A long-poll answers within seconds of the last: under five, it was heard just now.
    expect(view({ last_poll_age_ms: 4999 })).toBe("  ✓ r.example  live · heard just now · 2 keys trusted");
    expect(view({ last_poll_age_ms: 5000 })).toBe("  ✓ r.example  live · heard 5 s ago · 2 keys trusted");
    expect(view({ last_poll_age_ms: 20 * 60_000, last_error: "fetch failed" })).toBe(
      "  ✗ r.example  not live for 20 min: fetch failed",
    );
    expect(view({ last_poll_age_ms: 90_000 })).toBe("  ✗ r.example  not live for 2 min: no answer yet");
    expect(view({ polling: false, last_poll_age_ms: 90_000 })).toBe(
      "  ✗ r.example  not live for 2 min: it stopped asking",
    );
  });

  it("with no receiver, nothing in hand to say and everything else it may hold", () => {
    const lines = statusView(
      PLAIN,
      {
        ...base,
        receivers: [],
        busy: "a headless agent run",
        sdk: ["s1"],
        acks_pending: 2,
        start: {},
        ask: { on: false, harnesses: [] },
        pool: { on: true, port: 4141, listening: true, accounts: 3, with_room: 2, in_flight: 0 },
        update: {
          checked_at: new Date(now - 3 * 3600_000).toISOString(),
          latest: "1.2.3",
          pending: "1.3.0",
          failed: { version: "1.3.0", at: new Date(now - 3600_000).toISOString(), error: "npm install: EACCES" },
        },
      },
      now,
    ).join("\n");
    expect(lines).toContain("  · nobody  this computer takes no messages");
    expect(lines).toContain("  · in hand    a headless agent run");
    expect(lines).toContain("  · kept open  1 session");
    expect(lines).toContain("  · to send    2 answers");
    expect(lines).toContain("  · start a session in     no agent on this computer");
    expect(lines).toContain("  · let agents ask agents  no (`sessionpipe ask on`)");
    expect(lines).toContain("  · pool Claude accounts   on · 3 accounts, 2 with room left · 127.0.0.1:4141");
    expect(lines).toContain("  ✓ automatic  checked 3 h ago: 1.2.3 is the newest");
    expect(lines).toContain("  · waiting    1.3.0, until nothing is in hand");
    expect(lines).toContain("  ! failed     installing 1.3.0 60 min ago: npm install: EACCES");
  });

  it("the pool's other states, and the update's", () => {
    const pool = (p: Partial<NonNullable<Status["pool"]>>, ask = base.ask) =>
      statusView(
        PLAIN,
        {
          ...base,
          ask,
          pool: { on: true, port: 4141, listening: false, accounts: 1, with_room: 0, in_flight: 0, ...p },
        },
        now,
      ).find((l) => l.includes("pool Claude accounts"));
    expect(pool({})).toBe("  ✗ pool Claude accounts   on · 1 account, 0 with room left · its listener is not up");
    expect(pool({ another_daemon: true })).toContain("· another service answers for it");
    expect(pool({ on: false })).toBe("  · pool Claude accounts   off · 1 account");
    // On with no account yet it is still said; a pool nobody set up is not.
    expect(pool({ accounts: 0, listening: true })).toBe(
      "  · pool Claude accounts   on · 0 accounts, 0 with room left · 127.0.0.1:4141",
    );
    expect(pool({ on: false, accounts: 0 })).toBeUndefined();
    // Asking is on and no agent that can be asked is installed: said as that.
    expect(
      statusView(PLAIN, { ...base, ask: { on: true, harnesses: [] } }, now).find((l) =>
        l.includes("let agents ask agents"),
      ),
    ).toBe("  · let agents ask agents  yes: none installed");
    const upd = (update: unknown) => statusView(PLAIN, { ...base, update }, now).join("\n");
    expect(upd({ off: "SESSIONPIPE_NO_UPDATE_CHECK is set" })).toContain(
      "  · by hand  SESSIONPIPE_NO_UPDATE_CHECK is set",
    );
    expect(upd({})).toContain("  ✓ automatic  once a day; not checked yet");
    expect(upd({ checked_at: new Date(now - 60_000).toISOString(), error: "HTTP 503" })).toContain(
      "the check just now failed: HTTP 503",
    );
    expect(upd({ checked_at: new Date(now - 60_000).toISOString() })).toContain("checked just now: ? is the newest");
    expect(upd(null)).not.toContain("Updates");
  });
});

describe("how long ago a receiver was heard", () => {
  it("just now under five seconds, then in the unit a person reads", () => {
    expect(heardAgo(0)).toBe("just now");
    expect(heardAgo(4999)).toBe("just now");
    expect(heardAgo(5000)).toBe("5 s ago");
    expect(heardAgo(12_000)).toBe("12 s ago");
    expect(heardAgo(20 * 60_000)).toBe("20 min ago");
  });
});

describe("hostOf and isLive", () => {
  it("a URL's host, or the word itself", () => {
    expect(hostOf("https://r.example:8443/x")).toBe("r.example:8443");
    expect(hostOf("stdout")).toBe("stdout");
    expect(hostOf("file:/tmp/x")).toBe("file:/tmp/x");
  });

  it("live while it asks and was heard within the minute, or has only just begun", () => {
    expect(isLive({ polling: true, last_poll_age_ms: 59_000 })).toBe(true);
    expect(isLive({ polling: true, last_poll_age_ms: null })).toBe(true);
    expect(isLive({ polling: true, last_poll_age_ms: 60_000 })).toBe(false);
    expect(isLive({ polling: false, last_poll_age_ms: 1000 })).toBe(false);
  });
});
