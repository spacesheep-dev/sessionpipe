// SPDX-License-Identifier: Apache-2.0
// current.ts: `sessionpipe update` as one step. Everything that touches the computer is
// stood in for, and time is a counter, so each way it can go is one test.
import type { ServiceState } from "@sessionpipe/core/service";
import { describe, expect, it } from "vitest";
import type { Status } from "../src/control/daemon.js";
import { bringCurrent, type CurrentDeps, holding, type Outcome, type Step } from "../src/current.js";
import type { InstallResult } from "../src/update.js";

const MINE = "/p/typed/lib/node_modules/sessionpipe/dist";
const THEIRS = "/p/svc/lib/node_modules/sessionpipe/dist";

const st = (version: string, o: Partial<Status> = {}): Status =>
  ({
    version,
    pid: 1,
    name: "lab",
    receivers: [
      {
        url: "https://r.example",
        machine: "m",
        keys: 1,
        polling: true,
        last_poll: 1,
        last_poll_age_ms: 5,
        last_error: null,
      },
    ],
    busy: null,
    ...o,
  }) as Status;

const service = (o: Partial<ServiceState> = {}): ServiceState => ({
  manager: "launchd",
  file: "/h/Library/LaunchAgents/x.plist",
  installed: true,
  loaded: true,
  argv: ["/usr/bin/node", `${MINE}/cli.js`, "control", "run"],
  pid: null,
  ...o,
});

/** A computer: what is installed where, what the service does when asked. */
interface Sim {
  latest: string | Error;
  version: string;
  hooks: string | null;
  /** What the service answers each time it is asked; the last one stands. */
  status: (Status | null)[];
  look: ServiceState | null;
  installs: [string, string[]][];
  /** The sessions left for the next service, each time they were; and what was done to
   *  the service, in order. */
  seeded: string[][];
  did: string[];
  placed: number;
  restarts: number;
  rearms: number;
  said: Step[];
  clock: number;
}

function run(
  sim: Partial<Sim>,
  over: Partial<CurrentDeps> = {},
  how?: { installed?: boolean },
): { sim: Sim; out: Promise<Outcome> } {
  const s: Sim = {
    latest: "1.1.0",
    version: "1.0.0",
    hooks: "1.0.0",
    status: [st("1.0.0")],
    look: service(),
    installs: [],
    seeded: [],
    did: [],
    placed: 0,
    restarts: 0,
    rearms: 0,
    said: [],
    clock: 0,
    ...sim,
  };
  const deps: CurrentDeps = {
    version: s.version,
    distDir: MINE,
    node: "/usr/bin/node",
    cli: `${MINE}/cli.js`,
    prefix: "/p/typed",
    unwritable: null,
    platform: "darwin",
    latest: async () => {
      if (s.latest instanceof Error) throw s.latest;
      return s.latest;
    },
    install: async (v, others): Promise<InstallResult> => {
      s.installs.push([v, others]);
      s.hooks = v;
      return { ok: true, ms: 1, hooks: "hooks re-armed", rearmed: true };
    },
    rearm: async () => {
      s.rearms++;
      return { ok: true, said: "hooks re-armed" };
    },
    hooks: () => s.hooks,
    harnesses: ["claude-code"],
    wanted: true,
    status: async () => (s.status.length > 1 ? (s.status.shift() as Status | null) : (s.status[0] ?? null)),
    // A service of this release: it says which copy it is, so it remembers across a stop.
    health: async () => ({ accounts: [], copy: { cli: `${MINE}/cli.js`, via: "launchd" as const } }),
    restart: async () => {
      s.restarts++;
      s.did.push("restart");
      return true;
    },
    look: () => s.look,
    apart: null,
    place: () => {
      s.placed++;
      s.did.push("place");
    },
    quiesce: async () => {
      s.did.push("quiesce");
      return true;
    },
    seed: (sessions) => {
      s.seeded.push(sessions);
      s.did.push("seed");
    },
    versionAt: () => "1.0.0",
    globalPrefix: (d) => d.replace("/lib/node_modules/sessionpipe/dist", ""),
    same: (a, b) => a === b,
    sleep: async (ms) => {
      s.clock += ms;
    },
    now: () => s.clock,
    say: (step) => s.said.push(step),
    ...over,
  };
  return { sim: s, out: how ? bringCurrent(deps, how) : bringCurrent(deps) };
}
const texts = (s: Sim): string[] => s.said.map((x) => `${x.mark}: ${x.text}`);

describe("holding", () => {
  it("is what the service says it holds, except someone's own session mid-turn", () => {
    expect(holding(st("1", { busy: null }))).toBeNull();
    expect(holding(st("1", { busy: "a headless agent run" }))).toBe("a headless agent run");
    // What a service before 0.15 called busy, and never was its to wait for.
    expect(holding(st("1", { busy: "a session on this machine mid-turn" }))).toBeNull();
  });
});

