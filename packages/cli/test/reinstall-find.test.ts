// SPDX-License-Identifier: Apache-2.0
// The look `sessionpipe reinstall` takes at a computer (reinstall/find.ts), on computers
// made of temp folders: a home, a PATH, a Node of every kind, npm's cache. Every look but
// one is narrowed to the test's own folder (`reach`), so nothing this machine really has
// can be in an answer; the one that takes `reach: true` has a home of its own and asserts
// only on what lies in the temp folder.
//
// find.ts only reads. Every copy's cli.js here is a file that would write a marker beside
// itself if node ever ran it, and after each test there is none: nothing that was found
// was started. Running a copy is a function the look is handed (`runs`), stood in for by
// one that writes down what it was asked. Nothing is removed here but the temp folder.
//
// The findings of the review this file pins carry their id at the start of a test's
// title: M1 (one folder under two spellings), M3 (the home is where what is typed lives),
// M4 (the look runs nothing it has not proven), M5 (a project's own dependency), L3 (text
// from the disk). What the look answers today and should perhaps not is under "reported,
// not decided here".
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type Copy,
  canWrite,
  type Home,
  type Inventory,
  type Looking,
  look,
  prefixesOf,
  spelled,
} from "../src/reinstall/find.js";
import { prove, slotOf, within } from "../src/reinstall/ours.js";

/** What this file makes node:fs do: answer a look at a folder with an error of its
 *  choosing (`access`, by the code); not know where a path really is (`lost`); not be
 *  able to look at a path at all (`blind`); or take a folder for one that is real under
 *  this name too (`twice`: a volume mounted twice, a firmlink: the same folder by its
 *  device and inode, and no link for a real path to lead through). */
const fake = vi.hoisted(() => ({
  access: null as ((p: string) => string | null) | null,
  lost: null as ((p: string) => boolean) | null,
  blind: null as ((p: string) => boolean) | null,
  twice: null as string | null,
}));
vi.mock("node:fs", async (original) => {
  const m = await original<typeof import("node:fs")>();
  const refused = (code: string, p: string) => Object.assign(new Error(`${code}: ${p}`), { code });
  const accessSync = ((p: unknown, ...rest: unknown[]) => {
    const code = typeof p === "string" ? fake.access?.(p) : null;
    if (code) throw refused(code, p as string);
    return (m.accessSync as (...a: unknown[]) => void)(p, ...rest);
  }) as typeof m.accessSync;
  const statSync = ((p: unknown, ...rest: unknown[]) => {
    if (typeof p === "string" && fake.blind?.(p)) throw refused("ENOENT", p);
    return (m.statSync as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof m.statSync;
  const really =
    (inner: (...a: unknown[]) => unknown) =>
    (p: unknown, ...rest: unknown[]) => {
      if (typeof p === "string") {
        if (fake.lost?.(p)) throw refused("ENOENT", p);
        const under = fake.twice;
        if (under && (p === under || p.startsWith(`${under}/`))) {
          // What is there is real by this name; what is not is not there, as ever.
          m.statSync(p);
          return p;
        }
      }
      return inner(p, ...rest);
    };
  const realpathSync = Object.assign(really(m.realpathSync as (...a: unknown[]) => unknown), {
    native: really(m.realpathSync.native as (...a: unknown[]) => unknown),
  }) as typeof m.realpathSync;
  return { ...m, accessSync, statSync, realpathSync };
});

const win32 = process.platform === "win32";
/** chmod means something: not for root, who may write anywhere. */
const refusable = !win32 && process.getuid?.() !== 0;

/** The whole computer of one test, and the home folder in it. */
let tmp: string;
let home: string;
/** Folders a test made unwritable, made writable again before the temp folder goes. */
let locked: string[];
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sp-find-")));
  home = path.join(tmp, "home");
  mkdirSync(home);
  locked = [];
  searched = [];
});
/** Every marker under a folder: a file a cli.js wrote because it was run. */
const ran = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? ran(p) : e.name.endsWith(".ran") ? [p] : [];
  });
afterEach(() => {
  fake.access = null;
  fake.lost = null;
  fake.blind = null;
  fake.twice = null;
  for (const d of locked) chmodSync(d, 0o755);
  // No test of the look started anything it found.
  const started = ran(tmp);
  rmSync(tmp, { recursive: true, force: true });
  expect(started).toEqual([]);
});
const lock = (dir: string): void => {
  chmodSync(dir, 0o555);
  locked.push(dir);
};

const tilde = (p: string): string => (within(home, p) ? path.join("~", path.relative(home, p)) : p);
const PATH = (...dirs: string[]): string => dirs.join(path.delimiter);
/** The folders of the PATH the last look of a test was handed, as they were written: what
 *  a row is held to for "a shell looks in its command folder" (`row`). None before a
 *  test's first look. */
let searched: string[] = [];

/** A look at the test's computer: no PATH, no Node but one that has no global folder yet,
 *  this command run from outside it by its cli.js, only what is under the temp folder its
 *  own, and no way to run anything. */
const looking = (o: Partial<Looking> = {}): Looking => {
  searched = (o.env?.PATH ?? "").split(path.delimiter).filter(Boolean);
  return {
    env: {},
    home,
    reach: tmp,
    execPath: path.join(tmp, "node", "bin", "node"),
    distDir: path.join(os.tmpdir(), "sp-find-not-in-reach", "dist"),
    started: path.join(os.tmpdir(), "sp-find-not-in-reach", "dist", "cli.js"),
    npmPrefix: null,
    serviceCli: null,
    hooksVersion: null,
    tilde,
    ...o,
  };
};

/** What stands in for running a copy's cli.js with `--version`: it answers from a list
 *  (nothing: it printed nothing) and writes down every cli.js it was asked about. */
const runner = (says: Record<string, string | null> = {}) => {
  const asked: string[] = [];
  const runs = (cli: string): string | null => {
    asked.push(cli);
    return says[cli] ?? null;
  };
  return { asked, runs };
};

/** A cli.js that would say so if node ever ran it: it writes a file beside itself. */
const CLI = 'require("node:fs").writeFileSync(__filename + ".ran", "this file was run\\n");\n';

interface Pkg {
  /** What package.json says; null: it has no version. */
  version?: string | null;
  /** There is a dist/cli.js. */
  cli?: boolean;
  name?: string;
  /** package.json as it is on disk; null: there is none. */
  raw?: string | null;
  /** Folders beside package.json that no published sessionpipe has. */
  holds?: string[];
}
/** What npm unpacks into a package folder. */
function pkg(dir: string, o: Pkg = {}): string {
  const version = o.version === undefined ? "0.15.0" : o.version;
  mkdirSync(dir, { recursive: true });
  const json = JSON.stringify({ name: o.name ?? "sessionpipe", ...(version === null ? {} : { version }) });
  if (o.raw !== null) writeFileSync(path.join(dir, "package.json"), o.raw ?? json);
  if (o.cli !== false) {
    mkdirSync(path.join(dir, "dist"), { recursive: true });
    writeFileSync(path.join(dir, "dist", "cli.js"), CLI);
  }
  for (const e of o.holds ?? []) mkdirSync(path.join(dir, e), { recursive: true });
  return dir;
}

// --- a prefix: <prefix>/lib/node_modules/sessionpipe and <prefix>/bin/sessionpipe
const modulesOf = (prefix: string): string => path.join(prefix, "lib", "node_modules");
const slot = (prefix: string): string => path.join(modulesOf(prefix), "sessionpipe");
const binOf = (prefix: string): string => path.join(prefix, "bin", "sessionpipe");
const cliOf = (prefix: string): string => path.join(slot(prefix), "dist", "cli.js");
/** The bin link npm makes in a prefix: relative, into the package folder. */
function linkBin(prefix: string, to = path.join("..", "lib", "node_modules", "sessionpipe", "dist", "cli.js")): string {
  mkdirSync(path.join(prefix, "bin"), { recursive: true });
  symlinkSync(to, binOf(prefix));
  return binOf(prefix);
}
/** `npm install -g sessionpipe` into a prefix. */
function globalCopy(prefix: string, o: Pkg = {}): string {
  linkBin(prefix);
  return pkg(slot(prefix), o);
}
/** What the look says of a clean global copy in a prefix, and what a test says differs.
 *  `onPath`: its command folder is one of the PATH the look was handed, as the test wrote
 *  that PATH (a test of two spellings of one folder says it outright). */
const row = (prefix: string, o: Partial<Copy> = {}): Copy => ({
  dir: slot(prefix),
  where: tilde(prefix),
  prefix,
  slot: "global",
  not: null,
  aside: false,
  version: "0.15.0",
  wrong: null,
  bins: [binOf(prefix)],
  uses: [],
  onPath: (o.slot === undefined || o.slot === "global") && searched.includes(path.join(prefix, "bin")),
  writable: true,
  keeper: null,
  ...o,
});
/** What the look says of a folder in a prefix's slot that the proof refuses: said by its
 *  own folder, as everything that is no install is, and with no prefix: that is a global
 *  install's alone. Its link is still read as its link. */
const refused = (prefix: string, not: string, o: Partial<Copy> = {}): Copy =>
  row(prefix, { where: tilde(slot(prefix)), prefix: null, slot: null, not, ...o });
/** What the look says of a folder that is no install: said by its own name, in no slot. */
const stray = (dir: string, o: Partial<Copy> = {}): Copy => ({
  dir,
  where: tilde(dir),
  prefix: null,
  slot: null,
  not: NO_SLOT,
  aside: false,
  version: "0.15.0",
  wrong: null,
  bins: [],
  uses: [],
  onPath: false,
  writable: true,
  keeper: null,
  ...o,
});

/** A Node of a manager's that the look knows a place for, by its global prefix. One of
 *  each at most in a test, so the order they are found in is the look's own and never the
 *  order a disk happens to list a folder in. */
const node = {
  nvm: () => path.join(home, ".nvm", "versions", "node", "v22.11.0"),
  fnm: () => path.join(home, ".local", "share", "fnm", "node-versions", "v22.11.0", "installation"),
  asdf: () => path.join(home, ".asdf", "installs", "nodejs", "22.11.0"),
  mise: () => path.join(home, ".local", "share", "mise", "installs", "node", "22.11.0"),
  nodenv: () => path.join(home, ".nodenv", "versions", "22.11.0"),
};
const VOLTA = (): string => path.join(home, ".volta", "tools", "image", "packages", "sessionpipe");
/** The places a system Node and Homebrew keep global packages: named in every look, and
 *  out of every look that is narrowed to a folder. */
const SYSTEM = ["/usr/local", "/usr", "/opt/homebrew", "/home/linuxbrew/.linuxbrew"];
/** The prefixes a look at the test's computer takes by itself, and what a test adds: the
 *  running Node's, the home's two, Volta's; then each folder of PATH that proved one. */
const usual = (...onPath: string[]): string[] => [
  path.join(tmp, "node"),
  path.join(home, ".local"),
  path.join(home, ".npm-global"),
  VOLTA(),
  ...onPath,
];

/** A cache entry as npx makes it for `npx sessionpipe`: the package, and its link in the
 *  `.bin` beside it, which npx puts first on PATH for the one run it starts. */
const npxEntry = (cache: string, id: string, o: Pkg = {}) => {
  const entry = path.join(cache, "_npx", id);
  const bin = path.join(entry, "node_modules", ".bin");
  const dir = pkg(path.join(entry, "node_modules", "sessionpipe"), o);
  mkdirSync(bin, { recursive: true });
  symlinkSync(path.join("..", "sessionpipe", "dist", "cli.js"), path.join(bin, "sessionpipe"));
  return { entry, bin, dir };
};
const cachedRow = (e: { entry: string; bin: string; dir: string }, o: Partial<Copy> = {}): Copy => ({
  dir: e.dir,
  // An entry is said by its own folder, which says what it is.
  where: tilde(e.entry),
  prefix: null,
  slot: "npx",
  not: null,
  aside: false,
  version: "0.15.0",
  wrong: null,
  bins: [path.join(e.bin, "sessionpipe")],
  uses: [],
  onPath: false,
  writable: true,
  keeper: null,
  ...o,
});

const TYPED = "where the one you type is";
const IN_WAY = "where the copy is whose link is gone";
const LINKED = "where a link to it already is";
const THIS = "where this command runs from";
const SERVICE = "where the one the background service runs is";
const ANOTHER = "where another copy of it already is";
const NPM = "npm's global folder";
const OWN = "a folder of your own";
/** The one place the look names for the copy that is to stay: its command in the `bin`
 *  beside it, off PATH, nothing in its way, this user's to write; and what a test says
 *  differs. */
const place = (prefix: string, why: string, o: Partial<Home> = {}): Home => ({
  prefix,
  shown: tilde(prefix),
  why,
  bin: path.join(prefix, "bin"),
  onPath: false,
  blocked: null,
  writable: true,
  ...o,
});
const MISSING = "its dist/cli.js is missing (an install that was cut off?)";
const LEFT = "left behind by an install that was cut off";
/** What is wrong with a whole copy in a global folder that no link of npm's leads to. */
const NO_LINK = "npm's link to it is gone";
const NO_SLOT = "it is not a global install or an npx cache entry (a project's own dependency?)";
const NO_MANIFEST = "it has no package.json that can be read (an install that was cut off?)";
const NO_RELEASE = "its package.json names no release of sessionpipe";
const A_LINK = "it is a link that doesn't lead into a sessionpipe install";
const A_PROJECT = "the node_modules folder it is in is a project's own (a package.json is beside it)";
const STRANGER = "a file npm didn't put there";
const STRANGE_LINK = "a link to no install of sessionpipe";

/** Every folder and file an inventory names; `link`: the file itself is meant (a command
 *  on PATH), not what it leads to. */
const named = (inv: Inventory): { p: string; link: boolean }[] => [
  ...(typeof inv.reach === "string" ? [{ p: inv.reach, link: false }] : []),
  ...inv.copies.flatMap((c) => [
    { p: c.dir, link: false },
    ...(c.prefix ? [{ p: c.prefix, link: false }] : []),
    ...c.bins.map((p) => ({ p, link: true })),
  ]),
  ...inv.dangling.map((p) => ({ p, link: true })),
  ...inv.strangers.map((s) => ({ p: s.file, link: true })),
  ...inv.onPath.flatMap((e) => [{ p: e.file, link: true }, ...(e.dir ? [{ p: e.dir, link: false }] : [])]),
  ...(inv.typed ? [{ p: inv.typed, link: false }] : []),
  ...(inv.unsure ? [{ p: inv.unsure, link: true }] : []),
  ...(inv.home
    ? [
        { p: inv.home.prefix, link: false },
        { p: inv.home.bin, link: false },
        ...(inv.home.blocked ? [{ p: inv.home.blocked, link: true }] : []),
      ]
    : []),
  ...inv.prefixes.map((p) => ({ p, link: false })),
  { p: inv.npx, link: false },
];
/** The things on the disk an inventory has more than one name for, each with its names:
 *  one thing is one device and inode. Empty: every path has one spelling. */
const twoNames = (inv: Inventory): string[][] => {
  const by = new Map<string, Set<string>>();
  for (const { p, link } of named(inv)) {
    let st: ReturnType<typeof lstatSync>;
    try {
      st = link ? lstatSync(p) : statSync(p);
    } catch {
      continue;
    }
    const key = `${st.dev}:${st.ino}`;
    by.set(key, (by.get(key) ?? new Set<string>()).add(p));
  }
  return [...by.values()].filter((s) => s.size > 1).map((s) => [...s].sort());
};

describe.skipIf(win32)("spelled: one spelling for one place", () => {
  it("goes through a linked folder; what is not there keeps its tail on the real folder above", () => {
    mkdirSync(path.join(tmp, "real", "a"), { recursive: true });
    symlinkSync(path.join(tmp, "real"), path.join(tmp, "alias"));
    expect(spelled(path.join(tmp, "alias"))).toBe(path.join(tmp, "real"));
    expect(spelled(path.join(tmp, "alias", "a"))).toBe(path.join(tmp, "real", "a"));
    expect(spelled(path.join(tmp, "alias", "a", "not", "there"))).toBe(path.join(tmp, "real", "a", "not", "there"));
    expect(spelled(path.join(tmp, "alias", "nor", "this"))).toBe(path.join(tmp, "real", "nor", "this"));
  });

  it("a path that is not absolute is read from where the process is; the root is itself", () => {
    expect(spelled(".")).toBe(realpathSync.native(process.cwd()));
    expect(spelled(path.join(tmp, "a", "..", "b"))).toBe(path.join(tmp, "b"));
    const root = path.parse(tmp).root;
    expect(spelled(root)).toBe(root);
  });

  it("where no folder above can be found either, it is the path as it was given", () => {
    fake.lost = () => true;
    expect(spelled(path.join(tmp, "a", "b"))).toBe(path.join(tmp, "a", "b"));
  });
});

describe.skipIf(win32)("canWrite: may this user write a folder, or make it", () => {
  it("a folder that is there, and one not made yet under it", () => {
    expect(canWrite(tmp)).toBe(true);
    expect(canWrite(path.join(tmp, "not", "made", "yet"))).toBe(true);
  });

  it.runIf(refusable)("not one this user may not write, nor one to be made under it", () => {
    mkdirSync(path.join(tmp, "theirs"));
    lock(path.join(tmp, "theirs"));
    expect(canWrite(path.join(tmp, "theirs"))).toBe(false);
    expect(canWrite(path.join(tmp, "theirs", "lib", "node_modules"))).toBe(false);
  });

  it("an answer other than 'nothing is there' is no; so is nothing there all the way up", () => {
    fake.access = (p) => (p === tmp ? "EROFS" : null);
    expect(canWrite(tmp)).toBe(false);
    // A folder to be made under it: asked of the folder above, which says the same.
    fake.access = (p) => (p === tmp ? "EROFS" : "ENOENT");
    expect(canWrite(path.join(tmp, "lib", "node_modules"))).toBe(false);
    // A drive that isn't there: every folder up to the root is missing.
    fake.access = () => "ENOENT";
    expect(canWrite(path.join(tmp, "lib"))).toBe(false);
  });
});

