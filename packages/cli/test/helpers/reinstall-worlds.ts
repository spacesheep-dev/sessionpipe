// SPDX-License-Identifier: Apache-2.0
// Computers made up from a number, for the properties `sessionpipe reinstall` is held to
// (reinstall-plan.test.ts, cli-reinstall-agree.test.ts). No disk, nothing run: a made-up
// computer is a short description (what each Node's global folder holds, what sits at
// each command path, PATH in its order, where this command runs from, what the service
// file names), and the inventory is worked out from it by the look's own rules, written a
// second time here. So what holds over these worlds holds for the plan together with the
// look's contract, and not for a generator that makes only what the plan likes.
//
// The look's contract (reinstall/find.ts `look`), as it is kept here:
//  - `copies`: one entry a folder, no folder twice, in the order found: what PATH leads to,
//    each prefix's slot and leftovers, the npx cache, this command's own, the service's.
//  - a global copy's `dir` is `slotIn(prefix)`, or a `.sessionpipe-XXXXXXXX` beside it
//    (`aside`); its `where` is its prefix as a person reads it; `prefix` is set only for a
//    copy in a global slot (Volta's own, which the proof accepts and Volta keeps, too): a
//    build in a slot, an npx entry and what is no install have none. An npx entry's
//    `where` is its cache entry. What is no install is `where` it is, whole.
//  - `slot` is null for what the proof refuses (`not` says why) and for Volta's copy
//    (`keeper`); a copy the proof accepts names its release, but for a folder left behind
//    (`aside`): npm's own or this command's by its name, and an empty folder in a slot
//    (what is left of a copy that could only be emptied). What an install that was cut
//    off left in a prefix's own slot (no package.json) is not ours.
//  - `onPath`: the copy is in a global slot and its prefix's bin folder is on PATH,
//    whatever is typed.
//  - `wrong`: a leftover; no dist/cli.js; the one typed copy that was asked and did not
//    answer its own release; a whole global copy with no link of npm's (`bins` empty).
//  - `uses`: "typed" on the copy whose dir is `typed`; "service" on the one the service
//    file names; "this" on the one the command runs from, which is always among the copies
//    when it is in reach; "hooks" on one copy at most, of the release that wrote them.
//  - `onPath`: every `sessionpipe` a shell finds, in PATH's order; a `node_modules/.bin`
//    is passed over where npm or npx started this run (they put it on PATH for that run
//    alone), and looked in where a person put it on PATH. `typed` is the folder the first
//    of them that starts anything leads to. Where that first one is a file that leads to no
//    folder: at the command path of a prefix that holds an installed copy it sits where
//    that copy's link was, and nothing is typed and nothing is unsure; anywhere else it is
//    a shim, and what is typed is this command's own copy when that is an installed one
//    AND this command was started as npm's link to it (how a shim starts one), else null
//    with `unsure` naming the file. A link to a copy that is gone starts nothing: it is in
//    `dangling`, as is such a link in a prefix that is not on PATH.
//  - `home`: the typed copy's prefix when that copy is a global one of ours, whatever
//    folder that is; null when what is typed is no install of ours, and with `unsure`;
//    with nothing typed, the first of (the prefix whose copy has a file where its link
//    was, a dangling link's prefix, this command's, the service's, each other copy's,
//    npm's, ~/.local) whose bin folder is on PATH, else the first of them: only a prefix
//    that was looked in (a link of someone's into a folder that is gone names none), and
//    for such a fresh place never Homebrew's versioned folder nor Volta's. Never chosen
//    by who may write it, and never a prefix whose slot holds what is not ours. `blocked`
//    names a file at its command path that is not npm's link to its own slot.
//  - `taken`: with no home, the first folder that sat in a tried prefix's own slot and is
//    not provably ours, with the proof's reason; null where a home was found.
//  - `reach`: only what is inside it is listed; with none, nothing is.
//  - `prefixes` holds every prefix a global copy is in; `npx` is the cache looked in.
// And of the facts (cli.ts `reinstall`): `apart` is set exactly where the reach is not the
// whole computer; a service file is what puts "service" on a copy; the hooks' release is
// the one the look was given; a socket file is stale only where no daemon answers; a
// daemon says who started it (by hand, or a manager), or doesn't say (before 0.15).
import path from "node:path";
import type { Copy, Home, Inventory, Use } from "../../src/reinstall/find.js";
import type { Reach } from "../../src/reinstall/ours.js";
import { type Facts, slotIn } from "../../src/reinstall/plan.js";

/** A seeded generator (mulberry32): the same seed, the same world, on every platform. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The release npm calls the newest in every generated world. */
export const NEWEST = "2.0.0";
/** Releases before it, and one after it (a pre-release of what comes next). */
export const OLDER = "1.9.0";
export const ANCIENT = "1.0.0";
export const AHEAD = "2.1.0-rc.1";

export interface World {
  seed: number;
  inv: Inventory;
  facts: Facts;
  /** How the command was started, which no inventory shows: as a link that leads to the
   *  copy it runs from (npm's own, as a shim starts one), not as a cli.js by its path or
   *  through npx; and by npm or npx (`npm_command` is set for the run). */
  asLink: boolean;
  npmRun: boolean;
}

// Paths are only joined and compared, never opened: any absolute spelling will do.
const ROOT = path.resolve(path.sep, "w");
/** The home folder of every generated world. */
export const HOME = path.join(ROOT, "home", "u");
const within = (root: string, p: string): boolean => {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};
/** A path as the command shows one to a person. */
export const tilde = (p: string): string => (within(HOME, p) ? path.join("~", path.relative(HOME, p)) : p);