describe("the newest release, and this copy on it", () => {
  it("installs it, writes the hooks, restarts the service that runs this copy, and says so", async () => {
    const { sim, out } = run({ status: [st("1.0.0"), st("1.0.0"), st("1.1.0")] });
    expect(await out).toEqual({
      state: "current",
      version: "1.1.0",
      said: "This computer is up to date: sessionpipe 1.1.0 runs the command, the hooks and the background service, which hears r.example.",
    });
    expect(sim.installs).toEqual([["1.1.0", []]]);
    expect(sim.restarts).toBe(1);
    expect(sim.placed).toBe(0);
    expect(texts(sim)).toEqual([
      "info: installing sessionpipe 1.1.0 (this copy is 1.0.0)…",
      "ok: sessionpipe 1.1.0 installed (it was 1.0.0)",
      "ok: the hooks run sessionpipe 1.1.0 (claude-code)",
      "ok: the background service restarted onto sessionpipe 1.1.0",
    ]);
  });

  it("with nothing newer it changes nothing and says everything is current", async () => {
    const { sim, out } = run({ latest: "1.0.0" });
    expect((await out).state).toBe("current");
    expect(sim.installs).toEqual([]);
    expect(sim.rearms + sim.restarts + sim.placed).toBe(0);
    expect(texts(sim)).toEqual([
      "ok: sessionpipe 1.0.0 is the newest release",
      "ok: the hooks run sessionpipe 1.0.0 (claude-code)",
      "ok: the background service runs sessionpipe 1.0.0",
    ]);
  });

  it("a copy npm didn't install can't be updated by npm: one command gets a copy that can", async () => {
    const { sim, out } = run({}, { prefix: null });
    expect(await out).toEqual({
      state: "failed",
      error: `sessionpipe 1.1.0 is out and this copy is 1.0.0, but npm didn't install this copy (it runs from ${MINE}), so npm can't update it`,
      next: "npx sessionpipe@latest update",
    });
    expect(sim.installs).toEqual([]);
  });

  it("a prefix this user can't write: the one line that does it", async () => {
    const { out } = run(
      {},
      { unwritable: "/p/typed/lib/node_modules isn't writable by this user (installed with sudo?)" },
    );
    expect(await out).toMatchObject({
      state: "failed",
      next: "sudo npm install -g --prefix /p/typed sessionpipe@1.1.0 && sessionpipe update",
    });
    // A prefix with a space or a quote in it is one word of that line still.
    const spaced = run(
      {},
      { prefix: "/Users/it's me/my node", unwritable: "/Users/it's me/my node/lib/node_modules isn't writable" },
    );
    expect(((await spaced.out) as { next: string }).next).toBe(
      "sudo npm install -g --prefix '/Users/it'\\''s me/my node' sessionpipe@1.1.0 && sessionpipe update",
    );
  });

  it("on Windows there is no sudo: the same command, from a terminal that may write there", async () => {
    const { sim, out } = run(
      {},
      {
        platform: "win32",
        prefix: "C:\\Program Files\\nodejs",
        unwritable: "C:\\Program Files\\nodejs\\node_modules isn't writable by this user (installed as administrator?)",
      },
    );
    expect(await out).toEqual({
      state: "failed",
      error:
        "sessionpipe 1.1.0 is out and this copy is 1.0.0, but C:\\Program Files\\nodejs\\node_modules isn't writable by this user (installed as administrator?). Open a terminal as administrator and run this there",
      next: "sessionpipe update",
    });
    expect(sim.installs).toEqual([]);
  });

  it("npm failing leaves everything as it was", async () => {
    const { sim, out } = run(
      {},
      { install: async () => ({ ok: false, ms: 1, stage: "npm", error: "npm install: ETARGET" }) },
    );
    expect(await out).toEqual({
      state: "failed",
      // The way out when it keeps failing is named in the same sentence.
      error:
        "sessionpipe 1.1.0 couldn't be installed (npm install: ETARGET); this computer still runs 1.0.0. If it keeps failing, `npx -y sessionpipe@latest reinstall` installs a clean copy",
      next: "sessionpipe update",
    });
    expect(sim.restarts + sim.placed).toBe(0);
  });
});

describe("with npm out of reach", () => {
  it("still mends what needs no download, then says it couldn't check", async () => {
    const { sim, out } = run({
      latest: new Error("registry.npmjs.org can't be reached (ENOTFOUND)"),
      hooks: "0.9.0",
      status: [null, null, st("1.0.0")],
      look: service({ loaded: false }),
    });
    expect(await out).toEqual({
      state: "failed",
      error:
        "couldn't ask npm whether there is a newer release: registry.npmjs.org can't be reached (ENOTFOUND). Everything on this computer runs sessionpipe 1.0.0: the command, the hooks and the background service, which hears r.example",
      next: "sessionpipe update",
    });
    expect(sim.rearms).toBe(1);
    expect(sim.placed).toBe(1);
    expect(texts(sim)[0]).toBe(
      "warn: couldn't ask npm for the newest release: registry.npmjs.org can't be reached (ENOTFOUND)",
    );
  });

  it("never moves anything back: an older copy than what runs changes nothing", async () => {
    const offline = new Error("offline");
    for (const sim of [{ hooks: "1.2.0" }, { status: [st("1.2.0")] }]) {
      const r = run({ latest: offline, ...sim });
      expect(await r.out).toEqual({
        state: "failed",
        error:
          "this copy is sessionpipe 1.0.0, older than what already runs on this computer (1.2.0), and npm couldn't be asked for the newest release: offline. Nothing was changed",
        next: "sessionpipe update",
      });
      expect(r.sim.rearms + r.sim.placed + r.sim.restarts).toBe(0);
    }
  });

  it("nor back from a build newer than npm's latest: the command that gets that build", async () => {
    const theirs = service({ argv: ["/usr/bin/node", `${THEIRS}/cli.js`, "control", "run"] });
    const a = run({ latest: "1.0.0", look: theirs, status: [null] }, { versionAt: () => "1.3.0-beta.1" });
    expect(await a.out).toEqual({
      state: "failed",
      error:
        "sessionpipe 1.3.0-beta.1 already runs on this computer, newer than npm's latest (1.0.0); nothing was changed",
      next: "npm install -g --prefix /p/typed sessionpipe@1.3.0-beta.1",
    });
    const b = run({ latest: "1.0.0", hooks: "1.3.0" }, { prefix: null });
    expect(((await b.out) as { next: string }).next).toBe("sessionpipe update");
    // The prefix is one word of the command, quoted the way that system's shells read it.
    const c = run({ latest: "1.0.0", hooks: "1.3.0" }, { prefix: "C:\\Program Files\\nodejs", platform: "win32" });
    expect(((await c.out) as { next: string }).next).toBe(
      'npm install -g --prefix "C:\\Program Files\\nodejs" sessionpipe@1.3.0',
    );
  });
});

