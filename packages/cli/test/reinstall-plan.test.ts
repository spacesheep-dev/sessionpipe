// SPDX-License-Identifier: Apache-2.0
// The plan `sessionpipe reinstall` makes (reinstall/plan.ts), from inventories and facts
// written out here: no file is made and nothing is run. One clean copy in use everywhere
// is nothing to repair, wherever it lives and whoever may write there, and each thing
// that breaks that is tried by itself; then every refusal and their order, the steps and
// their order, what each step's row says, what is left alone, what keeps a run safe, and
// what is said beside them. At the end, the two things that hold for every plan, over
// computers made up from a seed (helpers/reinstall-worlds.ts).
//
// The paths here are joined as the plan joins them (`path.join`, `slotIn`), so the file
// reads the same under Windows' path rules; a line to paste is written out whole, from
// paths that are written out whole.
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Copy, Home, Inventory } from "../src/reinstall/find.js";
import { type Facts, idle, plan as made, type Plan, type Step, slotIn, twins, typing } from "../src/reinstall/plan.js";
import { shq } from "../src/shell.js";
import { AHEAD, healthy, NEWEST, world } from "./helpers/reinstall-worlds.js";

const inside = (root: string, p: string): boolean => {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};
/** The one command of someone else's that a plan may name for a copy: Volta's own. */
const KEEPER = "volta uninstall sessionpipe";

/** What no plan may do, whatever it was made from: the rules a plan breaks, in words.
 *  Nothing a step touches is a thing left alone, or inside one. A step is one this
 *  command has (a service file is never a step's to remove), a step that is shown has
 *  words for its row, and the download and the check have none. A plan does nothing, or
 *  refuses, or has steps: one of the three. What keeps a run safe is said only of a plan
 *  that does something, and the download is said to come first exactly where there is
 *  one. And npm is never asked to uninstall: not by a step, not by a line to paste. */
function broken(p: Plan): string[] {
  const no: string[] = [];
  const kept = p.left.map((l) => l.path);
  for (const s of p.steps) {
    if (!["fetch", "install", "stop", "use", "remove", "prove"].includes(s.do)) no.push(`a step named ${s.do}`);
    const touched = [...s.touches, ...(s.do === "remove" ? [s.path] : []), ...(s.do === "install" ? [s.dir] : [])];
    for (const t of touched) if (kept.some((k) => inside(k, t))) no.push(`${s.do} touches ${t}, which is left alone`);
    if (s.do === "fetch" || s.do === "prove") {
      if ("say" in s) no.push(`${s.do} has a row`);
    } else if (s.do !== "use" && !/\S/.test(s.say)) no.push(`${s.do} has no words for its row`);
    if ("why" in s) no.push(`${s.do} says more than its row`);
  }
  if (p.nothing !== null && p.refuse !== null) no.push("it does nothing and refuses");
  if ((p.nothing !== null || p.refuse !== null) && p.steps.length) no.push("it has steps and says it has none");
  if (p.nothing === null && p.refuse === null && !p.steps.length) no.push("it is no plan at all");
  if (p.refuse && /[\r\n]/.test(p.refuse.next)) no.push("a refusal's command is more than one line");
  if (p.safety.length && !p.steps.length) no.push("it says what keeps a run safe, and there is no run");
  const fresh = p.steps.filter((s) => s.do === "fetch" || s.do === "install").map((s) => s.do);
  if (p.steps.length && fresh.join() !== (p.stays === null ? "fetch,install" : ""))
    no.push(`it ${p.stays === null ? "installs" : "keeps the copy"}, and downloads and installs: ${fresh.join()}`);
  if (p.stays !== null && p.home?.writable !== false) no.push("a copy stays that could be installed again");
  const first = `Nothing is touched until ${p.target} has been downloaded and seen to run.`;
  if (p.safety.filter((s) => s.startsWith("Nothing is touched")).join() !== (fresh.length ? first : ""))
    no.push(`its safety line is ${JSON.stringify(p.safety)}`);
  const said = JSON.stringify({ ...p, left: p.left.map((l) => (l.line === KEEPER ? { ...l, line: null } : l)) });
  if (/uninstall/i.test(said)) no.push("it names an uninstall");
  return no;
}

/** Every plan a test here made by hand, for what is asked of all of them at the end. */
const all: Plan[] = [];
/** The plan, as every test here asks for it, held each time to what no plan may do. */
const plan = (...given: Parameters<typeof made>): Plan => {
  const p = made(...given);
  expect(broken(p)).toEqual([]);
  all.push(p);
  return p;
};

const NEW = "1.2.0";
const OLD = "1.1.0";
// Paths are only compared and joined, never opened: any absolute spelling will do.
const ROOT = path.resolve(path.sep, "w");
const HOME = path.join(ROOT, "home");
const LOCAL = path.join(HOME, ".local");
const NVM = path.join(HOME, ".nvm", "versions", "node", "v22.1.0");
const BREW = path.join(ROOT, "opt", "homebrew");
const USR = path.join(ROOT, "usr", "local");
const NPX = path.join(HOME, ".npm", "_npx");
const CACHED = path.join(NPX, "0a1b2c3d4e5f6a7b", "node_modules", "sessionpipe");
const FILE = path.join(HOME, "Library", "LaunchAgents", "org.sessionpipe.control.plist");
const HOOKS = [path.join(LOCAL, "share", "sessionpipe", "hook"), path.join(HOME, ".claude", "settings.json")];

/** The link npm makes in a prefix. */
const bin = (prefix: string): string => path.join(prefix, "bin", "sessionpipe");

/** A published copy in a global prefix: whole, the newest, used by nothing, its command
 *  folder one a shell looks in. */
const copy = (prefix: string, over: Partial<Copy> = {}): Copy => ({
  dir: slotIn(prefix),
  where: prefix,
  prefix,
  slot: "global",
  not: null,
  aside: false,
  version: NEW,
  wrong: null,
  bins: [bin(prefix)],
  uses: [],
  onPath: true,
  writable: true,
  keeper: null,
  ...over,
});
/** The copy everything uses, in ~/.local. */
const one = (over: Partial<Copy> = {}): Copy =>
  copy(LOCAL, { where: "~/.local", uses: ["typed", "service", "hooks", "this"], ...over });
/** A copy in the npx cache: its place is the cache entry it is in. */
const cached = (over: Partial<Copy> = {}): Copy =>
  copy(LOCAL, {
    dir: CACHED,
    where: "~/.npm/_npx/0a1b2c3d4e5f6a7b",
    prefix: null,
    slot: "npx",
    bins: [],
    onPath: false,
    ...over,
  });
/** A folder left in a prefix when an install was cut off. */
const leftover = (prefix: string, over: Partial<Copy> = {}): Copy =>
  copy(prefix, {
    dir: path.join(prefix, "lib", "node_modules", ".sessionpipe-Ab12Cd34"),
    aside: true,
    version: null,
    wrong: "left behind by an install that was cut off",
    bins: [],
    ...over,
  });
/** A folder that is no install of it: someone's checkout. */
const NOT_PUBLISHED = "it holds src, which no published sessionpipe has (a checkout or a build?)";
const checkedOut = (over: Partial<Copy> = {}): Copy =>
  copy(path.join(HOME, "code"), {
    dir: path.join(HOME, "code", "sessionpipe"),
    where: "~/code/sessionpipe",
    prefix: null,
    slot: null,
    not: NOT_PUBLISHED,
    bins: [],
    onPath: false,
    ...over,
  });

/** Where the one copy lives: ~/.local, its bin folder on PATH, this user's to write. */
const home = (over: Partial<Home> = {}): Home => ({
  prefix: LOCAL,
  shown: "~/.local",
  why: "where the one you type is",
  bin: path.join(LOCAL, "bin"),
  onPath: true,
  blocked: null,
  writable: true,
  ...over,
});
/** A computer with the one copy, typed through npm's own link in its bin folder. */
const inv = (over: Partial<Inventory> = {}): Inventory => ({
  reach: true,
  copies: [one()],
  dangling: [],
  strangers: [],
  onPath: [{ file: bin(LOCAL), dir: slotIn(LOCAL) }],
  typed: slotIn(LOCAL),
  unsure: null,
  home: home(),
  taken: null,
  prefixes: [LOCAL],
  npx: NPX,
  ...over,
});
/** The same computer with nothing a shell finds: nothing is typed, and no copy says it is.
 *  (Whether a shell looks in a copy's command folder is the copy's own to say, `onPath`:
 *  a test of a copy off PATH says so of the copy.) */
const untyped = (over: Partial<Inventory> = {}): Inventory =>
  inv({ copies: [one({ uses: ["service", "hooks", "this"] })], onPath: [], typed: null, ...over });
/** The one copy where no shell looks: whole, with npm's link, nobody types it. */
const unseen = (over: Partial<Copy> = {}): Copy => one({ uses: ["service", "hooks", "this"], onPath: false, ...over });
type Service = NonNullable<Facts["service"]>;
const service = (over: Partial<Service> = {}): Service => ({
  file: FILE,
  loaded: true,
  pid: 100,
  node: path.join(ROOT, "usr", "bin", "node"),
  nodeOk: true,
  cliOk: true,
  ...over,
});
/** Everything on the newest release: hooks written by it, the service running it. */
const facts = (over: Partial<Facts> = {}): Facts => ({
  latest: { version: NEW },
  npm: true,
  harnesses: ["claude"],
  hooks: { version: NEW, wrong: [] },
  hookFiles: HOOKS,
  wanted: true,
  service: service(),
  staleSocket: false,
  daemon: { pid: 100, version: NEW, byHand: null },
  apart: null,
  ...over,
});

/** The steps of a plan by name, a removal with what it removes. */
const does = (p: Plan): string[] => p.steps.map((s) => (s.do === "remove" ? `remove ${s.path}` : s.do));
const step = <K extends Step["do"]>(p: Plan, k: K): Extract<Step, { do: K }> =>
  p.steps.find((s) => s.do === k) as Extract<Step, { do: K }>;
/** What a repair of the one copy is, with nothing else to remove. */
const REPAIR = ["fetch", "install", "use", "prove"];
/** A plan that is nothing but its refusal: nothing is carried beside it. */
const REFUSED = { nothing: null, target: null, home: null, stays: null, steps: [], safety: [], left: [], notes: [] };
/** The refusal of a plan that refuses, held to changing and saying nothing else. */
const refused = (p: Plan): Plan["refuse"] => {
  expect(p).toEqual({ ...REFUSED, refuse: p.refuse });
  expect(p.refuse).not.toBeNull();
  return p.refuse;
};

/** One clean copy and nothing found that is not as it should be: the one sentence that
 *  says "nothing to repair". What can't be known (which copy a shim starts, whether npm
 *  has a newer release) is a note beside it and does not take the sentence away. */
const NOTHING = "Nothing to repair: one sessionpipe, 1.2.0, the newest release.";
/** The same where npm couldn't be asked: no release is called the newest. */
const NOTHING_UNASKED = (version: string) => `Nothing to repair: one sessionpipe, ${version}.`;
/** The same one copy with a finding beside it (what is typed is no copy of it, a folder is
 *  not on PATH, nothing starts the service): no step would change it, and the sentence
 *  no longer calls it nothing to repair. The note says what there is to say. */
const ONE_COPY = "One sessionpipe on this computer: 1.2.0, the newest release.";
/** And a finding where npm couldn't be asked: no release is called the newest. */
const UNASKED = (version: string) => `One sessionpipe on this computer: ${version}.`;
const OFFLINE = "registry.npmjs.org can't be reached (ENOTFOUND)";
const NPM_UNASKED = (version: string, error = OFFLINE) =>
  `npm couldn't be asked whether ${version} is the newest release: ${error}.`;
/** An npx cache entry nothing uses, where there is nothing to repair: a row of what is left. */
const NPX_CACHE = "npm's cache of what npx ran";
const NOT_ON_PATH = (dir: string) =>
  `${dir} is not on your PATH: add it, or \`sessionpipe\` is not found when you type it.`;
const NOTHING_STARTS_IT =
  "The background service isn't running, and nothing here starts it by itself: `sessionpipe control run` does.";
/** What typing `sessionpipe` starts, where that is a file that says nothing of a copy. */
const UNSURE = (file: string) =>
  `Typing \`sessionpipe\` starts ${file}, which is no link of npm's: which copy it starts can't be told from here.`;
/** And where it is a folder that is no installed copy. */
const NO_INSTALL = (where: string) => `Typing \`sessionpipe\` starts ${where}, which is no installed copy of it.`;
/** The first and the last step: neither has a row, so neither has words for one. */
const FETCH: Step = { do: "fetch", version: NEW, touches: [] };
const PROVE: Step = { do: "prove", touches: [] };
/** What the "switch" row says where agents are hooked and there is a service to move. */
const SERVED = "the hooks and the background service to it";
/** What keeps a run safe: said of every plan that installs. */
const SAFE = "Nothing is touched until 1.2.0 has been downloaded and seen to run.";
/** And what restarts, where something runs in the background. */
const SERVICE_RESTARTS = "The service keeps its environment and restarts once it holds nothing.";
const DAEMON_RESTARTS = "The daemon restarts once it holds nothing.";
/** A file named sessionpipe that leads to no install, and what the look says of it. */
const SCRIPT = path.join(HOME, "bin", "sessionpipe");
const STRANGER = { file: SCRIPT, why: "a file npm didn't put there" };

describe("slotIn: the package folder a prefix holds sessionpipe in", () => {
  it("is lib/node_modules/sessionpipe under the prefix, and asks for nothing but the prefix", () => {
    expect(slotIn(LOCAL)).toBe(path.join(LOCAL, "lib", "node_modules", "sessionpipe"));
    expect(slotIn("/usr/local")).toBe(path.join("/usr/local", "lib", "node_modules", "sessionpipe"));
    // No platform is handed in: this module is POSIX's, and Windows is refused before it.
    expect(slotIn.length).toBe(1);
  });
});