const LOCAL = path.join(HOME, ".local");
const NPM_GLOBAL = path.join(HOME, ".npm-global");
const NVM = path.join(HOME, ".nvm", "versions", "node", "v22.1.0");
const ASDF = path.join(HOME, ".asdf", "installs", "nodejs", "22.1.0");
const USR = path.join(ROOT, "usr", "local");
const BREW = path.join(ROOT, "opt", "homebrew");
/** Homebrew's versioned folder: gone at the next `brew upgrade node`, so never a home. */
const CELLAR = path.join(BREW, "Cellar", "node", "22.1.0");
const VOLTA = path.join(HOME, ".volta", "tools", "image", "packages", "sessionpipe");
/** Every prefix a world's look knows; what is outside the home is another user's to write. */
const INSIDE = [LOCAL, NPM_GLOBAL, NVM, ASDF];
const PREFIXES = [...INSIDE, USR, BREW, CELLAR, VOLTA];
const NPX = path.join(HOME, ".npm", "_npx");
/** Folders on PATH that are no prefix's: a version manager's shims, Volta's, one's own. */
const SHIMS = path.join(HOME, ".asdf", "shims");
const VOLTA_BIN = path.join(HOME, ".volta", "bin");
const MY_BIN = path.join(HOME, "bin");
/** Folders that are no install: a checkout's package, and a project's own dependency. */
const CHECKOUT = path.join(HOME, "src", "sessionpipe", "packages", "cli");
const PROJECT = path.join(HOME, "work", "app", "node_modules", "sessionpipe");
/** The `.bin` beside a package folder that is in some `node_modules`. */
const dotBin = (dir: string): string => path.join(path.dirname(dir), ".bin");
const SERVICE_FILE = path.join(HOME, "Library", "LaunchAgents", "org.sessionpipe.control.plist");
const LAUNCHER = path.join(LOCAL, "share", "sessionpipe", "hook");
const NODE = path.join(ROOT, "usr", "bin", "node");

const binOf = (prefix: string): string => path.join(prefix, "bin");
const asideIn = (prefix: string): string => path.join(path.dirname(slotIn(prefix)), ".sessionpipe-Ab12Cd34");
const entryDir = (id: string): string => path.join(NPX, id, "node_modules", "sessionpipe");

// --- a computer, described ---------------------------------------------------------------

/** What a prefix's package folder holds: a published copy; a build someone put there;
 *  what an install that was cut off left (no package.json; its cli.js unpacked or not);
 *  or nothing at all (what is left of a copy that could only be emptied). */
type Held =
  | { is: "published"; version: string; whole: boolean }
  | { is: "build"; version: string | null }
  | { is: "cutoff"; cli: boolean }
  | { is: "empty" };
/** A link of someone's own into a project's dependency that is gone: it leads nowhere,
 *  and the folder three above where it leads is no prefix anyone looked in. */
const GONE = path.join(HOME, "work", "old", "lib", "node_modules", "sessionpipe");
/** What sits at a command path: npm's link to that prefix's own slot, a file that is no
 *  link of npm's, a link of someone's that leads to no install, or nothing. */
type AtBin = "link" | "file" | "stray" | null;
interface Place {
  prefix: string;
  held: Held | null;
  leftover: boolean;
  bin: AtBin;
  /** This user may write `lib/node_modules`, and `bin`. */
  modules: boolean;
  binDir: boolean;
  /** Volta's own folder for the package. */
  kept: boolean;
}
interface Entry {
  id: string;
  version: string;
  whole: boolean;
  bin: boolean;
  writable: boolean;
}
/** A folder on PATH that is no prefix's bin, and the `sessionpipe` in it: a file, a link
 *  to no install, or a link of someone's own to a package folder. */
interface Other {
  dir: string;
  holds: "file" | "stray" | { link: string };
}
interface Model {
  reach: Reach;
  places: Place[];
  entries: Entry[];
  others: Other[];
  /** PATH, folder by folder. */
  path: string[];
  /** The package folder this command runs from. */
  mine: string;
  /** It was started as a link that leads to that folder (where there is one): npm's own
   *  link, which is what a shim runs. Else as its cli.js by its path, or through npx. */
  asLink: boolean;
  /** npm or npx started this run: a `node_modules/.bin` on PATH is that run's own. */
  npmRun: boolean;
  /** The service file: the package folder it names, and what its manager says. */
  service: { cli: string; loaded: boolean; pid: number | null; nodeOk: boolean } | null;
  /** The release that wrote the hooks' own files. */
  hooks: string | null;
  npmPrefix: string | null;
  /** What the typed copy printed when it was asked `--version`, where that is not its own
   *  release (null: nothing); null where it answered as its package.json says. */
  answers: { said: string | null } | null;
  latest: Facts["latest"];
  npm: boolean;
  harnesses: string[];
  hooksWrong: string[];
  wanted: boolean;
  daemon: Facts["daemon"];
  staleSocket: boolean;
}

interface Dice {
  next: () => number;
  chance: (p: number) => boolean;
  pick: <T>(xs: readonly T[]) => T;
  shuffle: <T>(xs: readonly T[]) => T[];
}
const dice = (next: () => number): Dice => {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T;
  return {
    next,
    chance: (p) => next() < p,
    pick,
    shuffle: (xs) => {
      const all = [...xs];
      for (let i = all.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [all[i], all[j]] = [all[j] as (typeof all)[number], all[i] as (typeof all)[number]];
      }
      return all;
    },
  };
};

const blank = (prefix: string): Place => ({
  prefix,
  held: null,
  leftover: false,
  bin: null,
  modules: true,
  binDir: true,
  kept: prefix === VOLTA,
});
const published = (version: string, whole = true): Held => ({ is: "published", version, whole });
const placeAt = (m: Model, prefix: string): Place => m.places.find((p) => p.prefix === prefix) as Place;
const entry = (d: Dice, n: number): Entry => ({
  id: `${n}a1b2c3d4e5f6a7b`,
  version: d.pick([NEWEST, NEWEST, NEWEST, OLDER, OLDER, AHEAD]),
  whole: d.chance(0.92),
  bin: d.chance(0.7),
  writable: d.chance(0.92),
});

