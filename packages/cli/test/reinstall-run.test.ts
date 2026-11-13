// SPDX-License-Identifier: Apache-2.0
// reinstall/run.ts: a plan carried out, one step after the other. Everything that would
// touch the computer is stood in for and written down in the order it happened, the plan
// is a literal, and time is a counter: each way a run can go is one test, with no file,
// no process and no clock in it.
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Status } from "../src/control/daemon.js";
import type { Health } from "../src/control/local.js";
import type { Outcome } from "../src/current.js";
import type { Left, Plan, Step } from "../src/reinstall/plan.js";
import { carryOut, type Doing, type Done, type Proof } from "../src/reinstall/run.js";

const HOME = path.join(path.sep, "home", "u");
/** The home of the fresh copy, its slot, and the name the old folder is moved aside under. */
const PREFIX = path.join(HOME, ".local");
const MODULES = path.join(PREFIX, "lib", "node_modules");
const SLOT = path.join(MODULES, "sessionpipe");
const ASIDE = path.join(MODULES, ".sessionpipe-a1b2c3d4");
const BIN = path.join(PREFIX, "bin", "sessionpipe");
/** An older copy under nvm with its bin link, and what npm left beside it. */
const NVM = path.join(HOME, ".nvm", "versions", "node", "v22.1.0");
const OLD = path.join(NVM, "lib", "node_modules", "sessionpipe");
const OLD_BIN = path.join(NVM, "bin", "sessionpipe");
const LEFTOVER = path.join(NVM, "lib", "node_modules", ".sessionpipe-Zz9Yy8Xx");
/** The copy the command itself runs from, and a link outside the home that leads nowhere. */
const NPX = path.join(HOME, ".npm", "_npx", "0a1b2c3d", "node_modules", "sessionpipe");
const LINK = path.join(path.sep, "usr", "local", "bin", "sessionpipe");
const tilde = (p: string): string => (p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p);

type Kind = Step["do"];
/** The steps as a plan writes them: what a row says of each is the plan's (`say`), and
 *  the run repeats it only of a removal. The download and the check have no row. */
const base = { touches: [] };
const fetch = (): Step => ({ ...base, do: "fetch", version: "2.0.0" });
const install = (replaces = false): Step => ({
  ...base,
  do: "install",
  version: "2.0.0",
  prefix: PREFIX,
  dir: SLOT,
  replaces,
  say: `2.0.0, the newest release, fresh in ~/.local (${replaces ? "replaces 1.0.0" : "a folder of your own"})`,
});
const stop = (pid = 41): Step => ({
  ...base,
  do: "stop",
  pid,
  say: `the daemon started by hand (pid ${pid}), once it holds nothing`,
});
const unserve = (): Step => ({
  ...base,
  do: "unserve",
  file: path.join(HOME, "Library", "LaunchAgents", "x.plist"),
  say: "the service file, which nothing here needs",
});
const use = (serve = true): Step => ({
  ...base,
  do: "use",
  serve,
  say: serve ? "the hooks and the background service to it" : "the hooks to it",
});
/** What the plan's row says of each thing these tests remove: a copy by its release and
 *  its folder, npm's leftover as that, a link by its file. */
const ROW: Record<string, string> = {
  [OLD]: "1.0.0 in ~/.nvm/versions/node/v22.1.0",
  [LEFTOVER]: "a leftover folder in ~/.nvm/versions/node/v22.1.0",
  [NPX]: "2.0.0 in ~/.npm/_npx/0a1b2c3d",
  [LINK]: `${LINK} (a link to a copy that is gone)`,
};
const remove = (p: string, say = ROW[p] as string): Step => ({ ...base, do: "remove", path: p, say });
const prove = (): Step => ({ ...base, do: "prove" });

const plan = (steps: Step[], o: Partial<Plan> = {}): Plan => ({
  nothing: null,
  refuse: null,
  target: "2.0.0",
  home: {
    prefix: PREFIX,
    shown: "~/.local",
    why: "a folder of your own",
    bin: path.dirname(BIN),
    pathAt: 0,
    blocked: null,
  },
  steps,
  // The plan's screen says it; the run has nothing to do with it.
  safety: ["Nothing is touched until 2.0.0 has downloaded. A failed install is undone."],
  left: [],
  notes: [],
  first: null,
  ...o,
});

/** The package folder of a prefix: what a left copy is by its whole path. */
const slotOf = (prefix: string): string => path.join(prefix, "lib", "node_modules", "sessionpipe");
const left = (o: Partial<Left> = {}): Left => ({
  where: "/usr/local",
  path: slotOf(path.join(path.sep, "usr", "local")),
  version: "1.0.0",
  why: "you may not write where it is",
  line: "sudo npm uninstall -g --prefix /usr/local sessionpipe",
  ours: true,
  ...o,
});

const st = (o: Partial<Status> = {}): Status =>
  ({ version: "1.0.0", pid: 41, name: "lab", receivers: [], mid_turn: [], busy: null, ...o }) as Status;
/** A daemon of this release says which copy it is; one from before 0.15 doesn't. */
const SAYS: Health = { accounts: [], copy: { cli: path.join(OLD, "dist", "cli.js"), via: null } };
const SILENT: Health = { accounts: [] };

/** The computer a run meets. */
interface Sim {
  /** The folders that are there when it starts. */
  there: string[];
  /** Why the release can't be fetched; null: it can. */
  fetch: string | null;
  /** Why npm couldn't install it (null: it did), and whether npm left a folder in the slot. */
  install: string | null;
  partial: boolean;
  /** A move that fails, by the folder that was to be moved, with what the system says. */
  unmovable: Record<string, string>;
  /** What can't be removed, with why. */
  stuck: Record<string, string>;
  /** The bin links that go with a folder. */
  bins: Record<string, string[]>;
  /** The link that starts the copy in the home is there once it was looked for. */
  relink: boolean;
  /** What the daemon answers each time it is asked; the last one stands. */
  status: (Status | null)[];
  health: Health | null;
  use: Outcome;
  serviceDir: string | null;
  proof: Partial<Proof>;
  settleMs: number | null;
  stopMs: number | null;
}

/** What a run did. */
interface World {
  /** Everything done and everything said, in the order it happened. */
  all: string[];
  /** Only what was done. */
  did: string[];
  /** Only what was said. */
  said: string[];
  /** What the proof was handed as removed, each time it was asked. */
  proved: string[][];
  /** Every removal asked for, with its `alone` as it was given: only the folder, its
   *  bin link left. */
  removals: [what: string, alone: boolean | undefined][];
  /** Every prefix whose link was looked for, and made again where it could be. */
  relinked: string[];
  there: Set<string>;
  clock: number;
  done: Done;
}

async function carry(p: Plan, sim: Partial<Sim> = {}): Promise<World> {
  const s: Sim = {
    there: [],
    fetch: null,
    install: null,
    partial: false,
    unmovable: {},
    stuck: {},
    bins: {},
    relink: true,
    status: [null],
    health: SAYS,
    use: { state: "current", version: "2.0.0", said: "This computer is up to date." },
    serviceDir: null,
    proof: {},
    settleMs: null,
    stopMs: null,
    ...sim,
  };
  const answers = [...s.status];
  const w: Omit<World, "done"> = {
    all: [],
    did: [],
    said: [],
    proved: [],
    removals: [],
    relinked: [],
    there: new Set(s.there),
    clock: 0,
  };
  const did = (x: string): void => {
    w.did.push(x);
    w.all.push(x);
  };
  const d: Doing = {
    say: (l) => {
      w.said.push(`${l.mark}: ${l.text}`);
      w.all.push(`${l.mark}: ${l.text}`);
    },
    tilde,
    fetch: async (version) => {
      did(`fetch ${version}`);
      return s.fetch;
    },
    install: async (prefix, version) => {
      did(`install ${version} in ${prefix}`);
      if (!s.install || s.partial) w.there.add(SLOT);
      return s.install;
    },
    exists: (p) => w.there.has(p),
    rename: (from, to) => {
      did(`rename ${from} -> ${to}`);
      if (s.unmovable[from]) throw new Error(s.unmovable[from]);
      w.there.delete(from);
      w.there.add(to);
    },
    id: () => "a1b2c3d4",
    status: async () => {
      did("status");
      return answers.length > 1 ? (answers.shift() as Status | null) : (answers[0] ?? null);
    },
    health: async () => {
      did("health");
      return s.health;
    },
    quiesce: async () => {
      did("quiesce");
      return true;
    },
    seed: (sessions) => did(`seed ${sessions.join(",")}`),
    stop: (pid) => did(`stop ${pid}`),
    unserve: () => did("unserve"),
    use: async (version, serve) => {
      did(`use ${version}${serve ? ", the service too" : ""}`);
      return s.use;
    },
    serviceDir: () => s.serviceDir,
    remove: async (what, alone) => {
      did(`remove ${what}${alone ? ", the folder only" : ""}`);
      w.removals.push([what, alone]);
      if (s.stuck[what]) throw new Error(s.stuck[what]);
      w.there.delete(what);
      return [what, ...(alone ? [] : (s.bins[what] ?? []))];
    },
    relink: (prefix) => {
      did(`relink ${prefix}`);
      w.relinked.push(prefix);
      return s.relink;
    },
    prove: async (removed) => {
      did("prove");
      w.proved.push([...removed]);
      return { runs: "2.0.0", onPath: [BIN], first: true, named: [], ...s.proof };
    },
    sleep: async (ms) => {
      w.clock += ms;
    },
    now: () => w.clock,
    ...(s.settleMs === null ? {} : { settleMs: s.settleMs }),
    ...(s.stopMs === null ? {} : { stopMs: s.stopMs }),
  };
  const done = await carryOut(p, d);
  return { ...w, done };
}