describe("the hooks", () => {
  it("are written again where they run another version than this copy", async () => {
    const { sim, out } = run({ latest: "1.0.0", hooks: "0.9.0" });
    expect((await out).state).toBe("current");
    expect(sim.rearms).toBe(1);
  });

  it("that can't be written are the one thing left to do, after the rest is done", async () => {
    const a = run(
      { latest: "1.0.0", hooks: "0.9.0" },
      {
        rearm: async () => ({ ok: false, said: "re-arming the hooks failed (EACCES); `sessionpipe install` does it" }),
      },
    );
    expect(await a.out).toEqual({
      state: "failed",
      error: "the hooks couldn't be written again from this copy (re-arming the hooks failed (EACCES))",
      next: "sessionpipe install",
    });
    expect(texts(a.sim)).toContain("ok: the background service runs sessionpipe 1.0.0");
    const b = run(
      { status: [st("1.0.0"), st("1.0.0"), st("1.1.0")] },
      {
        install: async () => ({
          ok: true,
          ms: 1,
          hooks: "re-arming the hooks failed (exit 1); `sessionpipe install` does it",
          rearmed: false,
        }),
      },
    );
    expect(await b.out).toMatchObject({ state: "failed", next: "sessionpipe install" });
    expect(texts(b.sim)).toContain("warn: re-arming the hooks failed (exit 1); `sessionpipe install` does it");
  });

  it("with no agent hooked there are none to write, and none to speak of", async () => {
    const { sim, out } = run({ latest: "1.0.0", hooks: null }, { harnesses: [] });
    expect(((await out) as { said: string }).said).toBe(
      "This computer is up to date: sessionpipe 1.0.0 runs the command and the background service, which hears r.example.",
    );
    expect(sim.rearms).toBe(0);
  });
});

describe("a computer with no background service", () => {
  it("has nothing to restart", async () => {
    const a = run({ latest: "1.0.0", status: [null], look: null }, { wanted: false });
    expect(await a.out).toMatchObject({
      state: "current",
      said: "This computer is up to date: sessionpipe 1.0.0 runs the command and the hooks.",
    });
    expect(texts(a.sim).at(-1)).toBe("info: the background service isn't set up on this computer: nothing to restart");
    const b = run({ latest: "1.0.0", status: [null], look: null, hooks: null }, { wanted: false, harnesses: [] });
    expect(((await b.out) as { said: string }).said).toBe(
      "This computer is up to date: sessionpipe 1.0.0 runs the command.",
    );
  });

  it("that is wanted, where nothing starts it: only a person can", async () => {
    const failed = {
      state: "failed",
      error: "the background service isn't running, and nothing on this computer starts it by itself",
      next: "sessionpipe control run",
    };
    // No manager that can be asked (Windows, a container, WSL without systemd).
    const a = run({ latest: "1.0.0", status: [null], look: null });
    expect(await a.out).toEqual(failed);
    // A manager, and no service file: nobody asked for a service here, so none is installed.
    const b = run({ latest: "1.0.0", status: [null], look: service({ installed: false, loaded: false, argv: null }) });
    expect(await b.out).toEqual(failed);
    expect(a.sim.placed + b.sim.placed).toBe(0);
    // A sessionpipe that keeps its files elsewhere has no service here: why, and the way through.
    const apart =
      "this sessionpipe keeps its files somewhere other than this computer's usual place (/x/state, not /home/me/.local/state/sessionpipe), so the usual background service is left alone";
    const c = run({ latest: "1.0.0", status: [null], look: null }, { apart });
    expect(await c.out).toEqual({
      state: "failed",
      error: `the background service isn't running, and nothing starts it by itself: ${apart}. Run it yourself, or give this one a service of its own with SESSIONPIPE_SERVICE_LABEL=org.sessionpipe.<name>`,
      next: "sessionpipe control run",
    });
  });
});

describe("a daemon someone runs by hand (pair --no-service, tmux, a container)", () => {
  // launchd is there and has no such service; with a file left from a start that failed, or none.
  const byHand = [
    service({ installed: false, loaded: false, argv: null }),
    service({ loaded: false }),
    service({ loaded: false, argv: ["/usr/bin/node", `${THEIRS}/cli.js`, "control", "run"] }),
    null,
  ];

  it("is restarted over its socket, and no service is installed for it", async () => {
    for (const look of byHand) {
      const { sim, out } = run({ look, status: [st("1.0.0"), st("1.0.0"), st("1.1.0")] });
      expect(await out).toMatchObject({ state: "current", version: "1.1.0" });
      expect(sim.did).toEqual(["restart"]);
      expect(texts(sim).at(-1)).toBe("ok: the background service restarted onto sessionpipe 1.1.0");
    }
  });

  it("on this version already is left as it is", async () => {
    for (const look of byHand) {
      const { sim, out } = run({ latest: "1.0.0", look });
      expect((await out).state).toBe("current");
      expect(sim.did).toEqual([]);
    }
  });

  it("that doesn't restart is theirs to stop and start", async () => {
    const failed = {
      state: "failed",
      error:
        "the background service still runs sessionpipe 1.0.0 and didn't restart onto 1.1.0. It was started by hand: stop it where it runs, then start it again",
      next: "sessionpipe control run",
    };
    const a = run({ look: byHand[0] as ServiceState }, { restart: async () => false });
    expect(await a.out).toEqual(failed);
    const b = run({ look: null });
    expect(await b.out).toEqual(failed);
    expect(a.sim.placed + b.sim.placed).toBe(0);
  });
});