// --- what the look answers of it ----------------------------------------------------------

interface Folder {
  /** The proof's answer: ours, in which kind of slot; or not, and why. */
  slot: "global" | "npx" | null;
  not: string | null;
  aside: boolean;
  version: string | null;
  whole: boolean;
  prefix: string | null;
  bins: string[];
  writable: boolean;
  kept: boolean;
}

/** Every folder of a world that could be found, by its path. */
function foldersOf(m: Model): Map<string, Folder> {
  const all = new Map<string, Folder>();
  for (const p of m.places) {
    const link = path.join(binOf(p.prefix), "sessionpipe");
    const base = { prefix: p.prefix, writable: p.modules, kept: p.kept };
    if (p.held) {
      const h = p.held;
      // What the proof accepts: a published copy, and an empty folder of the name.
      const ours = h.is === "published" || h.is === "empty";
      all.set(slotIn(p.prefix), {
        ...base,
        // Only a copy the proof accepts as a global install has a prefix.
        prefix: ours ? p.prefix : null,
        slot: ours ? "global" : null,
        not: ours
          ? null
          : h.is === "build"
            ? "it holds src, which no published sessionpipe has (a checkout or a build?)"
            : "it has no package.json that can be read (an install that was cut off?)",
        aside: false,
        version: h.is === "published" || h.is === "build" ? h.version : null,
        whole: h.is === "published" ? h.whole : h.is === "build" ? true : h.is === "cutoff" ? h.cli : false,
        // Its own link is a link whose text leads into it, whatever the folder holds.
        bins: p.bin === "link" ? [link] : [],
      });
    }
    if (p.leftover)
      all.set(asideIn(p.prefix), {
        ...base,
        slot: "global",
        not: null,
        aside: true,
        version: null,
        whole: false,
        bins: [],
      });
  }
  for (const e of m.entries) {
    const dir = entryDir(e.id);
    all.set(dir, {
      slot: "npx",
      not: null,
      aside: false,
      version: e.version,
      whole: e.whole,
      prefix: null,
      bins: e.bin ? [path.join(path.dirname(dir), ".bin", "sessionpipe")] : [],
      writable: e.writable,
      kept: false,
    });
  }
  const none = {
    slot: null,
    aside: false,
    whole: true,
    prefix: null,
    bins: [],
    writable: true,
    kept: false,
  };
  all.set(CHECKOUT, { ...none, not: "it is not a folder named node_modules/sessionpipe", version: "2.1.0-dev.3" });
  all.set(PROJECT, {
    ...none,
    not: "it is not a global install or an npx cache entry (a project's own dependency?)",
    version: OLDER,
  });
  return all;
}

/** This command was started as a link that leads to the copy it runs from: there is such a
 *  link (npm's own in its prefix, or one of someone's own), and that is how it was run. */
const startedAsLink = (m: Model): boolean =>
  m.asLink &&
  (m.places.some((p) => p.bin === "link" && !!p.held && slotIn(p.prefix) === m.mine) ||
    m.others.some((o) => typeof o.holds === "object" && o.holds.link === m.mine));