describe.skipIf(win32)("prefixesOf: every folder that may be some Node's global one", () => {
  /** One version of Node under each manager that keeps them in the home folder. */
  const managed = () => {
    const at = {
      nvm: node.nvm(),
      fnm: path.dirname(node.fnm()),
      asdf: node.asdf(),
      mise: node.mise(),
      nodenv: node.nodenv(),
      installer: path.join(home, ".local", "share", "node-v22.11.0-darwin-arm64"),
    };
    for (const d of Object.values(at)) mkdirSync(d, { recursive: true });
    // A file among the versions is no Node.
    writeFileSync(path.join(home, ".nvm", "versions", "node", "default"), "v22.11.0\n");
    return at;
  };

  it("this Node's, npm's answer, the environment's, the home's own, a system Node's and Homebrew's, each manager's, Volta's", () => {
    const at = managed();
    const o = looking({
      npmPrefix: path.join(tmp, "npm"),
      env: { npm_config_prefix: path.join(tmp, "configured"), N_PREFIX: path.join(tmp, "n") },
    });
    const all = [
      path.join(tmp, "node"),
      path.join(tmp, "npm"),
      path.join(tmp, "configured"),
      path.join(tmp, "n"),
      path.join(home, ".local"),
      path.join(home, ".npm-global"),
      ...SYSTEM,
      at.nvm,
      path.join(at.fnm, "installation"),
      at.asdf,
      at.mise,
      at.nodenv,
      at.installer,
      VOLTA(),
    ];
    expect(prefixesOf(o)).toEqual(all);
    // It is a list of names, the same whoever asks: which of them a sessionpipe may call
    // this computer's is the look's to say (below).
    expect(prefixesOf({ ...o, reach: null })).toEqual(all);
    expect(prefixesOf({ ...o, reach: true })).toEqual(all);
  });

  it("a manager that was told where to keep its files is looked in there, and not where it would have kept them", () => {
    managed();
    const told = {
      NVM_DIR: path.join(tmp, "nvm"),
      FNM_DIR: path.join(tmp, "fnm"),
      ASDF_DATA_DIR: path.join(tmp, "asdf"),
      VOLTA_HOME: path.join(tmp, "volta"),
    };
    mkdirSync(path.join(told.NVM_DIR, "versions", "node", "v20.18.0"), { recursive: true });
    mkdirSync(path.join(told.FNM_DIR, "node-versions", "v20.18.0"), { recursive: true });
    mkdirSync(path.join(told.ASDF_DATA_DIR, "installs", "nodejs", "20.18.0"), { recursive: true });
    expect(prefixesOf(looking({ env: told }))).toEqual([
      path.join(tmp, "node"),
      path.join(home, ".local"),
      path.join(home, ".npm-global"),
      ...SYSTEM,
      path.join(told.NVM_DIR, "versions", "node", "v20.18.0"),
      path.join(told.FNM_DIR, "node-versions", "v20.18.0", "installation"),
      path.join(told.ASDF_DATA_DIR, "installs", "nodejs", "20.18.0"),
      node.mise(),
      node.nodenv(),
      path.join(home, ".local", "share", "node-v22.11.0-darwin-arm64"),
      path.join(told.VOLTA_HOME, "tools", "image", "packages", "sessionpipe"),
    ]);
  });

  it("with no manager on the computer: this Node's, the home's two, the system's four, Volta's", () => {
    expect(prefixesOf(looking())).toEqual([
      path.join(tmp, "node"),
      path.join(home, ".local"),
      path.join(home, ".npm-global"),
      ...SYSTEM,
      VOLTA(),
    ]);
  });
});

describe.skipIf(win32)("look: which folders are looked in as a prefix", () => {
  it("each once, by its one name: npm's answer and the environment's naming this Node's folder again add nothing", () => {
    const inv = look(
      looking({
        npmPrefix: path.join(tmp, "node"),
        env: { npm_config_prefix: path.join(tmp, "node", "lib", ".."), N_PREFIX: path.join(home, ".local") },
      }),
    );
    expect(inv.prefixes).toEqual(usual());
    // The places a system Node and Homebrew use are named in every look, and are in none
    // that is narrowed to a folder: the reach is what keeps this computer's own out.
    for (const p of SYSTEM) expect(inv.prefixes).not.toContain(spelled(p));
  });

  it("only what is inside the reach folder, which may be named through a link", () => {
    const world = path.join(tmp, "world");
    mkdirSync(path.join(world, "home"), { recursive: true });
    const o = looking({
      home: path.join(world, "home"),
      reach: world,
      execPath: path.join(world, "node", "bin", "node"),
      npmPrefix: path.join(tmp, "outside"),
    });
    const inside = [
      path.join(world, "node"),
      path.join(world, "home", ".local"),
      path.join(world, "home", ".npm-global"),
      path.join(world, "home", ".volta", "tools", "image", "packages", "sessionpipe"),
    ];
    expect(look(o).prefixes).toEqual(inside);
    symlinkSync(world, path.join(tmp, "alias"));
    const through = look({ ...o, reach: path.join(tmp, "alias") });
    expect(through.prefixes).toEqual(inside);
    expect(through.reach).toBe(world);
  });

  it("M5: a folder of PATH named `bin` whose own npm link leads into the `lib` beside it is one: its copy is a global install", () => {
    // A Node this look knows no place for (a tarball unpacked in /opt, a manager it has
    // never heard of): what makes its folder a prefix is npm's own link, found by a shell.
    const opt = path.join(tmp, "opt", "node-22");
    globalCopy(opt);
    const inv = look(looking({ env: { PATH: path.join(opt, "bin") } }));
    expect(inv.prefixes).toEqual(usual(opt));
    expect(inv.copies).toEqual([row(opt, { uses: ["typed"] })]);
    // The link alone, its copy gone, says the same of the folder: a fresh copy may go there.
    const gone = path.join(tmp, "opt", "node-20");
    linkBin(gone);
    expect(look(looking({ env: { PATH: path.join(gone, "bin") } })).prefixes).toEqual(usual(gone));
    // Not on PATH, the same folder is no prefix, and nothing in it is looked at.
    const off = look(looking());
    expect(off.prefixes).toEqual(usual());
    expect(off.copies).toEqual([]);
  });

  it("M5: not where the link leads somewhere else, the folder is not named `bin`, or the file is no link of npm's", () => {
    // npm's kind of link, into the copy ANOTHER folder holds.
    const [here, there] = [path.join(tmp, "here"), path.join(tmp, "there")];
    pkg(slot(there));
    linkBin(here, path.join("..", "..", "there", "lib", "node_modules", "sessionpipe", "dist", "cli.js"));
    // A folder of commands that is not a prefix's `bin`, with a link into the lib beside it.
    const tools = path.join(tmp, "kit", "tools");
    pkg(slot(path.join(tmp, "kit")));
    mkdirSync(tools);
    symlinkSync(
      path.join("..", "lib", "node_modules", "sessionpipe", "dist", "cli.js"),
      path.join(tools, "sessionpipe"),
    );
    // A `bin` with a script of the name, and a lib beside it that holds a copy.
    const scripted = path.join(tmp, "scripted");
    pkg(slot(scripted));
    mkdirSync(path.join(scripted, "bin"));
    writeFileSync(binOf(scripted), "#!/bin/sh\necho mine\n");
    const inv = look(looking({ env: { PATH: PATH(path.join(here, "bin"), tools, path.join(scripted, "bin")) } }));
    expect(inv.prefixes).toEqual(usual());
    // The copies the two links lead to are found, as what a shell starts, and are in no
    // slot: by its shape alone a `lib/node_modules` could be any project's.
    expect(inv.copies).toEqual([stray(slot(there), { uses: ["typed"] }), stray(slot(path.join(tmp, "kit")))]);
    expect(inv.strangers).toEqual([{ file: binOf(scripted), why: STRANGER }]);
  });
});

describe.skipIf(win32)("look: where copies are found", () => {
  it("every sessionpipe on PATH, not the first; a folder listed twice counts once", () => {
    const [a, b, c] = ["a", "b", "c"].map((n) => path.join(tmp, n)) as [string, string, string];
    globalCopy(a);
    globalCopy(b, { version: "0.14.2" });
    globalCopy(c, { version: "0.13.0" });
    mkdirSync(path.join(tmp, "empty"));
    const inv = look(
      looking({
        env: {
          PATH: PATH(
            path.join(a, "bin"),
            path.join(b, "bin"),
            path.join(a, "bin"),
            path.join(tmp, "empty"),
            path.join(tmp, "not-there"),
            path.join(c, "bin"),
          ),
        },
      }),
    );
    expect(inv).toEqual({
      reach: tmp,
      copies: [row(a, { uses: ["typed"] }), row(b, { version: "0.14.2" }), row(c, { version: "0.13.0" })],
      dangling: [],
      strangers: [],
      // First first, as a shell finds them; a folder with no sessionpipe in it, there or
      // not, has none.
      onPath: [
        { file: binOf(a), dir: slot(a) },
        { file: binOf(b), dir: slot(b) },
        { file: binOf(c), dir: slot(c) },
      ],
      typed: slot(a),
      unsure: null,
      home: place(a, TYPED, { onPath: true }),
      taken: null,
      prefixes: usual(a, b, c),
      npx: path.join(home, ".npm", "_npx"),
    } satisfies Inventory);
  });

  it("the global folder of every Node there is a place for, on PATH or not", () => {
    const prefixes = [
      path.join(tmp, "node"),
      path.join(tmp, "npm"),
      path.join(tmp, "configured"),
      path.join(tmp, "n"),
      path.join(home, ".local"),
      path.join(home, ".npm-global"),
      node.nvm(),
      node.fnm(),
      node.asdf(),
      node.mise(),
      node.nodenv(),
      path.join(home, ".local", "share", "node-v22.11.0-linux-x64"),
    ];
    for (const p of prefixes) globalCopy(p);
    const inv = look(
      looking({
        npmPrefix: path.join(tmp, "npm"),
        env: { npm_config_prefix: path.join(tmp, "configured"), N_PREFIX: path.join(tmp, "n") },
      }),
    );
    expect(inv.copies).toEqual(prefixes.map((p) => row(p)));
    expect(inv.prefixes).toEqual([...prefixes, VOLTA()]);
    expect(inv.onPath).toEqual([]);
    expect(inv.typed).toBeNull();
  });

  it("where a manager was told to keep its Nodes, and nowhere it would have kept them otherwise", () => {
    const told = {
      NVM_DIR: path.join(tmp, "nvm"),
      FNM_DIR: path.join(tmp, "fnm"),
      ASDF_DATA_DIR: path.join(tmp, "asdf"),
    };
    const there = [
      path.join(told.NVM_DIR, "versions", "node", "v20.18.0"),
      path.join(told.FNM_DIR, "node-versions", "v20.18.0", "installation"),
      path.join(told.ASDF_DATA_DIR, "installs", "nodejs", "20.18.0"),
    ];
    for (const p of there) globalCopy(p);
    globalCopy(node.nvm());
    globalCopy(node.fnm());
    globalCopy(node.asdf());
    expect(look(looking({ env: told })).copies).toEqual(there.map((p) => row(p)));
  });

  it("the npx cache: npm's own place for it, or the one npm_config_cache names", () => {
    const mine = npxEntry(path.join(home, ".npm"), "a1b2c3d4e5f6a7b8", { version: "0.14.0" });
    // An entry npx made for something else.
    mkdirSync(path.join(home, ".npm", "_npx", "0000111122223333", "node_modules", "cowsay"), { recursive: true });
    const inv = look(looking());
    expect(inv.copies).toEqual([cachedRow(mine, { version: "0.14.0" })]);
    expect(inv.copies[0]?.where).toBe(path.join("~", ".npm", "_npx", "a1b2c3d4e5f6a7b8"));
    expect(inv.npx).toBe(path.join(home, ".npm", "_npx"));
    // A cache entry is never where the one copy lives.
    expect(inv.home).toEqual(place(path.join(home, ".local"), OWN));

    // Where npm was told to keep its cache: that one, and not the usual one beside it.
    const other = path.join(tmp, "cache", "_npx", "ffffeeeeddddcccc");
    const there = pkg(path.join(other, "node_modules", "sessionpipe"));
    const told = look(looking({ env: { npm_config_cache: path.join(tmp, "cache") } }));
    expect(told.copies).toEqual([cachedRow({ entry: other, bin: "", dir: there }, { bins: [] })]);
    expect(told.npx).toBe(path.join(tmp, "cache", "_npx"));
  });

  it("the copy this command runs from, and the one the service file names: in a Node's own folder, each is said to be in use", () => {
    const [mine, served] = [node.nvm(), node.asdf()];
    globalCopy(mine);
    globalCopy(served, { version: "0.14.2" });
    const o = looking({ distDir: path.join(slot(mine), "dist"), serviceCli: cliOf(served) });
    expect(look(o).copies).toEqual([
      row(mine, { uses: ["this"] }),
      row(served, { version: "0.14.2", uses: ["service"] }),
    ]);
    // One copy may be both.
    expect(look({ ...o, serviceCli: cliOf(mine) }).copies).toEqual([
      row(mine, { uses: ["service", "this"] }),
      row(served, { version: "0.14.2" }),
    ]);
  });

  it("M5: found wherever they are, by this command's own place and by the service file; where no Node is known to keep its packages, not as an install", () => {
    // `npm install -g --prefix` somewhere of one's own, started by its path: the folder
    // has a prefix's shape, and by its shape alone it could be a project named `lib`.
    const [far, off] = [path.join(tmp, "far"), path.join(tmp, "off")];
    globalCopy(far);
    globalCopy(off, { version: "0.14.2" });
    const o = looking({ distDir: path.join(slot(far), "dist"), serviceCli: cliOf(off) });
    expect(look(o).copies).toEqual([
      stray(slot(far), { uses: ["this"] }),
      stray(slot(off), { version: "0.14.2", uses: ["service"] }),
    ]);
    // A service file may run anything: only a `…/dist/cli.js` is a copy of sessionpipe.
    for (const program of [
      path.join(slot(off), "dist", "worker.js"),
      path.join(slot(off), "bin", "cli.js"),
      path.join(off, "bin", "node"),
    ])
      expect(look({ ...o, serviceCli: program }).copies.map((c) => c.dir)).toEqual([slot(far)]);
    // One that names a copy that is gone adds no row for it.
    expect(look({ ...o, serviceCli: cliOf(path.join(tmp, "gone")) }).copies.map((c) => c.dir)).toEqual([slot(far)]);
  });

  it("what npm left behind from an install that was cut off, beside the copy or alone", () => {
    const p = path.join(home, ".local");
    globalCopy(p);
    const modules = modulesOf(p);
    // What npm moved aside, whole; and a folder a run of this command had npm install
    // into, which was cut off before npm put anything there.
    pkg(path.join(modules, ".sessionpipe-Ab3dE9xZ"), { version: "0.14.0" });
    mkdirSync(path.join(modules, ".sessionpipe-0a1b2c3d"));
    // One with nothing that says what it was: found, and no longer provably ours.
    mkdirSync(path.join(modules, ".sessionpipe-9z8y7x6w", "dist"), { recursive: true });
    // Not npm's name for such a folder, and other packages: not looked at.
    mkdirSync(path.join(modules, ".sessionpipe-short"));
    mkdirSync(path.join(modules, ".sessionpipe-Ab3dE9xZ-more"));
    mkdirSync(path.join(modules, "npm"));
    const aside = (name: string, o: Partial<Copy>): Copy =>
      row(p, { dir: path.join(modules, name), aside: true, wrong: LEFT, bins: [], ...o });
    const inv = look(looking());
    // The order a disk lists a folder in is its own: the copy itself is first all the same.
    expect(inv.copies[0]).toEqual(row(p));
    expect([...inv.copies.slice(1)].sort((a, b) => a.dir.localeCompare(b.dir))).toEqual(
      [
        aside(".sessionpipe-Ab3dE9xZ", { version: "0.14.0" }),
        aside(".sessionpipe-0a1b2c3d", { version: null }),
        // What is not ours is said by its own folder.
        aside(".sessionpipe-9z8y7x6w", {
          where: tilde(path.join(modules, ".sessionpipe-9z8y7x6w")),
          version: null,
          prefix: null,
          slot: null,
          not: NO_MANIFEST,
        }),
      ].sort((a, b) => a.dir.localeCompare(b.dir)),
    );
    expect(inv.home).toEqual(place(p, ANOTHER));

    // A leftover alone is no copy, and no reason to put the fresh one beside it.
    const other = path.join(home, ".npm-global");
    rmSync(slot(p), { recursive: true });
    rmSync(binOf(p));
    for (const n of [".sessionpipe-0a1b2c3d", ".sessionpipe-9z8y7x6w"])
      rmSync(path.join(modules, n), { recursive: true });
    pkg(path.join(modulesOf(other), ".sessionpipe-Zz9yXx8w"), { version: "0.13.0" });
    const alone = look(looking());
    expect(alone.copies.map((c) => [c.dir, c.aside, c.slot])).toEqual([
      [path.join(modules, ".sessionpipe-Ab3dE9xZ"), true, "global"],
      [path.join(modulesOf(other), ".sessionpipe-Zz9yXx8w"), true, "global"],
    ]);
    // A folder of the user's own, for being that: not for the leftover in it.
    expect(alone.home).toEqual(place(p, OWN));
    // And npm's own folder before it, for being npm's: not the first leftover's.
    expect(look(looking({ npmPrefix: other })).home).toEqual(place(other, NPM));
  });
});