const count = (w: World, what: string): number => w.did.filter((x) => x === what).length;
const ONE: Done = {
  state: "one",
  said: "This computer has one sessionpipe: 2.0.0, in ~/.local. Pairings and settings are as they were.",
  warn: [],
};
/** The fresh copy is in use and a copy that should have gone is still there: what works
 *  is said as it is of one copy, then what is left (`still`) and the one command for it. */
const LEFT = (still: string, next = "sessionpipe reinstall", warn: string[] = []): Done => ({
  state: "left",
  said: "sessionpipe 2.0.0 is installed in ~/.local and in use. Pairings and settings are as they were.",
  warn,
  still,
  next,
});
const SUDO = "sudo npm uninstall -g --prefix /usr/local sessionpipe";
const TYPING = (file: string): string => `Typing \`sessionpipe\` still starts ${file}, not the fresh copy.`;

describe("a plan carried out", () => {
  it("fetches, installs over what was there, moves the hooks and the service, removes the rest, and proves it: in that order", async () => {
    const w = await carry(
      plan([fetch(), install(true), use(), remove(LINK), remove(LEFTOVER), remove(OLD), remove(NPX), prove()]),
      { there: [SLOT, LEFTOVER, OLD, NPX], bins: { [OLD]: [OLD_BIN] } },
    );
    expect(w.all).toEqual([
      "fetch 2.0.0",
      "ok: sessionpipe 2.0.0 downloaded",
      `rename ${SLOT} -> ${ASIDE}`,
      `install 2.0.0 in ${PREFIX}`,
      `remove ${ASIDE}`,
      "ok: installed fresh in ~/.local, and it runs (what was there is gone)",
      "use 2.0.0, the service too",
      // Each removal is said in the words of its row on the plan; the copy that had a
      // link says the link went with it.
      `remove ${LINK}`,
      `ok: removed ${LINK} (a link to a copy that is gone)`,
      `remove ${LEFTOVER}`,
      "ok: removed a leftover folder in ~/.nvm/versions/node/v22.1.0",
      `remove ${OLD}`,
      "ok: removed 1.0.0 in ~/.nvm/versions/node/v22.1.0, with its link",
      `remove ${NPX}`,
      "ok: removed 2.0.0 in ~/.npm/_npx/0a1b2c3d",
      "prove",
      "ok: the fresh copy runs: `--version` says 2.0.0",
      `ok: a shell finds one sessionpipe: ${tilde(BIN)}`,
      "ok: nothing here names a removed copy any more",
    ]);
    expect(w.done).toEqual(ONE);
    // The proof is handed what the removals said is gone, links too; the folder that was
    // moved aside was the home's own, and is no removed copy to look for.
    expect(w.proved).toEqual([[LINK, LEFTOVER, OLD, OLD_BIN, NPX]]);
    expect([...w.there]).toEqual([SLOT]);
    expect(w.clock).toBe(0);
    // Every removal was of the whole of a copy, its link with it: none of the folder only.
    // And no link was made again: that is for a folder put back after an install that failed.
    expect(w.removals).toEqual([
      [ASIDE, undefined],
      [LINK, undefined],
      [LEFTOVER, undefined],
      [OLD, undefined],
      [NPX, undefined],
    ]);
    expect(w.relinked).toEqual([]);
  });

  it("a plan with nothing to remove says nothing of removed copies", async () => {
    const w = await carry(plan([fetch(), install(), use(false), prove()]));
    expect(w.all).toEqual([
      "fetch 2.0.0",
      "ok: sessionpipe 2.0.0 downloaded",
      `install 2.0.0 in ${PREFIX}`,
      "ok: installed fresh in ~/.local, and it runs",
      "use 2.0.0",
      "prove",
      "ok: the fresh copy runs: `--version` says 2.0.0",
      `ok: a shell finds one sessionpipe: ${tilde(BIN)}`,
    ]);
    expect(w.done).toEqual(ONE);
    expect(w.proved).toEqual([[]]);
    expect(w.removals).toEqual([]);
    expect(w.relinked).toEqual([]);
  });
});

describe("the download", () => {
  it("a release that can't be downloaded stops it before anything is touched", async () => {
    const w = await carry(plan([fetch(), install(true), use(), remove(OLD), prove()]), {
      there: [SLOT, OLD],
      fetch: "npm error code E404",
    });
    expect(w.done).toEqual({
      state: "failed",
      error: "sessionpipe 2.0.0 couldn't be downloaded from npm (npm error code E404). Nothing was changed",
      next: "sessionpipe reinstall",
    });
    expect(w.all).toEqual(["fetch 2.0.0"]);
    expect([...w.there]).toEqual([SLOT, OLD]);
  });

  it("one that is downloaded is said by its release, in a line of its own", async () => {
    const w = await carry(plan([fetch()], { target: "2.1.0" }));
    // The release is the step's own: what was asked of npm is what is said.
    expect(w.all).toEqual(["fetch 2.0.0", "ok: sessionpipe 2.0.0 downloaded"]);
  });
});