/** The look, taken of a described computer. */
function seen(m: Model): Inventory {
  const inReach = (p: string): boolean => m.reach === true || (m.reach !== null && within(m.reach, p));
  const folders = foldersOf(m);
  const places = m.places.filter((p) => inReach(p.prefix));
  const dirs = new Set<string>();
  const add = (dir: string): void => {
    if (inReach(dir)) dirs.add(dir);
  };
  const onPath: Inventory["onPath"] = [];
  const dangling: string[] = [];
  /** Where each dangling link leads. */
  const led = new Map<string, string>();
  const strangers: Inventory["strangers"] = [];
  for (const dir of new Set(m.path)) {
    const file = path.join(dir, "sessionpipe");
    const place = m.places.find((p) => binOf(p.prefix) === dir);
    const holds: Other["holds"] | null = place
      ? place.bin === "link"
        ? { link: slotIn(place.prefix) }
        : place.bin
      : (m.others.find((o) => o.dir === dir)?.holds ?? null);
    if (!holds || !inReach(file) || (m.npmRun && /[\\/]node_modules[\\/]\.bin$/.test(dir))) continue;
    if (typeof holds === "string") {
      onPath.push({ file, dir: null });
      strangers.push({
        file,
        why: holds === "stray" ? "a link to no install of sessionpipe" : "a file npm didn't put there",
      });
      continue;
    }
    onPath.push({ file, dir: holds.link });
    if (folders.has(holds.link)) add(holds.link);
    else {
      dangling.push(file);
      led.set(file, holds.link);
    }
  }
  for (const p of places) {
    if (p.held) add(slotIn(p.prefix));
    if (p.leftover) add(asideIn(p.prefix));
    const link = path.join(binOf(p.prefix), "sessionpipe");
    if (p.bin === "link" && !p.held && !dangling.includes(link)) {
      dangling.push(link);
      led.set(link, slotIn(p.prefix));
    }
  }
  for (const e of m.entries) add(entryDir(e.id));
  add(m.mine);
  const serving = m.service && folders.has(m.service.cli) ? m.service.cli : null;
  if (serving) add(serving);

  const first = onPath.find((e) => !e.dir || folders.has(e.dir)) ?? null;
  const installed = (dir: string): boolean => {
    const f = folders.get(dir);
    return !!f && inReach(dir) && f.slot === "global" && !f.aside;
  };
  const opaque = first && !first.dir ? first.file : null;
  // At the command path of a prefix that holds an installed copy it is no shim: it sits
  // where that copy's link was.
  const under = opaque && path.basename(path.dirname(opaque)) === "bin" ? path.dirname(path.dirname(opaque)) : null;
  const inWay = under && installed(slotIn(under)) ? under : null;
  const shimmed = !!opaque && !inWay && installed(m.mine) && startedAsLink(m);
  const typed = opaque ? (shimmed ? m.mine : null) : (first?.dir ?? null);
  const unsure = opaque && !inWay && !shimmed ? opaque : null;

  const copies: Copy[] = [...dirs].map((dir) => {
    const f = folders.get(dir) as Folder;
    const ran = f.whole && f.slot && !f.kept && dir === typed && dir !== m.mine ? m.answers : null;
    // Left behind: by its name, or ours with no release to name (an empty folder).
    const aside = f.aside || (f.slot !== null && f.version === null);
    return {
      dir,
      where: tilde(
        f.slot === "npx" ? path.dirname(path.dirname(dir)) : f.slot === "global" ? (f.prefix as string) : dir,
      ),
      prefix: f.prefix,
      slot: f.kept ? null : f.slot,
      not: f.kept ? "Volta keeps it" : f.not,
      aside,
      version: f.version,
      wrong: aside
        ? "left behind by an install that was cut off"
        : !f.whole
          ? "its dist/cli.js is missing (an install that was cut off?)"
          : ran && ran.said === null
            ? "it doesn't run: `--version` printed nothing"
            : ran && ran.said !== f.version
              ? `it says it is ${ran.said}, and its package.json says ${f.version}`
              : f.slot === "global" && !f.bins.length
                ? "npm's link to it is gone"
                : null,
      bins: f.bins,
      uses: [
        ...(dir === typed ? (["typed"] as const) : []),
        ...(dir === serving ? (["service"] as const) : []),
        ...(dir === m.mine ? (["this"] as const) : []),
      ],
      // By the proof's own answer of where it sits (Volta's copy, which the proof accepts
      // and Volta keeps, too).
      onPath: f.slot === "global" && m.path.includes(binOf(path.dirname(path.dirname(path.dirname(dir))))),
      writable: f.writable,
      keeper: f.kept ? "volta uninstall sessionpipe" : null,
    };
  });
  const wrote = copies.filter((c) => !!m.hooks && c.version === m.hooks);
  (wrote.find((c) => c.uses.some((u) => u !== "this")) ?? wrote.find((c) => c.slot !== "npx") ?? wrote[0])?.uses.push(
    "hooks",
  );

  let taken: Inventory["taken"] = null;
  const homeAt = (prefix: string, why: string): Home | null => {
    // Only a prefix that was looked in as one; for a fresh place (nothing typed), not
    // Homebrew's versioned folder nor Volta's; and none whose slot holds what is not ours.
    const p = places.find((x) => x.prefix === prefix);
    if (!p) return null;
    if (!typed && (/[\\/]Cellar[\\/]node(?:@\d+)?[\\/]/.test(prefix) || p.kept)) return null;
    if (p.held && p.held.is !== "published" && p.held.is !== "empty") {
      // What is there is not provably ours: no home, and kept in mind should no place do.
      taken ??= { dir: slotIn(prefix), why: folders.get(slotIn(prefix))?.not as string };
      return null;
    }
    const bin = binOf(prefix);
    return {
      prefix,
      shown: tilde(prefix),
      why,
      bin,
      onPath: m.path.includes(bin),
      blocked: p.bin && p.bin !== "link" ? path.join(bin, "sessionpipe") : null,
      writable: p.modules && p.binDir,
    };
  };
  const by = (u: Use): string | null | undefined =>
    copies.find((c) => c.uses.includes(u) && c.slot === "global")?.prefix;
  const typedCopy = copies.find((c) => c.dir === typed);
  const candidates: [string | null | undefined, string][] = typed
    ? typedCopy?.slot === "global"
      ? [[typedCopy.prefix, "where the one you type is"]]
      : []
    : unsure
      ? []
      : [
          [inWay, "where the copy is whose link is gone"],
          ...dangling.map((f): [string, string] => [
            path.dirname(path.dirname(path.dirname(led.get(f) as string))),
            "where a link to it already is",
          ]),
          [by("this"), "where this command runs from"],
          [by("service"), "where the one the background service runs is"],
          ...copies
            .filter((c) => c.slot === "global" && !c.aside)
            .map((c): [string | null, string] => [c.prefix, "where another copy of it already is"]),
          [m.npmPrefix, "npm's global folder"],
          [LOCAL, "a folder of your own"],
        ];
  const homes = candidates.flatMap(([p, why]) => {
    const h = p ? homeAt(p, why) : null;
    return h ? [h] : [];
  });
  return {
    reach: m.reach,
    copies,
    dangling,
    strangers,
    onPath,
    typed,
    unsure,
    home: homes.find((h) => h.onPath) ?? homes[0] ?? null,
    taken: homes.length ? null : taken,
    prefixes: places.map((p) => p.prefix),
    npx: NPX,
  };
}

/** What was found beside the copies, of a described computer. */
function factsOf(m: Model): Facts {
  return {
    latest: m.latest,
    npm: m.npm,
    harnesses: m.harnesses,
    hooks: { version: m.hooks, wrong: m.hooksWrong },
    hookFiles: [...(m.hooks ? [LAUNCHER] : []), ...m.harnesses.map((h) => path.join(HOME, `.${h}`, "settings.json"))],
    wanted: m.wanted,
    service: m.service
      ? {
          file: SERVICE_FILE,
          loaded: m.service.loaded,
          pid: m.service.pid,
          node: NODE,
          nodeOk: m.service.nodeOk,
          cliOk: foldersOf(m).has(m.service.cli),
        }
      : null,
    // A socket file is stale only where no daemon answers on it.
    staleSocket: m.staleSocket && !m.daemon,
    daemon: m.daemon,
    apart:
      m.reach === true
        ? null
        : {
            said: `This sessionpipe keeps its files in ${path.join(ROOT, "tmp", "world")}, not in this computer's usual place (~/.local/state/sessionpipe)`,
            line: "env -u SESSIONPIPE_STATE -u SESSIONPIPE_CONFIG sessionpipe reinstall",
          },
  };
}

