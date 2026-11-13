// SPDX-License-Identifier: Apache-2.0
// The look `sessionpipe reinstall` takes at this computer before it decides anything:
// every copy of sessionpipe it can find, what each is used by, what typing `sessionpipe`
// starts, and where the one copy that is to stay lives. It reads, and runs nothing it
// finds, with one exception that is the caller's to allow (`Looking.runs`).
//
// Where it looks: every `sessionpipe` on PATH (all of them, not the first); the copy the
// service file names; the copy this command runs from; the global folder of every Node it
// knows a place for (this one's, npm's own answer, ~/.local, Homebrew, /usr/local, nvm,
// fnm, asdf, mise, nodenv, n, Volta, the installer's own Node) and of a PATH folder whose
// own npm link leads into it; and the npx cache.
import { accessSync, constants, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { parseVersion } from "@sessionpipe/core/version";
import {
  ASIDE,
  binsOf,
  binTarget,
  type Proving,
  prefixOfSlot,
  prove,
  type Reach,
  type Slot,
  same,
  within,
} from "./ours.js";

export type Use = "typed" | "service" | "hooks" | "this";

export interface Copy {
  /** The package folder. */
  dir: string;
  /** Where it is, for a person: its npm prefix, its cache entry, or the folder itself
   *  where it is no install. */
  where: string;
  /** The npm prefix of a copy that is a global install. */
  prefix: string | null;
  /** Ours to remove, and in which kind of slot; null where it is not, with why in `not`. */
  slot: Slot | null;
  not: string | null;
  /** A folder left behind: npm's own from an install that was cut off, this command's
   *  from a run that was, or an empty folder of the name (what is left of a copy that
   *  could only be emptied). It names no release. */
  aside: boolean;
  /** The release its package.json names; null when it names none. */
  version: string | null;
  /** What is wrong with it, in a few words; null when nothing is, as far as a look tells. */
  wrong: string | null;
  /** Its own bin links. */
  bins: string[];
  uses: Use[];
  /** A global install whose command folder (`<prefix>/bin`) a shell looks in. */
  onPath: boolean;
  /** This user may write where it is. */
  writable: boolean;
  /** Someone else's tool keeps it, and takes it away with this command. */
  keeper: string | null;
}

/** Where the one copy lives, or is to live. */
export interface Home {
  prefix: string;
  /** The prefix as a person reads it, and why it is this one. */
  shown: string;
  why: string;
  /** The folder its command is in, and whether a shell looks there. */
  bin: string;
  onPath: boolean;
  /** A file that sits where npm puts the command and is not npm's own link to the copy in
   *  this prefix (a script, a link to somewhere else): npm will not put its link over it,
   *  and it is not this command's to move. Null: nothing is. */
  blocked: string | null;
  /** This user may write its package folder and its command. */
  writable: boolean;
}

export interface Inventory {
  reach: Reach;
  copies: Copy[];
  /** Bin links that lead to a sessionpipe that is gone. */
  dangling: string[];
  /** Files named sessionpipe on PATH that lead to no folder at all: left, and said. */
  strangers: { file: string; why: string }[];
  /** Every `sessionpipe` a shell would find, first first, as the package folder each leads
   *  to (null: a file that leads to none). npx's own entry for the run it started is not
   *  among them. */
  onPath: { file: string; dir: string | null }[];
  /** The package folder typing `sessionpipe` starts. It is the one the first of `onPath`
   *  that starts anything leads to; where that first one is a file that leads to no folder
   *  (a version manager's shim, a wrapper) and this command runs from an installed copy,
   *  it is that copy: the file is what started it. Null: nothing is typed, or it can't be
   *  told (`unsure`). */
  typed: string | null;
  /** Such a file, where this command was not started from an installed copy (npx, a
   *  checkout): which copy it starts can't be told without running it. */
  unsure: string | null;
  /** Such a file, where this command WAS started as npm's link to an installed copy: that
   *  copy is taken to be what the file starts (`typed`), which is how a version manager's
   *  shim works, and is not read from anywhere: a wrapper of the person's own may start
   *  another copy. Where this is set, no installed copy is removed, and nothing is said of
   *  what typing starts as if it were known. */
  inferred: string | null;
  /** Where the copy that typing starts lives; with nothing typed, the place a shell would
   *  find a fresh one. Never chosen by who may write it. Null: no such place, or what is
   *  typed is no install of ours. */
  home: Home | null;
  /** With no home: a folder that sits where a prefix keeps the package and is not
   *  provably sessionpipe's (what an install that was cut off left, a build), and why. It
   *  is in the way of the one copy, and the person's to move. Null: nothing is. */
  taken: { dir: string; why: string } | null;
  /** The global prefixes, and the npx cache, that were looked in. */
  prefixes: string[];
  npx: string;
}

export interface Looking {
  env: NodeJS.ProcessEnv;
  /** The home folder in effect. */
  home: string;
  reach: Reach;
  /** The node running this, this copy's dist folder, and the file it was started as
   *  (`process.argv[1]`: npm's link to it, or its cli.js by its path). */
  execPath: string;
  distDir: string;
  started: string;
  /** npm's own global prefix (`npm prefix -g`); null when npm can't be asked. */
  npmPrefix: string | null;
  /** The cli.js the service file names; null when there is no service file. */
  serviceCli: string | null;
  /** The version the hooks' own files were written by; null when there are none. */
  hooksVersion: string | null;
  /** What `--version` prints when a cli.js is run; null when it doesn't run. Asked of one
   *  copy at most: the one typing starts, where that is a folder the proof accepts and is
   *  not the copy already running (a cli.js that was cut short can't be told from disk).
   *  Left out, nothing is run at all. */
  runs?: (cli: string) => string | null;
  /** How a path is shown to a person. */
  tilde: (p: string) => string;
}

/** The real path of a folder that is there, in the case the disk keeps it in, or of the
 *  nearest folder above one that isn't. */
export function spelled(p: string): string {
  const abs = path.resolve(p);
  for (let d = abs; ; d = path.dirname(d)) {
    try {
      return path.join(realpathSync.native(d), path.relative(d, abs));
    } catch {
      if (path.dirname(d) === d) return abs;
    }
  }
}

const subdirs = (dir: string): string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
};

