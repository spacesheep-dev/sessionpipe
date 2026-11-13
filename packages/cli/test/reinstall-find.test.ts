// SPDX-License-Identifier: Apache-2.0
// The look `sessionpipe reinstall` takes at a computer (reinstall/find.ts), on computers
// made of temp folders: a home, a PATH, a Node of every kind, npm's cache. Nearly every
// look is narrowed to the test's own folder (`reach`), so nothing this machine really
// has can be in an answer; the two tests that take `reach: true` assert only on what
// lies in that folder. find.ts only reads, and nothing is removed here but the temp folder.
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Copy, canWrite, type Inventory, type Looking, look, prefixesOf, spelled } from "../src/reinstall/find.js";
import { within } from "../src/reinstall/ours.js";

/** What this file makes node:fs do: answer a look at a folder with an error of its
 *  choosing (`access`, by the code), or not know where a path really is (`lost`). */
const fake = vi.hoisted(() => ({
  access: null as ((p: string) => string | null) | null,
  lost: null as ((p: string) => boolean) | null,
}));
vi.mock("node:fs", async (original) => {
  const m = await original<typeof import("node:fs")>();
  const refused = (code: string, p: string) => Object.assign(new Error(`${code}: ${p}`), { code });
  const accessSync = ((p: unknown, ...rest: unknown[]) => {
    const code = typeof p === "string" ? fake.access?.(p) : null;
    if (code) throw refused(code, p as string);
    return (m.accessSync as (...a: unknown[]) => void)(p, ...rest);
  }) as typeof m.accessSync;
  const realpathSync = Object.assign(
    (p: unknown, ...rest: unknown[]) => {
      if (typeof p === "string" && fake.lost?.(p)) throw refused("ENOENT", p);
      return (m.realpathSync as (...a: unknown[]) => unknown)(p, ...rest);
    },
    { native: m.realpathSync.native },
  ) as typeof m.realpathSync;
  return { ...m, accessSync, realpathSync };
});

const posix = process.platform !== "win32";
/** chmod means something: not on Windows, and not for root, who may write anywhere. */
const refusable = posix && process.getuid?.() !== 0;

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
});
afterEach(() => {
  fake.access = null;
  fake.lost = null;
  for (const d of locked) chmodSync(d, 0o755);
  rmSync(tmp, { recursive: true, force: true });
});
const lock = (dir: string): void => {
  chmodSync(dir, 0o555);
  locked.push(dir);
};

const tilde = (p: string): string => (within(home, p) ? path.join("~", path.relative(home, p)) : p);
const PATH = (...dirs: string[]): string => dirs.join(path.delimiter);

/** A look at the test's computer: no PATH, no Node but one that has no global folder yet,
 *  this command run from outside it, and only what is under the temp folder its own.
 *  `--version` is stood in for by what a copy's cli.js holds: its text is what it prints. */
const looking = (o: Partial<Looking> = {}): Looking => ({
  platform: "linux",
  env: {},
  home,
  reach: tmp,
  execPath: path.join(tmp, "node", "bin", "node"),
  distDir: path.join(os.tmpdir(), "sp-find-not-in-reach", "dist"),
  npmPrefix: null,
  serviceCli: null,
  hooksVersion: null,
  version: (cli) => (within(tmp, cli) ? readFileSync(cli, "utf8").trim() || null : null),
  tilde,
  ...o,
});

interface Pkg {
  /** What package.json says; null: it has no version. */
  version?: string | null;
  /** What cli.js prints for `--version`; "": nothing; null: there is no dist/cli.js. */
  says?: string | null;
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
  const says = o.says === undefined ? version : o.says;
  if (says !== null) {
    mkdirSync(path.join(dir, "dist"), { recursive: true });
    writeFileSync(path.join(dir, "dist", "cli.js"), says);
  }
  for (const e of o.holds ?? []) mkdirSync(path.join(dir, e), { recursive: true });
  return dir;
}

// --- a Mac or Linux prefix: <prefix>/lib/node_modules/sessionpipe and <prefix>/bin/sessionpipe
const slot = (prefix: string): string => path.join(prefix, "lib", "node_modules", "sessionpipe");
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
/** What the look says of a clean global copy in a prefix, and what a test says differs. */
const row = (prefix: string, o: Partial<Copy> = {}): Copy => ({
  dir: slot(prefix),
  where: tilde(prefix),
  prefix,
  slot: "global",
  not: null,
  aside: false,
  version: "0.15.0",
  runs: true,
  wrong: null,
  bins: [binOf(prefix)],
  uses: [],
  writable: true,
  keeper: null,
  ...o,
});

// --- a Windows prefix: <prefix>\node_modules\sessionpipe and the shims in <prefix> itself
const winSlot = (prefix: string): string => path.join(prefix, "node_modules", "sessionpipe");
const SHIMS = {
  sessionpipe: '#!/bin/sh\nexec node  "$basedir/node_modules/sessionpipe/dist/cli.js" "$@"\n',
  "sessionpipe.cmd": '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\sessionpipe\\dist\\cli.js" %*\r\n',
  "sessionpipe.ps1": '& "node$exe"  "$basedir/node_modules/sessionpipe/dist/cli.js" $args\n',
} as const;
type Shim = keyof typeof SHIMS;
/** The shims npm writes on Windows: plain files that name the package folder. */
function shims(prefix: string, names: readonly Shim[] = ["sessionpipe", "sessionpipe.cmd", "sessionpipe.ps1"]): void {
  mkdirSync(prefix, { recursive: true });
  for (const n of names) writeFileSync(path.join(prefix, n), SHIMS[n]);
}

const TYPED = "where the one you type is";
const THIS = "where this command runs from";
const SERVICE = "where the one the background service runs is";
const ANOTHER = "where another copy of it already is";
const NPM = "where npm puts what is installed for every folder";
const OWN = "a folder of your own";
/** A folder the look offers for the fresh copy. `pathAt`: which folder of PATH its
 *  command goes in, counted from the first; null: none. `bin`: that folder, where it is
 *  not `<prefix>/bin` by that name. `blocked`: a file at the command's own path there
 *  that is not npm's link to that prefix's copy; null: none. */
const offered = (
  prefix: string,
  why: string,
  pathAt: number | null = null,
  bin = path.join(prefix, "bin"),
  blocked: string | null = null,
): Inventory["homes"][number] => ({ prefix, shown: tilde(prefix), why, bin, pathAt, blocked });
const MISSING = "its dist/cli.js is missing (an install that was cut off?)";
const NO_SLOT = "it is not a global install or an npx cache entry (a project's own dependency?)";
const STRANGER = "a file of that name that npm didn't put there";
/** What is wrong with a whole copy in a global folder that no link of npm's leads to. */
const NO_LINK = "npm's link to it is gone";
const STRANGE_LINK = "a link that leads to no install of sessionpipe";

describe("spelled: one spelling for one place", () => {
  it.runIf(posix)("goes through a linked folder; what is not there keeps its tail on the real folder above", () => {
    mkdirSync(path.join(tmp, "real", "a"), { recursive: true });
    symlinkSync(path.join(tmp, "real"), path.join(tmp, "alias"));
    expect(spelled(path.join(tmp, "alias"))).toBe(path.join(tmp, "real"));
    expect(spelled(path.join(tmp, "alias", "a"))).toBe(path.join(tmp, "real", "a"));
    expect(spelled(path.join(tmp, "alias", "a", "not", "there"))).toBe(path.join(tmp, "real", "a", "not", "there"));
    expect(spelled(path.join(tmp, "alias", "nor", "this"))).toBe(path.join(tmp, "real", "nor", "this"));
  });

  it("a path that is not absolute is read from where the process is; the root is itself", () => {
    expect(spelled(".")).toBe(realpathSync(process.cwd()));
    expect(spelled(path.join(tmp, "a", "..", "b"))).toBe(path.join(tmp, "b"));
    const root = path.parse(tmp).root;
    expect(spelled(root)).toBe(root);
  });

  it("where no folder above can be found either, it is the path as it was given", () => {
    fake.lost = () => true;
    expect(spelled(path.join(tmp, "a", "b"))).toBe(path.join(tmp, "a", "b"));
  });
});

