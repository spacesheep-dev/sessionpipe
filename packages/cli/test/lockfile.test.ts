// SPDX-License-Identifier: Apache-2.0
// A lock file one process holds (control/lockfile.ts): taken once, let go of only by its holder,
// broken when stale by renaming it aside, and never broken when what was renamed turns out to be
// another's fresh lock taken in between (put back). The in-between is made by wrapping renameSync.
import { mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const between = { run: null as null | ((from: string) => void), lstatGone: false };
vi.mock("node:fs", async (original) => {
  const real = await original<typeof import("node:fs")>();
  return {
    ...real,
    lstatSync: (...a: Parameters<typeof real.lstatSync>) => {
      if (between.lstatGone) {
        between.lstatGone = false;
        throw Object.assign(new Error("gone"), { code: "ENOENT" });
      }
      return real.lstatSync(...a);
    },
    renameSync: (from: string, to: string) => {
      const f = between.run;
      between.run = null;
      f?.(from);
      return real.renameSync(from, to);
    },
  };
});
const { LockIsFolder, takeLock } = await import("../src/control/lockfile.js");

let dir: string;
let file: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sp-lock-")));
  file = path.join(dir, "x.lock");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("takeLock", () => {
  it("is taken once; a release by anyone but its holder leaves it", () => {
    const a = takeLock(file);
    expect(a).not.toBeNull();
    expect(takeLock(file)).toBeNull();
    expect(readFileSync(file, "utf8")).toBe(`${a?.token}\n`);
    // Broken and taken by another meanwhile: the first holder's release leaves the other's lock.
    writeFileSync(file, `${process.pid} someone-else\n`);
    a?.release();
    expect(readFileSync(file, "utf8")).toBe(`${process.pid} someone-else\n`);
  });

  it("an old lock is broken by renaming it aside; another's fresh lock renamed in between goes back", () => {
    writeFileSync(file, `${process.pid} old\n`);
    const old = new Date(Date.now() - 120_000);
    utimesSync(file, old, old);
    // Between the look and the rename, another breaks it and takes it fresh.
    between.run = (from) => writeFileSync(from, `${process.pid} fresh\n`);
    const broke: string[] = [];
    expect(takeLock(file, { staleMs: 30_000, broke: (w) => broke.push(w) })).toBeNull();
    expect(readFileSync(file, "utf8")).toBe(`${process.pid} fresh\n`);
    expect(broke).toEqual([]);
    // With nothing in between, the old one is broken and this one holds it.
    utimesSync(file, old, old);
    const held = takeLock(file, { staleMs: 30_000, broke: (w) => broke.push(w) });
    expect(held).not.toBeNull();
    expect(broke).toEqual(["120 s old"]);
    held?.release();
  });

  it("a lock that says no process is broken; one gone before the look is taken on the next try", () => {
    writeFileSync(file, "garbage\n");
    const broke: string[] = [];
    const held = takeLock(file, { broke: (w) => broke.push(w) });
    expect(broke).toEqual(["its command has ended"]);
    held?.release();
    writeFileSync(file, `${process.pid} other\n`);
    between.lstatGone = true;
    expect(takeLock(file)).toBeNull();
  });

  it("one gone between the look and the rename is taken on the next try; a folder is said", () => {
    writeFileSync(file, "999999 gone\n");
    between.run = (from) => rmSync(from);
    const held = takeLock(file);
    expect(held).not.toBeNull();
    held?.release();
    rmSync(file, { force: true });
    expect(() => takeLock(path.join(dir))).toThrow(LockIsFolder);
  });
});