const made = (seed: number, m: Model): World => ({
  seed,
  inv: seen(m),
  facts: factsOf(m),
  asLink: startedAsLink(m),
  npmRun: m.npmRun,
});

// --- a computer with nothing to repair --------------------------------------------------------

/** One installed copy: whole, the newest, what typing starts, the hooks and the service
 *  on it. Where it is, who may write there, how it comes to be typed, what else is on
 *  PATH and on the disk beside it, and whether anything is hooked or served at all, vary. */
function sound(d: Dice): Model {
  const { chance, pick } = d;
  const reach: Reach = chance(0.1) ? HOME : true;
  const at = pick(reach === true ? [LOCAL, LOCAL, NPM_GLOBAL, NVM, ASDF, USR, USR, BREW, CELLAR] : INSIDE);
  const places = PREFIXES.map(blank);
  const own = places.find((p) => p.prefix === at) as Place;
  own.held = published(NEWEST);
  own.bin = "link";
  own.modules = chance(within(HOME, at) ? 0.8 : 0.35);
  own.binDir = own.modules ? chance(0.9) : chance(0.25);
  const copy = slotIn(at);
  const others: Other[] = [];
  /** PATH before the `sessionpipe` that is typed (folders with none in them), and after. */
  const ahead: string[] = [];
  const behind: string[] = [];
  // How it comes to be typed: npm's own link first on PATH; a version manager's shim that
  // started this very copy; or a link of one's own to it, in a folder of one's own.
  const way = pick(["link", "link", "link", "shim", "shim", "linked"] as const);
  if (way === "shim") others.push({ dir: SHIMS, holds: chance(0.5) ? "file" : "stray" });
  if (way === "linked") others.push({ dir: MY_BIN, holds: { link: copy } });
  const front = way === "link" ? binOf(at) : way === "shim" ? SHIMS : MY_BIN;
  if (way !== "link" && chance(0.5)) behind.push(binOf(at));
  // What is no install of it, and stays: a build in another prefix, Volta's copy, files
  // of the name behind the one that is typed.
  const spare = places.filter((p) => p !== own && !p.kept);
  if (chance(0.14)) {
    const p = pick(spare);
    p.held = { is: "build", version: pick([NEWEST, OLDER, null]) };
    p.bin = chance(0.6) ? "link" : null;
    if (p.bin && chance(0.5)) behind.push(binOf(p.prefix));
  }
  if (chance(0.08)) {
    const volta = places.find((p) => p.kept) as Place;
    volta.held = published(pick([NEWEST, OLDER]));
    volta.bin = "link";
    others.push({ dir: VOLTA_BIN, holds: "stray" });
    behind.push(VOLTA_BIN);
  }
  if (way !== "shim" && chance(0.25)) {
    others.push({ dir: SHIMS, holds: chance(0.5) ? "file" : "stray" });
    behind.push(SHIMS);
  }
  if (way !== "linked" && chance(0.18)) {
    others.push({ dir: MY_BIN, holds: pick(["file", "stray", { link: CHECKOUT }] as const) });
    behind.push(MY_BIN);
  }
  for (const p of spare) if (!p.bin && chance(0.3)) (chance(0.5) ? ahead : behind).push(binOf(p.prefix));
  // npm's own cache of what npx ran: nothing uses an entry but, at most, this command.
  const entries = Array.from({ length: pick([0, 0, 0, 1, 1, 2]) }, (_, n) => entry(d, n));
  const from = way === "shim" ? 0 : d.next();
  if (from >= 0.55 && from < 0.75 && !entries.length) entries.push(entry(d, 0));
  const ran = from < 0.55 ? null : from < 0.75 ? pick(entries) : null;
  const mine = from < 0.55 ? copy : ran ? entryDir(ran.id) : from < 0.9 ? CHECKOUT : PROJECT;
  // Started by npx (from its cache, or inside a project that depends on it): npx puts that
  // run's own `.bin` first on PATH, and it is nobody's to type.
  const npmRun = (!!ran || mine === PROJECT) && chance(0.8);
  const runs: string[] = [];
  if (npmRun && chance(0.85)) {
    if (ran) ran.bin = true;
    others.push({ dir: dotBin(mine), holds: { link: mine } });
    runs.push(dotBin(mine));
  }
  // Hooks: no agent hooked (whatever wrote the files once), or hooked by the newest.
  const harnesses = pick<string[]>([[], ["claude"], ["claude"], ["claude", "codex"]]);
  const hooks = harnesses.length ? NEWEST : pick([null, NEWEST, ANCIENT]);
  // The service: its file on this copy with its own daemon answering; or no file, and
  // then no daemon where nothing needs one, or one someone runs by hand on the newest; or
  // a file nothing needs with no daemon answering, which is left and is nothing to say.
  const served = pick(["service", "service", "none", "by hand", "idle"] as const);
  const pid = pick([100, 4242]);
  // The process the manager names for the service: the daemon that answers, or none (it
  // doesn't say). And the daemon's own word on who started it: beside a service whose
  // manager names it, whatever it says, it is that service's; where the manager names no
  // process, a daemon that says "by hand" would be a second one, so it doesn't say that.
  const named = chance(0.8) ? pid : null;
  const byHand =
    served === "by hand" ? pick([true, null]) : named === null ? pick([false, null]) : pick([true, false, null]);
  return {
    reach,
    places,
    entries,
    others,
    path: [...runs, ...d.shuffle(ahead), front, ...d.shuffle(behind)],
    mine,
    // Through a shim it was started as npm's link, which is what a shim runs.
    asLink: way === "shim" || chance(0.5),
    npmRun,
    service:
      served === "service"
        ? { cli: copy, loaded: true, pid: named, nodeOk: true }
        : served === "idle"
          ? { cli: copy, loaded: chance(0.5), pid: chance(0.5) ? pid : null, nodeOk: chance(0.8) }
          : null,
    hooks,
    npmPrefix: chance(0.9) ? pick([at, LOCAL, USR]) : null,
    answers: null,
    latest: { version: NEWEST },
    npm: chance(0.9),
    harnesses,
    hooksWrong: [],
    wanted: served === "service" || (served === "by hand" && chance(0.5)),
    daemon: served === "none" || served === "idle" ? null : { pid, version: NEWEST, byHand },
    staleSocket: (served === "none" || served === "idle") && chance(0.2),
  };
}