/** Volta keeps each global package in a folder of its own, and its command in a shim. */
const volta = (o: Looking): string =>
  path.join(o.env.VOLTA_HOME || path.join(o.home, ".volta"), "tools", "image", "packages", "sessionpipe");

/** Every folder known to be some Node's global prefix on this computer. */
export function prefixesOf(o: Looking): string[] {
  const e = o.env;
  const h = o.home;
  return [
    path.dirname(path.dirname(o.execPath)),
    o.npmPrefix,
    e.npm_config_prefix,
    e.N_PREFIX,
    path.join(h, ".local"),
    path.join(h, ".npm-global"),
    "/usr/local",
    "/usr",
    "/opt/homebrew",
    "/home/linuxbrew/.linuxbrew",
    ...subdirs(path.join(e.NVM_DIR || path.join(h, ".nvm"), "versions", "node")),
    ...subdirs(path.join(e.FNM_DIR || path.join(h, ".local", "share", "fnm"), "node-versions")).map((d) =>
      path.join(d, "installation"),
    ),
    ...subdirs(path.join(e.ASDF_DATA_DIR || path.join(h, ".asdf"), "installs", "nodejs")),
    ...subdirs(path.join(h, ".local", "share", "mise", "installs", "node")),
    ...subdirs(path.join(h, ".nodenv", "versions")),
    // The one-line installer's own Node.
    ...subdirs(path.join(h, ".local", "share")).filter((d) => path.basename(d).startsWith("node-v")),
    volta(o),
  ].filter((p): p is string => !!p);
}

const modulesOf = (prefix: string): string => path.join(prefix, "lib", "node_modules");

/** May this user write a folder, or make it where it isn't there yet? */
export function canWrite(dir: string): boolean {
  for (let d = dir; ; d = path.dirname(d)) {
    try {
      accessSync(d, constants.W_OK);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT" || path.dirname(d) === d) return false;
    }
  }
}

/** Something has this name, a link that leads nowhere included. */
const isThere = (p: string): boolean => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/** The package folder a `…/dist/cli.js` is in; null for any other file. */
const packageOf = (cli: string | null): string | null =>
  cli && path.basename(cli) === "cli.js" && path.basename(path.dirname(cli)) === "dist"
    ? path.dirname(path.dirname(cli))
    : null;

