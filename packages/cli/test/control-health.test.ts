// SPDX-License-Identifier: Apache-2.0
// control/health.ts and control/view.ts: what doctor finds out about the background
// service, and `control status` as a terminal shows it.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Status } from "../src/control/daemon.js";
import {
  askHealth,
  freeBytes,
  logTroubles,
  SERVICE_LABEL,
  SERVICE_UNIT,
  serviceLog,
  serviceLook,
  serviceNames,
  tailOf,
} from "../src/control/health.js";
import { heardAgo, hostOf, isLive, statusView } from "../src/control/view.js";
import { makeUi, PLAIN, plain } from "../src/style.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "sp-health-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("the service's names", () => {
  it("are this computer's own, unless sessionpipe is pointed away from its files", () => {
    expect(serviceNames({})).toEqual({ label: SERVICE_LABEL, unit: SERVICE_UNIT });
    expect(serviceNames({ SESSIONPIPE_STATE: "/tmp/x" })).toBeNull();
    expect(serviceNames({ SESSIONPIPE_CONFIG: "/tmp/x/config.json" })).toBeNull();
    // The test's own sandbox sets both.
    expect(serviceNames()).toBeNull();
  });

  it("a throwaway world may name a service of its own", () => {
    expect(
      serviceNames({ SESSIONPIPE_STATE: "/tmp/x", SESSIONPIPE_SERVICE_LABEL: "org.sessionpipe.racetest" }),
    ).toEqual({
      label: "org.sessionpipe.racetest",
      unit: "org.sessionpipe.racetest.service",
    });
    expect(serviceNames({ SESSIONPIPE_SERVICE_LABEL: "no/slashes here" })).toBeNull();
  });
});

describe("a look at the service", () => {
  it("asks launchd, in both domains, and never changes anything", () => {
    const asked: string[] = [];
    const exec = (answers: Record<string, boolean>) => (cmd: string, args: string[]) => {
      asked.push([cmd, ...args].join(" "));
      if (!answers[args[1] as string]) throw new Error("not loaded");
      return "";
    };
    const o = { env: {}, platform: "darwin" as const, home: tmp };
    const plist = path.join(tmp, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
    expect(serviceLook({ ...o, exec: exec({}) })).toEqual({
      manager: "launchd",
      file: plist,
      installed: false,
      loaded: false,
    });
    expect(asked.every((a) => a.startsWith("launchctl print "))).toBe(true);
    expect(asked.map((a) => a.split(" ")[2]?.split("/")[0])).toEqual(["gui", "user"]);
    mkdirSync(path.dirname(plist), { recursive: true });
    writeFileSync(plist, "");
    const uid = String(process.getuid?.() ?? "");
    expect(serviceLook({ ...o, exec: exec({ [`user/${uid}/${SERVICE_LABEL}`]: true }) })).toMatchObject({
      installed: true,
      loaded: true,
    });
    expect(serviceLook({ ...o, exec: exec({ [`gui/${uid}/${SERVICE_LABEL}`]: true }) })?.loaded).toBe(true);
  });

  it("asks systemd whether the unit is active", () => {
    const o = { env: {}, platform: "linux" as const, home: tmp };
    expect(serviceLook({ ...o, exec: () => "active\n" })).toEqual({
      manager: "systemd",
      file: path.join(tmp, ".config", "systemd", "user", SERVICE_UNIT),
      installed: false,
      loaded: true,
    });
    expect(
      serviceLook({
        ...o,
        exec: () => {
          throw new Error("inactive");
        },
      })?.loaded,
    ).toBe(false);
  });

  it("is null where there is no manager, and in a throwaway world", () => {
    expect(serviceLook({ env: {}, platform: "win32" })).toBeNull();
    expect(serviceLook({ env: { SESSIONPIPE_STATE: tmp }, platform: "darwin" })).toBeNull();
    // Its own environment: the test's sandbox.
    expect(serviceLook()).toBeNull();
    // A world with a service of its own, on whatever this platform is: asked, never changed.
    const asked: string[] = [];
    const look = serviceLook({
      env: { SESSIONPIPE_STATE: tmp, SESSIONPIPE_SERVICE_LABEL: "org.sessionpipe.racetest" },
      exec: (cmd, args) => {
        asked.push([cmd, ...args].join(" "));
        throw new Error("not loaded");
      },
    });
    expect(look?.loaded ?? false).toBe(false);
    for (const a of asked) expect(a).toMatch(/^(launchctl print |systemctl --user is-active )/);
  });
});

describe("what the service sees", () => {
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
    // With nothing stood in: the real journalctl, or none; never a throw.
    expect(typeof serviceLog({ env: { ...env, SESSIONPIPE_STATE: path.join(tmp, "empty") }, platform: "linux" })).toBe(
      "string",
    );
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
    expect(pool({}, { on: true, harnesses: [] })).toBeDefined();
    const upd = (update: unknown) => statusView(PLAIN, { ...base, update }, now).join("\n");
    expect(statusView(PLAIN, { ...base, ask: { on: true, harnesses: [] } }, now).join("\n")).toContain(
      "yes: none installed",
    );
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