describe("nothing to repair", () => {
  it("one clean copy of the newest release, typed, hooked and served: one sentence and no step", () => {
    expect(plan(inv(), facts())).toEqual({
      nothing: NOTHING,
      refuse: null,
      target: NEW,
      home: home(),
      stays: null,
      steps: [],
      safety: [],
      left: [],
      notes: [],
    });
  });

  it("what is no install of it is left and said, with no step, and it is still nothing to repair", () => {
    const checkout = checkedOut({ version: "9.9.9" });
    const kept = copy(path.join(HOME, ".volta", "tools", "image", "packages", "sessionpipe"), {
      where: "~/.volta/tools/image/packages/sessionpipe",
      slot: null,
      not: "Volta keeps it",
      keeper: "volta uninstall sessionpipe",
    });
    const p = plan(
      inv({
        copies: [checkout, one(), kept],
        strangers: [STRANGER],
        // A file of the name that leads to no install is on PATH too, behind this copy.
        onPath: [
          { file: bin(LOCAL), dir: slotIn(LOCAL) },
          { file: SCRIPT, dir: null },
        ],
      }),
      facts(),
    );
    expect(p.nothing).toBe(NOTHING);
    expect(p.refuse).toBeNull();
    expect(p.steps).toEqual([]);
    expect(p.safety).toEqual([]);
    expect(p.notes).toEqual([]);
    expect(p.left).toEqual([
      {
        where: "~/code/sessionpipe",
        path: checkout.dir,
        version: "9.9.9",
        why: NOT_PUBLISHED,
        line: null,
        ours: false,
      },
      {
        where: "~/.volta/tools/image/packages/sessionpipe",
        path: kept.dir,
        version: NEW,
        why: "Volta keeps it",
        // Volta's own command for its own copy: said, never run, and the one line of
        // someone else's a plan may name.
        line: "volta uninstall sessionpipe",
        ours: false,
      },
      { where: SCRIPT, path: SCRIPT, version: null, why: "a file npm didn't put there", line: null, ours: false },
    ]);
  });

  it("with no agent hooked, the hooks are not asked about", () => {
    const f = facts({ harnesses: [], hooks: { version: null, wrong: ["the launcher names a node that is gone"] } });
    expect(plan(inv(), f).nothing).toBe(NOTHING);
  });

  it("a service whose manager names no process is not held against it", () => {
    expect(plan(inv(), facts({ service: service({ pid: null }) })).nothing).toBe(NOTHING);
  });

  it("with no service file: no daemon at all, or one someone runs by hand on the newest release", () => {
    const unserved = inv({ copies: [one({ uses: ["typed", "hooks", "this"] })] });
    const byHand = plan(unserved, facts({ service: null, daemon: { pid: 222, version: NEW, byHand: null } }));
    expect(byHand.nothing).toBe(NOTHING);
    expect(byHand.notes).toEqual([]);
    // Nothing needs the service and none runs: nothing to say either.
    const none = plan(unserved, facts({ service: null, daemon: null, wanted: false }));
    expect(none.nothing).toBe(NOTHING);
    expect(none.notes).toEqual([]);
    // Something needs it and nothing starts it: that is said, and is not this command's to
    // repair. With a note beside it the sentence says what is here, not "nothing to repair".
    const wanted = plan(unserved, facts({ service: null, daemon: null }));
    expect(wanted.nothing).toBe(ONE_COPY);
    expect(wanted.steps).toEqual([]);
    expect(wanted.notes).toEqual([NOTHING_STARTS_IT]);
  });

  it("a service file nothing needs, with no daemon answering, is left as it is and is nothing to say: 'Nothing to repair', no note, no step", () => {
    // The file is not this command's to remove: what says nothing needs the service is a
    // file of settings, and those may be another sessionpipe's. And it is no finding: doctor
    // says all is well of this computer, and so does this.
    for (const s of [service(), service({ loaded: false }), service({ nodeOk: false, cliOk: false, pid: null })]) {
      const p = plan(inv(), facts({ wanted: false, daemon: null, service: s }));
      expect(p.nothing).toBe(NOTHING);
      expect(p.refuse).toBeNull();
      expect(p.steps).toEqual([]);
      expect(p.notes).toEqual([]);
    }
    // Whatever copy that file names: it is not asked which.
    const elsewhere = plan(
      inv({ copies: [one({ uses: ["typed", "hooks", "this"] })] }),
      facts({ wanted: false, daemon: null }),
    );
    expect(elsewhere.nothing).toBe(NOTHING);
    expect(elsewhere.notes).toEqual([]);
    expect(elsewhere.steps).toEqual([]);
    // While a daemon answers it is a service in use, held to what any service is.
    expect(plan(inv(), facts({ wanted: false })).nothing).toBeNull();
  });

  it("nothing typed, and the folder the copy's command is in not on PATH: said beside the one copy, never 'nothing to repair'", () => {
    const off = home({ onPath: false, why: "where this command runs from" });
    const p = plan(untyped({ copies: [unseen()], home: off }), facts());
    expect(p.nothing).toBe(ONE_COPY);
    expect(p.steps).toEqual([]);
    expect(p.notes).toEqual([NOT_ON_PATH(path.join(LOCAL, "bin"))]);
    // The folder named is the COPY's own command folder, wherever the look would put a
    // fresh one. One whole copy in Homebrew's prefix, that folder off PATH, and an empty
    // ~/.local/bin that is on PATH (the home, then): "Nothing to repair" was said of it,
    // and doctor said "All good", while typing `sessionpipe` found nothing.
    for (const mine of [[], [cached({ uses: ["this"] })]]) {
      const lone = copy(BREW, {
        where: "/opt/homebrew",
        uses: mine.length ? ["service", "hooks"] : ["service", "hooks", "this"],
        onPath: false,
      });
      const elsewhere = plan(
        untyped({ copies: [lone, ...mine], home: home({ why: "a folder of your own" }), prefixes: [BREW, LOCAL] }),
        facts(),
      );
      expect(elsewhere.nothing).toBe(ONE_COPY);
      expect(elsewhere.notes).toEqual([NOT_ON_PATH(path.join(BREW, "bin"))]);
      expect(elsewhere.steps).toEqual([]);
      expect(elsewhere.refuse).toBeNull();
    }
    // What is typed is that copy, through a shim or a link of one's own: its own folder
    // not being on PATH is nothing to say.
    expect(plan(inv({ copies: [one({ onPath: false })], home: off }), facts()).nothing).toBe(NOTHING);
    // And with no copy installed there is nothing to say of PATH at all: where a fresh
    // one would go is decided when this command acts (an npx cache entry is no install).
    const none = plan(
      untyped({ copies: [cached({ uses: ["this"] })], home: off }),
      facts({ service: null, daemon: null, wanted: false, harnesses: [] }),
    );
    expect(none.notes).toEqual([]);
    expect(refused(none)?.next).toBe(`export PATH=${shq(path.join(LOCAL, "bin"), "linux")}:"$PATH"`);
  });

  it("what was found beside the one copy is a row of what is left: what is no install, then npm's cache entry", () => {
    const entry = cached({ uses: ["this"] });
    const checkout = checkedOut({ where: "~/code", not: "it holds src" });
    const strangers = [STRANGER];
    const beside = (i: Partial<Inventory>, f: Partial<Facts> = {}) => {
      const p = plan(inv(i), facts(f));
      expect(p.steps).toEqual([]);
      return { nothing: p.nothing, left: p.left, notes: p.notes };
    };
    /** The rows, as each kind is listed. */
    const inCache = {
      where: "~/.npm/_npx/0a1b2c3d4e5f6a7b",
      path: CACHED,
      version: NEW,
      why: NPX_CACHE,
      line: null,
      ours: false,
    };
    const noInstall = {
      where: "~/code",
      path: checkout.dir,
      version: NEW,
      why: "it holds src",
      line: null,
      ours: false,
    };
    const aFile = { where: SCRIPT, path: SCRIPT, version: null, why: STRANGER.why, line: null, ours: false };
    // "Found 2 copies" above the sentence is then no contradiction of it: the second is
    // listed, as npm's own cache, and is no copy this command would have removed.
    const typed = one({ uses: ["typed", "service", "hooks"] });
    expect(beside({ copies: [entry, typed] })).toEqual({ nothing: NOTHING, left: [inCache], notes: [] });
    // One nothing uses at all, the same.
    expect(beside({ copies: [one(), cached()] })).toEqual({ nothing: NOTHING, left: [inCache], notes: [] });
    expect(beside({ copies: [one(), checkout] })).toEqual({ nothing: NOTHING, left: [noInstall], notes: [] });
    expect(beside({ strangers })).toEqual({ nothing: NOTHING, left: [aFile], notes: [] });
    // All of them: what is no install first, as in every plan, then the cache.
    expect(beside({ copies: [checkout, typed, entry], strangers })).toEqual({
      nothing: NOTHING,
      left: [noInstall, aFile, inCache],
      notes: [],
    });
    // A row of what is left is no note: it is still "nothing to repair". Alone, the one
    // copy is all there is to say.
    expect(beside({})).toEqual({ nothing: NOTHING, left: [], notes: [] });
    // Where npm couldn't be asked, the rows are the same beside the note that says so; it
    // is what can't be known, no finding, so it is still nothing to repair.
    expect(beside({ copies: [one(), checkout, cached()] }, { latest: { error: OFFLINE } })).toEqual({
      nothing: NOTHING_UNASKED(NEW),
      left: [noInstall, inCache],
      notes: [NPM_UNASKED(NEW)],
    });
  });

  it("what else a shell finds behind this copy is nothing to say; ahead of it, it is what is typed: said, and no step", () => {
    const checkout = checkedOut();
    const mine = { file: bin(LOCAL), dir: slotIn(LOCAL) };
    const theirs = { file: path.join(HOME, "code", "bin", "sessionpipe"), dir: checkout.dir };
    // After this copy on PATH, a folder that is left alone is in nobody's way: no repair
    // (none could change it), and nothing to say.
    const after = plan(inv({ copies: [one(), checkout], onPath: [mine, theirs] }), facts());
    expect(after.nothing).toBe(NOTHING);
    expect(after.notes).toEqual([]);
    // Before it, it is what typing `sessionpipe` starts: no step could change that, and
    // the sentence no longer says "nothing to repair".
    const before = plan(
      inv({
        copies: [checkedOut({ uses: ["typed"] }), one({ uses: ["service", "hooks", "this"] })],
        onPath: [theirs, mine],
        typed: checkout.dir,
        home: null,
      }),
      facts(),
    );
    expect(before.nothing).toBe(ONE_COPY);
    expect(before.refuse).toBeNull();
    expect(before.steps).toEqual([]);
    expect(before.notes).toEqual([NO_INSTALL("~/code/sessionpipe")]);
    // With no home to speak of, none is answered.
    expect(before.home).toBeNull();
  });

  it("what was found comes first and decides the sentence; what can't be known comes after it and takes 'nothing to repair' from nobody", () => {
    const shim = path.join(HOME, ".asdf", "shims", "sessionpipe");
    const strangers = [{ file: shim, why: "a file npm didn't put there" }];
    // A shim first on PATH, and this command started from npx: which copy the shim starts
    // can't be told, and the one copy that is here is whole.
    const lost = (f: Partial<Facts> = {}, show?: (p: string) => string) =>
      plan(
        inv({
          copies: [cached({ uses: ["this"] }), one({ uses: ["hooks"] })],
          strangers,
          onPath: [
            { file: shim, dir: null },
            { file: bin(LOCAL), dir: slotIn(LOCAL) },
          ],
          typed: null,
          unsure: shim,
          home: null,
        }),
        facts({ service: null, daemon: null, ...f }),
        show,
      );
    // A finding (nothing starts the service this computer wants) and something that can't
    // be known (what the shim starts): the finding first, and it is what makes the sentence
    // "One sessionpipe…".
    const whole = lost();
    expect(whole.nothing).toBe(ONE_COPY);
    expect(whole.steps).toEqual([]);
    expect(whole.target).toBe(NEW);
    expect(whole.notes).toEqual([NOTHING_STARTS_IT, UNSURE(shim)]);
    // The path is said as a sentence says one; the file itself stays whole beside it.
    const shown = lost({}, (p) => `<${p}>`);
    expect(shown.notes).toEqual([NOTHING_STARTS_IT, UNSURE(`<${shim}>`)]);
    expect(shown.left.map((l) => [l.where, l.path])).toEqual([
      [`<${shim}>`, shim],
      ["~/.npm/_npx/0a1b2c3d4e5f6a7b", CACHED],
    ]);
    // Offline, what is said of npm comes last, and the sentence calls nothing the newest.
    const offline = lost({ latest: { error: OFFLINE } });
    expect(offline.nothing).toBe(UNASKED(NEW));
    expect(offline.notes).toEqual([NOTHING_STARTS_IT, UNSURE(shim), NPM_UNASKED(NEW)]);
    // What can't be known ALONE (nothing here needs a service): it is nothing to repair,
    // with the note beside it. Doctor calls this computer all good, and so does this.
    const unknown = lost({ wanted: false });
    expect(unknown.nothing).toBe(NOTHING);
    expect(unknown.notes).toEqual([UNSURE(shim)]);
    expect(unknown.steps).toEqual([]);
    expect(unknown.refuse).toBeNull();
    // Both unknowns alone: the shim first, then npm, and no release is called the newest.
    const both = lost({ wanted: false, latest: { error: OFFLINE } });
    expect(both.nothing).toBe(NOTHING_UNASKED(NEW));
    expect(both.notes).toEqual([UNSURE(shim), NPM_UNASKED(NEW)]);
    // A service file nothing needs adds nothing to say.
    const idleFile = lost({ service: service(), wanted: false });
    expect(idleFile.notes).toEqual([UNSURE(shim)]);
    expect(idleFile.nothing).toBe(NOTHING);
    // And each kind of finding beside an unknown: what is typed being no installed copy can't
    // come with `unsure` (one or the other is so), the folder off PATH can't either (there
    // is no home with `unsure`); the service is the finding that can.
    for (const p of [whole, shown, offline]) expect(p.nothing).toMatch(/^One sessionpipe on this computer: /);
  });

  it("offline, one clean copy is still nothing to repair: a note says npm wasn't asked, and nothing is called the newest release", () => {
    const latest = { error: OFFLINE };
    expect(plan(inv(), facts({ latest }))).toEqual({
      nothing: "Nothing to repair: one sessionpipe, 1.2.0.",
      refuse: null,
      target: NEW,
      home: home(),
      stays: null,
      steps: [],
      safety: [],
      left: [],
      notes: [
        "npm couldn't be asked whether 1.2.0 is the newest release: registry.npmjs.org can't be reached (ENOTFOUND).",
      ],
    });
    // Whatever release that copy is: with nothing to compare it to, the hooks and the
    // daemon are held to the copy's own.
    const older = plan(
      inv({ copies: [one({ version: OLD })] }),
      facts({ latest, hooks: { version: OLD, wrong: [] }, daemon: { pid: 100, version: OLD, byHand: null } }),
    );
    expect(older.nothing).toBe(NOTHING_UNASKED(OLD));
    expect(older.notes).toEqual([NPM_UNASKED(OLD)]);
    expect(older.target).toBe(OLD);
    // Why it couldn't be asked is npm's own word, whatever it is; it comes after every other note.
    const both = plan(
      untyped({ copies: [unseen()], home: home({ onPath: false }) }),
      facts({ latest: { error: "npm error code E503" }, service: null, daemon: null }),
    );
    expect(both.nothing).toBe(UNASKED(NEW));
    expect(both.notes).toEqual([
      NOT_ON_PATH(path.join(LOCAL, "bin")),
      NOTHING_STARTS_IT,
      NPM_UNASKED(NEW, "npm error code E503"),
    ]);
    // No release is called the newest where npm couldn't be asked, by either sentence.
    for (const p of [older, both]) expect(p.nothing).not.toMatch(/newest/);
  });
});

describe("each thing that makes it a repair, by itself", () => {
  const second = copy(BREW, { where: "/opt/homebrew", version: OLD });
  const cases: [string, Partial<Inventory>, Partial<Facts>, string[]][] = [
    ["a second copy", { copies: [one(), second] }, {}, ["fetch", "install", "use", `remove ${second.dir}`, "prove"]],
    [
      "a copy that doesn't run",
      { copies: [one({ wrong: "it doesn't run: `--version` printed nothing" })] },
      {},
      REPAIR,
    ],
    [
      "a copy that says it is another release than its package.json does",
      { copies: [one({ wrong: "it says it is 1.1.0, and its package.json says 1.2.0" })] },
      {},
      REPAIR,
    ],
    [
      "a copy cut off before its dist/cli.js was there",
      { copies: [one({ wrong: "its dist/cli.js is missing (an install that was cut off?)" })] },
      {},
      REPAIR,
    ],
    // It runs by its path, and nothing a person types starts it.
    [
      "a copy whose link is gone",
      {
        copies: [one({ bins: [], wrong: "npm's link to it is gone", uses: ["service", "hooks", "this"] })],
        onPath: [],
        typed: null,
        home: home({ why: "where this command runs from" }),
      },
      {},
      REPAIR,
    ],
    ["a copy of an older release", { copies: [one({ version: OLD })] }, {}, REPAIR],
    [
      "a link to a copy that is gone",
      { dangling: [bin(USR)] },
      {},
      ["fetch", "install", "use", `remove ${bin(USR)}`, "prove"],
    ],
    [
      "hooks with something wrong",
      {},
      { hooks: { version: NEW, wrong: ["claude: missing (~/.claude/settings.json)"] } },
      REPAIR,
    ],
    ["hooks another release wrote", {}, { hooks: { version: OLD, wrong: [] } }, REPAIR],
    ["hooks nothing has written", {}, { hooks: { version: null, wrong: [] } }, REPAIR],
    ["a service file nothing needs, while a daemon answers", {}, { wanted: false }, REPAIR],
    ["a service that is not loaded", {}, { service: service({ loaded: false }) }, REPAIR],
    ["a service file that names a node that is gone", {}, { service: service({ nodeOk: false }) }, REPAIR],
    ["a service that runs another copy", { copies: [one({ uses: ["typed", "hooks", "this"] })] }, {}, REPAIR],
    ["a service that is loaded, and nothing answers", {}, { daemon: null }, REPAIR],
    ["a service whose daemon is another release", {}, { daemon: { pid: 100, version: OLD, byHand: null } }, REPAIR],
    [
      "a service file, and a daemon someone started by hand",
      {},
      { daemon: { pid: 222, version: NEW, byHand: null } },
      ["fetch", "install", "stop", "use", "prove"],
    ],
    [
      "no service file, and a daemon someone runs by hand on another release",
      { copies: [one({ uses: ["typed", "hooks", "this"] })] },
      { service: null, daemon: { pid: 222, version: OLD, byHand: null } },
      REPAIR,
    ],
  ];
  it.each(cases)("%s", (_name, i, f, steps) => {
    const given = inv(i);
    const p = plan(given, facts(f));
    expect(p.nothing).toBeNull();
    expect(p.refuse).toBeNull();
    expect(p.target).toBe(NEW);
    // The home is the look's own: the plan chooses none.
    expect(p.home).toBe(given.home);
    expect(p.home?.prefix).toBe(LOCAL);
    expect(p.stays).toBeNull();
    expect(does(p)).toEqual(steps);
    // Whatever the repair is, the first thing said of how it is kept safe is the same.
    expect(p.safety[0]).toBe(SAFE);
  });
});

