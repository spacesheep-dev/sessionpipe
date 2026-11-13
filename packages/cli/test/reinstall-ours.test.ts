// SPDX-License-Identifier: Apache-2.0
// What `sessionpipe reinstall` may remove (reinstall/ours.ts): the proof, shape by shape
// and refusal by refusal; the one removal, which takes a folder and exactly its own bin
// link (or the folder alone, where its slot is filled again) and nothing through a link;
// and the guard that reads the sources: nothing else in reinstall/ deletes anything, and
// the wiring in cli.ts deletes nothing itself.
//
// Everything is built in a temp dir. node:fs is stood in for only to watch and to fail on
// cue: every path ours.ts hands to rmSync or unlinkSync is written down, and one that is
// not inside the test's temp dir is refused before it reaches the disk. So a mistake here,
// or in the proof, can't remove a copy of this computer's.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
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
  slotOf,
  within,
} from "../src/reinstall/ours.js";

const fake = vi.hoisted(() => ({
  /** The test's temp dir. A deletion handed any other path is refused here, loudly. */
  root: "",
  /** Every path ours.ts handed to rmSync or unlinkSync, in order. */
  gone: [] as string[],
  /** A builtin that fails on cue, for a folder the system won't let anyone read. */
  fails: null as ((call: "readdirSync" | "realpathSync", p: string) => boolean) | null,
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
  const refuse = (call: "readdirSync" | "realpathSync", what: unknown): void => {
    if (typeof what === "string" && fake.fails?.(call, what))
      throw Object.assign(new Error(`EACCES: permission denied, ${call} '${what}'`), { code: "EACCES" });
  };
  const rmSync = ((what: unknown, ...rest: unknown[]) => {
    watched(what);
    return (real.rmSync as (...a: unknown[]) => void)(what, ...rest);
  }) as typeof real.rmSync;
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
  return { ...real, rmSync, unlinkSync, readdirSync, realpathSync };
});

/** Symbolic links: npm's bin links on every platform but Windows, where a test can't
 *  count on being allowed to make one. Windows' own shapes are plain files, tested
 *  everywhere by naming the platform. */
const links = process.platform !== "win32";
const posix = (reach: Reach = true): Proving => ({ platform: "linux", reach, prefixes: [] });
const win = (prefixes: readonly string[], reach: Reach = true): Proving => ({ platform: "win32", reach, prefixes });

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
/** Where a prefix holds a global package, off Windows. */
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
const npx = (id = "0a1b2c3d4e5f6a7b"): string => path.join(tmp, "cache", "_npx", id, "node_modules", "sessionpipe");
/** The shims npm writes on Windows (cmd-shim), as their one telling line: the path of the
 *  package's cli.js from where the shim sits. */
const shim = (name: string, to: string): string =>
  name.endsWith(".cmd")
    ? `@ECHO off\r\n"%_prog%"  "%dp0%\\${to.split("/").join("\\")}" %*\r\n`
    : name.endsWith(".ps1")
      ? `#!/usr/bin/env pwsh\n& "node$exe"  "$basedir/${to}" $args\n`
      : `#!/bin/sh\nexec node  "$basedir/${to}" "$@"\n`;
const SHIMS = ["sessionpipe", "sessionpipe.cmd", "sessionpipe.ps1"];
function shims(dir: string, to: string, names: readonly string[] = SHIMS): string[] {
  mkdirSync(dir, { recursive: true });
  return names.map((n) => {
    const file = path.join(dir, n);
    writeFileSync(file, shim(n, to));
    return file;
  });
}
const GLOBAL_SHIM = "node_modules/sessionpipe/dist/cli.js";
const BIN_SHIM = "../sessionpipe/dist/cli.js";

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

/** The removal, held to the temp dir: the path asked for, every path it answers and every
 *  path it handed to a deletion lie inside it. */
async function take(what: string, o: Parameters<typeof remove>[1]): Promise<string[]> {
  expect(inside(what), `${what} is inside ${tmp}`).toBe(true);
  const said = await remove(what, o);
  for (const p of [...said, ...fake.gone]) expect(inside(p), `${p} is inside ${tmp}`).toBe(true);
  return said;
}

/** Not ours: the proof says why, the removal refuses in the same words, and nothing at
 *  all is removed or changed. */
async function refused(what: string, o: Parameters<typeof remove>[1], why: string): Promise<void> {
  expect(inside(what), `${what} is inside ${tmp}`).toBe(true);
  const before = tree();
  expect(prove(what, o)).toEqual({ is: "not", why });
  const e = await remove(what, o).then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(e).toBeInstanceOf(NotOurs);
  expect(e).toMatchObject({ what, why, message: `${what} was left alone: ${why}` });
  expect(fake.gone).toEqual([]);
  expect(tree()).toEqual(before);
}

describe("the test's own tripwire", () => {
  it("a removal handed a path outside the temp dir is refused before it reaches the disk", async () => {
    const fs = await import("node:fs");
    const other = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sp-ours-other-")));
    try {
      const file = path.join(other, "keep.txt");
      writeFileSync(file, "keep");
      expect(() => fs.unlinkSync(file)).toThrow("not inside the test's temp dir");
      expect(() => fs.rmSync(other, { recursive: true })).toThrow("not inside the test's temp dir");
      expect(() => fs.rmSync(tmp, { recursive: true })).toThrow("not inside the test's temp dir");
      expect(readFileSync(file, "utf8")).toBe("keep");
      expect(fake.gone).toEqual([file, other, tmp]);
    } finally {
      fake.gone = [];
      fake.real.rmSync(other, { recursive: true, force: true });
    }
  });
});

describe("by the path alone: inside a folder, the slot, the prefix, npm's name for a leftover", () => {
  it("within: the folder itself and what is under it, never beside or above it", () => {
    const root = path.join(tmp, "world");
    expect(within(root, root)).toBe(true);
    expect(within(root, path.join(root, "a", "b"))).toBe(true);
    expect(within(root, tmp)).toBe(false);
    expect(within(root, path.join(tmp, "other"))).toBe(false);
    // A name that only begins the same is another folder.
    expect(within(root, path.join(tmp, "world-2", "a"))).toBe(false);
    expect(within(root, path.join(root, "..", "world", "a"))).toBe(true);
    expect(within(root, path.join(root, "a", "..", "..", "other"))).toBe(false);
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

  it("slotOf: a prefix's lib/node_modules is global, an npx cache entry is npx, any other place is neither", () => {
    expect(slotOf(slot(path.join(tmp, "prefix")), posix())).toBe("global");
    expect(slotOf(slot(path.join(tmp, "prefix"), ".sessionpipe-AbCd1234"), posix())).toBe("global");
    expect(slotOf(npx(), posix())).toBe("npx");
    // A project's own dependency, a folder not in a node_modules, a node_modules not in a lib.
    expect(slotOf(path.join(tmp, "proj", "node_modules", "sessionpipe"), posix())).toBeNull();
    expect(slotOf(path.join(tmp, "prefix", "lib", "sessionpipe"), posix())).toBeNull();
    expect(slotOf(path.join(tmp, "prefix", "library", "node_modules", "sessionpipe"), posix())).toBeNull();
    // Off Windows the prefixes that were looked in say nothing.
    expect(
      slotOf(path.join(tmp, "proj", "node_modules", "sessionpipe"), { ...posix(), prefixes: [path.join(tmp, "proj")] }),
    ).toBeNull();
  });

  it("slotOf on Windows: global only in a prefix that was looked in as one, whatever its case", () => {
    const prefix = path.join(tmp, "AppData", "npm");
    const dir = path.join(prefix, "node_modules", "sessionpipe");
    expect(slotOf(dir, win([prefix]))).toBe("global");
    expect(slotOf(dir, win([path.join(tmp, "nodejs"), prefix.toUpperCase()]))).toBe("global");
    // The same shape in a folder nobody named is any project's node_modules.
    expect(slotOf(dir, win([]))).toBeNull();
    expect(slotOf(dir, win([path.join(tmp, "nodejs")]))).toBeNull();
    // `<prefix>\lib\node_modules` is no slot there.
    expect(slotOf(slot(prefix), win([prefix]))).toBeNull();
    expect(slotOf(npx(), win([]))).toBe("npx");
  });

  it("prefixOfSlot: three folders up, two on Windows", () => {
    const prefix = path.join(tmp, "prefix");
    expect(prefixOfSlot(slot(prefix), "linux")).toBe(prefix);
    expect(prefixOfSlot(slot(prefix), "darwin")).toBe(prefix);
    expect(prefixOfSlot(path.join(prefix, "node_modules", "sessionpipe"), "win32")).toBe(prefix);
  });
});

describe("binTarget: the folder a bin link leads to, read from the link and never followed", () => {
  it.runIf(links)("npm's own link, relative or absolute, names its package folder", () => {
    const prefix = path.join(tmp, "prefix");
    unpack(slot(prefix));
    expect(binTarget(link(prefix), "linux")).toBe(slot(prefix));
    const other = path.join(tmp, "other");
    expect(binTarget(link(other, path.join(slot(prefix), "dist", "cli.js")), "darwin")).toBe(slot(prefix));
  });

  it.runIf(links)("a link to a folder that is gone still names it", () => {
    const prefix = path.join(tmp, "prefix");
    expect(binTarget(link(prefix), "linux")).toBe(slot(prefix));
    expect(existsSync(slot(prefix))).toBe(false);
  });

  it.runIf(links)("a relative link leads from the folder it is really in, by whatever name that was reached", () => {
    // ~/bin is another name for ~/.local/bin: the link's `..` is ~/.local, not ~.
    const home = path.join(tmp, "home");
    const dir = unpack(slot(path.join(home, ".local")));
    const file = link(path.join(home, ".local"));
    symlinkSync(path.join(home, ".local", "bin"), path.join(home, "bin"));
    expect(binTarget(file, "linux")).toBe(dir);
    expect(binTarget(path.join(home, "bin", "sessionpipe"), "linux")).toBe(dir);
    // A bin folder that can't be found by its real name names nothing.
    fake.fails = (call, p) => call === "realpathSync" && p === path.join(home, "bin");
    expect(binTarget(path.join(home, "bin", "sessionpipe"), "linux")).toBeNull();
  });

  it.runIf(links)("a link of another name, or one that leads anywhere else, is nobody's", () => {
    const prefix = path.join(tmp, "prefix");
    unpack(slot(prefix));
    // The right text under another name.
    expect(binTarget(link(prefix, INTO, "sp"), "linux")).toBeNull();
    // The right name, leading to another package, to another file of this one, to the
    // folder itself, to a program.
    const to = (text: string) => binTarget(link(path.join(tmp, `p${text.length}`), text), "linux");
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
    expect(binTarget(path.join(bin, "sessionpipe"), "linux")).toBeNull();
    expect(binTarget(path.join(bin, "nothing"), "linux")).toBeNull();
    expect(binTarget(path.join(bin, "nothing"), "win32")).toBeNull();
    // A folder of the name, on either.
    mkdirSync(path.join(tmp, "dir", "sessionpipe"), { recursive: true });
    expect(binTarget(path.join(tmp, "dir", "sessionpipe"), "linux")).toBeNull();
    expect(binTarget(path.join(tmp, "dir", "sessionpipe"), "win32")).toBeNull();
  });

  it("Windows: each of npm's three shims in a prefix names that prefix's package folder", () => {
    const prefix = path.join(tmp, "npm");
    for (const file of shims(prefix, GLOBAL_SHIM))
      expect(binTarget(file, "win32"), file).toBe(path.join(prefix, "node_modules", "sessionpipe"));
    // The name is what it is in any case.
    const upper = path.join(tmp, "upper");
    mkdirSync(upper);
    writeFileSync(path.join(upper, "SessionPipe.CMD"), shim("sessionpipe.cmd", GLOBAL_SHIM));
    expect(binTarget(path.join(upper, "SessionPipe.CMD"), "win32")).toBe(
      path.join(upper, "node_modules", "sessionpipe"),
    );
  });

  it("Windows: a shim in a `.bin` names the package beside that folder, as npm writes it there", () => {
    const modules = path.dirname(npx());
    for (const file of shims(path.join(modules, ".bin"), BIN_SHIM)) expect(binTarget(file, "win32"), file).toBe(npx());
  });

  it("Windows: a file of another name, or one that doesn't name sessionpipe's cli.js, is nobody's", () => {
    const prefix = path.join(tmp, "npm");
    mkdirSync(prefix);
    const file = (name: string, text: string): string => {
      writeFileSync(path.join(prefix, name), text);
      return path.join(prefix, name);
    };
    expect(binTarget(file("other.cmd", shim("other.cmd", GLOBAL_SHIM)), "win32")).toBeNull();
    expect(binTarget(file("sessionpipe.bat", shim("sessionpipe.cmd", GLOBAL_SHIM)), "win32")).toBeNull();
    expect(binTarget(file("sessionpipe.cmd", "@ECHO off\r\necho hello\r\n"), "win32")).toBeNull();
    expect(
      binTarget(file("sessionpipe.ps1", shim("sessionpipe.ps1", "node_modules/other/dist/cli.js")), "win32"),
    ).toBeNull();
    // A shim in a prefix names the package under it, not one beside it; in a `.bin` the
    // other way round.
    expect(binTarget(file("sessionpipe", shim("sessionpipe", BIN_SHIM)), "win32")).toBeNull();
    const [beside] = shims(path.join(tmp, "x", "node_modules", ".bin"), GLOBAL_SHIM, ["sessionpipe.cmd"]);
    expect(binTarget(beside as string, "win32")).toBeNull();
  });

  it.runIf(links)("each platform knows only its own: a link is no shim, and a shim is no link", () => {
    const prefix = path.join(tmp, "prefix");
    expect(binTarget(link(prefix), "win32")).toBeNull();
    const [file] = shims(path.join(tmp, "npm"), GLOBAL_SHIM, ["sessionpipe"]);
    expect(binTarget(file as string, "linux")).toBeNull();
  });
});

describe("binsOf: the bin links that are a package folder's own", () => {
  it.runIf(links)("a global copy: the link in its prefix's bin, when it leads to this folder", () => {
    const prefix = path.join(tmp, "prefix");
    const dir = unpack(slot(prefix));
    expect(binsOf(dir, posix())).toEqual([]);
    const file = link(prefix);
    link(prefix, path.join("..", "lib", "node_modules", "other", "dist", "cli.js"), "other");
    expect(binsOf(dir, posix())).toEqual([file]);
    // The folder moved aside in the same slot has no link: the one there is the copy's.
    expect(binsOf(slot(prefix, ".sessionpipe-AbCd1234"), posix())).toEqual([]);
  });

  it.runIf(links)("a link in its prefix that leads to another prefix's copy is not its own", () => {
    const a = path.join(tmp, "a");
    const b = path.join(tmp, "b");
    unpack(slot(a));
    unpack(slot(b));
    link(a, path.join(slot(b), "dist", "cli.js"));
    expect(binsOf(slot(a), posix())).toEqual([]);
    expect(binsOf(slot(b), posix())).toEqual([]);
  });

  it.runIf(links)("a bin folder that is a link to another prefix's: the link in it is that prefix's copy's", () => {
    const a = path.join(tmp, "a");
    const b = path.join(tmp, "b");
    unpack(slot(a));
    unpack(slot(b));
    const own = link(b);
    symlinkSync(path.join(b, "bin"), path.join(a, "bin"));
    // <a>/bin/sessionpipe is the very link in <b>/bin, and from there `..` is <b>.
    expect(binTarget(path.join(a, "bin", "sessionpipe"), "linux")).toBe(slot(b));
    expect(binsOf(slot(a), posix())).toEqual([]);
    expect(binsOf(slot(b), posix())).toEqual([own]);
  });

  it.runIf(links)("an npx cache entry: the link in the `.bin` beside it", () => {
    const dir = unpack(npx());
    const bin = path.join(path.dirname(dir), ".bin");
    mkdirSync(bin);
    symlinkSync(path.join("..", "sessionpipe", "dist", "cli.js"), path.join(bin, "sessionpipe"));
    symlinkSync(path.join("..", "other", "cli.js"), path.join(bin, "other"));
    expect(binsOf(dir, posix())).toEqual([path.join(bin, "sessionpipe")]);
  });

  it.runIf(links)("a folder in no slot has none, whatever lies beside it", () => {
    const dir = unpack(path.join(tmp, "proj", "node_modules", "sessionpipe"));
    const bin = path.join(path.dirname(dir), ".bin");
    mkdirSync(bin);
    symlinkSync(path.join("..", "sessionpipe", "dist", "cli.js"), path.join(bin, "sessionpipe"));
    expect(binsOf(dir, posix())).toEqual([]);
  });

  it("Windows: the shims in the prefix that name it, and only those", () => {
    const prefix = path.join(tmp, "npm");
    const dir = unpack(path.join(prefix, "node_modules", "sessionpipe"));
    expect(binsOf(dir, win([prefix]))).toEqual([]);
    const all = shims(prefix, GLOBAL_SHIM);
    writeFileSync(path.join(prefix, "other.cmd"), shim("other.cmd", "node_modules/other/cli.js"));
    expect(binsOf(dir, win([prefix]))).toEqual(all);
    expect(binsOf(dir, win([prefix.toUpperCase()]))).toEqual(all);
    // One that someone wrote over is theirs.
    writeFileSync(path.join(prefix, "sessionpipe.cmd"), "@ECHO off\r\necho mine\r\n");
    expect(binsOf(dir, win([prefix]))).toEqual([
      path.join(prefix, "sessionpipe"),
      path.join(prefix, "sessionpipe.ps1"),
    ]);
    // In a prefix that was not looked in, the folder is in no slot.
    expect(binsOf(dir, win([]))).toEqual([]);
  });

  it("Windows: an npx cache entry's shims are in the `.bin` beside it", () => {
    const dir = unpack(npx());
    const all = shims(path.join(path.dirname(dir), ".bin"), BIN_SHIM);
    expect(binsOf(dir, win([]))).toEqual(all);
  });
});

describe("prove: what is ours", () => {
  it("a published copy in a global slot", () => {
    const dir = unpack(slot(path.join(tmp, "prefix")));
    expect(prove(dir, posix())).toEqual({ is: "folder", slot: "global", aside: false });
    expect(prove(dir, { ...posix(), platform: "darwin" })).toEqual({ is: "folder", slot: "global", aside: false });
  });

  it("what this very package publishes: its own files and package.json, and no dependency unpacked beside them", () => {
    // The proof knows a published sessionpipe by what it holds. A release that published
    // one more entry, or gained a dependency (npm unpacks those into a node_modules folder
    // inside the package), would be left alone by every reinstall after it: this fails first.
    const own = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
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
    expect([...published].sort()).toEqual(["LICENSE", "NOTICE", "README.md", "dist", "package.json"]);
    const dir = slot(path.join(tmp, "prefix"));
    mkdirSync(dir, { recursive: true });
    for (const f of published) writeFileSync(path.join(dir, f), f === "package.json" ? PACKAGE : f);
    expect(prove(dir, posix())).toEqual({ is: "folder", slot: "global", aside: false });
  });

  it("a published copy in an npx cache entry", () => {
    expect(prove(unpack(npx()), posix())).toEqual({ is: "folder", slot: "npx", aside: false });
  });

  it("a folder npm (or this command) moved aside in a global slot", () => {
    const dir = unpack(slot(path.join(tmp, "prefix"), ".sessionpipe-AbCd1234"));
    expect(prove(dir, posix())).toEqual({ is: "folder", slot: "global", aside: true });
  });

  it("a copy that was cut off half-way: no package.json, one that is cut short, only a dist, nothing at all", () => {
    const prefix = (n: number) => path.join(tmp, `prefix${n}`);
    const folder = { is: "folder", slot: "global", aside: false };
    expect(prove(unpack(slot(prefix(1)), null), posix())).toEqual(folder);
    expect(prove(unpack(slot(prefix(2)), '{"name":"sessionp'), posix())).toEqual(folder);
    mkdirSync(path.join(slot(prefix(3)), "dist"), { recursive: true });
    expect(prove(slot(prefix(3)), posix())).toEqual(folder);
    mkdirSync(slot(prefix(4)), { recursive: true });
    expect(prove(slot(prefix(4)), posix())).toEqual(folder);
    // A package.json that is a folder can't be read either, and is still a published name.
    mkdirSync(path.join(slot(prefix(5)), "package.json"), { recursive: true });
    expect(prove(slot(prefix(5)), posix())).toEqual(folder);
  });

  it("where reach is one folder, what lies inside it", () => {
    const world = path.join(tmp, "world");
    const dir = unpack(slot(path.join(world, ".local")));
    expect(prove(dir, posix(world))).toEqual({ is: "folder", slot: "global", aside: false });
    expect(prove(dir, posix(tmp))).toEqual({ is: "folder", slot: "global", aside: false });
  });

  it.runIf(links)("a bin link whose folder is gone, in a prefix's bin or in an npx entry's `.bin`", () => {
    expect(prove(link(path.join(tmp, "prefix")), posix())).toEqual({ is: "link" });
    const bin = path.join(path.dirname(npx()), ".bin");
    mkdirSync(bin, { recursive: true });
    symlinkSync(path.join("..", "sessionpipe", "dist", "cli.js"), path.join(bin, "sessionpipe"));
    expect(prove(path.join(bin, "sessionpipe"), posix())).toEqual({ is: "link" });
    expect(prove(path.join(bin, "sessionpipe"), posix(tmp))).toEqual({ is: "link" });
  });

  it("Windows: a copy in a prefix that was looked in, and a shim whose folder is gone", () => {
    const prefix = path.join(tmp, "npm");
    const dir = unpack(path.join(prefix, "node_modules", "sessionpipe"));
    expect(prove(dir, win([prefix]))).toEqual({ is: "folder", slot: "global", aside: false });
    expect(prove(dir, win([prefix.toUpperCase()]))).toEqual({ is: "folder", slot: "global", aside: false });
    const aside = unpack(path.join(prefix, "node_modules", ".sessionpipe-AbCd1234"));
    expect(prove(aside, win([prefix]))).toEqual({ is: "folder", slot: "global", aside: true });
    expect(prove(unpack(npx()), win([]))).toEqual({ is: "folder", slot: "npx", aside: false });
    const bare = path.join(tmp, "nodejs");
    for (const file of shims(bare, GLOBAL_SHIM)) expect(prove(file, win([bare])), file).toEqual({ is: "link" });
  });
});

describe("prove and remove: what is not ours, each with its reason, and nothing removed", () => {
  const OUTSIDE = "it is outside the folders this sessionpipe keeps its own files in";
  const NO_SLOT = "it is not a global install or an npx cache entry (a project's own dependency?)";

  it("anything where this sessionpipe may call nothing its own, or outside the one folder it may", async () => {
    const dir = unpack(slot(path.join(tmp, "prefix")));
    await refused(dir, posix(null), OUTSIDE);
    await refused(dir, posix(path.join(tmp, "world")), OUTSIDE);
    // A folder whose name only begins like the reach is outside it.
    await refused(dir, posix(path.join(tmp, "pre")), OUTSIDE);
    // The proof stops there: what is not in reach is not even looked at.
    await refused(path.join(tmp, "nothing"), posix(null), OUTSIDE);
  });

  it.runIf(links)("a link outside the reach, though the folder it leads to is gone", async () => {
    await refused(link(path.join(tmp, "prefix")), posix(path.join(tmp, "world")), OUTSIDE);
    await refused(link(path.join(tmp, "prefix2")), posix(null), OUTSIDE);
  });

  it("nothing there", async () => {
    mkdirSync(path.join(tmp, "prefix", "lib", "node_modules"), { recursive: true });
    await refused(slot(path.join(tmp, "prefix")), posix(), "nothing is there");
    await refused(path.join(tmp, "prefix", "bin", "sessionpipe"), posix(), "nothing is there");
  });

  it("a file that only has the name", async () => {
    const bin = path.join(tmp, "prefix", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, "sessionpipe"), "#!/bin/sh\nexec node ~/src/sessionpipe/packages/cli/dist/cli.js\n");
    await refused(path.join(bin, "sessionpipe"), posix(), "it is a file npm didn't put there");
    // A file where a package folder would be.
    mkdirSync(path.join(tmp, "prefix", "lib", "node_modules"), { recursive: true });
    writeFileSync(slot(path.join(tmp, "prefix")), "not a folder");
    await refused(slot(path.join(tmp, "prefix")), posix(), "it is a file npm didn't put there");
  });

  it.runIf(links)("a link that leads somewhere that is no sessionpipe install", async () => {
    const why = "it is a link that doesn't lead into a sessionpipe install";
    const checkout = unpack(path.join(tmp, "src", "sessionpipe", "packages", "cli"));
    await refused(link(path.join(tmp, "a"), path.join(checkout, "dist", "cli.js")), posix(), why);
    await refused(link(path.join(tmp, "b"), "/usr/bin/true"), posix(), why);
    await refused(link(path.join(tmp, "c"), INTO, "sp"), posix(), why);
  });

  it.runIf(links)(
    "a folder someone linked (`npm link`): the link is not followed, and what it leads to stays",
    async () => {
      const checkout = unpack(path.join(tmp, "src", "sessionpipe"));
      const prefix = path.join(tmp, "prefix");
      mkdirSync(path.dirname(slot(prefix)), { recursive: true });
      symlinkSync(checkout, slot(prefix));
      await refused(slot(prefix), posix(), "it is a link that doesn't lead into a sessionpipe install");
      expect(lstatSync(slot(prefix)).isSymbolicLink()).toBe(true);
      expect(readdirSync(checkout).sort()).toEqual(["LICENSE", "NOTICE", "README.md", "dist", "package.json"]);
    },
  );

  it.runIf(links)("a bin link into a project's own dependency, though that is gone", async () => {
    const proj = path.join(tmp, "proj");
    const why = "it leads to a sessionpipe that is not a global install or an npx cache entry";
    await refused(link(proj, path.join(proj, "node_modules", "sessionpipe", "dist", "cli.js")), posix(), why);
    unpack(path.join(proj, "node_modules", "sessionpipe"));
    await refused(path.join(proj, "bin", "sessionpipe"), posix(), why);
  });

  it.runIf(links)("the link of a copy that is there: it goes with its folder, never by itself", async () => {
    const prefix = path.join(tmp, "prefix");
    unpack(slot(prefix));
    await refused(link(prefix), posix(), "it is the link of a copy that is there");
    // Also where what is there is no copy of ours: a checkout in the slot, a file.
    const b = path.join(tmp, "b");
    mkdirSync(path.join(unpack(slot(b)), "src"));
    await refused(link(b), posix(), "it is the link of a copy that is there");
    const c = path.join(tmp, "c");
    mkdirSync(path.dirname(slot(c)), { recursive: true });
    writeFileSync(slot(c), "a file");
    await refused(link(c), posix(), "it is the link of a copy that is there");
  });

  it.runIf(links)("the link of a copy that is there, asked for by another name of the folder it is in", async () => {
    // Read from ~/bin its `..` would be ~, where no copy is: it would pass for a link
    // whose folder is gone, and a command that works would be taken away.
    const home = path.join(tmp, "home");
    const dir = unpack(slot(path.join(home, ".local")));
    const file = link(path.join(home, ".local"));
    symlinkSync(path.join(home, ".local", "bin"), path.join(home, "bin"));
    await refused(path.join(home, "bin", "sessionpipe"), posix(), "it is the link of a copy that is there");
    await refused(path.join(home, "bin", "sessionpipe"), posix(home), "it is the link of a copy that is there");
    expect(binTarget(file, "linux")).toBe(dir);
    expect(binsOf(dir, posix())).toEqual([file]);
  });

  it.runIf(links)(
    "what is really outside the reach, by a name inside it: a folder or a link in a linked folder",
    async () => {
      const world = path.join(tmp, "world");
      const real = path.join(tmp, "real");
      const theirs = unpack(slot(real));
      link(real);
      // The world's own ~/.local/lib/node_modules is a link to this computer's.
      mkdirSync(path.join(world, ".local", "lib"), { recursive: true });
      symlinkSync(path.dirname(theirs), path.join(world, ".local", "lib", "node_modules"));
      expect(lstatSync(slot(path.join(world, ".local"))).isDirectory()).toBe(true);
      await refused(slot(path.join(world, ".local")), posix(world), OUTSIDE);
      // A whole prefix that is one (a version manager's folder shared into the world).
      symlinkSync(real, path.join(world, "prefix"));
      await refused(slot(path.join(world, "prefix")), posix(world), OUTSIDE);
      // A link that leads nowhere, in a bin folder that is really outside.
      const empty = path.join(tmp, "empty");
      const dangling = link(empty);
      symlinkSync(path.join(empty, "bin"), path.join(world, "bin"));
      await refused(path.join(world, "bin", "sessionpipe"), posix(world), OUTSIDE);
      expect(lstatSync(dangling).isSymbolicLink()).toBe(true);
      expect(readdirSync(theirs).sort()).toEqual(["LICENSE", "NOTICE", "README.md", "dist", "package.json"]);
      // With all of it in reach they are what they are.
      expect(prove(slot(path.join(world, "prefix")), posix(tmp))).toEqual({
        is: "folder",
        slot: "global",
        aside: false,
      });
      expect(prove(path.join(world, "bin", "sessionpipe"), posix(tmp))).toEqual({ is: "link" });
      expect(prove(path.join(world, "bin", "sessionpipe"), posix())).toEqual({ is: "link" });
    },
  );

  it("a folder of another name", async () => {
    const why = "it is not a folder named node_modules/sessionpipe";
    const prefix = path.join(tmp, "prefix");
    await refused(unpack(slot(prefix, "sessionpipe-receiver")), posix(), why);
    await refused(unpack(slot(prefix, ".sessionpipe-short")), posix(), why);
    await refused(path.dirname(slot(prefix)), posix(), why);
    await refused(prefix, posix(), why);
  });

  it("a project's own dependency, and any folder of the name that is in no slot", async () => {
    await refused(unpack(path.join(tmp, "proj", "node_modules", "sessionpipe")), posix(), NO_SLOT);
    await refused(unpack(path.join(tmp, "src", "sessionpipe")), posix(), NO_SLOT);
    await refused(unpack(path.join(tmp, "prefix", "lib", "sessionpipe")), posix(), NO_SLOT);
    // A leftover's name counts only in a global slot: npx leaves none.
    await refused(unpack(path.join(path.dirname(npx()), ".sessionpipe-AbCd1234")), posix(), NO_SLOT);
    await refused(unpack(path.join(tmp, "proj", "node_modules", ".sessionpipe-AbCd1234")), posix(), NO_SLOT);
  });

  it.runIf(links)("a node_modules that is a link to somewhere else", async () => {
    const prefix = path.join(tmp, "prefix");
    const elsewhere = path.join(tmp, "elsewhere", "modules");
    unpack(path.join(elsewhere, "sessionpipe"));
    mkdirSync(path.join(prefix, "lib"), { recursive: true });
    symlinkSync(elsewhere, path.dirname(slot(prefix)));
    await refused(slot(prefix), posix(), "the node_modules folder it is in is a link to somewhere else");
    expect(existsSync(path.join(elsewhere, "sessionpipe", "dist", "cli.js"))).toBe(true);
  });

  it.runIf(links)(
    "a lib or a node_modules that is a link to a project: its dependency is not a global install",
    async () => {
      const why = "the node_modules folder it is in is a link to somewhere else";
      const proj = path.join(tmp, "proj");
      const dep = unpack(path.join(proj, "node_modules", "sessionpipe"));
      // The link has the very name a slot has: <prefix>/lib/node_modules -> <proj>/node_modules.
      const a = path.join(tmp, "a");
      mkdirSync(path.join(a, "lib"), { recursive: true });
      symlinkSync(path.join(proj, "node_modules"), path.dirname(slot(a)));
      expect(lstatSync(slot(a)).isDirectory()).toBe(true);
      await refused(slot(a), posix(), why);
      // One folder further up: <prefix>/lib -> <proj>.
      const b = path.join(tmp, "b");
      mkdirSync(b);
      symlinkSync(proj, path.join(b, "lib"));
      await refused(slot(b), posix(), why);
      // An npx cache entry whose node_modules is a link to it.
      const entry = path.dirname(path.dirname(npx()));
      mkdirSync(entry, { recursive: true });
      symlinkSync(path.join(proj, "node_modules"), path.join(entry, "node_modules"));
      await refused(npx(), posix(), why);
      expect(readdirSync(dep).sort()).toEqual(["LICENSE", "NOTICE", "README.md", "dist", "package.json"]);
    },
  );

  it.runIf(links)("a slot reached through a link to another slot of its kind is still one", () => {
    // A prefix whose lib/node_modules is kept on another disk, under the same names.
    const real = unpack(slot(path.join(tmp, "disk", "prefix")));
    const prefix = path.join(tmp, "prefix");
    mkdirSync(path.join(prefix, "lib"), { recursive: true });
    symlinkSync(path.dirname(real), path.dirname(slot(prefix)));
    expect(prove(slot(prefix), posix())).toEqual({ is: "folder", slot: "global", aside: false });
  });

  it.runIf(links)("a folder someone linked, asked for with a slash after its name", async () => {
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
    await expect(remove(asked, posix())).rejects.toThrow(`${slot(prefix)} was left alone: ${why}`);
    expect(fake.gone).toEqual([]);
    expect(tree()).toEqual(before);
    expect(readdirSync(theirs).sort()).toEqual(["LICENSE", "NOTICE", "README.md", "dist", "package.json"]);
  });

  it("a folder the system won't let it look in", async () => {
    const dir = unpack(slot(path.join(tmp, "prefix")));
    fake.fails = (call, p) => call === "realpathSync" && p === path.dirname(dir);
    await refused(dir, posix(), "the folder it is in can't be read");
    fake.fails = (call, p) => call === "readdirSync" && p === dir;
    await refused(dir, posix(), "it can't be read");
    fake.fails = null;
    expect(prove(dir, posix())).toEqual({ is: "folder", slot: "global", aside: false });
  });

  it("a checkout or a build: anything a published sessionpipe doesn't have at its top", async () => {
    const holds = (n: string) => `it holds ${n}, which no published sessionpipe has (a checkout or a build?)`;
    let n = 0;
    for (const extra of ["src", ".git", "node_modules", "tsconfig.json", "test"]) {
      const dir = unpack(slot(path.join(tmp, `prefix${n++}`)));
      if (extra.includes(".json")) writeFileSync(path.join(dir, extra), "{}");
      else mkdirSync(path.join(dir, extra));
      await refused(dir, posix(), holds(extra));
    }
    // In an npx cache entry and under a leftover's name alike.
    const cached = unpack(npx());
    writeFileSync(path.join(cached, "notes.txt"), "mine");
    await refused(cached, posix(), holds("notes.txt"));
    const aside = unpack(slot(path.join(tmp, "prefix"), ".sessionpipe-AbCd1234"));
    mkdirSync(path.join(aside, "src"));
    await refused(aside, posix(), holds("src"));
  });

  it("a package.json that says it is something else", async () => {
    const says = (name: string) => `its package.json says it is ${name}, not sessionpipe`;
    const at = (n: number, json: string) => unpack(slot(path.join(tmp, `prefix${n}`)), json);
    await refused(at(1, JSON.stringify({ name: "sessionpipe-receiver" })), posix(), says('"sessionpipe-receiver"'));
    await refused(at(2, JSON.stringify({ name: "@me/sessionpipe" })), posix(), says('"@me/sessionpipe"'));
    await refused(at(3, JSON.stringify({ version: "1.0.0" })), posix(), says("undefined"));
    await refused(at(4, JSON.stringify({ name: 7 })), posix(), says("7"));
    await refused(unpack(npx(), JSON.stringify({ name: "other" })), posix(), says('"other"'));
  });

  it("Windows: the same shape in a prefix nobody looked in is any project's node_modules", async () => {
    const prefix = path.join(tmp, "proj");
    const dir = unpack(path.join(prefix, "node_modules", "sessionpipe"));
    await refused(dir, win([]), NO_SLOT);
    await refused(dir, win([path.join(tmp, "npm")]), NO_SLOT);
    await refused(dir, win([prefix], null), OUTSIDE);
    await refused(dir, win([prefix], path.join(tmp, "world")), OUTSIDE);
  });

  it("Windows: a file of the name that npm didn't write, a shim of a copy that is there, one into no slot", async () => {
    const prefix = path.join(tmp, "npm");
    mkdirSync(prefix);
    writeFileSync(path.join(prefix, "sessionpipe.cmd"), "@ECHO off\r\necho mine\r\n");
    await refused(path.join(prefix, "sessionpipe.cmd"), win([prefix]), "it is a file npm didn't put there");
    writeFileSync(path.join(prefix, "sessionpipe.exe"), shim("sessionpipe.cmd", GLOBAL_SHIM));
    await refused(path.join(prefix, "sessionpipe.exe"), win([prefix]), "it is a file npm didn't put there");

    const there = path.join(tmp, "nodejs");
    unpack(path.join(there, "node_modules", "sessionpipe"));
    for (const file of shims(there, GLOBAL_SHIM))
      await refused(file, win([there]), "it is the link of a copy that is there");

    const [stray] = shims(path.join(tmp, "proj"), GLOBAL_SHIM, ["sessionpipe.cmd"]);
    await refused(
      stray as string,
      win([there]),
      "it leads to a sessionpipe that is not a global install or an npx cache entry",
    );
  });
});

describe("remove: a folder that is ours, with exactly its own bin link", () => {
  it("the folder, and nothing beside it", async () => {
    const prefix = path.join(tmp, "prefix");
    const dir = unpack(slot(prefix));
    const other = unpack(slot(prefix, "sessionpipe-receiver"), JSON.stringify({ name: "sessionpipe-receiver" }));
    const before = tree();
    expect(await take(dir, posix())).toEqual([dir]);
    expect(fake.gone).toEqual([dir]);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(path.join(other, "dist", "cli.js"))).toBe(true);
    // What is left is what was there, less the one folder.
    const rel = path.relative(tmp, dir);
    expect(tree()).toEqual(before.filter((e) => !e.startsWith(rel + path.sep)));
  });

  it.runIf(links)("its own link goes with it; another package and that package's link stay", async () => {
    const prefix = path.join(tmp, "prefix");
    const dir = unpack(slot(prefix));
    const bin = link(prefix);
    unpack(slot(prefix, "other"), JSON.stringify({ name: "other" }));
    const sibling = link(prefix, path.join("..", "lib", "node_modules", "other", "dist", "cli.js"), "other");
    writeFileSync(path.join(prefix, "bin", "node"), "node");
    const before = tree();
    expect(await take(dir, posix())).toEqual([dir, bin]);
    expect(fake.gone).toEqual([dir, bin]);
    const relDir = path.relative(tmp, dir);
    const relBin = path.relative(tmp, bin);
    expect(tree()).toEqual(before.filter((e) => !e.startsWith(relDir + path.sep) && !e.startsWith(`${relBin} -> `)));
    expect(lstatSync(sibling).isSymbolicLink()).toBe(true);
    expect(readFileSync(path.join(slot(prefix, "other"), "package.json"), "utf8")).toBe('{"name":"other"}');
  });

  it.runIf(links)(
    "a link in its prefix that leads to another copy of sessionpipe stays, and so does that copy",
    async () => {
      const a = path.join(tmp, "a");
      const b = path.join(tmp, "b");
      const dir = unpack(slot(a));
      const theirs = unpack(slot(b));
      const bin = link(a, path.join(theirs, "dist", "cli.js"));
      const own = link(b);
      expect(await take(dir, posix())).toEqual([dir]);
      expect(fake.gone).toEqual([dir]);
      expect(lstatSync(bin).isSymbolicLink()).toBe(true);
      expect(lstatSync(own).isSymbolicLink()).toBe(true);
      expect(prove(theirs, posix())).toEqual({ is: "folder", slot: "global", aside: false });
    },
  );

  it.runIf(links)("nothing is removed through a link: what a link inside the folder leads to stays", async () => {
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
    expect(await take(dir, posix())).toEqual([dir]);
    expect(fake.gone).toEqual([dir]);
    expect(existsSync(dir)).toBe(false);
    expect(readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("keep");
    expect(readFileSync(path.join(outside, "dir", "deep.txt"), "utf8")).toBe("deep");

    // A dist that is itself a link to a folder somewhere else.
    const b = path.join(tmp, "b");
    mkdirSync(slot(b), { recursive: true });
    writeFileSync(path.join(slot(b), "package.json"), PACKAGE);
    symlinkSync(path.join(outside, "dir"), path.join(slot(b), "dist"));
    fake.gone = [];
    expect(await take(slot(b), posix())).toEqual([slot(b)]);
    expect(fake.gone).toEqual([slot(b)]);
    expect(existsSync(slot(b))).toBe(false);
    expect(readFileSync(path.join(outside, "dir", "deep.txt"), "utf8")).toBe("deep");
  });

  it.runIf(links)("an npx cache entry: the folder and the link in the `.bin` beside it; npm is not asked", async () => {
    const dir = unpack(npx());
    const modules = path.dirname(dir);
    mkdirSync(path.join(modules, ".bin"));
    const bin = path.join(modules, ".bin", "sessionpipe");
    symlinkSync(path.join("..", "sessionpipe", "dist", "cli.js"), bin);
    mkdirSync(path.join(modules, "zod"));
    writeFileSync(path.join(modules, "zod", "index.js"), "zod");
    const npm = vi.fn(async () => {});
    expect(await take(dir, { ...posix(), npm })).toEqual([dir, bin]);
    expect(npm).not.toHaveBeenCalled();
    expect(fake.gone).toEqual([dir, bin]);
    expect(readdirSync(modules).sort()).toEqual([".bin", "zod"]);
    expect(readdirSync(path.join(modules, ".bin"))).toEqual([]);
  });

  it.runIf(links)(
    "a folder moved aside: it alone; the copy beside it and that copy's link stay; npm is not asked",
    async () => {
      const prefix = path.join(tmp, "prefix");
      const fresh = unpack(slot(prefix));
      const bin = link(prefix);
      const aside = unpack(slot(prefix, ".sessionpipe-AbCd1234"));
      const npm = vi.fn(async () => {});
      expect(await take(aside, { ...posix(), npm })).toEqual([aside]);
      expect(npm).not.toHaveBeenCalled();
      expect(fake.gone).toEqual([aside]);
      expect(existsSync(aside)).toBe(false);
      expect(prove(fresh, posix())).toEqual({ is: "folder", slot: "global", aside: false });
      expect(binTarget(bin, "linux")).toBe(fresh);
    },
  );

  it.runIf(links)("a bin link whose folder is gone is removed by itself", async () => {
    const prefix = path.join(tmp, "prefix");
    const bin = link(prefix);
    writeFileSync(path.join(prefix, "bin", "node"), "node");
    expect(await take(bin, posix(tmp))).toEqual([bin]);
    expect(fake.gone).toEqual([bin]);
    expect(readdirSync(path.join(prefix, "bin"))).toEqual(["node"]);
  });

  it("where reach is one folder, a copy inside it goes", async () => {
    const world = path.join(tmp, "world");
    const dir = unpack(slot(path.join(world, ".local")));
    const real = unpack(slot(path.join(tmp, "real")));
    expect(await take(dir, posix(world))).toEqual([dir]);
    expect(fake.gone).toEqual([dir]);
    expect(existsSync(path.join(real, "dist", "cli.js"))).toBe(true);
  });

  it.runIf(links)("a copy in reach whose link lies outside it: the folder goes, the link stays", async () => {
    const prefix = path.join(tmp, "prefix");
    const dir = unpack(slot(prefix));
    const bin = link(prefix);
    // The reach is the prefix's lib: the copy is inside it, <prefix>/bin is not.
    const o = posix(path.join(prefix, "lib"));
    expect(binsOf(dir, o)).toEqual([]);
    expect(binsOf(dir, posix(prefix))).toEqual([bin]);
    expect(await take(dir, o)).toEqual([dir]);
    expect(fake.gone).toEqual([dir]);
    expect(lstatSync(bin).isSymbolicLink()).toBe(true);
  });

  it.runIf(links)(
    "a link to it that is really outside the reach, in a bin folder that is a link out of it: the link stays",
    async () => {
      const world = path.join(tmp, "world");
      const prefix = path.join(world, ".local");
      const dir = unpack(slot(prefix));
      // The world's bin folder is another name for one outside it, and the link there
      // leads, by its full name, to the world's copy.
      const outside = path.join(tmp, "outside");
      const theirs = link(outside, path.join(dir, "dist", "cli.js"));
      symlinkSync(path.join(outside, "bin"), path.join(prefix, "bin"));
      const byName = path.join(prefix, "bin", "sessionpipe");
      expect(binTarget(byName, "linux")).toBe(dir);
      expect(binsOf(dir, posix(tmp))).toEqual([byName]);
      expect(binsOf(dir, posix(world))).toEqual([]);
      expect(await take(dir, posix(world))).toEqual([dir]);
      expect(fake.gone).toEqual([dir]);
      expect(lstatSync(theirs).isSymbolicLink()).toBe(true);
    },
  );

  it("the path is taken by its one spelling: a slash after it, or a way round, is the same folder", async () => {
    const a = unpack(slot(path.join(tmp, "a")));
    const round = [path.dirname(a), "x", "..", "sessionpipe"].join(path.sep);
    expect(prove(a + path.sep, posix())).toEqual({ is: "folder", slot: "global", aside: false });
    expect(prove(round, posix())).toEqual({ is: "folder", slot: "global", aside: false });
    // What it answers, and what it hands to the deletion, is the path written out.
    expect(await remove(a + path.sep, posix(tmp))).toEqual([a]);
    expect(fake.gone).toEqual([a]);
    const b = unpack(slot(path.join(tmp, "b")));
    fake.gone = [];
    expect(await remove([path.dirname(b), "x", "..", "sessionpipe"].join(path.sep), posix(tmp))).toEqual([b]);
    expect(fake.gone).toEqual([b]);
    // And a way round that leaves the reach is outside it.
    const c = unpack(slot(path.join(tmp, "c")));
    const out = [tmp, "world", "..", "c", "lib", "node_modules", "sessionpipe"].join(path.sep);
    await expect(remove(out, posix(path.join(tmp, "world")))).rejects.toThrow(
      `${c} was left alone: it is outside the folders this sessionpipe keeps its own files in`,
    );
    expect(fake.gone).toEqual([b]);
  });

  it("Windows: the folder and the shims in its prefix that name it; one someone wrote stays", async () => {
    const prefix = path.join(tmp, "npm");
    const dir = unpack(path.join(prefix, "node_modules", "sessionpipe"));
    shims(prefix, GLOBAL_SHIM);
    writeFileSync(path.join(prefix, "sessionpipe.cmd"), "@ECHO off\r\necho mine\r\n");
    writeFileSync(path.join(prefix, "npm.cmd"), shim("npm.cmd", "node_modules/npm/bin/npm-cli.js"));
    const npm = vi.fn(async (_prefix: string) => {});
    const own = [path.join(prefix, "sessionpipe"), path.join(prefix, "sessionpipe.ps1")];
    expect(await take(dir, { ...win([prefix]), npm })).toEqual([dir, ...own]);
    // npm was asked first, by the prefix: two folders up there.
    expect(npm.mock.calls).toEqual([[prefix]]);
    expect(fake.gone).toEqual([dir, ...own]);
    expect(readdirSync(prefix).sort()).toEqual(["node_modules", "npm.cmd", "sessionpipe.cmd"]);
    expect(readFileSync(path.join(prefix, "sessionpipe.cmd"), "utf8")).toBe("@ECHO off\r\necho mine\r\n");
  });

  it("Windows: an npx cache entry goes with the shims in its `.bin`; a shim whose folder is gone goes by itself", async () => {
    const dir = unpack(npx());
    const all = shims(path.join(path.dirname(dir), ".bin"), BIN_SHIM);
    expect(await take(dir, win([]))).toEqual([dir, ...all]);
    expect(fake.gone).toEqual([dir, ...all]);
    expect(readdirSync(path.dirname(dir))).toEqual([".bin"]);

    const prefix = path.join(tmp, "nodejs");
    const [cmd] = shims(prefix, GLOBAL_SHIM, ["sessionpipe.cmd"]);
    fake.gone = [];
    expect(await take(cmd as string, win([prefix]))).toEqual([cmd]);
    expect(fake.gone).toEqual([cmd]);
    expect(readdirSync(prefix)).toEqual([]);
  });
});

describe.runIf(links)("remove: a global copy is handed to npm first", () => {
  let prefix: string;
  let dir: string;
  let bin: string;
  beforeEach(() => {
    prefix = path.join(tmp, "prefix");
    dir = unpack(slot(prefix));
    bin = link(prefix);
  });

  it("npm takes all of it: asked once, by the prefix, and nothing more is removed here", async () => {
    const npm = vi.fn(async (_prefix: string) => {
      fake.real.rmSync(dir, { recursive: true });
      fake.real.unlinkSync(bin);
    });
    expect(await take(dir, { ...posix(), npm })).toEqual([dir, bin]);
    expect(npm.mock.calls).toEqual([[prefix]]);
    expect(fake.gone).toEqual([]);
    expect(existsSync(dir)).toBe(false);
    expect(readdirSync(path.join(prefix, "bin"))).toEqual([]);
  });

  it("npm says it did and left everything: the folder and its link are taken here", async () => {
    const npm = vi.fn(async (_prefix: string) => "up to date in 100ms");
    expect(await take(dir, { ...posix(), npm })).toEqual([dir, bin]);
    expect(npm.mock.calls).toEqual([[prefix]]);
    expect(fake.gone).toEqual([dir, bin]);
    expect(existsSync(dir)).toBe(false);
    expect(readdirSync(path.join(prefix, "bin"))).toEqual([]);
  });

  it("npm takes the folder and leaves the link, or the link and leaves the folder: the rest is taken here", async () => {
    const folderOnly = vi.fn(async (_prefix: string) => fake.real.rmSync(dir, { recursive: true }));
    expect(await take(dir, { ...posix(), npm: folderOnly })).toEqual([dir, bin]);
    expect(fake.gone).toEqual([bin]);

    const b = path.join(tmp, "b");
    const dirB = unpack(slot(b));
    const binB = link(b);
    fake.gone = [];
    const linkOnly = vi.fn(async (_prefix: string) => fake.real.unlinkSync(binB));
    expect(await take(dirB, { ...posix(), npm: linkOnly })).toEqual([dirB, binB]);
    expect(linkOnly.mock.calls).toEqual([[b]]);
    expect(fake.gone).toEqual([dirB]);
    expect(existsSync(dirB)).toBe(false);
  });

  it("npm fails: it is removed here all the same", async () => {
    const npm = vi.fn(async (_prefix: string) => {
      throw new Error("npm error code EACCES");
    });
    expect(await take(dir, { ...posix(), npm })).toEqual([dir, bin]);
    expect(npm.mock.calls).toEqual([[prefix]]);
    expect(fake.gone).toEqual([dir, bin]);
    expect(existsSync(dir)).toBe(false);
  });

  /** The removal refusing after npm ran: what it threw, in the words it says it in. */
  const AFTER = "after npm ran it was no longer provably a published sessionpipe";
  async function refusedAfter(npm: (prefix: string) => Promise<unknown>): Promise<void> {
    const e = await remove(dir, { ...posix(), npm }).then(
      (said) => said,
      (thrown: unknown) => thrown,
    );
    // Thrown, so nothing is answered as gone: not the folder, and not its link.
    expect(e).toBeInstanceOf(NotOurs);
    expect(e).toMatchObject({ what: dir, why: AFTER, message: `${dir} was left alone: ${AFTER}` });
  }

  it("npm leaves in the slot what is no published sessionpipe: it is refused, said, and never answered as gone", async () => {
    await refusedAfter(async () => {
      fake.real.rmSync(dir, { recursive: true });
      mkdirSync(path.join(dir, "src"), { recursive: true });
    });
    // Nothing was handed to a deletion here: what npm left stays, and the link stays
    // with the folder it leads into (a link goes with its folder, or when that is gone).
    expect(fake.gone).toEqual([]);
    expect(readdirSync(dir)).toEqual(["src"]);
    expect(fake.real.readlinkSync(bin)).toBe(INTO);
    expect(prove(bin, posix())).toEqual({ is: "not", why: "it is the link of a copy that is there" });
  });

  it("something of someone's put in the copy while npm ran: all of it stays, and its link with it", async () => {
    const before = tree();
    await refusedAfter(async () => writeFileSync(path.join(dir, "notes.txt"), "mine"));
    expect(fake.gone).toEqual([]);
    expect(tree()).toEqual([...before, `${path.relative(tmp, path.join(dir, "notes.txt"))}: mine`].sort());
    // The same where npm itself failed.
    fake.real.unlinkSync(path.join(dir, "notes.txt"));
    await refusedAfter(async () => {
      mkdirSync(path.join(dir, ".git"));
      throw new Error("npm error code EBUSY");
    });
    expect(fake.gone).toEqual([]);
    expect(readFileSync(path.join(dir, "package.json"), "utf8")).toBe(PACKAGE);
    expect(binsOf(dir, posix())).toEqual([bin]);
  });

  it("the link is proven again too: one that leads to another copy by then is that copy's, stays, and is not answered", async () => {
    const theirs = unpack(slot(path.join(tmp, "b")));
    const npm = vi.fn(async (_prefix: string) => {
      fake.real.unlinkSync(bin);
      symlinkSync(path.join(theirs, "dist", "cli.js"), bin);
    });
    // What it answers is what is gone: the folder, and not the link that is there.
    expect(await take(dir, { ...posix(), npm })).toEqual([dir]);
    expect(fake.gone).toEqual([dir]);
    expect(binTarget(bin, "linux")).toBe(theirs);
    expect(prove(theirs, posix())).toEqual({ is: "folder", slot: "global", aside: false });
  });

  it("what is not ours is refused before npm is asked anything", async () => {
    mkdirSync(path.join(dir, ".git"));
    const npm = vi.fn(async (_prefix: string) => {});
    const before = tree();
    await expect(remove(dir, { ...posix(), npm })).rejects.toThrow(NotOurs);
    await expect(remove(bin, { ...posix(), npm })).rejects.toThrow("it is the link of a copy that is there");
    await expect(remove(dir, { ...posix(null), npm })).rejects.toThrow("was left alone: it is outside the folders");
    expect(npm).not.toHaveBeenCalled();
    expect(fake.gone).toEqual([]);
    expect(tree()).toEqual(before);
  });
});

describe("remove: the folder alone, where its slot is filled again", () => {
  const FOLDER = { is: "folder", slot: "global", aside: false };

  it.runIf(links)(
    "the folder goes; its link stays as npm wrote it; npm is not asked; only the folder is answered",
    async () => {
      const prefix = path.join(tmp, "prefix");
      const dir = unpack(slot(prefix));
      const bin = link(prefix);
      const npm = vi.fn(async (_prefix: string) => {});
      expect(await take(dir, { ...posix(), npm, alone: true })).toEqual([dir]);
      expect(npm).not.toHaveBeenCalled();
      expect(fake.gone).toEqual([dir]);
      expect(existsSync(dir)).toBe(false);
      // The link still leads to the slot, for the folder that comes back to it.
      expect(fake.real.readlinkSync(bin)).toBe(INTO);
      expect(binTarget(bin, "linux")).toBe(dir);
      unpack(dir);
      expect(prove(dir, posix())).toEqual(FOLDER);
      expect(binsOf(dir, posix())).toEqual([bin]);
      expect(prove(bin, posix())).toEqual({ is: "not", why: "it is the link of a copy that is there" });
    },
  );

  it.runIf(links)("a leftover and an npx cache entry alike: the folder, and nothing beside it", async () => {
    const prefix = path.join(tmp, "prefix");
    const fresh = unpack(slot(prefix));
    const bin = link(prefix);
    const aside = unpack(slot(prefix, ".sessionpipe-AbCd1234"));
    const cached = unpack(npx());
    const dotBin = path.join(path.dirname(cached), ".bin");
    mkdirSync(dotBin);
    symlinkSync(path.join("..", "sessionpipe", "dist", "cli.js"), path.join(dotBin, "sessionpipe"));
    const npm = vi.fn(async (_prefix: string) => {});
    expect(await take(aside, { ...posix(), npm, alone: true })).toEqual([aside]);
    expect(await take(cached, { ...posix(), npm, alone: true })).toEqual([cached]);
    expect(npm).not.toHaveBeenCalled();
    expect(fake.gone).toEqual([aside, cached]);
    expect(fake.real.readlinkSync(path.join(dotBin, "sessionpipe"))).toBe(
      path.join("..", "sessionpipe", "dist", "cli.js"),
    );
    expect(prove(fresh, posix())).toEqual(FOLDER);
    expect(binTarget(bin, "linux")).toBe(fresh);
  });

  it.runIf(links)(
    "`alone: false` is the same as not saying it: npm is asked, and the link goes with its folder",
    async () => {
      const prefix = path.join(tmp, "prefix");
      const dir = unpack(slot(prefix));
      const bin = link(prefix);
      const npm = vi.fn(async (_prefix: string) => {});
      expect(await take(dir, { ...posix(), npm, alone: false })).toEqual([dir, bin]);
      expect(npm.mock.calls).toEqual([[prefix]]);
      expect(fake.gone).toEqual([dir, bin]);
      expect(readdirSync(path.join(prefix, "bin"))).toEqual([]);
    },
  );

  it.runIf(links)(
    "a link is a link all the same: one whose folder is gone goes, one of a copy that is there doesn't",
    async () => {
      const dangling = link(path.join(tmp, "a"));
      expect(await take(dangling, { ...posix(), alone: true })).toEqual([dangling]);
      expect(fake.gone).toEqual([dangling]);
      fake.gone = [];
      const b = path.join(tmp, "b");
      unpack(slot(b));
      await refused(link(b), { ...posix(), alone: true }, "it is the link of a copy that is there");
    },
  );

  it("Windows: the folder goes, and npm's shims stay as they were written", async () => {
    const prefix = path.join(tmp, "npm");
    const dir = unpack(path.join(prefix, "node_modules", "sessionpipe"));
    const all = shims(prefix, GLOBAL_SHIM);
    const npm = vi.fn(async (_prefix: string) => {});
    const before = tree();
    expect(await take(dir, { ...win([prefix]), npm, alone: true })).toEqual([dir]);
    expect(npm).not.toHaveBeenCalled();
    expect(fake.gone).toEqual([dir]);
    const rel = path.relative(tmp, dir);
    expect(tree()).toEqual(before.filter((e) => !e.startsWith(rel + path.sep)));
    for (const file of all) expect(binTarget(file, "win32"), file).toBe(dir);
  });

  it("what is not ours is refused all the same, and nothing is removed", async () => {
    const alone = (reach: Reach = true) => ({ ...posix(reach), alone: true, npm: vi.fn(async () => {}) });
    const checkout = unpack(slot(path.join(tmp, "prefix")));
    mkdirSync(path.join(checkout, "src"));
    await refused(checkout, alone(), "it holds src, which no published sessionpipe has (a checkout or a build?)");
    await refused(
      unpack(path.join(tmp, "proj", "node_modules", "sessionpipe")),
      alone(),
      "it is not a global install or an npx cache entry (a project's own dependency?)",
    );
    await refused(
      unpack(slot(path.join(tmp, "b"))),
      alone(null),
      "it is outside the folders this sessionpipe keeps its own files in",
    );
  });
});

describe("the guard: one file deletes, in one function", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const folder = path.resolve(here, "..", "src", "reinstall");
  const files = readdirSync(folder).sort();
  const source = (name: string): string => readFileSync(path.join(folder, name), "utf8");
  /** Every way node:fs deletes, by its name or as it is called. */
  const DELETES = /\b(?:rmSync|unlinkSync|rmdirSync)\b|\b(?:rm|unlink|rmdir)\(/g;
  const deletes = (text: string): { at: number; word: string }[] =>
    [...text.matchAll(DELETES)].map((m) => ({ at: m.index, word: m[0] }));
  /** What a file takes from node:fs, name by name. */
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
  ];

  it("the folder is the five files this guard was written for", () => {
    expect(files).toEqual(["find.ts", "ours.ts", "page.ts", "plan.ts", "run.ts"]);
  });

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
  });

  it("only ours.ts names a deletion; every other file can only read, and none runs a program", () => {
    for (const name of files) {
      const text = source(name);
      if (name !== "ours.ts") expect(deletes(text), name).toEqual([]);
      // What it takes from node:fs is read-only, name by name (never the whole module).
      for (const taken of fromFs(text))
        expect([...READS, ...(name === "ours.ts" ? ["rmSync", "unlinkSync"] : [])], `${name} takes ${taken}`).toContain(
          taken,
        );
      expect(text, name).not.toMatch(/fs\/promises/);
      expect(text, name).not.toMatch(/child_process/);
      expect(text, name).not.toMatch(/\brequire\(|\bimport\(/);
      expect(text, name).not.toMatch(/\b(?:rename|write|append|truncate|copy|cp|mkdir|symlink|link|chmod)\w*Sync\b/);
    }
    expect(fromFs(source("ours.ts"))).toEqual(expect.arrayContaining(["rmSync", "unlinkSync"]));
    expect(fromFs(source("find.ts")).length).toBeGreaterThan(0);
  });

  it("in ours.ts every deletion is inside `remove`, the last function in the file", () => {
    const text = source("ours.ts");
    const start = text.indexOf("export async function remove(");
    expect(start).toBeGreaterThan(0);
    expect(text.indexOf("export async function remove(", start + 1)).toBe(-1);
    // Before it: the two names in the one import from node:fs, and nothing else.
    const imported = /^import \{[^}]*\} from "node:fs";$/m.exec(text) as RegExpExecArray;
    const before = deletes(text.slice(0, start));
    expect(before.map((d) => d.word)).toEqual(["rmSync", "unlinkSync"]);
    for (const d of before) {
      expect(d.at).toBeGreaterThan(imported.index);
      expect(d.at).toBeLessThan(imported.index + imported[0].length);
    }
    // After it: the three uses, each a call, and no other function begins before the file ends.
    const body = text.slice(start);
    expect(deletes(body).map((d) => d.word)).toEqual(["unlinkSync", "rmSync", "unlinkSync"]);
    expect(body.match(/unlinkSync\(what\)|rmSync\(what, \{ recursive: true \}\)|unlinkSync\(b\)/g)).toHaveLength(3);
    expect(body.slice(1)).not.toMatch(/^(?:export\s+)?(?:async\s+)?(?:function|const|let|var|class)\b/m);
    expect(body.trimEnd().endsWith("\n}")).toBe(true);
    // Each is reached only past the proof.
    const proved = body.indexOf('if (p.is === "not") throw new NotOurs(what, p.why);');
    expect(proved).toBeGreaterThan(0);
    for (const d of deletes(body)) expect(d.at).toBeGreaterThan(proved);
    // And each by its own condition: a link alone only as the proof's answer; the folder
    // only when proven again; a link with its folder only once the folder is gone (the
    // refusal comes first) and while it is still this folder's own.
    expect(body).toContain('if (p.is === "link") {\n    unlinkSync(what);\n    return [what];\n  }');
    const folder = body.indexOf('if (prove(what, o).is === "folder") rmSync(what, { recursive: true });');
    const refusal = body.indexOf("if (!gone(what)) throw new NotOurs(what,");
    const links = body.indexOf("for (const b of bins) if (still.includes(b)) unlinkSync(b);");
    expect(folder).toBeGreaterThan(proved);
    expect(refusal).toBeGreaterThan(folder);
    expect(links).toBeGreaterThan(refusal);
    // What is deleted is the one path that was proven: `what`, by its one spelling.
    expect(body).toContain("const what = path.resolve(asked);\n  const p = prove(what, o);");
    // (Its only other mention, comments apart, is the parameter itself.)
    const code = body.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(code.match(/\basked\b/g)).toHaveLength(2);
  });

  it("cli.ts's reinstall() deletes nothing itself: its removal is ours.ts's; a rename and npm's own link are all it writes", () => {
    const cli = readFileSync(path.resolve(here, "..", "src", "cli.ts"), "utf8");
    expect(cli).toMatch(/^import \{[^}]*\bremove\b[^}]*\} from "\.\/reinstall\/ours\.js";$/m);
    // The one `remove` in cli.ts is that import: nothing of the name is declared there.
    expect(cli).not.toMatch(/\b(?:function|const|let|var)\s+remove\b/);
    expect(cli.match(/\bremove\b[^"'\n]*from "/g)).toHaveLength(1);

    const start = cli.indexOf("\nasync function reinstall(): Promise<void> {\n");
    expect(start).toBeGreaterThan(0);
    const end = cli.indexOf("\n}\n", start);
    expect(end).toBeGreaterThan(start);
    const body = cli.slice(start, end);
    expect(body).toContain("await carryOut(p, {");
    expect(deletes(body)).toEqual([]);
    // Its `remove:` hands the path to ours.ts's `remove`, with the proof's own terms (and
    // `alone` only as it was given), and npm's uninstall as the one thing npm is asked.
    expect(body).toMatch(
      /\n\s+remove: \(what, alone\) =>\s+remove\(what, \{\s+\.\.\.proving,\s+\.\.\.\(alone \? \{ alone \} : \{\}\),\s+npm: async \(prefix\) => \{\s+const why = await npmDo\(\["uninstall", "--global", "--prefix", prefix, "sessionpipe"\], \{ node \}\);/,
    );
    expect(body.match(/\bremove\(/g)).toHaveLength(1);
    expect(body).toContain("const proving = { platform, reach: inv.reach, prefixes: inv.prefixes };");
    expect(body.match(/\bproving\b/g)).toHaveLength(2);
    // What it writes with node:fs: the rename that moves the old folder aside (and back),
    // and one link, npm's own, made again where it is gone. Nothing else, by any name.
    expect(body).toMatch(/\n\s+rename: renameSync,\n/);
    expect(body.match(/\b\w+Sync\b/g)?.filter((w) => !["existsSync", "readFileSync"].includes(w))).toEqual([
      "renameSync",
      "symlinkSync",
    ]);
    expect(body).not.toMatch(
      /\b(?:writeFile|appendFile|truncate|copyFile|cp|mkdir|mkdtemp|symlink|link|chmod|rename)\(/,
    );
    // The link: inside `relink:`, in the prefix it was given, only where no link of npm's
    // is there, and with the very text npm writes for it.
    const from = body.indexOf("\n    relink: (prefix) => {\n");
    expect(from).toBeGreaterThan(0);
    const relink = body.slice(from, body.indexOf("\n    },\n", from));
    expect(body.match(/\bsymlinkSync\b/g)).toHaveLength(1);
    expect(relink).toContain("symlinkSync(");
    expect(relink).toMatch(
      /const link =\s+platform === "win32" \? path\.join\(prefix, "sessionpipe\.cmd"\) : path\.join\(prefix, "bin", "sessionpipe"\);/,
    );
    expect(relink).toMatch(
      /if \(platform !== "win32" && !binTarget\(link, platform\)\)\s+try \{\s+symlinkSync\(path\.join\("\.\.", "lib", "node_modules", "sessionpipe", "dist", "cli\.js"\), link\);\s+\} catch \{\}/,
    );
    // That text is what this file's own links are made of, and what binTarget reads back.
    expect(INTO).toBe(path.join("..", "lib", "node_modules", "sessionpipe", "dist", "cli.js"));
  });

  it.runIf(links)("the link `relink` makes is npm's own: it is its copy's, and goes with it", async () => {
    const prefix = path.join(tmp, "prefix");
    const dir = unpack(slot(prefix));
    mkdirSync(path.join(prefix, "bin"));
    const file = path.join(prefix, "bin", "sessionpipe");
    // As cli.ts makes it: the same words, in the prefix's bin folder.
    symlinkSync(path.join("..", "lib", "node_modules", "sessionpipe", "dist", "cli.js"), file);
    expect(binTarget(file, "linux")).toBe(dir);
    expect(binsOf(dir, posix())).toEqual([file]);
    expect(await take(dir, posix())).toEqual([dir, file]);
  });
});
