// SPDX-License-Identifier: Apache-2.0
// files.ts on its own: what the daemon tests can't reach through a receiver — a
// cwd that isn't its own realpath, a write that fails after the first file landed
// (nothing kept), a disk that is full or a folder that can't be written to, a fetch
// that rejects with something that isn't an Error, the tries at a file, sizes.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type Failure,
  FETCH_TIMEOUT_MS,
  type Fetched,
  FileProblem,
  fetchFiles,
  humanSize,
  limitWords,
  RETRY_DELAYS_MS,
  retries,
  withFiles,
  writeFiles,
} from "../src/control/files.js";

// The one write a test makes fail, with the system's code for why.
const fsFault = vi.hoisted(() => ({ code: null as string | null }));
vi.mock("node:fs", async (original) => {
  const real = await original<typeof import("node:fs")>();
  const writeFileSync = ((...a: Parameters<typeof real.writeFileSync>) => {
    if (fsFault.code)
      throw Object.assign(new Error(`${fsFault.code}: the system's own words, open '${String(a[0])}'`), {
        code: fsFault.code,
      });
    return real.writeFileSync(...a);
  }) as typeof real.writeFileSync;
  return { ...real, writeFileSync };
});

const here = path.dirname(fileURLToPath(import.meta.url));

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
  fsFault.code = null;
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

describe("a write the system refuses, in words", () => {
  it.each([
    ["EACCES", "this folder can't be written to"],
    ["EPERM", "this folder can't be written to"],
    ["EROFS", "this folder can't be written to"],
    ["ENOSPC", "the disk is full"],
  ])("%s: %s, and nothing is kept", (code, words) => {
    writeFiles(tmp, "s0", [file("a.txt")]);
    fsFault.code = code;
    expect(() => writeFiles(tmp, "s1", [file("a.txt")])).toThrow(new FileProblem(`couldn't save the files: ${words}`));
    expect(existsSync(path.join(tmp, ".sessionpipe", "files", "s1"))).toBe(false);
  });
  it("any other reason is said as the system said it", () => {
    writeFiles(tmp, "s0", [file("a.txt")]);
    fsFault.code = "EIO";
    expect(() => writeFiles(tmp, "s1", [file("a.txt")])).toThrow(
      /^couldn't save the files: EIO: the system's own words/,
    );
  });
});

describe("fetchFiles", () => {
  it("a fetch that rejects with something that isn't an Error is the network: it names the file, in words", async () => {
    const f = { name: "x.bin", type: "application/octet-stream", size: 1, sha256: "A".repeat(43) };
    const o = {
      control: "http://r/c/",
      token: "t",
      fetch: (() => Promise.reject("socket hung up")) as typeof fetch,
      retryDelaysMs: [1, 1],
    };
    await expect(fetchFiles([f], o)).rejects.toThrow(
      new FileProblem('couldn\'t download "x.bin": the connection to the receiver kept failing'),
    );
    expect(FETCH_TIMEOUT_MS).toBe(300_000);
  });
});

describe("fetchFiles, told to stop", () => {
  const f = (name: string) => ({ name, type: "text/plain", size: 3, sha256: "A".repeat(43) });
  it("drops the download in flight, and asks for no file after it", async () => {
    const ctl = new AbortController();
    const asked: string[] = [];
    const stalls: typeof fetch = (input, init) =>
      new Promise((_res, rej) => {
        asked.push(String(input));
        init?.signal?.addEventListener("abort", () => rej(new Error("hung up")));
      });
    const got = fetchFiles([f("a.txt"), f("b.txt")], {
      control: "http://x/c",
      token: "t",
      fetch: stalls,
      signal: ctl.signal,
    });
    await new Promise((r) => setTimeout(r, 20));
    ctl.abort();
    await expect(got).rejects.toThrow('couldn\'t download "a.txt": hung up');
    expect(asked).toHaveLength(1);
    // Stopped before it began: nothing is asked for at all.
    const none = fetchFiles([f("b.txt")], { control: "http://x/c", token: "t", fetch: stalls, signal: ctl.signal });
    await expect(none).rejects.toThrow(FileProblem);
    await expect(none).rejects.toThrow('stopped before "b.txt" was downloaded');
    expect(asked).toHaveLength(1);
  });
});

describe("fetchFiles, stopped in flight by a fetch that rejects with something that isn't an Error", () => {
  it("still names the file", async () => {
    const ctl = new AbortController();
    const f = { name: "c.txt", type: "text/plain", size: 3, sha256: "A".repeat(43) };
    const stalls: typeof fetch = (_input, init) =>
      new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej("socket hung up")));
    const got = fetchFiles([f], { control: "http://x/c", token: "t", fetch: stalls, signal: ctl.signal });
    setTimeout(() => ctl.abort(), 20);
    await expect(got).rejects.toThrow(new FileProblem('couldn\'t download "c.txt": socket hung up'));
  });
});

describe("whether a file is tried again (conformance/control-file-retry.json)", () => {
  interface Case {
    name: string;
    failure: Failure["kind"];
    status?: number;
    expect: "retries" | "fails";
  }
  const vectors = JSON.parse(
    readFileSync(path.resolve(here, "../../../conformance/control-file-retry.json"), "utf8"),
  ) as { cases: Case[] };
  it("has every kind of failure, and both answers", () => {
    expect(new Set(vectors.cases.map((c) => c.failure))).toEqual(
      new Set(["network", "status", "too_long", "too_short", "hash", "timeout", "stopped"]),
    );
    expect(vectors.cases.filter((c) => c.expect === "retries")).toHaveLength(5);
  });
  it.each(vectors.cases)("$name", (c) => {
    const f = (c.failure === "status" ? { kind: "status", status: c.status } : { kind: c.failure }) as Failure;
    expect(retries(f)).toBe(c.expect === "retries");
  });
});