describe("the fresh install", () => {
  it("into an empty slot nothing is moved and nothing is removed", async () => {
    const w = await carry(plan([install()]));
    expect(w.all).toEqual([`install 2.0.0 in ${PREFIX}`, "ok: installed fresh in ~/.local, and it runs"]);
    expect(w.done).toEqual(ONE);
  });

  it("what is in the slot is moved aside beside it, and goes only once the fresh copy runs", async () => {
    const w = await carry(plan([install(true)]), { there: [SLOT] });
    expect(w.did).toEqual([`rename ${SLOT} -> ${ASIDE}`, `install 2.0.0 in ${PREFIX}`, `remove ${ASIDE}`]);
    // Beside the slot, under the name npm itself gives a folder it moved out of the way.
    expect(path.dirname(ASIDE)).toBe(path.dirname(SLOT));
    expect(path.basename(ASIDE)).toMatch(/^\.sessionpipe-[A-Za-z0-9]{8}$/);
    expect(w.said).toEqual(["ok: installed fresh in ~/.local, and it runs (what was there is gone)"]);
    expect([...w.there]).toEqual([SLOT]);
    // The old folder goes whole, and the link npm has just written is not looked for again.
    expect(w.removals).toEqual([[ASIDE, undefined]]);
    expect(w.relinked).toEqual([]);
  });

  it("an old folder that can't be removed afterwards is the next run's to find: the install worked", async () => {
    const w = await carry(plan([install(true), use(), prove()]), {
      there: [SLOT],
      stuck: { [ASIDE]: "EBUSY: resource busy or locked" },
    });
    expect(w.did).toEqual([
      `rename ${SLOT} -> ${ASIDE}`,
      `install 2.0.0 in ${PREFIX}`,
      `remove ${ASIDE}`,
      "use 2.0.0, the service too",
      "prove",
    ]);
    expect(w.done).toEqual(ONE);
    expect([...w.there].sort()).toEqual([ASIDE, SLOT].sort());
  });

  it("npm failing into an empty slot: what it left is removed, and nothing else was changed", async () => {
    const steps = [fetch(), install(), use(), remove(OLD), prove()];
    const failed: Done = {
      state: "failed",
      error:
        "sessionpipe 2.0.0 couldn't be installed in ~/.local: npm install: npm error code EINTEGRITY. Nothing else was changed",
      next: "sessionpipe reinstall",
    };
    // npm left half a copy in the slot.
    const half = await carry(plan(steps), {
      there: [OLD],
      install: "npm install: npm error code EINTEGRITY",
      partial: true,
    });
    expect(half.done).toEqual(failed);
    // Only the folder: a link in the home's bin folder is not npm's leftover to take with it.
    expect(half.did).toEqual(["fetch 2.0.0", `install 2.0.0 in ${PREFIX}`, `remove ${SLOT}, the folder only`]);
    expect(half.removals).toEqual([[SLOT, true]]);
    expect([...half.there]).toEqual([OLD]);
    // npm left nothing: there is nothing to remove.
    const none = await carry(plan(steps), { there: [OLD], install: "npm install: npm error code EINTEGRITY" });
    expect(none.done).toEqual(failed);
    expect(none.did).toEqual(["fetch 2.0.0", `install 2.0.0 in ${PREFIX}`]);
    // Either way it stops there: the hooks, the service and the other copies are as they were.
    expect(none.said).toEqual(["ok: sessionpipe 2.0.0 downloaded"]);
    expect([...none.there]).toEqual([OLD]);
    // Nothing was moved aside, so there is no folder back in its place to have a link for.
    expect(half.relinked).toEqual([]);
    expect(none.relinked).toEqual([]);
  });

  it("npm failing over a copy: what it left is removed, the old folder is moved back, and its link is seen to be there", async () => {
    const failed: Done = {
      state: "failed",
      error:
        "sessionpipe 2.0.0 couldn't be installed in ~/.local: npm install: it installed, and the copy on disk says nothing. What was there is back in its place",
      next: "sessionpipe reinstall",
    };
    const why = "npm install: it installed, and the copy on disk says nothing";
    const half = await carry(plan([install(true), use(), prove()]), { there: [SLOT], install: why, partial: true });
    expect(half.done).toEqual(failed);
    // What npm left goes as a folder only: the link stays for the folder that comes back.
    expect(half.did).toEqual([
      `rename ${SLOT} -> ${ASIDE}`,
      `install 2.0.0 in ${PREFIX}`,
      `remove ${SLOT}, the folder only`,
      `rename ${ASIDE} -> ${SLOT}`,
      `relink ${PREFIX}`,
    ]);
    expect(half.removals).toEqual([[SLOT, true]]);
    expect(half.relinked).toEqual([PREFIX]);
    expect([...half.there]).toEqual([SLOT]);
    expect(half.said).toEqual([]);
    const none = await carry(plan([install(true), use(), prove()]), { there: [SLOT], install: why });
    expect(none.done).toEqual(failed);
    expect(none.did).toEqual([
      `rename ${SLOT} -> ${ASIDE}`,
      `install 2.0.0 in ${PREFIX}`,
      `rename ${ASIDE} -> ${SLOT}`,
      `relink ${PREFIX}`,
    ]);
    expect(none.removals).toEqual([]);
    expect([...none.there]).toEqual([SLOT]);
  });

  it("the old folder is back and the link that starts it is not: the sentence says so", async () => {
    // npm took the link with what it left, and it could not be made again.
    const w = await carry(plan([fetch(), install(true), use(), remove(OLD), prove()]), {
      there: [SLOT, OLD],
      install: "npm install: npm error code ENOSPC",
      partial: true,
      relink: false,
    });
    expect(w.done).toEqual({
      state: "failed",
      error:
        "sessionpipe 2.0.0 couldn't be installed in ~/.local: npm install: npm error code ENOSPC. What was there is back in its place, but the link that starts it is gone",
      next: "sessionpipe reinstall",
    });
    // The link is looked for only after the folder is back, and once.
    expect(w.did).toEqual([
      "fetch 2.0.0",
      `rename ${SLOT} -> ${ASIDE}`,
      `install 2.0.0 in ${PREFIX}`,
      `remove ${SLOT}, the folder only`,
      `rename ${ASIDE} -> ${SLOT}`,
      `relink ${PREFIX}`,
    ]);
    // It stops there all the same: the hooks, the service and the other copy are as they were.
    expect([...w.there].sort()).toEqual([OLD, SLOT].sort());
    expect(w.said).toEqual(["ok: sessionpipe 2.0.0 downloaded"]);
  });

  it("an old folder that can't be put back is kept beside the slot, and the sentence says where", async () => {
    const kept = `it is kept beside it, as ${tilde(ASIDE)}`;
    // The move back fails.
    const back = await carry(plan([install(true), use()]), {
      there: [SLOT],
      install: "npm install: ENOSPC",
      unmovable: { [ASIDE]: "EPERM: operation not permitted, rename" },
    });
    expect(back.done).toEqual({
      state: "failed",
      error: `sessionpipe 2.0.0 couldn't be installed in ~/.local: npm install: ENOSPC; and what was there could not be put back (EPERM: operation not permitted, rename): ${kept}`,
      next: "sessionpipe reinstall",
    });
    // No folder is back in the slot, so no link is made for one.
    expect(back.did).toEqual([
      `rename ${SLOT} -> ${ASIDE}`,
      `install 2.0.0 in ${PREFIX}`,
      `rename ${ASIDE} -> ${SLOT}`,
    ]);
    expect(back.relinked).toEqual([]);
    expect([...back.there]).toEqual([ASIDE]);
    // What npm left in the slot can't be removed, so the old folder has nowhere to go back to.
    const full = await carry(plan([install(true), use()]), {
      there: [SLOT],
      install: "npm install: ENOSPC",
      partial: true,
      stuck: { [SLOT]: "it holds src, which no published sessionpipe has (a checkout or a build?)" },
    });
    expect(full.done).toEqual({
      state: "failed",
      error: `sessionpipe 2.0.0 couldn't be installed in ~/.local: npm install: ENOSPC; and what was there could not be put back (it holds src, which no published sessionpipe has (a checkout or a build?)): ${kept}`,
      next: "sessionpipe reinstall",
    });
    expect(full.did).toEqual([
      `rename ${SLOT} -> ${ASIDE}`,
      `install 2.0.0 in ${PREFIX}`,
      `remove ${SLOT}, the folder only`,
    ]);
    expect(full.relinked).toEqual([]);
    expect([...full.there].sort()).toEqual([ASIDE, SLOT].sort());
  });

  it("what npm left in an empty slot can't be removed: it says that, and names no folder kept beside it", async () => {
    const w = await carry(plan([install(), use()]), {
      install: "npm install: ENOSPC",
      partial: true,
      stuck: { [SLOT]: "EACCES: permission denied, rmdir" },
    });
    expect(w.done).toEqual({
      state: "failed",
      error:
        "sessionpipe 2.0.0 couldn't be installed in ~/.local: npm install: ENOSPC; and what npm left there could not be removed (EACCES: permission denied, rmdir)",
      next: "sessionpipe reinstall",
    });
    // Nothing was moved aside, so no such folder is there to speak of.
    expect(w.done.state === "failed" && w.done.error).not.toContain(".sessionpipe-");
    expect(w.did).toEqual([`install 2.0.0 in ${PREFIX}`, `remove ${SLOT}, the folder only`]);
    expect(w.there.has(ASIDE)).toBe(false);
  });

  it("what is there can't be moved out of the way: npm is never run", async () => {
    const w = await carry(plan([fetch(), install(true), use(), remove(OLD), prove()]), {
      there: [SLOT, OLD],
      unmovable: { [SLOT]: "EACCES: permission denied, rename" },
    });
    expect(w.done).toEqual({
      state: "failed",
      error:
        "sessionpipe 2.0.0 couldn't be installed in ~/.local: what is there now couldn't be moved out of the way (EACCES: permission denied, rename). Nothing was changed",
      next: "sessionpipe reinstall",
    });
    expect(w.did).toEqual(["fetch 2.0.0", `rename ${SLOT} -> ${ASIDE}`]);
    expect([...w.there]).toEqual([SLOT, OLD]);
    expect(w.relinked).toEqual([]);
  });
});

