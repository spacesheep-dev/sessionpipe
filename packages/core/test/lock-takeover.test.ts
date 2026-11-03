// SPDX-License-Identifier: Apache-2.0
// A stale lock taken over by two workers at once (issue #208 review): both read the
// dead pid, the first unlinked it and made its own, the second then unlinked that and
// made another, and two drains ran side by side. The takeover now renames the stale
// file aside (one rename wins), puts back a fresh lock it moved by mistake, and a
// release deletes only its own lock. The races are staged by doing, just before or
// just after the rename, what the other worker would have done there.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Hook = undefined | ((from: string) => void);
const race = vi.hoisted(() => ({ before: undefined as Hook, after: undefined as Hook }));
vi.mock("node:fs", async (orig) => {
  const fs = await orig<typeof import("node:fs")>();
  const renameSync = (from: string, to: string) => {
    const { before, after } = race;
    race.before = race.after = undefined;
    before?.(from);
    fs.renameSync(from, to);
    after?.(from);
  };
  return { ...fs, default: { ...fs, renameSync }, renameSync };
});

import { takeNamedLock } from "../src/outbox.js";

const DEAD = "2147483647";
const THEIRS = `${process.pid} 0123456789abcdef`;
let tmp: string;
let f: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "sp-lock-"));
  mkdirSync(path.join(tmp, "locks"));
  f = path.join(tmp, "locks", "flush.lock");
  writeFileSync(f, DEAD);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));
const leftovers = () => readdirSync(path.join(tmp, "locks")).filter((n) => n !== "flush.lock");

describe("taking over a stale lock", () => {
  it("a dead holder's lock is moved aside and replaced by ours; nothing is left behind", () => {
    const release = takeNamedLock(tmp, "flush");
    expect(release).not.toBeNull();
    expect(readFileSync(f, "utf8")).toMatch(new RegExp(`^${process.pid} [0-9a-f]{16}$`));
    expect(leftovers()).toEqual([]);
    release?.();
    expect(existsSync(f)).toBe(false);
  });

  it("another worker moved it first: our rename fails and we stand down", () => {
    race.before = (from) => rmSync(from);
    expect(takeNamedLock(tmp, "flush")).toBeNull();
    expect(existsSync(f)).toBe(false);
  });

  it("another worker took it over in between: the fresh lock we moved is put back, and we stand down", () => {
    race.before = (from) => writeFileSync(from, THEIRS);
    expect(takeNamedLock(tmp, "flush")).toBeNull();
    expect(readFileSync(f, "utf8")).toBe(THEIRS);
    expect(leftovers()).toEqual([]);
  });

  it("…and when a third made one at the path before the put-back, that one stays", () => {
    const third = `${process.pid} fedcba9876543210`;
    race.before = (from) => writeFileSync(from, THEIRS);
    race.after = (from) => writeFileSync(from, third);
    expect(takeNamedLock(tmp, "flush")).toBeNull();
    expect(readFileSync(f, "utf8")).toBe(third);
    expect(leftovers()).toEqual([]);
  });

  it("a release deletes only its own lock, not one another worker took over since", () => {
    const release = takeNamedLock(tmp, "flush");
    writeFileSync(f, THEIRS);
    release?.();
    expect(readFileSync(f, "utf8")).toBe(THEIRS);
  });
});
