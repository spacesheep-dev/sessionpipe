// SPDX-License-Identifier: Apache-2.0
// The plan `sessionpipe reinstall` makes (reinstall/plan.ts), from inventories and facts
// written out here: no file is made and nothing is run. One clean copy in use everywhere
// is nothing to repair, and each thing that breaks that is tried by itself; then every
// refusal, the steps and their order, what each step's row says, what is left alone,
// what keeps a run safe, and what is said beside them.
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Copy, Inventory } from "../src/reinstall/find.js";
import { type Facts, idle, plan as made, type Plan, type Step, slotIn } from "../src/reinstall/plan.js";

/** The plan, as every test here asks for it, held each time to what no plan may do:
 *  touch what it says it leaves. Nothing a step touches is the whole path of a thing
 *  left alone, and nothing left alone is a folder a step removes or installs into.
 *  And to what every plan's screen is made of: a step that is shown has words for its
 *  row, the download and the check have none, and what keeps a run safe is said of a
 *  plan that does something and of no other. */
const plan = (...given: Parameters<typeof made>): Plan => {
  const p = made(...given);
  const kept = p.left.map((l) => path.resolve(l.path));
  for (const s of p.steps) {
    for (const t of s.touches) expect(kept, `${s.do} touches what is left alone`).not.toContain(path.resolve(t));
    if (s.do === "remove") expect(kept, "a removal of what is left alone").not.toContain(path.resolve(s.path));
    if (s.do === "install") expect(kept, "an install into what is left alone").not.toContain(path.resolve(s.dir));
    if (s.do === "fetch" || s.do === "prove") expect("say" in s, `${s.do} has no row`).toBe(false);
    else if (s.do !== "use") expect(s.say, `${s.do} has a row`).toMatch(/\S/);
    expect("why" in s, `${s.do} says its row and nothing else`).toBe(false);
  }
  expect(p.safety.length > 0, "what keeps a run safe is said where something is done").toBe(p.steps.length > 0);
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
const CACHED = path.join(HOME, ".npm", "_npx", "0a1b2c3d4e5f6a7b", "node_modules", "sessionpipe");
const FILE = path.join(HOME, "Library", "LaunchAgents", "org.sessionpipe.control.plist");
const HOOKS = [path.join(LOCAL, "share", "sessionpipe", "hook"), path.join(HOME, ".claude", "settings.json")];

/** The bin link (on Windows the shim) npm makes in a prefix. */
const bin = (prefix: string, platform: NodeJS.Platform = "linux"): string =>
  platform === "win32" ? path.join(prefix, "sessionpipe.cmd") : path.join(prefix, "bin", "sessionpipe");

/** A published copy in a global prefix: whole, running, the newest, used by nothing. */
const copy = (prefix: string, over: Partial<Copy> = {}, platform: NodeJS.Platform = "linux"): Copy => ({
  dir: slotIn(prefix, platform),
  where: prefix,
  prefix,
  slot: "global",
  not: null,
  aside: false,
  version: NEW,
  runs: true,
  wrong: null,
  bins: [bin(prefix, platform)],
  uses: [],
  writable: true,
  keeper: null,
  ...over,
});
/** The copy everything uses, where the fresh one would go. */
const one = (over: Partial<Copy> = {}, platform: NodeJS.Platform = "linux"): Copy =>
  copy(LOCAL, { where: "~/.local", uses: ["typed", "service", "hooks", "this"], ...over }, platform);
/** A copy in the npx cache: its place is the cache entry it is in. */
const cached = (over: Partial<Copy> = {}): Copy =>
  copy(LOCAL, {
    dir: CACHED,
    where: "~/.npm/_npx/0a1b2c3d4e5f6a7b",
    prefix: null,
    slot: "npx",
    bins: [],
    ...over,
  });
/** A folder npm left in a prefix when an install was cut off. */
const leftover = (prefix: string, over: Partial<Copy> = {}): Copy =>
  copy(prefix, {
    dir: path.join(prefix, "lib", "node_modules", ".sessionpipe-Ab12Cd34"),
    aside: true,
    runs: false,
    wrong: "left behind by an install that was cut off",
    bins: [],
    ...over,
  });

type Home = Inventory["homes"][number];
/** The folder a prefix's command goes in: its bin folder, on Windows the prefix itself. */
const binOf = (prefix: string, platform: NodeJS.Platform = "linux"): string =>
  platform === "win32" ? prefix : path.join(prefix, "bin");
/** Where the fresh copy goes: ~/.local, its bin folder the first on PATH. */
const home = (over: Partial<Home> = {}, platform: NodeJS.Platform = "linux"): Home => ({
  prefix: LOCAL,
  shown: "~/.local",
  why: "where the one you type is",
  bin: binOf(LOCAL, platform),
  pathAt: 0,
  blocked: null,
  ...over,
});
/** A `sessionpipe` a shell finds: the file, and the folder it leads to (none for a file
 *  that is no install). */
type Found = { file: string; dir: string | null };
/** The home's bin folder on PATH with no `sessionpipe` in it yet. */
const EMPTY = "the home's bin folder, with nothing in it";
/** PATH as a shell reads it, folder by folder: the `sessionpipe` found in one, or `EMPTY`.
 *  Answers what the look lists of it: each one found with its folder's place on PATH, and
 *  the home with its bin folder's place (none where PATH doesn't have that folder). */
const shell = (
  folders: (Found | typeof EMPTY)[],
  h: Partial<Home> = {},
  platform: NodeJS.Platform = "linux",
): Pick<Inventory, "onPath" | "homes"> => {
  const mine = home(h, platform);
  const at = folders.findIndex((f) => f === EMPTY || path.dirname(f.file) === mine.bin);
  return {
    onPath: folders.flatMap((f, n) => (f === EMPTY ? [] : [{ ...f, at: n }])),
    homes: [{ ...mine, pathAt: at < 0 ? null : at }],
  };
};
/** A computer with the one copy, typed from its own bin folder. */
const inv = (over: Partial<Inventory> = {}): Inventory => {
  const platform = over.platform ?? "linux";
  return {
    platform,
    reach: true,
    copies: [one({}, platform)],
    dangling: [],
    strangers: [],
    ...shell([{ file: bin(LOCAL, platform), dir: slotIn(LOCAL, platform) }], {}, platform),
    prefixes: [LOCAL],
    ...over,
  };
};
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
  daemon: { pid: 100, version: NEW },
  apart: null,
  ...over,
});

/** The steps of a plan by name, a removal with what it removes. */
const does = (p: Plan): string[] => p.steps.map((s) => (s.do === "remove" ? `remove ${s.path}` : s.do));
const step = <K extends Step["do"]>(p: Plan, k: K): Extract<Step, { do: K }> =>
  p.steps.find((s) => s.do === k) as Extract<Step, { do: K }>;
/** What a repair of the one copy is, with nothing else to remove. */
const REPAIR = ["fetch", "install", "use", "prove"];

/** One clean copy and nothing more to say: the one sentence that says "nothing to repair". */
const NOTHING = "Nothing to repair: one sessionpipe, 1.2.0, the newest release.";
/** The same one copy with a note beside it (what a person types is another file, a
 *  folder is not on PATH, nothing starts the service): no step would change it, and the
 *  sentence no longer calls it nothing to repair. The note says what there is to say. */
const ONE_COPY = "One sessionpipe on this computer: 1.2.0, the newest release.";
/** And where npm couldn't be asked: no release is called the newest, and a note says why. */
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
/** `shown`: the home the fresh copy goes to, as the look shows it. */
const FOUND_FIRST = (file: string, shown = "~/.local") =>
  `Typing \`sessionpipe\` starts ${file}, not the copy in ${shown}.`;
/** What a plan says of what a shell finds first: the file as it is, and the notes. */
const finds = (p: Plan) => ({ first: p.first, notes: p.notes });
/** The fresh copy is what a shell finds, or it finds nothing: no file, and nothing said. */
const ITSELF = { first: null, notes: [] };
/** Another file comes first: named as it is, and the one note built from it. */
const FIRST = (file: string) => ({ first: file, notes: [FOUND_FIRST(file)] });
/** The first and the last step: neither has a row, so neither has words for one. */
const FETCH: Step = { do: "fetch", version: NEW, touches: [] };
const PROVE: Step = { do: "prove", touches: [] };
/** What the "switch" row says where agents are hooked and there is a service to move. */
const SERVED = "the hooks and the background service to it";
/** What keeps a run safe: said of every plan that does something. */
const SAFE = "Nothing is touched until 1.2.0 has downloaded. A failed install is undone.";
/** And what restarts, where something runs in the background. */
const SERVICE_RESTARTS = "The service keeps its environment and restarts once it holds nothing.";
const DAEMON_RESTARTS = "The daemon restarts once it holds nothing.";

describe("slotIn: the package folder a prefix holds sessionpipe in", () => {
  it("is lib/node_modules/sessionpipe, and node_modules\\sessionpipe on Windows", () => {
    expect(slotIn(LOCAL, "linux")).toBe(path.join(LOCAL, "lib", "node_modules", "sessionpipe"));
    expect(slotIn(LOCAL, "darwin")).toBe(path.join(LOCAL, "lib", "node_modules", "sessionpipe"));
    expect(slotIn(LOCAL, "win32")).toBe(path.join(LOCAL, "node_modules", "sessionpipe"));
  });
});