describe("a daemon someone started by hand", () => {
  const BUSY = st({ busy: "a headless agent run" });
  const waiting = (pid: number): Done => ({
    state: "waiting",
    said: `The daemon someone started by hand (pid ${pid}) is busy: a headless agent run. The fresh copy is installed; when that is done, run \`sessionpipe reinstall\` once more and it finishes.`,
  });

  it("busy with its own work past the wait: it is left to finish, and nothing after the install is done", async () => {
    const w = await carry(plan([fetch(), install(), stop(), use(), remove(OLD), prove()]), {
      there: [OLD],
      status: [BUSY],
    });
    expect(w.done).toEqual(waiting(41));
    // 25 seconds by default, asked twice a second; the counter is the only clock.
    expect(w.clock).toBe(25_000);
    expect(count(w, "status")).toBe(51);
    expect(w.did.filter((x) => x !== "status")).toEqual(["fetch 2.0.0", `install 2.0.0 in ${PREFIX}`]);
    expect([...w.there].sort()).toEqual([OLD, SLOT].sort());
    // The wait is the caller's to shorten.
    const short = await carry(plan([stop(7)]), {
      status: [st({ pid: 7, busy: "a headless agent run" })],
      settleMs: 1000,
    });
    expect(short.done).toEqual(waiting(7));
    expect(short.clock).toBe(1000);
    expect(short.did).toEqual(["status", "status", "status"]);
  });

  it("gone by the time it is asked: there is nothing to stop, and the rest goes on", async () => {
    const w = await carry(plan([stop(), use(), prove()]), { status: [null] });
    expect(w.did).toEqual(["status", "use 2.0.0, the service too", "prove"]);
    expect(w.said).toEqual([
      "ok: the fresh copy runs: `--version` says 2.0.0",
      `ok: a shell finds one sessionpipe: ${tilde(BIN)}`,
    ]);
    expect(w.done).toEqual(ONE);
    expect(w.clock).toBe(0);
  });

  it("another process answers by now (it was started again, or the service's own took the socket): nothing is stopped, and no signal goes to the number the plan saw", async () => {
    const nothingStopped = ["status", "use 2.0.0, the service too", "prove"];
    const went = [
      "ok: the fresh copy runs: `--version` says 2.0.0",
      `ok: a shell finds one sessionpipe: ${tilde(BIN)}`,
    ];
    // Free, and from before 0.15 with someone mid-turn: not asked to finish, nothing
    // written down for it, not signalled, and not said to be stopped.
    const other = await carry(plan([stop(), use(), prove()]), {
      status: [st({ pid: 99, mid_turn: ["s1"] })],
      health: SILENT,
    });
    expect(other.did).toEqual(nothingStopped);
    expect(other.said).toEqual(went);
    expect(other.done).toEqual(ONE);
    expect(other.clock).toBe(0);
    // Busy: its work is not this step's to wait for. Not "waiting", and the wait is not
    // waited out for it.
    const busy = await carry(plan([stop(), use(), prove()]), {
      status: [st({ pid: 99, busy: "a headless agent run" })],
    });
    expect(busy.did).toEqual(nothingStopped);
    expect(busy.done).toEqual(ONE);
    expect(busy.clock).toBe(0);
    for (const w of [other, busy]) expect(w.did.filter((x) => /^(quiesce|health|seed|stop)/.test(x))).toEqual([]);
  });

  it("busy when first looked at, and gone or replaced while it was waited for: the wait ends there, and nothing is stopped", async () => {
    // The one the plan saw ended by itself.
    const gone = await carry(plan([stop(), use(), prove()]), { status: [BUSY, BUSY, null] });
    expect(gone.did).toEqual(["status", "status", "status", "use 2.0.0, the service too", "prove"]);
    expect(gone.clock).toBe(1000);
    expect(gone.done).toEqual(ONE);
    // Another one answers in its place, busy itself: still not this step's.
    const replaced = await carry(plan([stop(), use(), prove()]), {
      status: [BUSY, st({ pid: 99, busy: "a headless agent run" })],
    });
    expect(replaced.did).toEqual(["status", "status", "use 2.0.0, the service too", "prove"]);
    expect(replaced.clock).toBe(500);
    expect(replaced.done).toEqual(ONE);
    for (const w of [gone, replaced]) expect(w.said.some((l) => l.includes("is stopped"))).toBe(false);
  });

  it("stopped is when it no longer answers: the service's own daemon answering in its place is what was wanted", async () => {
    // At once: no failure, and the ten seconds are not waited out.
    const atOnce = await carry(plan([stop(), use(), prove()]), { status: [st(), st({ pid: 99 })] });
    expect(atOnce.all).toEqual([
      "status",
      "quiesce",
      "health",
      "stop 41",
      "status",
      "ok: the daemon someone started by hand (pid 41) is stopped",
      "use 2.0.0, the service too",
      "prove",
      "ok: the fresh copy runs: `--version` says 2.0.0",
      `ok: a shell finds one sessionpipe: ${tilde(BIN)}`,
    ]);
    expect(atOnce.clock).toBe(0);
    expect(atOnce.done).toEqual(ONE);
    // After a moment in which the one that was signalled still answered: the same, and
    // only that moment was waited. The one that took its place may be busy already.
    const soon = await carry(plan([stop(), use(), prove()]), {
      status: [st(), st(), st(), st({ pid: 99, busy: "a headless agent run" })],
    });
    expect(soon.did).toEqual([
      "status",
      "quiesce",
      "health",
      "stop 41",
      "status",
      "status",
      "status",
      "use 2.0.0, the service too",
      "prove",
    ]);
    expect(soon.clock).toBe(1000);
    expect(soon.said[0]).toBe("ok: the daemon someone started by hand (pid 41) is stopped");
    expect(soon.done).toEqual(ONE);
    // It is signalled once, by the number the plan saw and the daemon itself gave.
    for (const w of [atOnce, soon]) expect(w.did.filter((x) => x.startsWith("stop"))).toEqual(["stop 41"]);
  });

  it("once it holds nothing it is told to finish, signalled, and seen to be gone before the service is moved", async () => {
    const w = await carry(plan([stop(), use(), prove()]), {
      status: [BUSY, BUSY, st(), st(), null],
    });
    expect(w.all).toEqual([
      "status",
      "status",
      "status",
      "quiesce",
      "health",
      "stop 41",
      "status",
      "status",
      "ok: the daemon someone started by hand (pid 41) is stopped",
      "use 2.0.0, the service too",
      "prove",
      "ok: the fresh copy runs: `--version` says 2.0.0",
      `ok: a shell finds one sessionpipe: ${tilde(BIN)}`,
    ]);
    // Two looks while it was busy, one while it was stopping.
    expect(w.clock).toBe(1500);
    expect(w.done).toEqual(ONE);
  });

  it("one from before 0.15 writes nothing down when it stops: who is mid-turn is left for the service that starts next", async () => {
    // What such a daemon called busy was never its to wait for (current.ts `holding`).
    const old = st({ busy: "a session on this machine mid-turn", mid_turn: ["s1", "s2"] });
    const before = await carry(plan([stop()]), { status: [old, null], health: SILENT });
    expect(before.did).toEqual(["status", "quiesce", "health", "seed s1,s2", "stop 41", "status"]);
    expect(before.clock).toBe(0);
    // One too old to know the question answers nothing: the same.
    const mute = await carry(plan([stop()]), { status: [old, null], health: null });
    expect(mute.did).toEqual(["status", "quiesce", "health", "seed s1,s2", "stop 41", "status"]);
    // A daemon of this release remembers by itself.
    const now = await carry(plan([stop()]), { status: [st({ mid_turn: ["s1"] }), null], health: SAYS });
    expect(now.did).toEqual(["status", "quiesce", "health", "stop 41", "status"]);
    // Nobody mid-turn, or a daemon that doesn't say who is: nothing to leave.
    const nobody = await carry(plan([stop()]), { status: [st({ mid_turn: [] }), null], health: SILENT });
    expect(nobody.did).toEqual(["status", "quiesce", "health", "stop 41", "status"]);
    const { mid_turn: _, ...bare } = st();
    const unsaid = await carry(plan([stop()]), { status: [bare as Status, null], health: SILENT });
    expect(unsaid.did).toEqual(["status", "quiesce", "health", "stop 41", "status"]);
    for (const w of [before, mute, now, nobody, unsaid])
      expect(w.said).toEqual(["ok: the daemon someone started by hand (pid 41) is stopped"]);
  });

  it("asked to stop and still answering: it fails there, with the hooks, the service and the other copies as they were", async () => {
    const w = await carry(plan([stop(), use(), remove(OLD), prove()]), { there: [OLD], status: [st()] });
    expect(w.done).toEqual({
      state: "failed",
      error: "the daemon someone started by hand (pid 41) was asked to stop and still answers",
      next: "sessionpipe reinstall",
    });
    // Ten seconds by default.
    expect(w.clock).toBe(10_000);
    expect(w.did.slice(0, 4)).toEqual(["status", "quiesce", "health", "stop 41"]);
    expect(count(w, "status")).toBe(1 + 21);
    expect(count(w, "stop 41")).toBe(1);
    expect(w.did.filter((x) => /^(use|remove|prove)/.test(x))).toEqual([]);
    expect(w.said).toEqual([]);
    const short = await carry(plan([stop()]), { status: [st()], stopMs: 1500 });
    expect(short.done.state).toBe("failed");
    expect(short.clock).toBe(1500);
    expect(count(short, "status")).toBe(1 + 4);
  });
});

