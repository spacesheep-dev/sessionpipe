// SPDX-License-Identifier: Apache-2.0
// What `sessionpipe reinstall` may remove, said once, and the one function that removes.
// Nothing else in this folder deletes anything, and nothing here is handed to npm or to a
// shell to delete (a test reads the sources to hold that).
//
// Ours to remove is only what is provably a published sessionpipe package:
//
//   a folder   a real folder, never a link, named `node_modules/sessionpipe`, or one npm
//              left behind from an install that was cut off (`.sessionpipe-XXXXXXXX`,
//              which is also the name of the folder this command has npm install into
//              before it swaps the copy in); in the global folder of a prefix that was
//              looked in as one (`<prefix>/lib/node_modules`: a folder of that shape
//              anywhere else is a project's) or in an entry of the npx cache that was
//              looked in; holding nothing a published package doesn't; and with a
//              package.json that says it is sessionpipe, of some release.
//   its link   the bin link npm made for it: a link whose text leads into that folder.
//              It goes with its folder. By itself a link is ours only when the folder
//              it leads to is gone; nothing is ever removed through one.
//
// So a checkout, a build, a folder someone linked, a project's own dependency and a file
// that only has the name are all refused, with the reason in words. A folder is the same
// folder by whatever name it is reached (its device and inode), and the copy a run has
// just put in place is refused whatever else holds.
import {
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { parseVersion } from "@sessionpipe/core/version";
import { clean } from "../style.js";

/** Which folders this sessionpipe may call this computer's: everything (`true`), only
 *  what lies inside one folder (a world of its own: a test, an agent's sandbox), or
 *  nothing (`null`). */
export type Reach = true | string | null;

export interface Proving {
  reach: Reach;
  /** The prefixes that were looked in as npm's global ones. A global slot is the
   *  `lib/node_modules` of one of these: by its shape alone it could be any project's. */
  prefixes: readonly string[];
  /** The npx cache that was looked in (`<npm's cache>/_npx`); null for none. */
  npx: string | null;
  /** Folders that are never removed: the copy this run put in place. */
  keep?: readonly string[];
  /** Folders this very run had npm install into, beside a slot. One of these is ours by
   *  who made it, whatever the release that npm unpacked there holds; a folder of that
   *  shape that was only found must hold a copy the proof accepts. */
  made?: readonly string[];
}

/** Every entry a published sessionpipe has at its top; the manifest is the last to go. */
const REST = ["dist", "README.md", "LICENSE", "NOTICE"] as const;
const PUBLISHED: ReadonlySet<string> = new Set(["package.json", ...REST]);
/** What an operating system drops into a folder by itself when someone looks at it: the
 *  Finder's `.DS_Store`, Explorer's `Thumbs.db` and `desktop.ini`. Nobody put them there
 *  and nobody misses them, so they say nothing about whose a folder is, and go with it. */
const DROPPED: ReadonlySet<string> = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
/** What npm calls a folder it has moved out of the way, and what this command calls the
 *  folder it has npm install into. */
export const ASIDE = /^\.sessionpipe-[A-Za-z0-9]{8}$/;

export const within = (root: string, p: string): boolean => {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};
const inReach = (o: Proving, p: string): boolean => o.reach === true || (o.reach !== null && within(o.reach, p));

/** One folder, by whatever name: the same device and inode (a home reached through a
 *  link, another case on a disk that ignores it, a volume mounted twice). What is not
 *  there is the same only by its name. */
export function same(a: string, b: string): boolean {
  if (path.resolve(a) === path.resolve(b)) return true;
  try {
    const [x, y] = [statSync(a), statSync(b)];
    return x.dev === y.dev && x.ino === y.ino;
  } catch {
    return false;
  }
}

/** A path by the real name of the folder it is in (a folder on the way to it may be a
 *  link to somewhere else); null when that folder can't be read. */
const really = (p: string): string | null => {
  try {
    return path.join(realpathSync(path.dirname(p)), path.basename(p));
  } catch {
    return null;
  }
};

export type Slot = "global" | "npx";
/** What a path is: a folder that is ours (and in which kind of slot), a bin link that is
 *  ours, or neither, with why. `staging`: a folder npm was told to install into. */
export type Proof =
  | { is: "folder"; slot: Slot; aside: boolean; staging: boolean }
  | { is: "link" }
  | { is: "not"; why: string };

const not = (why: string): Proof => ({ is: "not", why });

/** The slot a package folder sits in; null for any other place. */
export function slotOf(dir: string, o: Proving): Slot | null {
  const modules = path.dirname(dir);
  if (path.basename(modules) !== "node_modules") return null;
  const above = path.dirname(modules);
  if (o.npx !== null && same(path.dirname(above), o.npx)) return "npx";
  return path.basename(above) === "lib" && o.prefixes.some((p) => same(p, path.dirname(above))) ? "global" : null;
}

/** The npm prefix a global package folder belongs to. */
export const prefixOfSlot = (dir: string): string => path.dirname(path.dirname(path.dirname(dir)));

/** Is this bin link npm's own for the package folder it names? The folder it leads to,
 *  read from the link itself and never followed; null when it is anything else (a script
 *  someone wrote, a link to somewhere that is no sessionpipe). */
export function binTarget(file: string): string | null {
  try {
    if (!lstatSync(file).isSymbolicLink() || path.basename(file) !== "sessionpipe") return null;
    // A relative link leads from the folder it is really in, by whatever name (a link to
    // that folder) the file was reached.
    const to = path.resolve(realpathSync(path.dirname(file)), readlinkSync(file));
    const m = /^(.*[\\/]node_modules[\\/]sessionpipe)[\\/]dist[\\/]cli\.js$/.exec(to);
    return m ? (m[1] as string) : null;
  } catch {
    return null;
  }
}

/** The bin links that are this package folder's own, and in reach as it must be. */
export function binsOf(dir: string, o: Proving): string[] {
  const modules = path.dirname(dir);
  const slot = slotOf(dir, o);
  const at =
    slot === "npx" ? path.join(modules, ".bin") : slot === "global" ? path.join(prefixOfSlot(dir), "bin") : null;
  if (!at) return [];
  const file = path.join(at, "sessionpipe");
  const to = binTarget(file);
  const real = really(file);
  // In reach by its name and by where it really is.
  return inReach(o, file) && real !== null && inReach(o, real) && to !== null && same(to, dir) ? [file] : [];
}

/** The entries of a real folder (never a link to one); null for anything else. */
const entries = (dir: string): string[] | null => {
  try {
    return lstatSync(dir).isDirectory() ? readdirSync(dir) : null;
  } catch {
    return null;
  }
};
const only = (dir: string, names: readonly string[]): boolean =>
  entries(dir)?.every((e) => names.includes(e) || DROPPED.has(e)) ?? false;

/** The entry of a folder that no published sessionpipe has; null where it holds nothing
 *  but those; undefined where it is no real folder that can be read. */
const extra = (dir: string): string | null | undefined => {
  const all = entries(dir);
  return all === null ? undefined : (all.find((e) => !PUBLISHED.has(e) && !DROPPED.has(e)) ?? null);
};

/** Nothing in it but, at most, what a system dropped there. */
const empty = (dir: string): boolean => entries(dir)?.every((e) => DROPPED.has(e)) ?? false;

/** Why a folder's package.json does not say it is a release of sessionpipe; null where
 *  it does. */
function unnamed(dir: string): string | null {
  let manifest: { name?: unknown; version?: unknown };
  try {
    manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as typeof manifest;
  } catch {
    return "it has no package.json that can be read (an install that was cut off?)";
  }
  if (manifest.name !== "sessionpipe")
    return `its package.json says it is ${clean(JSON.stringify(manifest.name) ?? "nothing")}, not sessionpipe`;
  return typeof manifest.version === "string" && parseVersion(manifest.version)
    ? null
    : "its package.json names no release of sessionpipe";
}

/** A folder this command had npm install into, as npm lays a prefix out for one package:
 *  `lib/node_modules/sessionpipe` (while it is still there), npm's own list beside it,
 *  and `bin/sessionpipe`. Nothing else, each a real folder, and no link on the way. */
function staged(dir: string, made: boolean): boolean {
  const modules = path.join(dir, "lib", "node_modules");
  const copy = path.join(modules, "sessionpipe");
  const link = path.join(dir, "bin", "sessionpipe");
  const holds = (d: string, names: readonly string[]): boolean => gone(d) || only(d, names);
  return (
    only(dir, ["lib", "bin"]) &&
    holds(path.join(dir, "bin"), ["sessionpipe"]) &&
    (gone(link) || binTarget(link) !== null) &&
    holds(path.join(dir, "lib"), ["node_modules"]) &&
    holds(modules, ["sessionpipe", ".package-lock.json"]) &&
    // What npm unpacked there is a copy by the same proof as any other, or nothing yet;
    // or it is what this run asked npm for, a moment ago.
    (gone(copy) || empty(copy) || (extra(copy) === null && unnamed(copy) === null) || (made && entries(copy) !== null))
  );
}

/** The proof, in one place. */
export function prove(asked: string, o: Proving): Proof {
  // The path by its one spelling: with a slash after its name, a link to a folder would
  // be looked at as the folder it leads to.
  const what = path.resolve(asked);
  if (!inReach(o, what)) return not("it is outside the folders this sessionpipe keeps its own files in");
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(what);
  } catch {
    return not("nothing is there");
  }
  const base = path.basename(what);
  // Where it really is: what is outside the reach is outside it by whatever name inside
  // leads there.
  const real = really(what);
  if (real === null) return not("the folder it is in can't be read");
  if (!inReach(o, real)) return not("it is outside the folders this sessionpipe keeps its own files in");
  if (!st.isDirectory()) {
    // A bin link is ours when it names a sessionpipe slot that is ours or is gone.
    const to = binTarget(what);
    if (!to)
      return not(
        st.isSymbolicLink()
          ? "it is a link that doesn't lead into a sessionpipe install"
          : "it is a file npm didn't put there",
      );
    if (!slotOf(to, o)) return not("it leads to a sessionpipe that is not a global install or an npx cache entry");
    // The link of a copy that is there goes with that copy, never by itself: taking it
    // away alone would leave a copy nobody can type.
    return gone(to) ? { is: "link" } : not("it is the link of a copy that is there");
  }
  // The copy this run put in place, by whatever name it is asked for.
  if (o.keep?.some((k) => same(k, what))) return not("it is the copy this run put in place");
  const aside = ASIDE.test(base);
  if (base !== "sessionpipe" && !aside) return not("it is not a folder named node_modules/sessionpipe");
  const slot = slotOf(what, o);
  if (!slot || (aside && slot !== "global"))
    return not("it is not a global install or an npx cache entry (a project's own dependency?)");
  // Where it really is must be the same kind of slot: through a linked folder it may be
  // a project's own dependency.
  if (slotOf(real, o) !== slot) return not("the node_modules folder it is in is a link to somewhere else");
  // A prefix has no package.json beside its node_modules: a project has.
  // (By the name it was asked for and by where it really is.)
  if (slot === "global" && [what, real].some((x) => !gone(path.join(path.dirname(path.dirname(x)), "package.json"))))
    return not("the node_modules folder it is in is a project's own (a package.json is beside it)");
  if (aside && staged(what, o.made?.some((m) => same(m, what)) ?? false))
    return { is: "folder", slot, aside, staging: true };
  const more = extra(what);
  if (more === undefined) return not("it can't be read");
  if (more !== null) return not(`it holds ${clean(more)}, which no published sessionpipe has (a checkout or a build?)`);
  // Nothing in it: what is left of a copy that could only be removed in part. Taking an
  // empty folder away loses nothing.
  if (empty(what)) return { is: "folder", slot, aside, staging: false };
  const flaw = unnamed(what);
  return flaw ? not(flaw) : { is: "folder", slot, aside, staging: false };
}