describe.skipIf(win32)("look: what uses each copy", () => {
  it("typed is the first on PATH; one copy may be typed, the service's, this command's and the hooks' at once", () => {
    const [a, b] = [path.join(tmp, "a"), path.join(tmp, "b")];
    globalCopy(a);
    globalCopy(b);
    const env = { PATH: PATH(path.join(b, "bin"), path.join(a, "bin")) };
    const inv = look(looking({ env }));
    expect(inv.copies).toEqual([row(b, { uses: ["typed"] }), row(a)]);
    expect(inv.typed).toBe(slot(b));
    expect(
      look(looking({ env, distDir: path.join(slot(b), "dist"), serviceCli: cliOf(b), hooksVersion: "0.15.0" })).copies,
    ).toEqual([row(b, { uses: ["typed", "service", "this", "hooks"] }), row(a)]);
  });

  it("the hooks: the copy of the release that wrote them that is in use, else the first of it, else none", () => {
    const typed = path.join(tmp, "typed");
    const first = path.join(home, ".local");
    const second = path.join(home, ".npm-global");
    const served = node.nvm();
    globalCopy(typed);
    globalCopy(first, { version: "0.14.2" });
    globalCopy(second, { version: "0.14.2" });
    globalCopy(served, { version: "0.14.2" });
    const o = looking({ env: { PATH: path.join(typed, "bin") }, hooksVersion: "0.14.2" });
    const old = { version: "0.14.2" };
    expect(look({ ...o, serviceCli: cliOf(served) }).copies).toEqual([
      row(typed, { uses: ["typed"] }),
      row(first, old),
      row(second, old),
      row(served, { ...old, uses: ["service", "hooks"] }),
    ]);
    // With no service file none of that release is in use: the first of them.
    expect(look(o).copies).toEqual([
      row(typed, { uses: ["typed"] }),
      row(first, { ...old, uses: ["hooks"] }),
      row(second, old),
      row(served, old),
    ]);
    // A release no copy here is, and no hooks at all.
    for (const hooksVersion of ["0.9.0", null])
      expect(look({ ...o, hooksVersion }).copies.flatMap((c) => c.uses)).toEqual(["typed"]);
  });

  it("a link that leads nowhere is passed over, as a shell passes it: typed is the first that starts something", () => {
    const [gone, a, b] = ["gone", "a", "b"].map((n) => path.join(tmp, n)) as [string, string, string];
    linkBin(gone);
    globalCopy(a);
    globalCopy(b);
    const inv = look(
      looking({ env: { PATH: PATH(path.join(gone, "bin"), path.join(a, "bin"), path.join(b, "bin")) } }),
    );
    expect(inv.copies).toEqual([row(a, { uses: ["typed"] }), row(b)]);
    // The link is still among what PATH lists, first, and is said as one that leads nowhere.
    expect(inv.onPath).toEqual([
      { file: binOf(gone), dir: slot(gone) },
      { file: binOf(a), dir: slot(a) },
      { file: binOf(b), dir: slot(b) },
    ]);
    expect(inv.dangling).toEqual([binOf(gone)]);
    expect(inv.typed).toBe(slot(a));
    // So the one copy lives where the one that really starts is.
    expect(inv.home).toEqual(place(a, TYPED, { onPath: true }));
  });

  it("with nothing on PATH but links that lead nowhere, nothing is typed: a copy off PATH is nobody's", () => {
    const [gone, also] = [path.join(tmp, "gone"), path.join(tmp, "also-gone")];
    const local = path.join(home, ".local");
    linkBin(gone);
    linkBin(also);
    pkg(slot(local));
    const inv = look(looking({ env: { PATH: PATH(path.join(gone, "bin"), path.join(also, "bin")) } }));
    // Whole, and nothing starts it: that is what is wrong with it.
    expect(inv.copies).toEqual([row(local, { bins: [], wrong: NO_LINK })]);
    expect(inv.onPath).toEqual([
      { file: binOf(gone), dir: slot(gone) },
      { file: binOf(also), dir: slot(also) },
    ]);
    expect(inv.dangling).toEqual([binOf(gone), binOf(also)]);
    expect(inv.typed).toBeNull();
    expect(inv.unsure).toBeNull();
    // A fresh copy goes where a shell already looks for one: behind the first such link.
    expect(inv.home).toEqual(place(gone, LINKED, { onPath: true }));
  });

  it("what is typed lies outside the folders this sessionpipe may call its own: it is named, not listed, and no place is", () => {
    const world = path.join(tmp, "world");
    const outside = path.join(tmp, "outside");
    globalCopy(outside);
    // A link inside the reach, of npm's kind, to the copy outside it.
    mkdirSync(path.join(world, "home", "bin"), { recursive: true });
    symlinkSync(cliOf(outside), path.join(world, "home", "bin", "sessionpipe"));
    const inv = look(
      looking({
        home: path.join(world, "home"),
        reach: world,
        execPath: path.join(world, "node", "bin", "node"),
        env: { PATH: path.join(world, "home", "bin") },
      }),
    );
    expect(inv.onPath).toEqual([{ file: path.join(world, "home", "bin", "sessionpipe"), dir: slot(outside) }]);
    expect(inv.typed).toBe(slot(outside));
    expect(inv.copies).toEqual([]);
    expect(inv.dangling).toEqual([]);
    expect(inv.home).toBeNull();
  });
});

describe.skipIf(win32)("look: started by npx", () => {
  /** What npm and npx say of themselves to what they start: the command they were given. */
  const BY_NPX = { npm_command: "exec" };

  it("M5: npx's own entry, first on PATH for that one run, is nobody's to type: the copy behind it is", () => {
    const npx = npxEntry(path.join(home, ".npm"), "a1b2c3d4e5f6a7b8");
    const a = path.join(tmp, "a");
    globalCopy(a, { version: "0.14.2" });
    mkdirSync(path.join(tmp, "empty"));
    const o = looking({
      env: { ...BY_NPX, PATH: PATH(path.join(tmp, "empty"), npx.bin, path.join(a, "bin")) },
      distDir: path.join(npx.dir, "dist"),
      started: path.join(npx.bin, "sessionpipe"),
    });
    const inv = look(o);
    // What a shell opened afterwards finds: the installed copy, and only that.
    expect(inv.onPath).toEqual([{ file: binOf(a), dir: slot(a) }]);
    expect(inv.dangling).toEqual([]);
    expect(inv.strangers).toEqual([]);
    // The entry is still a copy, found in the cache and as the one this command runs from.
    expect(inv.copies).toEqual([row(a, { version: "0.14.2", uses: ["typed"] }), cachedRow(npx, { uses: ["this"] })]);
    expect(inv.copies[1]?.where).toBe(path.join("~", ".npm", "_npx", "a1b2c3d4e5f6a7b8"));
    // The one copy lives where the one typed is, never in the cache.
    expect(inv.typed).toBe(slot(a));
    expect(inv.home).toEqual(place(a, TYPED, { onPath: true }));

    // On a computer with no installed copy at all, nothing is typed and a shell finds none.
    const alone = look({ ...o, env: { ...BY_NPX, PATH: npx.bin } });
    expect(alone.onPath).toEqual([]);
    expect(alone.copies).toEqual([cachedRow(npx, { uses: ["this"] })]);
    expect(alone.typed).toBeNull();
    expect(alone.unsure).toBeNull();
    expect(alone.home).toEqual(place(path.join(home, ".local"), OWN));
  });

  it("M5: wherever npm keeps its cache: an entry's `.bin` is told by its shape; an entry outside the cache that was looked in is found as this command's own, and is no cache entry of ours", () => {
    // A cache this look is not told of (npm's own config names it, not the environment).
    const npx = npxEntry(path.join(tmp, "elsewhere"), "ffffeeeeddddcccc");
    const o = looking({ env: { ...BY_NPX, PATH: npx.bin } });
    expect(look(o)).toMatchObject({ copies: [], onPath: [], dangling: [], strangers: [], typed: null });
    const mine = look({ ...o, distDir: path.join(npx.dir, "dist") });
    expect(mine.copies).toEqual([stray(npx.dir, { uses: ["this"] })]);
    expect(mine.onPath).toEqual([]);
  });

  it("M5: a link that leads nowhere and a file of the name, in an entry's `.bin`, are not listed either", () => {
    const cache = path.join(home, ".npm");
    // An entry whose package is gone and whose link stayed; one where someone put a file.
    const hollow = npxEntry(cache, "0000111122223333");
    rmSync(hollow.dir, { recursive: true });
    const odd = path.join(cache, "_npx", "4444555566667777", "node_modules", ".bin");
    mkdirSync(odd, { recursive: true });
    writeFileSync(path.join(odd, "sessionpipe"), "#!/bin/sh\necho mine\n");
    expect(look(looking({ env: { ...BY_NPX, PATH: PATH(hollow.bin, odd) } }))).toMatchObject({
      copies: [],
      onPath: [],
      dangling: [],
      strangers: [],
      typed: null,
      unsure: null,
    });
  });

  /** Two folders with a `.bin` beside a package: a project's own, as `npm run` and `npx`
   *  put it on PATH; and one under a folder that only has the cache's name, with no entry
   *  between. */
  const twoBins = () => {
    const project = path.join(home, "code", "app", "node_modules");
    const named = path.join(tmp, "_npx", "node_modules");
    for (const modules of [project, named]) {
      pkg(path.join(modules, "sessionpipe"));
      mkdirSync(path.join(modules, ".bin"));
      symlinkSync(path.join("..", "sessionpipe", "dist", "cli.js"), path.join(modules, ".bin", "sessionpipe"));
    }
    const a = path.join(tmp, "a");
    globalCopy(a);
    return { project, named, a, PATH: PATH(path.join(project, ".bin"), path.join(named, ".bin"), path.join(a, "bin")) };
  };

  it("M5: started by npm or npx, any `node_modules/.bin` on PATH is that run's own: a project's is nobody's to type, and its package is not looked at", () => {
    const { project, a, PATH } = twoBins();
    const env = { ...BY_NPX, PATH };
    const inv = look(looking({ env }));
    expect(inv.onPath).toEqual([{ file: binOf(a), dir: slot(a) }]);
    expect(inv.typed).toBe(slot(a));
    expect(inv.copies).toEqual([row(a, { uses: ["typed"] })]);
    // Started from the project's own dependency it is found, as this command's, and left.
    const from = look(looking({ env, distDir: path.join(project, "sessionpipe", "dist") }));
    expect(from.copies).toEqual([
      row(a, { uses: ["typed"] }),
      stray(path.join(project, "sessionpipe"), { uses: ["this"] }),
    ]);
    expect(from.copies[1]?.where).toBe(path.join("~", "code", "app", "node_modules", "sessionpipe"));
    expect(from.typed).toBe(slot(a));
    // Whatever npm says its command was.
    for (const npm_command of ["exec", "run-script", "x"])
      expect(look(looking({ env: { npm_command, PATH } })).onPath).toEqual([{ file: binOf(a), dir: slot(a) }]);
  });

  it("a `.bin` a person put on their own PATH is theirs, and is looked in like any other folder: what it starts is what is typed, and is no install", () => {
    const { project, named, a, PATH } = twoBins();
    // Not started by npm: nothing says these folders are on PATH for one run only.
    for (const env of [{ PATH }, { PATH, npm_command: "" }]) {
      const inv = look(looking({ env }));
      expect(inv.onPath).toEqual([
        { file: path.join(project, ".bin", "sessionpipe"), dir: path.join(project, "sessionpipe") },
        { file: path.join(named, ".bin", "sessionpipe"), dir: path.join(named, "sessionpipe") },
        { file: binOf(a), dir: slot(a) },
      ]);
      expect(inv.typed).toBe(path.join(project, "sessionpipe"));
      expect(inv.copies).toEqual([
        stray(path.join(project, "sessionpipe"), { uses: ["typed"] }),
        stray(path.join(named, "sessionpipe")),
        row(a),
      ]);
      // What is typed is a project's own dependency: the one clean copy has no place.
      expect(inv.home).toBeNull();
      // Neither `.bin` makes the folder above it a prefix.
      expect(inv.prefixes).toEqual(usual(a));
    }
  });

  describe("the hooks, written by one release: whose they are among the copies of it", () => {
    const local = () => path.join(home, ".local");
    /** This command run by npx from its cache entry, with the hooks written by its release. */
    const under = (npx: { dir: string }, o: Partial<Looking> = {}) =>
      looking({ distDir: path.join(npx.dir, "dist"), hooksVersion: "0.15.0", ...o });

    it("the copy something uses beside this very command, before npx's own entry", () => {
      const npx = npxEntry(path.join(home, ".npm"), "a1b2c3d4e5f6a7b8");
      globalCopy(local());
      const inv = look(under(npx, { env: { ...BY_NPX, PATH: PATH(npx.bin, path.join(local(), "bin")) } }));
      expect(inv.copies).toEqual([row(local(), { uses: ["typed", "hooks"] }), cachedRow(npx, { uses: ["this"] })]);
    });

    it("the installed copy though nothing types or serves it, never the entry npx runs this from", () => {
      // The computer a repair has just left: one copy, its folder not on PATH yet. Run
      // again through npx, the hooks are still that copy's.
      const npx = npxEntry(path.join(home, ".npm"), "a1b2c3d4e5f6a7b8");
      globalCopy(local());
      const inv = look(under(npx, { env: { ...BY_NPX, PATH: npx.bin } }));
      expect(inv.copies).toEqual([row(local(), { uses: ["hooks"] }), cachedRow(npx, { uses: ["this"] })]);
    });

    it("a copy that is no cache entry, before a cache entry that is listed ahead of it", () => {
      // A cache entry nothing uses is found before the copy this command runs from, which
      // is in no folder known as a Node's: being first is not what decides.
      const stale = npxEntry(path.join(home, ".npm"), "a1b2c3d4e5f6a7b8");
      const mine = path.join(tmp, "mine");
      globalCopy(mine);
      const inv = look(looking({ distDir: path.join(slot(mine), "dist"), hooksVersion: "0.15.0" }));
      expect(inv.copies).toEqual([cachedRow(stale), stray(slot(mine), { uses: ["this", "hooks"] })]);
    });

    it("with only cache entries of that release, the first of them as they are listed", () => {
      // One the cache holds, and the one this runs from, in the same cache. An installed
      // copy of another release has nothing to do with them.
      const held = npxEntry(path.join(home, ".npm"), "a1b2c3d4e5f6a7b8");
      const npx = npxEntry(path.join(home, ".npm"), "ffffeeeeddddcccc");
      globalCopy(local(), { version: "0.14.2" });
      const inv = look(under(npx));
      expect(inv.copies[0]).toEqual(row(local(), { version: "0.14.2" }));
      // The two entries, in the order the disk lists the cache in: the first has the hooks.
      const entries = inv.copies.slice(1);
      expect(entries.map((c) => c.dir).sort()).toEqual([held.dir, npx.dir].sort());
      expect(entries.map((c) => c.uses.includes("hooks"))).toEqual([true, false]);
      expect(entries.find((c) => c.dir === npx.dir)?.uses).toContain("this");
    });

    it("a cache entry the background service runs from is in use: it comes before an installed copy nothing uses", () => {
      const served = npxEntry(path.join(home, ".npm"), "a1b2c3d4e5f6a7b8");
      globalCopy(local());
      const inv = look(looking({ serviceCli: path.join(served.dir, "dist", "cli.js"), hooksVersion: "0.15.0" }));
      expect(inv.copies).toEqual([row(local()), cachedRow(served, { uses: ["service", "hooks"] })]);
    });

    it("with no copy of that release, or no hooks, they are nobody's", () => {
      const npx = npxEntry(path.join(home, ".npm"), "a1b2c3d4e5f6a7b8");
      globalCopy(local());
      for (const hooksVersion of ["0.9.0", null])
        expect(look(under(npx, { hooksVersion })).copies).toEqual([row(local()), cachedRow(npx, { uses: ["this"] })]);
    });
  });
});