describe("canWrite: may this user write a folder, or make it", () => {
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

describe("prefixesOf: every folder that may be some Node's global one", () => {
  /** One version of Node under each manager that keeps them in the home folder. */
  const managed = () => {
    const at = {
      nvm: path.join(home, ".nvm", "versions", "node", "v22.11.0"),
      fnm: path.join(home, ".local", "share", "fnm", "node-versions", "v22.11.0"),
      asdf: path.join(home, ".asdf", "installs", "nodejs", "22.11.0"),
      mise: path.join(home, ".local", "share", "mise", "installs", "node", "22.11.0"),
      nodenv: path.join(home, ".nodenv", "versions", "22.11.0"),
      installer: path.join(home, ".local", "share", "node-v22.11.0-darwin-arm64"),
    };
    for (const d of Object.values(at)) mkdirSync(d, { recursive: true });
    // A file among the versions is no Node.
    writeFileSync(path.join(home, ".nvm", "versions", "node", "default"), "v22.11.0\n");
    return at;
  };
  const volta = () => path.join(home, ".volta", "tools", "image", "packages", "sessionpipe");

  it("on a Mac or Linux: this Node's, npm's answer, the environment's, the home's own, each manager's, Volta's", () => {
    const at = managed();
    const o = looking({
      npmPrefix: path.join(tmp, "npm"),
      env: { npm_config_prefix: path.join(tmp, "configured"), N_PREFIX: path.join(tmp, "n") },
    });
    const mine = [
      path.join(tmp, "node"),
      path.join(tmp, "npm"),
      path.join(tmp, "configured"),
      path.join(tmp, "n"),
      path.join(home, ".local"),
      path.join(home, ".npm-global"),
      at.nvm,
      path.join(at.fnm, "installation"),
      at.asdf,
      at.mise,
      at.nodenv,
      at.installer,
      volta(),
    ];
    expect(prefixesOf(o)).toEqual(mine);
    // With every folder this computer's: the places a system Node and Homebrew use too.
    const all = prefixesOf({ ...o, reach: true });
    expect(all.filter((p) => within(tmp, p))).toEqual(mine);
    for (const fixed of ["/usr/local", "/usr", "/opt/homebrew", "/home/linuxbrew/.linuxbrew"])
      expect(all).toContain(spelled(fixed));
    // With none its own: none.
    expect(prefixesOf({ ...o, reach: null })).toEqual([]);
  });

  it("a manager that was told where to keep its files is looked in there; a folder named twice is one", () => {
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
    expect(
      prefixesOf(
        looking({
          // npm's own answer and the environment's are this Node's folder again.
          npmPrefix: path.join(tmp, "node"),
          env: { ...told, npm_config_prefix: path.join(tmp, "node", "lib", "..") },
        }),
      ),
    ).toEqual([
      path.join(tmp, "node"),
      path.join(home, ".local"),
      path.join(home, ".npm-global"),
      path.join(told.NVM_DIR, "versions", "node", "v20.18.0"),
      path.join(told.FNM_DIR, "node-versions", "v20.18.0", "installation"),
      path.join(told.ASDF_DATA_DIR, "installs", "nodejs", "20.18.0"),
      path.join(home, ".local", "share", "mise", "installs", "node", "22.11.0"),
      path.join(home, ".nodenv", "versions", "22.11.0"),
      path.join(home, ".local", "share", "node-v22.11.0-darwin-arm64"),
      path.join(told.VOLTA_HOME, "tools", "image", "packages", "sessionpipe"),
    ]);
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
    expect(prefixesOf(o)).toEqual(inside);
    if (posix) {
      symlinkSync(world, path.join(tmp, "alias"));
      expect(prefixesOf({ ...o, reach: path.join(tmp, "alias") })).toEqual(inside);
    }
  });

  it("on Windows: %AppData%\\npm, the Node's own folder, npm's answers, Program Files, each nvm-windows version", () => {
    const env = {
      APPDATA: path.join(tmp, "AppData", "Roaming"),
      ProgramFiles: path.join(tmp, "Program Files"),
      NVM_HOME: path.join(tmp, "nvm"),
      npm_config_prefix: path.join(tmp, "configured"),
    };
    mkdirSync(path.join(env.NVM_HOME, "v22.11.0"), { recursive: true });
    const o = looking({
      platform: "win32",
      env,
      execPath: path.join(tmp, "node", "node.exe"),
      npmPrefix: path.join(tmp, "npm"),
    });
    expect(prefixesOf(o)).toEqual([
      path.join(env.APPDATA, "npm"),
      path.join(tmp, "node"),
      path.join(tmp, "npm"),
      path.join(tmp, "configured"),
      path.join(env.ProgramFiles, "nodejs"),
      path.join(env.NVM_HOME, "v22.11.0"),
    ]);
    // With none of those said: the folder the running Node is in.
    expect(prefixesOf({ ...o, env: {}, npmPrefix: null })).toEqual([path.join(tmp, "node")]);
  });
});

describe.runIf(posix)("look: where copies are found", () => {
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
      platform: "linux",
      reach: tmp,
      copies: [row(a, { uses: ["typed"] }), row(b, { version: "0.14.2" }), row(c, { version: "0.13.0" })],
      dangling: [],
      strangers: [],
      // Each by the folder of PATH it is in: one named twice is one, and a folder with
      // no sessionpipe in it, there or not, is a place in the order all the same.
      onPath: [
        { file: binOf(a), dir: slot(a), at: 0 },
        { file: binOf(b), dir: slot(b), at: 1 },
        { file: binOf(c), dir: slot(c), at: 4 },
      ],
      homes: [
        offered(a, TYPED, 0),
        offered(b, ANOTHER, 1),
        offered(c, ANOTHER, 4),
        offered(path.join(home, ".local"), OWN),
      ],
      prefixes: [
        path.join(tmp, "node"),
        path.join(home, ".local"),
        path.join(home, ".npm-global"),
        path.join(home, ".volta", "tools", "image", "packages", "sessionpipe"),
      ],
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
      path.join(home, ".nvm", "versions", "node", "v22.11.0"),
      path.join(home, ".local", "share", "fnm", "node-versions", "v22.11.0", "installation"),
      path.join(home, ".asdf", "installs", "nodejs", "22.11.0"),
      path.join(home, ".local", "share", "mise", "installs", "node", "22.11.0"),
      path.join(home, ".nodenv", "versions", "22.11.0"),
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
    expect(inv.onPath).toEqual([]);
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
    globalCopy(path.join(home, ".nvm", "versions", "node", "v22.11.0"));
    globalCopy(path.join(home, ".local", "share", "fnm", "node-versions", "v22.11.0", "installation"));
    globalCopy(path.join(home, ".asdf", "installs", "nodejs", "22.11.0"));
    expect(look(looking({ env: told })).copies).toEqual(there.map((p) => row(p)));
  });

  it("the npx cache: npm's own place for it, or the one npm_config_cache names", () => {
    const entry = path.join(home, ".npm", "_npx", "a1b2c3d4e5f6a7b8");
    const dir = pkg(path.join(entry, "node_modules", "sessionpipe"), { version: "0.14.0" });
    mkdirSync(path.join(entry, "node_modules", ".bin"));
    symlinkSync(
      path.join("..", "sessionpipe", "dist", "cli.js"),
      path.join(entry, "node_modules", ".bin", "sessionpipe"),
    );
    // An entry npx made for something else.
    mkdirSync(path.join(home, ".npm", "_npx", "0000111122223333", "node_modules", "cowsay"), { recursive: true });
    const cached: Copy = {
      dir,
      // An entry is said by its own folder, which says what it is.
      where: path.join("~", ".npm", "_npx", "a1b2c3d4e5f6a7b8"),
      prefix: null,
      slot: "npx",
      not: null,
      aside: false,
      version: "0.14.0",
      runs: true,
      wrong: null,
      bins: [path.join(entry, "node_modules", ".bin", "sessionpipe")],
      uses: [],
      writable: true,
      keeper: null,
    };
    const inv = look(looking());
    expect(inv.copies).toEqual([cached]);
    // A cache entry is never where the fresh copy goes.
    expect(inv.homes).toEqual([offered(path.join(home, ".local"), OWN)]);

    const other = path.join(tmp, "cache", "_npx", "ffffeeeeddddcccc");
    const there = pkg(path.join(other, "node_modules", "sessionpipe"));
    expect(look(looking({ env: { npm_config_cache: path.join(tmp, "cache") } })).copies).toEqual([
      { ...cached, dir: there, where: other, version: "0.15.0", bins: [] },
    ]);
  });

  it("the copy this command runs from, and the one the service file names", () => {
    const mine = path.join(tmp, "mine");
    const served = path.join(tmp, "served");
    globalCopy(mine);
    globalCopy(served, { version: "0.14.2" });
    const o = looking({ distDir: path.join(slot(mine), "dist"), serviceCli: cliOf(served) });
    expect(look(o).copies).toEqual([
      row(mine, { uses: ["this"] }),
      row(served, { version: "0.14.2", uses: ["service"] }),
    ]);
    // A service file may run anything: only a `…/dist/cli.js` is a copy of sessionpipe.
    for (const program of [
      path.join(slot(served), "dist", "worker.js"),
      path.join(slot(served), "bin", "cli.js"),
      path.join(served, "bin", "node"),
    ])
      expect(look({ ...o, serviceCli: program }).copies).toEqual([row(mine, { uses: ["this"] })]);
    // One that names a copy that is gone adds no row for it.
    expect(look({ ...o, serviceCli: cliOf(path.join(tmp, "gone")) }).copies).toEqual([row(mine, { uses: ["this"] })]);
  });

  it("what npm left behind from an install that was cut off, beside the copy or alone", () => {
    const p = path.join(home, ".local");
    globalCopy(p);
    const modules = path.dirname(slot(p));
    pkg(path.join(modules, ".sessionpipe-Ab3dE9xZ"), { version: "0.14.0" });
    mkdirSync(path.join(modules, ".sessionpipe-0a1b2c3d"));
    // Not npm's name for such a folder, and other packages: not looked at.
    mkdirSync(path.join(modules, ".sessionpipe-short"));
    mkdirSync(path.join(modules, ".sessionpipe-Ab3dE9xZ-more"));
    mkdirSync(path.join(modules, "npm"));
    const left = "left behind by an install that was cut off";
    const inv = look(looking());
    expect([...inv.copies].sort((a, b) => a.dir.localeCompare(b.dir))).toEqual(
      [
        row(p),
        row(p, {
          dir: path.join(modules, ".sessionpipe-Ab3dE9xZ"),
          aside: true,
          version: "0.14.0",
          wrong: left,
          bins: [],
        }),
        row(p, {
          dir: path.join(modules, ".sessionpipe-0a1b2c3d"),
          aside: true,
          version: null,
          runs: false,
          wrong: left,
          bins: [],
        }),
      ].sort((a, b) => a.dir.localeCompare(b.dir)),
    );
    // The copy itself is listed first, and a leftover is no reason to put the fresh one there.
    expect(inv.copies[0]).toEqual(row(p));
    expect(inv.homes).toEqual([offered(p, ANOTHER)]);
  });
});