describe("nothing to repair", () => {
  it("one clean copy of the newest release, typed, hooked and served: one sentence and no step", () => {
    expect(plan(inv(), facts())).toEqual({
      nothing: NOTHING,
      refuse: null,
      target: NEW,
      home: home(),
      steps: [],
      safety: [],
      left: [],
      notes: [],
      first: null,
    });
    // The same with npm's layout on Windows.
    expect(plan(inv({ platform: "win32" }), facts()).nothing).toBe(NOTHING);
  });

  it("what is no install of it is left and said, with no step; one that is typed is named in a note, and it is not 'nothing to repair'", () => {
    const checkout = copy(path.join(HOME, "code"), {
      where: "~/code/lib/node_modules/sessionpipe",
      version: "9.9.9",
      slot: null,
      not: "it holds src, which no published sessionpipe has (a checkout or a build?)",
    });
    const kept = copy(path.join(HOME, ".volta", "tools", "image", "packages", "sessionpipe"), {
      where: "~/.volta/tools/image/packages/sessionpipe",
      slot: null,
      not: "Volta keeps it",
      keeper: "volta uninstall sessionpipe",
    });
    const script = path.join(HOME, "bin", "sessionpipe");
    const p = plan(
      inv({
        copies: [checkout, one(), kept],
        strangers: [{ file: script, why: "a file of that name that npm didn't put there" }],
        // A file of the name that leads to no install is on PATH too, ahead of this copy,
        // and is not a second copy.
        ...shell([
          { file: script, dir: null },
          { file: bin(LOCAL), dir: slotIn(LOCAL, "linux") },
        ]),
      }),
      facts(),
    );
    // That file is what a shell finds first: the note beside the sentence says so, the
    // sentence no longer says "nothing to repair", and there is no step: it is not ours to move.
    expect(p.nothing).toBe(ONE_COPY);
    expect(p.nothing).not.toContain("Nothing to repair");
    expect(p.refuse).toBeNull();
    expect(p.steps).toEqual([]);
    expect(p.safety).toEqual([]);
    expect(finds(p)).toEqual(FIRST(script));
    expect(p.left).toEqual([
      {
        where: "~/code/lib/node_modules/sessionpipe",
        path: checkout.dir,
        version: "9.9.9",
        why: "it holds src, which no published sessionpipe has (a checkout or a build?)",
        line: null,
        ours: false,
      },
      {
        where: "~/.volta/tools/image/packages/sessionpipe",
        path: kept.dir,
        version: NEW,
        why: "Volta keeps it",
        line: "volta uninstall sessionpipe",
        ours: false,
      },
      {
        where: script,
        path: script,
        version: null,
        why: "a file of that name that npm didn't put there",
        line: null,
        ours: false,
      },
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
    const byHand = plan(unserved, facts({ service: null, daemon: { pid: 222, version: NEW } }));
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

  it("the copy's bin folder not being on PATH is said beside it", () => {
    const p = plan(inv({ ...shell([]) }), facts());
    expect(p.nothing).toBe(ONE_COPY);
    expect(p.notes).toEqual([NOT_ON_PATH(path.join(LOCAL, "bin"))]);
    // On PATH with nothing in it yet, there is nothing to say: nothing to repair.
    const empty = plan(inv({ ...shell([EMPTY]) }), facts());
    expect(empty.notes).toEqual([]);
    expect(empty.nothing).toBe(NOTHING);
    // On Windows npm's shims sit in the prefix itself.
    const w = plan(inv({ platform: "win32", ...shell([], {}, "win32") }), facts());
    expect(w.nothing).toBe(ONE_COPY);
    expect(w.notes).toEqual([NOT_ON_PATH(LOCAL)]);
    // The folder named is the one the look gives for the command, whatever the prefix:
    // the real one where `<prefix>/bin` is a link to another.
    const real = path.join(ROOT, "real-bin");
    expect(plan(inv({ ...shell([], { bin: real }) }), facts()).notes).toEqual([NOT_ON_PATH(real)]);
  });

  it("what was found beside the one copy is a row of what is left: what is no install, then npm's cache entry", () => {
    const entry = cached({ uses: ["this"] });
    const checkout = copy(path.join(HOME, "code"), { where: "~/code", slot: null, not: "it holds src" });
    const script = path.join(HOME, "bin", "sessionpipe");
    const strangers = [{ file: script, why: "a file of that name that npm didn't put there" }];
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
    const aFile = { where: script, path: script, version: null, why: strangers[0]?.why, line: null, ours: false };
    // "Found 2 copies" above the sentence is then no contradiction of it: the second is
    // listed, as npm's own cache, and is no copy this command would have removed.
    expect(beside({ copies: [entry, one()] })).toEqual({ nothing: NOTHING, left: [inCache], notes: [] });
    // One nothing uses at all, the same.
    expect(beside({ copies: [one(), cached()] })).toEqual({ nothing: NOTHING, left: [inCache], notes: [] });
    expect(beside({ copies: [one(), checkout] })).toEqual({ nothing: NOTHING, left: [noInstall], notes: [] });
    expect(beside({ strangers })).toEqual({ nothing: NOTHING, left: [aFile], notes: [] });
    // All of them: what is no install first, as in every plan, then the cache.
    expect(beside({ copies: [checkout, one(), entry], strangers })).toEqual({
      nothing: NOTHING,
      left: [noInstall, aFile, inCache],
      notes: [],
    });
    // A row of what is left is no note: it is still "nothing to repair". Alone, the one
    // copy is all there is to say.
    expect(beside({})).toEqual({ nothing: NOTHING, left: [], notes: [] });
    // Where npm couldn't be asked, the rows are the same beside the note that says so.
    expect(beside({ copies: [one(), checkout, entry] }, { latest: { error: OFFLINE } })).toEqual({
      nothing: UNASKED(NEW),
      left: [noInstall, inCache],
      notes: [NPM_UNASKED(NEW)],
    });
  });

  it("what else a shell finds behind this copy is nothing to say; ahead of it, it is what is typed: said, and no step", () => {
    const checkout = copy(path.join(HOME, "code"), {
      where: "~/code/lib/node_modules/sessionpipe",
      slot: null,
      not: "it holds src, which no published sessionpipe has (a checkout or a build?)",
    });
    const mine = { file: bin(LOCAL), dir: slotIn(LOCAL, "linux") };
    const theirs = { file: bin(path.join(HOME, "code")), dir: checkout.dir };
    // After this copy on PATH, a folder that is left alone is in nobody's way: no repair
    // (none could change it), and nothing to say.
    const after = plan(inv({ copies: [one(), checkout], ...shell([mine, theirs]) }), facts());
    expect(after.nothing).toBe(NOTHING);
    expect(finds(after)).toEqual(ITSELF);
    // Before it, it is what typing `sessionpipe` starts: no step could change that, and
    // the sentence no longer says "nothing to repair".
    const before = plan(inv({ copies: [checkout, one()], ...shell([theirs, mine]) }), facts());
    expect(before.nothing).toBe(ONE_COPY);
    expect(before.steps).toEqual([]);
    expect(finds(before)).toEqual(FIRST(theirs.file));
    // The same on Windows, where the shim sits in the prefix itself.
    const shim = { file: bin(path.join(HOME, "code"), "win32"), dir: checkout.dir };
    const w = plan(
      inv({
        platform: "win32",
        copies: [checkout, one({}, "win32")],
        ...shell([shim, { file: bin(LOCAL, "win32"), dir: slotIn(LOCAL, "win32") }], {}, "win32"),
      }),
      facts(),
    );
    expect(w.nothing).toBe(ONE_COPY);
    expect(finds(w)).toEqual(FIRST(shim.file));
  });

  it("the note about what is typed: as the caller shows the path, before what is said of npm, with the rows of what is left", () => {
    const script = path.join(HOME, "bin", "sessionpipe");
    const folders = [
      { file: script, dir: null },
      { file: bin(LOCAL), dir: slotIn(LOCAL, "linux") },
    ];
    const typed = shell(folders);
    const whole = plan(inv({ ...typed }), facts());
    expect(whole.nothing).toBe(ONE_COPY);
    expect(whole.notes).toEqual([FOUND_FIRST(script)]);
    expect(whole.steps).toEqual([]);
    expect(whole.target).toBe(NEW);
    // The path is said as a sentence says one; the file itself stays whole beside it. The
    // sentence names no path at all.
    const shown = plan(inv({ ...typed }), facts(), (p) => `<${p}>`);
    expect(shown.nothing).toBe(ONE_COPY);
    expect(shown.notes).toEqual([FOUND_FIRST(`<${script}>`)]);
    expect(shown.first).toBe(script);
    // The home it names is the look's own word for it, whatever that is.
    const elsewhere = plan(inv({ ...shell(folders, { shown: "~/.npm-global" }) }), facts());
    expect(elsewhere.notes).toEqual([FOUND_FIRST(script, "~/.npm-global")]);
    // Offline, what is said of npm comes after it, and the sentence calls nothing the newest.
    const offline = plan(inv({ ...typed }), facts({ latest: { error: OFFLINE } }));
    expect(offline.nothing).toBe(UNASKED(NEW));
    expect(offline.notes).toEqual([FOUND_FIRST(script), NPM_UNASKED(NEW)]);
    // And what else was found is listed as left, as beside "Nothing to repair".
    const strangers = [{ file: script, why: "a file of that name that npm didn't put there" }];
    const more = plan(inv({ copies: [cached({ uses: ["this"] }), one()], strangers, ...typed }), facts());
    expect(more.nothing).toBe(ONE_COPY);
    expect(more.left.map((l) => [l.where, l.why])).toEqual([
      [script, "a file of that name that npm didn't put there"],
      ["~/.npm/_npx/0a1b2c3d4e5f6a7b", NPX_CACHE],
    ]);
    // With this copy what a shell finds, it is "Nothing to repair" as ever.
    expect(plan(inv({ strangers }), facts()).nothing).toBe(NOTHING);
  });

  it("offline, one clean copy is still no repair: a note says npm wasn't asked, and nothing is called the newest release", () => {
    const latest = { error: OFFLINE };
    expect(plan(inv(), facts({ latest }))).toEqual({
      nothing: "One sessionpipe on this computer: 1.2.0.",
      refuse: null,
      target: NEW,
      home: home(),
      steps: [],
      safety: [],
      left: [],
      notes: [
        "npm couldn't be asked whether 1.2.0 is the newest release: registry.npmjs.org can't be reached (ENOTFOUND).",
      ],
      first: null,
    });
    // Whatever release that copy is: with nothing to compare it to, the hooks and the
    // daemon are held to the copy's own.
    const older = plan(
      inv({ copies: [one({ version: OLD })] }),
      facts({ latest, hooks: { version: OLD, wrong: [] }, daemon: { pid: 100, version: OLD } }),
    );
    expect(older.nothing).toBe(UNASKED(OLD));
    expect(older.notes).toEqual([NPM_UNASKED(OLD)]);
    expect(older.target).toBe(OLD);
    // Why it couldn't be asked is npm's own word, whatever it is; it comes after every other note.
    const both = plan(
      inv({ ...shell([]) }),
      facts({ latest: { error: "npm error code E503" }, service: null, daemon: null }),
    );
    expect(both.nothing).toBe(UNASKED(NEW));
    expect(both.notes).toEqual([
      NOT_ON_PATH(path.join(LOCAL, "bin")),
      NOTHING_STARTS_IT,
      NPM_UNASKED(NEW, "npm error code E503"),
    ]);
    // Never "nothing to repair" there: that is said only of the newest release.
    for (const p of [older, both]) expect(p.nothing).not.toMatch(/Nothing to repair|newest/);
  });
});

describe("each thing that makes it a repair, by itself", () => {
  const second = copy(BREW, { where: "/opt/homebrew", version: OLD });
  const away = copy(NVM, { where: "~/.nvm/versions/node/v22.1.0", uses: ["typed", "service", "hooks", "this"] });
  const cases: [string, Partial<Inventory>, Partial<Facts>, string[]][] = [
    ["a second copy", { copies: [one(), second] }, {}, ["fetch", "install", "use", `remove ${second.dir}`, "prove"]],
    [
      "the one copy is not where the fresh one goes",
      { copies: [away], ...shell([{ file: bin(NVM), dir: away.dir }, EMPTY]) },
      {},
      ["fetch", "install", "use", `remove ${away.dir}`, "prove"],
    ],
    [
      "a copy that doesn't run",
      { copies: [one({ runs: false, wrong: "it doesn't run: `--version` printed nothing" })] },
      {},
      REPAIR,
    ],
    // It runs by its path, and nothing a person types starts it.
    ["a copy whose link is gone", { copies: [one({ bins: [], wrong: "npm's link to it is gone" })] }, {}, REPAIR],
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
    ["a service file, and nothing that needs the service", {}, { wanted: false }, REPAIR],
    ["a service that is not loaded", {}, { service: service({ loaded: false }) }, REPAIR],
    ["a service file that names a node that is gone", {}, { service: service({ nodeOk: false }) }, REPAIR],
    ["a service that runs another copy", { copies: [one({ uses: ["typed", "hooks", "this"] })] }, {}, REPAIR],
    ["a service that is loaded, and nothing answers", {}, { daemon: null }, REPAIR],
    ["a service whose daemon is another release", {}, { daemon: { pid: 100, version: OLD } }, REPAIR],
    [
      "a service file, and a daemon someone started by hand",
      {},
      { daemon: { pid: 222, version: NEW } },
      ["fetch", "install", "stop", "use", "prove"],
    ],
    [
      "no service file, and a daemon someone runs by hand on another release",
      { copies: [one({ uses: ["typed", "hooks", "this"] })] },
      { service: null, daemon: { pid: 222, version: OLD } },
      REPAIR,
    ],
  ];
  it.each(cases)("%s", (_name, i, f, steps) => {
    const given = inv(i);
    const p = plan(given, facts(f));
    expect(p.nothing).toBeNull();
    expect(p.refuse).toBeNull();
    expect(p.target).toBe(NEW);
    expect(p.home).toBe(given.homes[0]);
    expect(p.home?.prefix).toBe(LOCAL);
    expect(does(p)).toEqual(steps);
    // Whatever the repair is, the first thing said of how it is kept safe is the same.
    expect(p.safety[0]).toBe(SAFE);
  });
});

describe("it refuses, and changes nothing", () => {
  /** Something to repair: a second copy. */
  const two = (over: Partial<Inventory> = {}) =>
    inv({ copies: [one(), copy(BREW, { where: "/opt/homebrew", version: OLD })], ...over });
  const refused = (p: Plan) => {
    expect(p.nothing).toBeNull();
    expect(p.steps).toEqual([]);
    // Nothing is done, so there is nothing to say of how it is kept safe.
    expect(p.safety).toEqual([]);
    expect(p.target).toBeNull();
    expect(p.home).toBeNull();
    return p.refuse;
  };

  it("a sessionpipe that keeps its files apart, in this account's own home, touches no copy", () => {
    const apart = {
      said: "This sessionpipe keeps its files in /tmp/world, not in this computer's usual place (~/.local/state/sessionpipe)",
      line: "env -u SESSIONPIPE_STATE -u SESSIONPIPE_CONFIG sessionpipe reinstall",
    };
    const script = {
      file: path.join(HOME, "bin", "sessionpipe"),
      why: "a file of that name that npm didn't put there",
    };
    // Whatever was found, a file that is no install first on PATH too: nothing is listed
    // as left, nothing is said beside it.
    expect(
      plan(
        two({
          reach: null,
          strangers: [script],
          // The home's bin folder is not on PATH, and that file is all a shell finds.
          ...shell([{ file: script.file, dir: null }]),
        }),
        facts({ apart }),
      ),
    ).toEqual({
      nothing: null,
      refuse: {
        error:
          "This sessionpipe keeps its files in /tmp/world, not in this computer's usual place (~/.local/state/sessionpipe), so it leaves this computer's copies alone. Nothing was changed",
        next: "env -u SESSIONPIPE_STATE -u SESSIONPIPE_CONFIG sessionpipe reinstall",
      },
      target: null,
      home: null,
      steps: [],
      safety: [],
      left: [],
      notes: [],
      first: null,
    });
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
    const script = {
      file: path.join(HOME, "bin", "sessionpipe"),
      why: "a file of that name that npm didn't put there",
    };
    const offline = facts({ latest: { error: "registry.npmjs.org can't be reached (ECONNREFUSED)" }, npm: false });
    const p = plan(two({ strangers: [script], ...shell([]) }), offline);
    expect(refused(p)).toEqual({
      error:
        "npm couldn't be asked for the newest release (registry.npmjs.org can't be reached (ECONNREFUSED)), and a fresh copy comes from npm. Nothing was changed",
      next: "sessionpipe reinstall",
    });
    // What is left alone and what is said beside the plan are said all the same.
    expect(p.left).toEqual([
      { where: script.file, path: script.file, version: null, why: script.why, line: null, ours: false },
    ]);
    expect(finds(p)).toEqual({ first: null, notes: [NOT_ON_PATH(path.join(LOCAL, "bin"))] });
    // And what a shell finds first, where that is not this copy: on every refusal that
    // comes after the look at PATH.
    const typed = shell([
      { file: script.file, dir: null },
      { file: bin(LOCAL), dir: slotIn(LOCAL, "linux") },
    ]);
    expect(finds(plan(two({ strangers: [script], ...typed }), offline))).toEqual(FIRST(script.file));
    expect(finds(plan(two({ strangers: [script], ...typed }), facts({ npm: false })))).toEqual(FIRST(script.file));
    const ahead = plan(two({ strangers: [script], ...typed }), facts({ hooks: { version: "9.9.9", wrong: [] } }));
    expect(ahead.refuse?.next).toBe("sessionpipe doctor");
    expect(finds(ahead)).toEqual(FIRST(script.file));
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
    expect(refused(plan(inv({ copies: [one({ version: "1.3.0-rc.1" })], homes: [] }), facts()))).toEqual(
      ahead("1.3.0-rc.1"),
    );
    // The hooks; a broken copy that says no version is passed over on the way to them.
    const broken = one({
      version: null,
      runs: false,
      wrong: "its dist/cli.js is missing (an install that was cut off?)",
    });
    expect(refused(plan(inv({ copies: [broken] }), facts({ hooks: { version: "1.2.1", wrong: [] } })))).toEqual(
      ahead("1.2.1"),
    );
    // The daemon, with a service file and without one.
    expect(refused(plan(two(), facts({ daemon: { pid: 100, version: "2.0.0" } })))).toEqual(ahead("2.0.0"));
    expect(refused(plan(two(), facts({ service: null, daemon: { pid: 222, version: "2.0.0" } })))).toEqual(
      ahead("2.0.0"),
    );
    // The first found is the one named: copies, then the hooks, then the daemon.
    expect(
      refused(
        plan(
          two({ copies: [one(), copy(BREW, { version: "1.4.0" })] }),
          facts({ hooks: { version: "1.5.0", wrong: [] }, daemon: { pid: 100, version: "1.6.0" } }),
        ),
      ),
    ).toEqual(ahead("1.4.0"));
  });

  it("a newer folder that is no install of it (a checkout) stands in nobody's way", () => {
    const checkout = copy(path.join(HOME, "code"), {
      version: "9.9.9",
      slot: null,
      not: "it holds src, which no published sessionpipe has (a checkout or a build?)",
    });
    const p = plan(two({ copies: [one(), copy(BREW, { version: OLD }), checkout] }), facts());
    expect(p.refuse).toBeNull();
    expect(does(p)).toEqual(["fetch", "install", "use", `remove ${slotIn(BREW, "linux")}`, "prove"]);
  });

  it("no folder this user may write can hold a fresh copy", () => {
    const sys = copy(USR, { where: "/usr/local", writable: false, uses: ["typed", "service", "hooks", "this"] });
    const p = plan(
      inv({ copies: [sys], onPath: shell([{ file: bin(USR), dir: sys.dir }]).onPath, homes: [] }),
      facts(),
    );
    expect(refused(p)).toEqual({
      error: "no folder on this computer that you may write can hold a fresh copy. Nothing was changed",
      next: "sessionpipe doctor",
    });
    // With no home there is no bin folder to say anything of, and no copy to be found first.
    expect(finds(p)).toEqual(ITSELF);
    expect(p.left).toEqual([]);
  });

  /** What it says of a file that is not npm's link, where npm's link goes. */
  const inTheWay = (file: string) =>
    `${file} is not sessionpipe's, and it is where the fresh copy's link goes: npm won't write over it. Nothing was changed. Move it aside, then run this again`;

  it("a file that is not npm's link sits where the fresh copy's link goes: refused, with the line that moves it", () => {
    // The paths are written out: they are only said and quoted, as any computer would have them.
    const at = (file: string, platform: NodeJS.Platform = "linux") =>
      plan(inv({ platform, ...shell([EMPTY], { blocked: file }, platform) }), facts());
    const plain = "/home/u/.local/bin/sessionpipe";
    expect(refused(at(plain))).toEqual({
      error: inTheWay(plain),
      next: "mv /home/u/.local/bin/sessionpipe /home/u/.local/bin/sessionpipe.old",
    });
    // A path a shell would split or act on is one word of the line, each time.
    const spaced = "/home/my name/.local/bin/sessionpipe";
    expect(refused(at(spaced))).toEqual({
      error: inTheWay(spaced),
      next: "mv '/home/my name/.local/bin/sessionpipe' '/home/my name/.local/bin/sessionpipe.old'",
    });
    expect(refused(at("/home/it's me/bin/sessionpipe"))?.next).toBe(
      "mv '/home/it'\\''s me/bin/sessionpipe' '/home/it'\\''s me/bin/sessionpipe.old'",
    );
    // On Windows the shim is moved with cmd's and PowerShell's own word, in their quotes.
    const shim = "C:\\Users\\u\\AppData\\Roaming\\npm\\sessionpipe.cmd";
    expect(refused(at(shim, "win32"))).toEqual({
      error: inTheWay(shim),
      next: 'move "C:\\Users\\u\\AppData\\Roaming\\npm\\sessionpipe.cmd" "C:\\Users\\u\\AppData\\Roaming\\npm\\sessionpipe.cmd.old"',
    });
    const named = "C:\\Users\\My Name\\AppData\\Roaming\\npm\\sessionpipe.ps1";
    expect(refused(at(named, "win32"))?.next).toBe(
      'move "C:\\Users\\My Name\\AppData\\Roaming\\npm\\sessionpipe.ps1" "C:\\Users\\My Name\\AppData\\Roaming\\npm\\sessionpipe.ps1.old"',
    );
    // The sentence names the file as the caller shows a path; the line to paste never does.
    const shown = plan(inv({ ...shell([EMPTY], { blocked: spaced }) }), facts(), (p) => `<${p}>`);
    expect(shown.refuse).toEqual({
      error: inTheWay(`<${spaced}>`),
      next: "mv '/home/my name/.local/bin/sessionpipe' '/home/my name/.local/bin/sessionpipe.old'",
    });
  });

  it("it is refused whatever else is so: with one clean copy, with something to repair, and before every other refusal but one", () => {
    // The file is what a shell finds in the home's own bin folder, and is listed as left.
    const file = bin(LOCAL);
    const strangers = [{ file, why: "a file of that name that npm didn't put there" }];
    const blocked = shell([{ file, dir: null }], { blocked: file });
    const carried = (p: Plan) => {
      expect(refused(p)?.error).toBe(inTheWay(file));
      expect(refused(p)?.next).toMatch(/^mv \S.* \S.*\.old'?$/);
      // What is left, what is said beside it and what is typed are carried as found.
      expect(p.left).toEqual([
        { where: file, path: file, version: null, why: strangers[0]?.why, line: null, ours: false },
      ]);
      expect(finds(p)).toEqual(FIRST(file));
    };
    // One clean copy otherwise: it is not "nothing to repair" while that file is typed.
    carried(plan(inv({ copies: [one({ uses: ["service", "hooks", "this"] })], strangers, ...blocked }), facts()));
    // Something to repair: no step is planned, not even the fetch.
    carried(plan(two({ strangers, ...blocked }), facts()));
    // npm out of reach, no npm, something newer here: this comes first, and is the one thing said.
    carried(plan(two({ strangers, ...blocked }), facts({ latest: { error: "ENOTFOUND" } })));
    carried(plan(two({ strangers, ...blocked }), facts({ npm: false })));
    carried(plan(two({ strangers, ...blocked }), facts({ hooks: { version: "9.9.9", wrong: [] } })));
    // Another folder that could hold a copy is no answer: the copy would land where nobody types it.
    const spare = home({
      prefix: BREW,
      shown: "/opt/homebrew",
      why: "where another copy of it already is",
      bin: binOf(BREW),
      pathAt: 1,
    });
    const second = plan(two({ strangers, onPath: blocked.onPath, homes: [...blocked.homes, spare] }), facts());
    carried(second);
    expect(second.home).toBeNull();
    // A home with nothing in the way is used as ever, whatever a later one has there.
    const later = plan(two({ homes: [home(), { ...spare, blocked: bin(BREW) }] }), facts());
    expect(later.refuse).toBeNull();
    expect(step(later, "install").prefix).toBe(LOCAL);
    // Only a sessionpipe that keeps its files apart is told that first: it touches no copy at all.
    const apart = { said: "This sessionpipe keeps its files in /tmp/world", line: "sessionpipe reinstall" };
    expect(plan(two({ reach: null, strangers, ...blocked }), facts({ apart })).refuse?.next).toBe(
      "sessionpipe reinstall",
    );
    // On Windows the same, with its own word for the move.
    const shim = bin(LOCAL, "win32");
    const w = plan(
      inv({
        platform: "win32",
        copies: [one({}, "win32")],
        ...shell([{ file: shim, dir: null }], { blocked: shim }, "win32"),
      }),
      facts(),
    );
    expect(refused(w)?.error).toBe(inTheWay(shim));
    expect(refused(w)?.next).toMatch(/^move \S.* \S.*\.cmd\.old"?$/);
    expect(finds(w)).toEqual(FIRST(shim));
  });
});

describe("the steps, in the order they are taken", () => {
  it("several copies: fetched, installed where the typed one is, put to use, the rest removed, then proven", () => {
    const typed = one({ version: OLD, uses: ["typed"] });
    const served = copy(NVM, { where: "~/.nvm/versions/node/v22.1.0", version: OLD, uses: ["service", "hooks"] });
    const mine = cached({ uses: ["this"] });
    const spare = copy(BREW, { where: "/opt/homebrew", version: "1.0.0" });
    const cut = leftover(LOCAL, { where: "~/.local", version: null });
    const checkout = copy(path.join(HOME, "code"), {
      where: "~/code/lib/node_modules/sessionpipe",
      slot: null,
      not: "it holds src, which no published sessionpipe has (a checkout or a build?)",
    });
    const script = path.join(HOME, "bin", "sessionpipe");
    const p = plan(
      inv({
        copies: [mine, served, typed, spare, cut, checkout],
        dangling: [bin(USR)],
        strangers: [{ file: script, why: "a file of that name that npm didn't put there" }],
        ...shell([
          { file: bin(LOCAL), dir: typed.dir },
          { file: bin(NVM), dir: served.dir },
          { file: script, dir: null },
        ]),
      }),
      facts({ hooks: { version: OLD, wrong: [] }, daemon: { pid: 100, version: OLD } }),
    );
    expect(p).toEqual({
      nothing: null,
      refuse: null,
      target: NEW,
      home: home(),
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
        {
          where: "~/code/lib/node_modules/sessionpipe",
          path: checkout.dir,
          version: NEW,
          why: "it holds src, which no published sessionpipe has (a checkout or a build?)",
          line: null,
          ours: false,
        },
        {
          where: script,
          path: script,
          version: null,
          why: "a file of that name that npm didn't put there",
          line: null,
          ours: false,
        },
      ],
      notes: [],
      first: null,
    });
  });

  it("removals go by use, whatever order the copies were found in: leftovers, unused, in use, this command's own", () => {
    const a = copy(path.join(ROOT, "a"), { uses: ["this", "typed"] });
    const b = copy(path.join(ROOT, "b"), { uses: ["hooks"] });
    const c = copy(path.join(ROOT, "c"));
    const d = leftover(path.join(ROOT, "d"));
    const e = copy(path.join(ROOT, "e"), { uses: ["service"] });
    const f = copy(path.join(ROOT, "f"));
    // A leftover the service file happens to name is in use, and waits its turn.
    const g = leftover(path.join(ROOT, "g"), { uses: ["service"] });
    const removed = (copies: Copy[]) =>
      does(plan(inv({ copies }), facts()))
        .filter((s) => s.startsWith("remove "))
        .map((s) => path.basename(path.dirname(path.dirname(path.dirname(s.slice("remove ".length))))));
    expect(removed([a, b, c, d, e, f, g])).toEqual(["d", "c", "f", "b", "e", "g", "a"]);
    expect(removed([g, f, e, d, c, b, a])).toEqual(["d", "f", "c", "g", "e", "b", "a"]);
    // The copy in the home's own slot is replaced by the install, never removed after it.
    expect(removed([a, one({ version: OLD }), d])).toEqual(["d", "a"]);
  });

  it("a broken copy where the fresh one goes is replaced, and the row says so; what is wrong with it is the table's to say", () => {
    const install = (c: Copy) => step(plan(inv({ copies: [c] }), facts()), "install");
    const cut = {
      version: null,
      runs: false,
      wrong: "its dist/cli.js is missing (an install that was cut off?)",
    };
    expect(install(one(cut))).toEqual({
      do: "install",
      version: NEW,
      prefix: LOCAL,
      dir: slotIn(LOCAL, "linux"),
      replaces: true,
      touches: [slotIn(LOCAL, "linux"), bin(LOCAL)],
      // It says no release of its own: it is named as what it is.
      say: "1.2.0, the newest release, fresh in ~/.local (replaces the broken copy)",
    });
    // One that says its release and doesn't run is named by the release.
    const silent = one({ runs: false, wrong: "it doesn't run: `--version` printed nothing" });
    expect(install(silent).say).toBe("1.2.0, the newest release, fresh in ~/.local (replaces 1.2.0)");
    // Neither row repeats what is wrong: that is on the copy's own row of what was found.
    for (const c of [one(cut), silent]) expect(install(c).say).not.toContain(c.wrong as string);
    // The same copy anywhere else is removed, and named the same way.
    const p = plan(inv({ copies: [one(), copy(BREW, { where: "/opt/homebrew", bins: [], ...cut })] }), facts());
    expect(p.steps.find((s) => s.do === "remove")).toEqual({
      do: "remove",
      path: slotIn(BREW, "linux"),
      touches: [slotIn(BREW, "linux")],
      say: "the broken copy in /opt/homebrew",
    });
  });

  it("an empty slot is installed into, with nothing to take out; the home is the first one offered", () => {
    const away = copy(NVM, { where: "~/.nvm/versions/node/v22.1.0", uses: ["typed", "this"] });
    const p = plan(
      inv({
        copies: [away],
        onPath: shell([{ file: bin(NVM), dir: away.dir }]).onPath,
        homes: [
          // Its bin folder is on PATH, after the copy's that is typed now.
          home({
            prefix: BREW,
            shown: "/opt/homebrew",
            why: "npm's global folder",
            bin: binOf(BREW),
            pathAt: 1,
          }),
          home({ pathAt: null }),
        ],
      }),
      facts(),
    );
    expect(p.home?.prefix).toBe(BREW);
    expect(step(p, "install")).toEqual({
      do: "install",
      version: NEW,
      prefix: BREW,
      dir: slotIn(BREW, "linux"),
      replaces: false,
      touches: [slotIn(BREW, "linux"), bin(BREW)],
      // No copy is there for the table to say anything of: why this folder is said here.
      say: "1.2.0, the newest release, fresh in /opt/homebrew (npm's global folder)",
    });
    expect(does(p)).toEqual(["fetch", "install", "use", `remove ${away.dir}`, "prove"]);
    // The reason is the look's own, whichever it gave for the home.
    const said = (why: string) =>
      step(plan(inv({ copies: [away], onPath: [], homes: [home({ why, pathAt: null })] }), facts()), "install").say;
    for (const why of ["a folder of your own", "where another copy of it already is", "where this command runs from"])
      expect(said(why)).toBe(`1.2.0, the newest release, fresh in ~/.local (${why})`);
    // A leftover beside an empty slot is no copy in it: the reason is still the home's.
    const beside = plan(
      inv({ copies: [away, leftover(LOCAL, { where: "~/.local" })], onPath: [], homes: [home({ pathAt: null })] }),
      facts(),
    );
    expect(step(beside, "install")).toMatchObject({
      replaces: false,
      say: "1.2.0, the newest release, fresh in ~/.local (where the one you type is)",
    });
  });

  it("a service file nothing needs is removed, and the fresh copy serves nothing", () => {
    const p = plan(inv(), facts({ wanted: false, daemon: null }));
    expect(does(p)).toEqual(["fetch", "install", "unserve", "use", "prove"]);
    expect(step(p, "unserve")).toEqual({
      do: "unserve",
      file: FILE,
      touches: [FILE],
      say: "the service file, which nothing here needs",
    });
    // The hooks alone are switched: the service file is no longer one of the files touched.
    expect(step(p, "use")).toEqual({ do: "use", serve: false, touches: HOOKS, say: "the hooks to it" });
    expect(p.notes).toEqual([]);
    // Nothing runs in the background afterwards, so nothing is said to restart.
    expect(p.safety).toEqual([SAFE]);
    // While a daemon still answers, the file stays and is made to run the fresh copy.
    const answered = plan(inv(), facts({ wanted: false }));
    expect(does(answered)).toEqual(REPAIR);
    expect(step(answered, "use")).toEqual({ do: "use", serve: true, touches: [...HOOKS, FILE], say: SERVED });
    expect(answered.safety).toEqual([SAFE, SERVICE_RESTARTS]);
  });

  it("two daemons: the one someone started by hand is stopped before the service is moved", () => {
    const p = plan(inv(), facts({ daemon: { pid: 222, version: OLD } }));
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
    // A manager that names no process while a daemon answers is the same state: the
    // service's own process leaves when it finds another daemon on the socket, so the
    // one that answers is not the service's.
    const unnamed = plan(inv({ copies: [one({ version: OLD })] }), facts({ service: service({ pid: null }) }));
    expect(does(unnamed)).toEqual(["fetch", "install", "stop", "use", "prove"]);
    expect(step(unnamed, "stop").pid).toBe(100);
    expect(step(unnamed, "stop").say).toBe("the daemon started by hand (pid 100), once it holds nothing");
    // Wanted or not: with a daemon in the way the file is not removed, the daemon is stopped.
    expect(does(plan(inv(), facts({ wanted: false, daemon: { pid: 222, version: NEW } })))).toEqual([
      "fetch",
      "install",
      "stop",
      "use",
      "prove",
    ]);
  });

  it("a daemon run by hand with no service file is asked to restart; with neither, nothing is started", () => {
    const unserved = inv({ copies: [one({ version: OLD, uses: ["typed", "hooks", "this"] })] });
    const byHand = plan(unserved, facts({ service: null, daemon: { pid: 222, version: OLD } }));
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
    expect(step(plan(old, facts({ harnesses: [], service: null, daemon: { pid: 222, version: OLD } })), "use")).toEqual(
      { do: "use", serve: true, touches: [], say: "the daemon that runs here to it" },
    );
    // Nothing to switch: the step is still taken (`update`'s own steps say what they
    // find), and the plan has no row for it.
    const bare = plan(old, facts({ harnesses: [], service: null, daemon: null }));
    expect(step(bare, "use")).toEqual({ do: "use", serve: false, touches: [], say: null });
    expect(does(bare)).toEqual(REPAIR);
    // A service file that is removed is nothing to switch to either.
    const unserved = plan(old, facts({ harnesses: [], wanted: false, daemon: null }));
    expect(does(unserved)).toEqual(["fetch", "install", "unserve", "use", "prove"]);
    expect(step(unserved, "use")).toEqual({ do: "use", serve: false, touches: [], say: null });
  });

  it("the switch row: the hooks where an agent is hooked, then what runs in the background where something does", () => {
    const old = inv({ copies: [one({ version: OLD })] });
    const switched = (f: Partial<Facts>) => step(plan(old, facts(f)), "use").say;
    const byHand = { pid: 222, version: OLD };
    // Hooked, with each thing that may run in the background.
    expect(switched({})).toBe("the hooks and the background service to it");
    expect(switched({ service: null, daemon: byHand })).toBe("the hooks and the daemon that runs here to it");
    expect(switched({ service: null, daemon: null })).toBe("the hooks to it");
    // A service file and a daemon someone started by hand: the service is what is switched
    // (the daemon has a row of its own, where it is stopped).
    expect(switched({ daemon: byHand })).toBe("the hooks and the background service to it");
    // A service file with nothing answering yet is started on the fresh copy.
    expect(switched({ daemon: null })).toBe("the hooks and the background service to it");
    // One that is removed is not switched.
    expect(switched({ wanted: false, daemon: null })).toBe("the hooks to it");
    // Nobody hooked.
    expect(switched({ harnesses: [] })).toBe("the background service to it");
    expect(switched({ harnesses: [], service: null, daemon: byHand })).toBe("the daemon that runs here to it");
    expect(switched({ harnesses: [], service: null, daemon: null })).toBeNull();
  });

  it("a copy where this user may not write stays, with the one line that removes it where there is one", () => {
    // The prefix goes into the line as one word of a command; nothing else is done with it.
    const sys = copy(USR, { where: "/usr/local", prefix: "/usr/local", version: OLD, writable: false });
    const spaced = copy(path.join(ROOT, "my node"), { where: "/opt/my node", prefix: "/opt/my node", writable: false });
    const inCache = cached({ writable: false });
    const cut = leftover(USR, { where: "/usr/local", version: null, writable: false });
    const spare = copy(BREW, { where: "/opt/homebrew" });
    const p = plan(inv({ copies: [one(), sys, spaced, inCache, cut, spare] }), facts());
    // What can be removed still is; nothing is planned for what can't.
    expect(does(p)).toEqual(["fetch", "install", "use", `remove ${spare.dir}`, "prove"]);
    const why = "you may not write where it is";
    expect(p.left).toEqual([
      // npm has no command for a folder it left behind itself, nor for a cache entry.
      // Each is named for a person, and by the whole folder that stays.
      { where: "/usr/local", path: cut.dir, version: null, why, line: null, ours: true },
      {
        where: "/usr/local",
        path: sys.dir,
        version: OLD,
        why,
        line: "sudo npm uninstall -g --prefix /usr/local sessionpipe",
        ours: true,
      },
      {
        where: "/opt/my node",
        path: spaced.dir,
        version: NEW,
        why,
        line: "sudo npm uninstall -g --prefix '/opt/my node' sessionpipe",
        ours: true,
      },
      { where: "~/.npm/_npx/0a1b2c3d4e5f6a7b", path: CACHED, version: NEW, why, line: null, ours: true },
    ]);
    // What is no install of it comes first in the list, and is not ours to count.
    const checkout = copy(path.join(HOME, "code"), { where: "~/code", slot: null, not: "it holds src" });
    const script = {
      file: path.join(HOME, "bin", "sessionpipe"),
      why: "a file of that name that npm didn't put there",
    };
    const mixed = plan(inv({ copies: [sys, one(), checkout], strangers: [script] }), facts());
    expect(mixed.left.map((l) => [l.where, l.path, l.ours])).toEqual([
      ["~/code", checkout.dir, false],
      [script.file, script.file, false],
      ["/usr/local", sys.dir, true],
    ]);
  });

  it("Windows: npm's layout there, and no sudo line for a copy that can't be written", () => {
    const sys = copy(USR, { where: "C:\\Program Files\\nodejs", version: OLD, writable: false }, "win32");
    const spare = copy(BREW, { where: "C:\\nvm\\v22.1.0", version: OLD }, "win32");
    const p = plan(
      inv({
        platform: "win32",
        copies: [one({ version: OLD }, "win32"), sys, spare],
        ...shell([], { shown: "~\\AppData\\Roaming\\npm" }, "win32"),
      }),
      facts(),
    );
    expect(step(p, "install")).toEqual({
      do: "install",
      version: NEW,
      prefix: LOCAL,
      dir: path.join(LOCAL, "node_modules", "sessionpipe"),
      replaces: true,
      touches: [path.join(LOCAL, "node_modules", "sessionpipe"), path.join(LOCAL, "sessionpipe.cmd")],
      say: "1.2.0, the newest release, fresh in ~\\AppData\\Roaming\\npm (replaces 1.1.0)",
    });
    expect(does(p)).toEqual(["fetch", "install", "use", `remove ${spare.dir}`, "prove"]);
    expect(p.steps.find((s) => s.do === "remove")?.touches).toEqual([spare.dir, path.join(BREW, "sessionpipe.cmd")]);
    expect(p.left).toEqual([
      {
        where: "C:\\Program Files\\nodejs",
        path: sys.dir,
        version: OLD,
        why: "you may not write where it is",
        line: null,
        ours: true,
      },
    ]);
    expect(p.notes).toEqual([NOT_ON_PATH(LOCAL)]);
  });

  it("a link that leads nowhere is removed, except the home's own, which the install writes again", () => {
    const stale = [bin(LOCAL), bin(USR), bin(NVM)];
    const p = plan(inv({ dangling: stale }), facts());
    expect(does(p)).toEqual(["fetch", "install", "use", `remove ${bin(USR)}`, `remove ${bin(NVM)}`, "prove"]);
    expect(step(p, "install").touches).toContain(bin(LOCAL));
    // The home's own alone is still a repair: the install is what puts it right.
    expect(does(plan(inv({ dangling: [bin(LOCAL)] }), facts()))).toEqual(REPAIR);
    // On Windows the shim sits in the prefix itself.
    const shims = [bin(LOCAL, "win32"), bin(USR, "win32")];
    const w = plan(inv({ platform: "win32", dangling: shims }), facts());
    expect(does(w)).toEqual(["fetch", "install", "use", `remove ${bin(USR, "win32")}`, "prove"]);
    expect(w.steps.find((s) => s.do === "remove")).toEqual({
      do: "remove",
      path: bin(USR, "win32"),
      touches: [bin(USR, "win32")],
      say: `${bin(USR, "win32")} (a link to a copy that is gone)`,
    });
    // The home's own is told by the folder the look gives for its command, not by a
    // name put together from the prefix: where `<prefix>/bin` is a link to another
    // folder, the link in that folder is the home's, and one in a folder that is only
    // called `<prefix>/bin` is not.
    const real = path.join(ROOT, "real-bin");
    const linked = plan(
      inv({ dangling: [path.join(real, "sessionpipe"), bin(LOCAL)], ...shell([EMPTY], { bin: real }) }),
      facts(),
    );
    expect(does(linked)).toEqual(["fetch", "install", "use", `remove ${bin(LOCAL)}`, "prove"]);
  });

  it("what is not this command's to repair is said beside the steps: a bin folder off PATH", () => {
    const p = plan(inv({ copies: [one({ version: OLD })], ...shell([]) }), facts());
    expect(does(p)).toEqual(REPAIR);
    expect(p.notes).toEqual([NOT_ON_PATH(path.join(LOCAL, "bin"))]);
    // Both, where both hold.
    const both = plan(
      inv({ copies: [one({ version: OLD, uses: ["this"] })], ...shell([]) }),
      facts({ service: null, daemon: null }),
    );
    expect(both.notes).toEqual([NOT_ON_PATH(path.join(LOCAL, "bin")), NOTHING_STARTS_IT]);
  });

  it("the first and the last step are always the same two, and neither has a row: the download is the safety line's to say, the check the run's", () => {
    for (const f of [{}, { harnesses: [] }, { service: null, daemon: null }, { wanted: false, daemon: null }]) {
      const p = plan(inv({ copies: [one({ version: OLD })] }), facts(f));
      expect(p.steps[0]).toEqual(FETCH);
      expect(p.steps.at(-1)).toEqual(PROVE);
    }
    expect(Object.keys(FETCH).sort()).toEqual(["do", "touches", "version"]);
    expect(Object.keys(PROVE).sort()).toEqual(["do", "touches"]);
    // What the download is for is said once, under the rows, with the release by its number.
    const p = plan(inv({ copies: [one({ version: OLD })] }), facts());
    expect(p.safety[0]).toBe("Nothing is touched until 1.2.0 has downloaded. A failed install is undone.");
    const next = plan(inv({ copies: [one({ version: OLD })] }), facts({ latest: { version: "1.2.1" } }));
    expect(next.safety[0]).toBe("Nothing is touched until 1.2.1 has downloaded. A failed install is undone.");
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
    expect(safe({ daemon: { pid: 222, version: OLD } })).toEqual([SAFE, SERVICE_RESTARTS]);
    // A daemon someone runs by hand, with no service file, is asked to restart onto it.
    expect(safe({ service: null, daemon: { pid: 222, version: OLD } })).toEqual([SAFE, DAEMON_RESTARTS]);
    // No service file and no daemon: nothing runs it in the background, and one line is all.
    expect(safe({ service: null, daemon: null })).toEqual([SAFE]);
    expect(safe({ harnesses: [], service: null, daemon: null })).toEqual([SAFE]);
    // A service file that is removed, with no daemon: the same.
    expect(safe({ wanted: false, daemon: null })).toEqual([SAFE]);
    // Never both: a service that is moved is the one thing said to restart.
    for (const f of [{}, { daemon: { pid: 222, version: OLD } }, { service: null, daemon: { pid: 222, version: OLD } }])
      expect(safe(f)).toHaveLength(2);
  });

  it("where nothing is done nothing is said of safety: nothing to repair, and every refusal", () => {
    const two = inv({ copies: [one(), copy(BREW, { where: "/opt/homebrew", version: OLD })] });
    const blocked = shell([EMPTY], { blocked: bin(LOCAL) });
    const apart = { said: "This sessionpipe keeps its files in /tmp/world", line: "sessionpipe reinstall" };
    for (const p of [
      plan(inv(), facts()),
      plan(inv({ ...shell([]) }), facts()),
      plan(inv(), facts({ latest: { error: OFFLINE } })),
      plan(inv({ ...two, reach: null }), facts({ apart })),
      plan(inv({ ...two, ...blocked }), facts()),
      plan(two, facts({ latest: { error: OFFLINE } })),
      plan(two, facts({ npm: false })),
      plan(two, facts({ hooks: { version: "9.9.9", wrong: [] } })),
      plan(inv({ ...two, homes: [] }), facts()),
    ]) {
      expect(p.steps).toEqual([]);
      expect(p.safety).toEqual([]);
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

  it("a copy by its release, a broken one as that, npm's leftover as a leftover folder", () => {
    expect(removed({ copies: [one(), copy(BREW, { where: "/opt/homebrew", version: OLD })] })).toBe(
      "1.1.0 in /opt/homebrew",
    );
    // The same release as the fresh copy is still named by it: the folder tells them apart.
    expect(removed({ copies: [one(), copy(NVM, { where: "~/.nvm/versions/node/v22.1.0" })] })).toBe(
      "1.2.0 in ~/.nvm/versions/node/v22.1.0",
    );
    expect(
      removed({
        copies: [
          one(),
          copy(BREW, { where: "/opt/homebrew", version: null, runs: false, wrong: "its package.json can't be read" }),
        ],
      }),
    ).toBe("the broken copy in /opt/homebrew");
    // One that says a release and doesn't run is named by the release: the table says the rest.
    expect(
      removed({
        copies: [one(), copy(BREW, { where: "/opt/homebrew", version: OLD, runs: false, wrong: "it doesn't run" })],
      }),
    ).toBe("1.1.0 in /opt/homebrew");
    // npm's leftover has no release worth naming, whatever its package.json says.
    expect(removed({ copies: [one(), leftover(BREW, { where: "/opt/homebrew" })] })).toBe(
      "a leftover folder in /opt/homebrew",
    );
    expect(removed({ copies: [one(), leftover(LOCAL, { where: "~/.local", version: null })] })).toBe(
      "a leftover folder in ~/.local",
    );
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
    expect(removed({ platform: "win32", dangling: [bin(USR, "win32")] }, show)).toBe(
      `<${bin(USR, "win32")}> (a link to a copy that is gone)`,
    );
  });

  it("a row says nothing of the link that goes with a copy: it is touched, and the run says it when it is gone", () => {
    const linked = plan(inv({ copies: [one(), copy(BREW, { where: "/opt/homebrew", version: OLD })] }), facts());
    const bare = plan(
      inv({ copies: [one(), copy(BREW, { where: "/opt/homebrew", version: OLD, bins: [] })] }),
      facts(),
    );
    const row = (p: Plan) => p.steps.find((s) => s.do === "remove") as Extract<Step, { do: "remove" }>;
    expect(row(linked).say).toBe(row(bare).say);
    expect(row(linked).touches).toEqual([slotIn(BREW, "linux"), bin(BREW)]);
    expect(row(bare).touches).toEqual([slotIn(BREW, "linux")]);
  });
});

describe("what a shell finds first, once every copy that goes is gone and the fresh one has its link", () => {
  const here = { file: bin(LOCAL), dir: slotIn(LOCAL, "linux") };
  /** A file named sessionpipe that leads to no install. */
  const script = path.join(HOME, "bin", "sessionpipe");
  const stranger = { file: script, dir: null };
  const old = copy(NVM, { where: "~/.nvm/versions/node/v22.1.0", version: OLD, uses: ["typed"] });
  const older = { file: bin(NVM), dir: old.dir };
  /** The home's copy, with something else on the computer to remove. */
  const mine = one({ uses: ["this"] });
  /** A folder that is no install of it, and its link. */
  const checkout = copy(path.join(HOME, "code"), { where: "~/code", slot: null, not: "it holds src" });
  const linked = { file: bin(path.join(HOME, "code")), dir: checkout.dir };

  it("a copy that is removed stands in nobody's way: the fresh one is what is found then", () => {
    // First on PATH now, and removed: this copy comes next.
    const p = plan(inv({ copies: [mine, old], ...shell([older, here]) }), facts());
    expect(does(p)).toContain(`remove ${old.dir}`);
    expect(finds(p)).toEqual(ITSELF);
    // The only one on PATH, ahead of the home's bin folder that has nothing in it yet.
    expect(finds(plan(inv({ copies: [old], ...shell([older, EMPTY]) }), facts()))).toEqual(ITSELF);
    // Nothing on PATH but that folder, and this copy first on it: nothing to say either.
    expect(finds(plan(inv({ copies: [one({ version: OLD })], ...shell([EMPTY]) }), facts()))).toEqual(ITSELF);
    expect(finds(plan(inv({ copies: [one({ version: OLD })], ...shell([here, older]) }), facts()))).toEqual(ITSELF);
    // Where the home's bin folder is not on PATH, that is what is said: the copy that
    // goes is still not what a shell finds afterwards.
    expect(finds(plan(inv({ copies: [mine, old], ...shell([older]) }), facts()))).toEqual({
      first: null,
      notes: [NOT_ON_PATH(path.join(LOCAL, "bin"))],
    });
  });

  it("a copy this user may not write stays, and is still what is typed: said, beside the line that removes it", () => {
    const sys = copy(USR, {
      where: "/usr/local",
      prefix: "/usr/local",
      version: OLD,
      writable: false,
      uses: ["typed"],
    });
    const theirs = { file: bin(USR), dir: sys.dir };
    const p = plan(inv({ copies: [mine, sys], ...shell([theirs, here]) }), facts());
    expect(does(p)).toEqual(REPAIR);
    expect(p.left).toEqual([
      {
        where: "/usr/local",
        path: sys.dir,
        version: OLD,
        why: "you may not write where it is",
        line: "sudo npm uninstall -g --prefix /usr/local sessionpipe",
        ours: true,
      },
    ]);
    expect(finds(p)).toEqual(FIRST(bin(USR)));
    // After this copy on PATH it stays the same way, and is in nobody's way.
    expect(finds(plan(inv({ copies: [mine, sys], ...shell([here, theirs]) }), facts()))).toEqual(ITSELF);
    // What is removed before it on PATH doesn't hide it: it is first once that is gone.
    expect(finds(plan(inv({ copies: [mine, old, sys], ...shell([older, theirs, here]) }), facts()))).toEqual(
      FIRST(bin(USR)),
    );
  });

  it("a folder that is no install of it (a checkout, the copy Volta keeps) stays first: said", () => {
    const kept = copy(path.join(HOME, ".volta"), {
      where: "~/.volta",
      slot: null,
      not: "Volta keeps it",
      keeper: "volta uninstall sessionpipe",
    });
    for (const c of [checkout, kept]) {
      const theirs = { file: bin(c.prefix as string), dir: c.dir };
      const p = plan(inv({ copies: [mine, old, c], ...shell([older, theirs, here]) }), facts());
      expect(does(p)).toEqual(["fetch", "install", "use", `remove ${old.dir}`, "prove"]);
      expect(finds(p)).toEqual(FIRST(theirs.file));
      expect(finds(plan(inv({ copies: [mine, old, c], ...shell([older, here, theirs]) }), facts()))).toEqual(ITSELF);
    }
  });

  it("a file of that name that npm didn't put there: said where it comes before this copy, not after", () => {
    const strangers = [{ file: script, why: "a file of that name that npm didn't put there" }];
    const first = plan(inv({ copies: [mine, old], strangers, ...shell([older, stranger, here]) }), facts());
    expect(finds(first)).toEqual(FIRST(script));
    const last = plan(inv({ copies: [mine, old], strangers, ...shell([older, here, stranger]) }), facts());
    expect(finds(last)).toEqual(ITSELF);
  });

  it("what stays in the home's own bin folder is found there, in place of the fresh copy: named as one ahead of it is", () => {
    // A checkout's link where the home's own link would be.
    const inPlace = { file: bin(LOCAL), dir: checkout.dir };
    const p = plan(inv({ copies: [checkout, old], ...shell([older, inPlace]) }), facts());
    expect(p.home?.pathAt).toBe(1);
    expect(finds(p)).toEqual(FIRST(bin(LOCAL)));
    // And a file there that leads to no folder at all.
    const file = { file: bin(LOCAL), dir: null };
    expect(finds(plan(inv({ copies: [mine, old], ...shell([older, file]) }), facts()))).toEqual(FIRST(bin(LOCAL)));
    // With one clean copy otherwise, the note says what is typed, and it is not "nothing to repair".
    const fine = plan(
      inv({ copies: [one({ uses: ["service", "hooks", "this"] }), checkout], ...shell([inPlace]) }),
      facts(),
    );
    expect(fine.nothing).toBe(ONE_COPY);
    expect(finds(fine)).toEqual(FIRST(bin(LOCAL)));
    // The home's own link there, to the home's own copy, is the fresh copy's: nothing to name.
    expect(finds(plan(inv({ copies: [mine, old], ...shell([older, here]) }), facts()))).toEqual(ITSELF);
    // One folder further on PATH is behind it.
    expect(finds(plan(inv({ copies: [checkout, old], ...shell([older, EMPTY, linked]) }), facts()))).toEqual(ITSELF);
  });

  it("behind the home's bin folder on PATH nothing is found first, though no copy is in that folder yet", () => {
    // The fresh copy's link goes into a folder a shell reads before the checkout's: said
    // before the install, "the checkout is found first" would be untrue after it.
    const p = plan(inv({ copies: [checkout, old], ...shell([EMPTY, linked, older]) }), facts());
    expect(does(p)).toEqual(["fetch", "install", "use", `remove ${old.dir}`, "prove"]);
    expect(step(p, "install").replaces).toBe(false);
    expect(finds(p)).toEqual(ITSELF);
    // The same folders the other way round: the checkout's link is read first, and is named.
    expect(finds(plan(inv({ copies: [checkout, old], ...shell([linked, EMPTY, older]) }), facts()))).toEqual(
      FIRST(linked.file),
    );
  });

  it("with the home's bin folder not on PATH, the first of what stays is what a shell finds: said after that", () => {
    // The same checkout's link, and no place on PATH for the fresh copy to come before it.
    const p = plan(inv({ copies: [checkout, old], ...shell([linked, older]) }), facts());
    expect(finds(p)).toEqual({
      first: linked.file,
      notes: [NOT_ON_PATH(path.join(LOCAL, "bin")), FOUND_FIRST(linked.file)],
    });
    // What goes is passed over there too, wherever it is.
    expect(finds(plan(inv({ copies: [checkout, old], ...shell([older, linked]) }), facts())).first).toBe(linked.file);
    expect(finds(plan(inv({ copies: [old], ...shell([older]) }), facts())).first).toBeNull();
  });

  it("of two that stay, one ahead of the home's bin folder and one behind it, the one ahead is named", () => {
    const strangers = [{ file: script, why: "a file of that name that npm didn't put there" }];
    const ahead = (folders: Parameters<typeof shell>[0]) =>
      finds(plan(inv({ copies: [mine, checkout], strangers, ...shell(folders) }), facts()));
    expect(ahead([stranger, here, linked])).toEqual(FIRST(script));
    expect(ahead([linked, here, stranger])).toEqual(FIRST(linked.file));
    // Both ahead: the first of them. Both behind: neither.
    expect(ahead([linked, stranger, here])).toEqual(FIRST(linked.file));
    expect(ahead([stranger, linked, here])).toEqual(FIRST(script));
    expect(ahead([here, stranger, linked])).toEqual(ITSELF);
  });

  it("a file that leads to no folder is compared with no folder, never with the one the command was run in", () => {
    // Run from inside the home's own package folder: a path that is empty resolves to
    // that folder, and the file that is no install would pass for the fresh copy.
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(slotIn(LOCAL, "linux"));
    try {
      expect(path.resolve("")).toBe(slotIn(LOCAL, "linux"));
      const p = plan(inv({ copies: [mine, old], ...shell([older, stranger, here]) }), facts());
      expect(finds(p)).toEqual(FIRST(script));
      // The same where there is nothing to repair.
      const fine = plan(inv({ ...shell([stranger, here]) }), facts());
      expect(fine.nothing).toBe(ONE_COPY);
      expect(finds(fine)).toEqual(FIRST(script));
    } finally {
      cwd.mockRestore();
    }
  });

  it("a link that leads nowhere is passed over: it goes, or is this copy's own and written again", () => {
    const gone = { file: bin(USR), dir: slotIn(USR, "linux") };
    // Another prefix's: removed, so what comes after it is what is found.
    const p = plan(inv({ dangling: [gone.file], ...shell([gone, here]) }), facts());
    expect(does(p)).toContain(`remove ${gone.file}`);
    expect(finds(p)).toEqual(ITSELF);
    expect(finds(plan(inv({ dangling: [gone.file], ...shell([gone, stranger, here]) }), facts()))).toEqual(
      FIRST(script),
    );
    // The home's own: the install writes it again, and it is this copy.
    expect(finds(plan(inv({ dangling: [here.file], ...shell([here, stranger]) }), facts()))).toEqual(ITSELF);
    // And with the home's bin folder not on PATH a link that goes is still not what is found.
    expect(finds(plan(inv({ dangling: [gone.file], ...shell([gone]) }), facts())).first).toBeNull();
  });

  it("it is said after a bin folder that is not on PATH, and before a service nothing starts", () => {
    const p = plan(
      inv({ copies: [one({ version: OLD, uses: ["this"] })], ...shell([stranger]) }),
      facts({ service: null, daemon: null }),
    );
    expect(finds(p)).toEqual({
      first: script,
      notes: [NOT_ON_PATH(path.join(LOCAL, "bin")), FOUND_FIRST(script), NOTHING_STARTS_IT],
    });
  });

  it("with no folder to install into there is no copy to speak of: nothing is said", () => {
    const sys = copy(USR, { where: "/usr/local", version: OLD, writable: false, uses: ["typed"] });
    const p = plan(
      inv({
        copies: [sys, old],
        onPath: shell([older, stranger, { file: bin(USR), dir: sys.dir }]).onPath,
        homes: [],
      }),
      facts(),
    );
    expect(p.refuse?.next).toBe("sessionpipe doctor");
    expect(finds(p)).toEqual(ITSELF);
  });

  it("on Windows the shims are compared the same way", () => {
    const sys = copy(USR, { where: "C:\\Program Files\\nodejs", version: OLD, writable: false }, "win32");
    const theirs = { file: bin(USR, "win32"), dir: sys.dir };
    const ours = { file: bin(LOCAL, "win32"), dir: slotIn(LOCAL, "win32") };
    const w = (folders: Parameters<typeof shell>[0]) =>
      finds(
        plan(
          inv({ platform: "win32", copies: [one({ uses: ["this"] }, "win32"), sys], ...shell(folders, {}, "win32") }),
          facts(),
        ),
      );
    expect(w([theirs, ours])).toEqual(FIRST(theirs.file));
    expect(w([ours, theirs])).toEqual(ITSELF);
    // The prefix itself is the folder on PATH there: with no shim in it yet, the same.
    expect(w([EMPTY, theirs])).toEqual(ITSELF);
    expect(w([theirs, EMPTY])).toEqual(FIRST(theirs.file));
  });
});

describe("a path in a sentence is said as the caller shows it; what is touched, pasted or compared is whole", () => {
  /** A `show` that marks what it was handed, as the command's `~/…` would shorten it. */
  const show = (p: string) => `<${p}>`;
  const script = path.join(HOME, "bin", "sessionpipe");
  const gone = bin(USR);
  const spare = copy(BREW, { where: "/opt/homebrew", version: OLD });
  // Its prefix goes into the line to paste as one word; nothing else is done with it.
  const sys = copy(path.join(ROOT, "sys"), { where: "/sys", prefix: "/opt/sys", writable: false });
  const checkout = copy(path.join(HOME, "code"), { where: "~/code", slot: null, not: "it holds src" });
  /** One of everything a sentence names a path in, beside what a step touches. */
  const mixed = (over: Partial<Inventory> = {}) =>
    inv({
      copies: [one(), spare, sys, checkout],
      dangling: [gone],
      strangers: [{ file: script, why: "a file of that name that npm didn't put there" }],
      // The home's bin folder is not on PATH, and that file is what a shell finds.
      ...shell([{ file: script, dir: null }]),
      ...over,
    });
  /** How many paths in a plan went through `show`. */
  const shown = (p: Plan) => JSON.stringify(p).match(/</g)?.length ?? 0;

  it("the two notes, a link's sentence and a stranger's place are shown; nothing else is", () => {
    const p = plan(mixed(), facts(), show);
    expect(p.notes).toEqual([
      `<${path.join(LOCAL, "bin")}> is not on your PATH: add it, or \`sessionpipe\` is not found when you type it.`,
      // The home is the look's own word for it, shortened already: only the file is shown.
      `Typing \`sessionpipe\` starts <${script}>, not the copy in ~/.local.`,
    ]);
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
        where: `<${script}>`,
        path: script,
        version: null,
        why: "a file of that name that npm didn't put there",
        line: null,
        ours: false,
      },
      // The line to paste names the whole prefix, quoted as a shell needs it and no other way.
      {
        where: "/sys",
        path: sys.dir,
        version: NEW,
        why: "you may not write where it is",
        line: "sudo npm uninstall -g --prefix /opt/sys sessionpipe",
        ours: true,
      },
    ]);
    // Those four and no more: not the file a shell finds first, not the home, not a step's
    // folder or what it touches, not a copy's removal, not a line under the rows.
    expect(shown(p)).toBe(4);
    expect(JSON.stringify(p.safety)).not.toContain("<");
    expect(step(p, "install").say).toBe("1.2.0, the newest release, fresh in ~/.local (replaces 1.2.0)");
    expect(p.first).toBe(script);
    expect(p.home).toEqual(home({ pathAt: null }));
    expect(step(p, "install")).toMatchObject({
      prefix: LOCAL,
      dir: slotIn(LOCAL, "linux"),
      touches: [slotIn(LOCAL, "linux"), bin(LOCAL)],
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
    expect(whole.notes).toEqual([NOT_ON_PATH(path.join(LOCAL, "bin")), FOUND_FIRST(script)]);
    expect(whole.left[1]?.where).toBe(script);
    expect(whole.steps.find((s) => s.do === "remove")).toMatchObject({
      say: `${gone} (a link to a copy that is gone)`,
    });
  });

  it("the notes are shown where there is nothing to repair, and where it refuses", () => {
    const fine = { copies: [one(), checkout], dangling: [] };
    const nothing = plan(mixed(fine), facts(), show);
    // The sentence names no path; the notes beside it do, each as the caller shows one.
    expect(nothing.nothing).toBe(ONE_COPY);
    expect(nothing.notes).toEqual([
      `<${path.join(LOCAL, "bin")}> is not on your PATH: add it, or \`sessionpipe\` is not found when you type it.`,
      `Typing \`sessionpipe\` starts <${script}>, not the copy in ~/.local.`,
    ]);
    expect(shown(nothing)).toBe(3);
    expect(nothing.first).toBe(script);
    expect(nothing.left.map((l) => l.where)).toEqual(["~/code", `<${script}>`]);
    const refused = plan(mixed(), facts({ npm: false }), show);
    expect(refused.refuse?.next).toBe("sessionpipe reinstall");
    expect(refused.notes).toEqual(nothing.notes);
    expect(refused.first).toBe(script);
    expect(shown(refused)).toBe(3);
  });

  it("on Windows the folder that is not on PATH is the prefix itself, shown the same way", () => {
    const w = plan(
      inv({ platform: "win32", copies: [one({ version: OLD }, "win32")], ...shell([], {}, "win32") }),
      facts(),
      show,
    );
    expect(w.notes).toEqual([
      `<${LOCAL}> is not on your PATH: add it, or \`sessionpipe\` is not found when you type it.`,
    ]);
    expect(shown(w)).toBe(1);
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
    // A global copy nothing uses is a stray, and so is npm's leftover.
    expect(idle(copy(BREW))).toBe(false);
    expect(idle(copy(BREW, { uses: ["this"] }))).toBe(false);
    expect(idle(leftover(BREW))).toBe(false);
    // What is no install of it is nobody's to count.
    expect(idle(copy(path.join(HOME, "code"), { slot: null, not: "it holds src" }))).toBe(false);
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
    expect(offline.nothing).toBe(UNASKED(NEW));
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

  it("an entry the service runs from, that wrote the hooks, or that is typed is a second copy: it acts", () => {
    const removes = ["fetch", "install", "use", `remove ${CACHED}`, "prove"];
    // Everything else as it should be: the entry in use is the one thing to repair.
    const hooked = plan(
      inv({ copies: [one({ uses: ["typed", "service", "this"] }), cached({ uses: ["hooks"] })] }),
      facts(),
    );
    expect(hooked.nothing).toBeNull();
    expect(does(hooked)).toEqual(removes);
    const typed = plan(
      inv({ copies: [cached({ uses: ["typed"] }), one({ uses: ["service", "hooks", "this"] })] }),
      facts(),
    );
    expect(does(typed)).toEqual(removes);
    const served = plan(
      inv({ copies: [one({ uses: ["typed", "hooks", "this"] }), cached({ uses: ["service"] })] }),
      facts(),
    );
    expect(does(served)).toEqual(removes);
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
    const alone = inv({ copies: [cached({ uses: ["this"] })], onPath: [] });
    const p = plan(alone, facts({ service: null, daemon: null, hooks: { version: null, wrong: [] } }));
    expect(p.nothing).toBeNull();
    expect(p.refuse).toBeNull();
    expect(does(p)).toEqual(["fetch", "install", "use", `remove ${CACHED}`, "prove"]);
    expect(step(p, "install")).toMatchObject({ prefix: LOCAL, dir: slotIn(LOCAL, "linux"), replaces: false });
    // Offline there is no release to hold anything to, and nothing to install from.
    const offline = plan(alone, facts({ latest: { error: "registry.npmjs.org can't be reached (ENOTFOUND)" } }));
    expect(offline.nothing).toBeNull();
    expect(offline.target).toBeNull();
    expect(offline.refuse?.next).toBe("sessionpipe reinstall");
  });
});