describe.skipIf(win32)("look: what is wrong with a copy, read from the disk", () => {
  it("L4: no cli.js; a package.json cut off, missing, another package's, or naming no release: each is said, and only a published sessionpipe of some release is ours", () => {
    const at = (n: string) => path.join(tmp, n);
    globalCopy(at("whole"));
    globalCopy(at("no-cli"), { cli: false });
    globalCopy(at("unversioned"), { version: null });
    globalCopy(at("cut-off"), { raw: '{"name":"sessionp' });
    globalCopy(at("bare"), { raw: null });
    globalCopy(at("empty"), { raw: null, cli: false });
    globalCopy(at("other"), { name: "sessionpipe-fork" });
    const names = ["whole", "no-cli", "unversioned", "cut-off", "bare", "empty", "other"];
    const inv = look(looking({ env: { PATH: PATH(...names.map((n) => path.join(at(n), "bin"))) } }));
    expect(inv.copies).toEqual([
      row(at("whole"), { uses: ["typed"] }),
      row(at("no-cli"), { wrong: MISSING }),
      // Whole as far as a look tells, and not provably a release of sessionpipe: not ours,
      // and nothing is "wrong" with what is somebody else's.
      refused(at("unversioned"), NO_RELEASE, { version: null }),
      // No package.json that can be read, and nothing a published copy doesn't hold: what
      // an install that was cut off leaves in npm's own slot (its tarball has package.json
      // last). Not provably ours, so not ours to remove.
      refused(at("cut-off"), NO_MANIFEST, { version: null }),
      refused(at("bare"), NO_MANIFEST, { version: null }),
      // A folder of the name with nothing in it at all is what is left of a copy that
      // could only be emptied: ours (taking it away loses nothing), of no release, and so
      // a folder left behind, by that word, as npm's own leftovers are.
      row(at("empty"), { version: null, aside: true, wrong: LEFT }),
      // Another package in the slot is not ours, and its version is not sessionpipe's.
      refused(at("other"), 'its package.json says it is "sessionpipe-fork", not sessionpipe', { version: null }),
    ]);
    expect(inv.dangling).toEqual([]);
    expect(inv.strangers).toEqual([]);
  });

  it("an empty folder of the name is a leftover wherever the proof accepts it: in a prefix's slot (the home's or another), in an npx cache entry; never 'a copy of no release'", () => {
    const local = path.join(home, ".local");
    const other = path.join(home, ".npm-global");
    mkdirSync(slot(local), { recursive: true });
    mkdirSync(slot(other), { recursive: true });
    linkBin(other);
    const entry = path.join(home, ".npm", "_npx", "a1b2c3d4e5f6a7b8", "node_modules", "sessionpipe");
    mkdirSync(entry, { recursive: true });
    const inv = look(looking({ env: { PATH: path.join(other, "bin") } }));
    expect(inv.copies).toEqual([
      // Typed through npm's link, which still leads into it; of no release; a leftover.
      row(other, { version: null, aside: true, wrong: LEFT, uses: ["typed"] }),
      row(local, { version: null, aside: true, wrong: LEFT, bins: [] }),
      {
        ...row(local, { version: null, aside: true, wrong: LEFT, bins: [] }),
        dir: entry,
        where: tilde(path.dirname(path.dirname(entry))),
        prefix: null,
        slot: "npx",
        onPath: false,
      },
    ]);
    for (const c of inv.copies) expect(c.version === null && c.aside).toBe(true);
    // The home is where what is typed is: the prefix's slot holds what is ours.
    expect(inv.home).toEqual(place(other, TYPED, { onPath: true }));
    // One entry put in it and it is judged by what it holds: no leftover, and not ours.
    mkdirSync(path.join(slot(local), "dist"));
    expect(look(looking()).copies.find((c) => c.dir === slot(local))).toMatchObject({
      slot: null,
      aside: false,
      not: NO_MANIFEST,
    });
  });

  it("with no home, the folder that is in the way of the one copy is named, and why (`taken`): what sits in a tried prefix's own slot and is not provably ours; the first such; none where a home is found", () => {
    const local = path.join(home, ".local");
    const npm = path.join(tmp, "npm");
    // What a killed `npm install -g` leaves in ~/.local: no package.json.
    pkg(slot(local), { raw: null });
    const HOLDS = "it holds src, which no published sessionpipe has (a checkout or a build?)";
    // Nothing typed, and ~/.local the only place: no home, and that folder is why.
    const cut = look(looking());
    expect(cut.home).toBeNull();
    expect(cut.taken).toEqual({ dir: slot(local), why: NO_MANIFEST });
    // npm's own folder holds a build: it is tried first, so it is the one named.
    pkg(slot(npm), { holds: ["src"] });
    const both = look(looking({ npmPrefix: npm }));
    expect(both.home).toBeNull();
    expect(both.taken).toEqual({ dir: slot(npm), why: HOLDS });
    // Typed through npm's own link into the cut-off folder: what is typed is no install,
    // so no place was tried at all, and none is named (the plan goes by what is typed).
    linkBin(local);
    const typed = look(looking({ env: { PATH: path.join(local, "bin") } }));
    expect(typed).toMatchObject({ typed: slot(local), home: null, taken: null });
    // A home is found (another prefix that is free): nothing is in the way of it.
    rmSync(binOf(local));
    const free = path.join(tmp, "free");
    const found = look(looking({ npmPrefix: free }));
    expect(found.home).toEqual(place(free, NPM));
    expect(found.taken).toBeNull();
    // A whole copy elsewhere, and the folder of one's own taken: the copy's prefix is the home.
    globalCopy(path.join(home, ".npm-global"));
    expect(look(looking())).toMatchObject({ home: { prefix: path.join(home, ".npm-global") }, taken: null });
  });

  it("a copy says whether a shell looks in its command folder (`onPath`): by whatever name PATH has for that folder, only of a global install, and whatever is typed", () => {
    const local = path.join(home, ".local");
    const other = path.join(home, ".npm-global");
    globalCopy(local);
    globalCopy(other, { version: "0.14.2" });
    const entry = npxEntry(path.join(home, ".npm"), "a1b2c3d4e5f6a7b8");
    const on = (inv: Inventory) => inv.copies.map((c) => [c.dir, c.onPath]);
    // Neither on PATH; then each alone; then both, where only the first is what is typed.
    expect(on(look(looking()))).toEqual([
      [slot(local), false],
      [slot(other), false],
      [entry.dir, false],
    ]);
    expect(on(look(looking({ env: { PATH: path.join(other, "bin") } })))).toEqual([
      [slot(other), true],
      [slot(local), false],
      [entry.dir, false],
    ]);
    const both = look(looking({ env: { PATH: PATH(path.join(local, "bin"), path.join(other, "bin")) } }));
    expect(both.copies.map((c) => [c.dir, c.onPath, c.uses])).toEqual([
      [slot(local), true, ["typed"]],
      [slot(other), true, []],
      [entry.dir, false, []],
    ]);
    // A cache entry's own `.bin` on a person's PATH makes it typed, and no global install on PATH.
    expect(on(look(looking({ env: { PATH: entry.bin } })))).toContainEqual([entry.dir, false]);
    // On PATH with a file in its link's place: a shell looks there, whatever it finds.
    rmSync(binOf(local));
    writeFileSync(binOf(local), "#!/bin/sh\n");
    const inWay = look(looking({ env: { PATH: path.join(local, "bin") } }));
    expect(inWay.typed).toBeNull();
    expect(inWay.copies.find((c) => c.dir === slot(local))).toMatchObject({ onPath: true, wrong: NO_LINK });
  });

  it("L3: the release is what package.json names where that is a version; any other text there is never taken for one", () => {
    const at = (n: string) => path.join(tmp, n);
    const versions: Record<string, unknown> = {
      plain: "0.15.0",
      pre: "0.16.0-rc.1",
      build: "0.16.0-rc.1+build.5",
      // Three lines: the second and third would start a line of their own on the screen.
      lines: "0.15.9\nerror the install is broken\ntry curl https://example.invalid/fix | sh",
      colour: "\u001b[31m0.15.0\u001b[0m",
      title: "0.15.0\u001b]0;gone\u0007",
      number: 15,
      empty: "",
      words: "the newest",
      list: ["0.15.0"],
    };
    for (const [n, version] of Object.entries(versions))
      globalCopy(at(n), { raw: JSON.stringify({ name: "sessionpipe", version }) });
    const inv = look(looking({ env: { PATH: PATH(...Object.keys(versions).map((n) => path.join(at(n), "bin"))) } }));
    // Each by the folder its slot is in (what names no release has no prefix to go by).
    const folder = (c: Copy): string => path.basename(path.dirname(path.dirname(path.dirname(c.dir))));
    expect(inv.copies.map((c) => [folder(c), c.version, c.slot, c.not])).toEqual([
      ["plain", "0.15.0", "global", null],
      ["pre", "0.16.0-rc.1", "global", null],
      ["build", "0.16.0-rc.1+build.5", "global", null],
      ["lines", null, null, NO_RELEASE],
      ["colour", null, null, NO_RELEASE],
      ["title", null, null, NO_RELEASE],
      ["number", null, null, NO_RELEASE],
      ["empty", null, null, NO_RELEASE],
      ["words", null, null, NO_RELEASE],
      ["list", null, null, NO_RELEASE],
    ]);
    // Nothing of such a text is anywhere in what the look answers.
    const all = JSON.stringify(inv);
    for (const raw of ["error the install", "try curl", "\\u001b", "the newest"]) expect(all).not.toContain(raw);
  });

  it("L3: where a copy is, and where the one copy lives, are said as the caller says a path", () => {
    const local = path.join(home, ".local");
    globalCopy(local);
    const entry = npxEntry(path.join(home, ".npm"), "a1b2c3d4e5f6a7b8");
    const checkout = pkg(path.join(home, "code", "sessionpipe"), { holds: ["src"] });
    const said: string[] = [];
    const inv = look(
      looking({
        env: { PATH: path.join(local, "bin") },
        distDir: path.join(checkout, "dist"),
        tilde: (p) => {
          said.push(p);
          return `<${path.relative(home, p)}>`;
        },
      }),
    );
    expect(inv.copies.map((c) => c.where)).toEqual(["<.local>", "<.npm/_npx/a1b2c3d4e5f6a7b8>", "<code/sessionpipe>"]);
    expect(inv.home?.shown).toBe("<.local>");
    // A prefix, a cache entry's own folder, a folder that is no install; then the home.
    expect(said).toEqual([local, entry.entry, checkout, local]);
  });
});

describe.skipIf(win32)("look: links that lead nowhere, and files that only have the name", () => {
  it("a link to a sessionpipe that is gone: on PATH, in a prefix that is not on PATH, and once where it is both", () => {
    const x = path.join(tmp, "x");
    const local = path.join(home, ".local");
    linkBin(x);
    linkBin(local);
    const onPath = look(looking({ env: { PATH: path.join(x, "bin") } }));
    expect(onPath.dangling).toEqual([binOf(x), binOf(local)]);
    expect(onPath.onPath).toEqual([{ file: binOf(x), dir: slot(x) }]);
    expect(onPath.copies).toEqual([]);
    expect(onPath.typed).toBeNull();
    const both = look(looking({ env: { PATH: PATH(path.join(x, "bin"), path.join(local, "bin")) } }));
    expect(both.dangling).toEqual([binOf(x), binOf(local)]);
    expect(both.onPath).toEqual([
      { file: binOf(x), dir: slot(x) },
      { file: binOf(local), dir: slot(local) },
    ]);
    // A prefix with a link and nothing behind it may take the fresh copy: the first of them.
    expect(both.home).toEqual(place(x, LINKED, { onPath: true }));
  });

  it("a file npm didn't put there and a link to no install are strangers, each said as what it is; a link of someone's own to a build's cli.js starts that folder", () => {
    const [tools, links, dev, stale] = ["tools", "links", "dev", "stale"].map((n) => path.join(tmp, n)) as [
      string,
      string,
      string,
      string,
    ];
    for (const d of [tools, links, dev, stale]) mkdirSync(d);
    // A script of the name someone wrote.
    writeFileSync(path.join(tools, "sessionpipe"), "#!/bin/sh\necho mine\n");
    // A link to something else; a link to a checkout's build, in no `node_modules/sessionpipe`;
    // and a link to nowhere in particular.
    writeFileSync(path.join(tools, "run.sh"), "#!/bin/sh\n");
    symlinkSync(path.join(tools, "run.sh"), path.join(links, "sessionpipe"));
    const checkout = pkg(path.join(tmp, "code", "sessionpipe"), { holds: ["src"] });
    symlinkSync(path.join(checkout, "dist", "cli.js"), path.join(dev, "sessionpipe"));
    symlinkSync(path.join(tmp, "nowhere", "run"), path.join(stale, "sessionpipe"));
    const inv = look(looking({ env: { PATH: PATH(dev, tools, links, stale) } }));
    expect(inv.strangers).toEqual([
      { file: path.join(tools, "sessionpipe"), why: STRANGER },
      { file: path.join(links, "sessionpipe"), why: STRANGE_LINK },
      { file: path.join(stale, "sessionpipe"), why: STRANGE_LINK },
    ]);
    expect(STRANGER).toBe("a file npm didn't put there");
    expect(STRANGE_LINK).toBe("a link to no install of sessionpipe");
    expect(inv.onPath).toEqual([
      { file: path.join(dev, "sessionpipe"), dir: checkout },
      { file: path.join(tools, "sessionpipe"), dir: null },
      { file: path.join(links, "sessionpipe"), dir: null },
      { file: path.join(stale, "sessionpipe"), dir: null },
    ]);
    // The checkout is what typing starts, known without running it: a copy that is no
    // install. None of the four is a link to a sessionpipe that is gone.
    expect(inv.typed).toBe(checkout);
    expect(inv.unsure).toBeNull();
    expect(inv.copies).toEqual([stray(checkout, { uses: ["typed"] })]);
    expect(inv.dangling).toEqual([]);
    // What is typed is no install: the one clean copy has no place this look can name.
    expect(inv.home).toBeNull();
  });

  it("a link to a file that is not a `dist/cli.js`, however it is named, says nothing of what it starts", () => {
    const checkout = pkg(path.join(tmp, "code", "sessionpipe"), { holds: ["src", "bin"] });
    writeFileSync(path.join(checkout, "dist", "main.js"), "");
    writeFileSync(path.join(checkout, "bin", "cli.js"), "");
    const dirs = ["main", "bin-cli"].map((n) => path.join(tmp, n));
    for (const d of dirs) mkdirSync(d);
    symlinkSync(path.join(checkout, "dist", "main.js"), path.join(dirs[0] as string, "sessionpipe"));
    symlinkSync(path.join(checkout, "bin", "cli.js"), path.join(dirs[1] as string, "sessionpipe"));
    const inv = look(looking({ env: { PATH: PATH(...dirs) } }));
    expect(inv.strangers).toEqual(dirs.map((d) => ({ file: path.join(d, "sessionpipe"), why: STRANGE_LINK })));
    expect(inv.copies).toEqual([]);
    expect(inv.unsure).toBe(path.join(dirs[0] as string, "sessionpipe"));
  });

  it("a PATH entry that is another name for a bin folder: its link is read from where it really is", () => {
    // ~/bin is a link to ~/.local/bin, and only ~/bin is on PATH. npm's link is relative,
    // so read from ~/bin it would lead to ~/lib/…, which is not there.
    const local = path.join(home, ".local");
    globalCopy(local);
    symlinkSync(path.join(local, "bin"), path.join(home, "bin"));
    const inv = look(looking({ env: { PATH: path.join(home, "bin") } }));
    expect(inv.dangling).toEqual([]);
    expect(inv.onPath).toEqual([{ file: binOf(local), dir: slot(local) }]);
    // A shell looks in its command folder, by that other name.
    expect(inv.copies).toEqual([row(local, { uses: ["typed"], onPath: true })]);
    expect(inv.home).toEqual(place(local, TYPED, { onPath: true }));
  });

  it("a prefix whose bin folder is a link to a folder on PATH: its link that leads nowhere is listed once", () => {
    const local = path.join(home, ".local");
    const real = path.join(tmp, "dotfiles");
    linkBin(real);
    mkdirSync(local);
    symlinkSync(path.join(real, "bin"), path.join(local, "bin"));
    // Found on PATH and again in the prefix, it is one file: by the folder it is really in.
    for (const env of [{ PATH: path.join(local, "bin") }, { PATH: path.join(real, "bin") }])
      expect(look(looking({ env })).dangling).toEqual([binOf(real)]);
    // Off PATH it is found in the prefix alone, and named the same way.
    expect(look(looking()).dangling).toEqual([binOf(real)]);
  });

  it("a prefix whose bin folder is a link: its command goes in the folder that really is, on PATH or not", () => {
    const local = path.join(home, ".local");
    const real = path.join(tmp, "dotfiles", "bin");
    mkdirSync(real, { recursive: true });
    mkdirSync(path.join(tmp, "empty"));
    mkdirSync(local);
    symlinkSync(real, path.join(local, "bin"));
    // The folder it leads to is on PATH: that is where a shell finds what goes in it.
    expect(look(looking({ env: { PATH: PATH(path.join(tmp, "empty"), real) } })).home).toEqual(
      place(local, OWN, { bin: real, onPath: true }),
    );
    // Named on PATH through the link itself it is the same folder.
    expect(look(looking({ env: { PATH: path.join(local, "bin") } })).home).toEqual(
      place(local, OWN, { bin: real, onPath: true }),
    );
    // Not on PATH by either name: the real folder is still the one said, and no shell finds it.
    expect(look(looking({ env: { PATH: path.join(tmp, "empty") } })).home).toEqual(place(local, OWN, { bin: real }));
  });
});

describe.skipIf(win32)("look: what is not ours", () => {
  it("Volta's copy is Volta's to remove, and its folder is never where the one copy lives", () => {
    const volta = VOLTA();
    globalCopy(volta);
    const kept = row(volta, { slot: null, not: "Volta keeps it", keeper: "volta uninstall sessionpipe" });
    expect(kept.where).toBe(path.join("~", ".volta", "tools", "image", "packages", "sessionpipe"));
    // npm, run by Volta's Node, names that folder as its own: it is still no place.
    const inv = look(looking({ npmPrefix: volta }));
    expect(inv.copies).toEqual([kept]);
    expect(inv.home).toEqual(place(path.join(home, ".local"), OWN));
    // Typed through npm's own link in Volta's folder: what is typed is no install of ours.
    // (A shell looks in its command folder: `onPath` goes by the proof's slot, as Volta
    // lays its folder out, though the row is no copy of ours.)
    const typed = look(looking({ env: { PATH: path.join(volta, "bin") } }));
    expect(typed.copies).toEqual([{ ...kept, uses: ["typed"], onPath: true }]);
    expect(typed.typed).toBe(slot(volta));
    expect(typed.home).toBeNull();

    // Where VOLTA_HOME says Volta is.
    const told = path.join(tmp, "volta", "tools", "image", "packages", "sessionpipe");
    globalCopy(told);
    const there = look(looking({ env: { VOLTA_HOME: path.join(tmp, "volta") }, npmPrefix: told }));
    expect(there.copies).toEqual([
      row(told, { slot: null, not: "Volta keeps it", keeper: "volta uninstall sessionpipe" }),
    ]);
    expect(there.home).toEqual(place(path.join(home, ".local"), OWN));
  });

  it("M3: Volta's own command is a shim, first on PATH: which copy it starts can't be told from outside, and is Volta's when this command was started through it", () => {
    const volta = VOLTA();
    globalCopy(volta);
    // Volta's command for it: a link to its shim.
    const shim = path.join(home, ".volta", "bin", "sessionpipe");
    mkdirSync(path.dirname(shim), { recursive: true });
    writeFileSync(path.join(home, ".volta", "bin", "volta-shim"), "");
    symlinkSync("volta-shim", shim);
    const o = looking({ env: { PATH: path.join(home, ".volta", "bin") } });
    const inv = look(o);
    expect(inv.strangers).toEqual([{ file: shim, why: STRANGE_LINK }]);
    expect(inv.typed).toBeNull();
    expect(inv.unsure).toBe(shim);
    expect(inv.home).toBeNull();
    // Started through the shim, as npm's link to Volta's copy: that is what typing starts,
    // and it is Volta's: no place for a copy of ours either.
    const through = look({ ...o, distDir: path.join(slot(volta), "dist"), started: binOf(volta) });
    expect(through.typed).toBe(slot(volta));
    expect(through.unsure).toBeNull();
    expect(through.copies.map((c) => [c.uses, c.slot, c.not])).toEqual([[["typed", "this"], null, "Volta keeps it"]]);
    expect(through.home).toBeNull();
  });

  it("a checkout this command runs from is listed, with why it is no install", () => {
    const checkout = pkg(path.join(home, "code", "sessionpipe"), { holds: ["src", ".git"] });
    const inv = look(looking({ distDir: path.join(checkout, "dist") }));
    expect(inv.copies).toEqual([stray(checkout, { uses: ["this"] })]);
    expect(inv.copies[0]?.where).toBe(path.join("~", "code", "sessionpipe"));
    expect(inv.home).toEqual(place(path.join(home, ".local"), OWN));
  });

  it("M1: a slot that is a link to a checkout (`npm link`) is that checkout: listed once, by its own folder, as what typing starts", () => {
    const linked = path.join(tmp, "linked");
    const checkout = pkg(path.join(tmp, "code", "sessionpipe"), { holds: ["src"] });
    mkdirSync(modulesOf(linked), { recursive: true });
    symlinkSync(checkout, slot(linked));
    linkBin(linked);
    const inv = look(looking({ env: { PATH: path.join(linked, "bin") }, npmPrefix: linked }));
    // Found on PATH, and again as what its prefix's slot holds: one folder, one row.
    expect(inv.onPath).toEqual([{ file: binOf(linked), dir: checkout }]);
    expect(inv.copies).toEqual([stray(checkout, { uses: ["typed"] })]);
    expect(inv.typed).toBe(checkout);
    expect(inv.home).toBeNull();
    expect(twoNames(inv)).toEqual([]);
    // Off PATH it is found in the prefix alone, the same way; and npm's own folder, which
    // holds what is not ours, is no place for the one copy.
    const off = look(looking({ npmPrefix: linked }));
    expect(off.copies).toEqual([stray(checkout)]);
    expect(off.home).toEqual(place(path.join(home, ".local"), OWN));
  });

  it("a slot that holds a build, or a link to nothing: listed, not ours, and no place for the one copy", () => {
    // A build someone copied into the slot.
    const built = path.join(tmp, "built");
    globalCopy(built, { holds: ["src"] });
    // A link in the slot whose folder is gone.
    const hollow = path.join(tmp, "hollow");
    mkdirSync(modulesOf(hollow), { recursive: true });
    symlinkSync(path.join(tmp, "code", "gone"), slot(hollow));
    const HOLDS = "it holds src, which no published sessionpipe has (a checkout or a build?)";
    const o = looking({ env: { PATH: path.join(built, "bin") } });
    const inv = look({ ...o, npmPrefix: hollow });
    expect(inv.copies).toEqual([
      refused(built, HOLDS, { uses: ["typed"] }),
      refused(hollow, A_LINK, { version: null, wrong: MISSING, bins: [] }),
    ]);
    // What is typed is no install of ours: no place.
    expect(inv.home).toBeNull();
    // With nothing typed, such a prefix is passed over for the next reason.
    const own = place(path.join(home, ".local"), OWN);
    expect(look(looking({ npmPrefix: hollow })).home).toEqual(own);
    expect(look(looking({ npmPrefix: built })).home).toEqual(own);
  });
});