describe("the service, made to run this copy", () => {
  const other = service({ argv: ["/usr/bin/node", `${THEIRS}/cli.js`, "control", "run"] });

  it("replaces one that runs another copy, and says where that was", async () => {
    const { sim, out } = run({ look: other, status: [st("0.9.0"), st("0.9.0"), null, st("1.1.0")] });
    expect((await out).state).toBe("current");
    expect(sim.placed).toBe(1);
    expect(sim.restarts).toBe(0);
    expect(sim.installs).toEqual([["1.1.0", []]]);
    expect(texts(sim).at(-1)).toBe("ok: the background service now runs this copy (it ran another one, in /p/svc)");
    // One npm didn't install (a checkout) is named by its folder.
    const b = run({ look: other, status: [st("0.9.0"), st("0.9.0"), null, st("1.1.0")] }, { globalPrefix: () => null });
    expect((await b.out).state).toBe("current");
    expect(texts(b.sim).at(-1)).toBe(
      `ok: the background service now runs this copy (it ran another one, in ${THEIRS})`,
    );
  });

  it("one from before 0.15 forgets who is mid-turn when stopped: that is written down for the next one first", async () => {
    const turns = ["claude-code:aaaa", "codex:bbbb"];
    // It says a session is mid-turn, which was never its own to wait for, and answers no `health`.
    const old = st("0.14.2", { busy: "a session on this machine mid-turn", mid_turn: turns });
    const a = run({ look: other, status: [old, old, null, st("1.1.0")] }, { health: async () => null });
    expect((await a.out).state).toBe("current");
    expect(a.sim.seeded).toEqual([turns]);
    expect(a.sim.did).toEqual(["quiesce", "seed", "place"]);
    // One that answers `health` without saying which copy it is, is as old.
    const b = run({ look: other, status: [old, old, null, st("1.1.0")] }, { health: async () => ({ accounts: [] }) });
    expect((await b.out).state).toBe("current");
    expect(b.sim.seeded).toEqual([turns]);
    // With no session mid-turn, or a status that names none, there is nothing to write.
    for (const idle of [st("0.14.2", { mid_turn: [] }), st("0.14.2")]) {
      const c = run({ look: other, status: [idle, idle, null, st("1.1.0")] }, { health: async () => null });
      expect((await c.out).state).toBe("current");
      expect(c.sim.did).toEqual(["quiesce", "place"]);
    }
  });

  it("one that remembers by itself is left to: nothing is written for it, nor where none was running", async () => {
    const now = st("1.0.0", { mid_turn: ["claude-code:aaaa"] });
    const a = run(
      { look: other, status: [now, now, null, st("1.1.0")] },
      { health: async () => ({ accounts: [], copy: { cli: `${THEIRS}/cli.js`, via: "launchd" } }) },
    );
    expect((await a.out).state).toBe("current");
    expect(a.sim.did).toEqual(["quiesce", "place"]);
    let asked = 0;
    const b = run(
      { latest: "1.0.0", look: service({ loaded: false }), status: [null, st("1.0.0")] },
      {
        health: async () => {
          asked++;
          return null;
        },
      },
    );
    expect((await b.out).state).toBe("current");
    expect(b.sim.did).toEqual(["place"]);
    expect(asked).toBe(0);
  });

  it("starts one launchd doesn't have, and one whose file is gone", async () => {
    const a = run({ latest: "1.0.0", look: service({ loaded: false }), status: [null, st("1.0.0")] });
    expect((await a.out).state).toBe("current");
    expect(texts(a.sim).at(-1)).toBe("ok: the background service is started");
    const b = run({ latest: "1.0.0", look: service({ installed: false, argv: null }), status: [st("1.0.0")] });
    expect((await b.out).state).toBe("current");
    expect(b.sim.placed).toBe(1);
    expect(texts(b.sim).at(-1)).toBe("ok: the background service was started again on this copy");
    // Loaded and silent: replaced too.
    const c = run({ latest: "1.0.0", status: [null, null, st("1.0.0")] });
    expect((await c.out).state).toBe("current");
    expect(c.sim.placed).toBe(1);
  });

  it("gives it a moment to finish what it holds, then replaces it", async () => {
    const busy = st("0.9.0", { busy: "2 message(s) in hand" });
    const { sim, out } = run({ look: other, status: [busy, busy, busy, st("0.9.0"), st("1.1.0")] });
    expect((await out).state).toBe("current");
    expect(sim.placed).toBe(1);
    expect(texts(sim)).toContain("info: the background service is busy (2 message(s) in hand): giving it a moment…");
    // The other copy was brought along in case the wait ran out.
    expect(sim.installs).toEqual([["1.1.0", [THEIRS]]]);
  });

  it("a service that went away while it was waited for is simply started", async () => {
    const busy = st("0.9.0", { busy: "a headless agent run" });
    const { sim, out } = run({ look: other, status: [busy, null, null, st("1.1.0")] });
    expect((await out).state).toBe("current");
    expect(sim.placed).toBe(1);
  });

  it("still busy after that: it restarts by itself when done, onto its own copy brought up too", async () => {
    const busy = st("0.9.0", { busy: "a headless agent run" });
    const { sim, out } = run(
      { look: other, status: [busy] },
      {
        versionAt: () => "1.1.0",
        install: async (_v, o) => ({ ok: true, ms: 1, hooks: "x", rearmed: true, along: o }),
      },
    );
    expect(await out).toEqual({
      state: "waiting",
      version: "1.1.0",
      said: "The background service is busy: a headless agent run. It restarts by itself onto sessionpipe 1.1.0 when that is done: nothing more to type.",
    });
    expect(sim.placed).toBe(0);
    expect(sim.restarts).toBe(1);
    expect(sim.clock).toBeGreaterThanOrEqual(25_000);
    expect(texts(sim)).toContain("ok: the background service's own copy (in /p/svc) is 1.1.0 too");
  });

  it("still busy, and its own copy couldn't be brought up or it won't restart itself: once more, later", async () => {
    const busy = st("0.9.0", { busy: "a headless agent run" });
    const said =
      "The background service is busy: a headless agent run. Moving it onto this copy now would cut that short; when it is done, run `sessionpipe update` once more.";
    const a = run(
      { look: other, status: [busy] },
      {
        install: async () => ({
          ok: true,
          ms: 1,
          hooks: "x",
          rearmed: true,
          others: [{ dir: THEIRS, error: "EACCES" }],
        }),
      },
    );
    expect(await a.out).toEqual({ state: "waiting", version: "1.1.0", said });
    expect(texts(a.sim)).toContain(`warn: the other copy in ${THEIRS} couldn't be updated (EACCES)`);
    const b = run({ look: other, status: [busy] }, { versionAt: () => "1.1.0", restart: async () => false });
    expect(await b.out).toEqual({ state: "waiting", version: "1.1.0", said });
    // A copy npm didn't install isn't brought along at all.
    const c = run({ look: other, status: [busy] }, { globalPrefix: () => null });
    expect((await c.out).state).toBe("waiting");
    expect(c.sim.installs).toEqual([["1.1.0", []]]);
  });

  it("this copy's own service, busy and not installed any more, restarts itself too", async () => {
    const busy = st("1.0.0", { busy: "a session starting" });
    const { out } = run({ look: service({ installed: false, argv: null }), status: [busy] });
    expect(await out).toMatchObject({
      state: "waiting",
      said: expect.stringContaining("It restarts by itself onto sessionpipe 1.1.0"),
    });
  });

  it("asks it to stop taking messages just before, in one step of its own; one that holds something by then is not cut short", async () => {
    // It held nothing when looked at, and took a message before it could be stopped.
    const free = st("0.9.0");
    const took = st("0.9.0", { busy: "1 message(s) in hand" });
    const a = run({ look: other, status: [free, took] }, { quiesce: async () => false, versionAt: () => "1.1.0" });
    expect(await a.out).toEqual({
      state: "waiting",
      version: "1.1.0",
      said: "The background service is busy: 1 message(s) in hand. It restarts by itself onto sessionpipe 1.1.0 when that is done: nothing more to type.",
    });
    expect(a.sim.did).toEqual(["restart"]);
    // It says it holds something and is free again when asked what: still not replaced under it.
    const b = run({ look: other, status: [free] }, { quiesce: async () => false, versionAt: () => "1.1.0" });
    expect(await b.out).toMatchObject({
      state: "waiting",
      said: expect.stringContaining("The background service is busy: what it has just taken up."),
    });
    expect(b.sim.placed).toBe(0);
    // It went away in between: there is nothing left to cut short, and it is started.
    const c = run({ look: other, status: [free, null, null, st("1.1.0")] }, { quiesce: async () => false });
    expect((await c.out).state).toBe("current");
    expect(c.sim.did).toEqual(["place"]);
    // One from before it knew the question gives no answer, and is replaced as it was before.
    const d = run({ look: other, status: [free, null, st("1.1.0")] }, { quiesce: async () => null });
    expect((await d.out).state).toBe("current");
    expect(d.sim.placed).toBe(1);
    // Paused and free: replaced. One that was never running, or is busy, is not asked.
    const e = run({ look: other, status: [free, null, st("1.1.0")] });
    expect((await e.out).state).toBe("current");
    expect(e.sim.did).toEqual(["quiesce", "place"]);
    const f = run({ latest: "1.0.0", look: service({ loaded: false }), status: [null, st("1.0.0")] });
    expect((await f.out).state).toBe("current");
    expect(f.sim.did).toEqual(["place"]);
  });

  it("a replace the manager refused: why, what answers now, and the one command for that", async () => {
    const refuse = () => {
      throw new Error("launchd refused it (launchctl answered 5); the service file that was there before was put back");
    };
    // The service that was there before was put back and answers again after a moment.
    const a = run({ look: other, status: [st("0.9.0"), null, null, st("0.9.0")] }, { place: refuse });
    expect(await a.out).toEqual({
      state: "failed",
      error:
        "the background service couldn't be moved onto this copy: launchd refused it (launchctl answered 5); the service file that was there before was put back. The one that answers now runs sessionpipe 0.9.0",
      next: "sessionpipe update",
    });
    // Nothing answers after the moment it is given: said, with the command that starts one.
    const b = run({ look: other, status: [st("0.9.0"), null] }, { place: refuse });
    expect(await b.out).toEqual({
      state: "failed",
      error:
        "the background service couldn't be moved onto this copy: launchd refused it (launchctl answered 5); the service file that was there before was put back. Nothing answers now",
      next: "sessionpipe control run",
    });
    expect(b.sim.clock).toBeGreaterThanOrEqual(10_000);
    const c = run({ look: other, status: [st("0.9.0"), null] }, { place: refuse, backMs: 3000 });
    await c.out;
    expect(c.sim.clock).toBe(3000);
  });

  it("says why when the service manager refuses, and when what it started isn't it", async () => {
    const a = run(
      { latest: "1.0.0", look: service({ loaded: false }), status: [null] },
      {
        place: () => {
          throw new Error("launchd refused it (launchctl answered 5)");
        },
      },
    );
    expect(await a.out).toEqual({
      state: "failed",
      error:
        "the background service couldn't be started: launchd refused it (launchctl answered 5). Nothing answers now",
      next: "sessionpipe control run",
    });
    const b = run({ latest: "1.0.0", look: service({ loaded: false }), status: [null] });
    expect(await b.out).toEqual({
      state: "failed",
      error: "the background service was started and doesn't answer",
      next: "sessionpipe doctor",
    });
    expect(b.sim.clock).toBeGreaterThanOrEqual(30_000);
    const c = run({ latest: "1.0.0", look: service({ loaded: false }), status: [null, st("0.9.0")] });
    expect(await c.out).toMatchObject({
      error: "the background service was started, but it answers as sessionpipe 0.9.0, not 1.0.0",
    });
  });
});

