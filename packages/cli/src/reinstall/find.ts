// SPDX-License-Identifier: Apache-2.0
// The look `sessionpipe reinstall` takes at this computer before it decides anything:
// every copy of sessionpipe it can find and what each is used by. It only reads.
//
// Where it looks: every `sessionpipe` on PATH (all of them, not the first); the copy the
// service file names; the copy this command runs from; the global folder of every Node it
// knows a place for (this one's, npm's own answer, ~/.local, Homebrew, /usr/local, nvm,
// fnm, asdf, mise, nodenv, n, Volta, the installer's own Node; on Windows %AppData%\npm,
// Program Files and nvm-windows); and the npx cache.
import { accessSync, constants, existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import {
  ASIDE,
  binsOf,
  binTarget,
  type Proving,
  prefixOfSlot,
  prove,
  type Reach,
  SHIMS,
  type Slot,
  within,
} from "./ours.js";

export type Use = "typed" | "service" | "hooks" | "this";

export interface Copy {
  /** The package folder. */
  dir: string;
  /** Where it is, for a person: its npm prefix, or which cache. */
  where: string;
  /** Its npm prefix, for a global install. */
  prefix: string | null;
  /** Ours to remove, and in which kind of slot; null where it is not, with why in `not`. */
  slot: Slot | null;
  not: string | null;
  /** npm's own leftover from an install that was cut off (or ours, from a run that was). */
  aside: boolean;
  /** What its package.json says; null when that can't be read. */
  version: string | null;
  /** `--version` from it printed that version. */
  runs: boolean;
  /** What is wrong with it, in a few words; null when nothing. */
  wrong: string | null;
  /** Its own bin links. */
  bins: string[];
  uses: Use[];
  /** This user may write where it is. */
  writable: boolean;
  /** Someone else's tool keeps it, and takes it away with this command. */
  keeper: string | null;
}

export interface Inventory {
  platform: NodeJS.Platform;
  reach: Reach;
  copies: Copy[];
  /** Bin links that lead to a sessionpipe that is gone. */
  dangling: string[];
  /** Files named sessionpipe on PATH that are no install of it: left, and said. */
  strangers: { file: string; why: string }[];
  /** Every `sessionpipe` a shell would find, first first, as the package folder each leads
   *  to (null: a file that is no link to one). `at`: which folder of PATH it is in, counted
   *  from the first. npx's own entry for the run it started is not among them. */
  onPath: { file: string; dir: string | null; at: number }[];
  /** Where the fresh copy may go, best first; `shown` is the prefix as a person reads it.
   *  `bin`: the folder its command goes in (on Windows the prefix itself). `pathAt`: which
   *  folder of PATH that is, counted as `onPath` counts; null when it is not on PATH.
   *  `blocked`: a file that sits where npm puts the command there and is not npm's own
   *  link to the copy in this prefix (a script, a link to somewhere else): npm will not
   *  put its link over it, and it is not this command's to move. Null: nothing is. */
  homes: { prefix: string; shown: string; why: string; bin: string; pathAt: number | null; blocked: string | null }[];
  /** The global prefixes that were looked in. */
  prefixes: string[];
}

export interface Looking {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** The home folder in effect. */
  home: string;
  reach: Reach;
  /** The node running this, and this copy's dist folder. */
  execPath: string;
  distDir: string;
  /** npm's own global prefix (`npm prefix -g`); null when npm can't be asked. */
  npmPrefix: string | null;
  /** The cli.js the service file names; null when there is no service file. */
  serviceCli: string | null;
  /** The version the hooks' own files were written by; null when there are none. */
  hooksVersion: string | null;
  /** What `--version` prints when this cli.js is run; null when it doesn't run. */
  version: (cli: string) => string | null;
  /** How a path is shown to a person. */
  tilde: (p: string) => string;
}

/** One spelling for one place: the real path of a folder that is there, or of the nearest
 *  folder above one that isn't. Every path in an inventory is spelled this way, so the
 *  plan can compare them as they are. */
export function spelled(p: string): string {
  const abs = path.resolve(p);
  for (let d = abs; ; d = path.dirname(d)) {
    try {
      return path.join(realpathSync(d), path.relative(d, abs));
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

/** Every folder that may be some Node's global prefix on this computer. */
export function prefixesOf(o: Looking): string[] {
  const e = o.env;
  const h = o.home;
  const all: (string | undefined | null)[] =
    o.platform === "win32"
      ? [
          e.APPDATA && path.join(e.APPDATA, "npm"),
          path.dirname(o.execPath),
          o.npmPrefix,
          e.npm_config_prefix,
          e.ProgramFiles && path.join(e.ProgramFiles, "nodejs"),
          ...(e.NVM_HOME ? subdirs(e.NVM_HOME) : []),
        ]
      : [
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
        ];
  const reach = o.reach === true || o.reach === null ? o.reach : spelled(o.reach);
  return [...new Set(all.filter((p): p is string => !!p).map(spelled))].filter(
    (p) => reach === true || (reach !== null && within(reach, p)),
  );
}

/** Volta keeps each global package in a folder of its own, and its command in a shim. */
const volta = (o: Looking): string =>
  spelled(path.join(o.env.VOLTA_HOME || path.join(o.home, ".volta"), "tools", "image", "packages", "sessionpipe"));

const modulesOf = (prefix: string, platform: NodeJS.Platform): string =>
  platform === "win32" ? path.join(prefix, "node_modules") : path.join(prefix, "lib", "node_modules");

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

export function look(o: Looking): Inventory {
  const prefixes = prefixesOf(o);
  const reach = o.reach === true || o.reach === null ? o.reach : spelled(o.reach);
  const proving: Proving = { platform: o.platform, reach, prefixes };
  const inReach = (p: string) => reach === true || (reach !== null && within(reach, spelled(p)));

  // --- every folder that may hold one ---------------------------------------------------
  const dirs = new Map<string, string>();
  const add = (dir: string | null) => {
    if (dir && inReach(dir)) dirs.set(spelled(dir), spelled(dir));
  };
  const bin = o.platform === "win32" ? "sessionpipe.cmd" : "sessionpipe";
  const onPath: Inventory["onPath"] = [];
  const dangling: string[] = [];
  const strangers: Inventory["strangers"] = [];
  // PATH, each folder by its one spelling: a folder named twice (/bin and /usr/bin, a
  // home reached through a link) is looked in once, and a link in it is read from where
  // it really is, which is where its `..` leads from.
  const pathDirs = [...new Set((o.env.PATH ?? "").split(path.delimiter).filter(Boolean).map(spelled))];
  /** The folder a prefix's command is in, by its one spelling: a `bin` that is a link to
   *  a folder on PATH is that folder. */
  const binOf = (prefix: string): string => spelled(o.platform === "win32" ? prefix : path.join(prefix, "bin"));
  for (const [at, dir] of pathDirs.entries()) {
    const file = path.join(dir, bin);
    let linked: boolean;
    try {
      linked = lstatSync(file).isSymbolicLink();
    } catch {
      continue;
    }
    if (!inReach(file)) continue;
    const led = binTarget(file, o.platform);
    const to = led && spelled(led);
    // npx puts its own cache entry first on PATH for the one run it starts: nobody types
    // that one, and a shell opened afterwards doesn't find it. The entry itself is found
    // in the cache, below.
    if (/[\\/]_npx[\\/][^\\/]+[\\/]node_modules[\\/]\.bin$/.test(dir)) continue;
    onPath.push({ file, dir: to, at });
    if (to && existsSync(to)) add(to);
    else if (to) dangling.push(file);
    else
      strangers.push({
        file,
        why: linked
          ? "a link that leads to no install of sessionpipe"
          : "a file of that name that npm didn't put there",
      });
  }
  for (const p of prefixes) {
    const modules = modulesOf(p, o.platform);
    add(
      existsSync(path.join(modules, "sessionpipe")) || isLink(path.join(modules, "sessionpipe"))
        ? path.join(modules, "sessionpipe")
        : null,
    );
    for (const d of subdirs(modules)) if (ASIDE.test(path.basename(d))) add(d);
    // A bin link in a prefix that is not on PATH, left with nothing behind it.
    const link = path.join(binOf(p), bin);
    const to = binTarget(link, o.platform);
    if (to && !existsSync(to) && !dangling.includes(link) && inReach(link)) dangling.push(link);
  }
  const cache =
    o.env.npm_config_cache ||
    (o.platform === "win32" && o.env.LOCALAPPDATA
      ? path.join(o.env.LOCALAPPDATA, "npm-cache")
      : path.join(o.home, ".npm"));
  for (const entry of subdirs(path.join(cache, "_npx"))) {
    const d = path.join(entry, "node_modules", "sessionpipe");
    if (existsSync(d)) add(d);
  }
  // The package folder a `…/dist/cli.js` is in; anything else a service file may run is
  // no copy of sessionpipe to speak of.
  const packageOf = (cli: string | null): string | null =>
    cli && path.basename(cli) === "cli.js" && path.basename(path.dirname(cli)) === "dist"
      ? path.dirname(path.dirname(cli))
      : null;
  const mine = spelled(path.dirname(o.distDir));
  add(mine);
  const served = packageOf(o.serviceCli);
  if (served && existsSync(served)) add(served);

  // --- what each is ---------------------------------------------------------------------
  // What a person types: the first on PATH that starts something. A link to a copy that
  // is gone starts nothing, and a shell goes on to the next.
  const typed = onPath.find((e) => !e.dir || existsSync(e.dir))?.dir ?? null;
  const is = (a: string | null, b: string) => !!a && spelled(a) === spelled(b);
  const copies: Copy[] = [...dirs.values()].map((dir) => {
    const proof = prove(dir, proving);
    const slot = proof.is === "folder" ? proof.slot : null;
    let version: string | null = null;
    try {
      const j = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (j.name === "sessionpipe" && typeof j.version === "string") version = j.version;
    } catch {}
    const cli = path.join(dir, "dist", "cli.js");
    const said = existsSync(cli) ? o.version(cli) : null;
    const aside = ASIDE.test(path.basename(dir));
    const global = slot === "global" || (!slot && path.basename(path.dirname(path.dirname(dir))) === "lib");
    const prefix = global ? prefixOfSlot(dir, o.platform) : null;
    const kept = is(prefixOfSlot(dir, o.platform), volta(o));
    const bins = binsOf(dir, proving);
    const uses: Use[] = [
      ...(is(typed, dir) ? (["typed"] as const) : []),
      ...(is(packageOf(o.serviceCli), dir) ? (["service"] as const) : []),
      ...(is(mine, dir) ? (["this"] as const) : []),
    ];
    return {
      dir,
      // An npx cache entry by its own folder (`~/.npm/_npx/<id>` says what it is).
      where: o.tilde(slot === "npx" ? path.dirname(path.dirname(dir)) : (prefix ?? dir)),
      prefix,
      slot: kept ? null : slot,
      not: kept ? "Volta keeps it" : proof.is === "not" ? proof.why : null,
      aside,
      version,
      runs: said !== null && said === version,
      wrong: aside
        ? "left behind by an install that was cut off"
        : !existsSync(cli)
          ? "its dist/cli.js is missing (an install that was cut off?)"
          : said === null
            ? "it doesn't run: `--version` printed nothing"
            : said !== version
              ? `it says it is ${said}, and its package.json says ${version ?? "nothing"}`
              : // Whole, and nothing can start it: npm's link to it was taken away or written
                // over. (An npx cache entry is started by npx, by its path.)
                slot === "global" && !bins.length
                ? "npm's link to it is gone"
                : null,
      bins,
      uses,
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

  // --- where the fresh one may go ---------------------------------------------------------
  const homes: Inventory["homes"] = [];
  const offer = (given: string | null | undefined, why: string) => {
    const prefix = given ? spelled(given) : null;
    if (!prefix || !inReach(prefix) || homes.some((x) => x.prefix === prefix)) return;
    // Not Homebrew's versioned folder (gone at the next `brew upgrade node`), not Volta's,
    // not a folder this user can't write, and not one whose slot holds what is not ours.
    if (/[\\/]Cellar[\\/]node(?:@\d+)?[\\/]/.test(prefix) || is(prefix, volta(o))) return;
    const slot = path.join(modulesOf(prefix, o.platform), "sessionpipe");
    if (
      !canWrite(modulesOf(prefix, o.platform)) ||
      !canWrite(o.platform === "win32" ? prefix : path.join(prefix, "bin"))
    )
      return;
    if ((existsSync(slot) || isLink(slot)) && prove(slot, proving).is !== "folder") return;
    const at = pathDirs.indexOf(binOf(prefix));
    // What is at the command's own path and is not npm's link to this prefix's copy.
    const blocked = (o.platform === "win32" ? SHIMS : (["sessionpipe"] as const))
      .map((name) => path.join(binOf(prefix), name))
      .find((file) => isThere(file) && !is(binTarget(file, o.platform), slot));
    homes.push({
      prefix,
      shown: o.tilde(prefix),
      why,
      bin: binOf(prefix),
      pathAt: at < 0 ? null : at,
      blocked: blocked ?? null,
    });
  };
  const by = (u: Use) => copies.find((c) => c.uses.includes(u) && c.slot === "global")?.prefix;
  offer(by("typed"), "where the one you type is");
  offer(by("this"), "where this command runs from");
  offer(by("service"), "where the one the background service runs is");
  // The copy typed may be where this user can't write: another copy's folder that is on
  // PATH will do, before one that isn't.
  for (const c of copies) if (c.slot === "global" && !c.aside) offer(c.prefix, "where another copy of it already is");
  offer(o.npmPrefix, "where npm puts what is installed for every folder");
  offer(
    o.platform === "win32" ? o.env.APPDATA && path.join(o.env.APPDATA, "npm") : path.join(o.home, ".local"),
    "a folder of your own",
  );
  // A folder a shell finds `sessionpipe` in comes before one it doesn't, whatever else
  // speaks for it: a fresh copy nobody can type is no repair.
  homes.sort((a, b) => Number(b.pathAt !== null) - Number(a.pathAt !== null));
  return { platform: o.platform, reach, copies, dangling, strangers, onPath, homes, prefixes };
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

const isLink = (p: string): boolean => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};