describe.skipIf(win32)("look: what typing `sessionpipe` starts, and where the one copy lives", () => {
  /** A copy typed that is not this user's to write, and a folder of their own that is. */
  const sudoInstall = (refuse: (dirs: string[]) => void, which: (sys: string) => string[]) => {
    const sys = path.join(tmp, "usr", "local");
    const local = path.join(home, ".local");
    globalCopy(sys);
    mkdirSync(path.join(local, "bin"), { recursive: true });
    mkdirSync(modulesOf(local), { recursive: true });
    refuse(which(sys));
    return { sys, local };
  };
  const both = (sys: string): string[] => [modulesOf(sys), path.join(sys, "bin")];

  /** The review's M3a, as the look sees it: the home is the typed copy's own folder, said
   *  as not writable, wherever a writable folder of the user's own is on PATH. */
  const homeIsWhatIsTyped = (refuse: (dirs: string[]) => void) => () => {
    const { sys, local } = sudoInstall(refuse, both);
    for (const dirs of [
      [path.join(sys, "bin"), path.join(local, "bin")],
      [path.join(local, "bin"), path.join(sys, "bin")],
    ]) {
      const inv = look(looking({ env: { PATH: PATH(...dirs) } }));
      expect(inv.typed).toBe(slot(sys));
      expect(inv.unsure).toBeNull();
      expect(inv.copies).toEqual([row(sys, { uses: ["typed"], writable: false })]);
      expect(inv.home).toEqual(place(sys, TYPED, { onPath: true, writable: false }));
      expect(inv.home?.prefix).not.toBe(local);
    }
    // Started by npx, from its cache: the same.
    const npx = npxEntry(path.join(home, ".npm"), "a1b2c3d4e5f6a7b8");
    const inv = look(
      looking({
        env: { npm_command: "exec", PATH: PATH(npx.bin, path.join(local, "bin"), path.join(sys, "bin")) },
        distDir: path.join(npx.dir, "dist"),
        started: path.join(npx.bin, "sessionpipe"),
        npmPrefix: local,
      }),
    );
    expect(inv.home).toEqual(place(sys, TYPED, { onPath: true, writable: false }));
  };
  it(
    "M3: the usual sudo install: the home is where the copy that is typed lives, though this user may not write there and a folder of their own is on PATH, before it or behind",
    homeIsWhatIsTyped((dirs) => {
      fake.access = (p) => (dirs.includes(p) ? "EACCES" : null);
    }),
  );
  it.runIf(refusable)(
    "M3: the same where the system itself refuses the folders (chmod 555)",
    homeIsWhatIsTyped((dirs) => dirs.forEach(lock)),
  );

  it("M3: writable means the package folder and the command's folder both: one of them refused is a home this user may not write", () => {
    const refuse = (dirs: string[]) => {
      fake.access = (p) => (dirs.includes(p) ? "EACCES" : null);
    };
    const packages = sudoInstall(refuse, (sys) => [modulesOf(sys)]);
    const first = look(looking({ env: { PATH: path.join(packages.sys, "bin") } }));
    expect(first.home).toEqual(place(packages.sys, TYPED, { onPath: true, writable: false }));
    expect(first.copies[0]?.writable).toBe(false);
    // The command's folder alone: the copy's own folder could be written, the home not.
    refuse([path.join(packages.sys, "bin")]);
    const second = look(looking({ env: { PATH: path.join(packages.sys, "bin") } }));
    expect(second.home).toEqual(place(packages.sys, TYPED, { onPath: true, writable: false }));
    expect(second.copies[0]?.writable).toBe(true);
    // Neither refused: writable.
    fake.access = null;
    expect(look(looking({ env: { PATH: path.join(packages.sys, "bin") } })).home).toEqual(
      place(packages.sys, TYPED, { onPath: true }),
    );
  });

  /** A version manager's shim first on PATH, the one healthy copy in the Node it leads
   *  to, and a folder of the user's own on PATH behind it (the review's M3b). */
  const shimmed = (shim: (file: string) => void) => {
    const shims = path.join(home, ".asdf", "shims");
    const real = node.asdf();
    const local = path.join(home, ".local");
    mkdirSync(shims, { recursive: true });
    shim(path.join(shims, "sessionpipe"));
    globalCopy(real);
    mkdirSync(path.join(local, "bin"), { recursive: true });
    const env = { PATH: PATH(shims, path.join(local, "bin")) };
    return { file: path.join(shims, "sessionpipe"), real, local, env };
  };
  const SHIMS: [string, string, (file: string) => void][] = [
    ["a script", STRANGER, (file) => writeFileSync(file, '#!/bin/sh\nexec asdf exec sessionpipe "$@"\n')],
    [
      "a link to the manager's own program",
      STRANGE_LINK,
      (file) => {
        writeFileSync(path.join(path.dirname(file), "shim"), "");
        symlinkSync("shim", file);
      },
    ],
  ];

  it.each(SHIMS)(
    "M3: a shim first on PATH (%s), and this command started through it, as npm's link to the installed copy: that copy is what typing starts, and its folder is the home",
    (_kind, why, shim) => {
      const { file, real, env } = shimmed(shim);
      // A shim ends by starting npm's own link in the Node it chose: that is what this
      // command was started as.
      const inv = look(looking({ env, distDir: path.join(slot(real), "dist"), started: binOf(real) }));
      expect(inv.strangers).toEqual([{ file, why }]);
      expect(inv.onPath).toEqual([{ file, dir: null }]);
      expect(inv.typed).toBe(slot(real));
      expect(inv.unsure).toBeNull();
      expect(inv.copies).toEqual([row(real, { uses: ["typed", "this"] })]);
      // Its own folder, though it is not on PATH and ~/.local/bin is: the shim finds it.
      expect(inv.home).toEqual(place(real, TYPED));
      // The link named another way (through a link to the home) is the same link.
      symlinkSync(home, path.join(tmp, "also-home"));
      const named = path.join(tmp, "also-home", path.relative(home, binOf(real)));
      expect(look(looking({ env, distDir: path.join(slot(real), "dist"), started: named })).typed).toBe(slot(real));
    },
  );

  it.each(SHIMS)(
    "M3: a shim first on PATH (%s), and this command not started as npm's link to an installed copy: which copy the shim starts can't be told, and no home is named",
    (_kind, _why, shim) => {
      const { file, real, env } = shimmed(shim);
      const checkout = pkg(path.join(home, "code", "sessionpipe"), { holds: ["src"] });
      const npx = npxEntry(path.join(home, ".npm"), "a1b2c3d4e5f6a7b8");
      const leftover = pkg(path.join(modulesOf(real), ".sessionpipe-Ab3dE9xZ"));
      const far = path.join(tmp, "far");
      globalCopy(far);
      const second = path.join(home, ".npm-global");
      globalCopy(second);
      const dist = (dir: string): string => path.join(dir, "dist");
      const cases: [string, Partial<Looking>][] = [
        ["from nowhere in reach", {}],
        ["a checkout, by its cli.js", { distDir: dist(checkout), started: path.join(checkout, "dist", "cli.js") }],
        ["an npx cache entry, by npx's link", { distDir: dist(npx.dir), started: path.join(npx.bin, "sessionpipe") }],
        [
          "a leftover of an install that was cut off",
          { distDir: dist(leftover), started: path.join(leftover, "dist", "cli.js") },
        ],
        ["npm's link to a copy in a folder nobody looked in", { distDir: dist(slot(far)), started: binOf(far) }],
        // The installed copy itself, but not as a shim starts it.
        ["the installed copy by its cli.js", { distDir: dist(slot(real)), started: cliOf(real) }],
        ["the installed copy, started as nothing that can be read", { distDir: dist(slot(real)), started: "" }],
        ["the installed copy, said to be started as the shim", { distDir: dist(slot(real)), started: file }],
        ["the installed copy, started as npm's link to another", { distDir: dist(slot(real)), started: binOf(second) }],
      ];
      for (const [how, from] of cases) {
        const inv = look(looking({ env, ...from }));
        expect(inv.typed, how).toBeNull();
        expect(inv.unsure, how).toBe(file);
        expect(inv.home, how).toBeNull();
        // The copy is found, and nothing is said to type it.
        expect(inv.copies.find((c) => c.dir === slot(real))?.uses.includes("typed"), how).toBe(false);
        expect(
          inv.copies.flatMap((c) => c.uses),
          how,
        ).toEqual(from.distDir ? ["this"] : []);
      }
    },
  );

  const SCRIPT = '#!/bin/sh\nexec node ~/code/sessionpipe/dist/cli.js "$@"\n';

  it("M3: a file that is no link of npm's at the command path of a prefix that holds an installed copy is no shim: it sits where that copy's link was, nothing is typed, nothing is unsure, and that prefix is the home with the file in its way", () => {
    const local = path.join(home, ".local");
    const b = node.nvm();
    pkg(slot(local));
    mkdirSync(path.join(local, "bin"));
    writeFileSync(binOf(local), SCRIPT);
    globalCopy(b);
    const o = looking({
      env: { PATH: PATH(path.join(local, "bin"), path.join(b, "bin")) },
      npmPrefix: path.join(tmp, "npm"),
    });
    const blocked = place(local, IN_WAY, { onPath: true, blocked: binOf(local) });
    const inv = look(o);
    expect(inv.strangers).toEqual([{ file: binOf(local), why: STRANGER }]);
    expect(inv.onPath).toEqual([
      { file: binOf(local), dir: null },
      { file: binOf(b), dir: slot(b) },
    ]);
    // A shell starts the file, not the copy behind it on PATH: nothing of ours is typed.
    expect(inv.typed).toBeNull();
    expect(inv.unsure).toBeNull();
    expect(inv.copies).toEqual([row(b), row(local, { bins: [], wrong: NO_LINK })]);
    expect(inv.home).toEqual(blocked);
    // It is no shim however this command was started: as npm's link to the other copy,
    // which is how a shim would have started it, typing still starts the file.
    const through = look({ ...o, distDir: path.join(slot(b), "dist"), started: binOf(b) });
    expect(through.typed).toBeNull();
    expect(through.unsure).toBeNull();
    expect(through.home).toEqual(blocked);
    // A link to something that is no install, in the same place: the same.
    rmSync(binOf(local));
    writeFileSync(path.join(tmp, "run.sh"), "#!/bin/sh\n");
    symlinkSync(path.join(tmp, "run.sh"), binOf(local));
    const linked = look(o);
    expect(linked.strangers).toEqual([{ file: binOf(local), why: STRANGE_LINK }]);
    expect(linked.typed).toBeNull();
    expect(linked.unsure).toBeNull();
    expect(linked.home).toEqual(blocked);
  });

  it("M3: such a file where the prefix holds no installed copy is a shim as far as can be told: nothing there, a build, a leftover alone, a folder nobody looked in", () => {
    const at = (n: string): string => path.join(tmp, n);
    const script = (prefix: string): string => {
      mkdirSync(path.join(prefix, "bin"), { recursive: true });
      writeFileSync(binOf(prefix), SCRIPT);
      return binOf(prefix);
    };
    // npm's own folder each time, so the folder is one that is looked in as a prefix.
    const unsureAt = (prefix: string) => look(looking({ env: { PATH: path.join(prefix, "bin") }, npmPrefix: prefix }));
    script(at("empty"));
    pkg(slot(at("built")), { holds: ["src"] });
    script(at("built"));
    pkg(path.join(modulesOf(at("leftover")), ".sessionpipe-Ab3dE9xZ"));
    script(at("leftover"));
    for (const n of ["empty", "built", "leftover"]) {
      const inv = unsureAt(at(n));
      expect(inv.typed).toBeNull();
      expect(inv.unsure).toBe(binOf(at(n)));
      expect(inv.home).toBeNull();
    }
    // A whole copy under it, in a folder that was not looked in as a prefix: by its shape
    // alone that copy could be any project's, so the file is not known to be in its way.
    pkg(slot(at("far")));
    script(at("far"));
    const far = look(looking({ env: { PATH: path.join(at("far"), "bin") } }));
    expect(far.unsure).toBe(binOf(at("far")));
    expect(far.copies).toEqual([]);
    // Looked in as one, it is.
    const near = unsureAt(at("far"));
    expect(near.unsure).toBeNull();
    expect(near.home).toEqual(place(at("far"), IN_WAY, { onPath: true, blocked: binOf(at("far")) }));
  });

  it("M3: a file that is no install behind a link that leads nowhere is what a shell starts: the copies after it are not what is typed", () => {
    const [gone, a] = [path.join(tmp, "gone"), path.join(tmp, "a")];
    linkBin(gone);
    globalCopy(a);
    mkdirSync(path.join(tmp, "tools"));
    writeFileSync(path.join(tmp, "tools", "sessionpipe"), "#!/bin/sh\necho mine\n");
    const inv = look(
      looking({ env: { PATH: PATH(path.join(gone, "bin"), path.join(tmp, "tools"), path.join(a, "bin")) } }),
    );
    expect(inv.copies).toEqual([row(a)]);
    expect(inv.onPath.map((e) => e.dir)).toEqual([slot(gone), null, slot(a)]);
    expect(inv.typed).toBeNull();
    expect(inv.unsure).toBe(path.join(tmp, "tools", "sessionpipe"));
    expect(inv.home).toBeNull();
    // Behind a copy that starts, the same file is only what is left alone.
    const behind = look(looking({ env: { PATH: PATH(path.join(a, "bin"), path.join(tmp, "tools")) } }));
    expect(behind.typed).toBe(slot(a));
    expect(behind.unsure).toBeNull();
    expect(behind.strangers).toEqual([{ file: path.join(tmp, "tools", "sessionpipe"), why: STRANGER }]);
    expect(behind.home).toEqual(place(a, TYPED, { onPath: true }));
  });

  it("M3: what is typed is a copy that is no install (a checkout linked on PATH): no home, whatever else is on the computer", () => {
    const checkout = pkg(path.join(home, "code", "sessionpipe"), { holds: ["src"] });
    mkdirSync(path.join(home, "bin"));
    symlinkSync(path.join(checkout, "dist", "cli.js"), path.join(home, "bin", "sessionpipe"));
    const local = path.join(home, ".local");
    globalCopy(local);
    const inv = look(
      looking({
        env: { PATH: PATH(path.join(home, "bin"), path.join(local, "bin")) },
        npmPrefix: path.join(tmp, "npm"),
      }),
    );
    expect(inv.typed).toBe(checkout);
    expect(inv.copies).toEqual([stray(checkout, { uses: ["typed"] }), row(local)]);
    expect(inv.home).toBeNull();
  });

  it("M3: with nothing typed, the first place by its reason: a link to a copy that is gone, this command's, the service's, another copy's, npm's own, then ~/.local", () => {
    const linked = path.join(tmp, "n");
    const [mine, served, another, npm, local] = [
      node.nvm(),
      node.asdf(),
      path.join(home, ".npm-global"),
      path.join(tmp, "npm"),
      path.join(home, ".local"),
    ];
    // Built up from an empty computer, each reason comes before the one found before it.
    const steps: [() => Partial<Looking>, Home][] = [
      [() => ({}), place(local, OWN)],
      [() => ({ npmPrefix: npm }), place(npm, NPM)],
      [
        () => {
          globalCopy(another);
          return {};
        },
        place(another, ANOTHER),
      ],
      [
        () => {
          globalCopy(served);
          return { serviceCli: cliOf(served) };
        },
        place(served, SERVICE),
      ],
      [
        () => {
          globalCopy(mine);
          return { distDir: path.join(slot(mine), "dist") };
        },
        place(mine, THIS),
      ],
      [
        () => {
          linkBin(linked);
          return { env: { N_PREFIX: linked } };
        },
        place(linked, LINKED),
      ],
    ];
    let o = looking();
    for (const [more, home] of steps) {
      o = { ...o, ...more() };
      const inv = look(o);
      expect(inv.typed).toBeNull();
      expect(inv.unsure).toBeNull();
      expect(inv.home).toEqual(home);
    }
    // All six are there now, and none is on PATH.
    expect(look(o).copies.map((c) => [c.prefix, c.uses])).toEqual([
      [another, []],
      [mine, ["this"]],
      [served, ["service"]],
    ]);
    expect(look(o).dangling).toEqual([binOf(linked)]);
  });

  it("M3: with nothing typed, a place a shell looks in comes before one it doesn't; among those, the order of the reasons and not of PATH", () => {
    const [mine, npm, local] = [node.nvm(), path.join(tmp, "npm"), path.join(home, ".local")];
    globalCopy(mine);
    const o = looking({ distDir: path.join(slot(mine), "dist"), npmPrefix: npm });
    // This command's copy is not on PATH, ~/.local/bin is (with nothing in it, there or not).
    expect(look({ ...o, env: { PATH: path.join(local, "bin") } }).home).toEqual(place(local, OWN, { onPath: true }));
    // npm's own bin folder too: it is the earlier reason, whichever way PATH lists them.
    for (const dirs of [
      [path.join(local, "bin"), path.join(npm, "bin")],
      [path.join(npm, "bin"), path.join(local, "bin")],
    ])
      expect(look({ ...o, env: { PATH: PATH(...dirs) } }).home).toEqual(place(npm, NPM, { onPath: true }));
    // None of them on PATH: the first reason.
    expect(look({ ...o, env: { PATH: path.join(tmp, "empty") } }).home).toEqual(place(mine, THIS));
    // And a copy that IS typed decides it alone, behind an empty folder of the user's own.
    const typed = path.join(home, ".npm-global");
    globalCopy(typed);
    expect(look({ ...o, env: { PATH: PATH(path.join(local, "bin"), path.join(typed, "bin")) } }).home).toEqual(
      place(typed, TYPED, { onPath: true }),
    );
  });

  it("a prefix is one place, for the reason that decides: typed, the service's, this command's and npm's own at once", () => {
    const local = path.join(home, ".local");
    globalCopy(local);
    const o = looking({ distDir: path.join(slot(local), "dist"), serviceCli: cliOf(local), npmPrefix: local });
    const inv = look({ ...o, env: { PATH: path.join(local, "bin") } });
    expect(inv.copies).toEqual([row(local, { uses: ["typed", "service", "this"], onPath: true })]);
    expect(inv.home).toEqual(place(local, TYPED, { onPath: true }));
    // Off PATH: where this command runs from.
    expect(look(o).home).toEqual(place(local, THIS));
    expect(look(o).copies).toEqual([row(local, { uses: ["service", "this"], onPath: false })]);
  });

  it("a fresh copy is not put in Homebrew's versioned folder for a Node, which the next upgrade takes away; the copy that is typed from there has its home there all the same", () => {
    const cellar = path.join(tmp, "opt", "homebrew", "Cellar");
    const own = place(path.join(home, ".local"), OWN);
    for (const formula of [path.join("node", "23.1.0"), path.join("node@22", "22.11.0")]) {
      mkdirSync(path.join(cellar, formula), { recursive: true });
      expect(look(looking({ npmPrefix: path.join(cellar, formula) })).home).toEqual(own);
    }
    // A copy that is there and that nobody types is no reason to put the fresh one there either.
    const brewed = path.join(cellar, "node", "23.1.0");
    globalCopy(brewed);
    const untyped = look(looking({ npmPrefix: brewed, distDir: path.join(slot(brewed), "dist") }));
    expect(untyped.copies).toEqual([row(brewed, { uses: ["this"] })]);
    expect(untyped.home).toEqual(own);
    // The copy that is typed from there: its folder is the home, whatever it is. The home
    // is where the typed copy lives and never another place, and with no home at all the
    // plan could only refuse (and named `doctor`, which named `reinstall` back).
    const typed = look(looking({ npmPrefix: brewed, env: { PATH: path.join(brewed, "bin") } }));
    expect(typed.copies).toEqual([row(brewed, { uses: ["typed"] })]);
    expect(typed.home).toEqual(place(brewed, TYPED, { onPath: true }));
    // Found by its link on PATH alone, where npm names another folder: the same.
    const found = look(looking({ env: { PATH: path.join(brewed, "bin") } }));
    expect(found.prefixes).toContain(brewed);
    expect(found.home).toEqual(place(brewed, TYPED, { onPath: true }));
    // Only a Node's: another formula's folder is a folder like any other.
    const other = path.join(cellar, "nodebrew", "1.2.0");
    expect(look(looking({ npmPrefix: other })).home).toEqual(place(other, NPM));
  });

  it("not a folder outside the reach, and none at all where nothing is in reach", () => {
    const world = path.join(tmp, "world");
    mkdirSync(path.join(world, "home"), { recursive: true });
    const o = looking({
      home: path.join(world, "home"),
      reach: world,
      execPath: path.join(world, "node", "bin", "node"),
      npmPrefix: path.join(tmp, "outside"),
    });
    expect(look(o).home).toEqual(place(path.join(world, "home", ".local"), OWN));
    expect(look({ ...o, home, npmPrefix: null }).home).toBeNull();
  });
});

