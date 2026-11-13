// SPDX-License-Identifier: Apache-2.0
// reinstall/run.ts: a plan carried out, one step after the other. Everything that would
// touch the computer is stood in for and written down in the order it happened, the plan
// is a literal, the disk is a list of folders, and time is a counter: each way a run can
// go is one test, with no file, no process and no clock in it. (The last test is the one
// exception: what the swap leaves beside the slot is handed to the real proof and the
// real removal, in a folder of its own, to see that they take it.)
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Status } from "../src/control/daemon.js";
import type { Health } from "../src/control/local.js";
import type { Outcome } from "../src/current.js";
import { binTarget, ASIDE as LEFT_BEHIND, remove as removeOurs, same } from "../src/reinstall/ours.js";
import { type Left, plan as makePlan, type Plan, type Step } from "../src/reinstall/plan.js";
import { carryOut, type Doing, type Done, type Proof } from "../src/reinstall/run.js";
import { world } from "./helpers/reinstall-worlds.js";

const HOME = path.join(path.sep, "home", "u");
/** The home of the fresh copy and its slot. */
const PREFIX = path.join(HOME, ".local");
const MODULES = path.join(PREFIX, "lib", "node_modules");
const SLOT = path.join(MODULES, "sessionpipe");
const BIN = path.join(PREFIX, "bin", "sessionpipe");
/** The two names a fresh install asks for, in the order it asks: the folder npm installs
 *  into beside the slot (a prefix of its own, with the copy where npm puts one), and the
 *  name what is in the slot steps aside under. */
const IDS = ["a1b2c3d4", "e5f6a7b8"] as const;
const STAGE = path.join(MODULES, `.sessionpipe-${IDS[0]}`);
const STAGED = path.join(STAGE, "lib", "node_modules", "sessionpipe");
const ASIDE = path.join(MODULES, `.sessionpipe-${IDS[1]}`);
/** An older copy under nvm with its bin link, and what npm left beside it. */
const NVM = path.join(HOME, ".nvm", "versions", "node", "v22.1.0");
const OLD = path.join(NVM, "lib", "node_modules", "sessionpipe");
const OLD_BIN = path.join(NVM, "bin", "sessionpipe");
const LEFTOVER = path.join(NVM, "lib", "node_modules", ".sessionpipe-Zz9Yy8Xx");
/** The copy the command itself runs from, and a link outside the home that leads nowhere. */
const NPX = path.join(HOME, ".npm", "_npx", "0a1b2c3d", "node_modules", "sessionpipe");
const LINK = path.join(path.sep, "usr", "local", "bin", "sessionpipe");
const tilde = (p: string): string => (p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p);
/** The way in that needs no working copy on this computer. */
const BY_NPX = "npx -y sessionpipe@latest reinstall";

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
    onPath: true,
    blocked: null,
    writable: true,
  },
  stays: null,
  steps,
  // The plan's screen says it; the run has nothing to do with it.
  safety: ["Nothing is touched until 2.0.0 has been downloaded and seen to run."],
  inferred: null,
  kept: 0,
  left: [],
  notes: [],
  ...o,
});

/** The package folder of a prefix: what a left copy is by its whole path. */
const slotOf = (prefix: string): string => path.join(prefix, "lib", "node_modules", "sessionpipe");
/** The line a plan writes for a copy this user may not write: the folder and its own
 *  link, by name. The run hands it on as it is. */
const SUDO = "sudo rm -r /usr/local/lib/node_modules/sessionpipe /usr/local/bin/sessionpipe";
const left = (o: Partial<Left> = {}): Left => ({
  where: "/usr/local",
  path: slotOf(path.join(path.sep, "usr", "local")),
  version: "1.0.0",
  why: "you may not write where it is",
  line: SUDO,
  ours: true,
  ...o,
});

const st = (o: Partial<Status> = {}): Status =>
  ({ version: "1.0.0", pid: 41, name: "lab", receivers: [], mid_turn: [], busy: null, ...o }) as Status;
/** A daemon of this release says which copy it is; one from before 0.15 doesn't. */
const SAYS: Health = { accounts: [], copy: { cli: path.join(OLD, "dist", "cli.js"), via: null } };
const SILENT: Health = { accounts: [] };

/** What a folder on the stand-in disk is: one that was there before the run, the copy
 *  npm has just unpacked, or the prefix npm was told to install into. */
const WAS = "what was there";
const FRESH = "the fresh copy";
const NPMS = "the folder npm installed into";

/** The computer a run meets. */
interface Sim {
  /** The folders that are there when it starts. */
  there: string[];
  /** Why the release can't be fetched; null: it can. */
  fetch: string | null;
  /** Why npm couldn't install it (null: it did), and whether it left its folder beside the slot. */
  install: string | null;
  partial: boolean;
  /** npm never comes back: the run ends there, as a signal ends it, with these words. */
  cut: string | null;
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
  /** The copy a daemon that is still at work says it runs from; null: it doesn't say. */
  runningFrom: string | null;
  /** A second name of a folder, and the folder it is: what `same` knows. */
  spelled: Record<string, string>;
  /** What the proof answers: every time, or each time it is asked (the last one stands). */
  proof: Partial<Proof> | Partial<Proof>[];
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
  /** Every removal asked for, the swap's own two folders among them. */
  removals: string[];
  /** Every prefix whose link was looked for, and made where it was not there. */
  relinked: string[];
  /** What the slot held at each thing done (null: nothing), and when npm came back. */
  slot: [did: string, held: string | null][];
  /** What the slot held at the first moment anything else could run after each move. */
  after: (string | null)[];
  /** The folders that are there, and what each is. */
  disk: Map<string, string>;
  clock: number;
}

const inside = (p: string, root: string): boolean => p === root || p.startsWith(root + path.sep);

/** A stand-in computer, and everything a run does to it written down. */
function start(sim: Partial<Sim> = {}): { w: World; d: Doing } {
  const s: Sim = {
    there: [],
    fetch: null,
    install: null,
    partial: false,
    cut: null,
    unmovable: {},
    stuck: {},
    bins: {},
    relink: true,
    status: [null],
    health: SAYS,
    use: { state: "current", version: "2.0.0", said: "This computer is up to date." },
    runningFrom: null,
    spelled: {},
    proof: {},
    settleMs: null,
    stopMs: null,
    ...sim,
  };
  const answers = [...s.status];
  const proofs = Array.isArray(s.proof) ? [...s.proof] : [s.proof];
  let ids = 0;
  const w: World = {
    all: [],
    did: [],
    said: [],
    proved: [],
    removals: [],
    relinked: [],
    slot: [],
    after: [],
    disk: new Map(s.there.map((p) => [p, WAS])),
    clock: 0,
  };
  const held = (): string | null => w.disk.get(SLOT) ?? null;
  const did = (x: string): void => {
    w.did.push(x);
    w.all.push(x);
    w.slot.push([x, held()]);
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
      if (!s.install || s.partial) w.disk.set(prefix, NPMS);
      // A signal: npm had started, and nothing after it runs.
      if (s.cut) throw new Error(s.cut);
      // npm takes its time, and other things run meanwhile.
      await Promise.resolve();
      if (!s.install) w.disk.set(path.join(prefix, "lib", "node_modules", "sessionpipe"), FRESH);
      w.slot.push(["npm is back", held()]);
      return s.install;
    },
    exists: (p) => w.disk.has(p),
    rename: (from, to) => {
      did(`rename ${from} -> ${to}`);
      // Whatever is waiting to run gets its turn only when the run next lets go.
      queueMicrotask(() => w.after.push(held()));
      if (s.unmovable[from]) throw new Error(s.unmovable[from]);
      for (const [p, what] of [...w.disk])
        if (inside(p, from)) {
          w.disk.delete(p);
          w.disk.set(to + p.slice(from.length), what);
        }
    },
    id: () => IDS[ids++ % IDS.length] as string,
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
    use: async (version, serve) => {
      did(`use ${version}${serve ? ", the service too" : ""}`);
      return s.use;
    },
    runningFrom: async () => {
      did("running from?");
      return s.runningFrom;
    },
    same: (a, b) => (s.spelled[a] ?? a) === (s.spelled[b] ?? b),
    remove: async (what) => {
      did(`remove ${what}`);
      w.removals.push(what);
      if (s.stuck[what]) throw new Error(s.stuck[what]);
      for (const p of [...w.disk.keys()]) if (inside(p, what)) w.disk.delete(p);
      return [what, ...(s.bins[what] ?? [])];
    },
    relink: (prefix) => {
      did(`relink ${prefix}`);
      w.relinked.push(prefix);
      return s.relink;
    },
    prove: async (removed) => {
      did("prove");
      w.proved.push([...removed]);
      const answer = proofs.length > 1 ? proofs.shift() : proofs[0];
      return { runs: "2.0.0", typed: true, onPath: [BIN], named: [], ...answer };
    },
    sleep: async (ms) => {
      w.clock += ms;
    },
    now: () => w.clock,
    ...(s.settleMs === null ? {} : { settleMs: s.settleMs }),
    ...(s.stopMs === null ? {} : { stopMs: s.stopMs }),
  };
  return { w, d };
}

async function carry(p: Plan, sim: Partial<Sim> = {}): Promise<World & { done: Done }> {
  const { w, d } = start(sim);
  const done = await carryOut(p, d);
  return Object.assign(w, { done });
}

const count = (w: World, what: string): number => w.did.filter((x) => x === what).length;
/** The folders that are there afterwards, in a fixed order. */
const folders = (w: World): string[] => [...w.disk.keys()].sort();
const sorted = (...list: string[]): string[] => [...list].sort();
/** The removals a plan's own steps asked for: not the swap's tidying of its two folders. */
const taken = (w: World): string[] => w.removals.filter((x) => x !== STAGE && x !== ASIDE);

/** What a fresh install does where it goes well: over a copy that is there, and into an
 *  empty slot. */