describe("a service file nothing needs", () => {
  it("is removed before the hooks are written, and the line says so", async () => {
    const w = await carry(plan([fetch(), install(), unserve(), use(false), prove()]));
    expect(w.all.slice(3, 7)).toEqual([
      "ok: installed fresh in ~/.local, and it runs",
      "unserve",
      "ok: the service file nothing here needs is removed",
      "use 2.0.0",
    ]);
    expect(w.done).toEqual(ONE);
  });
});

describe("the hooks and the service onto the fresh copy", () => {
  const BUSY_SAID =
    "The background service is busy: a headless agent run. It restarts by itself onto sessionpipe 2.0.0 when that is done: nothing more to type.";

  it("update's own steps are run for the release that was installed, with or without a service to move", async () => {
    expect((await carry(plan([use(true)], { target: "2.1.0" }))).did).toEqual(["use 2.1.0, the service too"]);
    expect((await carry(plan([use(false)], { target: "2.1.0" }))).did).toEqual(["use 2.1.0"]);
  });

  it("a failure of theirs stops it before anything is removed; `sessionpipe update` as the next step is this command", async () => {
    const steps = [fetch(), install(), use(), remove(OLD), prove()];
    const w = await carry(plan(steps), {
      there: [OLD],
      use: {
        state: "failed",
        error: "the background service was restarted and doesn't answer",
        next: "sessionpipe update",
      },
    });
    expect(w.done).toEqual({
      state: "failed",
      error: "the background service was restarted and doesn't answer",
      next: "sessionpipe reinstall",
    });
    expect(w.did).toEqual(["fetch 2.0.0", `install 2.0.0 in ${PREFIX}`, "use 2.0.0, the service too"]);
    expect(w.there.has(OLD)).toBe(true);
    // Any other next step is theirs to name.
    const other = await carry(plan(steps), {
      use: { state: "failed", error: "the hooks couldn't be written", next: "sessionpipe doctor" },
    });
    expect(other.done).toEqual({
      state: "failed",
      error: "the hooks couldn't be written",
      next: "sessionpipe doctor",
    });
  });

  it("a busy service that runs the fresh copy restarts by itself: everything else is removed, and nothing is proven yet", async () => {
    const w = await carry(plan([fetch(), install(true), use(), remove(LEFTOVER), remove(OLD), prove()]), {
      there: [SLOT, LEFTOVER, OLD],
      use: { state: "waiting", version: "2.0.0", said: BUSY_SAID },
      serviceDir: SLOT,
    });
    // The sentence is update's own: no copy waits for it.
    expect(w.done).toEqual({ state: "waiting", said: BUSY_SAID });
    expect(w.did.slice(4)).toEqual(["use 2.0.0, the service too", `remove ${LEFTOVER}`, `remove ${OLD}`]);
    expect(count(w, "prove")).toBe(0);
    expect([...w.there]).toEqual([SLOT]);
  });

  it("a busy service that runs another copy keeps that copy: the rest goes, and it says to run once more", async () => {
    const w = await carry(plan([fetch(), install(), use(), remove(LEFTOVER), remove(OLD), remove(NPX), prove()]), {
      there: [LEFTOVER, OLD, NPX],
      use: {
        state: "waiting",
        version: "2.0.0",
        said: "The background service is busy: a headless agent run. Moving it onto this copy now would cut that short; when it is done, run `sessionpipe update` once more.",
      },
      // The service file may spell the same folder another way.
      serviceDir: path.join(OLD, "dist", ".."),
    });
    expect(w.done).toEqual({
      state: "waiting",
      said: `The background service is busy: a headless agent run. It still runs from ${tilde(path.join(OLD, "dist", ".."))}, which stays until that is done. Then run \`sessionpipe reinstall\` once more: it moves the service and removes that last copy.`,
    });
    expect(w.did.slice(2)).toEqual(["use 2.0.0, the service too", `remove ${LEFTOVER}`, `remove ${NPX}`]);
    expect(w.said.slice(2)).toEqual([
      "ok: removed a leftover folder in ~/.nvm/versions/node/v22.1.0",
      "ok: removed 2.0.0 in ~/.npm/_npx/0a1b2c3d",
    ]);
    expect(count(w, "prove")).toBe(0);
    expect([...w.there].sort()).toEqual([OLD, SLOT].sort());
  });

  it("a busy service whose file names no copy: update's sentence stands, and every removal is made", async () => {
    const w = await carry(plan([use(), remove(OLD), prove()]), {
      there: [OLD],
      use: { state: "waiting", version: "2.0.0", said: BUSY_SAID },
      serviceDir: null,
    });
    expect(w.done).toEqual({ state: "waiting", said: BUSY_SAID });
    expect(w.did).toEqual(["use 2.0.0, the service too", `remove ${OLD}`]);
  });

  it('the command update names for "once more" is this one, wherever its sentence ends up: update would leave the other copies', async () => {
    const once =
      "The background service is busy: a headless agent run. Moving it onto this copy now would cut that short; when it is done, run `sessionpipe update` once more.";
    // Returned as it is (the service's file names no copy that goes): the command is this one.
    const asIs = await carry(plan([use(), remove(OLD), prove()]), {
      there: [OLD],
      use: { state: "waiting", version: "2.0.0", said: once },
      serviceDir: null,
    });
    expect(asIs.done).toEqual({
      state: "waiting",
      said: "The background service is busy: a headless agent run. Moving it onto this copy now would cut that short; when it is done, run `sessionpipe reinstall` once more.",
    });
    // The same where the service runs a copy that is left alone (no step removes it).
    const kept = await carry(plan([use(), remove(OLD), prove()]), {
      there: [OLD],
      use: { state: "waiting", version: "2.0.0", said: once },
      serviceDir: NPX,
    });
    expect(kept.done).toEqual(asIs.done);
    // Every time it is named, not only the first.
    const twice = await carry(plan([use()]), {
      use: {
        state: "waiting",
        version: "2.0.0",
        said: "`sessionpipe update` can't move it yet. When it is done, run `sessionpipe update` once more.",
      },
    });
    expect(twice.done).toEqual({
      state: "waiting",
      said: "`sessionpipe reinstall` can't move it yet. When it is done, run `sessionpipe reinstall` once more.",
    });
    // And where only its first sentence is kept, with this command's own after it.
    const first = await carry(plan([use(), remove(OLD), prove()]), {
      there: [OLD],
      use: {
        state: "waiting",
        version: "2.0.0",
        said: "When the background service is done, run `sessionpipe update` once more. It is busy: a headless agent run.",
      },
      serviceDir: OLD,
    });
    expect(first.done).toEqual({
      state: "waiting",
      said: `When the background service is done, run \`sessionpipe reinstall\` once more. It still runs from ${tilde(OLD)}, which stays until that is done. Then run \`sessionpipe reinstall\` once more: it moves the service and removes that last copy.`,
    });
    for (const w of [asIs, kept, twice, first])
      expect(w.done.state === "waiting" && w.done.said).not.toContain("sessionpipe update");
  });

  it("what update says is not as it should be is said beside the one copy", async () => {
    const warn = "The background service hasn't heard from r.example yet. `sessionpipe doctor` looks again.";
    const w = await carry(plan([use(), prove()]), {
      use: { state: "current", version: "2.0.0", said: "This computer is up to date.", warn },
    });
    expect(w.done).toEqual({ ...ONE, warn: [warn] });
  });
});