describe.skipIf(win32)("look: what sits where the home's command goes", () => {
  const SCRIPT = '#!/bin/sh\nexec node ~/code/sessionpipe/dist/cli.js "$@"\n';
  const at = (n: string): string => path.join(tmp, n);
  /** The home named where npm's own folder is `prefix` and nothing is on PATH. */
  const homeWith = (prefix: string) => look(looking({ npmPrefix: prefix })).home;

  it("nothing there, npm's link to the copy there, and npm's link whose folder is gone block nothing", () => {
    mkdirSync(path.join(at("empty"), "bin"), { recursive: true });
    globalCopy(at("whole"));
    linkBin(at("hollow"));
    expect(homeWith(at("empty"))).toEqual(place(at("empty"), NPM));
    expect(homeWith(at("whole"))).toEqual(place(at("whole"), ANOTHER));
    // What npm left when its folder went is a link to this very slot: the install writes it again.
    const inv = look(looking({ npmPrefix: at("hollow") }));
    expect(inv.dangling).toEqual([binOf(at("hollow"))]);
    expect(inv.home).toEqual(place(at("hollow"), LINKED));
  });

  it("a script, a link to what is no install, a link to nowhere, npm's kind of link into another prefix: each is said by its file", () => {
    for (const n of ["script", "linked", "stale", "other"]) mkdirSync(path.join(at(n), "bin"), { recursive: true });
    writeFileSync(binOf(at("script")), SCRIPT);
    writeFileSync(at("run.sh"), "#!/bin/sh\n");
    symlinkSync(at("run.sh"), binOf(at("linked")));
    symlinkSync(path.join(at("nowhere"), "run"), binOf(at("stale")));
    // As npm writes one, but into the copy another prefix holds.
    globalCopy(at("elsewhere"));
    symlinkSync(
      path.join("..", "..", "elsewhere", "lib", "node_modules", "sessionpipe", "dist", "cli.js"),
      binOf(at("other")),
    );
    for (const n of ["script", "linked", "stale", "other"])
      expect(homeWith(at(n))).toEqual(place(at(n), NPM, { blocked: binOf(at(n)) }));
    // The same over a copy that is there: its own link is what the file took the place of.
    pkg(slot(at("script")));
    expect(homeWith(at("script"))).toEqual(place(at("script"), ANOTHER, { blocked: binOf(at("script")) }));
  });

  it("such a home is the home all the same: the copy typed through a link of someone's own lives there", () => {
    const local = path.join(home, ".local");
    const b = at("b");
    // A script where npm's link was; the copy is still what is typed, through a link in ~/bin.
    pkg(slot(local));
    mkdirSync(path.join(local, "bin"));
    writeFileSync(binOf(local), SCRIPT);
    mkdirSync(path.join(home, "bin"));
    symlinkSync(cliOf(local), path.join(home, "bin", "sessionpipe"));
    globalCopy(b);
    const inv = look(
      looking({
        env: { PATH: PATH(path.join(home, "bin"), path.join(local, "bin"), path.join(b, "bin")) },
        npmPrefix: at("npm"),
      }),
    );
    // Typed through a link someone made; npm's own is gone all the same, and that is said.
    expect(inv.copies).toEqual([row(local, { bins: [], uses: ["typed"], wrong: NO_LINK }), row(b)]);
    expect(inv.strangers).toEqual([{ file: binOf(local), why: STRANGER }]);
    expect(inv.home).toEqual(place(local, TYPED, { onPath: true, blocked: binOf(local) }));
    // With nothing on PATH: first for its reason all the same, a clean folder behind it.
    const off = look(looking({ distDir: path.join(slot(local), "dist"), npmPrefix: b }));
    expect(off.home).toEqual(place(local, THIS, { blocked: binOf(local) }));
  });

  it("where the home's bin folder is a link, the file is named in the folder that really is", () => {
    const local = path.join(home, ".local");
    const real = path.join(at("dotfiles"), "bin");
    mkdirSync(real, { recursive: true });
    mkdirSync(local);
    symlinkSync(real, path.join(local, "bin"));
    writeFileSync(path.join(real, "sessionpipe"), SCRIPT);
    const blocked = path.join(real, "sessionpipe");
    expect(look(looking()).home).toEqual(place(local, OWN, { bin: real, blocked }));
    expect(look(looking({ env: { PATH: path.join(local, "bin") } })).home).toBeNull();
  });
});

describe.skipIf(win32)("look: only what is inside the reach folder", () => {
  /** A world of its own beside a copy, a link, a stranger and a cache that are not its. */
  const worlds = () => {
    const world = path.join(tmp, "world");
    const outside = path.join(tmp, "outside");
    const inHome = path.join(world, "home");
    const local = path.join(inHome, ".local");
    globalCopy(local);
    for (const n of ["typed", "mine", "served", "npm"]) globalCopy(path.join(outside, n));
    linkBin(path.join(outside, "hollow"));
    mkdirSync(path.join(outside, "tools"), { recursive: true });
    writeFileSync(path.join(outside, "tools", "sessionpipe"), "#!/bin/sh\n");
    pkg(path.join(outside, "cache", "_npx", "a1b2c3d4e5f6a7b8", "node_modules", "sessionpipe"));
    const o = looking({
      home: inHome,
      reach: world,
      execPath: path.join(world, "node", "bin", "node"),
      env: {
        PATH: PATH(
          path.join(outside, "typed", "bin"),
          path.join(outside, "hollow", "bin"),
          path.join(outside, "tools"),
          path.join(local, "bin"),
        ),
        npm_config_cache: path.join(outside, "cache"),
        npm_config_prefix: path.join(outside, "npm"),
      },
      distDir: path.join(slot(path.join(outside, "mine")), "dist"),
      serviceCli: cliOf(path.join(outside, "served")),
      npmPrefix: path.join(outside, "npm"),
    });
    return { world, outside, local, o };
  };

  it("a copy, a link, a file and a cache outside it are not listed, and what is typed is the first inside it", () => {
    const { world, outside, local, o } = worlds();
    const inv = look(o);
    expect(inv).toEqual({
      reach: world,
      copies: [row(local, { uses: ["typed"] })],
      dangling: [],
      strangers: [],
      onPath: [{ file: binOf(local), dir: slot(local) }],
      typed: slot(local),
      unsure: null,
      home: place(local, TYPED, { onPath: true }),
      taken: null,
      prefixes: [
        path.join(world, "node"),
        local,
        path.join(world, "home", ".npm-global"),
        path.join(world, "home", ".volta", "tools", "image", "packages", "sessionpipe"),
      ],
      // The cache npm was told to keep is named as it is; nothing in it is in reach.
      npx: path.join(outside, "cache", "_npx"),
    } satisfies Inventory);
  });

  it("the reach folder named through a link is the same folder", () => {
    const { world, local, o } = worlds();
    symlinkSync(world, path.join(tmp, "alias"));
    const inv = look({ ...o, reach: path.join(tmp, "alias") });
    expect(inv.reach).toBe(world);
    expect(inv.copies).toEqual([row(local, { uses: ["typed"] })]);
  });

  it("with no folder its own, nothing is listed and no place is named", () => {
    const { outside, o } = worlds();
    expect(look({ ...o, reach: null })).toEqual({
      reach: null,
      copies: [],
      dangling: [],
      strangers: [],
      onPath: [],
      typed: null,
      unsure: null,
      home: null,
      taken: null,
      prefixes: [],
      npx: path.join(outside, "cache", "_npx"),
    } satisfies Inventory);
  });

  it("a link that leads nowhere, in a bin folder that is itself a link to outside, is not listed", () => {
    const world = path.join(tmp, "world");
    const local = path.join(world, "home", ".local");
    mkdirSync(local, { recursive: true });
    mkdirSync(path.join(tmp, "outside", "bin"), { recursive: true });
    symlinkSync(path.join(tmp, "outside", "bin"), path.join(local, "bin"));
    symlinkSync(cliOf(local), path.join(tmp, "outside", "bin", "sessionpipe"));
    const inv = look(looking({ home: path.join(world, "home"), reach: world }));
    expect(inv.dangling).toEqual([]);
    expect(inv.copies).toEqual([]);
  });

  it("with every folder this computer's, what is in the temp folder is all found", () => {
    const { outside, local, o } = worlds();
    const inv = look({ ...o, reach: true });
    expect(inv.reach).toBe(true);
    // Only what this test made is looked at here: the rest is this machine's own.
    const mine = <T>(list: T[], at: (x: T) => string): T[] => list.filter((x) => within(tmp, at(x)));
    const out = (n: string, o: Partial<Copy> = {}) =>
      row(path.join(outside, n), { where: path.join(outside, n), ...o });
    const entry = path.join(outside, "cache", "_npx", "a1b2c3d4e5f6a7b8");
    expect(mine(inv.copies, (c) => c.dir)).toEqual([
      out("typed", { uses: ["typed"] }),
      row(local),
      out("npm"),
      cachedRow({ entry, bin: "", dir: path.join(entry, "node_modules", "sessionpipe") }, { bins: [] }),
      // Found by this command's own place and by the service file, in folders no Node is
      // known to keep its packages in: not installs.
      stray(slot(path.join(outside, "mine")), { uses: ["this"] }),
      stray(slot(path.join(outside, "served")), { uses: ["service"] }),
    ]);
    expect(mine(inv.dangling, (f) => f)).toEqual([binOf(path.join(outside, "hollow"))]);
    expect(mine(inv.strangers, (s) => s.file)).toEqual([
      { file: path.join(outside, "tools", "sessionpipe"), why: STRANGER },
    ]);
    expect(mine(inv.onPath, (e) => e.file).map((e) => e.file)).toEqual([
      binOf(path.join(outside, "typed")),
      binOf(path.join(outside, "hollow")),
      path.join(outside, "tools", "sessionpipe"),
      binOf(local),
    ]);
    expect(inv.typed).toBe(slot(path.join(outside, "typed")));
    expect(inv.home).toEqual({
      ...place(path.join(outside, "typed"), TYPED, { onPath: true }),
      shown: path.join(outside, "typed"),
    });
    // The places a system Node and Homebrew use are looked in now, by their one name each.
    for (const p of SYSTEM) expect(inv.prefixes).toContain(spelled(p));
    expect(mine(inv.prefixes, (p) => p)).toEqual([
      path.join(tmp, "world", "node"),
      path.join(outside, "npm"),
      local,
      path.join(tmp, "world", "home", ".npm-global"),
      path.join(tmp, "world", "home", ".volta", "tools", "image", "packages", "sessionpipe"),
      path.join(outside, "typed"),
      path.join(outside, "hollow"),
    ]);
  });
});