describe("the service that runs this copy already", () => {
  it("busy: it restarts itself when done", async () => {
    const { sim, out } = run({ status: [st("1.0.0", { busy: "a permission prompt waiting for an answer" })] });
    expect(await out).toEqual({
      state: "waiting",
      version: "1.1.0",
      said: "The background service is busy: a permission prompt waiting for an answer. It restarts by itself onto sessionpipe 1.1.0 when that is done: nothing more to type.",
    });
    // The wait that follows is said before it begins, with what the service holds.
    expect(sim.restarts).toBe(1);
    expect(texts(sim).at(-1)).toBe(
      "info: the background service is busy (a permission prompt waiting for an answer): giving it a moment…",
    );
    expect(sim.clock).toBeGreaterThanOrEqual(25_000);
  });

  it("holding nothing, or refusing to restart: no wait is announced", async () => {
    const moment = (s: Sim) => texts(s).filter((t) => t.includes("giving it a moment"));
    // It restarts at once: there is nothing to wait for.
    const free = run({ status: [st("1.0.0"), st("1.0.0"), st("1.1.0")] });
    expect((await free.out).state).toBe("current");
    expect(moment(free.sim)).toEqual([]);
    // Busy, and it won't restart itself: no wait follows, so none is said.
    const wont = run({ status: [st("1.0.0", { busy: "a headless agent run" })] }, { restart: async () => false });
    expect((await wont.out).state).toBe("failed");
    expect(moment(wont.sim)).toEqual([]);
    expect(wont.sim.clock).toBe(0);
  });

  it("one from before 0.15 that a manager has is replaced at once, with who is mid-turn written down: its own rule would wait for ever on a busy computer", async () => {
    const old = st("0.14.2", { busy: "a session on this machine mid-turn", mid_turn: ["claude-code:aaaa"] });
    const { sim, out } = run(
      { version: "0.15.0", latest: "0.15.0", hooks: "0.15.0", status: [old, old, null, st("0.15.0")] },
      { health: async () => null },
    );
    expect((await out).state).toBe("current");
    expect(sim.seeded).toEqual([["claude-code:aaaa"]]);
    // Asked to stop taking messages first (an older one doesn't answer that), then written down, then replaced.
    expect(sim.did).toEqual(["quiesce", "seed", "place"]);
    expect(texts(sim)).toContain("ok: the background service was started again on this copy");
    // One that holds something of its own is still given its moment, and never cut short.
    const working = st("0.14.2", { busy: "a headless agent run" });
    const b = run(
      { version: "0.15.0", latest: "0.15.0", hooks: "0.15.0", status: [working] },
      { health: async () => null },
    );
    expect(await b.out).toMatchObject({ state: "waiting" });
    expect(b.sim.did).not.toContain("place");
  });

  it("one from before 0.15 that someone runs by hand waits by its own older rule: waiting, not failed", async () => {
    const old = st("0.14.2", { busy: "a session on this machine mid-turn", mid_turn: ["claude-code:aaaa"] });
    const { sim, out } = run(
      { version: "0.15.0", latest: "0.15.0", hooks: "0.15.0", status: [old], look: null },
      { health: async () => null },
    );
    expect(await out).toEqual({
      state: "waiting",
      version: "0.15.0",
      said: "The background service still runs sessionpipe 0.14.2, which waits for the sessions on this computer to end their turn before it restarts. It restarts by itself onto sessionpipe 0.15.0 when the one it waits for ends its turn: nothing more to type.",
    });
    expect(sim.did).toEqual(["restart"]);
    expect(sim.clock).toBeGreaterThanOrEqual(25_000);
    // It restarts itself when nothing is mid-turn: there is nothing to write down for it.
    expect(sim.seeded).toEqual([]);
  });

  it("that won't restart, or didn't: try again; that stopped and doesn't come back: doctor", async () => {
    const failed = {
      state: "failed",
      error: "the background service still runs sessionpipe 1.0.0 and didn't restart onto 1.1.0",
      next: "sessionpipe update",
    };
    const a = run({}, { restart: async () => false });
    expect(await a.out).toEqual(failed);
    expect(a.sim.clock).toBe(0);
    const b = run({});
    expect(await b.out).toEqual(failed);
    // Busy and unwilling is no promise that it restarts by itself.
    const busy = st("1.0.0", { busy: "a headless agent run" });
    expect(await run({ status: [busy] }, { restart: async () => false }).out).toEqual(failed);
    const c = run({ status: [st("1.0.0"), st("1.0.0"), null] });
    expect(await c.out).toEqual({
      state: "failed",
      error: "the background service stopped to restart onto sessionpipe 1.1.0 and doesn't answer",
      next: "sessionpipe doctor",
    });
  });

  it("started by hand from another copy can't be moved from here", async () => {
    const { sim, out } = run(
      { look: null },
      { health: async () => ({ accounts: [], copy: { cli: `${THEIRS}/cli.js`, via: null } }) },
    );
    expect(await out).toEqual({
      state: "failed",
      error: `the background service was started by hand from another copy (${THEIRS}/cli.js) and runs sessionpipe 1.0.0: stop it where it runs, then start this one`,
      next: "sessionpipe control run",
    });
    expect(sim.restarts).toBe(0);
  });

  it("of another copy, under a manager this shell can't ask: said as that, and where to run this", async () => {
    const { sim, out } = run(
      { look: null },
      { health: async () => ({ accounts: [], copy: { cli: `${THEIRS}/cli.js`, via: "systemd" } }) },
    );
    expect(await out).toEqual({
      state: "failed",
      error: `the background service runs another copy (${THEIRS}/cli.js) on sessionpipe 1.0.0, and systemd can't be asked from this shell to move it onto this one. Run this from a terminal you opened on this computer yourself`,
      next: "sessionpipe update",
    });
    expect(sim.did).toEqual([]);
    const mac = run(
      { look: null },
      { health: async () => ({ accounts: [], copy: { cli: `${THEIRS}/cli.js`, via: "launchd" } }) },
    );
    expect(((await mac.out) as { error: string }).error).toContain("and launchd can't be asked from this shell");
    // A supervisor of its own is somebody's hand too.
    const own = run(
      { look: null },
      { health: async () => ({ accounts: [], copy: { cli: `${THEIRS}/cli.js`, via: "supervisor" } }) },
    );
    expect(await own.out).toMatchObject({ next: "sessionpipe control run" });
  });

  it("started by hand from this copy restarts itself", async () => {
    const { sim, out } = run(
      { look: null, status: [st("1.0.0"), st("1.0.0"), st("1.1.0")] },
      { health: async () => ({ accounts: [], copy: { cli: `${MINE}/cli.js`, via: null } }) },
    );
    expect((await out).state).toBe("current");
    expect(sim.restarts).toBe(1);
  });
});