describe("the removals", () => {
  it('each is said in the plan\'s own words for it; "with its link" only where the removal answered more than the folder', async () => {
    const said = async (p: string, bins: string[] = [], row?: string) =>
      (await carry(plan([remove(p, row)]), { there: [p], bins: { [p]: bins } })).said;
    // A copy with npm's link beside it: both went, and the line says so.
    expect(await said(OLD, [OLD_BIN])).toEqual(["ok: removed 1.0.0 in ~/.nvm/versions/node/v22.1.0, with its link"]);
    // Windows writes three shims for one copy: still "its link", once.
    expect(await said(OLD, [OLD_BIN, `${OLD_BIN}.cmd`, `${OLD_BIN}.ps1`])).toEqual([
      "ok: removed 1.0.0 in ~/.nvm/versions/node/v22.1.0, with its link",
    ]);
    // A copy that had none, npm's leftover, a cache entry: the folder is all that went.
    expect(await said(OLD)).toEqual(["ok: removed 1.0.0 in ~/.nvm/versions/node/v22.1.0"]);
    expect(await said(LEFTOVER)).toEqual(["ok: removed a leftover folder in ~/.nvm/versions/node/v22.1.0"]);
    expect(await said(NPX)).toEqual(["ok: removed 2.0.0 in ~/.npm/_npx/0a1b2c3d"]);
    // A link that led nowhere is the one thing removed: it is not "with its link".
    expect(await said(LINK)).toEqual([`ok: removed ${LINK} (a link to a copy that is gone)`]);
    // The words are the row's, whatever they are: the run adds no path of its own to them.
    expect(await said(OLD, [], "the broken copy in /opt/homebrew")).toEqual([
      "ok: removed the broken copy in /opt/homebrew",
    ]);
    expect(await said(OLD, [OLD_BIN], "the broken copy in /opt/homebrew")).toEqual([
      "ok: removed the broken copy in /opt/homebrew, with its link",
    ]);
  });

  it("a copy that can't be removed stays and is said in yellow; the rest still goes, and what is left names the one that stayed", async () => {
    const why = `${OLD} was left alone: it holds src, which no published sessionpipe has (a checkout or a build?)`;
    const w = await carry(plan([use(), remove(LEFTOVER), remove(OLD), remove(NPX), prove()]), {
      there: [LEFTOVER, OLD, NPX],
      stuck: { [OLD]: why },
    });
    expect(w.all).toEqual([
      "use 2.0.0, the service too",
      `remove ${LEFTOVER}`,
      "ok: removed a leftover folder in ~/.nvm/versions/node/v22.1.0",
      `remove ${OLD}`,
      `warn: ${tilde(OLD)} could not be removed: ${why}`,
      `remove ${NPX}`,
      "ok: removed 2.0.0 in ~/.npm/_npx/0a1b2c3d",
      "prove",
      "ok: the fresh copy runs: `--version` says 2.0.0",
      `ok: a shell finds one sessionpipe: ${tilde(BIN)}`,
      "ok: nothing here names a removed copy any more",
    ]);
    // What stayed was not removed, so nothing is looked for under its name.
    expect(w.proved).toEqual([[LEFTOVER, NPX]]);
    // No failure: the fresh copy is in use, and that is said first. What is left is its
    // own sentence, the folder as a person reads it, with why it stayed.
    expect(w.done).toEqual({
      state: "left",
      said: "sessionpipe 2.0.0 is installed in ~/.local and in use. Pairings and settings are as they were.",
      warn: [],
      still: `One other copy is still there: ${tilde(OLD)} (${why}).`,
      next: "sessionpipe reinstall",
    });
    expect([...w.there]).toEqual([OLD]);
  });

  it("several that stay are counted, each with its reason", async () => {
    const w = await carry(plan([remove(OLD), remove(NPX), prove()]), {
      there: [OLD, NPX],
      stuck: { [OLD]: "EACCES: permission denied", [NPX]: "EBUSY: resource busy or locked" },
    });
    expect(w.done).toEqual(
      LEFT(
        `2 other copies are still there: ${tilde(OLD)} (EACCES: permission denied); ${tilde(NPX)} (EBUSY: resource busy or locked).`,
      ),
    );
    // Nothing was removed, so there is nothing to say of removed copies.
    expect(w.said).toEqual([
      `warn: ${tilde(OLD)} could not be removed: EACCES: permission denied`,
      `warn: ${tilde(NPX)} could not be removed: EBUSY: resource busy or locked`,
      "ok: the fresh copy runs: `--version` says 2.0.0",
      `ok: a shell finds one sessionpipe: ${tilde(BIN)}`,
    ]);
  });
});

describe("the proof", () => {
  it("the fresh copy printing another version, or nothing, fails with the way in that needs no working copy", async () => {
    const steps = [fetch(), install(), use(), remove(OLD), prove()];
    const other = await carry(plan(steps), { there: [OLD], proof: { runs: "1.0.0" } });
    expect(other.done).toEqual({
      state: "failed",
      error: "the fresh copy in ~/.local doesn't run as it should (`--version` printed 1.0.0)",
      next: "npx -y sessionpipe@latest reinstall",
    });
    expect(other.said.at(-1)).toBe("ok: removed 1.0.0 in ~/.nvm/versions/node/v22.1.0");
    const silent = await carry(plan(steps), { there: [OLD], proof: { runs: null } });
    expect(silent.done).toEqual({
      state: "failed",
      error: "the fresh copy in ~/.local doesn't run as it should (`--version` printed nothing)",
      next: "npx -y sessionpipe@latest reinstall",
    });
    // Whatever a shell finds: a copy that doesn't run is the one thing said.
    const found = await carry(plan(steps), { there: [OLD], proof: { runs: null, onPath: [BIN], first: true } });
    expect(found.done).toEqual(silent.done);
    expect(found.said.at(-1)).toBe("ok: removed 1.0.0 in ~/.nvm/versions/node/v22.1.0");
  });

  it("a shell that finds this copy and nothing else: said in green, with the file it finds", async () => {
    const w = await carry(plan([use(), prove()]), { proof: { onPath: [BIN], first: true } });
    expect(w.said).toEqual([
      "ok: the fresh copy runs: `--version` says 2.0.0",
      `ok: a shell finds one sessionpipe: ${tilde(BIN)}`,
    ]);
    expect(w.done).toEqual(ONE);
  });

  it("a shell that finds several, this copy first: said as it is, with what is behind it in its order, and no warning", async () => {
    const several = await carry(plan([use(), prove()]), { proof: { onPath: [BIN, OLD_BIN, LINK], first: true } });
    // What is behind it starts nothing a person types: nothing to look at, so no warning.
    expect(several.done).toEqual(ONE);
    // Not "finds one": that line is only for one. And not the fresh copy's own file again.
    expect(several.said).toEqual([
      "ok: the fresh copy runs: `--version` says 2.0.0",
      `info: a shell finds this copy first; behind it: ${tilde(OLD_BIN)}, ${LINK}`,
    ]);
    // One behind it, a folder under the home said as a person reads it.
    const two = await carry(plan([use(), prove()]), { proof: { onPath: [BIN, OLD_BIN], first: true } });
    expect(two.done).toEqual(ONE);
    expect(two.said.at(-1)).toBe(`info: a shell finds this copy first; behind it: ${tilde(OLD_BIN)}`);
    expect(tilde(OLD_BIN).startsWith("~")).toBe(true);
    // Whatever the plan expected to be first: with the fresh copy first, that is all there is to say.
    const expected = await carry(plan([use(), prove()], { first: LINK }), {
      proof: { onPath: [BIN, LINK], first: true },
    });
    expect(expected.done).toEqual(ONE);
    expect(expected.said.at(-1)).toBe(`info: a shell finds this copy first; behind it: ${LINK}`);
  });

  it("what a shell finds first is not this copy: what a person types is still the other one, and that is the warning", async () => {
    // Several, another first.
    const behind = await carry(plan([use(), prove()]), { proof: { onPath: [OLD_BIN, BIN], first: false } });
    expect(behind.done).toEqual({
      ...ONE,
      warn: [`Typing \`sessionpipe\` still starts ${tilde(OLD_BIN)}, not the fresh copy.`],
    });
    // Neither line about what a shell finds is said: the warning is.
    expect(behind.said).toEqual(["ok: the fresh copy runs: `--version` says 2.0.0"]);
    // One only, and it is not this copy: never "a shell finds one sessionpipe".
    const other = await carry(plan([use(), prove()]), { proof: { onPath: [LINK], first: false } });
    expect(other.done).toEqual({ ...ONE, warn: [TYPING(LINK)] });
    expect(other.said).toEqual(["ok: the fresh copy runs: `--version` says 2.0.0"]);
  });

  it("what the plan saw coming is said by its own note, and not a second time: only another file is news", async () => {
    const found = { proof: { onPath: [LINK, BIN], first: false } };
    const still = TYPING(LINK);
    const fresh = ["ok: the fresh copy runs: `--version` says 2.0.0"];
    // The plan named no such file: the proof is the first to say it.
    const unseen = await carry(plan([use(), prove()], { first: null }), found);
    expect(unseen.done).toEqual({ ...ONE, warn: [still] });
    // The plan named this very file, and its note says so on the last line: nothing is
    // added, and with nothing else to say there is no warning at all.
    const seen = await carry(plan([use(), prove()], { first: LINK }), found);
    expect(seen.done).toEqual(ONE);
    expect(seen.said).toEqual(fresh);
    // The same file under another spelling, on either side, is the same file.
    const dotted = [path.dirname(LINK), ".", path.basename(LINK)].join(path.sep);
    const around = [path.dirname(LINK), "..", path.basename(path.dirname(LINK)), path.basename(LINK)].join(path.sep);
    expect(dotted).not.toBe(LINK);
    expect((await carry(plan([use(), prove()], { first: dotted }), found)).done).toEqual(ONE);
    expect(
      (await carry(plan([use(), prove()], { first: LINK }), { proof: { onPath: [around, BIN], first: false } })).done,
    ).toEqual(ONE);
    // The plan named another file than the one a shell finds now: the warning names what
    // the proof found, not what the plan expected.
    const other = await carry(plan([use(), prove()], { first: OLD_BIN }), found);
    expect(other.done).toEqual({ ...ONE, warn: [still] });
    // What else there is to say is said all the same.
    const plist = path.join(HOME, "Library", "LaunchAgents", "org.sessionpipe.control.plist");
    const more = await carry(plan([use(), remove(OLD), prove()], { first: LINK }), {
      there: [OLD],
      use: { state: "current", version: "2.0.0", said: "", warn: "A receiver hasn't answered." },
      proof: { ...found.proof, named: [{ file: plist, path: OLD }] },
    });
    expect(more.done).toEqual({
      ...ONE,
      warn: ["A receiver hasn't answered.", `${tilde(plist)} still names ${tilde(OLD)}, which was removed.`],
    });
    // A plan that expected another file first, and a shell that finds the fresh copy:
    // nothing of what is typed is said here.
    const better = await carry(plan([use(), prove()], { first: LINK }));
    expect(better.done).toEqual(ONE);
    expect(better.said).toEqual([...fresh, `ok: a shell finds one sessionpipe: ${tilde(BIN)}`]);
  });

  it("a shell that finds none is said by neither line: the plan's own note says the folder is not on PATH", async () => {
    const none = await carry(plan([use(), prove()]), { proof: { onPath: [], first: false } });
    expect(none.done).toEqual(ONE);
    expect(none.said).toEqual(["ok: the fresh copy runs: `--version` says 2.0.0"]);
  });

  it("a file that still names a removed copy is a warning, and then nothing says it is clean", async () => {
    const plist = path.join(HOME, "Library", "LaunchAgents", "org.sessionpipe.control.plist");
    const settings = path.join(HOME, ".claude", "settings.json");
    const w = await carry(plan([use(), remove(OLD), prove()]), {
      there: [OLD],
      bins: { [OLD]: [OLD_BIN] },
      proof: {
        named: [
          { file: plist, path: OLD },
          { file: settings, path: OLD_BIN },
        ],
      },
    });
    expect(w.done).toEqual({
      ...ONE,
      warn: [
        `${tilde(plist)} still names ${tilde(OLD)}, which was removed.`,
        `${tilde(settings)} still names ${tilde(OLD_BIN)}, which was removed.`,
      ],
    });
    expect(w.said).toEqual([
      "ok: removed 1.0.0 in ~/.nvm/versions/node/v22.1.0, with its link",
      "ok: the fresh copy runs: `--version` says 2.0.0",
      `ok: a shell finds one sessionpipe: ${tilde(BIN)}`,
    ]);
    // With update's own warning, and several on PATH: every warning is kept, in the order
    // found; what is behind the fresh copy on PATH is a line of the run, and no warning.
    const all = await carry(plan([use(), remove(OLD), prove()]), {
      there: [OLD],
      use: { state: "current", version: "2.0.0", said: "", warn: "A receiver hasn't answered." },
      proof: { onPath: [BIN, LINK], named: [{ file: plist, path: OLD }] },
    });
    expect(all.done).toEqual({
      ...ONE,
      warn: ["A receiver hasn't answered.", `${tilde(plist)} still names ${tilde(OLD)}, which was removed.`],
    });
    expect(all.said).toEqual([
      "ok: removed 1.0.0 in ~/.nvm/versions/node/v22.1.0",
      "ok: the fresh copy runs: `--version` says 2.0.0",
      `info: a shell finds this copy first; behind it: ${LINK}`,
    ]);
    // And with another copy typed still: that warning comes before what still names a removed copy.
    const typed = await carry(plan([use(), remove(OLD), prove()]), {
      there: [OLD],
      proof: { onPath: [LINK, BIN], first: false, named: [{ file: plist, path: OLD }] },
    });
    expect(typed.done).toEqual({
      ...ONE,
      warn: [TYPING(LINK), `${tilde(plist)} still names ${tilde(OLD)}, which was removed.`],
    });
  });
});