describe("it refuses, and changes nothing", () => {
  /** Something to repair: a second copy. */
  const two = (over: Partial<Inventory> = {}) =>
    inv({ copies: [one(), copy(BREW, { where: "/opt/homebrew", version: OLD })], ...over });

  it("a sessionpipe that keeps its files apart, in this account's own home, touches no copy", () => {
    const apart = {
      said: "This sessionpipe keeps its files in /tmp/world, not in this computer's usual place (~/.local/state/sessionpipe)",
      line: "env -u SESSIONPIPE_STATE -u SESSIONPIPE_CONFIG sessionpipe reinstall",
    };
    // Whatever was found, a file that is no install first on PATH too: nothing is listed
    // as left, nothing is said beside it.
    expect(
      plan(
        two({ reach: null, strangers: [STRANGER], onPath: [{ file: SCRIPT, dir: null }], typed: null, unsure: SCRIPT }),
        facts({ apart }),
      ),
    ).toEqual({
      ...REFUSED,
      refuse: {
        error:
          "This sessionpipe keeps its files in /tmp/world, not in this computer's usual place (~/.local/state/sessionpipe), so it leaves this computer's copies alone. Nothing was changed",
        next: "env -u SESSIONPIPE_STATE -u SESSIONPIPE_CONFIG sessionpipe reinstall",
      },
    });
    // The line is the caller's, whatever it unsets: it is handed on as it is.
    const xdg = { said: apart.said, line: "env -u XDG_STATE_HOME -u SESSIONPIPE_SERVICE_LABEL sessionpipe reinstall" };
    expect(refused(plan(two({ reach: null }), facts({ apart: xdg })))?.next).toBe(xdg.line);
    // In a home of its own it has copies to call its own: it goes on as anywhere.
    expect(plan(inv({ reach: path.join(ROOT, "world") }), facts({ apart })).nothing).toBe(NOTHING);
    expect(does(plan(two({ reach: path.join(ROOT, "world") }), facts({ apart }))).slice(0, 2)).toEqual([
      "fetch",
      "install",
    ]);
    // And it is the sentence that refuses: no reach by itself decides nothing here.
    expect(plan(inv({ reach: null }), facts()).nothing).toBe(NOTHING);
  });

  it("npm couldn't be asked for the newest release: a fresh copy comes from npm", () => {
    const offline = facts({ latest: { error: "registry.npmjs.org can't be reached (ECONNREFUSED)" }, npm: false });
    // A refusal is all a plan that refuses holds: what was found is on the screen above it.
    expect(refused(plan(two({ strangers: [STRANGER] }), offline))).toEqual({
      error:
        "npm couldn't be asked for the newest release (registry.npmjs.org can't be reached (ECONNREFUSED)), and a fresh copy comes from npm. Nothing was changed",
      next: "sessionpipe reinstall",
    });
    // With no copy at all there is no release to hold anything to either.
    const none = plan(inv({ copies: [], onPath: [], typed: null }), offline);
    expect(refused(none)?.next).toBe("sessionpipe reinstall");
    expect(none.target).toBeNull();
  });

  it("no npm to run", () => {
    // It comes before what npm's newest release would be compared with.
    const p = plan(two({ copies: [one(), copy(BREW, { version: "2.0.0" })] }), facts({ npm: false }));
    expect(refused(p)).toEqual({
      error:
        "npm is not beside this Node nor on PATH, and a fresh copy comes from npm. Nothing was changed. Install npm, then run this again",
      next: "sessionpipe reinstall",
    });
  });

  it("something here is newer than npm's newest release: a copy, the hooks, or the daemon", () => {
    const ahead = (v: string) => ({
      error: `sessionpipe ${v} is on this computer, newer than npm's newest release (1.2.0): a reinstall would move it back. Nothing was changed`,
      next: "sessionpipe doctor",
    });
    // A copy, also a pre-release of what comes next; and it is said before a missing home.
    expect(refused(plan(two({ copies: [one(), copy(BREW, { version: "1.3.0" })] }), facts()))).toEqual(ahead("1.3.0"));
    expect(refused(plan(inv({ copies: [one({ version: "1.3.0-rc.1" })], home: null }), facts()))).toEqual(
      ahead("1.3.0-rc.1"),
    );
    // The hooks; a leftover folder that names no release is passed over on the way to them.
    expect(
      refused(
        plan(
          inv({ copies: [leftover(LOCAL, { where: "~/.local" }), one()] }),
          facts({ hooks: { version: "1.2.1", wrong: [] } }),
        ),
      ),
    ).toEqual(ahead("1.2.1"));
    // The daemon, with a service file and without one.
    expect(refused(plan(two(), facts({ daemon: { pid: 100, version: "2.0.0", byHand: null } })))).toEqual(
      ahead("2.0.0"),
    );
    expect(
      refused(plan(two(), facts({ service: null, daemon: { pid: 222, version: "2.0.0", byHand: null } }))),
    ).toEqual(ahead("2.0.0"));
    // The first found is the one named: copies, then the hooks, then the daemon.
    expect(
      refused(
        plan(
          two({ copies: [one(), copy(BREW, { version: "1.4.0" })] }),
          facts({ hooks: { version: "1.5.0", wrong: [] }, daemon: { pid: 100, version: "1.6.0", byHand: null } }),
        ),
      ),
    ).toEqual(ahead("1.4.0"));
  });

  it("a newer folder that is no install of it (a checkout) stands in nobody's way", () => {
    const checkout = checkedOut({ version: "9.9.9" });
    const p = plan(two({ copies: [one(), copy(BREW, { version: OLD }), checkout] }), facts());
    expect(p.refuse).toBeNull();
    expect(does(p)).toEqual(["fetch", "install", "use", `remove ${slotIn(BREW)}`, "prove"]);
  });

  it("no folder can hold the one copy: refused with the line that shows what PATH finds, not `doctor`, which would name this command back", () => {
    const NO_HOME = {
      error: "no folder on this computer can hold the one copy of sessionpipe. Nothing was changed",
      next: "which -a sessionpipe",
    };
    // Nothing is typed, and no place a shell would find a fresh one.
    expect(refused(plan(untyped({ copies: [cached({ uses: ["this"] })], home: null }), facts()))).toEqual(NO_HOME);
    // With copies to clear away and no place for the one to stay: the same, and no step.
    const strays = [copy(BREW, { version: OLD, onPath: false }), copy(NVM, { version: OLD, onPath: false })];
    expect(refused(plan(untyped({ copies: strays, home: null }), facts()))).toEqual(NO_HOME);
    expect(NO_HOME.next).not.toMatch(/sessionpipe (doctor|reinstall)/);
  });

  it("the copy that is typed lives in Homebrew's versioned folder: that folder is its home, and it is repaired there (the look names no other place, and none at all was a refusal doctor answered with this command)", () => {
    const cellar = path.join(BREW, "Cellar", "node", "22.1.0");
    const brewed = home({ prefix: cellar, shown: cellar, bin: path.join(cellar, "bin") });
    const there = copy(cellar, { version: OLD, uses: ["typed", "service", "hooks", "this"] });
    const at = (c: Copy, over: Partial<Inventory> = {}): Inventory =>
      inv({ copies: [c], onPath: [{ file: bin(cellar), dir: c.dir }], typed: c.dir, home: brewed, ...over });
    const p = plan(at(there), facts());
    expect(does(p)).toEqual(REPAIR);
    expect(step(p, "install")).toMatchObject({ prefix: cellar, dir: slotIn(cellar), replaces: true });
    // A stray elsewhere goes; the fresh copy still goes where the typed one is.
    const stray = copy(LOCAL, { where: "~/.local", version: OLD });
    const two = plan(at(there, { copies: [there, stray] }), facts());
    expect(does(two)).toEqual(["fetch", "install", "use", `remove ${stray.dir}`, "prove"]);
    expect(step(two, "install").prefix).toBe(cellar);
    // Whole and the newest there, it is nothing to repair, as anywhere.
    const fine = plan(at({ ...there, version: NEW }), facts());
    expect(fine.nothing).toBe(NOTHING);
    expect(fine.home).toEqual(brewed);
  });

  /** What it says of a file that is not npm's link, where npm's link goes. */
  const inTheWay = (file: string) =>
    `${file} is not sessionpipe's, and it is where the fresh copy's link goes: npm won't write over it. Nothing was changed. Move it aside, then run this again`;
  /** The one copy with a file where its link was, as the look answers it: nothing a person
   *  types starts it, nothing is unsure, and the home is that copy's prefix, blocked. */
  const blocked = (file: string, over: Partial<Inventory> = {}) =>
    untyped({
      copies: [one({ bins: [], wrong: "npm's link to it is gone", uses: ["service", "hooks", "this"] })],
      home: home({ blocked: file, why: "where the copy is whose link is gone" }),
      ...over,
    });

  it("L7: a file that is not npm's link sits where the fresh copy's link goes: refused, with a line that moves it and writes over nothing (`mv -n`)", () => {
    // The paths are written out: they are only said and quoted, as any computer would have them.
    const at = (file: string) => plan(blocked(file), facts());
    const plain = "/home/u/.local/bin/sessionpipe";
    expect(refused(at(plain))).toEqual({
      error: inTheWay(plain),
      // `-n`: a `sessionpipe.old` that is there already is somebody's, and stays.
      next: "mv -n /home/u/.local/bin/sessionpipe /home/u/.local/bin/sessionpipe.old",
    });
    // A path a shell would split or act on is one word of the line, each time.
    const spaced = "/home/my name/.local/bin/sessionpipe";
    expect(refused(at(spaced))).toEqual({
      error: inTheWay(spaced),
      next: "mv -n '/home/my name/.local/bin/sessionpipe' '/home/my name/.local/bin/sessionpipe.old'",
    });
    expect(refused(at("/home/it's me/bin/sessionpipe"))?.next).toBe(
      "mv -n '/home/it'\\''s me/bin/sessionpipe' '/home/it'\\''s me/bin/sessionpipe.old'",
    );
    // The sentence names the file as the caller shows a path; the line to paste never does.
    const shown = plan(blocked(spaced), facts(), (p) => `<${p}>`);
    expect(shown.refuse).toEqual({
      error: inTheWay(`<${spaced}>`),
      next: "mv -n '/home/my name/.local/bin/sessionpipe' '/home/my name/.local/bin/sessionpipe.old'",
    });
    // Never the line that writes over what is there, on any refusal of the kind.
    for (const p of [at(plain), at(spaced), shown]) expect(p.refuse?.next).toMatch(/^mv -n \S/);
  });

  it("it is refused whatever else there is to repair, and the file is never a step's to touch", () => {
    const file = bin(LOCAL);
    const strangers = [{ file, why: "a file npm didn't put there" }];
    const carried = (p: Plan) => {
      expect(refused(p)?.error).toBe(inTheWay(file));
      expect(refused(p)?.next).toBe(`mv -n ${shq(file, "linux")} ${shq(`${file}.old`, "linux")}`);
    };
    // The file is what a shell finds first: it is no shim, it sits where this copy's link
    // was. Nothing is typed and nothing is unsure, so the refusal is the one for the file.
    const through = { strangers, onPath: [{ file, dir: null }] };
    carried(plan(blocked(file, through), facts()));
    // With more to repair: no step is planned, not even the fetch.
    carried(
      plan(
        blocked(file, {
          ...through,
          copies: [one({ bins: [], wrong: "npm's link to it is gone" }), copy(BREW, { version: OLD })],
          dangling: [bin(USR)],
        }),
        facts({ hooks: { version: OLD, wrong: [] } }),
      ),
    );
    // And with the home not this user's to write, or its folder off PATH: the file is said first.
    carried(plan(blocked(file, { home: home({ blocked: file, writable: false, onPath: false }) }), facts()));
  });

  it("S2: a file where an installed copy's link was is moved aside, never installed over: `mv -n`, not `npm install -g … && sessionpipe reinstall`, however this command was started", () => {
    // The end-to-end run's S2: a script of the person's own at `<prefix>/bin/sessionpipe`,
    // the copy whole in `<prefix>/lib/node_modules`. Read as a shim nobody can see through
    // it was answered with `npm install -g sessionpipe@<v> && sessionpipe reinstall`, and
    // run there npm wrote its link over the script. The look now says what it is (find.ts
    // `inWay`): nothing typed, nothing unsure, the home that prefix, blocked by the file.
    const file = bin(LOCAL);
    const strangers = [{ file, why: "a file npm didn't put there" }];
    const stuck = one({ bins: [], wrong: "npm's link to it is gone", uses: [] });
    const from: [string, Copy[]][] = [
      ["its own cli.js, by its path", [{ ...stuck, uses: ["this"] }]],
      ["npx", [stuck, cached({ uses: ["this"] })]],
      ["a checkout", [stuck, checkedOut({ uses: ["this"] })]],
      ["another installed copy", [stuck, copy(BREW, { version: OLD, uses: ["this"] })]],
    ];
    for (const [how, copies] of from) {
      const p = plan(blocked(file, { copies, strangers, onPath: [{ file, dir: null }] }), facts());
      expect(refused(p), how).toEqual({
        error: inTheWay(file),
        next: `mv -n ${shq(file, "linux")} ${shq(`${file}.old`, "linux")}`,
      });
      expect(p.refuse?.next, how).not.toMatch(/npm install/);
    }
    // The same computer, had the look called the file a shim it can't see through: the
    // line that is never to be said of it. (What `unsure` is still right for: a file in a
    // folder that holds no copy of its own.)
    const asShim = plan(
      untyped({ copies: [stuck, cached({ uses: ["this"] })], strangers, onPath: [{ file, dir: null }], unsure: file }),
      facts(),
    );
    expect(asShim.refuse?.next).toBe("npm install -g sessionpipe@1.2.0 && sessionpipe reinstall");
  });

  it("every refusal in its order: each is said before the ones after it, and none plans a step", () => {
    const apart = { said: "This sessionpipe keeps its files in /tmp/world", line: "env -u X sessionpipe reinstall" };
    const shim = path.join(HOME, ".asdf", "shims", "sessionpipe");
    const file = "/home/u/.local/bin/sessionpipe";
    /** Everything that can stand in the way at once, each taken away in turn. */
    const everything: { i: Partial<Inventory>; f: Partial<Facts>; next: string; says: RegExp }[] = [
      { i: { reach: null }, f: { apart }, next: "env -u X sessionpipe reinstall", says: /keeps its files/ },
      { i: {}, f: { latest: { error: OFFLINE } }, next: "sessionpipe reinstall", says: /npm couldn't be asked/ },
      { i: {}, f: { npm: false }, next: "sessionpipe reinstall", says: /npm is not beside this Node/ },
      { i: {}, f: { hooks: { version: "9.9.9", wrong: [] } }, next: "sessionpipe doctor", says: /newer than npm's/ },
      {
        i: { unsure: shim },
        f: {},
        next: "npm install -g sessionpipe@1.2.0 && sessionpipe reinstall",
        says: /is the first `sessionpipe` on your PATH/,
      },
      {
        i: { typed: path.join(HOME, "code", "sessionpipe") },
        f: {},
        next: "which -a sessionpipe",
        says: /^Typing `sessionpipe` starts/,
      },
      // The same line as the one before it, for another reason: the sentence tells them apart.
      { i: { home: null }, f: {}, next: "which -a sessionpipe", says: /^no folder on this computer/ },
      {
        i: { home: home({ prefix: "/home/u/.local", blocked: file, onPath: false, writable: false }) },
        f: {},
        next: "mv -n /home/u/.local/bin/sessionpipe /home/u/.local/bin/sessionpipe.old",
        says: /is not sessionpipe's/,
      },
      {
        i: { home: home({ prefix: "/home/u/.local", bin: "/home/u/.local/bin", onPath: false, writable: false }) },
        f: {},
        next: 'export PATH=/home/u/.local/bin:"$PATH"',
        says: /is not on your PATH, so/,
      },
      {
        i: { home: home({ prefix: "/home/u/.local", writable: false }) },
        f: {},
        next: "sudo npm install -g --prefix /home/u/.local sessionpipe@1.2.0",
        says: /you may not write there/,
      },
    ];
    // Something to repair, and nothing typed: the copies are an old one and a stray.
    const base = { copies: [copy(BREW, { version: OLD }), copy(NVM, { version: OLD, uses: ["this"] })] };
    everything.forEach((_, from) => {
      // What stands in the way from here on, the first of it decided last: the earlier
      // an obstacle is in the list, the later its fields are laid over the others'.
      const rest = everything.slice(from).reverse();
      const p = plan(
        untyped({ ...base, ...Object.assign({}, ...rest.map((r) => r.i)) }),
        facts(Object.assign({}, ...rest.map((r) => r.f))),
      );
      expect(refused(p)?.next, `from ${from}`).toBe(everything[from]?.next);
      expect(refused(p)?.error, `from ${from}`).toMatch(everything[from]?.says as RegExp);
    });
    // With none of them it is a plan.
    expect(does(plan(untyped(base), facts())).slice(0, 2)).toEqual(["fetch", "install"]);
  });
});

describe("M3: the one copy stays where it is typed, whoever may write there", () => {
  // The paths that go into a line to paste are written out whole.
  const SYS = "/usr/local";
  const sys = (over: Partial<Copy> = {}): Copy =>
    copy(SYS, { uses: ["typed", "service", "hooks", "this"], writable: false, ...over });
  const sysHome = (over: Partial<Home> = {}): Home =>
    home({ prefix: SYS, shown: "/usr/local", bin: "/usr/local/bin", writable: false, ...over });
  /** As after `sudo npm install -g sessionpipe`: one copy, in a prefix that is root's. */
  const sudo = (over: Partial<Inventory> = {}): Inventory =>
    inv({
      copies: [sys()],
      onPath: [{ file: bin(SYS), dir: slotIn(SYS) }],
      typed: slotIn(SYS),
      home: sysHome(),
      prefixes: [SYS, LOCAL],
      ...over,
    });

  it("M3: the usual sudo install, whole and the newest, is nothing to repair: no second copy in ~/.local, no step at all", () => {
    expect(plan(sudo(), facts())).toEqual({
      nothing: NOTHING,
      refuse: null,
      target: NEW,
      home: sysHome(),
      stays: null,
      steps: [],
      safety: [],
      left: [],
      notes: [],
    });
    // Whoever may write the home, whether its own bin folder is on PATH (the copy may be
    // typed through a link of one's own), and whatever ~/.local holds behind it on PATH
    // (here a build someone put there, which is no install of it and is left).
    const build = copy(LOCAL, { where: "~/.local/lib/node_modules/sessionpipe", slot: null, not: NOT_PUBLISHED });
    for (const writable of [true, false])
      for (const onPath of [true, false])
        for (const behind of [[], [build]]) {
          const p = plan(
            sudo({
              copies: [sys({ writable }), ...behind],
              home: sysHome({ writable, onPath }),
              onPath: [{ file: bin(SYS), dir: slotIn(SYS) }, ...behind.map((c) => ({ file: bin(LOCAL), dir: c.dir }))],
            }),
            facts(),
          );
          expect(p.nothing, `writable ${writable}, on PATH ${onPath}`).toBe(NOTHING);
          expect(p.refuse).toBeNull();
          expect(p.steps).toEqual([]);
          expect(p.notes).toEqual([]);
          expect(p.left.map((l) => l.path)).toEqual(behind.map((c) => c.dir));
        }
  });

  it("M3: that copy older, or broken: refused before any step with the one line that updates it in place, never a second copy somewhere else", () => {
    const update = (version: string) => ({
      error: `/usr/local holds the copy you type (${version}), and you may not write there. Nothing was changed. Update it there, then run this again`,
      next: "sudo npm install -g --prefix /usr/local sessionpipe@1.2.0",
    });
    expect(refused(plan(sudo({ copies: [sys({ version: OLD })] }), facts()))).toEqual(update(OLD));
    const cut = sys({ wrong: "its dist/cli.js is missing (an install that was cut off?)" });
    expect(refused(plan(sudo({ copies: [cut] }), facts()))).toEqual(update(NEW));
    // ~/.local is this user's, empty, and on PATH: it is no answer. The copy that is typed
    // would stay the one that is typed, and a paste of the old sudo line left none at all.
    const tempting = sudo({
      copies: [sys({ version: OLD }), copy(BREW, { version: OLD })],
      onPath: [
        { file: bin(SYS), dir: slotIn(SYS) },
        { file: bin(BREW), dir: slotIn(BREW) },
      ],
      prefixes: [SYS, LOCAL, BREW],
    });
    const p = plan(tempting, facts());
    expect(refused(p)).toEqual(update(OLD));
    expect(p.steps.filter((s) => s.do === "install")).toEqual([]);
    // The line names the release npm calls the newest, and the prefix as one word of it.
    const spaced = sudo({
      copies: [copy("/opt/my node", { version: OLD, uses: ["typed", "this"], writable: false })],
      onPath: [{ file: bin("/opt/my node"), dir: slotIn("/opt/my node") }],
      typed: slotIn("/opt/my node"),
      home: sysHome({ prefix: "/opt/my node", shown: "/opt/my node", bin: "/opt/my node/bin" }),
    });
    expect(refused(plan(spaced, facts({ latest: { version: "1.2.1" } })))).toEqual({
      error:
        "/opt/my node holds the copy you type (1.1.0), and you may not write there. Nothing was changed. Update it there, then run this again",
      next: "sudo npm install -g --prefix '/opt/my node' sessionpipe@1.2.1",
    });
    // Where this user may write there, it is updated in place by this command itself.
    const mine = plan(
      sudo({ copies: [sys({ version: OLD, writable: true })], home: sysHome({ writable: true }) }),
      facts(),
    );
    expect(does(mine)).toEqual(REPAIR);
    expect(step(mine, "install")).toMatchObject({ prefix: SYS, dir: slotIn(SYS), replaces: true });
  });

  it("M3: no copy in a home that is not this user's to write: refused with the line that installs it there, and why there", () => {
    // Nothing is typed; a link to a copy that is gone says where `sessionpipe` was.
    const gone = untyped({
      copies: [cached({ uses: ["this"] })],
      dangling: [bin(SYS)],
      onPath: [{ file: bin(SYS), dir: slotIn(SYS) }],
      home: sysHome({ why: "where a link to it already is" }),
    });
    expect(refused(plan(gone, facts({ service: null, daemon: null })))).toEqual({
      error:
        "/usr/local is where `sessionpipe` goes (where a link to it already is), and you may not write there. Nothing was changed. Install it there, then run this again",
      next: "sudo npm install -g --prefix /usr/local sessionpipe@1.2.0",
    });
    // A leftover folder beside the empty slot is no copy in it.
    const beside = plan(
      { ...gone, copies: [cached({ uses: ["this"] }), leftover(SYS, { writable: false })] },
      facts({ service: null, daemon: null }),
    );
    expect(refused(beside)?.error).toContain("is where `sessionpipe` goes (where a link to it already is)");
  });

  it("M3: that home whole and the newest, with a stray elsewhere: it stays as it is, nothing is downloaded or installed, and the stray goes", () => {
    const stray = copy(BREW, { where: "/opt/homebrew", version: OLD });
    const p = plan(sudo({ copies: [sys(), stray], prefixes: [SYS, LOCAL, BREW] }), facts());
    expect(p).toEqual({
      nothing: null,
      refuse: null,
      target: NEW,
      home: sysHome(),
      stays: "1.2.0 in /usr/local as it is: whole, the newest, and not yours to write",
      steps: [
        { do: "use", serve: true, touches: [...HOOKS, FILE], say: SERVED },
        { do: "remove", path: stray.dir, touches: [stray.dir, bin(BREW)], say: "1.1.0 in /opt/homebrew" },
        PROVE,
      ],
      // No download, so nothing is said to wait for one.
      safety: [SERVICE_RESTARTS],
      left: [],
      notes: [],
    });
    // The copy that stays is the home's own: it is neither installed over nor removed.
    expect(does(p)).not.toContain(`remove ${slotIn(SYS)}`);
    // With nothing running in the background nothing is left to say of safety.
    const quiet = plan(
      sudo({ copies: [sys({ uses: ["typed", "hooks", "this"] }), stray] }),
      facts({ service: null, daemon: null, wanted: false }),
    );
    expect(does(quiet)).toEqual(["use", `remove ${stray.dir}`, "prove"]);
    expect(quiet.safety).toEqual([]);
    expect(quiet.stays).toBe("1.2.0 in /usr/local as it is: whole, the newest, and not yours to write");
    // The hooks alone to put right: they are written again by the copy that stays.
    const hooks = plan(sudo(), facts({ hooks: { version: OLD, wrong: [] } }));
    expect(does(hooks)).toEqual(["use", "prove"]);
    expect(hooks.stays).not.toBeNull();
    // A home this user may write is installed fresh, as ever, and nothing "stays".
    const free = plan(sudo({ copies: [sys({ writable: true }), stray], home: sysHome({ writable: true }) }), facts());
    expect(free.stays).toBeNull();
    expect(does(free)).toEqual(["fetch", "install", "use", `remove ${stray.dir}`, "prove"]);
    expect(free.safety).toEqual([SAFE, SERVICE_RESTARTS]);
  });

  const shim = path.join(HOME, ".asdf", "shims", "sessionpipe");
  const asdf = path.join(HOME, ".asdf", "installs", "nodejs", "22.1.0");
  const strangers = [{ file: shim, why: "a file npm didn't put there" }];
  const managed = (over: Partial<Home> = {}): Home =>
    home({
      prefix: asdf,
      shown: "~/.asdf/installs/nodejs/22.1.0",
      bin: path.join(asdf, "bin"),
      onPath: false,
      ...over,
    });
  /** A version manager: its shim first on PATH, the one copy in its own Node. */
  const shimmed = (over: Partial<Inventory> = {}): Inventory =>
    inv({
      copies: [copy(asdf, { where: "~/.asdf/installs/nodejs/22.1.0", uses: ["typed", "service", "hooks", "this"] })],
      strangers,
      onPath: [{ file: shim, dir: null }],
      // Started through the shim from that copy: it is what typing starts.
      typed: slotIn(asdf),
      home: managed(),
      prefixes: [asdf, LOCAL],
      ...over,
    });

  it("M3: a shim manager's copy, started through its shim, is what typing starts: nothing to repair, and it is never moved to ~/.local", () => {
    const p = plan(shimmed(), facts());
    expect(p.nothing).toBe(NOTHING);
    expect(p.refuse).toBeNull();
    expect(p.steps).toEqual([]);
    expect(p.notes).toEqual([]);
    expect(p.home).toEqual(managed());
    // The shim is listed as what it is: left alone.
    expect(p.left).toEqual([
      { where: shim, path: shim, version: null, why: strangers[0]?.why, line: null, ours: false },
    ]);
    // ~/.local/bin on PATH behind the shim changes nothing.
    const behind = plan(shimmed({ onPath: [{ file: shim, dir: null }], prefixes: [LOCAL, asdf] }), facts());
    expect(behind.nothing).toBe(NOTHING);
    // An older copy there is updated where it is: the fresh one goes to the same Node, and
    // the copy that is typed is installed over, never removed.
    const old = plan(
      shimmed({
        copies: [copy(asdf, { where: "~/.asdf/installs/nodejs/22.1.0", version: OLD, uses: ["typed", "this"] })],
      }),
      facts({ service: null, daemon: null, wanted: false, harnesses: [] }),
    );
    expect(does(old)).toEqual(REPAIR);
    expect(step(old, "install")).toMatchObject({ prefix: asdf, dir: slotIn(asdf), replaces: true });
    expect(old.notes).toEqual([]);
  });

  it("M3: a shim first on PATH, and this command not started through it: refused before any step where there is something to repair; with one whole copy it is nothing to repair, and what can't be told is a note", () => {
    const lost = (over: Partial<Inventory> = {}): Inventory =>
      shimmed({
        copies: [cached({ uses: ["this"] }), copy(asdf, { version: OLD, uses: ["service", "hooks"] })],
        typed: null,
        unsure: shim,
        home: null,
        ...over,
      });
    const cant = (file: string) =>
      `${file} is the first \`sessionpipe\` on your PATH and no link of npm's, and this command was not started through it: it can't tell which copy that file starts, so it can't tell where the one clean copy goes. Nothing was changed. Install it into the Node you use, then run it from there`;
    expect(refused(plan(lost(), facts()))).toEqual({
      error: cant(shim),
      next: "npm install -g sessionpipe@1.2.0 && sessionpipe reinstall",
    });
    // The file is said as the caller shows a path; the release is npm's newest.
    expect(refused(plan(lost(), facts({ latest: { version: "1.2.1" } }), (p) => `<${p}>`))).toEqual({
      error: cant(`<${shim}>`),
      next: "npm install -g sessionpipe@1.2.1 && sessionpipe reinstall",
    });
    // Whatever home the look could have named: none is used.
    expect(refused(plan(lost({ home: home() }), facts()))?.next).toBe(
      "npm install -g sessionpipe@1.2.0 && sessionpipe reinstall",
    );
    // One whole copy of the newest release there, and nothing else to repair: no step
    // would change anything, so it is not a refusal, and nothing was found that is not as
    // it should be (the file may well be the shim that starts this very copy): it is
    // "Nothing to repair", with what can't be told said beside it.
    const whole = plan(
      lost({ copies: [cached({ uses: ["this"] }), copy(asdf, { uses: ["service", "hooks"] })] }),
      facts(),
    );
    expect(whole.refuse).toBeNull();
    expect(whole.steps).toEqual([]);
    expect(whole.nothing).toBe(NOTHING);
    expect(whole.notes).toEqual([UNSURE(shim)]);
  });

  it("M3: what is typed is no installed copy of it: left alone, and refused with the line that shows what PATH finds, never one that installs over it", () => {
    const stray = copy(BREW, { where: "/opt/homebrew", version: OLD });
    const sorry = (where: string, why: string) =>
      `Typing \`sessionpipe\` starts ${where}, which is no installed copy of it${why}: this command leaves it alone, so it can't put one clean copy in its place. Nothing was changed`;
    /** What is typed, a stray beside it, and no home: what is typed is no install of ours. */
    const typing = (typed: Copy, over: Partial<Inventory> = {}): Inventory =>
      inv({
        copies: [{ ...typed, uses: ["typed"] }, stray, cached({ uses: ["this"] })],
        onPath: [{ file: path.join(HOME, "bin", "sessionpipe"), dir: typed.dir }],
        typed: typed.dir,
        home: null,
        ...over,
      });
    // A checkout, by a link of one's own: nothing names a place for a copy, and nothing of
    // sessionpipe's is there to run. The line shows what the person's own PATH finds, in
    // its order (`sessionpipe doctor` named nothing that could be done).
    expect(refused(plan(typing(checkedOut()), facts()))).toEqual({
      error: sorry("~/code/sessionpipe", ` (${NOT_PUBLISHED})`),
      next: "which -a sessionpipe",
    });
    // A build someone put where a prefix keeps a copy, as the look lists one (no prefix:
    // it is no global install): no line installs over what this command has just said it
    // leaves alone. Pasted, such a line wrote over a project's dependency.
    const build = copy("/opt/node", {
      where: "/opt/node/lib/node_modules/sessionpipe",
      prefix: null,
      slot: null,
      not: NOT_PUBLISHED,
    });
    expect(refused(plan(typing(build), facts()))).toEqual({
      error: sorry("/opt/node/lib/node_modules/sessionpipe", ` (${NOT_PUBLISHED})`),
      next: "which -a sessionpipe",
    });
    // Whatever the copy says of a prefix, and whoever may write there: the same line.
    const theirs = copy("/opt/my node", { where: "/opt/my node/…", slot: null, not: "it holds src", writable: false });
    expect(refused(plan(typing(theirs), facts({ latest: { version: "1.2.1" } })))).toEqual({
      error: sorry("/opt/my node/…", " (it holds src)"),
      next: "which -a sessionpipe",
    });
    // An npx cache entry someone linked to: ours to remove, and no installed copy. There
    // is no reason it is refused for, and none is said.
    expect(refused(plan(typing(cached()), facts()))).toEqual({
      error: sorry("~/.npm/_npx/0a1b2c3d4e5f6a7b", ""),
      next: "which -a sessionpipe",
    });
    // A folder the look may not reach is no copy on its list: it is named by its path, as
    // the caller shows one.
    const outside = path.join(ROOT, "elsewhere", "lib", "node_modules", "sessionpipe");
    const unlisted = inv({ copies: [stray, cached({ uses: ["this"] })], typed: outside, home: null });
    expect(refused(plan(unlisted, facts(), (p) => `<${p}>`))).toEqual({
      error: sorry(`<${outside}>`, ""),
      next: "which -a sessionpipe",
    });
    // Never the command that names nothing to do, and never npm's, on any of them.
    for (const typed of [checkedOut(), build, theirs, cached()]) {
      const next = refused(plan(typing(typed), facts()))?.next;
      expect(next).not.toBe("sessionpipe doctor");
      expect(next).not.toMatch(/npm|sudo/);
    }
  });

  it("M3: nothing is typed and the home's bin folder is not on PATH: refused with the line that adds it, before a copy lands where no shell looks", () => {
    const off = (dir: string): Inventory =>
      untyped({
        copies: [one({ version: OLD, uses: ["service", "hooks", "this"] })],
        home: home({ bin: dir, onPath: false, why: "where this command runs from" }),
      });
    const unseen = (dir: string) =>
      `${dir} is not on your PATH, so \`sessionpipe\` would not be found when you type it. Nothing was changed. Add it, then run this again`;
    expect(refused(plan(off("/home/u/.local/bin"), facts()))).toEqual({
      error: unseen("/home/u/.local/bin"),
      next: 'export PATH=/home/u/.local/bin:"$PATH"',
    });
    expect(refused(plan(off("/home/my name/.local/bin"), facts(), (p) => `<${p}>`))).toEqual({
      error: unseen("</home/my name/.local/bin>"),
      next: `export PATH='/home/my name/.local/bin':"$PATH"`,
    });
    // On PATH, the same computer is repaired.
    const on = untyped({ copies: [one({ version: OLD, uses: ["service", "hooks", "this"] })] });
    expect(does(plan(on, facts()))).toEqual(REPAIR);
    // And where a copy is typed, its own folder may be off PATH (a shim, a link of one's own).
    const typed = inv({ copies: [one({ version: OLD })], home: home({ onPath: false }) });
    expect(does(plan(typed, facts()))).toEqual(REPAIR);
  });

  it("M3: what is typed is the copy Volta keeps (started through Volta's shim): refused, and never with npm's line into Volta's own folder", () => {
    // The look answers a copy in Volta's folder as no install of ours ("Volta keeps it",
    // with `volta uninstall sessionpipe` for it), and it sits where a prefix keeps a copy,
    // so it has a prefix. The refusal named `npm install -g --prefix <Volta's folder>`
    // for it: a line that writes over a copy this command had just said it leaves alone,
    // behind the back of the tool that keeps it. No line of npm's is named any more.
    const volta = "/home/u/.volta/tools/image/packages/sessionpipe";
    const kept = copy(volta, {
      where: "~/.volta/tools/image/packages/sessionpipe",
      version: OLD,
      slot: null,
      not: "Volta keeps it",
      keeper: "volta uninstall sessionpipe",
      uses: ["typed", "this"],
    });
    const shim = path.join(HOME, ".volta", "bin", "sessionpipe");
    const p = plan(
      inv({
        copies: [kept, copy(BREW, { version: OLD })],
        strangers: [{ file: shim, why: "a link to no install of sessionpipe" }],
        onPath: [{ file: shim, dir: null }],
        typed: kept.dir,
        home: null,
      }),
      facts(),
    );
    expect(refused(p)).toEqual({
      error:
        "Typing `sessionpipe` starts ~/.volta/tools/image/packages/sessionpipe, which is no installed copy of it (Volta keeps it): this command leaves it alone, so it can't put one clean copy in its place. Nothing was changed",
      next: "which -a sessionpipe",
    });
  });
});

describe("twins: two daemons, by one definition for the plan, the page and doctor", () => {
  /** Who the manager names for the service (the daemon that answers is pid 7), what the
   *  daemon says of who started it, and whether that is two daemons. */
  const TABLE: [string, number | null, boolean | null, boolean][] = [
    // Never where the manager names the answering process as its own, whatever it says.
    ["the manager names the daemon, which says a manager started it", 7, false, false],
    ["the manager names the daemon, which doesn't say", 7, null, false],
    ["the manager names the daemon, which says it was started by hand", 7, true, false],
    // Another process than the one the manager names: the daemon's own word decides, and
    // one that doesn't say (from before 0.15) is told by being another process.
    ["the manager names another process, and the daemon says it was started by hand", 100, true, true],
    ["the manager names another process, and the daemon says a manager started it", 100, false, false],
    ["the manager names another process, and the daemon doesn't say", 100, null, true],
    // The manager names no process: only the daemon's own word makes it a second one.
    ["the manager names no process, and the daemon says it was started by hand", null, true, true],
    ["the manager names no process, and the daemon says a manager started it", null, false, false],
    ["the manager names no process, and the daemon doesn't say", null, null, false],
  ];

  it.each(TABLE)("%s", (_said, pid, byHand, two) => {
    const daemon = { pid: 7, version: NEW, byHand };
    expect(twins({ pid }, daemon)).toBe(two);
    // One whole copy of the newest release, hooked and served: it is nothing to repair
    // exactly where there are not two daemons (`serviceFine`), and where there are, the
    // one started by hand is stopped before the service is moved onto the fresh copy.
    const p = plan(inv(), facts({ service: service({ pid }), daemon }));
    expect(p.nothing).toBe(two ? null : NOTHING);
    expect(does(p)).toEqual(two ? ["fetch", "install", "stop", "use", "prove"] : []);
    if (two)
      expect(step(p, "stop")).toMatchObject({
        pid: 7,
        say: "the daemon started by hand (pid 7), once it holds nothing",
      });
    // With something else to repair, the stop step is there exactly in the same rows.
    const older = plan(inv({ copies: [one({ version: OLD })] }), facts({ service: service({ pid }), daemon }));
    expect(does(older)).toEqual(two ? ["fetch", "install", "stop", "use", "prove"] : REPAIR);
  });

  it("with no service file, or no daemon answering, there are no two", () => {
    for (const byHand of [true, false, null]) {
      expect(twins(null, { pid: 7, byHand })).toBe(false);
      // A daemon someone runs by hand with no service file is the one daemon: nothing to stop.
      const alone = plan(
        inv({ copies: [one({ uses: ["typed", "hooks", "this"] })] }),
        facts({ service: null, daemon: { pid: 7, version: NEW, byHand } }),
      );
      expect(alone.nothing).toBe(NOTHING);
      expect(
        does(
          plan(
            inv({ copies: [one({ version: OLD })] }),
            facts({ service: null, daemon: { pid: 7, version: NEW, byHand } }),
          ),
        ),
      ).toEqual(REPAIR);
    }
    for (const pid of [7, 100, null]) expect(twins({ pid }, null)).toBe(false);
    expect(twins(null, null)).toBe(false);
  });
});

describe("typing: what typing `sessionpipe` starts, where that is no installed copy a shell finds", () => {
  const show = (p: string) => `<${p}>`;
  const shim = path.join(HOME, ".asdf", "shims", "sessionpipe");

  it("an installed copy, through npm's link or through a file that started it: nothing to say", () => {
    expect(typing(inv())).toBeNull();
    expect(typing(inv(), show)).toBeNull();
    // Its own bin folder off PATH is nothing to say while it is what is typed.
    expect(typing(inv({ home: home({ onPath: false }) }))).toBeNull();
    expect(typing(inv({ home: null }))).toBeNull();
  });

  it("a file that is no link of npm's, where this command was not started through it: nothing is KNOWN to be astray, so it has no answer", () => {
    // `typing` says only what is known: `doctor` makes a row and a thing to fix of its
    // answer. Which copy a shim starts can't be told, and it may be the right one: that is
    // a note beside the plan (see "nothing to repair"), and nothing to doctor.
    const lost = inv({ typed: null, unsure: shim, home: null });
    expect(typing(lost)).toBeNull();
    expect(typing(lost, show)).toBeNull();
    // Whatever home a hand-made inventory names beside it.
    expect(typing(inv({ typed: null, unsure: shim, home: home() }))).toBeNull();
  });

  it("a folder that is no installed copy: by the look's own word for it, or by its path where the look lists none", () => {
    const checkout = checkedOut({ uses: ["typed"] });
    const at = inv({ copies: [checkout, one({ uses: [] })], typed: checkout.dir, home: null });
    // The look shortened the folder already: it is not shown a second time.
    expect(typing(at)).toBe(NO_INSTALL("~/code/sessionpipe"));
    expect(typing(at, show)).toBe(NO_INSTALL("~/code/sessionpipe"));
    // An npx cache entry is ours and is no installed copy; so is a leftover folder.
    expect(typing(inv({ copies: [cached({ uses: ["typed"] })], typed: CACHED, home: null }))).toBe(
      NO_INSTALL("~/.npm/_npx/0a1b2c3d4e5f6a7b"),
    );
    // No copy on the list has that folder (it is outside what the look may reach).
    const outside = path.join(ROOT, "elsewhere", "sessionpipe");
    expect(typing(inv({ typed: outside }))).toBe(NO_INSTALL(outside));
    expect(typing(inv({ typed: outside }), show)).toBe(NO_INSTALL(`<${outside}>`));
  });

  it("nothing typed: a finding where a copy IS installed and no installed copy's command folder is one a shell looks in; that copy's folder is the one named", () => {
    const dir = path.join(LOCAL, "bin");
    const lost = untyped({ copies: [unseen()], home: home({ onPath: false }) });
    expect(typing(lost)).toBe(NOT_ON_PATH(dir));
    expect(typing(lost, show)).toBe(NOT_ON_PATH(`<${dir}>`));
    // Whatever home the look names: another folder that is on PATH, or none at all. It is
    // the copy that is not found, and its own folder that is to be added.
    const brewed = copy(BREW, { onPath: false });
    for (const h of [home(), home({ onPath: false }), null])
      expect(typing(untyped({ copies: [brewed], home: h }))).toBe(NOT_ON_PATH(path.join(BREW, "bin")));
    // Several installed and none on PATH: the first found is named. One of them on PATH
    // (its link gone, so nothing is typed): a shell looks there, and nothing is said.
    const second = copy(NVM, { onPath: false });
    expect(typing(untyped({ copies: [brewed, second] }))).toBe(NOT_ON_PATH(path.join(BREW, "bin")));
    expect(typing(untyped({ copies: [second, brewed] }))).toBe(NOT_ON_PATH(path.join(NVM, "bin")));
    const linkless = copy(NVM, { bins: [], wrong: "npm's link to it is gone" });
    expect(typing(untyped({ copies: [brewed, linkless] }))).toBeNull();
    expect(typing(untyped())).toBeNull();
  });

  it("nothing typed and no copy installed: nothing to say of a computer, whatever the home (an npx user is told nothing of PATH; where a fresh copy goes is the plan's)", () => {
    for (const h of [home(), home({ onPath: false }), null]) {
      // None at all; an npx cache entry; a checkout; a leftover folder; what is no install.
      for (const copies of [
        [],
        [cached({ uses: ["this"] })],
        [checkedOut({ uses: ["this"] })],
        [leftover(LOCAL, { where: "~/.local", onPath: false })],
        [copy(BREW, { slot: null, prefix: null, not: "it holds src", onPath: false })],
      ])
        expect(typing(untyped({ copies, home: h }))).toBeNull();
    }
    // And where it can't be told what is typed, nothing is known to be astray.
    const shimmed = path.join(HOME, ".asdf", "shims", "sessionpipe");
    expect(typing(inv({ copies: [unseen()], typed: null, unsure: shimmed, home: null }))).toBeNull();
  });
});

describe("the steps, in the order they are taken", () => {
  it("several copies: fetched, installed where the typed one is, put to use, the rest removed, then proven", () => {
    const typed = one({ version: OLD, uses: ["typed"] });
    const served = copy(NVM, { where: "~/.nvm/versions/node/v22.1.0", version: OLD, uses: ["service", "hooks"] });
    const mine = cached({ uses: ["this"] });
    const spare = copy(BREW, { where: "/opt/homebrew", version: "1.0.0" });
    const cut = leftover(LOCAL, { where: "~/.local" });
    const checkout = checkedOut();
    const p = plan(
      inv({
        copies: [mine, served, typed, spare, cut, checkout],
        dangling: [bin(USR)],
        strangers: [STRANGER],
        onPath: [
          { file: bin(LOCAL), dir: typed.dir },
          { file: bin(NVM), dir: served.dir },
          { file: SCRIPT, dir: null },
        ],
      }),
      facts({ hooks: { version: OLD, wrong: [] }, daemon: { pid: 100, version: OLD, byHand: null } }),
    );
    expect(p).toEqual({
      nothing: null,
      refuse: null,
      target: NEW,
      home: home(),
      stays: null,
      steps: [
        FETCH,
        {
          do: "install",
          version: NEW,
          prefix: LOCAL,
          dir: typed.dir,
          replaces: true,
          touches: [typed.dir, bin(LOCAL)],
          // The copy that is there now is named by its release: the table says what uses it.
          say: "1.2.0, the newest release, fresh in ~/.local (replaces 1.1.0)",
        },
        { do: "use", serve: true, touches: [...HOOKS, FILE], say: SERVED },
        {
          do: "remove",
          path: bin(USR),
          touches: [bin(USR)],
          say: `${bin(USR)} (a link to a copy that is gone)`,
        },
        // What nothing uses first: the leftover, then the spare copy. Then the one in
        // use; the copy this command runs from last. A row says the release and the
        // folder; a link that goes with a copy is touched, and is the run's to say.
        { do: "remove", path: cut.dir, touches: [cut.dir], say: "a leftover folder in ~/.local" },
        { do: "remove", path: spare.dir, touches: [spare.dir, bin(BREW)], say: "1.0.0 in /opt/homebrew" },
        {
          do: "remove",
          path: served.dir,
          touches: [served.dir, bin(NVM)],
          say: "1.1.0 in ~/.nvm/versions/node/v22.1.0",
        },
        { do: "remove", path: CACHED, touches: [CACHED], say: "1.2.0 in ~/.npm/_npx/0a1b2c3d4e5f6a7b" },
        PROVE,
      ],
      safety: [SAFE, SERVICE_RESTARTS],
      left: [
        { where: "~/code/sessionpipe", path: checkout.dir, version: NEW, why: NOT_PUBLISHED, line: null, ours: false },
        { where: SCRIPT, path: SCRIPT, version: null, why: "a file npm didn't put there", line: null, ours: false },
      ],
      notes: [],
    });
  });

  it("removals go by use, whatever order the copies were found in: leftovers, unused, in use, this command's own", () => {
    const a = copy(path.join(ROOT, "a"), { uses: ["this"] });
    const b = copy(path.join(ROOT, "b"), { uses: ["hooks"] });
    const c = copy(path.join(ROOT, "c"));
    const d = leftover(path.join(ROOT, "d"));
    const e = copy(path.join(ROOT, "e"), { uses: ["service"] });
    const f = copy(path.join(ROOT, "f"));
    // A leftover the service file happens to name is in use, and waits its turn.
    const g = leftover(path.join(ROOT, "g"), { uses: ["service"] });
    const removed = (copies: Copy[]) =>
      does(plan(untyped({ copies }), facts()))
        .filter((s) => s.startsWith("remove "))
        .map((s) => path.basename(path.dirname(path.dirname(path.dirname(s.slice("remove ".length))))));
    expect(removed([a, b, c, d, e, f, g])).toEqual(["d", "c", "f", "b", "e", "g", "a"]);
    expect(removed([g, f, e, d, c, b, a])).toEqual(["d", "f", "c", "g", "e", "b", "a"]);
    // The copy in the home's own slot is replaced by the install, never removed after it.
    expect(removed([a, one({ version: OLD, uses: [] }), d])).toEqual(["d", "a"]);
  });

  it("a copy that is not whole where the fresh one goes is replaced, and the row says its release; what is wrong with it is the table's to say", () => {
    const install = (c: Copy) => step(plan(inv({ copies: [c] }), facts()), "install");
    const cut = one({ wrong: "its dist/cli.js is missing (an install that was cut off?)" });
    expect(install(cut)).toEqual({
      do: "install",
      version: NEW,
      prefix: LOCAL,
      dir: slotIn(LOCAL),
      replaces: true,
      touches: [slotIn(LOCAL), bin(LOCAL)],
      // A copy that is ours names its release (the proof asks for one): it is named by it.
      say: "1.2.0, the newest release, fresh in ~/.local (replaces 1.2.0)",
    });
    const silent = one({ version: OLD, wrong: "it doesn't run: `--version` printed nothing" });
    expect(install(silent).say).toBe("1.2.0, the newest release, fresh in ~/.local (replaces 1.1.0)");
    // Neither row repeats what is wrong: that is on the copy's own row of what was found.
    for (const c of [cut, silent]) expect(install(c).say).not.toContain(c.wrong as string);
    // The same copy anywhere else is removed, and named the same way.
    const p = plan(
      inv({ copies: [one(), copy(BREW, { where: "/opt/homebrew", bins: [], wrong: cut.wrong })] }),
      facts(),
    );
    expect(p.steps.find((s) => s.do === "remove")).toEqual({
      do: "remove",
      path: slotIn(BREW),
      touches: [slotIn(BREW)],
      say: "1.2.0 in /opt/homebrew",
    });
  });

  it("an empty slot is installed into, with nothing to take out; the home and its reason are the look's", () => {
    const mine = cached({ uses: ["this"] });
    const brew = home({
      prefix: BREW,
      shown: "/opt/homebrew",
      why: "npm's global folder",
      bin: path.join(BREW, "bin"),
    });
    const p = plan(untyped({ copies: [mine], home: brew }), facts());
    expect(p.home).toBe(brew);
    expect(step(p, "install")).toEqual({
      do: "install",
      version: NEW,
      prefix: BREW,
      dir: slotIn(BREW),
      replaces: false,
      touches: [slotIn(BREW), bin(BREW)],
      // No copy is there for the table to say anything of: why this folder is said here.
      say: "1.2.0, the newest release, fresh in /opt/homebrew (npm's global folder)",
    });
    expect(does(p)).toEqual(["fetch", "install", "use", `remove ${CACHED}`, "prove"]);
    // The link is the one in the folder the look gives for the command, whatever the prefix.
    const real = path.join(ROOT, "real-bin");
    expect(step(plan(untyped({ copies: [mine], home: { ...brew, bin: real } }), facts()), "install").touches).toEqual([
      slotIn(BREW),
      path.join(real, "sessionpipe"),
    ]);
    // The reason is the look's own, whichever it gave for the home.
    const said = (why: string) => step(plan(untyped({ copies: [mine], home: home({ why }) }), facts()), "install").say;
    for (const why of ["a folder of your own", "where another copy of it already is", "where this command runs from"])
      expect(said(why)).toBe(`1.2.0, the newest release, fresh in ~/.local (${why})`);
    // A leftover beside an empty slot is no copy in it: the reason is still the home's.
    const beside = plan(untyped({ copies: [mine, leftover(LOCAL, { where: "~/.local" })] }), facts());
    expect(step(beside, "install")).toMatchObject({
      replaces: false,
      say: "1.2.0, the newest release, fresh in ~/.local (where the one you type is)",
    });
  });

  it("a service file nothing needs is no step's to remove: it stays, nothing is said of it, and the fresh copy serves nothing", () => {
    const old = inv({ copies: [one({ version: OLD })] });
    const p = plan(old, facts({ wanted: false, daemon: null }));
    // No step takes the file away, and none is named for it.
    expect(does(p)).toEqual(REPAIR);
    expect(p.steps.map((s) => s.do)).not.toContain("unserve");
    for (const s of p.steps) expect(s.touches).not.toContain(FILE);
    // The hooks alone are switched: the service file is not one of the files touched.
    expect(step(p, "use")).toEqual({ do: "use", serve: false, touches: HOOKS, say: "the hooks to it" });
    // It is no finding, on a plan as on a computer with nothing to repair: no note.
    expect(p.notes).toEqual([]);
    // Nothing runs in the background afterwards, so nothing is said to restart.
    expect(p.safety).toEqual([SAFE]);
    // While a daemon still answers, the file stays and is made to run the fresh copy.
    const answered = plan(old, facts({ wanted: false }));
    expect(does(answered)).toEqual(REPAIR);
    expect(step(answered, "use")).toEqual({ do: "use", serve: true, touches: [...HOOKS, FILE], say: SERVED });
    expect(answered.safety).toEqual([SAFE, SERVICE_RESTARTS]);
    expect(answered.notes).toEqual([]);
  });

  it("two daemons: the one someone started by hand is stopped before the service is moved", () => {
    const p = plan(inv(), facts({ daemon: { pid: 222, version: OLD, byHand: true } }));
    expect(does(p)).toEqual(["fetch", "install", "stop", "use", "prove"]);
    expect(step(p, "stop")).toEqual({
      do: "stop",
      pid: 222,
      touches: [],
      say: "the daemon started by hand (pid 222), once it holds nothing",
    });
    expect(step(p, "use")).toEqual({ do: "use", serve: true, touches: [...HOOKS, FILE], say: SERVED });
    // The service is what runs afterwards: it is the one said to restart.
    expect(p.safety).toEqual([SAFE, SERVICE_RESTARTS]);
    // A manager that names no process while a daemon answers that says it was started by
    // hand is the same state: the service's own process leaves when it finds another
    // daemon on the socket, so the one that answers is not the service's.
    const unnamed = plan(
      inv({ copies: [one({ version: OLD })] }),
      facts({ service: service({ pid: null }), daemon: { pid: 100, version: NEW, byHand: true } }),
    );
    expect(does(unnamed)).toEqual(["fetch", "install", "stop", "use", "prove"]);
    expect(step(unnamed, "stop").pid).toBe(100);
    expect(step(unnamed, "stop").say).toBe("the daemon started by hand (pid 100), once it holds nothing");
    // Where that daemon doesn't say who started it, no process named tells nothing: it is
    // not taken for a second daemon, and is not stopped.
    const untold = plan(inv({ copies: [one({ version: OLD })] }), facts({ service: service({ pid: null }) }));
    expect(does(untold)).toEqual(REPAIR);
    // Wanted or not: with a daemon in the way the daemon is stopped, and the file is moved.
    expect(does(plan(inv(), facts({ wanted: false, daemon: { pid: 222, version: NEW, byHand: null } })))).toEqual([
      "fetch",
      "install",
      "stop",
      "use",
      "prove",
    ]);
  });

  it("a daemon run by hand with no service file is asked to restart; with neither, nothing is started", () => {
    const unserved = inv({ copies: [one({ version: OLD, uses: ["typed", "hooks", "this"] })] });
    const byHand = plan(unserved, facts({ service: null, daemon: { pid: 222, version: OLD, byHand: null } }));
    expect(does(byHand)).toEqual(REPAIR);
    expect(step(byHand, "use")).toEqual({
      do: "use",
      serve: true,
      touches: HOOKS,
      say: "the hooks and the daemon that runs here to it",
    });
    expect(byHand.notes).toEqual([]);
    // There is no service to keep an environment for: the daemon is what restarts.
    expect(byHand.safety).toEqual([SAFE, DAEMON_RESTARTS]);
    const neither = plan(unserved, facts({ service: null, daemon: null }));
    expect(does(neither)).toEqual(REPAIR);
    expect(step(neither, "use")).toEqual({ do: "use", serve: false, touches: HOOKS, say: "the hooks to it" });
    expect(neither.safety).toEqual([SAFE]);
    // Something here needs the service and nothing starts it: said beside the plan.
    expect(neither.notes).toEqual([NOTHING_STARTS_IT]);
    expect(plan(unserved, facts({ service: null, daemon: null, wanted: false })).notes).toEqual([]);
  });

  it("no agent hooked: no hook file is touched, and the row names only what runs in the background; with neither there is no row", () => {
    const old = inv({ copies: [one({ version: OLD })] });
    expect(step(plan(old, facts({ harnesses: [] })), "use")).toEqual({
      do: "use",
      serve: true,
      touches: [FILE],
      say: "the background service to it",
    });
    expect(
      step(plan(old, facts({ harnesses: [], service: null, daemon: { pid: 222, version: OLD, byHand: null } })), "use"),
    ).toEqual({ do: "use", serve: true, touches: [], say: "the daemon that runs here to it" });
    // Nothing to switch: the step is still taken (`update`'s own steps say what they
    // find), and the plan has no row for it.
    const bare = plan(old, facts({ harnesses: [], service: null, daemon: null }));
    expect(step(bare, "use")).toEqual({ do: "use", serve: false, touches: [], say: null });
    expect(does(bare)).toEqual(REPAIR);
    // A service file that is left as it is is nothing to switch to either.
    const unserved = plan(old, facts({ harnesses: [], wanted: false, daemon: null }));
    expect(does(unserved)).toEqual(REPAIR);
    expect(step(unserved, "use")).toEqual({ do: "use", serve: false, touches: [], say: null });
  });

  it("the switch row: the hooks where an agent is hooked, then what runs in the background where something does", () => {
    const old = inv({ copies: [one({ version: OLD })] });
    const switched = (f: Partial<Facts>) => step(plan(old, facts(f)), "use").say;
    const byHand = { pid: 222, version: OLD, byHand: null };
    // Hooked, with each thing that may run in the background.
    expect(switched({})).toBe("the hooks and the background service to it");
    expect(switched({ service: null, daemon: byHand })).toBe("the hooks and the daemon that runs here to it");
    expect(switched({ service: null, daemon: null })).toBe("the hooks to it");
    // A service file and a daemon someone started by hand: the service is what is switched
    // (the daemon has a row of its own, where it is stopped).
    expect(switched({ daemon: byHand })).toBe("the hooks and the background service to it");
    // A service file with nothing answering yet is started on the fresh copy.
    expect(switched({ daemon: null })).toBe("the hooks and the background service to it");
    // One that nothing needs is left as it is, and is not switched.
    expect(switched({ wanted: false, daemon: null })).toBe("the hooks to it");
    // Nobody hooked.
    expect(switched({ harnesses: [] })).toBe("the background service to it");
    expect(switched({ harnesses: [], service: null, daemon: byHand })).toBe("the daemon that runs here to it");
    expect(switched({ harnesses: [], service: null, daemon: null })).toBeNull();
  });

  it("M2: a copy where this user may not write stays, with the one line that removes it: `sudo rm -r` of its folder and its own links, and nothing else", () => {
    // The folder and the links go into the line as words of a command; nothing else is
    // done with them, so they are written out as any computer would have them.
    const sys = copy(USR, {
      dir: "/usr/local/lib/node_modules/sessionpipe",
      bins: ["/usr/local/bin/sessionpipe"],
      where: "/usr/local",
      version: OLD,
      writable: false,
    });
    const spaced = copy(path.join(ROOT, "my node"), {
      dir: "/opt/my node/lib/node_modules/sessionpipe",
      bins: ["/opt/my node/bin/sessionpipe"],
      where: "/opt/my node",
      writable: false,
    });
    // Its link was taken away or written over by a file of someone's: the folder alone.
    const unlinked = copy(NVM, {
      dir: "/home/u/.nvm/versions/node/v22.1.0/lib/node_modules/sessionpipe",
      bins: [],
      wrong: "npm's link to it is gone",
      where: "~/.nvm/versions/node/v22.1.0",
      writable: false,
    });
    const inCache = cached({
      dir: "/home/u/.npm/_npx/0a1b2c3d4e5f6a7b/node_modules/sessionpipe",
      bins: ["/home/u/.npm/_npx/0a1b2c3d4e5f6a7b/node_modules/.bin/sessionpipe"],
      writable: false,
    });
    const cut = leftover(USR, {
      dir: "/usr/local/lib/node_modules/.sessionpipe-Ab12Cd34",
      where: "/usr/local",
      writable: false,
    });
    const spare = copy(BREW, { where: "/opt/homebrew" });
    const p = plan(inv({ copies: [one(), sys, spaced, unlinked, inCache, cut, spare] }), facts());
    // What can be removed still is; nothing is planned for what can't.
    expect(does(p)).toEqual(["fetch", "install", "use", `remove ${spare.dir}`, "prove"]);
    const why = "you may not write where it is";
    expect(p.left).toEqual([
      // Each is named for a person, and by the whole folder that stays; the line is what
      // this command would have removed, to the word: the folder, then its own links.
      {
        where: "/usr/local",
        path: cut.dir,
        version: null,
        why,
        line: "sudo rm -r /usr/local/lib/node_modules/.sessionpipe-Ab12Cd34",
        ours: true,
      },
      {
        where: "/usr/local",
        path: sys.dir,
        version: OLD,
        why,
        line: "sudo rm -r /usr/local/lib/node_modules/sessionpipe /usr/local/bin/sessionpipe",
        ours: true,
      },
      {
        where: "/opt/my node",
        path: spaced.dir,
        version: NEW,
        why,
        line: "sudo rm -r '/opt/my node/lib/node_modules/sessionpipe' '/opt/my node/bin/sessionpipe'",
        ours: true,
      },
      {
        where: "~/.nvm/versions/node/v22.1.0",
        path: unlinked.dir,
        version: NEW,
        why,
        line: "sudo rm -r /home/u/.nvm/versions/node/v22.1.0/lib/node_modules/sessionpipe",
        ours: true,
      },
      {
        where: "~/.npm/_npx/0a1b2c3d4e5f6a7b",
        path: inCache.dir,
        version: NEW,
        why,
        line: "sudo rm -r /home/u/.npm/_npx/0a1b2c3d4e5f6a7b/node_modules/sessionpipe /home/u/.npm/_npx/0a1b2c3d4e5f6a7b/node_modules/.bin/sessionpipe",
        ours: true,
      },
    ]);
    for (const l of p.left) {
      // Never npm's uninstall, which takes whatever is at the prefix's command path (a
      // script of the user's the screen lists under "Left alone"), and never a prefix.
      expect(l.line).not.toMatch(/\bnpm |uninstall|--prefix/);
      expect(l.line).toMatch(/^sudo rm -r \S/);
    }
    // A file of the user's at that prefix's command path is no link of the copy's: the
    // line does not name it, and it is listed as left alone.
    const wrapper = { file: "/usr/local/bin/sessionpipe", why: "a file npm didn't put there" };
    const beside = plan(
      inv({ copies: [one(), { ...sys, bins: [], wrong: "npm's link to it is gone" }], strangers: [wrapper] }),
      facts(),
    );
    expect(beside.left.map((l) => l.line)).toEqual([null, "sudo rm -r /usr/local/lib/node_modules/sessionpipe"]);
    expect(beside.left.map((l) => l.path)).toEqual([wrapper.file, sys.dir]);
    // What is no install of it comes first in the list, and is not ours to count.
    const checkout = checkedOut({ where: "~/code", not: "it holds src" });
    const mixed = plan(inv({ copies: [sys, one(), checkout], strangers: [STRANGER] }), facts());
    expect(mixed.left.map((l) => [l.where, l.path, l.ours])).toEqual([
      ["~/code", checkout.dir, false],
      [SCRIPT, SCRIPT, false],
      ["/usr/local", sys.dir, true],
    ]);
  });

  it("a link that leads nowhere is removed, except the home's own, which the install writes again", () => {
    const stale = [bin(LOCAL), bin(USR), bin(NVM)];
    const p = plan(inv({ dangling: stale }), facts());
    expect(does(p)).toEqual(["fetch", "install", "use", `remove ${bin(USR)}`, `remove ${bin(NVM)}`, "prove"]);
    expect(step(p, "install").touches).toContain(bin(LOCAL));
    // The home's own alone is still a repair: the install is what puts it right.
    expect(does(plan(inv({ dangling: [bin(LOCAL)] }), facts()))).toEqual(REPAIR);
    // The home's own is told by the folder the look gives for its command, not by a
    // name put together from the prefix: where `<prefix>/bin` is a link to another
    // folder, the link in that folder is the home's, and one in a folder that is only
    // called `<prefix>/bin` is not.
    const real = path.join(ROOT, "real-bin");
    const linked = plan(
      inv({ dangling: [path.join(real, "sessionpipe"), bin(LOCAL)], home: home({ bin: real }) }),
      facts(),
    );
    expect(does(linked)).toEqual(["fetch", "install", "use", `remove ${bin(LOCAL)}`, "prove"]);
  });

  it("what is not this command's to repair is said beside the steps: a service nothing starts; a service file nothing needs is nothing to say", () => {
    const old = inv({ copies: [one({ version: OLD, uses: ["typed", "hooks", "this"] })] });
    expect(plan(old, facts({ service: null, daemon: null })).notes).toEqual([NOTHING_STARTS_IT]);
    expect(plan(old, facts({ wanted: false, daemon: null })).notes).toEqual([]);
    expect(plan(old, facts()).notes).toEqual([]);
    // No plan in any shape of the service says a word about a file nothing needs.
    for (const service_ of [service(), service({ loaded: false }), null])
      for (const wanted of [true, false])
        for (const daemon of [null, { pid: 100, version: NEW, byHand: null }])
          for (const n of plan(old, facts({ service: service_, wanted, daemon })).notes)
            expect(n).not.toMatch(/service file/);
    // What typing starts is never a note beside steps: where it is not the home's copy,
    // the plan is a refusal.
    expect(typing(old)).toBeNull();
  });

  it("the first and the last step are always the same two, and neither has a row: the download is the safety line's to say, the check the run's", () => {
    for (const f of [{}, { harnesses: [] }, { service: null, daemon: null }, { wanted: false, daemon: null }]) {
      const p = plan(inv({ copies: [one({ version: OLD })] }), facts(f));
      expect(p.steps[0]).toEqual(FETCH);
      expect(p.steps.at(-1)).toEqual(PROVE);
    }
    expect(Object.keys(FETCH).sort()).toEqual(["do", "touches", "version"]);
    expect(Object.keys(PROVE).sort()).toEqual(["do", "touches"]);
    // What the download is for is said once, under the rows, with the release by its number:
    // npm installs beside the copy that is there, and it is seen to run before the two
    // change places, so a download or an install that fails has touched nothing.
    const p = plan(inv({ copies: [one({ version: OLD })] }), facts());
    expect(p.safety[0]).toBe("Nothing is touched until 1.2.0 has been downloaded and seen to run.");
    const next = plan(inv({ copies: [one({ version: OLD })] }), facts({ latest: { version: "1.2.1" } }));
    expect(next.safety[0]).toBe("Nothing is touched until 1.2.1 has been downloaded and seen to run.");
    // One line of it, and no promise of an undo: there is nothing to undo.
    for (const x of [p, next]) expect(x.safety.join(" ")).not.toMatch(/undone|has downloaded\b/);
  });

  it("what keeps a run safe: the download first, then what restarts, named only where something runs in the background", () => {
    const old = inv({ copies: [one({ version: OLD })] });
    const safe = (f: Partial<Facts>) => plan(old, facts(f)).safety;
    // A service file that is moved onto the fresh copy: its environment is kept.
    expect(safe({})).toEqual([SAFE, SERVICE_RESTARTS]);
    // Hooked or not: the hooks restart nothing.
    expect(safe({ harnesses: [] })).toEqual([SAFE, SERVICE_RESTARTS]);
    // A service file with nothing answering yet is started on it, and said the same way.
    expect(safe({ daemon: null })).toEqual([SAFE, SERVICE_RESTARTS]);
    // A daemon someone started by hand beside a service file: the service takes over.
    expect(safe({ daemon: { pid: 222, version: OLD, byHand: null } })).toEqual([SAFE, SERVICE_RESTARTS]);
    // A daemon someone runs by hand, with no service file, is asked to restart onto it.
    expect(safe({ service: null, daemon: { pid: 222, version: OLD, byHand: null } })).toEqual([SAFE, DAEMON_RESTARTS]);
    // No service file and no daemon: nothing runs it in the background, and one line is all.
    expect(safe({ service: null, daemon: null })).toEqual([SAFE]);
    expect(safe({ harnesses: [], service: null, daemon: null })).toEqual([SAFE]);
    // A service file that is left as it is, with no daemon: the same.
    expect(safe({ wanted: false, daemon: null })).toEqual([SAFE]);
    // Never both: a service that is moved is the one thing said to restart.
    for (const f of [
      {},
      { daemon: { pid: 222, version: OLD, byHand: null } },
      { service: null, daemon: { pid: 222, version: OLD, byHand: null } },
    ])
      expect(safe(f)).toHaveLength(2);
  });

  it("where nothing is done nothing is said of safety: nothing to repair, and every refusal", () => {
    const two = inv({ copies: [one(), copy(BREW, { where: "/opt/homebrew", version: OLD })] });
    const apart = { said: "This sessionpipe keeps its files in /tmp/world", line: "sessionpipe reinstall" };
    for (const p of [
      plan(inv(), facts()),
      plan(untyped({ home: home({ onPath: false }) }), facts()),
      plan(inv(), facts({ latest: { error: OFFLINE } })),
      plan({ ...two, reach: null }, facts({ apart })),
      plan({ ...two, home: home({ blocked: bin(LOCAL) }) }, facts()),
      plan(two, facts({ latest: { error: OFFLINE } })),
      plan(two, facts({ npm: false })),
      plan(two, facts({ hooks: { version: "9.9.9", wrong: [] } })),
      plan({ ...two, home: null }, facts()),
      plan(
        { ...two, home: home({ writable: false }), copies: [one({ version: OLD }), ...two.copies.slice(1)] },
        facts(),
      ),
    ]) {
      expect(p.steps).toEqual([]);
      expect(p.safety).toEqual([]);
      expect(p.stays).toBeNull();
      expect(p.nothing === null).toBe(p.refuse !== null);
    }
  });
});

describe("what a removal's row says: the release and the folder, and of a link, the file", () => {
  /** The words of the one removal a plan has. */
  const removed = (i: Partial<Inventory>, show?: (p: string) => string) => {
    const p = plan(inv(i), facts(), show);
    const all = p.steps.filter((s) => s.do === "remove");
    expect(all).toHaveLength(1);
    return (all[0] as Extract<Step, { do: "remove" }>).say;
  };

  it("a copy by its release, whatever is wrong with it; a leftover as a leftover folder", () => {
    expect(removed({ copies: [one(), copy(BREW, { where: "/opt/homebrew", version: OLD })] })).toBe(
      "1.1.0 in /opt/homebrew",
    );
    // The same release as the fresh copy is still named by it: the folder tells them apart.
    expect(removed({ copies: [one(), copy(NVM, { where: "~/.nvm/versions/node/v22.1.0" })] })).toBe(
      "1.2.0 in ~/.nvm/versions/node/v22.1.0",
    );
    // One that doesn't run is named by the release: the table says the rest.
    expect(
      removed({
        copies: [one(), copy(BREW, { where: "/opt/homebrew", version: OLD, wrong: "it doesn't run" })],
      }),
    ).toBe("1.1.0 in /opt/homebrew");
    // A leftover has no release worth naming, whatever a package.json in it says.
    expect(removed({ copies: [one(), leftover(BREW, { where: "/opt/homebrew", version: OLD })] })).toBe(
      "a leftover folder in /opt/homebrew",
    );
    expect(removed({ copies: [one(), leftover(LOCAL, { where: "~/.local" })] })).toBe("a leftover folder in ~/.local");
    expect(removed({ copies: [one(), cached({ uses: ["hooks"] })] })).toBe("1.2.0 in ~/.npm/_npx/0a1b2c3d4e5f6a7b");
  });

  it("a copy's folder is the look's own word for it; a link is the file, as the caller shows a path", () => {
    const show = (p: string) => `<${p}>`;
    // The look shortened the folder already: it is not shown a second time.
    expect(removed({ copies: [one(), copy(BREW, { where: "/opt/homebrew", version: OLD })] }, show)).toBe(
      "1.1.0 in /opt/homebrew",
    );
    expect(removed({ dangling: [bin(USR)] })).toBe(`${bin(USR)} (a link to a copy that is gone)`);
    expect(removed({ dangling: [bin(USR)] }, show)).toBe(`<${bin(USR)}> (a link to a copy that is gone)`);
  });

  it("a row says nothing of the link that goes with a copy: it is touched, and the run says it when it is gone", () => {
    const linked = plan(inv({ copies: [one(), copy(BREW, { where: "/opt/homebrew", version: OLD })] }), facts());
    const bare = plan(
      inv({ copies: [one(), copy(BREW, { where: "/opt/homebrew", version: OLD, bins: [] })] }),
      facts(),
    );
    const row = (p: Plan) => p.steps.find((s) => s.do === "remove") as Extract<Step, { do: "remove" }>;
    expect(row(linked).say).toBe(row(bare).say);
    expect(row(linked).touches).toEqual([slotIn(BREW), bin(BREW)]);
    expect(row(bare).touches).toEqual([slotIn(BREW)]);
  });
});

describe("a path in a sentence is said as the caller shows it; what is touched, pasted or compared is whole", () => {
  /** A `show` that marks what it was handed, as the command's `~/…` would shorten it. */
  const show = (p: string) => `<${p}>`;
  const gone = bin(USR);
  const spare = copy(BREW, { where: "/opt/homebrew", version: OLD });
  // Its folder goes into the line to paste as one word; nothing else is done with it.
  const sys = copy(path.join(ROOT, "sys"), {
    dir: "/opt/sys/lib/node_modules/sessionpipe",
    bins: ["/opt/sys/bin/sessionpipe"],
    where: "/sys",
    writable: false,
  });
  const checkout = checkedOut({ where: "~/code", not: "it holds src" });
  /** One of everything a sentence names a path in, beside what a step touches. */
  const mixed = (over: Partial<Inventory> = {}) =>
    inv({
      copies: [one(), spare, sys, checkout],
      dangling: [gone],
      strangers: [STRANGER],
      onPath: [
        { file: bin(LOCAL), dir: slotIn(LOCAL) },
        { file: SCRIPT, dir: null },
      ],
      ...over,
    });
  /** How many paths in a plan went through `show`. */
  const shown = (p: Plan) => JSON.stringify(p).match(/</g)?.length ?? 0;

  it("a link's sentence and a stranger's place are shown; nothing else is", () => {
    const p = plan(mixed(), facts(), show);
    expect(p.notes).toEqual([]);
    // The link's own step: what it removes and touches is the file, whole; its row shows it.
    expect(p.steps.find((s) => s.do === "remove")).toEqual({
      do: "remove",
      path: gone,
      touches: [gone],
      say: `<${gone}> (a link to a copy that is gone)`,
    });
    expect(p.left).toEqual([
      // A copy's place is the look's own word for it, which the caller shortened already;
      // beside it, each thing's whole path, as it was found.
      { where: "~/code", path: checkout.dir, version: NEW, why: "it holds src", line: null, ours: false },
      {
        where: `<${SCRIPT}>`,
        path: SCRIPT,
        version: null,
        why: "a file npm didn't put there",
        line: null,
        ours: false,
      },
      // The line to paste names the whole folder, quoted as a shell needs it and no other way.
      {
        where: "/sys",
        path: sys.dir,
        version: NEW,
        why: "you may not write where it is",
        line: "sudo rm -r /opt/sys/lib/node_modules/sessionpipe /opt/sys/bin/sessionpipe",
        ours: true,
      },
    ]);
    // Those two and no more: not the home, not a step's folder or what it touches, not a
    // copy's removal, not a line under the rows.
    expect(shown(p)).toBe(2);
    expect(JSON.stringify(p.safety)).not.toContain("<");
    expect(step(p, "install").say).toBe("1.2.0, the newest release, fresh in ~/.local (replaces 1.2.0)");
    expect(p.home).toEqual(home());
    expect(step(p, "install")).toMatchObject({
      prefix: LOCAL,
      dir: slotIn(LOCAL),
      touches: [slotIn(LOCAL), bin(LOCAL)],
    });
    expect(p.steps.at(-2)).toEqual({
      do: "remove",
      path: spare.dir,
      touches: [spare.dir, bin(BREW)],
      say: "1.1.0 in /opt/homebrew",
    });
    expect(step(p, "use").touches).toEqual([...HOOKS, FILE]);
  });

  it("with nothing said about how, every path is as it was found", () => {
    const whole = plan(mixed(), facts());
    expect(shown(whole)).toBe(0);
    expect(whole).toEqual(plan(mixed(), facts(), (p) => p));
    expect(whole.left[1]?.where).toBe(SCRIPT);
    expect(whole.steps.find((s) => s.do === "remove")).toMatchObject({
      say: `${gone} (a link to a copy that is gone)`,
    });
  });

  it("the note about what is typed is shown where there is nothing to repair; a refusal shows the path in its sentence, never in its line", () => {
    const off = home({ onPath: false, why: "where this command runs from" });
    const nothing = plan(untyped({ copies: [unseen(), checkout], strangers: [STRANGER], home: off }), facts(), show);
    // The sentence names no path; the note beside it does, as the caller shows one.
    expect(nothing.nothing).toBe(ONE_COPY);
    expect(nothing.notes).toEqual([NOT_ON_PATH(`<${path.join(LOCAL, "bin")}>`)]);
    expect(nothing.left.map((l) => l.where)).toEqual(["~/code", `<${SCRIPT}>`]);
    expect(shown(nothing)).toBe(2);
    // Each refusal that names a path: once, in the sentence.
    const file = "/home/u/.local/bin/sessionpipe";
    for (const p of [
      plan(untyped({ copies: [one({ version: OLD })], home: home({ blocked: file }) }), facts(), show),
      plan(untyped({ copies: [one({ version: OLD })], home: { ...off, bin: "/home/u/.local/bin" } }), facts(), show),
      plan(inv({ copies: [one({ version: OLD })], typed: null, unsure: file, home: null }), facts(), show),
    ]) {
      expect(p.refuse?.error).toContain("<");
      expect(p.refuse?.next).not.toContain("<");
      expect(shown(p)).toBe(1);
    }
    // One that names the home by the look's own word shows nothing.
    const unwritable = plan(inv({ copies: [one({ version: OLD })], home: home({ writable: false }) }), facts(), show);
    expect(unwritable.refuse?.error).toMatch(/^~\/\.local holds the copy you type/);
    expect(shown(unwritable)).toBe(0);
  });
});

describe("idle: an npx cache entry nothing uses but this command is no copy to repair", () => {
  it("is an npx entry with no use, or this command's alone", () => {
    expect(idle(cached())).toBe(true);
    expect(idle(cached({ uses: ["this"] }))).toBe(true);
    // Something else runs from it: it is a copy in use, as any other.
    expect(idle(cached({ uses: ["service"] }))).toBe(false);
    expect(idle(cached({ uses: ["hooks"] }))).toBe(false);
    expect(idle(cached({ uses: ["typed"] }))).toBe(false);
    expect(idle(cached({ uses: ["this", "hooks"] }))).toBe(false);
    // A global copy nothing uses is a stray, and so is a leftover.
    expect(idle(copy(BREW))).toBe(false);
    expect(idle(copy(BREW, { uses: ["this"] }))).toBe(false);
    expect(idle(leftover(BREW))).toBe(false);
    // What is no install of it is nobody's to count.
    expect(idle(checkedOut())).toBe(false);
  });

  it("beside one clean copy it is nothing to repair, and the sentence names the clean copy", () => {
    // `npx -y sessionpipe@latest reinstall` on a computer that is fine, and an entry npx left earlier.
    for (const entry of [cached({ uses: ["this"] }), cached()]) {
      for (const copies of [
        [entry, one({ uses: ["typed", "service", "hooks"] })],
        [one({ uses: ["typed", "service", "hooks"] }), entry],
      ]) {
        const p = plan(inv({ copies }), facts());
        // The clean copy is the one the sentence is about; the entry is listed as npm's
        // own, left, and not a copy this command would have removed.
        expect(p.nothing).toBe(NOTHING);
        expect(p.steps).toEqual([]);
        expect(p.notes).toEqual([]);
        expect(p.left).toEqual([
          {
            where: "~/.npm/_npx/0a1b2c3d4e5f6a7b",
            path: CACHED,
            version: NEW,
            why: NPX_CACHE,
            line: null,
            ours: false,
          },
        ]);
      }
    }
    // Offline too, where the one copy's own release is all there is to hold things to:
    // the sentence and the note name the clean copy's release, the row the entry's own.
    const offline = plan(
      inv({ copies: [cached({ uses: ["this"], version: "1.0.0" }), one()] }),
      facts({ latest: { error: OFFLINE } }),
    );
    expect(offline.nothing).toBe(NOTHING_UNASKED(NEW));
    expect(offline.notes).toEqual([NPM_UNASKED(NEW)]);
    expect(offline.left).toEqual([
      {
        where: "~/.npm/_npx/0a1b2c3d4e5f6a7b",
        path: CACHED,
        version: "1.0.0",
        why: NPX_CACHE,
        line: null,
        ours: false,
      },
    ]);
    // An entry that something runs from is no cache: it is a second copy, and no such row.
    const used = plan(
      inv({ copies: [one({ uses: ["typed", "service", "this"] }), cached({ uses: ["hooks"] })] }),
      facts(),
    );
    expect(used.nothing).toBeNull();
    expect(used.left).toEqual([]);
  });

  it("an entry of a newer release than npm's newest (`npx sessionpipe@next reinstall`) moves nothing back", () => {
    const next = cached({ uses: ["this"], version: "1.3.0-rc.1" });
    const stray = copy(BREW, { where: "/opt/homebrew", version: OLD });
    // Something to repair: it is no refusal, and the entry goes with the rest, last.
    const p = plan(inv({ copies: [next, one({ uses: ["typed", "service", "hooks"] }), stray] }), facts());
    expect(p.refuse).toBeNull();
    expect(p.target).toBe(NEW);
    expect(does(p)).toEqual(["fetch", "install", "use", `remove ${stray.dir}`, `remove ${CACHED}`, "prove"]);
    // One nothing uses at all, the same.
    const unused = plan(inv({ copies: [cached({ version: "2.0.0" }), one(), stray] }), facts());
    expect(unused.refuse).toBeNull();
    expect(does(unused)).toContain(`remove ${CACHED}`);
    // Nothing to repair beside it: nothing to repair.
    const beside = plan(inv({ copies: [next, one({ uses: ["typed", "service", "hooks"] })] }), facts());
    expect(beside.nothing).toBe(NOTHING);
    // Its row names the release it is, newer than the newest or not.
    expect(beside.left.map((l) => [l.where, l.version, l.why])).toEqual([
      ["~/.npm/_npx/0a1b2c3d4e5f6a7b", "1.3.0-rc.1", NPX_CACHE],
    ]);
    // One that something here runs from is what this computer runs: moving it back is refused.
    const refusal = {
      error:
        "sessionpipe 1.3.0-rc.1 is on this computer, newer than npm's newest release (1.2.0): a reinstall would move it back. Nothing was changed",
      next: "sessionpipe doctor",
    };
    for (const use of ["service", "hooks", "typed"] as const) {
      const used = cached({ uses: [use, "this"], version: "1.3.0-rc.1" });
      expect(plan(inv({ copies: [used, one({ uses: [] })] }), facts()).refuse).toEqual(refusal);
    }
    // And so is a newer copy npm installed for every folder, whatever uses it.
    expect(plan(inv({ copies: [one(), copy(BREW, { version: "1.3.0-rc.1" })] }), facts()).refuse).toEqual(refusal);
  });

  it("an entry the service runs from, or that wrote the hooks, is a second copy: it acts; one that is typed is no installed copy, and is left", () => {
    const removes = ["fetch", "install", "use", `remove ${CACHED}`, "prove"];
    // Everything else as it should be: the entry in use is the one thing to repair.
    const hooked = plan(
      inv({ copies: [one({ uses: ["typed", "service", "this"] }), cached({ uses: ["hooks"] })] }),
      facts(),
    );
    expect(hooked.nothing).toBeNull();
    expect(does(hooked)).toEqual(removes);
    const served = plan(
      inv({ copies: [one({ uses: ["typed", "hooks", "this"] }), cached({ uses: ["service"] })] }),
      facts(),
    );
    expect(does(served)).toEqual(removes);
    // A link of someone's own to a cache entry, first on PATH: where the one clean copy
    // goes can't be answered by removing what they type.
    const typed = plan(
      inv({
        copies: [cached({ uses: ["typed"] }), one({ uses: ["service", "hooks", "this"] })],
        onPath: [
          { file: SCRIPT, dir: CACHED },
          { file: bin(LOCAL), dir: slotIn(LOCAL) },
        ],
        typed: CACHED,
        home: null,
      }),
      facts(),
    );
    expect(refused(typed)?.next).toBe("which -a sessionpipe");
  });

  it("with a real stray beside it, it acts and removes both: the entry this command runs from last", () => {
    const stray = copy(BREW, { where: "/opt/homebrew", version: OLD });
    const p = plan(
      inv({ copies: [cached({ uses: ["this"] }), one({ uses: ["typed", "service", "hooks"] }), stray] }),
      facts(),
    );
    expect(p.nothing).toBeNull();
    expect(does(p)).toEqual(["fetch", "install", "use", `remove ${stray.dir}`, `remove ${CACHED}`, "prove"]);
    // An entry nothing uses at all goes with what else is unused, in the order found.
    const unused = plan(inv({ copies: [cached(), one(), stray] }), facts());
    expect(does(unused)).toEqual(["fetch", "install", "use", `remove ${CACHED}`, `remove ${stray.dir}`, "prove"]);
    // And when the one copy itself is what needs repair, the entry goes with it.
    const broken = plan(inv({ copies: [cached({ uses: ["this"] }), one({ version: OLD, uses: ["typed"] })] }), facts());
    expect(does(broken)).toEqual(["fetch", "install", "use", `remove ${CACHED}`, "prove"]);
  });

  it("alone on the computer it is no copy at all: one is installed at the home, then the entry removed", () => {
    const alone = untyped({ copies: [cached({ uses: ["this"] })], home: home({ why: "a folder of your own" }) });
    const p = plan(alone, facts({ service: null, daemon: null, hooks: { version: null, wrong: [] } }));
    expect(p.nothing).toBeNull();
    expect(p.refuse).toBeNull();
    expect(does(p)).toEqual(["fetch", "install", "use", `remove ${CACHED}`, "prove"]);
    expect(step(p, "install")).toMatchObject({ prefix: LOCAL, dir: slotIn(LOCAL), replaces: false });
    // Offline there is no release to hold anything to, and nothing to install from.
    const offline = plan(alone, facts({ latest: { error: "registry.npmjs.org can't be reached (ENOTFOUND)" } }));
    expect(offline.nothing).toBeNull();
    expect(offline.target).toBeNull();
    expect(offline.refuse?.next).toBe("sessionpipe reinstall");
  });
});

describe("what these tests found in the plan, as it answers now", () => {
  it("'Nothing to repair' is said only of a copy that is what typing starts, or where that can't be told and a note says so: over computers made up from a seed", () => {
    // The other way round from property (a): what "Nothing to repair" is said of. Where a
    // shim is first on PATH and this command was not started through it, which copy is
    // typed can't be known: by design, with the note beside the sentence. There was one
    // more shape, where nothing said anything: nothing typed, the one copy's own folder
    // off PATH, and the home another folder that is on PATH. None is left.
    const other: string[] = [];
    let unknown = 0;
    let typed = 0;
    for (let seed = 1; seed <= 2500; seed++) {
      const { inv: i, facts: f } = world(seed);
      const p = made(i, f);
      if (!p.nothing?.startsWith("Nothing to repair")) continue;
      const it = i.copies.find((c) => c.slot && !idle(c)) as Copy;
      if (it.dir === i.typed) typed++;
      else if (i.unsure !== null) {
        unknown++;
        if (!p.notes.some((n) => n.includes(i.unsure as string) && n.includes("can't be told")))
          other.push(`seed ${seed}: unsure, and no note says so`);
      } else other.push(`seed ${seed}: typed ${i.typed}, the copy in ${it.prefix}, the home ${i.home?.prefix}`);
    }
    expect(other).toEqual([]);
    expect(typed).toBeGreaterThan(100);
    expect(unknown).toBeGreaterThan(10);
  });

  it("a plan with steps does not repeat what typing starts: the run puts it right, and only what it does not mend is said beside the rows", () => {
    // Nothing typed, an old copy where no shell looks, and a home on PATH: the fresh copy
    // goes where a shell finds it and the old one goes. `typing()` has a finding for this
    // computer (doctor says it); beside the plan it would be a note about what the plan
    // itself is about to change.
    const old = copy(BREW, { where: "/opt/homebrew", version: OLD, uses: ["service", "hooks", "this"], onPath: false });
    const lost = untyped({ copies: [old], home: home({ why: "a folder of your own" }), prefixes: [BREW, LOCAL] });
    expect(typing(lost)).toBe(NOT_ON_PATH(path.join(BREW, "bin")));
    const p = plan(lost, facts());
    expect(does(p)).toEqual(["fetch", "install", "use", `remove ${old.dir}`, "prove"]);
    expect(step(p, "install")).toMatchObject({ prefix: LOCAL, replaces: false });
    expect(p.notes).toEqual([]);
    // What the run does not mend is still said: a service nothing starts.
    const unserved = plan(lost, facts({ service: null, daemon: null }));
    expect(unserved.notes).toEqual([NOTHING_STARTS_IT]);
    // With nothing to do, the finding is the note (and the sentence is not "nothing to repair").
    const whole = plan({ ...lost, copies: [{ ...old, version: NEW }] }, facts());
    expect(whole.steps).toEqual([]);
    expect(whole.notes).toEqual([NOT_ON_PATH(path.join(BREW, "bin"))]);
    expect(whole.nothing).toBe(ONE_COPY);
  });

  it("L4: what is typed sits in a prefix's own slot and is not provably ours (what an install that was cut off left, a build): refused with the line that moves it aside, and deletes nothing; no line of npm's", () => {
    // A killed `npm install -g` (npm's tarball has package.json last): the folder is where
    // npm keeps the package, and has no package.json to say what it is. npm's own link
    // still leads to it, so it is what typing starts. Not provably ours, so never this
    // command's to remove; and an `npm install -g --prefix` over it failed for real,
    // beside npm's own retired folder. The person moves it, and the next run installs.
    const cut = (over: Partial<Copy> = {}): Copy =>
      copy(LOCAL, {
        where: "~/.local/lib/node_modules/sessionpipe",
        prefix: null,
        slot: null,
        not: "it has no package.json that can be read (an install that was cut off?)",
        version: null,
        uses: ["typed"],
        ...over,
      });
    const at = (c: Copy, over: Partial<Inventory> = {}): Inventory =>
      inv({ copies: [c, cached({ uses: ["this"] })], typed: c.dir, home: null, prefixes: [LOCAL], ...over });
    const sorry = (why: string, end = ". Move it aside, then run this again") =>
      `Typing \`sessionpipe\` starts ~/.local/lib/node_modules/sessionpipe, which is no installed copy of it (${why}): this command leaves it alone, so it can't put one clean copy in its place. Nothing was changed${end}`;
    const MOVE = `mv -n ${shq(slotIn(LOCAL), "linux")} ${shq(`${slotIn(LOCAL)}.old`, "linux")}`;
    expect(refused(plan(at(cut()), facts()))).toEqual({
      error: sorry("it has no package.json that can be read (an install that was cut off?)"),
      next: MOVE,
    });
    // Whoever may write there, and whatever the reason it is not ours (a build): the same line.
    expect(refused(plan(at(cut({ writable: false })), facts()))?.next).toBe(MOVE);
    expect(refused(plan(at(cut({ not: NOT_PUBLISHED })), facts()))).toEqual({
      error: sorry(NOT_PUBLISHED),
      next: MOVE,
    });
    for (const c of [cut(), cut({ writable: false }), cut({ not: NOT_PUBLISHED })])
      expect(refused(plan(at(c), facts()))?.next).not.toMatch(/npm|sudo/);
    // A folder with a space in its name is one word of the line, twice.
    const spaced = path.join(ROOT, "my node");
    const there = cut({ dir: slotIn(spaced) });
    expect(refused(plan(at(there, { prefixes: [spaced] }), facts()))?.next).toBe(
      `mv -n ${shq(slotIn(spaced), "linux")} ${shq(`${slotIn(spaced)}.old`, "linux")}`,
    );
    expect(shq(slotIn(spaced), "linux")).toMatch(/^'.* .*'$/);
    // Only for a looked-in prefix's own slot: the same folder where no prefix was looked in
    // (a project's dependency, a checkout) is somebody's own, and nothing is said to be moved.
    const elsewhere = plan(at(cut(), { prefixes: [BREW] }), facts());
    expect(refused(elsewhere)).toEqual({
      error: sorry("it has no package.json that can be read (an install that was cut off?)", ""),
      next: "which -a sessionpipe",
    });
  });

  it("L4: nothing is typed, and the one place the copy could go holds a folder that is not provably ours (`taken`): refused with the line that moves that folder aside; with nothing in the way it is the plain 'no folder'", () => {
    const dir = slotIn(LOCAL);
    const why = "it has no package.json that can be read (an install that was cut off?)";
    const stray = copy(BREW, { where: "/opt/homebrew", version: OLD, uses: ["this"], onPath: false });
    const taken = untyped({ copies: [stray], home: null, taken: { dir, why }, prefixes: [LOCAL, BREW] });
    expect(refused(plan(taken, facts()))).toEqual({
      error: `${dir} is not provably sessionpipe's (${why}), and it is where the one copy goes. Nothing was changed. Move it aside, then run this again`,
      next: `mv -n ${shq(dir, "linux")} ${shq(`${dir}.old`, "linux")}`,
    });
    // The folder is said as the caller shows a path; the line keeps it whole.
    const shown = plan(taken, facts(), (x) => `<${x}>`);
    expect(shown.refuse?.error).toMatch(
      new RegExp(`^<${dir.replace(/[.\\/]/g, "\\$&")}> is not provably sessionpipe's`),
    );
    expect(shown.refuse?.next).not.toContain("<");
    // No folder in the way, and no place: what PATH finds, as before.
    expect(refused(plan({ ...taken, taken: null }, facts()))?.next).toBe("which -a sessionpipe");
    // With a home found, a folder elsewhere that is not ours is only left alone: there is a plan.
    const withHome = plan(
      { ...taken, home: home({ prefix: BREW, shown: "/opt/homebrew", bin: path.join(BREW, "bin") }), taken: null },
      facts(),
    );
    expect(does(withHome)).toEqual(REPAIR);
    // It comes after what is typed being no install (which has its own line), and after `unsure`.
    const shim = path.join(HOME, ".asdf", "shims", "sessionpipe");
    expect(refused(plan({ ...taken, unsure: shim }, facts()))?.next).toBe(
      "npm install -g sessionpipe@1.2.0 && sessionpipe reinstall",
    );
  });

  it("L6: what is left of a copy that was emptied, in another prefix, is removed as a leftover folder, by that name", () => {
    // An empty folder of the name in a slot: the proof accepts it, it names no release,
    // and the look calls it what it is: a folder left behind.
    const emptied = copy(BREW, {
      where: "/opt/homebrew",
      aside: true,
      version: null,
      wrong: "left behind by an install that was cut off",
      bins: [],
      onPath: false,
    });
    const p = plan(inv({ copies: [one(), emptied], prefixes: [LOCAL, BREW] }), facts());
    expect(does(p)).toEqual(["fetch", "install", "use", `remove ${emptied.dir}`, "prove"]);
    expect(p.steps.find((s) => s.do === "remove")).toEqual({
      do: "remove",
      path: emptied.dir,
      touches: [emptied.dir],
      say: "a leftover folder in /opt/homebrew",
    });
    expect(JSON.stringify(p)).not.toMatch(/null in|undefined/);
    // With its own link still beside it, the link goes with it.
    const linked = plan(inv({ copies: [one(), { ...emptied, bins: [bin(BREW)] }] }), facts());
    expect(linked.steps.find((s) => s.do === "remove")?.touches).toEqual([emptied.dir, bin(BREW)]);
    // Where this user may not write it: left, with the one line that removes exactly it.
    const kept = plan(inv({ copies: [one({ version: OLD }), { ...emptied, writable: false }] }), facts());
    expect(kept.left).toEqual([
      {
        where: "/opt/homebrew",
        path: emptied.dir,
        version: null,
        why: "you may not write where it is",
        line: `sudo rm -r ${shq(emptied.dir, "linux")}`,
        ours: true,
      },
    ]);
  });

  it("M3: the unwritable home's refusal says whose copy it holds: the one you type, or, with nothing typed, the one that is to stay", () => {
    const sys = path.join(ROOT, "usr", "local");
    const theirs = home({ prefix: sys, shown: "/usr/local", bin: path.join(sys, "bin"), writable: false });
    const old = copy(sys, { where: "/usr/local", version: OLD, writable: false });
    const typed = plan(
      inv({
        copies: [{ ...old, uses: ["typed"] }],
        onPath: [{ file: bin(sys), dir: old.dir }],
        typed: old.dir,
        home: theirs,
      }),
      facts(),
    );
    expect(refused(typed)?.error).toBe(
      "/usr/local holds the copy you type (1.1.0), and you may not write there. Nothing was changed. Update it there, then run this again",
    );
    // Nothing typed (its link is gone, say): "the copy you type" was said of it all the same.
    const untypedOne = plan(
      untyped({ copies: [{ ...old, bins: [], wrong: "npm's link to it is gone" }], home: theirs }),
      facts(),
    );
    expect(refused(untypedOne)).toEqual({
      error:
        "/usr/local holds the copy that is to stay (1.1.0), and you may not write there. Nothing was changed. Update it there, then run this again",
      next: `sudo npm install -g --prefix ${shq(sys, "linux")} sessionpipe@1.2.0`,
    });
  });
});

describe("an emptied folder in the home's own slot is no copy that is there", () => {
  // An empty folder of the name in a slot is ours, of no release: a folder left behind.
  // The install row said it "replaces null", and the unwritable home's refusal that it
  // "holds the copy that is to stay (null)".
  const emptied = copy(LOCAL, {
    where: "~/.local",
    aside: true,
    version: null,
    wrong: "left behind by an install that was cut off",
    uses: [],
    bins: [],
  });

  it("the fresh copy is installed there for the home's own reason, and the folder is no step's to remove: the install moves it out of the way", () => {
    const p = plan(
      untyped({ copies: [emptied, cached({ uses: ["this"] })], home: home({ why: "a folder of your own" }) }),
      facts(),
    );
    expect(does(p)).toEqual(["fetch", "install", "use", `remove ${CACHED}`, "prove"]);
    expect(step(p, "install")).toMatchObject({
      dir: slotIn(LOCAL),
      replaces: false,
      say: "1.2.0, the newest release, fresh in ~/.local (a folder of your own)",
    });
    expect(JSON.stringify(p)).not.toMatch(/null in|replaces null|\(null\)/);
    // Typed through npm's link, which still leads into it: the same, where it is typed.
    const typed = plan(inv({ copies: [{ ...emptied, uses: ["typed"], bins: [bin(LOCAL)] }] }), facts());
    expect(step(typed, "install")).toMatchObject({
      replaces: false,
      say: "1.2.0, the newest release, fresh in ~/.local (where the one you type is)",
    });
    expect(does(typed)).toEqual(REPAIR);
    // It is never "nothing to repair", and never a copy that stays.
    expect(typed.nothing).toBeNull();
    expect(typed.stays).toBeNull();
  });

  it("where the home is not this user's to write, the refusal says a copy is to be installed there, not that one is held", () => {
    const theirs = plan(
      untyped({
        copies: [{ ...emptied, writable: false }, cached({ uses: ["this"] })],
        home: home({ writable: false }),
      }),
      facts(),
    );
    expect(refused(theirs)).toEqual({
      error:
        "~/.local is where `sessionpipe` goes (where the one you type is), and you may not write there. Nothing was changed. Install it there, then run this again",
      next: `sudo npm install -g --prefix ${shq(LOCAL, "linux")} sessionpipe@1.2.0`,
    });
  });
});

describe("what someone else's tool keeps is never told to be moved", () => {
  it("what is typed is the copy VOLTA keeps, and Volta's folder was looked in as a prefix (it always is): no line moves Volta's copy aside", () => {
    // The refusal for what is typed names `mv -n <folder>` where that folder is a looked-in
    // prefix's own slot: meant for what an install that was cut off left, or a build.
    // Volta's own package folder is such a slot too, and the look always lists it among
    // the prefixes: a whole copy that Volta keeps is Volta's, and no line moves it.
    const volta = path.join(HOME, ".volta", "tools", "image", "packages", "sessionpipe");
    const kept = copy(volta, {
      where: "~/.volta/tools/image/packages/sessionpipe",
      prefix: null,
      slot: null,
      not: "Volta keeps it",
      keeper: "volta uninstall sessionpipe",
      version: OLD,
      uses: ["typed", "this"],
    });
    const p = plan(
      inv({ copies: [kept, copy(BREW, { version: OLD })], typed: kept.dir, home: null, prefixes: [LOCAL, volta] }),
      facts(),
    );
    expect(refused(p)).toEqual({
      error:
        "Typing `sessionpipe` starts ~/.volta/tools/image/packages/sessionpipe, which is no installed copy of it (Volta keeps it): this command leaves it alone, so it can't put one clean copy in its place. Nothing was changed",
      next: "which -a sessionpipe",
    });
  });
});

describe("over computers made up from a seed (helpers/reinstall-worlds.ts): what holds for every plan", () => {
  const SEEDS = 2500;
  /** A count of the seeds something was so in. */
  const tally = () => {
    const seen: Record<string, number> = {};
    return {
      seen,
      count: (what: string, so = true) => {
        seen[what] = (seen[what] ?? 0) + (so ? 1 : 0);
      },
    };
  };
  const live = (i: Inventory): Copy[] => i.copies.filter((c) => c.slot && !idle(c));
  /** Two daemons, said a second time here (not the source's own `twins`): a service file,
   *  a daemon that is not the process its manager names, and that daemon's own word that
   *  someone started it; or, where it doesn't say, the manager naming another process. */
  const two = (f: Facts): boolean => {
    if (!f.service || !f.daemon || f.service.pid === f.daemon.pid) return false;
    if (f.daemon.byHand !== null) return f.daemon.byHand;
    return f.service.pid !== null;
  };

  it("the computers made up keep the look's own contract, or a property would only be about the generator", () => {
    const wrong: string[] = [];
    const { seen, count } = tally();
    for (let seed = 1; seed <= SEEDS; seed++)
      for (const [kind, w] of [
        ["world", world(seed)],
        ["healthy", healthy(seed)],
      ] as const) {
        const { inv: i, facts: f } = w;
        const no: string[] = [];
        const used = (u: Copy["uses"][number]) => i.copies.filter((c) => c.uses.includes(u));
        const typed = i.copies.find((c) => c.dir === i.typed);
        // One entry a folder; each use on one copy at most; "typed" on the copy that is typed.
        if (new Set(i.copies.map((c) => c.dir)).size !== i.copies.length) no.push("a folder is listed twice");
        for (const u of ["typed", "service", "hooks", "this"] as const)
          if (used(u).length > 1) no.push(`two copies are used by ${u}`);
        if (used("typed")[0] !== typed) no.push("'typed' is not on the copy that is typed");
        // What typing starts: the first on PATH that starts anything. A file that leads to
        // no folder, at the command path of a prefix that holds an installed copy, sits
        // where that copy's link was: nothing is typed, nothing is unsure, and where the
        // home is that prefix the file is what blocks it. Any other such file is a shim:
        // this command's own installed copy where it was started as npm's link to it, or
        // nobody can tell.
        const first = i.onPath.find((e) => !e.dir || !i.dangling.includes(e.file));
        const mine = used("this")[0];
        const installedAt = (dir: string | undefined): boolean =>
          i.copies.some(
            (c) => c.dir === dir && c.prefix != null && c.dir === slotIn(c.prefix) && (!!c.slot || !!c.keeper),
          );
        const file = first && !first.dir ? first.file : null;
        const under = file && path.basename(path.dirname(file)) === "bin" ? path.dirname(path.dirname(file)) : null;
        const inWay = !!under && installedAt(slotIn(under));
        const shimmed = !!file && !inWay && installedAt(mine?.dir) && w.asLink;
        if (first?.dir && i.typed !== first.dir) no.push("what is typed is not what PATH leads to first");
        if (file && i.typed !== (shimmed ? mine?.dir : null)) no.push("a file first, and typed is wrong");
        if (file && (i.unsure !== null) !== (!inWay && !shimmed)) no.push("a file first, and unsure is wrong");
        if (inWay && i.home?.prefix === under && i.home.blocked !== file)
          no.push("a file where a copy's link was, and the home there is not blocked by it");
        // A `.bin` is looked in only where no npm started this run.
        if (w.npmRun && i.onPath.some((e) => /[\\/]node_modules[\\/]\.bin[\\/]sessionpipe$/.test(e.file)))
          no.push("npm's run, and its own .bin is on the list");
        if (!first && (i.typed !== null || i.unsure !== null))
          no.push("nothing on PATH starts anything, and it is typed");
        if (i.unsure !== null && (i.typed !== null || i.unsure !== first?.file)) no.push("unsure, and typed");
        // The home: the typed copy's prefix, or none; never one for what is no install of ours.
        if (i.typed !== null && i.home && !(typed?.slot === "global" && typed.prefix === i.home.prefix))
          no.push("a home that is not the typed copy's prefix");
        if (i.unsure !== null && i.home) no.push("a home, and nobody can tell what is typed");
        if (i.home && i.home.bin !== path.join(i.home.prefix, "bin")) no.push("the home's bin is not its prefix's");
        if (i.home && i.copies.some((c) => c.dir === slotIn(i.home?.prefix ?? "") && !c.slot))
          no.push("the home's slot holds what is not ours");
        // Only a prefix that was looked in; and a FRESH place is never Homebrew's versioned
        // folder, nor Volta's own (the typed copy's home is where it is, whatever that is).
        if (i.home && !i.prefixes.includes(i.home.prefix)) no.push("a home in no prefix that was looked in");
        // What is in the way of the one copy is said only where no home was found: a folder
        // in a looked-in prefix's own slot that the proof refuses, with the proof's reason.
        if (i.taken && i.home) no.push("a home, and a folder said to be in the way of it");
        if (
          i.taken &&
          !(
            i.prefixes.some((x) => slotIn(x) === i.taken?.dir) &&
            i.copies.some((c) => c.dir === i.taken?.dir && !c.slot && (c.keeper || c.not === i.taken?.why))
          )
        )
          no.push("a folder in the way that is no refused folder in a prefix's slot");
        if (i.typed === null && i.home && /[\\/]Cellar[\\/]node(?:@\d+)?[\\/]/.test(i.home.prefix))
          no.push("a fresh place in Homebrew's versioned folder");
        if (i.typed === null && i.home && i.copies.some((c) => c.keeper && c.dir === slotIn(i.home?.prefix ?? "")))
          no.push("a fresh place in Volta's folder");
        // Each copy by its kind.
        for (const c of i.copies) {
          if (c.slot === "global" && c.dir !== (c.aside ? c.dir : slotIn(c.prefix ?? "")))
            no.push("a global copy off its slot");
          if (c.slot === "global" && !i.prefixes.includes(c.prefix ?? ""))
            no.push("a global copy in no prefix looked in");
          if (c.slot === "npx" && (c.prefix !== null || !inside(i.npx, c.dir)))
            no.push("an npx entry out of the cache");
          // A copy of ours names its release; what names none is a folder left behind.
          if (c.slot && !c.aside && c.version === null) no.push("a copy of ours that names no release");
          if (c.aside && c.version !== null) no.push("a folder left behind that names a release");
          // A shell looks in its command folder: only of a copy that sits in a global slot,
          // and always of one whose own link in that folder is among what a shell finds.
          if (c.onPath && !(c.slot === "global" || c.keeper)) no.push("on PATH, and in no global slot");
          // (The other way round a shell may look in a folder that holds no `sessionpipe`.)
          if (
            c.prefix !== null &&
            !c.onPath &&
            i.onPath.some((e) => path.dirname(e.file) === path.join(c.prefix as string, "bin"))
          )
            no.push("its own command is among what a shell finds, and it is not on PATH");
          if ((c.slot === null) !== (c.not !== null)) no.push("a copy that is ours and is not");
          if (c.aside !== (c.wrong === "left behind by an install that was cut off"))
            no.push("a leftover not called one");
          if (c.slot === "global" && !c.aside && !c.bins.length && c.wrong === null)
            no.push("no link, and nothing wrong");
          if (c.keeper && c.slot) no.push("Volta's copy is ours");
          if (c.prefix !== null && !(c.slot === "global" || c.keeper))
            no.push("a prefix for what is no copy in a global slot");
          if (i.reach !== true && (i.reach === null || !inside(i.reach, c.dir))) no.push("a copy out of reach");
          if (i.dangling.some((d) => c.bins.includes(d))) no.push("a copy's own link leads nowhere");
        }
        for (const s of i.strangers)
          if (!i.onPath.some((e) => e.file === s.file && e.dir === null)) no.push("a stranger that is not on PATH");
        if (i.onPath.filter((e) => e.dir === null).length !== i.strangers.length)
          no.push("a file on PATH is no stranger");
        // And the facts beside it.
        if ((i.reach === true) !== (f.apart === null)) no.push("apart, and all in reach (or the other way round)");
        if (used("service").length && !f.service?.cliOk) no.push("a copy serves, and no service file names it");
        if (used("hooks").some((c) => c.version !== f.hooks.version)) no.push("the hooks' copy is another release");
        if (f.staleSocket && f.daemon) no.push("a stale socket, and a daemon answers");
        if (f.hooks.wrong.length && !f.harnesses.length) no.push("hooks wrong, and nobody hooked");
        for (const n of no) wrong.push(`${kind} ${seed}: ${n}`);
        if (kind === "world") {
          count("no copy at all", !i.copies.length);
          count("several copies of ours", live(i).length > 1);
          count(
            "a leftover",
            i.copies.some((c) => c.aside),
          );
          count(
            "an npx entry in use",
            i.copies.some((c) => c.slot === "npx" && !idle(c)),
          );
          // A prefix is a global install's alone: a build in a slot has none, and is told
          // from a checkout by where it sits.
          const inSlot = (c: Copy): boolean => path.basename(path.dirname(path.dirname(c.dir))) === "lib";
          count(
            "a checkout or a project's dependency",
            i.copies.some((c) => !c.slot && !c.keeper && !inSlot(c)),
          );
          count(
            "a build where a prefix keeps a copy",
            i.copies.some((c) => !c.slot && !c.keeper && inSlot(c)),
          );
          count(
            "Volta's copy",
            i.copies.some((c) => !!c.keeper),
          );
          count(
            "a copy this user may not write",
            i.copies.some((c) => c.slot && !c.writable),
          );
          count(
            "a copy that is not whole",
            i.copies.some((c) => c.slot && !c.aside && c.wrong),
          );
          count(
            "a copy newer than npm's newest",
            i.copies.some((c) => c.slot && c.version === AHEAD),
          );
          count("a dangling link", i.dangling.length > 0);
          count("a stranger", i.strangers.length > 0);
          count("no home", i.home === null);
          count("the home blocked", !!i.home?.blocked);
          count("the home off PATH", i.home?.onPath === false);
          count("the home not writable", i.home?.writable === false);
          count("a reach of its own", typeof i.reach === "string");
          const cut = (c: Copy): boolean => !c.slot && !c.keeper && !!c.not?.includes("no package.json");
          count("what an install that was cut off left in a slot", i.copies.some(cut));
          count(
            "that, and it is what typing starts",
            i.copies.some((c) => cut(c) && c.dir === i.typed),
          );
          count(
            "an emptied folder of ours, in a slot: a leftover",
            i.copies.some((c) => c.slot === "global" && c.aside && i.prefixes.some((x) => slotIn(x) === c.dir)),
          );
          count("no home, and a folder that is not ours in the way of it", i.taken !== null);
          count(
            "a link that leads nowhere and names no prefix that was looked in",
            i.onPath.some(
              (e) =>
                e.dir !== null && i.dangling.includes(e.file) && !i.prefixes.some((x) => inside(x, e.dir as string)),
            ),
          );
          count(
            "an installed copy no shell looks for, and nothing typed",
            i.typed === null && i.unsure === null && typing(i) !== null,
          );
          count(
            "the typed copy's home is Homebrew's versioned folder",
            i.typed !== null && !!i.home?.prefix.includes("Cellar"),
          );
          count("a file where a copy's link was", inWay);
          count("a shim first, started as npm's link: typed", shimmed);
          count("a shim first, started by its path or by npx: unsure", !!file && !inWay && !shimmed);
          count(
            "a shim first, this command's copy installed, started by its path: unsure",
            !!file && !inWay && installedAt(mine?.dir) && !w.asLink,
          );
          count("started by npm or npx", w.npmRun);
          count(
            "a person's own .bin on PATH",
            i.onPath.some((e) => /[\\/]node_modules[\\/]\.bin[\\/]sessionpipe$/.test(e.file)),
          );
          count("no service file", !f.service);
          count("a stale socket", f.staleSocket);
          count("no agent hooked", !f.harnesses.length);
        }
      }
    expect(wrong.slice(0, 20)).toEqual([]);
    for (const [what, n] of Object.entries(seen)) expect(n, what).toBeGreaterThan(SEEDS / 250);
  });

  it("(a) M3: whenever the one installed copy is whole, the newest, what is typed, with hooks and service fine, it is 'Nothing to repair' with no step: whoever may write its home, on PATH or not, whatever strangers and idle npx entries are beside it", () => {
    const wrong: string[] = [];
    const { seen, count } = tally();
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { inv: i, facts: f } = healthy(seed);
      const p = made(i, f);
      const ours = live(i);
      const it = ours[0];
      // The world is the one that was asked for: said of the inventory and the facts
      // themselves, by nothing the plan computes.
      const asked =
        ours.length === 1 &&
        it?.slot === "global" &&
        !it.aside &&
        it.wrong === null &&
        it.version === NEWEST &&
        it.dir === i.typed &&
        it.uses.includes("typed") &&
        i.unsure === null &&
        !i.dangling.length &&
        "version" in f.latest &&
        f.latest.version === NEWEST &&
        (!f.harnesses.length || (f.hooks.version === NEWEST && !f.hooks.wrong.length)) &&
        (f.service
          ? // A service file nothing needs, with no daemon answering, is fine as it is.
            (!f.wanted && !f.daemon) ||
            (f.wanted &&
              f.service.loaded &&
              f.service.nodeOk &&
              it.uses.includes("service") &&
              f.daemon?.version === NEWEST &&
              !two(f))
          : f.daemon
            ? f.daemon.version === NEWEST
            : !f.wanted);
      const no = [
        ...(asked ? [] : ["the generator made a computer that is not the one asked for"]),
        ...broken(p),
        ...(p.nothing?.startsWith("Nothing to repair") ? [] : [`it says ${JSON.stringify(p.nothing)}`]),
        ...(p.refuse ? [`it refuses: ${p.refuse.error}`] : []),
        ...(p.steps.length ? [`it has steps: ${does(p).join(", ")}`] : []),
        ...(p.notes.length ? [`it has notes: ${p.notes.join(" | ")}`] : []),
        ...(p.target === NEWEST ? [] : [`its release is ${p.target}`]),
        ...(p.home === i.home ? [] : ["its home is not the look's"]),
      ];
      for (const n of no) wrong.push(`seed ${seed}: ${n}`);
      count("the home is not this user's to write", i.home?.writable === false);
      count("the home is this user's to write", i.home?.writable === true);
      count("the home's bin folder is not on PATH", i.home?.onPath === false);
      count("the home's bin folder is on PATH", i.home?.onPath === true);
      count(
        "the home is Homebrew's versioned folder (the typed copy's own, whatever it is)",
        !!i.home?.prefix.includes("Cellar"),
      );
      count("a stranger on PATH", i.strangers.length > 0);
      count("a stranger first on PATH: typed through a shim", i.onPath[0]?.dir === null);
      count("an idle npx entry", i.copies.some(idle));
      count("two idle npx entries", i.copies.filter(idle).length > 1);
      count(
        "this command runs from an npx entry",
        i.copies.some((c) => idle(c) && c.uses.includes("this")),
      );
      count(
        "a folder that is no install of it",
        i.copies.some((c) => !c.slot),
      );
      count(
        "Volta's copy",
        i.copies.some((c) => c.keeper),
      );
      count("a world of its own (a reach)", i.reach !== true);
      count("no agent hooked", !f.harnesses.length);
      count("agents hooked", f.harnesses.length > 0);
      count("a service", !!f.service && f.wanted);
      count("a service file nothing needs, and no daemon", !!f.service && !f.wanted && !f.daemon);
      count("started by npm or npx (that run's own .bin passed over)", healthy(seed).npmRun);
      count("a daemon by hand, no service file", !f.service && !!f.daemon);
      count("the service's daemon says a manager started it", !!f.service && f.daemon?.byHand === false);
      count("the service's daemon doesn't say who started it", !!f.service && f.daemon?.byHand === null);
      count("the manager names no process for the service", !!f.service && !!f.daemon && f.service.pid === null);
      count("neither service nor daemon", !f.service && !f.daemon);
      count("no npm", !f.npm);
      count("something listed as left", p.left.length > 0);
    }
    expect(wrong.slice(0, 20)).toEqual([]);
    // The property is hollow unless each of these really varied.
    for (const [what, n] of Object.entries(seen)) expect(n, what).toBeGreaterThan(SEEDS / 50);
    expect(seen["the home is not this user's to write"]).toBeGreaterThan(SEEDS / 5);
    expect(seen["the home's bin folder is not on PATH"]).toBeGreaterThan(SEEDS / 10);
  });

  it("(b) every plan that has steps: the home is the typed copy's prefix, no step removes what is typed or installs anywhere but the home, nothing touched is left alone, and the steps are in their order; with what is typed unsure or no installed copy, no plan has a step", () => {
    const wrong: string[] = [];
    const { seen, count } = tally();
    let homeless = 0;
    let taken = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { inv: i, facts: f } = world(seed);
      const p = made(i, f);
      const no = broken(p);
      const typed = i.copies.find((c) => c.dir === i.typed);
      const astray = i.unsure !== null || (i.typed !== null && typed?.slot !== "global");
      // A file where an installed copy's link was (the look's `inWay`): never answered with
      // the line that has npm install over it, and where the home is that prefix, refused.
      const led = i.onPath.find((e) => !e.dir || !i.dangling.includes(e.file));
      const beside = led && !led.dir && path.basename(path.dirname(led.file)) === "bin" ? led.file : null;
      const prefixOf = beside ? path.dirname(path.dirname(beside)) : null;
      const inWay =
        !!prefixOf &&
        i.copies.some((c) => c.dir === slotIn(prefixOf) && c.prefix === prefixOf && (!!c.slot || !!c.keeper));
      if (inWay && p.refuse?.next.startsWith("npm install -g sessionpipe@"))
        no.push("a file where a copy's link was, and the line installs over it");
      if (inWay && i.home?.prefix === prefixOf && (p.steps.length || p.nothing !== null || !p.refuse))
        no.push("a file where a copy's link was in the home, and it is not refused");
      if (inWay && i.home?.prefix === prefixOf && p.refuse?.next.startsWith("mv -n") !== true) {
        // Only what is said before any look at the home may come first.
        if (!/^(sessionpipe reinstall|sessionpipe doctor|env -u )/.test(p.refuse?.next ?? ""))
          no.push(`a file where a copy's link was in the home, and the line is ${p.refuse?.next}`);
      }
      count("a file where a copy's link was", inWay);
      count("a file where a copy's link was: refused with `mv -n`", inWay && !!p.refuse?.next.startsWith("mv -n"));
      if (astray && p.steps.length) no.push("what is typed is unsure or no installed copy, and it has steps");
      // What is KNOWN to be astray is a finding: never "Nothing to repair", and `typing`
      // (doctor's row) answers it. What can't be known is neither: `typing` is silent, and
      // beside one whole copy it is "Nothing to repair" with the note that says so.
      const known = i.typed !== null && typed?.slot !== "global";
      if (known && p.nothing?.startsWith("Nothing to repair"))
        no.push("what is typed is no installed copy, and nothing is said");
      if (known && typing(i) === null) no.push("what is typed is no installed copy, and typing() is silent");
      // The refusal for it names what PATH finds; or, where what is typed sits in a
      // looked-in prefix's own slot (what an install that was cut off left, a build), the
      // line that moves that folder aside. Never a line of npm's.
      // (Never of what someone else's tool keeps: Volta's copy is Volta's to remove.)
      const inSlot = !typed?.keeper && i.prefixes.some((x) => slotIn(x) === i.typed);
      const move = (dir: string): string => `mv -n ${shq(dir, "linux")} ${shq(`${dir}.old`, "linux")}`;
      if (known && p.refuse?.error.startsWith("Typing `sessionpipe` starts")) {
        const line = inSlot ? move(i.typed as string) : "which -a sessionpipe";
        if (p.refuse.next !== line) no.push(`what is typed is no installed copy, and the line is ${p.refuse.next}`);
        if (p.refuse.error.endsWith(". Move it aside, then run this again") !== inSlot)
          no.push("what is typed is no installed copy, and the sentence about moving it is wrong");
        count("refused: what is typed is in a prefix's slot and not ours: `mv -n` it", inSlot);
      }
      if (known && p.refuse && /npm install/.test(p.refuse.next))
        no.push(`what is typed is no installed copy, and a refusal names ${p.refuse.next}`);
      // No home: the folder that is in the way of it is moved aside; with none, what PATH finds.
      if (p.refuse && /^no folder on this computer|is not provably sessionpipe's/.test(p.refuse.error)) {
        if (i.home) no.push("a home, and it is refused for none");
        const line = i.taken ? move(i.taken.dir) : "which -a sessionpipe";
        if (p.refuse.next !== line) no.push(`no home, and the line is ${p.refuse.next}`);
        if (p.refuse.error.includes("is not provably sessionpipe's") !== (i.taken !== null))
          no.push("no home, and the sentence is the other one");
        if (i.taken) taken++;
      }
      // A folder left behind in the home's own slot is no copy that is there: the install
      // row gives the home's reason, and nothing says `null` of a release.
      if (/replaces null|\(null\)|null in /.test(JSON.stringify(p))) no.push("a release that is no release is said");
      // "Nothing to repair" is said of the copy that is typed, or where that can't be told.
      if (p.nothing?.startsWith("Nothing to repair") && live(i)[0]?.dir !== i.typed && i.unsure === null)
        no.push("nothing to repair, and the one copy is not what is typed");
      if (i.unsure !== null && typing(i) !== null) no.push("it can't be told what is typed, and typing() answers");
      if (i.unsure !== null && p.nothing !== null && !p.notes.some((n) => n.includes("can't be told from here")))
        no.push("it can't be told what is typed, and no note says so");
      // A sentence for a computer with no step is "Nothing to repair" exactly where
      // nothing was found: where `typing` is silent and the service, if wanted, is there.
      if (p.nothing !== null) {
        const finding = typing(i) !== null || (f.wanted && !f.service && !f.daemon);
        if (p.nothing.startsWith("Nothing to repair") === finding)
          no.push(`a computer with ${finding ? "a" : "no"} finding, and it says ${p.nothing}`);
      }
      count(
        "unsure, and nothing to repair beside the note",
        i.unsure !== null && !!p.nothing?.startsWith("Nothing to repair"),
      );
      // The source's one definition is the table said above; and with two daemons a
      // computer is never one with nothing to do.
      if (twins(f.service, f.daemon) !== two(f)) no.push("twins() is not the table");
      if (two(f) && p.nothing !== null) no.push(`two daemons, and it says ${p.nothing}`);
      count("two daemons", two(f));
      count(
        "two daemons: the manager names no process, and the daemon says by hand",
        two(f) && f.service?.pid === null,
      );
      count(
        "another process than the manager's, started by a manager: not two",
        !!f.service && !!f.daemon && f.service.pid !== null && f.service.pid !== f.daemon.pid && !two(f),
      );
      if (p.stays !== null && !p.steps.length) no.push("a copy stays, and nothing is done");
      if (p.steps.length) {
        const h = p.home;
        const at = h ? slotIn(h.prefix) : null;
        if (!h || h !== i.home) no.push("it has steps and no home, or a home that is not the look's");
        if (p.target !== NEWEST) no.push(`it installs ${p.target}`);
        // The home is where the typed copy lives.
        if (i.typed !== null && (typed?.prefix !== h?.prefix || typed?.dir !== at))
          no.push(`the home is ${h?.prefix}, and what is typed is in ${typed?.prefix}`);
        if (i.typed === null && !h?.onPath) no.push("nothing is typed, and the home's bin folder is not on PATH");
        // What typing starts, where it is a finding (an installed copy no shell looks for):
        // the run puts it right, so it is no note beside the rows; and it is never so of a
        // computer where a copy is typed.
        const astrayNow = typing(i);
        if (astrayNow !== null && i.typed !== null)
          no.push(`it has steps, a copy is typed, and typing says ${astrayNow}`);
        if (astrayNow !== null && p.notes.includes(astrayNow)) no.push("it has steps, and repeats what typing starts");
        count("steps: an installed copy no shell found is put right", astrayNow !== null);
        if (h?.blocked) no.push("it has steps, and a file is where the home's link goes");
        // Nothing this computer runs is newer than what it installs: nothing is moved back.
        if ([...live(i).map((c) => c.version), f.hooks.version, f.daemon?.version].includes(AHEAD))
          no.push(`it has steps, and ${AHEAD} is here: it would be moved back`);
        // What is typed is never removed: not the copy, not its links, not the file a shell finds.
        const found = i.onPath.find((e) => !e.dir || i.copies.some((c) => c.dir === e.dir))?.file;
        const dear = [...(typed ? [typed.dir, ...typed.bins] : []), ...(i.typed !== null && found ? [found] : [])];
        const removes = p.steps.filter((s) => s.do === "remove");
        for (const s of removes)
          for (const t of [s.path, ...s.touches])
            if (dear.includes(t)) no.push(`a removal touches ${t}, which is typed`);
        // Nor is the link the install writes: a link there that led nowhere is written again.
        for (const s of removes)
          if (h && s.touches.includes(path.join(h.bin, "sessionpipe"))) no.push("a removal takes the home's own link");
        // It installs once at most, and only into the home.
        const installs = p.steps.filter((s) => s.do === "install");
        if (installs.length > 1) no.push("it installs twice");
        for (const s of installs)
          if (
            s.prefix !== h?.prefix ||
            s.dir !== at ||
            s.touches.join() !== [at, path.join(h?.bin ?? "", "sessionpipe")].join()
          )
            no.push(`it installs into ${s.dir}`);
        if (installs.length && installs[0]?.version !== NEWEST) no.push("it installs another release");
        // Nothing a step touches is a stranger's file, a copy that is no install of ours,
        // or a copy this user may not write.
        const theirs = [
          ...i.strangers.map((s) => s.file),
          ...i.copies.filter((c) => !c.slot).map((c) => c.dir),
          ...i.copies.filter((c) => c.slot && !c.writable && c.dir !== at).flatMap((c) => [c.dir, ...c.bins]),
        ];
        for (const s of p.steps)
          for (const t of [...s.touches, ...(s.do === "remove" ? [s.path] : [])])
            if (theirs.some((x) => inside(x, t))) no.push(`${s.do} touches ${t}, which is not this command's`);
        // A removal is of a copy that is ours and not the home's, or of a link that leads nowhere.
        const mine = i.copies.filter((c) => c.slot && c.writable && c.dir !== at);
        for (const s of removes) {
          const c = mine.find((x) => x.dir === s.path);
          if (
            c
              ? s.touches.join() !== [c.dir, ...c.bins].join()
              : !i.dangling.includes(s.path) || s.touches.join() !== s.path
          )
            no.push(`it removes ${s.path}`);
        }
        // Every copy of ours but the home's goes, or is listed as left with its one line.
        for (const c of i.copies.filter((x) => x.slot && x.dir !== at)) {
          const gone = removes.some((s) => s.path === c.dir);
          const kept = p.left.find((l) => l.path === c.dir);
          if (gone === !!kept) no.push(`${c.dir} is ${gone ? "removed and left" : "neither removed nor left"}`);
          if (kept && kept.line !== `sudo rm -r ${[c.dir, ...c.bins].map((x) => shq(x, "linux")).join(" ")}`)
            no.push(`the line for ${c.dir} is ${kept.line}`);
        }
        // The order: the download before the install, the copy put to use before anything
        // is removed, the check last; of the copies, this command's own goes last.
        const order = p.steps.map((s) => s.do);
        const use = order.indexOf("use");
        if (order.at(-1) !== "prove" || order.filter((d) => d === "prove").length !== 1)
          no.push("the check is not last");
        if (use < 0 || order.filter((d) => d === "use").length !== 1) no.push("it is put to use not once");
        if (order.includes("install") && order.indexOf("fetch") !== order.indexOf("install") - 1)
          no.push("no download first");
        if (order.includes("install") && order.indexOf("install") > use) no.push("it is used before it is installed");
        if (order.includes("stop") && order.indexOf("stop") !== use - 1)
          no.push("the daemon is not stopped just before");
        // A daemon is stopped exactly where there are two, and it is the one that answers.
        if (order.includes("stop") !== two(f)) no.push(`two daemons: ${two(f)}, and the steps are ${order.join(", ")}`);
        for (const s of p.steps) if (s.do === "stop" && s.pid !== f.daemon?.pid) no.push("it stops another process");
        if (removes.length && order.indexOf("remove") < use) no.push("something is removed before the copy is in use");
        const copies = removes.map((s) => i.copies.find((c) => c.dir === s.path)).filter((c): c is Copy => !!c);
        const own = copies.findIndex((c) => c.uses.includes("this"));
        if (own >= 0 && own !== copies.length - 1) no.push("this command's own copy is not the last removed");
        // The service file is the `use` step's alone, and only where there is a service to move.
        for (const s of p.steps)
          if (f.service && s.touches.includes(f.service.file) && !(s.do === "use" && s.serve))
            no.push(`${s.do} touches the service file`);
        if (
          p.stays !== null &&
          !(h && !h.writable && i.copies.some((c) => c.dir === at && !c.wrong && c.version === NEWEST))
        )
          no.push("a copy stays that is not whole, the newest and unwritable");
      }
      for (const n of no) wrong.push(`seed ${seed}: ${n}`);
      count("a plan with steps", p.steps.length > 0);
      count("a refusal", p.refuse !== null);
      count("nothing to repair", !!p.nothing?.startsWith("Nothing to repair"));
      count("one copy, with a note", !!p.nothing && !p.nothing.startsWith("Nothing to repair"));
      count("typed: an installed copy", typed?.slot === "global");
      count("typed: no installed copy", i.typed !== null && typed?.slot !== "global");
      count("typed: unsure", i.unsure !== null);
      count("typed: nothing", i.typed === null && i.unsure === null);
      count(
        "typed through a shim",
        i.typed !== null && i.onPath.find((e) => !e.dir || i.copies.some((c) => c.dir === e.dir))?.dir === null,
      );
      count("steps: the home's copy stays", p.steps.length > 0 && p.stays !== null);
      count(
        "steps: a copy is removed",
        p.steps.some((s) => s.do === "remove" && s.touches.length > 0 && !i.dangling.includes(s.path)),
      );
      count(
        "steps: a dangling link is removed",
        p.steps.some((s) => s.do === "remove" && i.dangling.includes(s.path)),
      );
      count(
        "steps: this command's own copy is removed",
        p.steps.some((s) => s.do === "remove" && i.copies.some((c) => c.dir === s.path && c.uses.includes("this"))),
      );
      count("steps: a copy is left, with its sudo line", p.steps.length > 0 && p.left.some((l) => l.ours));
      count("steps: something no install is left", p.steps.length > 0 && p.left.some((l) => !l.ours));
      count("steps: nothing was typed", p.steps.length > 0 && i.typed === null);
      count(
        "steps: a daemon is stopped",
        p.steps.some((s) => s.do === "stop"),
      );
      count(
        "steps: an empty slot is installed into",
        p.steps.some((s) => s.do === "install" && !s.replaces),
      );
      count("steps: the home's bin folder is not on PATH", p.steps.length > 0 && p.home?.onPath === false);
      count("a world that may reach nothing", i.reach === null);
      count("npm out of reach", "error" in f.latest);
      count(`something newer than npm's newest (${AHEAD})`, !!p.refuse?.error.includes(AHEAD));
      for (const next of [
        "sudo npm install -g --prefix",
        "npm install -g sessionpipe@",
        "mv -n ",
        "export PATH=",
        "env -u ",
        "which -a sessionpipe",
      ])
        count(`refused: ${next}`, !!p.refuse?.next.startsWith(next));
      // (Seldom: a folder of the user's own is nearly always a place.)
      if (p.refuse?.error.startsWith("no folder on this computer")) homeless++;
    }
    expect(wrong.slice(0, 20)).toEqual([]);
    for (const [what, n] of Object.entries(seen)) expect(n, what).toBeGreaterThan(SEEDS / 250);
    // No home: seldom, and in these computers always with a folder in the way (the plain
    // "no folder" is the hand-written tests' above).
    expect(taken).toBeGreaterThan(0);
    expect(homeless).toBeGreaterThanOrEqual(0);
    expect(seen["a plan with steps"]).toBeGreaterThan(SEEDS / 5);
    expect(seen["a refusal"]).toBeGreaterThan(SEEDS / 5);
    expect(seen["nothing to repair"]).toBeGreaterThan(SEEDS / 25);
  });

  it("M2: no plan names `npm uninstall`, by a step or by a line to paste: over every plan made in this file and every computer made up from a seed", () => {
    // Every plan a test above asked for was held to this as it was made (`broken`): they
    // are gone through once more here, with the computers made up from a seed.
    const every = [
      ...all,
      ...Array.from({ length: SEEDS }, (_, n) => world(n + 1)).map((w) => made(w.inv, w.facts)),
      ...Array.from({ length: SEEDS }, (_, n) => healthy(n + 1)).map((w) => made(w.inv, w.facts)),
    ];
    let lines = 0;
    let kept = 0;
    for (const p of every) {
      expect(JSON.stringify(p)).not.toMatch(/npm uninstall|npm rm\b|--prefix \S+ sessionpipe(?!@)/);
      for (const l of p.left) {
        if (l.ours) {
          // The line for a copy of ours that stays is the one deletion this command would
          // have made, by hand: never anything a package manager decides the extent of.
          expect(l.line).toMatch(/^sudo rm -r \S/);
          lines++;
        } else if (l.line !== null) {
          // The one other line a row may have: someone else's tool, for its own copy.
          expect(l.line).toBe(KEEPER);
          kept++;
        }
      }
      // Nowhere else is the word.
      expect(JSON.stringify({ ...p, left: p.left.map((l) => ({ ...l, line: l.ours ? l.line : null })) })).not.toMatch(
        /uninstall/i,
      );
      // And no step this command does not have: a service file is never a step's to remove.
      for (const s of p.steps) expect(["fetch", "install", "stop", "use", "remove", "prove"]).toContain(s.do);
    }
    expect(lines).toBeGreaterThan(50);
    expect(kept).toBeGreaterThan(20);
  });
});