describe("a last look", () => {
  it("a service that stopped answering", async () => {
    const { out } = run({ latest: "1.0.0", status: [st("1.0.0"), null] });
    expect(await out).toEqual({
      state: "failed",
      error: "the background service was running sessionpipe 1.0.0 and has stopped answering",
      next: "sessionpipe doctor",
    });
  });

  const rx = (r: Partial<Status["receivers"][number]>, url = "https://r.example") => ({
    url,
    machine: "m",
    keys: 1,
    polling: true,
    last_poll: null,
    last_poll_age_ms: 5,
    last_error: null,
    ...r,
  });
  const down = (r: Partial<Status["receivers"][number]>) => st("1.0.0", { receivers: [rx(r)] });

  it('"hears" is said of a receiver that has answered, never of one only being asked', async () => {
    // Just started: the poll is under way, which is all `polling` says. Its first answer comes later.
    const asking = down({});
    const a = run({ latest: "1.0.0", status: [asking, asking, asking, down({ last_poll: 7 })] });
    expect(await a.out).toEqual({
      state: "current",
      version: "1.0.0",
      said: "This computer is up to date: sessionpipe 1.0.0 runs the command, the hooks and the background service, which hears r.example.",
    });
    expect(texts(a.sim).at(-1)).toBe("info: waiting for r.example to answer the background service…");
    expect(a.sim.clock).toBeGreaterThan(0);
    // One that has answered already is not waited for.
    const b = run({ latest: "1.0.0" });
    expect(((await b.out) as { said: string }).said).toContain("which hears r.example.");
    expect(b.sim.clock).toBe(0);
  });

  it("a receiver that hasn't answered in the time a long-poll takes is a warning: the computer is up to date", async () => {
    const a = run({ latest: "1.0.0", status: [down({})] });
    expect(await a.out).toEqual({
      state: "current",
      version: "1.0.0",
      said: "This computer is up to date: sessionpipe 1.0.0 runs the command, the hooks and the background service.",
      warn: "r.example hasn't answered the background service yet. `sessionpipe doctor` looks again.",
    });
    expect(a.sim.clock).toBeGreaterThanOrEqual(40_000);
    // One that answers 401, or can't be reached: what the service last heard of it.
    const gone = "the receiver no longer knows this machine (401); run `sessionpipe control pair` again";
    const b = run({ latest: "1.0.0", status: [down({ polling: false, last_error: gone })] });
    expect(await b.out).toMatchObject({
      state: "current",
      warn: `r.example hasn't answered the background service: ${gone}. \`sessionpipe doctor\` looks again.`,
    });
    // It answered once and fails now: not heard either.
    const c = run({ latest: "1.0.0", status: [down({ last_poll: 7, last_error: "fetch failed" })] });
    expect(await c.out).toMatchObject({ warn: expect.stringContaining("r.example hasn't answered") });
    const d = run({ latest: "1.0.0", status: [down({ last_poll: 7, polling: false })] });
    expect(await d.out).toMatchObject({ warn: expect.stringContaining("r.example hasn't answered") });
    // One that comes round within the moment is fine.
    const e = run({ latest: "1.0.0", status: [down({ last_error: "fetch failed" }), down({ last_poll: 9 })] });
    expect(await e.out).not.toHaveProperty("warn");
  });

  it("of two receivers, the one that answers is heard and the other is named", async () => {
    const two = st("1.0.0", {
      receivers: [
        rx({ last_poll: 3 }, "https://a.example"),
        rx({ last_error: "HTTP 503" }, "https://b.example"),
        rx({}, "https://c.example"),
      ],
    });
    const { sim, out } = run({ latest: "1.0.0", status: [two] });
    expect(await out).toEqual({
      state: "current",
      version: "1.0.0",
      said: "This computer is up to date: sessionpipe 1.0.0 runs the command, the hooks and the background service, which hears a.example.",
      warn: "b.example hasn't answered the background service: HTTP 503. c.example hasn't answered the background service yet. `sessionpipe doctor` looks again.",
    });
    expect(texts(sim).at(-1)).toBe("info: waiting for b.example and c.example to answer the background service…");
  });

  it("a service that stops answering while its receivers are waited for", async () => {
    const { out } = run({ latest: "1.0.0", status: [down({}), down({}), down({}), null] });
    expect(await out).toMatchObject({
      state: "failed",
      error: "the background service was running sessionpipe 1.0.0 and has stopped answering",
    });
  });

  it("two receivers, and none", async () => {
    const two = st("1.0.0", {
      receivers: ["https://a.example", "https://b.example"].map((url) => ({
        url,
        machine: "m",
        keys: 1,
        polling: true,
        last_poll: 1,
        last_poll_age_ms: 1,
        last_error: null,
      })),
    });
    expect(((await run({ latest: "1.0.0", status: [two] }).out) as { said: string }).said).toContain(
      "which hears a.example and b.example.",
    );
    expect(
      ((await run({ latest: "1.0.0", status: [st("1.0.0", { receivers: [] })] }).out) as { said: string }).said,
    ).toBe("This computer is up to date: sessionpipe 1.0.0 runs the command, the hooks and the background service.");
  });

  it("uses the waits it is given", async () => {
    const { sim, out } = run(
      { latest: "1.0.0", look: service({ loaded: false }), status: [null] },
      { startMs: 2000, settleMs: 1000, heardMs: 1000 },
    );
    await out;
    expect(sim.clock).toBe(2000);
  });
});