describe("what is left: the fresh copy is in use, and a copy that should have gone is still there", () => {
  it("a published copy this user can't remove means the job isn't done: what works is said first, then what is left, and its own line is the next step", async () => {
    const w = await carry(plan([use(), remove(OLD), prove()], { left: [left()] }), { there: [OLD] });
    expect(w.done).toEqual({
      state: "left",
      // What works: the same words as of one copy, less the claim that it is the only one.
      said: "sessionpipe 2.0.0 is installed in ~/.local and in use. Pairings and settings are as they were.",
      warn: [],
      // The copy by its release and its folder; the command is not said twice, only that it needs sudo.
      still: "One other copy is still there: 1.0.0 in /usr/local (needs sudo).",
      next: SUDO,
    });
    // Everything it could do was done first, and said as ever.
    expect(w.did).toEqual(["use 2.0.0, the service too", `remove ${OLD}`, "prove"]);
    expect(w.said).toEqual([
      "ok: removed 1.0.0 in ~/.nvm/versions/node/v22.1.0",
      "ok: the fresh copy runs: `--version` says 2.0.0",
      `ok: a shell finds one sessionpipe: ${tilde(BIN)}`,
      "ok: nothing here names a removed copy any more",
    ]);
    // It is named as a person reads it; its whole path is the plan's to keep, and no step's.
    const done = w.done as Extract<Done, { state: "left" }>;
    for (const sentence of [done.said, done.still, done.next]) expect(sentence).not.toContain(left().path);
    expect(w.did.join("\n")).not.toContain(left().path);
    // It is no failure: a failure has no "what works" to say.
    expect(w.done.state).not.toBe("failed");
  });

  it("a copy with no line of its own says why it stays; a broken one is named as that", async () => {
    const still = async (...l: Left[]) => {
      const done = (await carry(plan([prove()], { left: l }))).done;
      return done.state === "left" ? [done.still, done.next] : done;
    };
    // Windows, or npm's own leftover: no sudo line, so the reason is said.
    expect(await still(left({ line: null }))).toEqual([
      "One other copy is still there: 1.0.0 in /usr/local (you may not write where it is).",
      "sessionpipe reinstall",
    ]);
    // A copy that says no release.
    expect(await still(left({ version: null }))).toEqual([
      "One other copy is still there: a broken copy in /usr/local (needs sudo).",
      SUDO,
    ]);
    expect(await still(left({ version: null, line: null, where: "C:\\Program Files\\nodejs" }))).toEqual([
      "One other copy is still there: a broken copy in C:\\Program Files\\nodejs (you may not write where it is).",
      "sessionpipe reinstall",
    ]);
    // What is no install of it is not a copy this command would have removed: it is not
    // counted, whatever line its keeper has for it.
    expect(await still(left({ ours: false, line: "volta uninstall sessionpipe" }))).toEqual(ONE);
    expect(await still(left({ ours: false }), left({ where: "/opt/node" }))).toEqual([
      "One other copy is still there: 1.0.0 in /opt/node (needs sudo).",
      SUDO,
    ]);
  });

  it("several are chained into one line, in order; one with no line of its own adds none", async () => {
    const opt = left({
      where: "/opt/node",
      path: slotOf(path.join(path.sep, "opt", "node")),
      line: "sudo npm uninstall -g --prefix /opt/node sessionpipe",
    });
    const cache = left({
      where: "the npx cache (/root/.npm/_npx/0a1b)",
      path: path.join(path.sep, "root", ".npm", "_npx", "0a1b", "node_modules", "sessionpipe"),
      line: null,
    });
    const w = await carry(plan([prove()], { left: [left(), cache, opt, left({ ours: false, line: null })] }));
    expect(w.done).toEqual(
      LEFT(
        "3 other copies are still there: 1.0.0 in /usr/local (needs sudo); 1.0.0 in the npx cache (/root/.npm/_npx/0a1b) (you may not write where it is); 1.0.0 in /opt/node (needs sudo).",
        "sudo npm uninstall -g --prefix /usr/local sessionpipe && sudo npm uninstall -g --prefix /opt/node sessionpipe",
      ),
    );
    // Two of them: counted as two, joined once.
    const two = await carry(plan([prove()], { left: [opt, left()] }));
    expect(two.done).toEqual(
      LEFT(
        "2 other copies are still there: 1.0.0 in /opt/node (needs sudo); 1.0.0 in /usr/local (needs sudo).",
        "sudo npm uninstall -g --prefix /opt/node sessionpipe && sudo npm uninstall -g --prefix /usr/local sessionpipe",
      ),
    );
  });

  it("with no line for any of them (Windows, a cache entry, a removal that failed) the next step is this command again", async () => {
    const w = await carry(plan([remove(OLD), prove()], { left: [left({ line: null })] }), {
      there: [OLD],
      stuck: { [OLD]: "EBUSY: resource busy or locked" },
    });
    // What the plan left comes first, then what a removal could not take: the first by
    // its release and folder, the second by the folder and what the system said.
    expect(w.done).toEqual(
      LEFT(
        `2 other copies are still there: 1.0.0 in /usr/local (you may not write where it is); ${tilde(OLD)} (EBUSY: resource busy or locked).`,
      ),
    );
    // A line there is, is the one to run, whatever else stayed.
    const mixed = await carry(plan([remove(OLD), prove()], { left: [left()] }), {
      there: [OLD],
      stuck: { [OLD]: "EBUSY: resource busy or locked" },
    });
    expect(mixed.done).toEqual(
      LEFT(
        `2 other copies are still there: 1.0.0 in /usr/local (needs sudo); ${tilde(OLD)} (EBUSY: resource busy or locked).`,
        SUDO,
      ),
    );
    // Two lines and a removal that failed: the two lines, joined; the third adds nothing to run.
    const opt = left({ where: "/opt/node", line: "sudo npm uninstall -g --prefix /opt/node sessionpipe" });
    const three = await carry(plan([remove(NPX), prove()], { left: [left(), opt] }), {
      there: [NPX],
      stuck: { [NPX]: "EPERM: operation not permitted" },
    });
    expect(three.done).toEqual(
      LEFT(
        `3 other copies are still there: 1.0.0 in /usr/local (needs sudo); 1.0.0 in /opt/node (needs sudo); ${tilde(NPX)} (EPERM: operation not permitted).`,
        `${SUDO} && sudo npm uninstall -g --prefix /opt/node sessionpipe`,
      ),
    );
  });

  it("a copy that stays, and what a shell finds first is not the fresh copy: a warning beside what is left, unless the plan's own note says it", async () => {
    const still = "One other copy is still there: 1.0.0 in /usr/local (needs sudo).";
    const behind = { proof: { onPath: [OLD_BIN, BIN], first: false } };
    // The plan named no file, or another one: the run is the first to say it.
    for (const first of [null, LINK]) {
      const w = await carry(plan([use(), prove()], { left: [left()], first }), behind);
      expect(w.done).toEqual(LEFT(still, SUDO, [TYPING(tilde(OLD_BIN))]));
    }
    // The plan saw this very file coming: its note is said with the rest, and not twice.
    const seen = await carry(plan([use(), prove()], { left: [left()], first: OLD_BIN }), behind);
    expect(seen.done).toEqual(LEFT(still, SUDO));
    // The same after a removal that threw; the path is said as a person reads it.
    const threw = await carry(plan([remove(NPX), prove()]), {
      there: [NPX],
      stuck: { [NPX]: "EBUSY: resource busy or locked" },
      proof: { onPath: [OLD_BIN], first: false },
    });
    expect(threw.done).toEqual(
      LEFT(`One other copy is still there: ${tilde(NPX)} (EBUSY: resource busy or locked).`, "sessionpipe reinstall", [
        TYPING(tilde(OLD_BIN)),
      ]),
    );
    expect(tilde(OLD_BIN).startsWith("~")).toBe(true);
    // What is typed is never part of the sentence about what is left.
    for (const w of [seen, threw]) expect(w.done.state === "left" && w.done.still).not.toContain("Typing");
  });

  it("what else there is to say is said beside it: update's warning, a file that still names a removed copy", async () => {
    const plist = path.join(HOME, "Library", "LaunchAgents", "org.sessionpipe.control.plist");
    const w = await carry(plan([use(), remove(OLD), prove()], { left: [left()] }), {
      there: [OLD],
      use: { state: "current", version: "2.0.0", said: "", warn: "A receiver hasn't answered." },
      proof: { onPath: [LINK, BIN], first: false, named: [{ file: plist, path: OLD }] },
    });
    expect(w.done).toEqual(
      LEFT("One other copy is still there: 1.0.0 in /usr/local (needs sudo).", SUDO, [
        "A receiver hasn't answered.",
        TYPING(LINK),
        `${tilde(plist)} still names ${tilde(OLD)}, which was removed.`,
      ]),
    );
  });

  it("a copy that stays says nothing of what is typed where the fresh copy is first, nothing is on PATH, or nothing was proven", async () => {
    const stays = LEFT("One other copy is still there: 1.0.0 in /usr/local (needs sudo).", SUDO);
    const stay = (steps: Step[], first: string | null = null) => plan(steps, { left: [left()], first });
    // The fresh copy is what a shell finds: alone, or first of several (the copy that
    // stays is then behind it, and the run's own line says so).
    expect((await carry(stay([use(), prove()]))).done).toEqual(stays);
    const several = await carry(stay([use(), prove()]), { proof: { onPath: [BIN, OLD_BIN], first: true } });
    expect(several.done).toEqual(stays);
    expect(several.said.at(-1)).toBe(`info: a shell finds this copy first; behind it: ${tilde(OLD_BIN)}`);
    // A shell finds none.
    expect((await carry(stay([use(), prove()]), { proof: { onPath: [], first: false } })).done).toEqual(stays);
    // No proof was asked for: what the plan expected is the plan's to say, not the run's.
    const unproven = await carry(stay([use()], LINK));
    expect(unproven.done).toEqual(stays);
    expect(count(unproven, "prove")).toBe(0);
  });

  it("a service still at work comes first: what is left is the next run's to say", async () => {
    const said =
      "The background service is busy: a headless agent run. It restarts by itself onto sessionpipe 2.0.0 when that is done: nothing more to type.";
    const w = await carry(plan([use(), remove(OLD), prove()], { left: [left()] }), {
      there: [OLD],
      stuck: { [OLD]: "EBUSY: resource busy or locked" },
      use: { state: "waiting", version: "2.0.0", said },
    });
    expect(w.done).toEqual({ state: "waiting", said });
  });

  it("what is no install of it was left alone: the plan's own rows said so, and the run adds nothing to its last line", async () => {
    const checkout = left({
      where: "~/src/sessionpipe",
      path: path.join(HOME, "src", "sessionpipe"),
      why: "it holds src",
      line: null,
      ours: false,
    });
    const volta = left({
      where: "~/.volta",
      path: slotOf(path.join(HOME, ".volta", "tools", "image", "packages", "sessionpipe")),
      why: "Volta keeps it",
      line: "volta uninstall sessionpipe",
      ours: false,
    });
    // One copy, whatever stays that is none: no warning, and nothing counted.
    const one = await carry(plan([use(), prove()], { left: [checkout] }));
    expect(one.done).toEqual(ONE);
    const two = await carry(plan([use(), prove()], { left: [checkout, volta] }), {
      proof: { onPath: [BIN, LINK] },
    });
    expect(two.done).toEqual(ONE);
    expect(two.said.at(-1)).toBe(`info: a shell finds this copy first; behind it: ${LINK}`);
    // Beside a copy of ours that stays, they are still not counted, and their line is not the next step.
    const mixed = await carry(plan([use(), prove()], { left: [checkout, volta, left()] }));
    expect(mixed.done).toEqual(LEFT("One other copy is still there: 1.0.0 in /usr/local (needs sudo).", SUDO));
  });
});

describe("the steps a plan may hold", () => {
  it("each kind is carried out by its own effect and by no other", async () => {
    const each: Record<Kind, [Step, string[]]> = {
      fetch: [fetch(), ["fetch 2.0.0"]],
      install: [install(), [`install 2.0.0 in ${PREFIX}`]],
      stop: [stop(), ["status"]],
      unserve: [unserve(), ["unserve"]],
      use: [use(), ["use 2.0.0, the service too"]],
      remove: [remove(OLD), [`remove ${OLD}`]],
      prove: [prove(), ["prove"]],
    };
    for (const [step, did] of Object.values(each)) expect((await carry(plan([step]))).did).toEqual(did);
    // No step at all: nothing is done, and the sentence is still the plan's.
    const none = await carry(plan([]));
    expect(none.all).toEqual([]);
    expect(none.done).toEqual(ONE);
  });
});