describe.skipIf(win32)("look: one folder under two spellings is one folder", () => {
  /** A computer in a folder with two names: `world`, and `other`, a link to it. One
   *  healthy copy in its ~/.local. `by`: a path of it said by the other name. */
  const twoSpellings = () => {
    const world = path.join(tmp, "world");
    const other = path.join(tmp, "other");
    const inHome = path.join(world, "home");
    const local = path.join(inHome, ".local");
    mkdirSync(inHome, { recursive: true });
    symlinkSync(world, other);
    globalCopy(local);
    const by = (p: string): string => path.join(other, path.relative(world, p));
    const o = looking({ home: inHome, reach: world, execPath: path.join(world, "node", "bin", "node") });
    /** What every look at it answers, however it is asked. */
    const one: Inventory = {
      reach: world,
      // A shell looks in its command folder, by whichever spelling PATH has for it.
      copies: [row(local, { uses: ["typed"], onPath: true })],
      dangling: [],
      strangers: [],
      onPath: [{ file: binOf(local), dir: slot(local) }],
      typed: slot(local),
      unsure: null,
      home: place(local, TYPED, { onPath: true }),
      taken: null,
      prefixes: [
        path.join(world, "node"),
        local,
        path.join(inHome, ".npm-global"),
        path.join(inHome, ".volta", "tools", "image", "packages", "sessionpipe"),
      ],
      npx: path.join(inHome, ".npm", "_npx"),
    };
    return { world, other, inHome, local, by, o, one };
  };

  it("M1: one healthy copy, and PATH names its folder by another spelling of the home (a link to it): one copy, typed, its own folder the home, every path by one name", () => {
    // What this pins is the property, on every POSIX system. It does not tell the fix
    // from the code before it: a link is led through by the old `fs.realpathSync` too.
    // What that one did not do is know a folder by the case the disk keeps it in, or by
    // its device and inode where it has two real names: the tests after this one.
    const { local, by, o, one } = twoSpellings();
    const inv = look({ ...o, env: { PATH: by(path.join(local, "bin")) } });
    expect(inv).toEqual(one);
    expect(inv.copies).toHaveLength(1);
    expect(inv.onPath).toHaveLength(1);
    expect(twoNames(inv)).toEqual([]);
    // The check has teeth: an inventory that names one folder twice is told.
    expect(twoNames({ ...inv, prefixes: [...inv.prefixes, by(local)] })).toEqual([[by(local), local].sort()]);
    // The same folder twice on PATH, by both spellings, either first: one entry.
    for (const dirs of [
      [by(path.join(local, "bin")), path.join(local, "bin")],
      [path.join(local, "bin"), by(path.join(local, "bin"))],
    ])
      expect(look({ ...o, env: { PATH: PATH(...dirs) } })).toEqual(one);
  });

  it("M1: everything the look is told, said by the other spelling, comes out by the one: the home, the reach, the Node, npm's prefix and cache, this command's place, the service file's", () => {
    const { world, other, inHome, local, by, o, one } = twoSpellings();
    const inv = look({
      ...o,
      home: by(inHome),
      reach: other,
      execPath: by(path.join(world, "node", "bin", "node")),
      env: { PATH: by(path.join(local, "bin")), npm_config_cache: by(path.join(inHome, ".npm")) },
      npmPrefix: by(local),
      distDir: by(path.join(slot(local), "dist")),
      serviceCli: by(cliOf(local)),
    });
    expect(inv).toEqual({ ...one, copies: [row(local, { uses: ["typed", "service", "this"], onPath: true })] });
    expect(twoNames(inv)).toEqual([]);
    // A second copy, a leftover, a link that leads nowhere and a stranger, each reached by
    // the other spelling only: every one by its one name.
    const second = path.join(inHome, ".npm-global");
    globalCopy(second, { version: "0.14.2" });
    pkg(path.join(modulesOf(second), ".sessionpipe-Ab3dE9xZ"));
    linkBin(path.join(world, "gone"));
    mkdirSync(path.join(world, "tools"));
    writeFileSync(path.join(world, "tools", "sessionpipe"), "#!/bin/sh\n");
    const more = look({
      ...o,
      home: by(inHome),
      env: {
        PATH: PATH(...[path.join(local, "bin"), path.join(world, "gone", "bin"), path.join(world, "tools")].map(by)),
      },
      serviceCli: by(cliOf(second)),
    });
    expect(twoNames(more)).toEqual([]);
    expect(more.copies.map((c) => [c.dir, c.uses])).toEqual([
      [slot(local), ["typed"]],
      [slot(second), ["service"]],
      [path.join(modulesOf(second), ".sessionpipe-Ab3dE9xZ"), []],
    ]);
    expect(more.dangling).toEqual([binOf(path.join(world, "gone"))]);
    expect(more.strangers).toEqual([{ file: path.join(world, "tools", "sessionpipe"), why: STRANGER }]);
    for (const { p } of named(more)) expect(within(world, p)).toBe(true);
  });

  /** Does this disk take two cases of a name for one file? */
  const ignoresCase = (): boolean => {
    mkdirSync(path.join(tmp, "CaseProbe"));
    return existsSync(path.join(tmp, "caseprobe"));
  };

  it("M1: on a disk that ignores case, PATH in another case of the folder is the same folder: one copy, never a second one to remove", (ctx) => {
    // The review's proof (poc-07): a copy in ~/.local, PATH saying ~/.Local/bin. An
    // extra: it runs where the temp folder's disk ignores case (a Mac as shipped), and
    // no line of the look is reached by it alone. It is the test that tells
    // `realpathSync.native` from `realpathSync`, which keeps the case it is given.
    if (!ignoresCase()) return ctx.skip();
    const local = path.join(home, ".local");
    globalCopy(local);
    const cased = path.join(home, ".Local");
    expect(statSync(cased).ino).toBe(statSync(local).ino);
    const inv = look(looking({ env: { PATH: path.join(cased, "bin") }, npmPrefix: path.join(home, ".LOCAL") }));
    expect(inv.copies).toEqual([row(local, { uses: ["typed"], onPath: true })]);
    expect(inv.onPath).toEqual([{ file: binOf(local), dir: slot(local) }]);
    expect(inv.typed).toBe(slot(local));
    expect(inv.home).toEqual(place(local, TYPED, { onPath: true }));
    expect(inv.prefixes).toEqual(usual());
    expect(twoNames(inv)).toEqual([]);
    // Everything the look is told, in another case.
    const shouted = look(
      looking({
        home: path.join(tmp, "HOME"),
        reach: path.join(path.dirname(tmp), path.basename(tmp).toUpperCase()),
        env: { PATH: path.join(tmp, "HOME", ".LOCAL", "BIN") },
        distDir: path.join(tmp, "Home", ".Local", "Lib", "Node_Modules", "SessionPipe", "dist"),
        serviceCli: cliOf(path.join(tmp, "hOME", ".lOCAL")),
      }),
    );
    expect(shouted.reach).toBe(tmp);
    expect(shouted.copies).toEqual([row(local, { uses: ["typed", "service", "this"], onPath: true })]);
    expect(shouted.home).toEqual(place(local, TYPED, { onPath: true }));
    expect(twoNames(shouted)).toEqual([]);
    expect(spelled(path.join(tmp, "HOME", ".LOCAL", "not", "There"))).toBe(path.join(local, "not", "There"));
  });

  it("M1: a folder that is real under two names (a volume mounted twice, a firmlink), where no link leads from one to the other: the copy is found once, by its device and inode, and is what is typed", () => {
    // What a link and another case can't show: here `realpath` answers each name as it is
    // given, so only the look's own memory of a folder (by device and inode) makes the copy
    // PATH leads to and the copy the home's prefix holds one copy. Without it: two.
    const { other, local, by, o } = twoSpellings();
    fake.twice = other;
    // Both names in reach, as on a computer where every folder is.
    const inv = look({ ...o, reach: tmp, env: { PATH: by(path.join(local, "bin")) } });
    expect(inv.copies).toHaveLength(1);
    expect(statSync(inv.copies[0]?.dir as string).ino).toBe(statSync(slot(local)).ino);
    expect(inv.copies[0]).toMatchObject({ slot: "global", uses: ["typed"], wrong: null });
    expect(inv.onPath).toHaveLength(1);
    expect(inv.typed).toBe(inv.copies[0]?.dir);
    expect(inv.dangling).toEqual([]);
    // Both names on PATH, either first: still one of each.
    for (const dirs of [
      [by(path.join(local, "bin")), path.join(local, "bin")],
      [path.join(local, "bin"), by(path.join(local, "bin"))],
    ]) {
      const twice = look({ ...o, reach: tmp, env: { PATH: PATH(...dirs) } });
      expect(twice.copies).toHaveLength(1);
      expect(twice.onPath).toHaveLength(1);
      expect(twice.copies[0]?.uses).toEqual(["typed"]);
    }
  });

  it("where a folder can't be looked at at all, a path is the name it was given, and nothing is said to be whole", () => {
    const local = path.join(home, ".local");
    globalCopy(local);
    fake.blind = () => true;
    const inv = look(looking({ env: { PATH: path.join(local, "bin") } }));
    expect(inv.reach).toBe(tmp);
    expect(inv.npx).toBe(path.join(home, ".npm", "_npx"));
    expect(inv.typed).toBe(slot(local));
    expect(inv.home?.prefix).toBe(local);
    expect(inv.copies).toEqual([row(local, { uses: ["typed"], wrong: MISSING })]);
  });
});

describe.skipIf(win32)("look: nothing that is found is started", () => {
  /** A computer with a copy of every kind on it, each with a cli.js that would leave a
   *  marker if it ran: the one typed; a second and a third; the service's; an npx cache
   *  entry; a leftover; and four folders the proof refuses. */
  const crowd = () => {
    const typed = path.join(tmp, "typed");
    const [second, third, served] = [path.join(home, ".local"), path.join(home, ".npm-global"), node.nvm()];
    globalCopy(typed);
    globalCopy(second, { version: "0.14.2" });
    globalCopy(third, { version: "0.14.0" });
    globalCopy(served, { version: "0.13.0" });
    const entry = npxEntry(path.join(home, ".npm"), "a1b2c3d4e5f6a7b8");
    const leftover = pkg(path.join(modulesOf(second), ".sessionpipe-Ab3dE9xZ"));
    // What the proof refuses: another package under the name, in a prefix not on PATH; an
    // npx cache folder of the name that holds a Makefile; a slot that is a link to a
    // folder of someone's; a checkout.
    const leftPad = globalCopy(node.asdf(), { name: "left-pad" });
    const makefile = npxEntry(path.join(home, ".npm"), "0000111122223333");
    writeFileSync(path.join(makefile.dir, "Makefile"), "all:\n\ttouch ran\n");
    const linked = pkg(path.join(tmp, "code", "linked"));
    mkdirSync(modulesOf(node.nodenv()), { recursive: true });
    symlinkSync(linked, slot(node.nodenv()));
    linkBin(node.nodenv());
    const checkout = pkg(path.join(tmp, "code", "sessionpipe"), { holds: ["src", ".git"] });
    mkdirSync(path.join(tmp, "dev"));
    symlinkSync(path.join(checkout, "dist", "cli.js"), path.join(tmp, "dev", "sessionpipe"));
    const refused = [leftPad, makefile.dir, linked, checkout];
    const accepted = [slot(typed), slot(second), slot(third), slot(served), entry.dir, leftover];
    const o = looking({ serviceCli: cliOf(served), hooksVersion: "0.14.2" });
    return { typed, second, third, served, entry, leftover, checkout, refused, accepted, o };
  };
  const cli = (dir: string): string => path.join(dir, "dist", "cli.js");

  it("M4: with no way to run anything handed in (doctor's look, and the look inside the proof), every copy is read and none is asked: a dry look", () => {
    const { typed, checkout, refused, accepted, o } = crowd();
    // The copy typed first on PATH; then the checkout first, so what is typed is refused.
    for (const dirs of [
      [path.join(typed, "bin"), path.join(tmp, "dev")],
      [path.join(tmp, "dev"), path.join(typed, "bin")],
    ]) {
      const inv = look({ ...o, env: { PATH: PATH(...dirs) } });
      // Every one of them was found: there was something to run.
      const found = inv.copies.map((c) => c.dir);
      for (const dir of [...accepted, ...refused]) expect(found).toContain(dir);
      for (const dir of accepted) expect(inv.copies.find((c) => c.dir === dir)?.slot).not.toBeNull();
      for (const dir of refused) expect(inv.copies.find((c) => c.dir === dir)?.slot).toBeNull();
      // Each has its cli.js, and each release is the one its package.json names.
      for (const c of inv.copies) expect(existsSync(cli(c.dir))).toBe(true);
      expect(inv.copies.find((c) => c.dir === slot(typed))).toEqual(
        row(typed, { uses: dirs[0] === path.join(typed, "bin") ? ["typed"] : [], onPath: true }),
      );
      expect(inv.typed).toBe(dirs[0] === path.join(typed, "bin") ? slot(typed) : checkout);
    }
    // And no marker is on the disk: the check after every test in this file.
    expect(ran(tmp)).toEqual([]);
  });

  it("M4: handed a way to run a copy, the look asks exactly one: the copy typing starts, by its own cli.js, and no second copy, service's copy, cache entry or leftover", () => {
    const { typed, o } = crowd();
    const { asked, runs } = runner({ [cliOf(typed)]: "0.15.0" });
    const inv = look({ ...o, env: { PATH: PATH(path.join(typed, "bin"), path.join(tmp, "dev")) }, runs });
    expect(asked).toEqual([cliOf(typed)]);
    // It answered its own release: nothing is wrong with it, nor with any other.
    expect(inv.copies.filter((c) => !c.aside).map((c) => c.wrong)).toEqual(
      inv.copies.filter((c) => !c.aside).map(() => null),
    );
  });

  it("M4: what it answers is said of that copy alone: nothing printed, or another release than its package.json names", () => {
    const { typed, second, o } = crowd();
    const env = { PATH: PATH(path.join(typed, "bin"), path.join(second, "bin")) };
    const silent = runner();
    const dead = look({ ...o, env, runs: silent.runs });
    expect(silent.asked).toEqual([cliOf(typed)]);
    expect(dead.copies[0]).toEqual(
      row(typed, { uses: ["typed"], onPath: true, wrong: "it doesn't run: `--version` printed nothing" }),
    );
    const other = runner({ [cliOf(typed)]: "0.14.2" });
    const mixed = look({ ...o, env, runs: other.runs });
    expect(other.asked).toEqual([cliOf(typed)]);
    expect(mixed.copies[0]).toEqual(
      row(typed, { uses: ["typed"], onPath: true, wrong: "it says it is 0.14.2, and its package.json says 0.15.0" }),
    );
    // No other copy is said to be wrong for it: each of them was only read.
    for (const inv of [dead, mixed]) expect(inv.copies.slice(1).filter((c) => !c.aside && c.wrong)).toEqual([]);
    // A copy with no cli.js is not asked: there is nothing to ask.
    rmSync(cliOf(typed));
    const none = runner();
    expect(look({ ...o, env, runs: none.runs }).copies[0]).toEqual(
      row(typed, { uses: ["typed"], onPath: true, wrong: MISSING }),
    );
    expect(none.asked).toEqual([]);
  });

  it("M4: never the copy this command runs from: it is running", () => {
    const { typed, o } = crowd();
    const { asked, runs } = runner();
    const inv = look({ ...o, env: { PATH: path.join(typed, "bin") }, distDir: path.join(slot(typed), "dist"), runs });
    expect(asked).toEqual([]);
    expect(inv.copies[0]).toEqual(row(typed, { uses: ["typed", "this"], onPath: true }));
    // Nor where it is what typing starts through a shim: the same copy, the same answer.
    mkdirSync(path.join(tmp, "shims"));
    writeFileSync(path.join(tmp, "shims", "sessionpipe"), "#!/bin/sh\n");
    const shimmed = look({
      ...o,
      env: { PATH: PATH(path.join(tmp, "shims"), path.join(typed, "bin")) },
      distDir: path.join(slot(node.nvm()), "dist"),
      started: binOf(node.nvm()),
      runs,
    });
    expect(shimmed.typed).toBe(slot(node.nvm()));
    expect(asked).toEqual([]);
  });

  it("M4: never a folder the proof refuses, though it is what typing starts: a checkout linked on PATH, a project's own dependency, another package under the name, a build in the slot", () => {
    const { checkout, o } = crowd();
    const { asked, runs } = runner();
    // A project's own dependency, typed through a link someone made to it.
    const dependency = pkg(path.join(home, "work", "app", "node_modules", "sessionpipe"));
    mkdirSync(path.join(home, "bin"));
    symlinkSync(cli(dependency), path.join(home, "bin", "sessionpipe"));
    // A build someone copied into a slot, with npm's own link.
    const built = path.join(tmp, "built");
    globalCopy(built, { holds: ["src"] });
    const starts: [string, string][] = [
      [path.join(tmp, "dev"), checkout],
      [path.join(home, "bin"), dependency],
      [path.join(node.asdf(), "bin"), slot(node.asdf())],
      [path.join(built, "bin"), slot(built)],
    ];
    for (const [dir, folder] of starts) {
      const inv = look({ ...o, env: { PATH: dir }, runs });
      expect(inv.typed).toBe(folder);
      const typed = inv.copies.find((c) => c.dir === folder);
      expect(typed?.uses).toEqual(["typed"]);
      expect(typed?.slot).toBeNull();
      expect(typed?.wrong).toBeNull();
    }
    expect(asked).toEqual([]);
  });

  it("M4: never where nothing is typed, or it can't be told what is: a shim first on PATH and this command from a checkout", () => {
    const { typed, checkout, o } = crowd();
    const { asked, runs } = runner();
    expect(look({ ...o, runs }).typed).toBeNull();
    mkdirSync(path.join(tmp, "shims"));
    writeFileSync(path.join(tmp, "shims", "sessionpipe"), "#!/bin/sh\n");
    const inv = look({
      ...o,
      env: { PATH: PATH(path.join(tmp, "shims"), path.join(typed, "bin")) },
      distDir: path.join(checkout, "dist"),
      runs,
    });
    expect(inv.unsure).toBe(path.join(tmp, "shims", "sessionpipe"));
    expect(asked).toEqual([]);
  });
});