export function look(o: Looking): Inventory {
  // One spelling for one folder, for the whole look: the plan compares the paths of an
  // inventory as they are, so a folder reached by two names (another case on a disk that
  // ignores it, a link, a volume mounted twice) must come out as one. A folder that is
  // there is known by its device and inode, and spelled by its own name under the one
  // spelling of the folder it is really in (so what is inside a folder with two names has
  // one name too); one that isn't there, by the folder above it. The home folder is
  // spelled first: it is how a person reads the rest.
  const names = new Map<string, string>();
  const one = (p: string): string => {
    const abs = path.resolve(p);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(abs);
    } catch {
      const up = path.dirname(abs);
      return up === abs ? abs : path.join(one(up), path.basename(abs));
    }
    const key = `${st.dev}:${st.ino}`;
    const had = names.get(key);
    if (had !== undefined) return had;
    const real = spelled(abs);
    const up = path.dirname(real);
    const name = up === real ? real : path.join(one(up), path.basename(real));
    names.set(key, name);
    return name;
  };
  one(o.home);
  const uniq = (list: string[]): string[] => [...new Set(list)];
  const reach = o.reach === true || o.reach === null ? o.reach : one(o.reach);
  const inReach = (p: string) => reach === true || (reach !== null && within(reach, p));

  // PATH, each folder once: a folder named twice (/bin and /usr/bin, a home reached through
  // a link) is looked in once, and a link in it is read from where it really is.
  const pathDirs = uniq((o.env.PATH ?? "").split(path.delimiter).filter(Boolean).map(one));
  // A prefix is a folder that was looked in as one: the places a Node keeps its global
  // packages, and a PATH folder whose own npm link leads into the `lib` beside it. A
  // `lib/node_modules` anywhere else is some project's.
  const prefixes = uniq(
    [
      ...prefixesOf(o),
      ...pathDirs.flatMap((dir) => {
        const to = binTarget(path.join(dir, "sessionpipe"));
        const prefix = path.dirname(dir);
        return path.basename(dir) === "bin" && to && same(to, path.join(modulesOf(prefix), "sessionpipe"))
          ? [prefix]
          : [];
      }),
    ].map(one),
  ).filter(inReach);
  const cache = o.env.npm_config_cache || path.join(o.home, ".npm");
  const npx = one(path.join(cache, "_npx"));
  const proving: Proving = { reach, prefixes, npx };

  // --- every folder that may hold one ---------------------------------------------------
  const dirs = new Set<string>();
  const add = (dir: string) => {
    if (inReach(dir)) dirs.add(dir);
  };
  const onPath: Inventory["onPath"] = [];
  const dangling: string[] = [];
  const strangers: Inventory["strangers"] = [];
  for (const dir of pathDirs) {
    const file = path.join(dir, "sessionpipe");
    let linked: boolean;
    try {
      linked = lstatSync(file).isSymbolicLink();
    } catch {
      continue;
    }
    // npm and npx put `node_modules/.bin` folders first on PATH for the one run they start
    // (the cache entry's, the project's they were started in): nobody types those, and a
    // shell opened afterwards doesn't find them. A cache entry itself is found in the
    // cache, below. A `.bin` a person put on their own PATH is theirs, and is looked in.
    if (!inReach(file) || (o.env.npm_command && /[\\/]node_modules[\\/]\.bin$/.test(dir))) continue;
    const led = binTarget(file);
    if (led) {
      const to = one(led);
      onPath.push({ file, dir: to });
      if (isThere(to)) add(to);
      else dangling.push(file);
      continue;
    }
    // A link of someone's own to a `…/dist/cli.js`: the folder it starts is known without
    // running it (a checkout, a build). Any other file says nothing of what it starts.
    let folder: string | null = null;
    try {
      folder = linked ? packageOf(realpathSync(file)) : null;
    } catch {}
    onPath.push({ file, dir: folder && one(folder) });
    if (folder) add(one(folder));
    else strangers.push({ file, why: linked ? "a link to no install of sessionpipe" : "a file npm didn't put there" });
  }
  for (const p of prefixes) {
    const slot = path.join(modulesOf(p), "sessionpipe");
    // By its one spelling: a slot that is a link to a folder is that folder.
    if (isThere(slot)) add(one(slot));
    for (const d of subdirs(modulesOf(p))) if (ASIDE.test(path.basename(d))) add(d);
    // A bin link in a prefix that is not on PATH, left with nothing behind it.
    const link = path.join(one(path.join(p, "bin")), "sessionpipe");
    const to = binTarget(link);
    if (to && !isThere(to) && !dangling.includes(link) && inReach(link)) dangling.push(link);
  }
  for (const entry of subdirs(npx)) {
    const d = path.join(entry, "node_modules", "sessionpipe");
    if (isThere(d)) add(one(d));
  }
  const mine = one(path.dirname(o.distDir));
  add(mine);
  const served = packageOf(o.serviceCli);
  const serving = served && isThere(served) ? one(served) : null;
  if (serving) add(serving);

  // --- what typing starts ---------------------------------------------------------------
  // The first on PATH that starts something: a link to a copy that is gone starts nothing,
  // and a shell goes on to the next.
  const first = onPath.find((e) => !e.dir || isThere(e.dir)) ?? null;
  const installed = (dir: string): boolean => {
    const p = prove(dir, proving);
    return p.is === "folder" && p.slot === "global" && !p.aside;
  };
  // A file that leads to no folder says nothing of what it starts, with one exception: at
  // the command path of a prefix that holds an installed copy it is no shim of anyone's,
  // it sits where that copy's link was (`inWay`), and nothing is typed. Any other such
  // file (a version manager's shim, a wrapper) is what started this command where this
  // command was started as npm's link to an installed copy, which is how a shim starts
  // one; started any other way (npx, a cli.js by its path) it can't be told.
  const opaque = first && !first.dir ? first.file : null;
  const under = opaque && path.basename(path.dirname(opaque)) === "bin" ? path.dirname(path.dirname(opaque)) : null;
  const inWay = under && installed(path.join(modulesOf(under), "sessionpipe")) ? under : null;
  const through = binTarget(o.started);
  const shimmed = !!opaque && !inWay && installed(mine) && !!through && same(through, mine);
  const typed = opaque ? (shimmed ? mine : null) : (first?.dir ?? null);
  const unsure = opaque && !inWay && !shimmed ? opaque : null;

  // --- what each is ---------------------------------------------------------------------
  const copies: Copy[] = [...dirs].map((dir) => {
    const proof = prove(dir, proving);
    const slot = proof.is === "folder" ? proof.slot : null;
    let version: string | null = null;
    try {
      const j = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (j.name === "sessionpipe" && typeof j.version === "string" && parseVersion(j.version)) version = j.version;
    } catch {}
    const cli = path.join(dir, "dist", "cli.js");
    // Left behind: by its name, or ours with no release to name (the proof takes such a
    // folder only when it is empty).
    const aside = ASIDE.test(path.basename(dir)) || (slot !== null && version === null);
    const prefix = slot === "global" ? prefixOfSlot(dir) : null;
    const kept = same(prefixOfSlot(dir), volta(o));
    const bins = binsOf(dir, proving);
    let whole = false;
    try {
      whole = statSync(cli).isFile();
    } catch {}
    // The one copy that is asked whether it runs: what typing starts, where that is a
    // folder the proof accepts and not the copy running now.
    const ran = whole && slot && !kept && dir === typed && dir !== mine && o.runs ? { said: o.runs(cli) } : null;
    return {
      dir,
      // An npx cache entry by its own folder (`~/.npm/_npx/<id>` says what it is); what is
      // no install, by the folder itself.
      where: o.tilde(slot === "npx" ? path.dirname(path.dirname(dir)) : slot === "global" ? prefixOfSlot(dir) : dir),
      prefix,
      slot: kept ? null : slot,
      not: kept ? "Volta keeps it" : proof.is === "not" ? proof.why : null,
      aside,
      version,
      wrong: aside
        ? "left behind by an install that was cut off"
        : !whole
          ? "its dist/cli.js is missing (an install that was cut off?)"
          : ran && ran.said === null
            ? "it doesn't run: `--version` printed nothing"
            : ran && ran.said !== version
              ? `it says it is ${ran.said}, and its package.json says ${version}`
              : // Whole, and nothing can start it: npm's link to it was taken away or written
                // over. (An npx cache entry is started by npx, by its path.)
                slot === "global" && !bins.length
                ? "npm's link to it is gone"
                : null,
      bins,
      uses: [
        ...(dir === typed ? (["typed"] as const) : []),
        ...(dir === serving ? (["service"] as const) : []),
        ...(dir === mine ? (["this"] as const) : []),
      ],
      onPath: slot === "global" && pathDirs.includes(one(path.join(prefixOfSlot(dir), "bin"))),
      writable: canWrite(path.dirname(dir)),
      keeper: kept ? "volta uninstall sessionpipe" : null,
    };
  });
  // The hooks run files of their own, written by one release: the copy of that release
  // that something uses beside this very command, else one that is no npx cache entry
  // (npx's runner writes no hooks of its own to stay), else the first of it.
  const wrote = copies.filter((c) => !!o.hooksVersion && c.version === o.hooksVersion);
  (wrote.find((c) => c.uses.some((u) => u !== "this")) ?? wrote.find((c) => c.slot !== "npx") ?? wrote[0])?.uses.push(
    "hooks",
  );

  // --- where the one copy lives -----------------------------------------------------------
  let taken: Inventory["taken"] = null;
  const homeAt = (given: string, why: string): Home | null => {
    const prefix = one(given);
    // Only a prefix that was looked in as one (a link someone made into a folder that is
    // gone names no place to install into), and not one whose slot holds what is not ours.
    // A place for a fresh copy is also not Homebrew's versioned folder (gone at the next
    // `brew upgrade node`) nor Volta's; the folder of the copy that is typed is what it is.
    if (!prefixes.includes(prefix)) return null;
    if (!typed && (/[\\/]Cellar[\\/]node(?:@\d+)?[\\/]/.test(prefix) || same(prefix, volta(o)))) return null;
    const slot = path.join(modulesOf(prefix), "sessionpipe");
    const held = isThere(slot) ? prove(slot, proving) : null;
    if (held?.is === "not") {
      // What is there is not provably sessionpipe's, so it is not this command's to remove
      // or to move: no home. It is kept in mind for the refusal, should no other place do.
      taken ??= { dir: slot, why: held.why };
      return null;
    }
    const bin = one(path.join(prefix, "bin"));
    const file = path.join(bin, "sessionpipe");
    const to = binTarget(file);
    return {
      prefix,
      shown: o.tilde(prefix),
      why,
      bin,
      onPath: pathDirs.includes(bin),
      blocked: isThere(file) && !(to && same(to, slot)) ? file : null,
      writable: canWrite(modulesOf(prefix)) && canWrite(path.join(prefix, "bin")),
    };
  };
  // The home is where the copy lives that typing starts: never another place because that
  // one can't be written. With nothing typed, it is a place a shell would find a fresh one.
  const by = (u: Use) => copies.find((c) => c.uses.includes(u) && c.slot === "global")?.prefix;
  const typedCopy = copies.find((c) => c.dir === typed);
  const places: [string | null | undefined, string][] = typed
    ? typedCopy?.slot === "global"
      ? [[typedCopy.prefix, "where the one you type is"]]
      : []
    : unsure
      ? []
      : [
          [inWay, "where the copy is whose link is gone"],
          ...dangling.map((f): [string, string] => [
            prefixOfSlot(binTarget(f) as string),
            "where a link to it already is",
          ]),
          [by("this"), "where this command runs from"],
          [by("service"), "where the one the background service runs is"],
          ...copies
            .filter((c) => c.slot === "global" && !c.aside)
            .map((c): [string | null, string] => [c.prefix, "where another copy of it already is"]),
          [o.npmPrefix, "npm's global folder"],
          [path.join(o.home, ".local"), "a folder of your own"],
        ];
  const homes = places.flatMap(([p, why]) => {
    const h = p ? homeAt(p, why) : null;
    return h ? [h] : [];
  });
  const home = homes.find((h) => h.onPath) ?? homes[0] ?? null;
  return {
    reach,
    copies,
    dangling,
    strangers,
    onPath,
    typed,
    unsure,
    inferred: shimmed ? opaque : null,
    home,
    taken: home ? null : taken,
    prefixes,
    npx,
  };
}
