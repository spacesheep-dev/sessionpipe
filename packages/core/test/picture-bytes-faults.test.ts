// SPDX-License-Identifier: Apache-2.0
// A saved picture's bytes read from one open of its path (CONTROL.md §6 `start`, Pictures;
// adapters/headless.ts pictureBytes), where the system does what a test can't make it do
// on a real file: a read that comes back short, an fstat that fails, and Windows, whose
// fs.constants has neither O_NOFOLLOW nor O_NONBLOCK. One fs call faked at a time.
import { closeSync, constants, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { pictureBytes } from "../src/adapters/headless.js";
import { type Picture, pictureFacts } from "../src/control/index.js";

const fake = vi.hoisted(() => ({
  constants: {} as Record<string, number | undefined>,
  short: false,
  fstatFails: false,
  flags: [] as number[],
  closed: [] as number[],
}));

vi.mock("node:fs", async (original) => {
  const m = await original<typeof import("node:fs")>();
  // A copy the test can take the two flags out of, as Windows' fs.constants has neither.
  const constants: Record<string, number | undefined> = { ...m.constants };
  fake.constants = constants;
  return {
    ...m,
    constants,
    openSync: ((p: string, flags: number, ...rest: unknown[]) => {
      fake.flags.push(flags);
      return (m.openSync as (...a: unknown[]) => number)(p, flags, ...rest);
    }) as typeof m.openSync,
    fstatSync: ((fd: number, ...rest: unknown[]) => {
      if (fake.fstatFails) throw Object.assign(new Error("EIO: i/o error, fstat"), { code: "EIO" });
      return (m.fstatSync as (...a: unknown[]) => unknown)(fd, ...rest);
    }) as typeof m.fstatSync,
    readSync: ((...a: unknown[]) =>
      fake.short ? 0 : (m.readSync as (...x: unknown[]) => number)(...a)) as typeof m.readSync,
    closeSync: ((fd: number) => {
      fake.closed.push(fd);
      m.closeSync(fd);
    }) as typeof m.closeSync,
  };
});

const tmp = mkdtempSync(path.join(os.tmpdir(), "sp-picture-bytes-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => {
  fake.short = false;
  fake.fstatFails = false;
  fake.flags.length = 0;
  fake.closed.length = 0;
});

/** A PNG as far as its header, saved as the daemon would describe it. */
function saved(): Picture {
  const b = Buffer.alloc(40);
  Buffer.from("\x89PNG\r\n\x1a\n\0\0\0\rIHDR", "latin1").copy(b);
  b.writeUInt32BE(10, 16);
  b.writeUInt32BE(10, 20);
  const p = path.join(tmp, "shot.png");
  writeFileSync(p, b);
  return { ...pictureFacts("image/png", b)!, path: p, size: b.length };
}

describe("a picture's bytes from one open", () => {
  it("opened without following a link and without waiting, and closed again", () => {
    expect(pictureBytes(saved())).toHaveLength(40);
    const want = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
    if (process.platform !== "win32") expect(want).not.toBe(constants.O_RDONLY);
    expect(fake.flags).toEqual([want]);
    expect(fake.closed).toHaveLength(1);
  });

  it("on Windows, with neither flag there: the plain read-only open, and the bytes", () => {
    const { O_NOFOLLOW, O_NONBLOCK } = fake.constants;
    delete fake.constants.O_NOFOLLOW;
    delete fake.constants.O_NONBLOCK;
    try {
      expect(pictureBytes(saved())).toHaveLength(40);
      expect(fake.flags).toEqual([constants.O_RDONLY]);
    } finally {
      Object.assign(fake.constants, { O_NOFOLLOW, O_NONBLOCK });
    }
  });

  it("a read that comes back short: no bytes, and the file is closed", () => {
    fake.short = true;
    expect(pictureBytes(saved())).toBeNull();
    expect(fake.closed).toHaveLength(1);
  });

  it("an fstat that fails: no bytes, and the file is closed", () => {
    fake.fstatFails = true;
    expect(pictureBytes(saved())).toBeNull();
    expect(fake.closed).toHaveLength(1);
    // Nothing is left open behind it.
    expect(() => closeSync(fake.closed[0] as number)).toThrow();
  });
});