/** The one installed (global) copy is whole, the newest, what is typed, with hooks and
 *  service fine. Everything else varies with the seed: `home.writable`, `home.onPath`,
 *  strangers (and so the copy typed through a shim), idle npx entries, copies that are no
 *  install (left alone), where the prefix is, whether hooks, harnesses or a service exist
 *  at all (fine in each shape). */
export function healthy(seed: number): World {
  return made(seed, sound(dice(rng(seed))));
}

// --- a computer with something wrong, and one with anything at all ------------------------------

/** Where the one copy of a sound computer is. */
const ownOf = (m: Model): Place => m.places.find((p) => p.held?.is === "published" && !p.kept) as Place;
const unusedPlaces = (m: Model): Place[] => m.places.filter((p) => !p.held && !p.bin && !p.kept);
/** A folder off PATH, wherever it was. */
const offPath = (m: Model, dir: string): void => {
  m.path = m.path.filter((p) => p !== dir);
};

/** One thing that makes a sound computer one to repair, or one this command refuses.
 *  `own`: where its one copy is (or was, before another of these took it away). */
const DEFECTS: ((m: Model, d: Dice, own: Place) => void)[] = [
  // The copy itself: an older release, cut off, its link gone or written over.
  (_m, _d, own) => {
    own.held = published(OLDER);
  },
  (_m, _d, own) => {
    own.held = published(NEWEST, false);
  },
  (_m, _d, own) => {
    own.bin = null;
  },
  (_m, d, own) => {
    own.bin = d.pick(["file", "stray"] as const);
  },
  (_m, _d, own) => {
    own.modules = false;
    own.binDir = false;
  },
  // What a killed `npm install -g` leaves where the copy was: no package.json to say what
  // it is, npm's link to it still in place. What is typed is then no installed copy.
  (_m, d, own) => {
    own.held = { is: "cutoff", cli: d.chance(0.5) };
  },
  // What is left of a second copy that could only be emptied: a folder with nothing in it.
  (m, d) => {
    const p = d.pick(unusedPlaces(m));
    p.held = { is: "empty" };
    p.bin = d.chance(0.5) ? "link" : null;
    p.modules = d.chance(0.9);
    p.binDir = p.modules;
    offPath(m, binOf(p.prefix));
    if (d.chance(0.4)) m.path.push(binOf(p.prefix));
  },
  // A link of someone's own into a project's dependency that is gone: it names no prefix.
  (m, d) => {
    if (m.others.some((o) => o.dir === MY_BIN)) return;
    m.others.push({ dir: MY_BIN, holds: { link: GONE } });
    if (d.chance(0.5)) m.path.unshift(MY_BIN);
    else m.path.push(MY_BIN);
  },
  // No place for a fresh copy: the one copy is gone with its link, and the folder of the
  // user's own holds a build someone put there (npm names that folder, or can't be asked).
  (m, d, own) => {
    if (m.mine === slotIn(own.prefix)) m.mine = CHECKOUT;
    own.held = null;
    own.bin = null;
    const local = placeAt(m, LOCAL);
    local.held = { is: "build", version: null };
    local.bin = null;
    m.npmPrefix = d.pick([null, LOCAL]);
  },
  // A second copy somewhere: behind the one that is typed, ahead of it, or off PATH.
  (m, d) => {
    const p = d.pick(unusedPlaces(m));
    p.held = published(d.pick([NEWEST, OLDER, OLDER, ANCIENT]), d.chance(0.9));
    p.bin = d.chance(0.9) ? "link" : null;
    p.modules = d.chance(within(HOME, p.prefix) ? 0.9 : 0.4);
    p.binDir = p.modules;
    offPath(m, binOf(p.prefix));
    const where = d.next();
    if (where < 0.5) m.path.push(binOf(p.prefix));
    else if (where < 0.75) m.path.unshift(binOf(p.prefix));
  },
  (m, d) => {
    d.pick(m.places.filter((p) => !p.kept)).leftover = true;
  },
  // A link to a copy that is gone, on PATH or not.
  (m, d) => {
    const p = d.pick(unusedPlaces(m));
    p.bin = "link";
    offPath(m, binOf(p.prefix));
    const where = d.next();
    if (where < 0.4) m.path.push(binOf(p.prefix));
    else if (where < 0.6) m.path.unshift(binOf(p.prefix));
  },
  // The hooks: another release's, nobody's, or with something wrong.
  (m, d) => {
    m.harnesses = ["claude"];
    m.hooks = d.pick([null, OLDER]);
  },
  (m) => {
    m.harnesses = ["claude"];
    m.hooks = NEWEST;
    m.hooksWrong = ["claude: missing (~/.claude/settings.json)"];
  },
  // The service: not loaded, a node that is gone, another release answering, a daemon
  // someone started by hand beside it, a file that names another copy or one that is gone.
  (m, d, own) => {
    const s = m.service ?? { cli: slotIn(own.prefix), loaded: true, pid: 100, nodeOk: true };
    m.service = s;
    m.wanted = true;
    m.daemon = m.daemon ?? { pid: s.pid ?? 100, version: NEWEST, byHand: null };
    const what = d.pick([
      ...(["unloaded", "node", "older", "by hand", "by hand", "supervised"] as const),
      ...(["silent", "elsewhere", "gone", "cached"] as const),
    ]);
    if (what === "unloaded") s.loaded = false;
    if (what === "node") s.nodeOk = false;
    if (what === "older") m.daemon = { ...m.daemon, version: OLDER };
    // Another process than the one the manager names: someone's own (it says so, or is
    // from before it said), or one a supervisor started, which is no second daemon.
    if (what === "by hand") m.daemon = { pid: 7777, version: d.pick([NEWEST, OLDER]), byHand: d.pick([true, null]) };
    if (what === "supervised") m.daemon = { pid: 7777, version: NEWEST, byHand: false };
    if (what === "silent") m.daemon = null;
    if (what === "elsewhere") s.cli = CHECKOUT;
    if (what === "gone") s.cli = slotIn(d.pick(unusedPlaces(m)).prefix);
    if (what === "cached") {
      if (!m.entries.length) m.entries.push(entry(d, 0));
      s.cli = entryDir((m.entries[0] as Entry).id);
    }
  },
  // A service file nothing needs (which is nothing to repair by itself), and a daemon
  // someone runs by hand on another release.
  (m, _d, own) => {
    m.service = m.service ?? { cli: slotIn(own.prefix), loaded: true, pid: 100, nodeOk: true };
    m.wanted = false;
    m.daemon = null;
  },
  (m, d) => {
    m.service = null;
    m.daemon = { pid: 7777, version: OLDER, byHand: d.pick([true, null]) };
  },
  (m) => {
    m.service = null;
    m.daemon = null;
    m.wanted = true;
  },
  // What a fresh copy comes from: npm out of reach, no npm, something newer than npm's newest.
  (m) => {
    m.latest = { error: "registry.npmjs.org can't be reached (ENOTFOUND)" };
  },
  (m) => {
    m.npm = false;
    m.npmPrefix = null;
  },
  (m, d, own) => {
    const what = d.pick(["copy", "hooks", "daemon"] as const);
    if (what === "copy") own.held = published(AHEAD);
    if (what === "hooks") m.hooks = AHEAD;
    if (what === "daemon") m.daemon = { pid: m.daemon?.pid ?? 7777, version: AHEAD, byHand: m.daemon?.byHand ?? null };
  },
  // What typing starts: a shim this command was not started through; nothing at all; a
  // build someone put in the prefix; a copy that does not answer its own release.
  (m, d) => {
    if (!m.others.some((o) => o.dir === SHIMS)) m.others.push({ dir: SHIMS, holds: "file" });
    offPath(m, SHIMS);
    m.path.unshift(SHIMS);
    m.mine = d.pick([CHECKOUT, PROJECT]);
  },
  // A shim first, and this command started as a cli.js by its path: it can't be told.
  (m) => {
    if (!m.others.some((o) => o.dir === SHIMS)) m.others.push({ dir: SHIMS, holds: "file" });
    offPath(m, SHIMS);
    m.path.unshift(SHIMS);
    m.asLink = false;
  },
  // A project's own `.bin` that a person put on PATH: looked in, and what it starts is no
  // installed copy.
  (m, d) => {
    const dir = dotBin(PROJECT);
    if (!m.others.some((o) => o.dir === dir)) m.others.push({ dir, holds: { link: PROJECT } });
    offPath(m, dir);
    if (d.chance(0.7)) m.path.unshift(dir);
    else m.path.push(dir);
    m.npmRun = false;
  },
  (m) => {
    const holds = (dir: string): boolean =>
      m.others.some((o) => o.dir === dir) || m.places.some((p) => p.bin && binOf(p.prefix) === dir);
    m.path = m.path.filter((dir) => !holds(dir));
  },
  (_m, d, own) => {
    own.held = { is: "build", version: d.pick([NEWEST, null]) };
  },
  (m, d, own) => {
    m.answers = { said: d.pick([null, OLDER]) };
    if (m.mine === slotIn(own.prefix)) m.mine = CHECKOUT;
  },
  // An npx cache entry that something runs from is a copy as any other.
  (m, d) => {
    if (!m.entries.length) m.entries.push(entry(d, 0));
    const e = m.entries[0] as Entry;
    e.version = OLDER;
    m.harnesses = ["claude"];
    m.hooks = OLDER;
  },
  // A sessionpipe that keeps its files apart, in this account's own home: it may reach nothing.
  (m) => {
    m.reach = null;
  },
];

