// SPDX-License-Identifier: Apache-2.0
// files.ts on its own: what the daemon tests can't reach through a receiver — a
// cwd that isn't its own realpath, a write that fails after the first file landed
// (nothing kept), a fetch that rejects with something that isn't an Error, sizes.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FETCH_TIMEOUT_MS,
  type Fetched,
  FileProblem,
  fetchFiles,
  humanSize,
  withFiles,
  writeFiles,
} from "../src/control/files.js";

let tmp: string;
const file = (name: string, n = 3): Fetched => ({
  file: { name, type: "text/plain", size: n, sha256: "A".repeat(43) },
  name,
  bytes: new Uint8Array(n).fill(0x61),
});

beforeEach(() => {
  // Its real path: on a Mac the temp folder is a symlink, and cwd reaches writeFiles resolved.
  tmp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "sp-files-")));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("writeFiles", () => {
  it("writes under <cwd>/.sessionpipe/files/<session>/ and answers the relative paths", () => {
    const rel = writeFiles(tmp, "s1", [file("a.txt"), file("b.txt", 5)]);
    expect(rel).toEqual([".sessionpipe/files/s1/a.txt", ".sessionpipe/files/s1/b.txt"]);
    expect(readdirSync(path.join(tmp, ".sessionpipe", "files", "s1")).sort()).toEqual(["a.txt", "b.txt"]);
  });
  it("a prompt's files: a folder of its own inside the session's, which may be there; the message's must be new", () => {
    writeFiles(tmp, "s1", [file("a.txt")]);
    expect(writeFiles(tmp, "s1", [file("a.txt")], "n1")).toEqual([".sessionpipe/files/s1/n1/a.txt"]);
    expect(writeFiles(tmp, "s2", [file("b.txt")], "n1")).toEqual([".sessionpipe/files/s2/n1/b.txt"]);
    expect(() => writeFiles(tmp, "s1", [file("c.txt")], "n1")).toThrow(".sessionpipe/files/s1/n1 already exists");
    // An id the protocol allows that is no folder of its own.
    expect(() => writeFiles(tmp, "..", [file("c.txt")], "n2")).toThrow("no folder ..");
    expect(() => writeFiles(tmp, "s1", [file("c.txt")], ".")).toThrow("no folder .");
    expect(readdirSync(path.join(tmp, ".sessionpipe", "files", "s1")).sort()).toEqual(["a.txt", "n1"]);
  });
  it("a second file that can't be created (wx) removes the first with the session's folder", () => {
    // The verifier never lets two names collide; the exclusive create is the last line.
    expect(() => writeFiles(tmp, "s1", [file("a.txt"), file("a.txt")])).toThrow(/couldn't save the files: EEXIST/);
    expect(existsSync(path.join(tmp, ".sessionpipe", "files", "s1"))).toBe(false);
    expect(existsSync(path.join(tmp, ".sessionpipe", "files"))).toBe(true);
  });
  it("a cwd that resolves elsewhere: refused, and the folder it made is removed", () => {
    const real = path.join(tmp, "real");
    mkdirSync(real);
    const link = path.join(tmp, "link");
    symlinkSync(real, link);
    let err: unknown;
    try {
      writeFiles(link, "s1", [file("a.txt")]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FileProblem);
    expect(String((err as Error).message)).toMatch(/leads outside/);
    expect(existsSync(path.join(real, ".sessionpipe", "files", "s1"))).toBe(false);
  });
});

describe("fetchFiles", () => {
  it("a fetch that rejects with something that isn't an Error still names the file", async () => {
    const f = { name: "x.bin", type: "application/octet-stream", size: 1, sha256: "A".repeat(43) };
    const o = { control: "http://r/c/", token: "t", fetch: (() => Promise.reject("socket hung up")) as typeof fetch };
    await expect(fetchFiles([f], o)).rejects.toThrow('couldn\'t download "x.bin": socket hung up');
    expect(FETCH_TIMEOUT_MS).toBe(300_000);
  });
});

describe("the list the session reads", () => {
  it("sizes in units of 1024, and the text first", () => {
    expect(humanSize(512)).toBe("512 B");
    expect(humanSize(183_402)).toBe("179 KB");
    expect(humanSize(1_258_291)).toBe("1.2 MB");
    expect(withFiles("hi", [file("a.txt", 512)], [".sessionpipe/files/s/a.txt"])).toBe(
      "hi\n\nAttached files (saved in this folder):\n- .sessionpipe/files/s/a.txt (text/plain, 512 B)",
    );
  });
});