describe("the tries at one file", () => {
  const body = new Uint8Array([1, 2, 3, 4]);
  const sha = createHash("sha256").update(body).digest("base64url");
  const f = { name: "shot.png", type: "image/png", size: body.length, sha256: sha };
  /** A receiver that answers each ask with the next of `answers`: a status, "drop" (the
   *  connection fails), "stall" (no answer until hung up on), or "ok" (the bytes). */
  const receiver = (...answers: (number | "drop" | "stall" | "ok" | "swap" | "short" | "long")[]) => {
    const asked: number[] = [];
    const fetch = ((_input: unknown, init?: RequestInit): Promise<Response> => {
      asked.push(Date.now());
      const a = answers.shift() ?? "ok";
      if (a === "drop") return Promise.reject(new TypeError("fetch failed"));
      if (a === "stall")
        return new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))));
      if (a === "ok") return Promise.resolve(new Response(body));
      if (a === "swap") return Promise.resolve(new Response(new Uint8Array([4, 3, 2, 1])));
      if (a === "short") return Promise.resolve(new Response(body.subarray(0, 3)));
      if (a === "long") return Promise.resolve(new Response(new Uint8Array(9)));
      return Promise.resolve(new Response("no", { status: a }));
    }) as typeof globalThis.fetch;
    return { asked, fetch };
  };
  const opts = (fetch: typeof globalThis.fetch, more: object = {}) => ({
    control: "http://r/c",
    token: "t",
    fetch,
    retryDelaysMs: [20, 40],
    ...more,
  });

  it("two more tries, after 1 s and 4 s by default", () => {
    expect(RETRY_DELAYS_MS).toEqual([1000, 4000]);
  });
  it("a connection that drops and a busy receiver: the third try gets it, after each wait", async () => {
    const r = receiver("drop", 503, "ok");
    const [got] = await fetchFiles([f], opts(r.fetch));
    expect(Buffer.from(got!.bytes)).toEqual(Buffer.from(body));
    expect(r.asked).toHaveLength(3);
    expect(r.asked[1]! - r.asked[0]!).toBeGreaterThanOrEqual(15);
    expect(r.asked[2]! - r.asked[1]!).toBeGreaterThanOrEqual(35);
  });
  it("a receiver that keeps failing: three tries, then its status", async () => {
    const r = receiver(500, 502, 500, "ok");
    await expect(fetchFiles([f], opts(r.fetch))).rejects.toThrow('couldn\'t download "shot.png": HTTP 500');
    expect(r.asked).toHaveLength(3);
  });
  it("a connection that keeps failing: three tries, then plain words, not the system's", async () => {
    const r = receiver("drop", "drop", "drop", "ok");
    const got = fetchFiles([f], opts(r.fetch));
    await expect(got).rejects.toThrow(
      new FileProblem('couldn\'t download "shot.png": the connection to the receiver kept failing'),
    );
    await expect(got).rejects.not.toThrow("fetch failed");
    expect(r.asked).toHaveLength(3);
  });
  it("a 404, another status, another size or another hash: asked once", async () => {
    for (const [answer, why] of [
      [404, "isn't on the receiver"],
      [403, "HTTP 403"],
      ["swap", "doesn't match its signed hash"],
      ["short", "is 3 bytes, not its signed 4"],
      ["long", "is larger than its signed size (4 bytes)"],
    ] as const) {
      const r = receiver(answer, "ok");
      await expect(fetchFiles([f], opts(r.fetch))).rejects.toThrow(why);
      expect(r.asked).toHaveLength(1);
    }
  });
  it("the time limit is the file's, every try and wait included: said in words", async () => {
    // It runs out in the middle of a try…
    const stalls = receiver("drop", "stall");
    await expect(fetchFiles([f], opts(stalls.fetch, { timeoutMs: 150 }))).rejects.toThrow(
      new FileProblem('"shot.png" didn\'t finish downloading within 0.15 seconds'),
    );
    expect(stalls.asked).toHaveLength(2);
    // …or while it waits to try again: no try after it.
    const waits = receiver("drop", "ok");
    await expect(fetchFiles([f], opts(waits.fetch, { timeoutMs: 50, retryDelaysMs: [5000] }))).rejects.toThrow(
      new FileProblem('"shot.png" didn\'t finish downloading within 0.05 seconds'),
    );
    expect(waits.asked).toHaveLength(1);
  });
  it("told to stop while it waits to try again: no try after it", async () => {
    const ctl = new AbortController();
    const r = receiver("drop", "ok");
    const got = fetchFiles([f], opts(r.fetch, { retryDelaysMs: [5000], signal: ctl.signal }));
    setTimeout(() => ctl.abort(), 30);
    await expect(got).rejects.toThrow(new FileProblem('stopped before "shot.png" was downloaded'));
    expect(r.asked).toHaveLength(1);
  });
  it("the limit in words", () => {
    expect(limitWords(FETCH_TIMEOUT_MS)).toBe("5 minutes");
    expect(limitWords(60_000)).toBe("1 minute");
    expect(limitWords(90_000)).toBe("90 seconds");
    expect(limitWords(1000)).toBe("1 second");
    expect(limitWords(300)).toBe("0.3 seconds");
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