describe.runIf(posix)("look: what uses each copy", () => {
  it("typed is the first on PATH; one copy may be typed, the service's, this command's and the hooks' at once", () => {
    const [a, b] = [path.join(tmp, "a"), path.join(tmp, "b")];
    globalCopy(a);
    globalCopy(b);
    const env = { PATH: PATH(path.join(b, "bin"), path.join(a, "bin")) };
    expect(look(looking({ env })).copies).toEqual([row(b, { uses: ["typed"] }), row(a)]);
    expect(
      look(looking({ env, distDir: path.join(slot(b), "dist"), serviceCli: cliOf(b), hooksVersion: "0.15.0" })).copies,
    ).toEqual([row(b, { uses: ["typed", "service", "this", "hooks"] }), row(a)]);
  });

  it("the hooks: the copy of the release that wrote them that is in use, else the first of it, else none", () => {
    const typed = path.join(tmp, "typed");
    const first = path.join(home, ".local");
    const second = path.join(home, ".npm-global");
    const served = path.join(tmp, "served");
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
    // With no service file its copy is not found at all, and none of that release is in use.
    expect(look(o).copies).toEqual([
      row(typed, { uses: ["typed"] }),
      row(first, { ...old, uses: ["hooks"] }),
      row(second, old),
    ]);
    // A release no copy here is, and no hooks at all.
    for (const hooksVersion of ["0.9.0", null])
      expect(look({ ...o, hooksVersion }).copies.flatMap((c) => c.uses)).toEqual(["typed"]);
  });

  it("with a file that is no install first on PATH, no copy is the one typed", () => {
    const a = path.join(tmp, "a");
    globalCopy(a);
    mkdirSync(path.join(tmp, "tools"));
    writeFileSync(path.join(tmp, "tools", "sessionpipe"), "#!/bin/sh\necho mine\n");
    const inv = look(looking({ env: { PATH: PATH(path.join(tmp, "tools"), path.join(a, "bin")) } }));
    expect(inv.copies).toEqual([row(a)]);
    expect(inv.onPath).toEqual([
      { file: path.join(tmp, "tools", "sessionpipe"), dir: null, at: 0 },
      { file: binOf(a), dir: slot(a), at: 1 },
    ]);
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
      { file: binOf(gone), dir: slot(gone), at: 0 },
      { file: binOf(a), dir: slot(a), at: 1 },
      { file: binOf(b), dir: slot(b), at: 2 },
    ]);
    expect(inv.dangling).toEqual([binOf(gone)]);
    // So the fresh copy goes where the one that really starts is.
    expect(inv.homes).toEqual([offered(a, TYPED, 1), offered(b, ANOTHER, 2), offered(path.join(home, ".local"), OWN)]);
  });

  it("behind such a link a file that is no install is what starts, and no copy after it is the one typed", () => {
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
    // Nobody's typed copy has a prefix to go by: the copy that is there is "another".
    expect(inv.homes[0]).toEqual(offered(a, ANOTHER, 2));
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
      { file: binOf(gone), dir: slot(gone), at: 0 },
      { file: binOf(also), dir: slot(also), at: 1 },
    ]);
    expect(inv.dangling).toEqual([binOf(gone), binOf(also)]);
    expect(inv.homes).toEqual([offered(local, ANOTHER)]);
  });
});