/** A sound computer with one to three things wrong with it. */
function troubled(d: Dice): Model {
  const m = sound(d);
  const own = ownOf(m);
  const n = d.pick([1, 1, 1, 2, 2, 3]);
  for (let i = 0; i < n; i++) d.pick(DEFECTS)(m, d, own);
  return m;
}

/** Anything: every prefix holds what it will, PATH is in any order, and nothing is tied
 *  to anything else beyond what a disk ties together. */
function chaos(d: Dice): Model {
  const { chance, pick, next } = d;
  const reach: Reach = chance(0.05) ? null : chance(0.08) ? HOME : true;
  const release = (): string => {
    const x = next();
    return x < 0.52 ? NEWEST : x < 0.85 ? OLDER : x < 0.97 ? ANCIENT : AHEAD;
  };
  const places = PREFIXES.map((prefix) => {
    const p = blank(prefix);
    if (p.kept) {
      if (chance(0.07)) {
        p.held = published(release());
        p.bin = "link";
      }
      return p;
    }
    if (chance(prefix === LOCAL ? 0.55 : 0.2)) {
      const kind = next();
      p.held =
        kind < 0.1
          ? { is: "build", version: chance(0.6) ? release() : null }
          : kind < 0.16
            ? { is: "cutoff", cli: chance(0.5) }
            : kind < 0.2
              ? { is: "empty" }
              : published(release(), chance(0.92));
    }
    const x = next();
    p.bin = p.held
      ? x < 0.86
        ? "link"
        : x < 0.93
          ? null
          : x < 0.97
            ? "file"
            : "stray"
      : x < 0.86
        ? null
        : x < 0.93
          ? "link"
          : x < 0.98
            ? "file"
            : "stray";
    p.leftover = chance(0.06);
    p.modules = chance(within(HOME, prefix) ? 0.92 : 0.45);
    p.binDir = p.modules ? chance(0.95) : chance(0.2);
    return p;
  });
  const free = places.filter((p) => !p.kept);
  const others: Other[] = [];
  if (chance(0.12)) others.push({ dir: SHIMS, holds: chance(0.6) ? "file" : "stray" });
  if (places.some((p) => p.kept && p.held) && chance(0.8)) others.push({ dir: VOLTA_BIN, holds: "stray" });
  if (chance(0.16))
    others.push({
      dir: MY_BIN,
      holds: pick(["file", "stray", { link: CHECKOUT }, { link: slotIn(pick(free).prefix) }, { link: GONE }] as const),
    });
  let dirs = d.shuffle([
    ...free.filter((p) => chance(p.bin ? 0.8 : 0.3)).map((p) => binOf(p.prefix)),
    ...others.map((o) => o.dir),
  ]);
  // A version manager puts its shims first.
  if (dirs.includes(SHIMS) && chance(0.6)) dirs = [SHIMS, ...dirs.filter((x) => x !== SHIMS)];
  const entries = Array.from({ length: pick([0, 0, 0, 0, 0, 1, 1, 1, 2]) }, (_, n) => entry(d, n));
  const globals = free.filter((p) => p.held?.is === "published");
  const builds = free.filter((p) => p.held?.is === "build");
  const from = next();
  if (from >= 0.6 && from < 0.8 && !entries.length) entries.push(entry(d, 0));
  const volta = places.find((p) => p.kept) as Place;
  const mine =
    from < 0.6 && globals.length
      ? slotIn(pick(globals).prefix)
      : from < 0.8 && entries.length
        ? entryDir(pick(entries).id)
        : from < 0.9
          ? CHECKOUT
          : from < 0.94
            ? PROJECT
            : from < 0.97 && builds.length
              ? slotIn(pick(builds).prefix)
              : volta.held
                ? slotIn(VOLTA)
                : CHECKOUT;
  // npm or npx started it: from the cache mostly, in a project sometimes, seldom anywhere
  // else. The run's own `.bin` is then first on PATH. And a person may have a project's
  // `.bin` on PATH with no npm about.
  const cachedRun = entries.find((e) => entryDir(e.id) === mine);
  const npmRun = chance(cachedRun ? 0.9 : mine === PROJECT ? 0.5 : 0.04);
  if ((cachedRun || mine === PROJECT) && chance(npmRun ? 0.85 : 0.3)) {
    if (cachedRun) cachedRun.bin = true;
    others.push({ dir: dotBin(mine), holds: { link: mine } });
    dirs = [dotBin(mine), ...dirs];
  } else if (chance(0.04)) {
    others.push({ dir: dotBin(PROJECT), holds: { link: PROJECT } });
    dirs = chance(0.6) ? [dotBin(PROJECT), ...dirs] : [...dirs, dotBin(PROJECT)];
  }
  const empty = free.filter((p) => !p.held);
  const names = (): string => {
    const y = next();
    if (y < 0.5) return mine;
    if (y < 0.75 && globals.length) return slotIn(pick(globals).prefix);
    if (y < 0.85 && entries.length) return entryDir(pick(entries).id);
    if (y < 0.93 && empty.length) return slotIn(pick(empty).prefix);
    return CHECKOUT;
  };
  const service = chance(reach === true ? 0.55 : 0.15)
    ? { cli: names(), loaded: chance(0.9), pid: chance(0.85) ? 100 : null, nodeOk: chance(0.95) }
    : null;
  const m: Model = {
    reach,
    places,
    entries,
    others,
    path: dirs,
    mine,
    asLink: chance(0.6),
    npmRun,
    service,
    hooks: null,
    npmPrefix: chance(0.9) ? pick([LOCAL, NPM_GLOBAL, USR, BREW, NVM]) : null,
    answers: chance(0.1) ? { said: pick([null, OLDER]) } : null,
    latest: chance(0.08) ? { error: "registry.npmjs.org can't be reached (ENOTFOUND)" } : { version: NEWEST },
    npm: chance(0.96),
    harnesses: pick<string[]>([[], ["claude"], ["claude"], ["claude", "codex"]]),
    hooksWrong: [],
    wanted: chance(0.7),
    daemon: null,
    staleSocket: false,
  };
  const releaseAt = (dir: string): string | null => foldersOf(m).get(dir)?.version ?? null;
  m.hooks = chance(0.2) ? null : chance(0.65) ? (releaseAt(mine) ?? release()) : release();
  if (m.harnesses.length && chance(0.1)) m.hooksWrong = ["claude: missing (~/.claude/settings.json)"];
  if (chance(0.6))
    m.daemon = {
      pid: service?.pid != null && chance(0.85) ? service.pid : 7777,
      version: chance(0.7) ? (releaseAt(service?.cli ?? mine) ?? release()) : release(),
      byHand: pick([true, false, null]),
    };
  else m.staleSocket = chance(0.1);
  return m;
}

/** Anything the look could answer: none, one or several copies of every kind (global, npx
 *  idle and in use, leftover, a checkout, a project's dependency, Volta's), older, the
 *  newest, newer or broken, writable or not, strangers, dangling links, a shim first on
 *  PATH (typed = this copy where it was started as npm's link, or unsure), a file where a
 *  copy's link was, a `.bin` of npm's run or of a person's own PATH, nothing typed, the
 *  home null, blocked, not on PATH or not writable, and every variation of the facts. A third of them are a sound
 *  computer with one to three things wrong; a few are sound; the rest are anything. */
export function world(seed: number): World {
  const d = dice(rng(seed));
  const kind = d.next();
  return made(seed, kind < 0.06 ? sound(d) : kind < 0.4 ? troubled(d) : chaos(d));
}
