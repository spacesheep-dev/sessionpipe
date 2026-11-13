// SPDX-License-Identifier: Apache-2.0
// What `sessionpipe reinstall` may remove, said once, and the one function that removes.
// Nothing else in this folder deletes anything (a test reads the sources to hold that).
//
// Ours to remove is only what is provably a published sessionpipe package:
//
//   a folder   a real folder, never a link, named `node_modules/sessionpipe`, or one npm
//              left behind from an install that was cut off (`.sessionpipe-XXXXXXXX`,
//              which is also the name this command gives the folder it moves aside);
//              in a global slot (`<prefix>/lib/node_modules`, on Windows
//              `<prefix>\node_modules` of a prefix that was looked in as one) or in an
//              npx cache entry (`_npx/<id>/node_modules`); holding nothing a published
//              package doesn't; and, where its package.json can be read, named sessionpipe.
//   its link   the bin link npm made for it: a link whose text leads into that folder
//              (on Windows the shims npm wrote, which name it). It goes with its folder.
//              By itself a link is ours only when the folder it leads to is gone;
//              nothing is ever removed through one.
//
// So a checkout, a build, a folder someone linked, a project's own dependency and a file
// that only has the name are all refused, with the reason in words.
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, unlinkSync } from "node:fs";
import path from "node:path";

/** Which folders this sessionpipe may call this computer's: everything (`true`), only
 *  what lies inside one folder (a world of its own: a test, an agent's sandbox), or
 *  nothing (`null`). */
export type Reach = true | string | null;

export interface Proving {
  platform: NodeJS.Platform;
  reach: Reach;
  /** Windows: the prefixes that were looked in as npm's global ones. A global slot there
   *  has the shape of any project's `node_modules`, so only these count. */
  prefixes: readonly string[];
}

/** Every entry a published sessionpipe has at its top. */
const PUBLISHED: ReadonlySet<string> = new Set(["package.json", "dist", "README.md", "LICENSE", "NOTICE"]);
/** What npm calls a folder it has moved out of the way, and what this command calls one. */
export const ASIDE = /^\.sessionpipe-[A-Za-z0-9]{8}$/;
/** The names npm gives the command in a prefix on Windows. */
export const SHIMS = ["sessionpipe", "sessionpipe.cmd", "sessionpipe.ps1"] as const;
/** How npm's shim names the cli.js it runs, from where the shim sits: in a prefix, the
 *  package under it; in a `.bin`, the package beside it. */
const NAMES_IT = /node_modules[\\/]sessionpipe[\\/]dist[\\/]cli\.js/;
const NAMES_IT_BESIDE = /\.\.[\\/]sessionpipe[\\/]dist[\\/]cli\.js/;

export const within = (root: string, p: string): boolean => {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};
const inReach = (o: Proving, p: string): boolean => o.reach === true || (o.reach !== null && within(o.reach, p));
const same = (a: string, b: string, o: Proving): boolean =>
  o.platform === "win32"
    ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
    : path.resolve(a) === path.resolve(b);

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
 *  ours, or neither, with why. */
export type Proof = { is: "folder"; slot: Slot; aside: boolean } | { is: "link" } | { is: "not"; why: string };

const not = (why: string): Proof => ({ is: "not", why });

/** The slot a package folder sits in by its path alone; null for any other place. */
export function slotOf(dir: string, o: Proving): Slot | null {
  const modules = path.dirname(dir);
  if (path.basename(modules) !== "node_modules") return null;
  const above = path.dirname(modules);
  if (path.basename(path.dirname(above)) === "_npx") return "npx";
  if (o.platform === "win32") return o.prefixes.some((p) => same(p, above, o)) ? "global" : null;
  return path.basename(above) === "lib" ? "global" : null;
}

/** The npm prefix a global package folder belongs to. */
export const prefixOfSlot = (dir: string, platform: NodeJS.Platform): string =>
  platform === "win32" ? path.dirname(path.dirname(dir)) : path.dirname(path.dirname(path.dirname(dir)));

/** Is this bin link (or, on Windows, shim) npm's own for the package folder it names?
 *  The folder it leads to, read from the link itself and never followed; null when it is
 *  anything else (a script someone wrote, a link to somewhere that is no sessionpipe). */