describe("after `sessionpipe reinstall` has installed the newest release as this copy", () => {
  /** npm, which is not to be asked: it counts each time it is. */
  const npm = () => {
    const asked = { times: 0 };
    return {
      asked,
      latest: async (): Promise<string> => {
        asked.times++;
        throw new Error("registry.npmjs.org can't be reached (ENOTFOUND)");
      },
    };
  };

  it("npm is asked nothing and nothing is said of the newest release: the hooks and the service follow", async () => {
    const { asked, latest } = npm();
    const { sim, out } = run(
      { version: "1.1.0", hooks: "1.0.0", status: [st("1.0.0"), st("1.0.0"), st("1.1.0")] },
      { latest },
      { installed: true },
    );
    // Not "couldn't ask npm": it was not asked, and the last line is the green one.
    expect(await out).toEqual({
      state: "current",
      version: "1.1.0",
      said: "This computer is up to date: sessionpipe 1.1.0 runs the command, the hooks and the background service, which hears r.example.",
    });
    expect(asked.times).toBe(0);
    // Nothing is installed here: the caller did that. The hooks are written, the service restarted.
    expect(sim.installs).toEqual([]);
    expect(sim.rearms).toBe(1);
    expect(sim.restarts).toBe(1);
    expect(texts(sim)).toEqual([
      "ok: the hooks run sessionpipe 1.1.0 (claude-code)",
      "ok: the background service restarted onto sessionpipe 1.1.0",
    ]);
    expect(texts(sim).join("\n")).not.toContain("newest release");
  });

  it("without it the same computer asks npm, and says what it answered or that it couldn't", async () => {
    const { asked, latest } = npm();
    const sim = { version: "1.1.0", hooks: "1.1.0", status: [st("1.1.0")] };
    const { sim: unasked, out } = run(sim, { latest });
    expect(await out).toMatchObject({ state: "failed", next: "sessionpipe update" });
    expect(asked.times).toBe(1);
    expect(texts(unasked)[0]).toBe(
      "warn: couldn't ask npm for the newest release: registry.npmjs.org can't be reached (ENOTFOUND)",
    );
    // `installed: false` is the same as not saying it.
    const said = run({ ...sim, latest: "1.1.0" }, {}, { installed: false });
    await said.out;
    expect(texts(said.sim)[0]).toBe("ok: sessionpipe 1.1.0 is the newest release");
    const quiet = run({ ...sim, latest: "1.1.0" }, {}, {});
    await quiet.out;
    expect(texts(quiet.sim)[0]).toBe("ok: sessionpipe 1.1.0 is the newest release");
  });
});