const SWAP = [
  `install 2.0.0 in ${STAGE}`,
  `rename ${SLOT} -> ${ASIDE}`,
  `rename ${STAGED} -> ${SLOT}`,
  `remove ${STAGE}`,
  `remove ${ASIDE}`,
  `relink ${PREFIX}`,
];
const INTO = [`install 2.0.0 in ${STAGE}`, `rename ${STAGED} -> ${SLOT}`, `remove ${STAGE}`, `relink ${PREFIX}`];
const INSTALLED = "ok: installed fresh in ~/.local, and it runs";
const REPLACED = `${INSTALLED} (what was there is gone)`;
/** The two lines of the check at the end, where all is as it should be. */
const RUNS = "ok: the copy in ~/.local runs: `--version` says 2.0.0";
const TYPED = `ok: typing \`sessionpipe\` starts it: ${tilde(BIN)}`;
const NOT_TYPED = (starts?: string): string =>
  `Typing \`sessionpipe\` does not start the copy in ~/.local${starts ? ` (it starts ${starts})` : ""}`;
const UNFIT = (printed: string): string =>
  `the copy in ~/.local doesn't run as it should (\`--version\` printed ${printed})`;
/** What ours.ts says of a folder it could empty only in part. */
const IN_PART = (what: string): string =>
  `${what} could only be removed in part (EACCES: permission denied, rmdir '${path.join(what, "dist")}'): what is left of it no longer runs, and the next run takes it`;

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

describe("a plan carried out", () => {
  it("M1: fetches, installs beside what was there and swaps it in, moves the hooks and the service, proves the copy before the first removal, removes the rest, and proves it again: in that order", async () => {
    const w = await carry(
      plan([fetch(), install(true), use(), remove(LINK), remove(LEFTOVER), remove(OLD), remove(NPX), prove()]),
      { there: [SLOT, LEFTOVER, OLD, NPX], bins: { [OLD]: [OLD_BIN] } },
    );
    expect(w.all).toEqual([
      "fetch 2.0.0",
      "ok: sessionpipe 2.0.0 downloaded",
      // npm installs beside the slot; the two folders change places; what the swap made
      // beside the slot goes; the link that starts the copy is seen to be there.
      `install 2.0.0 in ${STAGE}`,
      `rename ${SLOT} -> ${ASIDE}`,
      `rename ${STAGED} -> ${SLOT}`,
      `remove ${STAGE}`,
      `remove ${ASIDE}`,
      `relink ${PREFIX}`,
      REPLACED,
      "use 2.0.0, the service too",
      // Before anything else is removed: the copy in the home runs, and typing starts it.
      "prove",
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
      RUNS,
      TYPED,
      "ok: nothing here names a removed copy any more",
    ]);
    expect(w.done).toEqual(ONE);
    // The first proof is handed nothing: nothing is removed yet. The second is handed what
    // the removals said is gone, links too; the two folders of the swap were the home's
    // own, and are no removed copy to look for.
    expect(w.proved).toEqual([[], [LINK, LEFTOVER, OLD, OLD_BIN, NPX]]);
    expect(folders(w)).toEqual([SLOT]);
    expect(w.disk.get(SLOT)).toBe(FRESH);
    expect(w.clock).toBe(0);
    expect(w.removals).toEqual([STAGE, ASIDE, LINK, LEFTOVER, OLD, NPX]);
    expect(w.relinked).toEqual([PREFIX]);
  });

  it("a plan with nothing to remove proves once, at the end, and says nothing of removed copies", async () => {
    const w = await carry(plan([fetch(), install(), use(false), prove()]));
    expect(w.all).toEqual([
      "fetch 2.0.0",
      "ok: sessionpipe 2.0.0 downloaded",
      ...INTO,
      INSTALLED,
      "use 2.0.0",
      "prove",
      RUNS,
      TYPED,
    ]);
    expect(w.done).toEqual(ONE);
    expect(w.proved).toEqual([[]]);
    expect(taken(w)).toEqual([]);
  });

  it("M3: a home copy that stays as it is (whole, the newest, not this user's to write): nothing is fetched or installed, and the last line says why", async () => {
    const stays = "2.0.0 in ~/.local as it is: whole, the newest, and not yours to write";
    const w = await carry(plan([use(), remove(OLD), prove()], { stays }), { there: [SLOT, OLD] });
    expect(w.did).toEqual(["use 2.0.0, the service too", "prove", `remove ${OLD}`, "prove"]);
    expect(w.done).toEqual({
      state: "one",
      said: "This computer has one sessionpipe: 2.0.0, in ~/.local (not installed again: it is whole, the newest, and not yours to write). Pairings and settings are as they were.",
      warn: [],
    });
    // The copy in the home was never touched.
    expect(w.disk.get(SLOT)).toBe(WAS);
    expect(w.slot.every(([, held]) => held === WAS)).toBe(true);
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
    expect(folders(w)).toEqual(sorted(SLOT, OLD));
  });

  it("one that is downloaded is said by its release, in a line of its own", async () => {
    const w = await carry(plan([fetch()], { target: "2.1.0" }));
    // The release is the step's own: what was asked of npm is what is said.
    expect(w.all).toEqual(["fetch 2.0.0", "ok: sessionpipe 2.0.0 downloaded"]);
  });
});