export function binTarget(file: string, platform: NodeJS.Platform): string | null {
  try {
    const st = lstatSync(file);
    if (platform === "win32") {
      if (!st.isFile() || !SHIMS.includes(path.basename(file).toLowerCase() as (typeof SHIMS)[number])) return null;
      const dir = path.dirname(file);
      // npm's shim sits in the prefix itself, or in a `.bin` beside the package.
      const beside = path.basename(dir) === ".bin";
      if (!(beside ? NAMES_IT_BESIDE : NAMES_IT).test(readFileSync(file, "utf8"))) return null;
      return path.join(beside ? path.dirname(dir) : path.join(dir, "node_modules"), "sessionpipe");
    }
    if (!st.isSymbolicLink() || path.basename(file) !== "sessionpipe") return null;
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
    slot === "npx"
      ? [path.join(modules, ".bin")]
      : slot === "global"
        ? [o.platform === "win32" ? path.dirname(modules) : path.join(prefixOfSlot(dir, o.platform), "bin")]
        : [];
  return at
    .flatMap((d) => (o.platform === "win32" ? SHIMS : (["sessionpipe"] as const)).map((n) => path.join(d, n)))
    .filter((f) => {
      const to = binTarget(f, o.platform);
      const at = really(f);
      // In reach by its name and by where it really is.
      return inReach(o, f) && at !== null && inReach(o, at) && to !== null && same(to, dir, o);
    });
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
    const to = binTarget(what, o.platform);
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
  const aside = ASIDE.test(base);
  if (base !== "sessionpipe" && !aside) return not("it is not a folder named node_modules/sessionpipe");
  const slot = slotOf(what, o);
  if (!slot || (aside && slot !== "global"))
    return not("it is not a global install or an npx cache entry (a project's own dependency?)");
  // Where it really is must be the same kind of slot: through a linked folder it may be
  // a project's own dependency.
  if (slotOf(real, o) !== slot) return not("the node_modules folder it is in is a link to somewhere else");
  let entries: string[];
  try {
    entries = readdirSync(what);
  } catch {
    return not("it can't be read");
  }
  const extra = entries.find((e) => !PUBLISHED.has(e));
  if (extra) return not(`it holds ${extra}, which no published sessionpipe has (a checkout or a build?)`);
  try {
    const name = (JSON.parse(readFileSync(path.join(what, "package.json"), "utf8")) as { name?: unknown }).name;
    if (name !== "sessionpipe") return not(`its package.json says it is ${JSON.stringify(name)}, not sessionpipe`);
  } catch {
    // None, or cut off half-way: an install that broke. Still npm's slot for sessionpipe.
  }
  return { is: "folder", slot, aside };
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

/** Remove one thing that is ours: a package folder with its own bin links, or a bin link
 *  whose folder is gone. The proof comes first and again before each deletion. A global
 *  install is first handed to npm (`npm`, when given), which keeps its own books; what
 *  is still there afterwards is taken away here. Answers what is gone; throws `NotOurs`
 *  for anything else, having removed nothing. */
export async function remove(
  asked: string,
  o: Proving & {
    npm?: (prefix: string) => Promise<unknown>;
    /** Only the folder: its bin link stays, and npm (which would take it) is not asked. */
    alone?: boolean;
  },
): Promise<string[]> {
  // What is proven is what is removed: the path by its one spelling, for both.
  const what = path.resolve(asked);
  const p = prove(what, o);
  if (p.is === "not") throw new NotOurs(what, p.why);
  if (p.is === "link") {
    unlinkSync(what);
    return [what];
  }
  const bins = o.alone ? [] : binsOf(what, o);
  if (o.npm && !o.alone && p.slot === "global" && !p.aside) await o.npm(prefixOfSlot(what, o.platform)).catch(() => {});
  // Whatever npm left (or all of it, where npm was not asked), proven again first.
  if (prove(what, o).is === "folder") rmSync(what, { recursive: true });
  // Still there: npm left something in it that is not a published sessionpipe's, and
  // the second proof refused it. Said, never answered as gone, and its link stays with it.
  if (!gone(what)) throw new NotOurs(what, "after npm ran it was no longer provably a published sessionpipe");
  // And each link: it goes only while it is still this folder's own.
  const still = binsOf(what, o);
  for (const b of bins) if (still.includes(b)) unlinkSync(b);
  // What is gone: a link that is another copy's by now is there, and is not answered.
  return [what, ...bins.filter(gone)];
}