describe("a service file that names what is gone (`stale`)", () => {
  // The service a manager has, on this copy and this release, answering: nothing to do.
  const fine = { version: "1.1.0", latest: "1.1.0", hooks: "1.1.0", status: [st("1.1.0")] };

  it("is written again though the manager has it, it names this copy and its service answers", async () => {
    const left = run(fine);
    expect((await left.out).state).toBe("current");
    expect(left.sim.did).toEqual([]);
    expect(texts(left.sim).at(-1)).toBe("ok: the background service runs sessionpipe 1.1.0");
    // No reason, said as null or as nothing, is no reason.
    const none = run(fine, { stale: null });
    await none.out;
    expect(none.sim.did).toEqual([]);

    const { sim, out } = run(fine, { stale: "the node it names is gone" });
    expect((await out).state).toBe("current");
    // Asked to stop taking messages, then placed: the same steps as for one on another copy.
    expect(sim.did).toEqual(["quiesce", "place"]);
    expect(sim.restarts).toBe(0);
    expect(texts(sim).at(-1)).toBe("ok: the background service was started again on this copy");
  });

  it("is written again where the manager doesn't have it and a daemon answers all the same", async () => {
    const byHand = { ...fine, look: service({ loaded: false }) };
    // Its file is there, launchd has nothing loaded, and someone's daemon answers on this
    // release: left as it is.
    const left = run(byHand);
    expect((await left.out).state).toBe("current");
    expect(left.sim.did).toEqual([]);

    const { sim, out } = run(byHand, { stale: "the node it names is gone" });
    expect((await out).state).toBe("current");
    expect(sim.did).toEqual(["quiesce", "place"]);
    // With no file there is no service anyone asked for: none is installed, stale or not.
    const noFile = run({ ...fine, look: service({ installed: false, loaded: false, argv: null }) }, { stale: "gone" });
    expect((await noFile.out).state).toBe("current");
    expect(noFile.sim.did).toEqual([]);
  });

  it("one that is busy is not cut short for it", async () => {
    const { sim, out } = run(
      { ...fine, status: [st("1.1.0", { busy: "a headless agent run" })] },
      { stale: "the node it names is gone", settleMs: 1000 },
    );
    expect(await out).toEqual({
      state: "waiting",
      version: "1.1.0",
      said: "The background service is busy: a headless agent run. It restarts by itself onto sessionpipe 1.1.0 when that is done: nothing more to type.",
    });
    expect(sim.placed).toBe(0);
  });
});