const gone = (p: string): boolean => {
  try {
    lstatSync(p);
    return false;
  } catch {
    return true;
  }
};

/** Refused: the path is not provably ours. */
export class NotOurs extends Error {
  constructor(
    readonly what: string,
    readonly why: string,
  ) {
    super(`${what} was left alone: ${why}`);
  }
}

/** Remove one thing that is ours: a package folder with its own bin link, or a bin link
 *  whose folder is gone. The proof comes first; nothing but this function deletes, and
 *  npm is not asked to (it takes whatever is at a prefix's command path, its own link or
 *  not). A folder is emptied with its package.json last, so one that could only be
 *  removed in part is still provably ours for the run that comes back to it: that is
 *  said, never passed over. Answers what is gone; throws `NotOurs` for anything else,
 *  having removed nothing. */
export function remove(asked: string, o: Proving): string[] {
  // What is proven is what is removed: the path by its one spelling, for both.
  const what = path.resolve(asked);
  const p = prove(what, o);
  if (p.is === "not") throw new NotOurs(what, p.why);
  if (p.is === "link") {
    unlinkSync(what);
    return [what];
  }
  const bins = binsOf(what, o);
  try {
    if (p.staging) rmSync(what, { recursive: true });
    else {
      for (const e of [...REST, ...DROPPED]) rmSync(path.join(what, e), { recursive: true, force: true });
      rmSync(path.join(what, "package.json"), { force: true });
      rmdirSync(what);
    }
  } catch (e) {
    throw new Error(
      `${what} could only be removed in part (${(e as Error).message}): what is left of it no longer runs, and the next run takes it`,
    );
  }
  // Its own link, which leads nowhere now.
  for (const b of bins) unlinkSync(b);
  return [what, ...bins];
}