describe.runIf(posix)("look: started by npx", () => {
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
    where: tilde(e.entry),
    prefix: null,
    slot: "npx",
    not: null,
    aside: false,
    version: "0.15.0",
    runs: true,
    wrong: null,
    bins: [path.join(e.bin, "sessionpipe")],
    uses: [],
    writable: true,
    keeper: null,
    ...o,
  });

  it("npx's own entry, first on PATH for that one run, is nobody's to type: the copy behind it is", () => {
    const npx = npxEntry(path.join(home, ".npm"), "a1b2c3d4e5f6a7b8");
    const a = path.join(tmp, "a");
    globalCopy(a, { version: "0.14.2" });
    const o = looking({ env: { PATH: PATH(npx.bin, path.join(a, "bin")) }, distDir: path.join(npx.dir, "dist") });
    const inv = look(o);
    // What a shell opened afterwards finds: the installed copy, and only that.
    // It is in PATH's second folder: npx's own is still the first, and is passed over.
    expect(inv.onPath).toEqual([{ file: binOf(a), dir: slot(a), at: 1 }]);
    expect(inv.dangling).toEqual([]);
    expect(inv.strangers).toEqual([]);
    // The entry is still a copy, found in the cache and as the one this command runs from.
    expect(inv.copies).toEqual([row(a, { version: "0.14.2", uses: ["typed"] }), cachedRow(npx, { uses: ["this"] })]);
    expect(npx.entry).toBe(path.join(home, ".npm", "_npx", "a1b2c3d4e5f6a7b8"));
    expect(inv.copies[1]?.where).toBe(path.join("~", ".npm", "_npx", "a1b2c3d4e5f6a7b8"));
    // The fresh copy goes where the one typed is, never into the cache.
    expect(inv.homes).toEqual([offered(a, TYPED, 1), offered(path.join(home, ".local"), OWN)]);

    // On a computer with no installed copy at all, nothing is typed and a shell finds none.
    const alone = look({ ...o, env: { PATH: npx.bin } });
    expect(alone.onPath).toEqual([]);
    expect(alone.copies).toEqual([cachedRow(npx, { uses: ["this"] })]);
    expect(alone.homes).toEqual([offered(path.join(home, ".local"), OWN)]);
  });

  it("wherever npm keeps its cache: an entry's `.bin` is told by its shape, and the entry found as this command's own", () => {
    // A cache this look is not told of (npm's own config names it, not the environment).
    const npx = npxEntry(path.join(tmp, "elsewhere"), "ffffeeeeddddcccc");
    const o = looking({ env: { PATH: npx.bin } });
    expect(look(o)).toMatchObject({ copies: [], onPath: [], dangling: [], strangers: [] });
    const mine = look({ ...o, distDir: path.join(npx.dir, "dist") });
    expect(mine.copies).toEqual([cachedRow(npx, { uses: ["this"] })]);
    expect(mine.onPath).toEqual([]);
  });

  it("a link that leads nowhere and a file of the name, in an entry's `.bin`, are not listed either", () => {
    const cache = path.join(home, ".npm");
    // An entry whose package is gone and whose link stayed; one where someone put a file.
    const hollow = npxEntry(cache, "0000111122223333");
    rmSync(hollow.dir, { recursive: true });
    const odd = path.join(cache, "_npx", "4444555566667777", "node_modules", ".bin");
    mkdirSync(odd, { recursive: true });
    writeFileSync(path.join(odd, "sessionpipe"), "#!/bin/sh\necho mine\n");
    expect(look(looking({ env: { PATH: PATH(hollow.bin, odd) } }))).toMatchObject({
      copies: [],
      onPath: [],
      dangling: [],
      strangers: [],
    });
  });

  it("which folder of PATH each is in: an empty folder and npx's own are places in the order all the same", () => {
    const npx = npxEntry(path.join(home, ".npm"), "a1b2c3d4e5f6a7b8");
    const [a, b] = [path.join(tmp, "a"), path.join(tmp, "b")];
    globalCopy(a);
    globalCopy(b);
    mkdirSync(path.join(tmp, "empty"));
    const inv = look(
      looking({ env: { PATH: PATH(path.join(tmp, "empty"), path.join(a, "bin"), npx.bin, path.join(b, "bin")) } }),
    );
    expect(inv.onPath).toEqual([
      { file: binOf(a), dir: slot(a), at: 1 },
      { file: binOf(b), dir: slot(b), at: 3 },
    ]);
    expect(inv.homes).toEqual([offered(a, TYPED, 1), offered(b, ANOTHER, 3), offered(path.join(home, ".local"), OWN)]);
  });

  describe("the hooks, written by one release: whose they are among the copies of it", () => {
    const local = () => path.join(home, ".local");
    /** This command run by npx from its cache entry, with the hooks written by its release. */
    const under = (npx: { dir: string }, o: Partial<Looking> = {}) =>
      looking({ distDir: path.join(npx.dir, "dist"), hooksVersion: "0.15.0", ...o });

    it("the copy something uses beside this very command, before npx's own entry", () => {
      const npx = npxEntry(path.join(home, ".npm"), "a1b2c3d4e5f6a7b8");
      globalCopy(local());
      const inv = look(under(npx, { env: { PATH: PATH(npx.bin, path.join(local(), "bin")) } }));
      expect(inv.copies).toEqual([row(local(), { uses: ["typed", "hooks"] }), cachedRow(npx, { uses: ["this"] })]);
    });

    it("the installed copy though nothing types or serves it, never the entry npx runs this from", () => {
      // The computer a repair has just left: one copy, its folder not on PATH yet. Run
      // again through npx, the hooks are still that copy's, and nothing is to repair.
      const npx = npxEntry(path.join(home, ".npm"), "a1b2c3d4e5f6a7b8");
      globalCopy(local());
      const inv = look(under(npx, { env: { PATH: npx.bin } }));
      expect(inv.copies).toEqual([row(local(), { uses: ["hooks"] }), cachedRow(npx, { uses: ["this"] })]);
    });

    it("an installed copy this command runs from, before a cache entry that is listed ahead of it", () => {
      // A cache entry nothing uses is found before the copy this command runs from, which
      // is in no folder known as a Node's: being first is not what decides.
      const stale = npxEntry(path.join(home, ".npm"), "a1b2c3d4e5f6a7b8");
      const mine = path.join(tmp, "mine");
      globalCopy(mine);
      const inv = look(looking({ distDir: path.join(slot(mine), "dist"), hooksVersion: "0.15.0" }));
      expect(inv.copies).toEqual([cachedRow(stale), row(mine, { uses: ["this", "hooks"] })]);
    });

    it("with only cache entries of that release, the first of them", () => {
      // One the cache holds, and the one this runs from, in a cache this look is not told of.
      const held = npxEntry(path.join(home, ".npm"), "a1b2c3d4e5f6a7b8");
      const npx = npxEntry(path.join(tmp, "elsewhere"), "ffffeeeeddddcccc");
      // An installed copy of another release has nothing to do with them.
      globalCopy(local(), { version: "0.14.2" });
      const inv = look(under(npx));
      expect(inv.copies).toEqual([
        row(local(), { version: "0.14.2" }),
        cachedRow(held, { uses: ["hooks"] }),
        cachedRow(npx, { uses: ["this"] }),
      ]);
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

  it("a `.bin` that is no npx entry's is a folder on PATH like any other", () => {
    // A project's own, as `npm run` puts it on PATH; and one under a folder that only has
    // the cache's name, with no entry between.
    const project = path.join(home, "code", "app", "node_modules");
    const named = path.join(tmp, "_npx", "node_modules");
    for (const modules of [project, named]) {
      pkg(path.join(modules, "sessionpipe"));
      mkdirSync(path.join(modules, ".bin"));
      symlinkSync(path.join("..", "sessionpipe", "dist", "cli.js"), path.join(modules, ".bin", "sessionpipe"));
    }
    const inv = look(looking({ env: { PATH: PATH(path.join(project, ".bin"), path.join(named, ".bin")) } }));
    expect(inv.onPath).toEqual([
      { file: path.join(project, ".bin", "sessionpipe"), dir: path.join(project, "sessionpipe"), at: 0 },
      { file: path.join(named, ".bin", "sessionpipe"), dir: path.join(named, "sessionpipe"), at: 1 },
    ]);
    const dependency = (modules: string, o: Partial<Copy>): Copy =>
      cachedRow(
        {
          entry: path.join(modules, "sessionpipe"),
          bin: path.join(modules, ".bin"),
          dir: path.join(modules, "sessionpipe"),
        },
        { slot: null, not: NO_SLOT, bins: [], ...o },
      );
    expect(inv.copies).toEqual([
      dependency(project, {
        where: path.join("~", "code", "app", "node_modules", "sessionpipe"),
        uses: ["typed"],
      }),
      dependency(named, {}),
    ]);
  });
});

describe.runIf(posix)("look: what is wrong with a copy", () => {
  it("no cli.js, one that prints nothing, one that says another version; a package.json cut off, or not its own", () => {
    const at = (n: string) => path.join(tmp, n);
    globalCopy(at("whole"));
    globalCopy(at("no-cli"), { says: null });
    globalCopy(at("silent"), { says: "" });
    globalCopy(at("mixed"), { says: "0.14.2" });
    globalCopy(at("unversioned"), { version: null, says: "1.2.3" });
    globalCopy(at("number"), { raw: '{"name":"sessionpipe","version":15}', says: "0.15.0" });
    globalCopy(at("cut-off"), { raw: '{"name":"sessionp', says: "0.15.0" });
    globalCopy(at("empty"), { raw: null, says: null });
    globalCopy(at("other"), { name: "sessionpipe-fork" });
    const names = ["whole", "no-cli", "silent", "mixed", "unversioned", "number", "cut-off", "empty", "other"];
    const inv = look(looking({ env: { PATH: PATH(...names.map((n) => path.join(at(n), "bin"))) } }));
    expect(inv.copies).toEqual([
      row(at("whole"), { uses: ["typed"] }),
      row(at("no-cli"), { runs: false, wrong: MISSING }),
      row(at("silent"), { runs: false, wrong: "it doesn't run: `--version` printed nothing" }),
      row(at("mixed"), { runs: false, wrong: "it says it is 0.14.2, and its package.json says 0.15.0" }),
      row(at("unversioned"), {
        version: null,
        runs: false,
        wrong: "it says it is 1.2.3, and its package.json says nothing",
      }),
      row(at("number"), {
        version: null,
        runs: false,
        wrong: "it says it is 0.15.0, and its package.json says nothing",
      }),
      // An install that broke half-way is still npm's slot for sessionpipe: ours.
      row(at("cut-off"), {
        version: null,
        runs: false,
        wrong: "it says it is 0.15.0, and its package.json says nothing",
      }),
      row(at("empty"), { version: null, runs: false, wrong: MISSING }),
      // Another package in the slot is not ours, and its version is not sessionpipe's.
      row(at("other"), {
        slot: null,
        not: 'its package.json says it is "sessionpipe-fork", not sessionpipe',
        version: null,
        runs: false,
        wrong: "it says it is 0.15.0, and its package.json says nothing",
      }),
    ]);
    expect(inv.dangling).toEqual([]);
    expect(inv.strangers).toEqual([]);
  });
});

describe.runIf(posix)("look: links that lead nowhere, and files that only have the name", () => {
  it("a link to a sessionpipe that is gone: on PATH, in a prefix that is not on PATH, and once where it is both", () => {
    const x = path.join(tmp, "x");
    const local = path.join(home, ".local");
    linkBin(x);
    linkBin(local);
    const onPath = look(looking({ env: { PATH: path.join(x, "bin") } }));
    expect(onPath.dangling).toEqual([binOf(x), binOf(local)]);
    expect(onPath.onPath).toEqual([{ file: binOf(x), dir: slot(x), at: 0 }]);
    expect(onPath.copies).toEqual([]);
    const both = look(looking({ env: { PATH: PATH(path.join(x, "bin"), path.join(local, "bin")) } }));
    expect(both.dangling).toEqual([binOf(x), binOf(local)]);
    expect(both.onPath).toEqual([
      { file: binOf(x), dir: slot(x), at: 0 },
      { file: binOf(local), dir: slot(local), at: 1 },
    ]);
    // A prefix with a link and nothing behind it may still take the fresh copy.
    expect(both.homes).toEqual([offered(local, OWN, 1)]);
  });

  it("a file npm didn't put there, and a link that leads to no install, are strangers, each said as what it is", () => {
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
    const inv = look(looking({ env: { PATH: PATH(tools, links, dev, stale) } }));
    expect(inv.strangers).toEqual([
      { file: path.join(tools, "sessionpipe"), why: STRANGER },
      { file: path.join(links, "sessionpipe"), why: STRANGE_LINK },
      { file: path.join(dev, "sessionpipe"), why: STRANGE_LINK },
      { file: path.join(stale, "sessionpipe"), why: STRANGE_LINK },
    ]);
    expect(STRANGER).toBe("a file of that name that npm didn't put there");
    expect(STRANGE_LINK).toBe("a link that leads to no install of sessionpipe");
    expect(inv.onPath).toEqual([
      { file: path.join(tools, "sessionpipe"), dir: null, at: 0 },
      { file: path.join(links, "sessionpipe"), dir: null, at: 1 },
      { file: path.join(dev, "sessionpipe"), dir: null, at: 2 },
      { file: path.join(stale, "sessionpipe"), dir: null, at: 3 },
    ]);
    // None of them is a copy (the checkout is one only to a command that runs from it),
    // and none is a link to a sessionpipe that is gone.
    expect(inv.copies).toEqual([]);
    expect(inv.dangling).toEqual([]);
  });

  it("a PATH entry that is another name for a bin folder: its link is read from where it really is", () => {
    // ~/bin is a link to ~/.local/bin, and only ~/bin is on PATH. npm's link is relative,
    // so read from ~/bin it would lead to ~/lib/…, which is not there.
    const local = path.join(home, ".local");
    globalCopy(local);
    symlinkSync(path.join(local, "bin"), path.join(home, "bin"));
    const inv = look(looking({ env: { PATH: path.join(home, "bin") } }));
    expect(inv.dangling).toEqual([]);
    expect(inv.onPath).toEqual([{ file: binOf(local), dir: slot(local), at: 0 }]);
    expect(inv.copies).toEqual([row(local, { uses: ["typed"] })]);
    expect(inv.homes).toEqual([offered(local, TYPED, 0)]);
  });

  it("one folder on PATH under two names is one sessionpipe a shell finds, and one link that leads nowhere", () => {
    const [x, z] = [path.join(tmp, "x"), path.join(tmp, "z")];
    globalCopy(x);
    linkBin(z);
    symlinkSync(x, path.join(tmp, "also-x"));
    symlinkSync(z, path.join(tmp, "also-z"));
    const inv = look(
      looking({
        env: {
          PATH: PATH(
            path.join(tmp, "also-x", "bin"),
            path.join(x, "bin"),
            path.join(tmp, "also-z", "bin"),
            path.join(z, "bin"),
          ),
        },
      }),
    );
    // Four names on PATH, two folders: the second is the second.
    expect(inv.onPath).toEqual([
      { file: binOf(x), dir: slot(x), at: 0 },
      { file: binOf(z), dir: slot(z), at: 1 },
    ]);
    expect(inv.dangling).toEqual([binOf(z)]);
    expect(inv.copies).toEqual([row(x, { uses: ["typed"] })]);
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
    // The folder it leads to is on PATH, second: that is where a shell finds what goes in it.
    expect(look(looking({ env: { PATH: PATH(path.join(tmp, "empty"), real) } })).homes).toEqual([
      offered(local, OWN, 1, real),
    ]);
    // Named on PATH through the link itself it is the same folder.
    expect(look(looking({ env: { PATH: path.join(local, "bin") } })).homes).toEqual([offered(local, OWN, 0, real)]);
    // Not on PATH by either name: the real folder is still the one said, and no shell finds it.
    expect(look(looking({ env: { PATH: path.join(tmp, "empty") } })).homes).toEqual([offered(local, OWN, null, real)]);
  });
});

describe.runIf(posix)("look: what is not ours", () => {
  it("Volta's copy is Volta's to remove, and its folder is never where the fresh one goes", () => {
    const volta = path.join(home, ".volta", "tools", "image", "packages", "sessionpipe");
    globalCopy(volta);
    // Volta's own command for it: a link to its shim, first on PATH.
    mkdirSync(path.join(home, ".volta", "bin"), { recursive: true });
    writeFileSync(path.join(home, ".volta", "bin", "volta-shim"), "");
    symlinkSync("volta-shim", path.join(home, ".volta", "bin", "sessionpipe"));
    const kept = row(volta, { slot: null, not: "Volta keeps it", keeper: "volta uninstall sessionpipe" });
    const inv = look(looking({ env: { PATH: path.join(home, ".volta", "bin") }, npmPrefix: volta }));
    expect(inv.copies).toEqual([kept]);
    expect(kept.where).toBe(path.join("~", ".volta", "tools", "image", "packages", "sessionpipe"));
    expect(inv.strangers).toEqual([{ file: path.join(home, ".volta", "bin", "sessionpipe"), why: STRANGE_LINK }]);
    expect(inv.homes).toEqual([offered(path.join(home, ".local"), OWN)]);

    // Where VOLTA_HOME says Volta is.
    const told = path.join(tmp, "volta", "tools", "image", "packages", "sessionpipe");
    globalCopy(told);
    const there = look(looking({ env: { VOLTA_HOME: path.join(tmp, "volta") }, npmPrefix: told }));
    expect(there.copies).toEqual([
      row(told, { slot: null, not: "Volta keeps it", keeper: "volta uninstall sessionpipe" }),
    ]);
    expect(there.homes).toEqual([offered(path.join(home, ".local"), OWN)]);
  });

  it("a checkout this command runs from is listed, with why it is no install", () => {
    const checkout = pkg(path.join(home, "code", "sessionpipe"), { holds: ["src", ".git"] });
    const inv = look(looking({ distDir: path.join(checkout, "dist") }));
    expect(inv.copies).toEqual([
      row(home, {
        dir: checkout,
        where: path.join("~", "code", "sessionpipe"),
        prefix: null,
        slot: null,
        not: NO_SLOT,
        bins: [],
        uses: ["this"],
      }),
    ]);
    expect(inv.homes).toEqual([offered(path.join(home, ".local"), OWN)]);
  });

  it("a slot that holds a checkout, a link to one, or a link to nothing: listed, not ours, and no place for the fresh copy", () => {
    // A build someone copied into the slot.
    const built = path.join(tmp, "built");
    globalCopy(built, { holds: ["src"] });
    // `npm link`: the slot is a link to a checkout, which is what a shell runs.
    const linked = path.join(tmp, "linked");
    const checkout = pkg(path.join(tmp, "code", "sessionpipe"), { holds: ["src"] });
    mkdirSync(path.dirname(slot(linked)), { recursive: true });
    symlinkSync(checkout, slot(linked));
    linkBin(linked);
    // A link in the slot whose folder is gone.
    const hollow = path.join(tmp, "hollow");
    mkdirSync(path.dirname(slot(hollow)), { recursive: true });
    symlinkSync(path.join(tmp, "code", "gone"), slot(hollow));

    const o = looking({ env: { PATH: PATH(path.join(linked, "bin"), path.join(built, "bin")) } });
    const inv = look({ ...o, npmPrefix: hollow });
    expect(inv.copies).toEqual([
      row(tmp, { dir: checkout, where: checkout, prefix: null, slot: null, not: NO_SLOT, bins: [], uses: ["typed"] }),
      row(built, { slot: null, not: "it holds src, which no published sessionpipe has (a checkout or a build?)" }),
      row(hollow, {
        slot: null,
        not: "it is a link that doesn't lead into a sessionpipe install",
        version: null,
        runs: false,
        wrong: MISSING,
        bins: [],
      }),
    ]);
    expect(inv.onPath).toEqual([
      { file: binOf(linked), dir: checkout, at: 0 },
      { file: binOf(built), dir: slot(built), at: 1 },
    ]);
    const own = [offered(path.join(home, ".local"), OWN)];
    expect(inv.homes).toEqual(own);
    expect(look({ ...o, npmPrefix: built }).homes).toEqual(own);
    expect(look({ ...o, npmPrefix: linked }).homes).toEqual(own);
  });
});

describe.runIf(posix)("look: where the fresh copy may go", () => {
  /** A copy typed, the one this command runs from, the service's, one more, and npm's own
   *  folder with nothing in it: every reason a folder is offered for, on one computer. */
  const everyReason = () => {
    const [typed, mine, served, npm] = ["typed", "mine", "served", "npm"].map((n) => path.join(tmp, n)) as [
      string,
      string,
      string,
      string,
    ];
    const another = path.join(home, ".npm-global");
    for (const p of [typed, mine, served, another]) globalCopy(p);
    const o = looking({
      env: { PATH: path.join(typed, "bin") },
      distDir: path.join(slot(mine), "dist"),
      serviceCli: cliOf(served),
      npmPrefix: npm,
    });
    return { typed, mine, served, npm, another, local: path.join(home, ".local"), o };
  };

  it("the typed copy's prefix, this command's, the service's, another copy's, npm's own, then ~/.local", () => {
    const { typed, mine, served, npm, another, local, o } = everyReason();
    const inv = look(o);
    expect(inv.copies).toEqual([
      row(typed, { uses: ["typed"] }),
      row(another),
      row(mine, { uses: ["this"] }),
      row(served, { uses: ["service"] }),
    ]);
    expect(inv.homes).toEqual([
      offered(typed, TYPED, 0),
      offered(mine, THIS),
      offered(served, SERVICE),
      offered(another, ANOTHER),
      offered(npm, NPM),
      offered(local, OWN),
    ]);
  });

  it("a folder a shell finds `sessionpipe` in comes before one it doesn't; among each, the same order", () => {
    const { typed, mine, served, npm, another, local, o } = everyReason();
    // ~/.local/bin and npm's own bin folder are on PATH with nothing in them yet, the
    // service's copy is on PATH behind the one typed. Those four come first, in the order
    // of their reasons, whichever way PATH lists them: they are not put in PATH's order.
    const rest = [offered(mine, THIS), offered(another, ANOTHER)];
    const onPath = (...after: string[]) =>
      look({ ...o, env: { PATH: PATH(...[typed, ...after].map((p) => path.join(p, "bin"))) } });
    const asListed = onPath(served, npm, local);
    expect(asListed.homes).toEqual([
      offered(typed, TYPED, 0),
      offered(served, SERVICE, 1),
      offered(npm, NPM, 2),
      offered(local, OWN, 3),
      ...rest,
    ]);
    expect(asListed.copies.map((c) => c.uses)).toEqual([["typed"], ["service"], [], ["this"]]);
    // ~/.local, offered last, is earlier on PATH than the service's and npm's: it stays last of them.
    const turned = onPath(local, npm, served);
    expect(turned.homes).toEqual([
      offered(typed, TYPED, 0),
      offered(served, SERVICE, 3),
      offered(npm, NPM, 2),
      offered(local, OWN, 1),
      ...rest,
    ]);
    expect(turned.copies.map((c) => c.uses)).toEqual([["typed"], ["service"], [], ["this"]]);
    // The first on PATH need not hold the one typed: an empty bin folder there is found
    // by a shell all the same, and stays behind the reasons that come before its own.
    const first = look({ ...o, env: { PATH: PATH(path.join(local, "bin"), path.join(typed, "bin")) } });
    expect(first.homes).toEqual([
      offered(typed, TYPED, 1),
      offered(local, OWN, 0),
      offered(mine, THIS),
      offered(served, SERVICE),
      offered(another, ANOTHER),
      offered(npm, NPM),
    ]);
    // With no PATH at all nothing is found by a shell (nor is the copy that was typed,
    // whose folder is no Node's that is known here), and the order is the reasons' own.
    const none = look({ ...o, env: {} });
    expect(none.homes).toEqual([
      offered(mine, THIS),
      offered(served, SERVICE),
      offered(another, ANOTHER),
      offered(npm, NPM),
      offered(local, OWN),
    ]);
  });

  it("a prefix is offered once, for the first reason", () => {
    const local = path.join(home, ".local");
    globalCopy(local);
    const inv = look(
      looking({
        env: { PATH: path.join(local, "bin") },
        distDir: path.join(slot(local), "dist"),
        serviceCli: cliOf(local),
        npmPrefix: local,
      }),
    );
    expect(inv.copies).toEqual([row(local, { uses: ["typed", "service", "this"] })]);
    expect(inv.homes).toEqual([offered(local, TYPED, 0)]);
  });

  /** Three copies on PATH: one whose package folder refuses, one whose bin folder does,
   *  one that is this user's to write. `refuse` is how those folders are made to. */
  const sealedOff = (refuse: (dirs: string[]) => void) => () => {
    const [sealed, noBin, open] = ["sealed", "no-bin", "open"].map((n) => path.join(tmp, n)) as [
      string,
      string,
      string,
    ];
    for (const p of [sealed, noBin, open]) globalCopy(p);
    refuse([path.dirname(slot(sealed)), path.join(noBin, "bin")]);
    const inv = look(looking({ env: { PATH: PATH(...[sealed, noBin, open].map((p) => path.join(p, "bin"))) } }));
    expect(inv.copies).toEqual([row(sealed, { uses: ["typed"], writable: false }), row(noBin), row(open)]);
    expect(inv.homes).toEqual([offered(open, ANOTHER, 2), offered(path.join(home, ".local"), OWN)]);
  };
  it(
    "not a prefix whose package folder, or whose bin folder, this user may not write",
    sealedOff((dirs) => {
      fake.access = (p) => (dirs.includes(p) ? "EACCES" : null);
    }),
  );
  it.runIf(refusable)(
    "nor one whose folders the system itself refuses",
    sealedOff((dirs) => dirs.forEach(lock)),
  );

  it("not Homebrew's versioned folder for a Node, which the next upgrade takes away", () => {
    const cellar = path.join(tmp, "opt", "homebrew", "Cellar");
    const own = offered(path.join(home, ".local"), OWN);
    for (const node of [path.join("node", "23.1.0"), path.join("node@22", "22.11.0")]) {
      mkdirSync(path.join(cellar, node), { recursive: true });
      expect(look(looking({ npmPrefix: path.join(cellar, node) })).homes).toEqual([own]);
    }
    // A copy typed from there is listed all the same.
    globalCopy(path.join(cellar, "node", "23.1.0"));
    const typed = look(looking({ env: { PATH: path.join(cellar, "node", "23.1.0", "bin") } }));
    expect(typed.copies).toEqual([row(path.join(cellar, "node", "23.1.0"), { uses: ["typed"] })]);
    expect(typed.homes).toEqual([own]);
    // Only a Node's: another formula's folder is a folder like any other.
    const other = path.join(cellar, "nodebrew", "1.2.0");
    expect(look(looking({ npmPrefix: other })).homes).toEqual([offered(other, NPM), own]);
  });
});

describe.runIf(posix)("look: what sits where a home's command goes", () => {
  const SCRIPT = '#!/bin/sh\nexec node ~/code/sessionpipe/dist/cli.js "$@"\n';
  const at = (n: string): string => path.join(tmp, n);
  const own = () => offered(path.join(home, ".local"), OWN);
  /** The homes offered where npm's own folder is `prefix` and nothing is on PATH. */
  const homesWith = (prefix: string) => look(looking({ npmPrefix: prefix })).homes;

  it("nothing there, npm's link to the copy there, and npm's link whose folder is gone block nothing", () => {
    mkdirSync(path.join(at("empty"), "bin"), { recursive: true });
    globalCopy(at("whole"));
    linkBin(at("hollow"));
    expect(homesWith(at("empty"))).toEqual([offered(at("empty"), NPM), own()]);
    expect(homesWith(at("whole"))).toEqual([offered(at("whole"), ANOTHER), own()]);
    // What npm left when its folder went is a link to this very slot: the install writes it again.
    const inv = look(looking({ npmPrefix: at("hollow") }));
    expect(inv.dangling).toEqual([binOf(at("hollow"))]);
    expect(inv.homes).toEqual([offered(at("hollow"), NPM), own()]);
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
      expect(homesWith(at(n))).toEqual([offered(at(n), NPM, null, undefined, binOf(at(n))), own()]);
    // The same over a copy that is there: its own link is what the file took the place of.
    pkg(slot(at("script")));
    expect(homesWith(at("script"))).toEqual([
      offered(at("script"), ANOTHER, null, undefined, binOf(at("script"))),
      own(),
    ]);
  });

  it("such a home keeps its place and its reason: no other is put before it", () => {
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
    expect(inv.homes).toEqual([
      offered(local, TYPED, 1, undefined, binOf(local)),
      offered(b, ANOTHER, 2),
      offered(at("npm"), NPM),
    ]);
    // With nothing on PATH: first for its reason all the same, a clean folder behind it.
    const off = look(looking({ distDir: path.join(slot(local), "dist"), npmPrefix: b }));
    expect(off.homes).toEqual([offered(local, THIS, null, undefined, binOf(local)), offered(b, ANOTHER)]);
  });

  it("where a home's bin folder is a link, the file is named in the folder that really is", () => {
    const local = path.join(home, ".local");
    const real = path.join(at("dotfiles"), "bin");
    mkdirSync(real, { recursive: true });
    mkdirSync(local);
    symlinkSync(real, path.join(local, "bin"));
    writeFileSync(path.join(real, "sessionpipe"), SCRIPT);
    expect(look(looking()).homes).toEqual([offered(local, OWN, null, real, path.join(real, "sessionpipe"))]);
    expect(look(looking({ env: { PATH: path.join(local, "bin") } })).homes).toEqual([
      offered(local, OWN, 0, real, path.join(real, "sessionpipe")),
    ]);
  });
});

describe.runIf(posix)("look: only what is inside the reach folder", () => {
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
  it("a copy, a link, a file and a cache outside it are not listed, and no home is offered there", () => {
    const { world, local, o } = worlds();
    const inv = look(o);
    expect(inv).toEqual({
      platform: "linux",
      reach: world,
      copies: [row(local, { uses: ["typed"] })],
      dangling: [],
      strangers: [],
      // The folders of PATH that are not its own are still places in the order.
      onPath: [{ file: binOf(local), dir: slot(local), at: 3 }],
      homes: [offered(local, TYPED, 3)],
      prefixes: [
        path.join(world, "node"),
        local,
        path.join(world, "home", ".npm-global"),
        path.join(world, "home", ".volta", "tools", "image", "packages", "sessionpipe"),
      ],
    } satisfies Inventory);
  });

  it("the reach folder named through a link is the same folder", () => {
    const { world, local, o } = worlds();
    symlinkSync(world, path.join(tmp, "alias"));
    const inv = look({ ...o, reach: path.join(tmp, "alias") });
    expect(inv.reach).toBe(world);
    expect(inv.copies).toEqual([row(local, { uses: ["typed"] })]);
  });

  it("with no folder its own, nothing is listed and nowhere is offered", () => {
    const { o } = worlds();
    expect(look({ ...o, reach: null })).toEqual({
      platform: "linux",
      reach: null,
      copies: [],
      dangling: [],
      strangers: [],
      onPath: [],
      homes: [],
      prefixes: [],
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
    expect(mine(inv.copies, (c) => c.dir)).toEqual([
      out("typed", { uses: ["typed"] }),
      row(local),
      out("npm"),
      {
        ...out("cache"),
        dir: path.join(outside, "cache", "_npx", "a1b2c3d4e5f6a7b8", "node_modules", "sessionpipe"),
        where: path.join(outside, "cache", "_npx", "a1b2c3d4e5f6a7b8"),
        prefix: null,
        slot: "npx",
        bins: [],
      },
      out("mine", { uses: ["this"] }),
      out("served", { uses: ["service"] }),
    ]);
    expect(mine(inv.dangling, (f) => f)).toEqual([binOf(path.join(outside, "hollow"))]);
    expect(mine(inv.strangers, (s) => s.file)).toEqual([
      { file: path.join(outside, "tools", "sessionpipe"), why: STRANGER },
    ]);
    expect(mine(inv.onPath, (e) => e.file).map((e) => [e.file, e.at])).toEqual([
      [binOf(path.join(outside, "typed")), 0],
      [binOf(path.join(outside, "hollow")), 1],
      [path.join(outside, "tools", "sessionpipe"), 2],
      [binOf(local), 3],
    ]);
    // The two a shell finds first, then the others by their reasons.
    expect(mine(inv.homes, (h) => h.prefix).map((h) => [h.prefix, h.why, h.pathAt])).toEqual([
      [path.join(outside, "typed"), TYPED, 0],
      [local, ANOTHER, 3],
      [path.join(outside, "mine"), THIS, null],
      [path.join(outside, "served"), SERVICE, null],
      [path.join(outside, "npm"), ANOTHER, null],
    ]);
    expect(inv.prefixes).toContain(spelled("/usr/local"));
  });
});

describe("look: a Windows computer", () => {
  const win = (o: Partial<Looking> = {}): Looking =>
    looking({ platform: "win32", execPath: path.join(tmp, "Program Files", "nodejs", "node.exe"), ...o });
  /** What the look says of a clean copy in a Windows prefix. */
  const winRow = (prefix: string, o: Partial<Copy> = {}): Copy =>
    row(prefix, { dir: winSlot(prefix), bins: [path.join(prefix, "sessionpipe.cmd")], ...o });
  /** A home on Windows: the command goes in the prefix itself. */
  const winOffered = (prefix: string, why: string, pathAt: number | null = null, blocked: string | null = null) =>
    offered(prefix, why, pathAt, prefix, blocked);

  it("%AppData%\\npm, the Node's own folder, nvm-windows and the npx cache; the shims are files that name the copy", () => {
    const env = {
      APPDATA: path.join(tmp, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(tmp, "AppData", "Local"),
      ProgramFiles: path.join(tmp, "Program Files"),
      NVM_HOME: path.join(tmp, "nvm"),
    };
    const roaming = path.join(env.APPDATA, "npm");
    const system = path.join(env.ProgramFiles, "nodejs");
    const nvm = path.join(env.NVM_HOME, "v22.11.0");
    const project = path.join(tmp, "project");
    pkg(winSlot(roaming));
    shims(roaming);
    pkg(path.join(roaming, "node_modules", ".sessionpipe-Ab3dE9xZ"), { version: "0.12.0", says: null });
    pkg(winSlot(system), { version: "0.14.2" });
    shims(system, ["sessionpipe.cmd"]);
    pkg(winSlot(nvm), { version: "0.13.0" });
    const cached = path.join(env.LOCALAPPDATA, "npm-cache", "_npx", "a1b2c3d4e5f6a7b8");
    pkg(winSlot(cached));
    // A project's own dependency, with a shim someone put beside it, on PATH: a
    // `node_modules` like the others, in a folder that is no Node's global one.
    pkg(winSlot(project));
    shims(project, ["sessionpipe.cmd"]);
    // What the default place for the cache holds is not looked at where LOCALAPPDATA is said.
    pkg(winSlot(path.join(home, ".npm", "_npx", "0000111122223333")));

    const inv = look(win({ env: { ...env, PATH: PATH(roaming, project) } }));
    expect(inv).toEqual({
      platform: "win32",
      reach: tmp,
      copies: [
        winRow(roaming, {
          bins: ["sessionpipe", "sessionpipe.cmd", "sessionpipe.ps1"].map((n) => path.join(roaming, n)),
          uses: ["typed"],
        }),
        winRow(project, { where: winSlot(project), prefix: null, slot: null, not: NO_SLOT, bins: [] }),
        winRow(roaming, {
          dir: path.join(roaming, "node_modules", ".sessionpipe-Ab3dE9xZ"),
          aside: true,
          version: "0.12.0",
          runs: false,
          wrong: "left behind by an install that was cut off",
          bins: [],
        }),
        winRow(system, { version: "0.14.2" }),
        // No shim in its prefix names it: nothing starts it.
        winRow(nvm, { version: "0.13.0", bins: [], wrong: NO_LINK }),
        winRow(cached, { where: cached, prefix: null, slot: "npx", bins: [] }),
      ],
      dangling: [],
      strangers: [],
      onPath: [
        { file: path.join(roaming, "sessionpipe.cmd"), dir: winSlot(roaming), at: 0 },
        { file: path.join(project, "sessionpipe.cmd"), dir: winSlot(project), at: 1 },
      ],
      homes: [winOffered(roaming, TYPED, 0), winOffered(system, ANOTHER), winOffered(nvm, ANOTHER)],
      prefixes: [roaming, system, nvm],
    } satisfies Inventory);
  });

  it("a shim with nothing behind it, on PATH and off it; a file of the name that is no shim; no %AppData%", () => {
    const [one, tools, nvm] = [path.join(tmp, "one"), path.join(tmp, "tools"), path.join(tmp, "nvm", "v20.18.0")];
    shims(one, ["sessionpipe.cmd"]);
    shims(nvm, ["sessionpipe.cmd"]);
    mkdirSync(tools);
    writeFileSync(path.join(tools, "sessionpipe.cmd"), "@echo mine\r\n");
    // With no LOCALAPPDATA, npm's cache is in the home folder.
    const cached = path.join(home, ".npm", "_npx", "a1b2c3d4e5f6a7b8");
    pkg(winSlot(cached));
    const inv = look(win({ env: { PATH: PATH(one, tools), NVM_HOME: path.join(tmp, "nvm") }, npmPrefix: one }));
    expect(inv).toEqual({
      platform: "win32",
      reach: tmp,
      copies: [
        winRow(cached, {
          where: path.join("~", ".npm", "_npx", "a1b2c3d4e5f6a7b8"),
          prefix: null,
          slot: "npx",
          bins: [],
        }),
      ],
      dangling: [path.join(one, "sessionpipe.cmd"), path.join(nvm, "sessionpipe.cmd")],
      strangers: [{ file: path.join(tools, "sessionpipe.cmd"), why: STRANGER }],
      onPath: [
        { file: path.join(one, "sessionpipe.cmd"), dir: winSlot(one), at: 0 },
        { file: path.join(tools, "sessionpipe.cmd"), dir: null, at: 1 },
      ],
      // No copy to go by and no %AppData%: npm's own folder, which is on PATH.
      homes: [winOffered(one, NPM, 0)],
      prefixes: [path.join(tmp, "Program Files", "nodejs"), one, nvm],
    } satisfies Inventory);
  });

  it("started by npx: the entry's `.bin` on PATH is passed over, and the copy typed is the one behind it", () => {
    const APPDATA = path.join(tmp, "AppData", "Roaming");
    const LOCALAPPDATA = path.join(tmp, "AppData", "Local");
    const roaming = path.join(APPDATA, "npm");
    pkg(winSlot(roaming), { version: "0.14.2" });
    shims(roaming);
    const entry = path.join(LOCALAPPDATA, "npm-cache", "_npx", "a1b2c3d4e5f6a7b8");
    const bin = path.join(entry, "node_modules", ".bin");
    pkg(winSlot(entry));
    // npm's shims in a `.bin` name the package beside that folder.
    mkdirSync(bin);
    writeFileSync(path.join(bin, "sessionpipe"), 'exec node  "$basedir/../sessionpipe/dist/cli.js" "$@"\n');
    writeFileSync(path.join(bin, "sessionpipe.cmd"), '"%_prog%"  "%dp0%\\..\\sessionpipe\\dist\\cli.js" %*\r\n');
    writeFileSync(path.join(bin, "sessionpipe.ps1"), '& "node$exe"  "$basedir/../sessionpipe/dist/cli.js" $args\n');
    const three = (dir: string) => ["sessionpipe", "sessionpipe.cmd", "sessionpipe.ps1"].map((n) => path.join(dir, n));
    const inv = look(
      win({
        env: { APPDATA, LOCALAPPDATA, PATH: PATH(bin, roaming) },
        distDir: path.join(winSlot(entry), "dist"),
      }),
    );
    expect(inv.onPath).toEqual([{ file: path.join(roaming, "sessionpipe.cmd"), dir: winSlot(roaming), at: 1 }]);
    expect(inv.copies).toEqual([
      winRow(roaming, { version: "0.14.2", bins: three(roaming), uses: ["typed"] }),
      winRow(entry, { where: entry, prefix: null, slot: "npx", bins: three(bin), uses: ["this"] }),
    ]);
    expect(inv.dangling).toEqual([]);
    expect(inv.strangers).toEqual([]);
    expect(inv.homes).toEqual([winOffered(roaming, TYPED, 1)]);
  });

  it("what sits where a home's command goes: npm's shim blocks nothing; a file of one of its three names that is not npm's is said", () => {
    const at = (n: string): string => path.join(tmp, n);
    /** The one home offered where npm's own folder is `prefix`: there is no %AppData% here. */
    const homesWith = (prefix: string) => look(win({ npmPrefix: prefix })).homes;
    // Nothing there; npm's own `.cmd`, alone and with its two brothers.
    mkdirSync(at("empty"));
    shims(at("cmd"), ["sessionpipe.cmd"]);
    shims(at("three"));
    for (const n of ["empty", "cmd", "three"]) expect(homesWith(at(n))).toEqual([winOffered(at(n), NPM)]);
    // A `.cmd` that names nothing of ours.
    mkdirSync(at("foreign-cmd"));
    writeFileSync(path.join(at("foreign-cmd"), "sessionpipe.cmd"), "@echo mine\r\n");
    expect(homesWith(at("foreign-cmd"))).toEqual([
      winOffered(at("foreign-cmd"), NPM, null, path.join(at("foreign-cmd"), "sessionpipe.cmd")),
    ]);
    // npm's `.cmd` beside a `.ps1` that is someone's own.
    shims(at("foreign-ps1"), ["sessionpipe.cmd"]);
    writeFileSync(path.join(at("foreign-ps1"), "sessionpipe.ps1"), "Write-Host mine\n");
    expect(homesWith(at("foreign-ps1"))).toEqual([
      winOffered(at("foreign-ps1"), NPM, null, path.join(at("foreign-ps1"), "sessionpipe.ps1")),
    ]);
    // Someone's own file with no extension, npm's two beside it; and all three someone's:
    // the first of the three names is the one said.
    shims(at("foreign-sh"), ["sessionpipe.cmd", "sessionpipe.ps1"]);
    mkdirSync(at("all-foreign"));
    for (const n of ["sessionpipe", "sessionpipe.cmd", "sessionpipe.ps1"])
      writeFileSync(path.join(at("all-foreign"), n), "mine\n");
    writeFileSync(path.join(at("foreign-sh"), "sessionpipe"), "#!/bin/sh\necho mine\n");
    for (const n of ["foreign-sh", "all-foreign"])
      expect(homesWith(at(n))).toEqual([winOffered(at(n), NPM, null, path.join(at(n), "sessionpipe"))]);
    // Over a copy that is there, on PATH, typed: the home is the same one, in its place.
    pkg(winSlot(at("foreign-ps1")));
    const typed = look(win({ env: { PATH: at("foreign-ps1") }, npmPrefix: at("foreign-ps1") }));
    expect(typed.copies).toEqual([winRow(at("foreign-ps1"), { uses: ["typed"] })]);
    expect(typed.homes).toEqual([
      winOffered(at("foreign-ps1"), TYPED, 0, path.join(at("foreign-ps1"), "sessionpipe.ps1")),
    ]);
  });

  it("with %AppData% and nothing installed, %AppData%\\npm is the folder of your own", () => {
    const APPDATA = path.join(tmp, "AppData", "Roaming");
    const inv = look(win({ env: { APPDATA } }));
    expect(inv.copies).toEqual([]);
    expect(inv.homes).toEqual([winOffered(path.join(APPDATA, "npm"), OWN)]);
  });
});