describe("the fresh install: beside the slot, then two moves", () => {
  const WHY = "npm install: npm error code EINTEGRITY";
  const failed = (error: string, next = "sessionpipe reinstall"): Done => ({
    state: "failed",
    error: `sessionpipe 2.0.0 couldn't be installed in ~/.local: ${error}`,
    next,
  });

  it("L1: npm installs beside the copy that is there: the slot holds that copy while npm works, and is empty for no moment in which anything else can run", async () => {
    const w = await carry(plan([install(true)]), { there: [SLOT] });
    expect(w.did).toEqual(SWAP);
    // What the slot held at each thing done. While npm worked, and when it came back, the
    // copy that was there; the one thing done with the slot empty is the move that fills
    // it, straight after the move that emptied it.
    expect(w.slot).toEqual([
      [`install 2.0.0 in ${STAGE}`, WAS],
      ["npm is back", WAS],
      [`rename ${SLOT} -> ${ASIDE}`, WAS],
      [`rename ${STAGED} -> ${SLOT}`, null],
      [`remove ${STAGE}`, FRESH],
      [`remove ${ASIDE}`, FRESH],
      [`relink ${PREFIX}`, FRESH],
    ]);
    // Between the two moves the run does not let go: whatever was waiting to run after the
    // first of them finds the fresh copy in the slot already.
    expect(w.after).toEqual([FRESH, FRESH]);
    expect(w.said).toEqual([REPLACED]);
    expect(folders(w)).toEqual([SLOT]);
    expect(w.disk.get(SLOT)).toBe(FRESH);
    expect(w.done).toEqual(ONE);
  });

  it("L1: the folder npm installs into and the name the old copy steps aside under are two names, both beside the slot, both as npm names a folder it moved away", () => {
    expect(STAGE).not.toBe(ASIDE);
    for (const beside of [STAGE, ASIDE]) {
      expect(path.dirname(beside)).toBe(path.dirname(SLOT));
      expect(path.basename(beside)).toMatch(LEFT_BEHIND);
    }
    // npm lays its own prefix out in the first: the copy is where a prefix keeps one.
    expect(STAGED).toBe(slotOf(STAGE));
  });

  it("L1: into an empty slot: one move, nothing put aside, and only npm's folder to tidy", async () => {
    const w = await carry(plan([install()]));
    expect(w.all).toEqual([...INTO, INSTALLED]);
    expect(w.done).toEqual(ONE);
    expect(w.removals).toEqual([STAGE]);
    expect(folders(w)).toEqual([SLOT]);
    expect(w.disk.get(SLOT)).toBe(FRESH);
    // A copy that turns up in the slot only after the plan was made is put aside all the
    // same: what is there is looked at when npm is back, not taken from the plan.
    const late = await carry(plan([install()]), { there: [SLOT] });
    expect(late.did).toEqual(SWAP);
    expect(late.said).toEqual([INSTALLED]);
  });

  it("L1: npm failing has touched nothing: no move was made, the slot holds the copy that was there, and what npm left beside it is removed", async () => {
    const steps = [fetch(), install(true), use(), remove(OLD), prove()];
    // npm left its folder beside the slot.
    const half = await carry(plan(steps), { there: [SLOT, OLD], install: WHY, partial: true });
    expect(half.done).toEqual(failed(`${WHY}. Nothing was changed`));
    expect(half.did).toEqual(["fetch 2.0.0", `install 2.0.0 in ${STAGE}`, `remove ${STAGE}`]);
    // npm left nothing: there is nothing to remove.
    const none = await carry(plan(steps), { there: [SLOT, OLD], install: WHY });
    expect(none.done).toEqual(half.done);
    expect(none.did).toEqual(["fetch 2.0.0", `install 2.0.0 in ${STAGE}`]);
    for (const w of [half, none]) {
      // It stops there: the hooks, the service and the other copies are as they were.
      expect(w.said).toEqual(["ok: sessionpipe 2.0.0 downloaded"]);
      expect(folders(w)).toEqual(sorted(SLOT, OLD));
      // The slot held the copy that was there at every moment, and holds it still. No
      // folder was moved, so there is no link to look for.
      expect(w.slot.map(([, held]) => held)).toEqual(w.slot.map(() => WAS));
      expect(w.did.filter((x) => x.startsWith("rename"))).toEqual([]);
      expect(w.relinked).toEqual([]);
    }
    // The same words where nothing was in the slot: nothing is in it now.
    const empty = await carry(plan([install()]), { install: WHY, partial: true });
    expect(empty.done).toEqual(half.done);
    expect(folders(empty)).toEqual([]);
    // A copy npm unpacked whole that then says nothing of itself is such a failure too.
    const mute = `npm finished, but the copy in ${STAGE} says nothing, not 2.0.0`;
    const unfit = await carry(plan(steps), { there: [SLOT, OLD], install: mute, partial: true });
    expect(unfit.done).toEqual(failed(`${mute}. Nothing was changed`));
    expect(unfit.disk.get(SLOT)).toBe(WAS);
  });

  it("L1: what npm left beside the slot and can't be removed is said, never passed over; the failure is the same", async () => {
    const w = await carry(plan([install(true), use()]), {
      there: [SLOT],
      install: WHY,
      partial: true,
      stuck: { [STAGE]: "EACCES: permission denied, rmdir" },
    });
    expect(w.all).toEqual([
      `install 2.0.0 in ${STAGE}`,
      `remove ${STAGE}`,
      `warn: ${tilde(STAGE)} could not be removed (EACCES: permission denied, rmdir)`,
    ]);
    expect(w.done).toEqual(failed(`${WHY}. Nothing was changed`));
    expect(folders(w)).toEqual(sorted(SLOT, STAGE));
    expect(w.disk.get(SLOT)).toBe(WAS);
  });

  it("L1: a run cut off while npm works has moved nothing: the slot holds the copy that was there, and what npm had made is a leftover for the next run", async () => {
    const { w, d } = start({ there: [SLOT, OLD], cut: "SIGINT" });
    await expect(carryOut(plan([fetch(), install(true), use(), remove(OLD), prove()]), d)).rejects.toThrow("SIGINT");
    // Nothing after npm was started: no move, no removal, no link, no hooks, no proof.
    expect(w.did).toEqual(["fetch 2.0.0", `install 2.0.0 in ${STAGE}`]);
    expect(w.disk.get(SLOT)).toBe(WAS);
    expect(w.disk.get(OLD)).toBe(WAS);
    expect(folders(w)).toEqual(sorted(SLOT, OLD, STAGE));
    expect(path.basename(STAGE)).toMatch(LEFT_BEHIND);
  });

  it("L2: what is there can't be moved out of the way: nothing was changed, npm's folder is tidied, and the command named is one that still runs", async () => {
    const w = await carry(plan([fetch(), install(true), use(), remove(OLD), prove()]), {
      there: [SLOT, OLD],
      unmovable: { [SLOT]: "EACCES: permission denied, rename" },
    });
    expect(w.done).toEqual(
      failed(
        "what is there now couldn't be moved out of the way (EACCES: permission denied, rename). Nothing was changed",
      ),
    );
    expect(w.did).toEqual([
      "fetch 2.0.0",
      `install 2.0.0 in ${STAGE}`,
      `rename ${SLOT} -> ${ASIDE}`,
      `remove ${STAGE}`,
    ]);
    expect(folders(w)).toEqual(sorted(SLOT, OLD));
    expect(w.disk.get(SLOT)).toBe(WAS);
    expect(w.relinked).toEqual([]);
    // Where npm's folder can't be removed either, that is said too.
    const stuck = await carry(plan([install(true)]), {
      there: [SLOT],
      unmovable: { [SLOT]: "EACCES: permission denied, rename" },
      stuck: { [STAGE]: "EBUSY: resource busy or locked" },
    });
    expect(stuck.said).toEqual([`warn: ${tilde(STAGE)} could not be removed (EBUSY: resource busy or locked)`]);
    expect(stuck.done).toEqual(w.done);
  });

  it("L2: the fresh copy can't be moved in: what was there is moved back by the same move the other way round, and the command named still runs", async () => {
    const w = await carry(plan([fetch(), install(true), use(), remove(OLD), prove()]), {
      there: [SLOT, OLD],
      unmovable: { [STAGED]: "EXDEV: cross-device link not permitted, rename" },
    });
    expect(w.done).toEqual(
      failed(
        "the fresh copy couldn't be put in its place (EXDEV: cross-device link not permitted, rename). What was there is back where it was",
      ),
    );
    expect(w.did).toEqual([
      "fetch 2.0.0",
      `install 2.0.0 in ${STAGE}`,
      `rename ${SLOT} -> ${ASIDE}`,
      `rename ${STAGED} -> ${SLOT}`,
      // The way back is one move: nothing is removed to make room for it.
      `rename ${ASIDE} -> ${SLOT}`,
      `remove ${STAGE}`,
    ]);
    expect(folders(w)).toEqual(sorted(SLOT, OLD));
    expect(w.disk.get(SLOT)).toBe(WAS);
    // The link that starts the copy was never touched: there is none to make again.
    expect(w.relinked).toEqual([]);
    // Nothing else could run while the slot was empty: the three moves are one after the other.
    expect(w.after).toEqual([WAS, WAS, WAS]);
    expect(w.said).toEqual(["ok: sessionpipe 2.0.0 downloaded"]);
    // Into a slot that was empty there is nothing to move back, and nothing else was changed.
    const empty = await carry(plan([install()]), {
      unmovable: { [STAGED]: "EXDEV: cross-device link not permitted, rename" },
    });
    expect(empty.done).toEqual(
      failed(
        "the fresh copy couldn't be put in its place (EXDEV: cross-device link not permitted, rename). Nothing else was changed",
      ),
    );
    expect(empty.did).toEqual([`install 2.0.0 in ${STAGE}`, `rename ${STAGED} -> ${SLOT}`, `remove ${STAGE}`]);
    expect(folders(empty)).toEqual([]);
  });

  it("L2: the fresh copy can't be moved in and what was there can't be moved back: the slot is empty, so the command named is the one that needs no working copy, and the sentence says where the old copy is, and the fresh one", async () => {
    const w = await carry(plan([fetch(), install(true), use(), remove(OLD), prove()]), {
      there: [SLOT, OLD],
      unmovable: {
        [STAGED]: "EXDEV: cross-device link not permitted, rename",
        [ASIDE]: "EPERM: operation not permitted, rename",
      },
    });
    expect(w.done).toEqual(
      failed(
        // Both folders it leaves beside the slot are named: the old copy, and the folder npm
        // installed the fresh one into. (That one was left there with no word of it: the
        // one failure that was not said.)
        `the fresh copy couldn't be put in its place (EXDEV: cross-device link not permitted, rename), and what was there could not be put back (EPERM: operation not permitted, rename): it is beside its place, as ${tilde(ASIDE)}, and the fresh copy as ${tilde(STAGE)}`,
        BY_NPX,
      ),
    );
    expect(ASIDE).not.toBe(STAGE);
    expect(w.done.state === "failed" && w.done.next).not.toBe("sessionpipe reinstall");
    expect(w.did).toEqual([
      "fetch 2.0.0",
      `install 2.0.0 in ${STAGE}`,
      `rename ${SLOT} -> ${ASIDE}`,
      `rename ${STAGED} -> ${SLOT}`,
      `rename ${ASIDE} -> ${SLOT}`,
    ]);
    // The old copy is where the sentence says, whole, and so is the fresh one: nothing
    // was tidied away that a person might put in place by hand, and nothing else was touched.
    expect(w.disk.has(SLOT)).toBe(false);
    expect(w.disk.get(ASIDE)).toBe(WAS);
    expect(w.disk.has(STAGED)).toBe(true);
    expect(w.disk.get(OLD)).toBe(WAS);
    expect(w.relinked).toEqual([]);
  });

  it("L2: the fresh copy is in its place and the link that starts it can't be made: the command named is the one that needs no working copy", async () => {
    const w = await carry(plan([fetch(), install(true), use(), remove(OLD), prove()]), {
      there: [SLOT, OLD],
      relink: false,
    });
    expect(w.done).toEqual(
      failed("the fresh copy is in its place, and the link that starts it couldn't be made", BY_NPX),
    );
    // The link is looked for once the copy is in its place and the swap is tidied, and once.
    expect(w.did).toEqual(["fetch 2.0.0", ...SWAP]);
    expect(w.disk.get(SLOT)).toBe(FRESH);
    // It stops there: the hooks, the service and the other copy are as they were.
    expect(w.disk.get(OLD)).toBe(WAS);
    expect(w.said).toEqual(["ok: sessionpipe 2.0.0 downloaded"]);
    // The same into a slot that was empty.
    const empty = await carry(plan([install()]), { relink: false });
    expect(empty.done).toEqual(w.done);
    expect(empty.did).toEqual(INTO);
  });

  it("L2: however the install fails, `sessionpipe reinstall` is named only where the slot holds what it held before; anywhere else it is the npx line", async () => {
    const ways: Partial<Sim>[] = [
      { install: WHY },
      { install: WHY, partial: true },
      { install: WHY, partial: true, stuck: { [STAGE]: "EBUSY" } },
      { unmovable: { [SLOT]: "EACCES" } },
      { unmovable: { [STAGED]: "EXDEV" } },
      { unmovable: { [STAGED]: "EXDEV" }, stuck: { [STAGE]: "EBUSY" } },
      { unmovable: { [STAGED]: "EXDEV", [ASIDE]: "EPERM" } },
      { relink: false },
      { relink: false, stuck: { [ASIDE]: "EBUSY", [STAGE]: "EBUSY" } },
    ];
    const next: string[] = [];
    for (const way of ways)
      for (const there of [[SLOT], []]) {
        const w = await carry(plan([install(there.length > 0), use(), prove()]), { ...way, there });
        // A slot that was empty has no copy to be unable to move away: that way is none there.
        if (w.done.state !== "failed") {
          expect(way.unmovable?.[SLOT] && !there.length).toBeTruthy();
          continue;
        }
        next.push(w.done.next);
        if (w.done.next === "sessionpipe reinstall")
          expect(w.disk.get(SLOT) ?? null, w.done.error).toBe(there.length ? WAS : null);
        else expect(w.done.next).toBe(BY_NPX);
        // Nothing after the install was done.
        expect(w.did.filter((x) => /^(use|prove)/.test(x))).toEqual([]);
      }
    // Both kinds of ending were met.
    expect(new Set(next)).toEqual(new Set(["sessionpipe reinstall", BY_NPX]));
  });

  it("L6: a folder of the swap that can't be tidied afterwards is said in yellow and is the next run's to take: the install worked", async () => {
    const steps = [install(true), use(), prove()];
    const old = await carry(plan(steps), { there: [SLOT], stuck: { [ASIDE]: IN_PART(ASIDE) } });
    expect(old.all).toEqual([
      ...SWAP.slice(0, 5),
      `warn: ${tilde(ASIDE)} could not be removed (${IN_PART(ASIDE)})`,
      `relink ${PREFIX}`,
      REPLACED,
      "use 2.0.0, the service too",
      "prove",
      RUNS,
      TYPED,
    ]);
    expect(old.done).toEqual(ONE);
    expect(folders(old)).toEqual(sorted(SLOT, ASIDE));
    expect(old.disk.get(SLOT)).toBe(FRESH);
    // npm's own folder: the same, and the old copy still goes.
    const stage = await carry(plan(steps), { there: [SLOT], stuck: { [STAGE]: "EBUSY: resource busy or locked" } });
    expect(stage.said[0]).toBe(`warn: ${tilde(STAGE)} could not be removed (EBUSY: resource busy or locked)`);
    expect(stage.did.slice(0, SWAP.length)).toEqual(SWAP);
    expect(stage.done).toEqual(ONE);
    expect(folders(stage)).toEqual(sorted(SLOT, STAGE));
    // Both: a line each.
    const both = await carry(plan(steps), { there: [SLOT], stuck: { [STAGE]: "EBUSY", [ASIDE]: "EPERM" } });
    expect(both.said.filter((l) => l.startsWith("warn: "))).toEqual([
      `warn: ${tilde(STAGE)} could not be removed (EBUSY)`,
      `warn: ${tilde(ASIDE)} could not be removed (EPERM)`,
    ]);
    expect(both.done).toEqual(ONE);
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
    expect(w.did.filter((x) => x !== "status")).toEqual(["fetch 2.0.0", ...INTO]);
    expect(folders(w)).toEqual(sorted(OLD, SLOT));
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
    expect(w.said).toEqual([RUNS, TYPED]);
    expect(w.done).toEqual(ONE);
    expect(w.clock).toBe(0);
  });

  it("another process answers by now (it was started again, or the service's own took the socket): nothing is stopped, and no signal goes to the number the plan saw", async () => {
    const nothingStopped = ["status", "use 2.0.0, the service too", "prove"];
    const went = [RUNS, TYPED];
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
      RUNS,
      TYPED,
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
      RUNS,
      TYPED,
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

describe("the hooks and the service onto the fresh copy", () => {
  /** `update`'s two sentences of a service that is still at work. */
  const BY_ITSELF =
    "The background service is busy: a headless agent run. It restarts by itself onto sessionpipe 2.0.0 when that is done: nothing more to type.";
  const ONCE_MORE =
    "The background service is busy: a headless agent run. Moving it onto this copy now would cut that short; when it is done, run `sessionpipe update` once more.";
  const busy = (said: string): Outcome => ({ state: "waiting", version: "2.0.0", said });

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
    expect(w.did).toEqual(["fetch 2.0.0", ...INTO, "use 2.0.0, the service too"]);
    expect(w.disk.has(OLD)).toBe(true);
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

  it("a busy service that runs the copy in the home restarts by itself: that copy is proven, everything else is removed, and the check at the end is the next run's", async () => {
    const w = await carry(plan([fetch(), install(true), use(), remove(LEFTOVER), remove(OLD), prove()]), {
      there: [SLOT, LEFTOVER, OLD],
      use: busy(BY_ITSELF),
      runningFrom: SLOT,
    });
    // The sentence is update's own: no copy waits for it.
    expect(w.done).toEqual({ state: "waiting", said: BY_ITSELF });
    expect(w.did.slice(1 + SWAP.length)).toEqual([
      "use 2.0.0, the service too",
      // Which copy it runs from is asked once, when it is found to be still at work.
      "running from?",
      "prove",
      `remove ${LEFTOVER}`,
      `remove ${OLD}`,
    ]);
    expect(w.proved).toEqual([[]]);
    expect(folders(w)).toEqual([SLOT]);
  });

  it("L9: a daemon still at work that doesn't say which copy it runs from: no copy is removed, and the last line says so", async () => {
    const steps = [fetch(), install(), use(), remove(LINK), remove(LEFTOVER), remove(OLD), remove(NPX), prove()];
    for (const said of [BY_ITSELF, ONCE_MORE]) {
      const w = await carry(plan(steps), { there: [LEFTOVER, OLD, NPX], use: busy(said), runningFrom: null });
      expect(w.done).toEqual({
        state: "waiting",
        said: "The background service is busy: a headless agent run. It doesn't say which copy it runs from, so no copy was removed. When that is done, run `sessionpipe reinstall` once more.",
      });
      // Not one removal of the plan's was asked for, a link that leads nowhere included,
      // and nothing was proven for one.
      expect(taken(w)).toEqual([]);
      expect(w.did.slice(1 + INTO.length)).toEqual(["use 2.0.0, the service too", "running from?"]);
      expect(folders(w)).toEqual(sorted(LEFTOVER, OLD, NPX, SLOT));
      expect(w.said.some((l) => l.includes("removed"))).toBe(false);
    }
    // With nothing to remove there is no copy to speak of: update's sentence stands.
    const none = await carry(plan([use(), prove()]), { use: busy(BY_ITSELF), runningFrom: null });
    expect(none.done).toEqual({ state: "waiting", said: BY_ITSELF });
  });

  it("L9: it runs from a copy that is to go, named another way than the plan names it: that copy stays, the rest goes, and it says to run once more", async () => {
    // The daemon names its copy through a folder that is a link to the one the look found.
    const ALIAS = path.join(HOME, "node", "lib", "node_modules", "sessionpipe");
    const w = await carry(plan([fetch(), install(), use(), remove(LEFTOVER), remove(OLD), remove(NPX), prove()]), {
      there: [LEFTOVER, OLD, NPX],
      use: busy(ONCE_MORE),
      runningFrom: ALIAS,
      spelled: { [ALIAS]: OLD },
    });
    expect(ALIAS).not.toBe(OLD);
    expect(w.done).toEqual({
      state: "waiting",
      said: `The background service is busy: a headless agent run. It still runs from ${tilde(ALIAS)}, which stays until that is done. Then run \`sessionpipe reinstall\` once more: it moves the service and removes that last copy.`,
    });
    expect(w.did.slice(1 + INTO.length)).toEqual([
      "use 2.0.0, the service too",
      "running from?",
      "prove",
      `remove ${LEFTOVER}`,
      `remove ${NPX}`,
    ]);
    expect(taken(w)).toEqual([LEFTOVER, NPX]);
    expect(w.said.slice(2)).toEqual([
      "ok: removed a leftover folder in ~/.nvm/versions/node/v22.1.0",
      "ok: removed 2.0.0 in ~/.npm/_npx/0a1b2c3d",
    ]);
    // The check at the end is the next run's: only the proof before the removals was taken.
    expect(w.proved).toEqual([[]]);
    expect(folders(w)).toEqual(sorted(OLD, SLOT));
    // By the very name the plan has for it: the same.
    const named = await carry(plan([use(), remove(OLD), remove(NPX), prove()]), {
      there: [OLD, NPX],
      use: busy(ONCE_MORE),
      runningFrom: OLD,
    });
    expect(taken(named)).toEqual([NPX]);
    expect(named.done.state === "waiting" && named.done.said).toContain(`It still runs from ${tilde(OLD)}, which`);
  });

  it("L9: it runs from a copy no step removes: every removal is made, and the sentence is update's own", async () => {
    const steps = [use(), remove(OLD), remove(NPX), prove()];
    const w = await carry(plan(steps), { there: [OLD, NPX], use: busy(BY_ITSELF), runningFrom: SLOT });
    expect(w.done).toEqual({ state: "waiting", said: BY_ITSELF });
    expect(w.did).toEqual(["use 2.0.0, the service too", "running from?", "prove", `remove ${OLD}`, `remove ${NPX}`]);
    expect(folders(w)).toEqual([]);
  });

  it('the command update names for "once more" is this one, wherever its sentence ends up: update would leave the other copies', async () => {
    // Returned as it is (the daemon runs a copy no step removes): the command is this one.
    const asIs = await carry(plan([use(), remove(OLD), prove()]), {
      there: [OLD],
      use: busy(ONCE_MORE),
      runningFrom: SLOT,
    });
    expect(asIs.done).toEqual({
      state: "waiting",
      said: "The background service is busy: a headless agent run. Moving it onto this copy now would cut that short; when it is done, run `sessionpipe reinstall` once more.",
    });
    // Every time it is named, not only the first.
    const twice = await carry(plan([use()]), {
      use: busy("`sessionpipe update` can't move it yet. When it is done, run `sessionpipe update` once more."),
    });
    expect(twice.done).toEqual({
      state: "waiting",
      said: "`sessionpipe reinstall` can't move it yet. When it is done, run `sessionpipe reinstall` once more.",
    });
    // And where only its first sentence is kept, with this command's own after it: for a
    // copy that stays, and for a daemon that names none.
    const said =
      "When the background service is done, run `sessionpipe update` once more. It is busy: a headless agent run.";
    const first = await carry(plan([use(), remove(OLD), prove()]), {
      there: [OLD],
      use: busy(said),
      runningFrom: OLD,
    });
    expect(first.done).toEqual({
      state: "waiting",
      said: `When the background service is done, run \`sessionpipe reinstall\` once more. It still runs from ${tilde(OLD)}, which stays until that is done. Then run \`sessionpipe reinstall\` once more: it moves the service and removes that last copy.`,
    });
    const unnamed = await carry(plan([use(), remove(OLD), prove()]), { there: [OLD], use: busy(said) });
    expect(unnamed.done).toEqual({
      state: "waiting",
      said: "When the background service is done, run `sessionpipe reinstall` once more. It doesn't say which copy it runs from, so no copy was removed. When that is done, run `sessionpipe reinstall` once more.",
    });
    for (const w of [asIs, twice, first, unnamed])
      expect(w.done.state === "waiting" && w.done.said).not.toContain("sessionpipe update");
  });

  it("what update says is not as it should be is said beside the one copy", async () => {
    const warn = "The background service hasn't heard from r.example yet. `sessionpipe doctor` looks again.";
    const w = await carry(plan([use(), prove()]), {
      use: { state: "current", version: "2.0.0", said: "This computer is up to date.", warn },
    });
    expect(w.done).toEqual({ ...ONE, warn: [warn] });
    // A service that moved at once is not asked which copy it runs from.
    expect(count(w, "running from?")).toBe(0);
  });
});

describe("the proof before the first removal", () => {
  const steps = [fetch(), install(true), use(), remove(LINK), remove(LEFTOVER), remove(OLD), remove(NPX), prove()];
  const computer = { there: [SLOT, LEFTOVER, OLD, NPX] };

  it("M1: the copy in the home doesn't run: the run ends there, no other copy was removed, and the command named needs no working copy", async () => {
    for (const [runs, printed] of [
      [null, "nothing"],
      ["1.0.0", "1.0.0"],
    ] as const) {
      const w = await carry(plan(steps), { ...computer, proof: { runs } });
      expect(w.done).toEqual({
        state: "failed",
        error: `${UNFIT(printed)}: no other copy was removed`,
        next: BY_NPX,
      });
      // Asked once, handed nothing, and it is the last thing done.
      expect(w.proved).toEqual([[]]);
      expect(w.did.at(-1)).toBe("prove");
      expect(taken(w)).toEqual([]);
      expect(folders(w)).toEqual(sorted(SLOT, LEFTOVER, OLD, NPX));
      expect(w.said.some((l) => l.includes("removed"))).toBe(false);
    }
  });

  it("M1: typing `sessionpipe` doesn't start the copy in the home: the run ends there, no other copy was removed, and it names what typing starts", async () => {
    const other = await carry(plan(steps), { ...computer, proof: { typed: false, onPath: [OLD_BIN, BIN] } });
    expect(other.done).toEqual({
      state: "failed",
      error: `${NOT_TYPED(tilde(OLD_BIN))}: no other copy was removed`,
      next: "sessionpipe doctor",
    });
    // Nothing on PATH at all: there is no file to name.
    const none = await carry(plan(steps), { ...computer, proof: { typed: false, onPath: [] } });
    expect(none.done).toEqual({
      state: "failed",
      error: `${NOT_TYPED()}: no other copy was removed`,
      next: "sessionpipe doctor",
    });
    for (const w of [other, none]) {
      expect(w.proved).toEqual([[]]);
      expect(taken(w)).toEqual([]);
      expect(folders(w)).toEqual(sorted(SLOT, LEFTOVER, OLD, NPX));
    }
    // A copy that doesn't run is the first thing said, whatever typing starts.
    const both = await carry(plan(steps), { ...computer, proof: { runs: null, typed: false, onPath: [OLD_BIN] } });
    expect(both.done).toEqual({
      state: "failed",
      error: `${UNFIT("nothing")}: no other copy was removed`,
      next: BY_NPX,
    });
    expect(taken(both)).toEqual([]);
  });

  it("M1: it is asked once, before the first removal and not before each; a plan that removes nothing asks only at the end", async () => {
    const w = await carry(plan(steps), computer);
    const after = w.did.slice(w.did.indexOf("use 2.0.0, the service too") + 1);
    expect(after).toEqual(["prove", `remove ${LINK}`, `remove ${LEFTOVER}`, `remove ${OLD}`, `remove ${NPX}`, "prove"]);
    expect(w.proved).toEqual([[], [LINK, LEFTOVER, OLD, NPX]]);
    // A link that leads nowhere is a removal as any other: the proof comes before it too.
    const link = await carry(plan([use(), remove(LINK)]));
    expect(link.did).toEqual(["use 2.0.0, the service too", "prove", `remove ${LINK}`]);
    // No removal: nothing to prove before one.
    const none = await carry(plan([fetch(), install(true), use(), prove()]), { there: [SLOT] });
    expect(none.proved).toEqual([[]]);
    expect(none.did.at(-1)).toBe("prove");
    expect((await carry(plan([fetch(), install(true), use()]), { there: [SLOT] })).proved).toEqual([]);
  });

  it("M1: a removal that is passed over (a daemon still at work in that copy) asks nothing; the first one that is made does", async () => {
    const waiting: Outcome = { state: "waiting", version: "2.0.0", said: "The service is busy. More." };
    const passed = await carry(plan([use(), remove(OLD), prove()]), {
      there: [OLD],
      use: waiting,
      runningFrom: OLD,
    });
    expect(passed.did).toEqual(["use 2.0.0, the service too", "running from?"]);
    expect(passed.proved).toEqual([]);
    const second = await carry(plan([use(), remove(OLD), remove(NPX), prove()]), {
      there: [OLD, NPX],
      use: waiting,
      runningFrom: OLD,
    });
    expect(second.did).toEqual(["use 2.0.0, the service too", "running from?", "prove", `remove ${NPX}`]);
    // And where that proof fails, the copy that was to go stays as well.
    const unfit = await carry(plan([use(), remove(OLD), remove(NPX), prove()]), {
      there: [OLD, NPX],
      use: waiting,
      runningFrom: OLD,
      proof: { runs: null },
    });
    expect(unfit.done).toEqual({
      state: "failed",
      error: `${UNFIT("nothing")}: no other copy was removed`,
      next: BY_NPX,
    });
    expect(folders(unfit)).toEqual(sorted(OLD, NPX));
  });
});

describe("the removals", () => {
  it('each is said in the plan\'s own words for it; "with its link" only where the removal answered more than the folder', async () => {
    const said = async (p: string, bins: string[] = [], row?: string) =>
      (await carry(plan([remove(p, row)]), { there: [p], bins: { [p]: bins } })).said;
    // A copy with npm's link beside it: both went, and the line says so.
    expect(await said(OLD, [OLD_BIN])).toEqual(["ok: removed 1.0.0 in ~/.nvm/versions/node/v22.1.0, with its link"]);
    // Whatever more than the folder went: still "its link", once.
    expect(await said(OLD, [OLD_BIN, path.join(NVM, "bin", "sessionpipe-2")])).toEqual([
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

  it("a removal is asked for by the folder alone: what goes with it is the removal's own to know", async () => {
    const calls: unknown[][] = [];
    const { d } = start({ there: [OLD] });
    const spied: Doing = {
      ...d,
      remove: (...args) => {
        calls.push(args);
        return d.remove(...args);
      },
    };
    await carryOut(plan([install(true), remove(OLD)]), spied);
    expect(calls).toEqual([[STAGE], [OLD]]);
  });

  it("a copy that can't be removed stays and is said in yellow; the rest still goes, and what is left names the one that stayed", async () => {
    const why = `${OLD} was left alone: it holds src, which no published sessionpipe has (a checkout or a build?)`;
    const w = await carry(plan([use(), remove(LEFTOVER), remove(OLD), remove(NPX), prove()]), {
      there: [LEFTOVER, OLD, NPX],
      stuck: { [OLD]: why },
    });
    expect(w.all).toEqual([
      "use 2.0.0, the service too",
      "prove",
      `remove ${LEFTOVER}`,
      "ok: removed a leftover folder in ~/.nvm/versions/node/v22.1.0",
      `remove ${OLD}`,
      `warn: ${tilde(OLD)} could not be removed: ${why}`,
      `remove ${NPX}`,
      "ok: removed 2.0.0 in ~/.npm/_npx/0a1b2c3d",
      "prove",
      RUNS,
      TYPED,
      "ok: nothing here names a removed copy any more",
    ]);
    // What stayed was not removed, so nothing is looked for under its name.
    expect(w.proved).toEqual([[], [LEFTOVER, NPX]]);
    // No failure: the fresh copy is in use, and that is said first. What is left is its
    // own sentence, the folder as a person reads it, with why it stayed.
    expect(w.done).toEqual({
      state: "left",
      said: "sessionpipe 2.0.0 is installed in ~/.local and in use. Pairings and settings are as they were.",
      warn: [],
      still: `One other copy is still there: ${tilde(OLD)} (${why}).`,
      next: "sessionpipe reinstall",
    });
    expect(folders(w)).toEqual([OLD]);
  });

  it("L6: a copy that could only be removed in part is said in yellow, counted as still there, and the next step is this command once more", async () => {
    const w = await carry(plan([use(), remove(OLD), remove(NPX), prove()]), {
      there: [OLD, NPX],
      bins: { [OLD]: [OLD_BIN] },
      stuck: { [OLD]: IN_PART(OLD) },
    });
    expect(w.said).toEqual([
      `warn: ${tilde(OLD)} could not be removed: ${IN_PART(OLD)}`,
      "ok: removed 2.0.0 in ~/.npm/_npx/0a1b2c3d",
      RUNS,
      TYPED,
      "ok: nothing here names a removed copy any more",
    ]);
    // Neither the folder nor its link is answered as gone.
    expect(w.proved).toEqual([[], [NPX]]);
    expect(w.done).toEqual(LEFT(`One other copy is still there: ${tilde(OLD)} (${IN_PART(OLD)}).`));
    expect(w.done.state === "left" && w.done.next).toBe("sessionpipe reinstall");
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
      RUNS,
      TYPED,
    ]);
    // The proof before the first removal was taken once, though that removal failed.
    expect(w.proved).toEqual([[], []]);
  });
});

describe("the proof at the end", () => {
  it("the copy printing another version, or nothing, fails with the way in that needs no working copy", async () => {
    // With nothing to remove this is the one proof there is.
    const steps = [fetch(), install(), use(), prove()];
    const other = await carry(plan(steps), { proof: { runs: "1.0.0" } });
    expect(other.done).toEqual({ state: "failed", error: UNFIT("1.0.0"), next: BY_NPX });
    const silent = await carry(plan(steps), { proof: { runs: null } });
    expect(silent.done).toEqual({ state: "failed", error: UNFIT("nothing"), next: BY_NPX });
    // Whatever a shell finds: a copy that doesn't run is the one thing said.
    const found = await carry(plan(steps), { proof: { runs: null, typed: true, onPath: [BIN] } });
    expect(found.done).toEqual(silent.done);
    expect(found.said.at(-1)).toBe(INSTALLED);
    // It ran before the removals and doesn't after them: the same, and nothing is said of
    // copies that were not removed, for by then they were.
    const after = await carry(plan([use(), remove(OLD), prove()]), {
      there: [OLD],
      proof: [{}, { runs: null }],
    });
    expect(after.done).toEqual(silent.done);
    expect(after.said).toEqual(["ok: removed 1.0.0 in ~/.nvm/versions/node/v22.1.0"]);
  });

  it("N1: what typing starts was taken, not read (a file npm did not make is first on PATH): the proof is not asked about typing, before a removal or at the end, and no line says 'starts it'", async () => {
    const SHIM = path.join(path.dirname(path.dirname(BIN)), "shims", "sessionpipe");
    const taken0 = { inferred: SHIM };
    // Whatever the look answers of what is typed, either way: it is not what decides.
    for (const typed of [true, false]) {
      const proof = { typed, onPath: [SHIM, BIN] };
      // With removals (a leftover, a cache entry): the proof before the first one asks
      // only that the copy runs, and the run goes on.
      const w = await carry(plan([fetch(), install(true), use(), remove(LEFTOVER), remove(NPX), prove()], taken0), {
        there: [SLOT, LEFTOVER, NPX],
        proof,
      });
      expect(w.done.state, String(typed)).toBe("one");
      expect(taken(w)).toEqual([LEFTOVER, NPX]);
      expect(w.proved).toEqual([[], [LEFTOVER, NPX]]);
      for (const line of [...w.said, ...(w.done.state === "one" ? [w.done.said, ...w.done.warn] : [])]) {
        expect(line).not.toMatch(/starts it|does not start/);
        expect(line).not.toContain(tilde(SHIM));
      }
      expect(w.said).toContain(RUNS);
      // With none: the same silence at the end.
      const bare = await carry(plan([use(), prove()], taken0), { proof });
      expect(bare.said).toEqual([RUNS]);
      expect(bare.done).toEqual(ONE);
    }
    // A copy that does not run still ends it, before any removal: that much is read.
    const dead = await carry(plan([use(), remove(LEFTOVER), prove()], taken0), {
      there: [SLOT, LEFTOVER],
      proof: { runs: null, typed: true },
    });
    expect(dead.done).toEqual({
      state: "failed",
      error: `${UNFIT("nothing")}: no other copy was removed`,
      next: BY_NPX,
    });
    expect(taken(dead)).toEqual([]);
    // The same plan where what is typed WAS read is held to it, as ever.
    const read = await carry(plan([use(), remove(LEFTOVER), prove()]), {
      there: [SLOT, LEFTOVER],
      proof: { typed: false, onPath: [SHIM, BIN] },
    });
    expect(read.done.state).toBe("failed");
    expect(taken(read)).toEqual([]);
  });

  it("N1: with installed copies kept for that reason, the last sentence does not say this computer has ONE sessionpipe", async () => {
    const kept = await carry(plan([use(), prove()], { inferred: "/x/shims/sessionpipe", kept: 2 }), {
      proof: { typed: true, onPath: [] },
    });
    expect(kept.done).toEqual({
      state: "one",
      said: "sessionpipe 2.0.0 is installed in ~/.local and in use. Pairings and settings are as they were.",
      warn: [],
    });
    // And where the home's copy stayed as it was.
    const stays = await carry(
      plan([use(), prove()], { inferred: "/x/shims/sessionpipe", kept: 1, stays: "2.0.0 in ~/.local as it is" }),
      { proof: { typed: true, onPath: [] } },
    );
    expect(stays.done.state === "one" && stays.done.said).toBe(
      "sessionpipe 2.0.0 is installed in ~/.local and in use (not installed again: it is whole, the newest, and not yours to write). Pairings and settings are as they were.",
    );
    // None kept: one sessionpipe, as ever, inferred or not.
    expect((await carry(plan([use(), prove()], { inferred: "/x/shims/sessionpipe" }), {})).done).toEqual(ONE);
  });

  it("N1: over computers made up from a seed, no run of a plan whose `inferred` is set says what typing starts, or fails for it; and with a copy kept it never says this computer has ONE", async () => {
    let ran = 0;
    let keeping = 0;
    const wrong: string[] = [];
    for (let seed = 1; seed <= 2500; seed++) {
      const w = world(seed);
      const p = makePlan(w.inv, w.facts);
      if (!p.steps.length || !p.inferred) continue;
      ran++;
      const said: string[] = [];
      // Every effect works, and the look says typing does NOT start the copy: were it
      // asked, the run would stop before a removal, or say so at the end.
      const done = await carryOut(p, {
        say: (step) => void said.push(step.text),
        tilde: (x) => x,
        fetch: async () => null,
        install: async () => null,
        exists: () => false,
        rename: () => {},
        id: () => "a1b2c3d4",
        status: async () => null,
        health: async () => null,
        quiesce: async () => true,
        seed: () => {},
        stop: () => {},
        use: async (version) => ({ state: "current", version, said: "ok" }),
        runningFrom: async () => null,
        same: (x, y) => x === y,
        remove: async (what) => [what],
        relink: () => true,
        prove: async () => ({ runs: p.target, typed: false, onPath: [p.inferred as string], named: [] }),
        sleep: async () => {},
        now: () => 0,
      });
      const text = [...said, ...("said" in done ? [done.said] : []), ...("warn" in done ? done.warn : [])].join("\n");
      if (/starts it|does not start the copy/.test(text)) wrong.push(`seed ${seed}: it says what typing starts`);
      if (done.state === "failed") wrong.push(`seed ${seed}: it failed: ${done.error}`);
      if (p.kept) {
        keeping++;
        if (/This computer has one sessionpipe/.test(text))
          wrong.push(`seed ${seed}: copies were kept, and it says there is one`);
      }
    }
    expect(wrong).toEqual([]);
    expect(ran).toBeGreaterThan(20);
    expect(keeping).toBeGreaterThan(5);
  });

  it("typing starts this copy and a shell finds nothing else: said in green, with the file it finds", async () => {
    const w = await carry(plan([use(), prove()]), { proof: { onPath: [BIN], typed: true } });
    expect(w.said).toEqual([RUNS, TYPED]);
    expect(w.done).toEqual(ONE);
    // Where no file is named there is none to say.
    const bare = await carry(plan([use(), prove()]), { proof: { onPath: [], typed: true } });
    expect(bare.said).toEqual([RUNS, "ok: typing `sessionpipe` starts it"]);
    expect(bare.done).toEqual(ONE);
  });

  it("typing starts this copy and a shell finds more behind it: said as it is, in their order, and no warning", async () => {
    const several = await carry(plan([use(), prove()]), { proof: { onPath: [BIN, OLD_BIN, LINK] } });
    // What is behind it starts nothing a person types: nothing to look at, so no warning.
    expect(several.done).toEqual(ONE);
    // Not the copy's own file again: only what is behind it.
    expect(several.said).toEqual([
      RUNS,
      `info: typing \`sessionpipe\` starts it; behind it on PATH: ${tilde(OLD_BIN)}, ${LINK}`,
    ]);
    // One behind it, a folder under the home said as a person reads it.
    const two = await carry(plan([use(), prove()]), { proof: { onPath: [BIN, OLD_BIN] } });
    expect(two.done).toEqual(ONE);
    expect(two.said.at(-1)).toBe(`info: typing \`sessionpipe\` starts it; behind it on PATH: ${tilde(OLD_BIN)}`);
    expect(tilde(OLD_BIN).startsWith("~")).toBe(true);
    // What typing starts is the look's to say, not the order of the files: a file first on
    // PATH that is no link of npm's (a version manager's shim) may be what starts this copy.
    const shim = path.join(HOME, ".asdf", "shims", "sessionpipe");
    const through = await carry(plan([use(), prove()]), { proof: { onPath: [shim, BIN], typed: true } });
    expect(through.done).toEqual(ONE);
    expect(through.said.at(-1)).toBe(`info: typing \`sessionpipe\` starts it; behind it on PATH: ${tilde(BIN)}`);
  });

  it("typing does not start this copy: that is the warning, with what it starts, and neither line about typing is said", async () => {
    // Several, another first.
    const behind = await carry(plan([use(), prove()]), { proof: { onPath: [OLD_BIN, BIN], typed: false } });
    expect(behind.done).toEqual({ ...ONE, warn: [`${NOT_TYPED(tilde(OLD_BIN))}.`] });
    expect(behind.said).toEqual([RUNS]);
    // One only, and it is not this copy.
    const other = await carry(plan([use(), prove()]), { proof: { onPath: [LINK], typed: false } });
    expect(other.done).toEqual({ ...ONE, warn: [`${NOT_TYPED(LINK)}.`] });
    expect(other.said).toEqual([RUNS]);
    // A shell finds none: there is no file to name.
    const none = await carry(plan([use(), prove()]), { proof: { onPath: [], typed: false } });
    expect(none.done).toEqual({ ...ONE, warn: [`${NOT_TYPED()}.`] });
    expect(none.said).toEqual([RUNS]);
    // It is a warning at the end only: the same answer before the first removal ends the run.
    const earlier = await carry(plan([use(), remove(OLD), prove()]), {
      there: [OLD],
      proof: { onPath: [LINK], typed: false },
    });
    expect(earlier.done.state).toBe("failed");
    // Typed before the removals, and not after them: the warning, beside what was done.
    const later = await carry(plan([use(), remove(OLD), prove()]), {
      there: [OLD],
      proof: [{}, { onPath: [LINK], typed: false }],
    });
    expect(later.done).toEqual({ ...ONE, warn: [`${NOT_TYPED(LINK)}.`] });
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
    expect(w.said).toEqual(["ok: removed 1.0.0 in ~/.nvm/versions/node/v22.1.0, with its link", RUNS, TYPED]);
    // With update's own warning, and several on PATH: every warning is kept, in the order
    // found; what is behind this copy on PATH is a line of the run, and no warning.
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
      RUNS,
      `info: typing \`sessionpipe\` starts it; behind it on PATH: ${LINK}`,
    ]);
    // And with another copy typed by the end: that warning comes before what still names
    // a removed copy.
    const typed = await carry(plan([use(), remove(OLD), prove()]), {
      there: [OLD],
      proof: [{}, { onPath: [LINK, BIN], typed: false, named: [{ file: plist, path: OLD }] }],
    });
    expect(typed.done).toEqual({
      ...ONE,
      warn: [`${NOT_TYPED(LINK)}.`, `${tilde(plist)} still names ${tilde(OLD)}, which was removed.`],
    });
  });
});

describe("what is left: the fresh copy is in use, and a copy that should have gone is still there", () => {
  it("L10: a published copy this user can't remove means the job isn't done: what works is said first, then what is left, and its own line is the next step", async () => {
    const w = await carry(plan([use(), remove(OLD), prove()], { left: [left()] }), { there: [OLD] });
    expect(w.done).toEqual({
      state: "left",
      // What works: the same words as of one copy, less the claim that it is the only one.
      said: "sessionpipe 2.0.0 is installed in ~/.local and in use. Pairings and settings are as they were.",
      warn: [],
      // The copy by its release and its folder; the command is not said twice, only that it needs sudo.
      still: "One other copy is still there: 1.0.0 in /usr/local (needs sudo).",
      // The plan's own line for it, word for word: the folder and its own link, and not npm.
      next: SUDO,
    });
    // Everything it could do was done first, and said as ever.
    expect(w.did).toEqual(["use 2.0.0, the service too", "prove", `remove ${OLD}`, "prove"]);
    expect(w.said).toEqual([
      "ok: removed 1.0.0 in ~/.nvm/versions/node/v22.1.0",
      RUNS,
      TYPED,
      "ok: nothing here names a removed copy any more",
    ]);
    // In the two sentences it is named as a person reads it; its whole path is in the line
    // to paste, and is no step's to touch.
    const done = w.done as Extract<Done, { state: "left" }>;
    for (const sentence of [done.said, done.still]) expect(sentence).not.toContain(left().path);
    expect(w.did.join("\n")).not.toContain(left().path);
    // It is no failure: a failure has no "what works" to say.
    expect(w.done.state).not.toBe("failed");
  });

  it("a copy with no line of its own says why it stays; one that names no release is named as that", async () => {
    const still = async (...l: Left[]) => {
      const done = (await carry(plan([prove()], { left: l }))).done;
      return done.state === "left" ? [done.still, done.next] : done;
    };
    expect(await still(left({ line: null }))).toEqual([
      "One other copy is still there: 1.0.0 in /usr/local (you may not write where it is).",
      "sessionpipe reinstall",
    ]);
    // A leftover folder names no release.
    expect(await still(left({ version: null }))).toEqual([
      "One other copy is still there: a broken copy in /usr/local (needs sudo).",
      SUDO,
    ]);
    expect(await still(left({ version: null, line: null, where: "/opt/node" }))).toEqual([
      "One other copy is still there: a broken copy in /opt/node (you may not write where it is).",
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

  it("L10: several are chained into one line, in order; one with no line of its own adds none", async () => {
    const OPT = "sudo rm -r /opt/node/lib/node_modules/sessionpipe /opt/node/bin/sessionpipe";
    const opt = left({ where: "/opt/node", path: slotOf(path.join(path.sep, "opt", "node")), line: OPT });
    const cache = left({
      where: "/root/.npm/_npx/0a1b",
      path: path.join(path.sep, "root", ".npm", "_npx", "0a1b", "node_modules", "sessionpipe"),
      line: null,
    });
    const w = await carry(plan([prove()], { left: [left(), cache, opt, left({ ours: false, line: null })] }));
    expect(w.done).toEqual(
      LEFT(
        "3 other copies are still there: 1.0.0 in /usr/local (needs sudo); 1.0.0 in /root/.npm/_npx/0a1b (you may not write where it is); 1.0.0 in /opt/node (needs sudo).",
        `${SUDO} && ${OPT}`,
      ),
    );
    // Two of them: counted as two, joined once.
    const two = await carry(plan([prove()], { left: [opt, left()] }));
    expect(two.done).toEqual(
      LEFT(
        "2 other copies are still there: 1.0.0 in /opt/node (needs sudo); 1.0.0 in /usr/local (needs sudo).",
        `${OPT} && ${SUDO}`,
      ),
    );
  });

  it("L10: with no line for any of them (a removal that failed) the next step is this command again; a line there is, is the one to run", async () => {
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
    const OPT = "sudo rm -r /opt/node/lib/node_modules/sessionpipe";
    const opt = left({ where: "/opt/node", line: OPT });
    const three = await carry(plan([remove(NPX), prove()], { left: [left(), opt] }), {
      there: [NPX],
      stuck: { [NPX]: "EPERM: operation not permitted" },
    });
    expect(three.done).toEqual(
      LEFT(
        `3 other copies are still there: 1.0.0 in /usr/local (needs sudo); 1.0.0 in /opt/node (needs sudo); ${tilde(NPX)} (EPERM: operation not permitted).`,
        `${SUDO} && ${OPT}`,
      ),
    );
  });

  it("a copy that stays, and typing doesn't start the copy in the home by the end: a warning beside what is left", async () => {
    const still = "One other copy is still there: 1.0.0 in /usr/local (needs sudo).";
    const w = await carry(plan([use(), prove()], { left: [left()] }), {
      proof: { onPath: [OLD_BIN, BIN], typed: false },
    });
    expect(w.done).toEqual(LEFT(still, SUDO, [`${NOT_TYPED(tilde(OLD_BIN))}.`]));
    // The same after a removal that threw; the path is said as a person reads it.
    const threw = await carry(plan([remove(NPX), prove()]), {
      there: [NPX],
      stuck: { [NPX]: "EBUSY: resource busy or locked" },
      proof: [{}, { onPath: [OLD_BIN], typed: false }],
    });
    expect(threw.done).toEqual(
      LEFT(`One other copy is still there: ${tilde(NPX)} (EBUSY: resource busy or locked).`, "sessionpipe reinstall", [
        `${NOT_TYPED(tilde(OLD_BIN))}.`,
      ]),
    );
    expect(tilde(OLD_BIN).startsWith("~")).toBe(true);
    // What is typed is never part of the sentence about what is left.
    for (const x of [w, threw]) expect(x.done.state === "left" && x.done.still).not.toContain("Typing");
  });

  it("what else there is to say is said beside it: update's warning, a file that still names a removed copy", async () => {
    const plist = path.join(HOME, "Library", "LaunchAgents", "org.sessionpipe.control.plist");
    const w = await carry(plan([use(), remove(OLD), prove()], { left: [left()] }), {
      there: [OLD],
      use: { state: "current", version: "2.0.0", said: "", warn: "A receiver hasn't answered." },
      proof: [{}, { onPath: [LINK, BIN], typed: false, named: [{ file: plist, path: OLD }] }],
    });
    expect(w.done).toEqual(
      LEFT("One other copy is still there: 1.0.0 in /usr/local (needs sudo).", SUDO, [
        "A receiver hasn't answered.",
        `${NOT_TYPED(LINK)}.`,
        `${tilde(plist)} still names ${tilde(OLD)}, which was removed.`,
      ]),
    );
  });

  it("a copy that stays says nothing of what is typed where typing starts the copy in the home, or nothing was proven", async () => {
    const stays = LEFT("One other copy is still there: 1.0.0 in /usr/local (needs sudo).", SUDO);
    const stay = (steps: Step[]) => plan(steps, { left: [left()] });
    // Typing starts it: alone on PATH, or first of several (the copy that stays is then
    // behind it, and the run's own line says so).
    expect((await carry(stay([use(), prove()]))).done).toEqual(stays);
    const several = await carry(stay([use(), prove()]), { proof: { onPath: [BIN, OLD_BIN] } });
    expect(several.done).toEqual(stays);
    expect(several.said.at(-1)).toBe(`info: typing \`sessionpipe\` starts it; behind it on PATH: ${tilde(OLD_BIN)}`);
    // No proof was asked for: there is nothing of the run's to say.
    const unproven = await carry(stay([use()]));
    expect(unproven.done).toEqual(stays);
    expect(count(unproven, "prove")).toBe(0);
  });

  it("a home copy that was not installed again, and another that needs sudo: what is left is said, not that there is one", async () => {
    const w = await carry(plan([use(), prove()], { left: [left()], stays: "2.0.0 in ~/.local as it is" }), {
      there: [SLOT],
    });
    expect(w.done).toEqual(LEFT("One other copy is still there: 1.0.0 in /usr/local (needs sudo).", SUDO));
  });

  it("a service still at work comes first: what is left is the next run's to say", async () => {
    const said =
      "The background service is busy: a headless agent run. It restarts by itself onto sessionpipe 2.0.0 when that is done: nothing more to type.";
    const w = await carry(plan([use(), remove(OLD), prove()], { left: [left()] }), {
      there: [OLD],
      stuck: { [OLD]: "EBUSY: resource busy or locked" },
      use: { state: "waiting", version: "2.0.0", said },
      runningFrom: SLOT,
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
    expect(two.said.at(-1)).toBe(`info: typing \`sessionpipe\` starts it; behind it on PATH: ${LINK}`);
    // Beside a copy of ours that stays, they are still not counted, and their line is not the next step.
    const mixed = await carry(plan([use(), prove()], { left: [checkout, volta, left()] }));
    expect(mixed.done).toEqual(LEFT("One other copy is still there: 1.0.0 in /usr/local (needs sudo).", SUDO));
  });
});

describe("the steps a plan may hold", () => {
  it("each kind is carried out by its own effect and by no other; none removes a service file", async () => {
    const each: Record<Kind, [Step, string[]]> = {
      fetch: [fetch(), ["fetch 2.0.0"]],
      install: [install(), INTO],
      stop: [stop(), ["status"]],
      use: [use(), ["use 2.0.0, the service too"]],
      // A removal brings the proof that comes before the first of them.
      remove: [remove(OLD), ["prove", `remove ${OLD}`]],
      prove: [prove(), ["prove"]],
    };
    for (const [step, did] of Object.values(each)) expect((await carry(plan([step]))).did).toEqual(did);
    expect(Object.keys(each).sort()).toEqual(["fetch", "install", "prove", "remove", "stop", "use"]);
    // A service file nothing needs is left where it is: no plan holds a step that takes
    // one away, and a run is handed nothing that could.
    // @ts-expect-error no such step
    const unserve: Step = { ...base, do: "unserve" };
    expect(unserve.do in each).toBe(false);
    // @ts-expect-error no such way
    const way: keyof Doing = "unserve";
    expect(way in start().d).toBe(false);
    // No step at all: nothing is done, and the sentence is still the plan's.
    const none = await carry(plan([]));
    expect(none.all).toEqual([]);
    expect(none.done).toEqual(ONE);
  });
});

// The one test with a disk in it. A fresh install leaves two folders beside the slot for
// ours.ts to take: npm's own prefix (its copy moved out, its link leading nowhere) and
// the old copy under the name it stepped aside as. run.ts only asks; whether the proof
// knows those two shapes is ours.ts's, and a run that asks for what the proof refuses
// would leave a folder behind every time. So here the moves and the removal are the real
// ones, in a folder of this test's own that nothing outside of may be proven in.
// Not on Windows, where this command does not run (nor where a path is not written as the
// disk under it reads one).
describe.skipIf(process.platform === "win32" || path.sep !== "/")(
  "the swap, with the real proof and the real removal",
  () => {
    const TEXT = path.join("..", "lib", "node_modules", "sessionpipe", "dist", "cli.js");
    /** A published copy of a release, as npm unpacks one. */
    const unpack = (dir: string, version: string): void => {
      mkdirSync(path.join(dir, "dist"), { recursive: true });
      writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "sessionpipe", version }));
      writeFileSync(path.join(dir, "dist", "cli.js"), `// ${version}\n`);
      for (const f of ["README.md", "LICENSE", "NOTICE"]) writeFileSync(path.join(dir, f), "");
    };
    /** A prefix as npm lays one out for the package: the copy, and the link that starts it. */
    const lay = (prefix: string, version: string): void => {
      unpack(slotOf(prefix), version);
      mkdirSync(path.join(prefix, "bin"), { recursive: true });
      symlinkSync(TEXT, path.join(prefix, "bin", "sessionpipe"));
    };
    const versionAt = (dir: string): string =>
      (JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { version: string }).version;

    /** A computer in a folder: a prefix (with a copy of `was` in it, or none), and a run
     *  whose moves and removals are real. `npm`: what the stand-in for npm does in the
     *  prefix it is handed, and what it answers. `noted`: whether the folder npm is told
     *  to install into is written down as this run's own, as the command does it (cli.ts
     *  `made`). */
    async function swap(was: string | null, npm: (stage: string) => string | null, noted = true) {
      const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sp-reinstall-run-")));
      try {
        const prefix = path.join(root, "home", ".local");
        const modules = path.join(prefix, "lib", "node_modules");
        const slot = slotOf(prefix);
        const link = path.join(prefix, "bin", "sessionpipe");
        mkdirSync(modules, { recursive: true });
        if (was) lay(prefix, was);
        const { w, d } = start();
        // Only what is inside this test's folder may be proven, and the copy in the slot never.
        // And what this run has npm install into is its own to remove again.
        const made: string[] = [];
        const proving = { reach: root, prefixes: [prefix], npx: null, keep: [slot], made };
        const done = await carryOut(
          plan([{ ...base, do: "install", version: "2.0.0", prefix, dir: slot, replaces: !!was, say: "" }]),
          {
            ...d,
            install: async (stage) => {
              if (noted) made.push(stage);
              return npm(stage);
            },
            exists: existsSync,
            rename: renameSync,
            same,
            remove: async (what) => {
              if (!inside(what, root)) throw new Error(`${what} is outside this test's folder`);
              return removeOurs(what, proving);
            },
            // As the command does it: npm's own link, made where it is not there.
            relink: () => {
              if (!binTarget(link)) {
                mkdirSync(path.dirname(link), { recursive: true });
                symlinkSync(TEXT, link);
              }
              const to = binTarget(link);
              return to !== null && same(to, slot);
            },
          },
        );
        return {
          done,
          said: w.said,
          beside: readdirSync(modules).sort(),
          slot: existsSync(slot) ? versionAt(slot) : null,
          // What the link in the home's bin folder really leads to now.
          starts: existsSync(link) ? path.relative(prefix, realpathSync(link)) : null,
        };
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
    const CLI = path.join("lib", "node_modules", "sessionpipe", "dist", "cli.js");

    it("L1: over a copy: npm's prefix and the old copy are both taken, nothing is left beside the slot, and the home's link was never touched", async () => {
      const r = await swap("1.0.0", (stage) => {
        lay(stage, "2.0.0");
        return null;
      });
      expect(r.said).toEqual(["ok: installed fresh in ~/.local, and it runs (what was there is gone)"]);
      expect(r.done.state).toBe("one");
      expect(r.beside).toEqual(["sessionpipe"]);
      expect(r.slot).toBe("2.0.0");
      // The link npm made in the home long ago leads to the fresh copy: the tidying, which
      // comes before the link is looked for, took neither it nor anything through it.
      expect(r.starts).toBe(CLI);
    });

    it("L1: npm's hidden lock file beside the copy it unpacked is no reason to leave its prefix", async () => {
      const r = await swap("1.0.0", (stage) => {
        lay(stage, "2.0.0");
        writeFileSync(path.join(stage, "lib", "node_modules", ".package-lock.json"), "{}");
        return null;
      });
      expect(r.said).toEqual(["ok: installed fresh in ~/.local, and it runs (what was there is gone)"]);
      expect(r.beside).toEqual(["sessionpipe"]);
    });

    it("L1: npm failing, whatever it had unpacked by then: its prefix is taken, and the copy that was there is as it was", async () => {
      // Stopped half-way: a folder with part of the copy in it, and no link yet.
      const half = await swap("1.0.0", (stage) => {
        mkdirSync(path.join(slotOf(stage), "dist"), { recursive: true });
        writeFileSync(path.join(slotOf(stage), "dist", "cli.js"), "");
        return "npm install: npm error code ENOSPC";
      });
      // Unpacked whole, and then it says nothing of itself.
      const mute = await swap("1.0.0", (stage) => {
        lay(stage, "2.0.0");
        return "npm finished, but the copy says nothing, not 2.0.0";
      });
      // It made its prefix and nothing in it.
      const bare = await swap("1.0.0", (stage) => {
        mkdirSync(stage);
        return "npm install: npm error code E404";
      });
      for (const r of [half, mute, bare]) {
        expect(r.done.state === "failed" && r.done.next).toBe("sessionpipe reinstall");
        expect(r.slot).toBe("1.0.0");
        expect(r.starts).toBe(CLI);
      }
      // The folder is this run's own, whatever npm had got into it by then (no package.json
      // yet: npm's tarball has it last): it is taken, and nothing is said of it.
      for (const r of [half, mute, bare]) {
        expect(r.said).toEqual([]);
        expect(r.beside).toEqual(["sessionpipe"]);
      }
    });

    it("N5: the folder this run had npm install into is its own to remove whatever that release holds; the same folder, only found, must hold a copy the proof accepts", async () => {
      // A release with a file this version does not know of, which then fails to run: what
      // npm unpacked is no copy by this version's proof.
      const newer = (stage: string): string => {
        lay(stage, "2.0.0");
        writeFileSync(path.join(slotOf(stage), "CHANGELOG.md"), "");
        return "npm finished, but the copy says nothing, not 2.0.0";
      };
      // Written down as this run's own (as cli.ts does when it has npm install): it goes.
      const mine = await swap("1.0.0", newer);
      expect(mine.done.state).toBe("failed");
      expect(mine.said).toEqual([]);
      expect(mine.beside).toEqual(["sessionpipe"]);
      expect(mine.slot).toBe("1.0.0");
      // Not written down, the same folder is one that was found: it stays, and that is said.
      const found = await swap("1.0.0", newer, false);
      expect(found.said).toHaveLength(1);
      expect(found.said[0]).toMatch(
        /^warn: .*\.sessionpipe-a1b2c3d4 could not be removed \(.* was left alone: it holds (bin|lib), which no published sessionpipe has \(a checkout or a build\?\)\)$/,
      );
      expect(found.beside).toEqual([".sessionpipe-a1b2c3d4", "sessionpipe"]);
      expect(found.slot).toBe("1.0.0");
      // And half a copy in a folder that was only found is not this command's either.
      const half = await swap(
        "1.0.0",
        (stage) => {
          mkdirSync(path.join(slotOf(stage), "dist"), { recursive: true });
          writeFileSync(path.join(slotOf(stage), "dist", "cli.js"), "");
          return "npm install: npm error code ENOSPC";
        },
        false,
      );
      expect(half.said).toHaveLength(1);
      expect(half.beside).toEqual([".sessionpipe-a1b2c3d4", "sessionpipe"]);
    });

    it("L1: into a prefix with no copy: npm's prefix is taken, and the copy is in its place", async () => {
      const r = await swap(null, (stage) => {
        lay(stage, "2.0.0");
        return null;
      });
      expect(r.said).toEqual(["ok: installed fresh in ~/.local, and it runs"]);
      expect(r.done.state).toBe("one");
      expect(r.beside).toEqual(["sessionpipe"]);
      expect(r.slot).toBe("2.0.0");
      // The link is made only after the tidying, and leads to the copy in the slot.
      expect(r.starts).toBe(CLI);
    });

    it("L6: what npm's prefix holds beside what npm puts there is not this command's to take: it stays, and that is said", async () => {
      const r = await swap("1.0.0", (stage) => {
        lay(stage, "2.0.0");
        writeFileSync(path.join(stage, "notes.txt"), "someone's");
        return null;
      });
      expect(r.said).toHaveLength(2);
      expect(r.said[0]).toMatch(
        // (No "the next run takes it" of such a folder: the next run leaves it alone too.)
        /^warn: .*\.sessionpipe-a1b2c3d4 could not be removed \(.* was left alone: it holds .*, which no published sessionpipe has \(a checkout or a build\?\)\)$/,
      );
      expect(r.said[1]).toBe("ok: installed fresh in ~/.local, and it runs (what was there is gone)");
      // The swap itself was made, and the old copy is gone.
      expect(r.beside).toEqual([".sessionpipe-a1b2c3d4", "sessionpipe"]);
      expect(r.slot).toBe("2.0.0");
      expect(r.starts).toBe(CLI);
    });
  },
);