describe.skipIf(win32)("look: a project's own dependency is not an install", () => {
  /** The review's M5 (poc-02): a project in a folder named `lib`, which depends on
   *  sessionpipe. By its shape alone its dependency sits where a prefix `~/work/app`
   *  would keep a global package. */
  const projectNamedLib = () => {
    const project = path.join(home, "work", "app", "lib");
    mkdirSync(project, { recursive: true });
    writeFileSync(path.join(project, "package.json"), '{"name":"app","dependencies":{"sessionpipe":"^0.15.0"}}');
    writeFileSync(path.join(project, "package-lock.json"), "{}");
    const dependency = pkg(path.join(project, "node_modules", "sessionpipe"));
    const bin = path.join(project, "node_modules", ".bin");
    mkdirSync(bin);
    symlinkSync(path.join("..", "sessionpipe", "dist", "cli.js"), path.join(bin, "sessionpipe"));
    return { app: path.join(home, "work", "app"), project, dependency, bin };
  };

  it("M5: a project folder named `lib`, this command started from its dependency (`npx sessionpipe reinstall` there): listed with why it is no install, not typed, and its folder is no prefix and no home", () => {
    const { app, dependency, bin } = projectNamedLib();
    const from = { distDir: path.join(dependency, "dist") };
    const theirs = stray(dependency, { uses: ["this"] });
    // As npx starts it, its own `.bin` first on PATH; and by its path, with no PATH at all.
    for (const env of [{ npm_command: "exec", PATH: bin }, {}]) {
      const inv = look(looking({ env, ...from }));
      expect(inv.copies).toEqual([theirs]);
      expect(inv.copies[0]?.where).toBe(path.join("~", "work", "app", "lib", "node_modules", "sessionpipe"));
      // The folder above the project's `lib` is no prefix: not of the look, not of the copy.
      expect(inv.copies[0]?.prefix).toBeNull();
      expect(inv.prefixes).not.toContain(app);
      expect(inv.prefixes).toEqual(usual());
      expect(inv.onPath).toEqual([]);
      expect(inv.typed).toBeNull();
      expect(inv.unsure).toBeNull();
      expect(inv.dangling).toEqual([]);
      // The one copy goes to a folder of the user's own, never into the project.
      expect(inv.home).toEqual(place(path.join(home, ".local"), OWN));
    }
    // Not started from it, it is not found at all.
    expect(look(looking({ env: { npm_command: "exec", PATH: bin } })).copies).toEqual([]);
    // Its `.bin` on a person's own PATH (no npm started this): it is what typing starts,
    // still no install, and there is no place for the one copy rather than the project.
    const own = look(looking({ env: { PATH: bin }, ...from }));
    expect(own.typed).toBe(dependency);
    expect(own.copies).toEqual([{ ...theirs, uses: ["typed", "this"] }]);
    expect(own.prefixes).toEqual(usual());
    expect(own.home).toBeNull();
  });

  it("M5: the same project where its parent folder IS looked in as a prefix (npm names it, the environment does): the package.json beside node_modules says whose it is", () => {
    const { app, dependency } = projectNamedLib();
    for (const told of [{ npmPrefix: app }, { env: { npm_config_prefix: app } }, { env: { N_PREFIX: app } }]) {
      const inv = look(looking(told));
      expect(inv.prefixes).toContain(app);
      expect(inv.copies).toEqual([stray(dependency, { not: A_PROJECT })]);
      // Its folder holds what is not ours: no place for the one copy.
      expect(inv.home).toEqual(place(path.join(home, ".local"), OWN));
    }
  });

  it("M5: a prefix whose lib/node_modules is a link into such a project: what is found there is the project's dependency, by its own folder, and no install", () => {
    const { app, dependency } = projectNamedLib();
    const prefix = path.join(home, ".npm-global");
    mkdirSync(path.join(prefix, "lib"), { recursive: true });
    symlinkSync(path.join(app, "lib", "node_modules"), modulesOf(prefix));
    const inv = look(looking());
    expect(statSync(slot(prefix)).ino).toBe(statSync(dependency).ino);
    expect(inv.copies).toEqual([stray(dependency)]);
    expect(twoNames(inv)).toEqual([]);
    // The prefix's slot holds what is not ours: no place for the one copy.
    expect(look(looking({ npmPrefix: prefix })).home).toEqual(place(path.join(home, ".local"), OWN));
  });
});

describe.skipIf(win32)("look: what these tests found in the look, as it answers now", () => {
  // Each of these was written down as a finding with the look's answer of the day; each
  // is now the test of what was done about it.

  it("M3: one whole copy with npm's own link, its bin folder not on PATH, and an empty ~/.local/bin that is: nothing is typed, and the copy says no shell looks in its folder", () => {
    // The place for a fresh copy is still the first one a shell looks in (~/.local). What
    // the inventory did not say is that `sessionpipe` is not found: nothing was typed, the
    // home was on PATH, the one copy was whole, and so the plan said "Nothing to repair"
    // and doctor "All good". The copy says it now (`onPath`), and `typing()` reads that.
    const real = node.nvm();
    const local = path.join(home, ".local");
    globalCopy(real);
    mkdirSync(path.join(local, "bin"), { recursive: true });
    const env = { PATH: path.join(local, "bin") };
    for (const o of [looking({ env }), looking({ env, distDir: path.join(slot(real), "dist") })]) {
      const inv = look(o);
      expect(inv.onPath).toEqual([]);
      expect(inv.typed).toBeNull();
      expect(inv.unsure).toBeNull();
      expect(inv.dangling).toEqual([]);
      expect(inv.copies.map((c) => [c.dir, c.wrong, c.uses.includes("typed")])).toEqual([[slot(real), null, false]]);
      expect(inv.copies[0]?.onPath).toBe(false);
      expect(inv.home).toEqual(place(local, OWN, { onPath: true }));
    }
    // With ~/.local/bin off PATH too, the home is the copy's own folder, off PATH as well.
    const off = look(looking({ distDir: path.join(slot(real), "dist") }));
    expect(off.home).toEqual(place(real, THIS));
    expect(off.copies[0]?.onPath).toBe(false);
    // Its own folder on PATH: typed, and a shell looks there.
    const on = look(looking({ env: { PATH: PATH(path.join(local, "bin"), path.join(real, "bin")) } }));
    expect(on.typed).toBe(slot(real));
    expect(on.copies[0]?.onPath).toBe(true);
  });

  it("a link of someone's own on PATH into a project's dependency that is gone names no place to install into: the home is only ever a prefix that was looked in", () => {
    // A dangling link's prefix was taken by its shape (three folders up from where the
    // link's text leads, whatever those folders are): the project's parent folder became
    // the home, in no slot the proof knows, so a run could not tidy beside the fresh copy
    // and the next look called that copy no install.
    const app = path.join(home, "work", "app");
    mkdirSync(path.join(app, "lib"), { recursive: true });
    writeFileSync(path.join(app, "lib", "package.json"), '{"name":"app"}');
    mkdirSync(path.join(home, "bin"));
    const link = path.join(home, "bin", "sessionpipe");
    symlinkSync(path.join(app, "lib", "node_modules", "sessionpipe", "dist", "cli.js"), link);
    const local = path.join(home, ".local");
    const inv = look(looking({ env: { PATH: path.join(home, "bin") } }));
    // The link is still found, and still leads nowhere.
    expect(inv.dangling).toEqual([link]);
    expect(inv.typed).toBeNull();
    expect(inv.prefixes).toEqual(usual());
    expect(inv.home).toEqual(place(local, OWN));
    expect(inv.prefixes).toContain(inv.home?.prefix);
    // Where the home is, a copy is in a slot the proof knows.
    const proving = { reach: inv.reach, prefixes: inv.prefixes, npx: inv.npx };
    expect(slotOf(slot(inv.home?.prefix as string), proving)).toBe("global");
    expect(slotOf(slot(app), proving)).toBeNull();
    // With a folder of the user's own on PATH, that one, on PATH.
    expect(look(looking({ env: { PATH: PATH(path.join(home, "bin"), path.join(local, "bin")) } })).home).toEqual(
      place(local, OWN, { onPath: true }),
    );
  });

  it("the same link into an npx cache entry that is gone: the npx cache is no place for a copy", () => {
    const cache = path.join(home, ".npm", "_npx");
    mkdirSync(path.join(home, "bin"));
    const link = path.join(home, "bin", "sessionpipe");
    symlinkSync(path.join(cache, "a1b2c3d4e5f6a7b8", "node_modules", "sessionpipe", "dist", "cli.js"), link);
    const inv = look(looking({ env: { PATH: path.join(home, "bin") } }));
    expect(inv.dangling).toEqual([link]);
    expect(inv.npx).toBe(cache);
    expect(inv.home).toEqual(place(path.join(home, ".local"), OWN));
    expect(inv.prefixes).not.toContain(cache);
  });

  it("a link that leads nowhere in a prefix that WAS looked in still names it as the place: npm's own link, left when the copy went", () => {
    const real = node.nvm();
    linkBin(real);
    mkdirSync(path.dirname(slot(real)), { recursive: true });
    const inv = look(looking({ env: { PATH: path.join(real, "bin") } }));
    expect(inv.dangling).toEqual([binOf(real)]);
    expect(inv.prefixes).toContain(real);
    expect(inv.home).toEqual(place(real, LINKED, { onPath: true }));
  });

  it("a `prefix` is a global install's alone: a project named lib, a build in a slot and a checkout have none, wherever they sit", () => {
    // A folder got a `prefix` by its shape (any `…/lib/node_modules/x`), and plan.ts
    // printed `npm install -g --prefix <that> sessionpipe@<v>` where such a folder was
    // what typing starts: for a project named `lib`, into the project's own node_modules,
    // over its dependency (the end-to-end run pasted it). No folder the proof refuses
    // names a prefix any more, so nothing can be told to install there.
    const app = path.join(home, "work", "app");
    mkdirSync(path.join(app, "lib"), { recursive: true });
    writeFileSync(path.join(app, "lib", "package.json"), '{"name":"app"}');
    const dependency = pkg(path.join(app, "lib", "node_modules", "sessionpipe"));
    mkdirSync(path.join(home, "bin"));
    symlinkSync(path.join(dependency, "dist", "cli.js"), path.join(home, "bin", "sessionpipe"));
    const inv = look(looking({ env: { PATH: path.join(home, "bin") } }));
    expect(inv.typed).toBe(dependency);
    expect(inv.copies).toEqual([stray(dependency, { uses: ["typed"] })]);
    expect(inv.copies[0]?.prefix).toBeNull();
    expect(inv.home).toBeNull();
    // A build in a slot, typed through npm's own link: none either.
    const built = path.join(tmp, "built");
    globalCopy(built, { holds: ["src"] });
    expect(look(looking({ env: { PATH: path.join(built, "bin") } })).copies.map((c) => [c.prefix, c.slot])).toEqual([
      [null, null],
    ]);
    // A checkout that sits nowhere of that shape has none.
    const checkout = pkg(path.join(home, "code", "sessionpipe"), { holds: ["src"] });
    expect(look(looking({ distDir: path.join(checkout, "dist") })).copies.map((c) => c.prefix)).toEqual([null]);
    // A copy in a global slot names its prefix; so does a leftover the proof accepts there.
    const p = path.join(home, ".local");
    globalCopy(p);
    pkg(path.join(modulesOf(p), ".sessionpipe-Ab3dE9xZ"));
    const found = look(looking({ env: { PATH: path.join(p, "bin") } })).copies;
    expect(found.filter((c) => c.slot === "global").map((c) => c.prefix)).toEqual([p, p]);
    for (const c of found) expect(c.prefix !== null, c.dir).toBe(c.slot === "global");
  });
  it("M1: a folder that is real under two names (a volume mounted twice, a firmlink): the copy inside it has one name, the one the home folder gives, and its folder is the home's own slot", () => {
    // A folder was given the first name it was seen under, each folder by itself: the
    // copy's folder was first seen through PATH, the prefix it is in through the home
    // folder, so the inventory had two names for one prefix. plan.ts compares
    // `slotIn(home.prefix)` with a copy's `dir` as strings: to it the home's slot was
    // empty and the typed copy another one, to remove (run.ts, handed `keep`, refused
    // that: "left", exit 1). A folder is now spelled by its own name under the ONE
    // spelling of the folder it is really in, and the home folder is spelled first.
    const world = path.join(tmp, "world");
    const other = path.join(tmp, "other");
    const inHome = path.join(world, "home");
    const local = path.join(inHome, ".local");
    mkdirSync(inHome, { recursive: true });
    symlinkSync(world, other);
    globalCopy(local);
    const by = (p: string): string => path.join(other, path.relative(world, p));
    // No `realpath` leads from one name to the other: both are real.
    fake.twice = other;
    const o = looking({ home: inHome, execPath: path.join(world, "node", "bin", "node") });
    for (const env of [
      { PATH: by(path.join(local, "bin")) },
      { PATH: PATH(by(path.join(local, "bin")), path.join(local, "bin")) },
      { PATH: PATH(path.join(local, "bin"), by(path.join(local, "bin"))) },
    ]) {
      const inv = look({ ...o, env });
      expect(inv.copies).toEqual([row(local, { uses: ["typed"], onPath: true })]);
      expect(inv.onPath).toEqual([{ file: binOf(local), dir: slot(local) }]);
      expect(inv.typed).toBe(slot(local));
      expect(inv.home).toEqual(place(local, TYPED, { onPath: true }));
      expect(inv.prefixes).toContain(local);
      expect(inv.prefixes).not.toContain(by(local));
      expect(twoNames(inv)).toEqual([]);
      // What the plan goes by: the home's slot, by its name, IS the copy's folder.
      expect(slot(inv.home?.prefix as string)).toBe(inv.copies[0]?.dir);
    }
    // Everything else the look is told by the other name comes out by the home's too.
    const second = path.join(inHome, ".npm-global");
    globalCopy(second, { version: "0.14.2" });
    const told = look({
      ...o,
      env: { PATH: by(path.join(local, "bin")) },
      npmPrefix: by(second),
      distDir: by(path.join(slot(second), "dist")),
      serviceCli: by(cliOf(second)),
    });
    expect(told.copies).toEqual([
      row(local, { uses: ["typed"], onPath: true }),
      row(second, { version: "0.14.2", uses: ["service", "this"] }),
    ]);
    expect(twoNames(told)).toEqual([]);
    // The home told by the OTHER name: then that is how a person reads the rest, and every
    // path is under it.
    const asked = look({ ...o, home: by(inHome), env: { PATH: path.join(local, "bin") } });
    expect(asked.copies.map((c) => c.dir)).toEqual([by(slot(local)), by(slot(second))]);
    expect(asked.home?.prefix).toBe(by(local));
    expect(twoNames(asked)).toEqual([]);
  });

  it("M1: the same on a Mac, where the data volume is one such second name for every folder (/System/Volumes/Data): an extra, run where that name is there", (ctx) => {
    // The review named it: `/Users/x` and `/System/Volumes/Data/Users/x` are one inode,
    // and neither `realpath` leads from one to the other. Nothing is faked here.
    const data = path.join("/System/Volumes/Data", tmp);
    const twoReal = (): boolean => {
      try {
        return statSync(data).ino === statSync(tmp).ino && realpathSync.native(data) === data;
      } catch {
        return false;
      }
    };
    if (!twoReal()) return ctx.skip();
    const local = path.join(home, ".local");
    globalCopy(local);
    const by = (p: string): string => path.join(data, path.relative(tmp, p));
    // Every folder in reach, as on a real computer: the other name is outside the temp
    // folder by its spelling. Only what this test made is looked at in the answer.
    const inv = look(looking({ reach: true, env: { PATH: by(path.join(local, "bin")) } }));
    const mine = inv.copies.filter((c) => c.dir.includes(path.basename(tmp)));
    expect(mine).toEqual([row(local, { uses: ["typed"], onPath: true })]);
    expect(inv.typed).toBe(slot(local));
    expect(inv.home).toEqual(place(local, TYPED, { onPath: true }));
    expect(slot(inv.home?.prefix as string)).toBe(mine[0]?.dir);
    expect(twoNames(inv).filter((names) => names.some((n) => n.includes(path.basename(tmp))))).toEqual([]);
  });

  it("M4: Volta's copy is asked nothing, though it is what typing starts and the proof accepts its folder: it is Volta's to keep", () => {
    // The look asked the copy wherever the proof's answer was a slot; that Volta keeps it
    // was said of the row afterwards. Typed through npm's own link in Volta's package
    // folder, which is on no PATH Volta sets up: a person would have had to put it there.
    const volta = VOLTA();
    globalCopy(volta);
    const { asked, runs } = runner({ [cliOf(volta)]: "0.14.0" });
    const inv = look(looking({ env: { PATH: path.join(volta, "bin") }, runs }));
    expect(inv.copies.map((c) => [c.slot, c.not, c.uses, c.wrong])).toEqual([
      [null, "Volta keeps it", ["typed"], null],
    ]);
    expect(asked).toEqual([]);
    // Where VOLTA_HOME says Volta is, the same.
    const told = path.join(tmp, "volta", "tools", "image", "packages", "sessionpipe");
    globalCopy(told);
    const there = runner();
    look(looking({ env: { VOLTA_HOME: path.join(tmp, "volta"), PATH: path.join(told, "bin") }, runs: there.runs }));
    expect(there.asked).toEqual([]);
  });
});

describe.skipIf(win32)("reported, not decided here: what the look answers today", () => {
  it("a prefix npm itself names, whose `lib` is a project (a package.json beside its node_modules), can be the home: a copy put there would be one the proof refuses", () => {
    // `homeAt` asks that the prefix was looked in and that what is in its slot, if
    // anything, is ours. It does not ask whether a copy put there COULD be ours: with a
    // package.json beside `lib/node_modules` the proof refuses whatever is in that slot
    // ("a project's own"), so a fresh copy installed there is "no installed copy" to the
    // next look. Narrow: npm's own prefix (or `npm_config_prefix`, `N_PREFIX`) has to name
    // the folder above a project called `lib`.
    const app = path.join(home, "work", "app");
    mkdirSync(path.join(app, "lib", "node_modules"), { recursive: true });
    writeFileSync(path.join(app, "lib", "package.json"), '{"name":"app"}');
    const inv = look(looking({ npmPrefix: app }));
    expect(inv.prefixes).toContain(app);
    expect(inv.home).toEqual(place(app, NPM));
    // What the proof says of a published copy in that very slot.
    const there = pkg(slot(app));
    const proving = { reach: inv.reach, prefixes: inv.prefixes, npx: inv.npx };
    expect(prove(there, proving)).toEqual({ is: "not", why: A_PROJECT });
    // With the copy there the look does refuse the place: only the empty slot slips through.
    expect(look(looking({ npmPrefix: app })).home).toEqual(place(path.join(home, ".local"), OWN));
  });

  it("L3: a release written with blanks or line breaks around it, or a `v` before it, is taken as it is written: `parseVersion` reads it trimmed, and the look keeps the text", () => {
    // Nothing can start a line of its own this way (only blanks pass), and the page cleans
    // every word it sets. But such a copy's release is never equal to the newest one's
    // text, so it is always "not the newest".
    const at = (n: string) => path.join(tmp, n);
    const written = { padded: " 0.15.0\n", lined: "\n0.15.0\r\n", prefixed: "v0.15.0" };
    for (const [n, version] of Object.entries(written))
      globalCopy(at(n), { raw: JSON.stringify({ name: "sessionpipe", version }) });
    const inv = look(looking({ env: { PATH: PATH(...Object.keys(written).map((n) => path.join(at(n), "bin"))) } }));
    expect(inv.copies.map((c) => [c.version, c.slot])).toEqual(Object.values(written).map((v) => [v, "global"]));
  });
});
