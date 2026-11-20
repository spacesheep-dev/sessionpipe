// SPDX-License-Identifier: Apache-2.0
// A command's pictures, passed natively where a harness takes them (CONTROL.md §6 `start`,
// Pictures; ADAPTERS.md): which file is a picture, which pictures each harness takes
// (conformance/control-pictures.json), a saved picture checked again before a run, and
// what each harness is handed: Codex's `--image` arguments on `exec` and `exec resume`,
// an ACP agent's `image` blocks, the Agent SDK's `image` blocks.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { ACP_PICTURES, acpImages } from "../src/adapters/acp-control.js";
import { CLAUDE_SDK_PICTURES, claudeImages } from "../src/adapters/claude-code-control.js";
import { CODEX_PICTURES, codexArgs, codexPictures, codexRefusedPictures } from "../src/adapters/codex-control.js";
import { pictureBytes, pictureThere } from "../src/adapters/headless.js";
import {
  base64Length,
  PICTURE_TYPES,
  type Picture,
  type PictureLimits,
  patches,
  pictureFacts,
  picturesFor,
  takes,
} from "../src/control/index.js";

const V = JSON.parse(readFileSync(new URL("../../../conformance/control-pictures.json", import.meta.url), "utf8")) as {
  facts: { name: string; type: string; bytes: string; expect: unknown }[];
  takes: { harness: string; why: string; picture: Omit<Picture, "path">; expect: boolean }[];
  messages: { harness: string; why: string; pictures: Omit<Picture, "path">[]; expect: number[] }[];
};

/** Each harness's limits, or null for one with no way but the text. */
const LIMITS: Record<string, PictureLimits | null> = {
  codex: CODEX_PICTURES,
  acp: ACP_PICTURES,
  "claude-code-sdk": CLAUDE_SDK_PICTURES,
  "claude-code": null,
  antigravity: null,
};

const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sp-pictures-")));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const bytesOf = (name: string) => Buffer.from(V.facts.find((f) => f.name === name)!.bytes, "base64");

/** A picture saved under `tmp` (in a folder whose name has a space and an accent), as
 *  the daemon describes it once it is written. */
function saved(name: string, vector: string, type = V.facts.find((f) => f.name === vector)!.type): Picture {
  const dir = path.join(tmp, "my files é");
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  const b = bytesOf(vector);
  writeFileSync(p, b);
  return { ...(pictureFacts(type, b) as NonNullable<ReturnType<typeof pictureFacts>>), path: p, size: b.length };
}

describe("which file is a picture (control-pictures.json, facts)", () => {
  for (const v of V.facts)
    it(v.name, () => {
      expect(pictureFacts(v.type, Buffer.from(v.bytes, "base64"))).toEqual(v.expect);
    });

  it("every case has a reason, and both answers are there", () => {
    expect(new Set(V.facts.map((v) => v.name)).size).toBe(V.facts.length);
    expect(V.facts.some((v) => v.expect === null)).toBe(true);
    expect(V.facts.some((v) => v.expect !== null)).toBe(true);
  });
});

describe("which pictures each harness takes (control-pictures.json, takes)", () => {
  for (const v of V.takes)
    it(`${v.harness}: ${v.why}`, () => {
      const l = LIMITS[v.harness];
      expect(l === undefined).toBe(false);
      expect(!!l && takes({ ...v.picture, path: "/x" }, l)).toBe(v.expect);
    });

  for (const v of V.messages)
    it(`several in one message, ${v.harness}: ${v.why}`, () => {
      const all = v.pictures.map((p, i) => ({ ...p, path: `/${i}` }));
      expect(picturesFor(all, LIMITS[v.harness] as PictureLimits).map((p) => Number(p.path.slice(1)))).toEqual(
        v.expect,
      );
    });

  it("base64 takes 4 characters for every 3 bytes begun", () => {
    expect([0, 1, 2, 3, 4, 3_750_000].map(base64Length)).toEqual([0, 4, 4, 4, 8, 5_000_000]);
    expect(Buffer.alloc(3_750_000).toString("base64")).toHaveLength(base64Length(3_750_000));
  });

  it("patches are 32 px squares, a part of one counted whole", () => {
    expect(patches({ width: 32, height: 32 })).toBe(1);
    expect(patches({ width: 33, height: 1 })).toBe(2);
    expect(patches({ width: 4800, height: 6400 })).toBe(30_000);
  });

  it("a harness is given those it takes, in the command's order", () => {
    const p = (type: Picture["type"], width: number): Picture => ({
      type,
      width,
      height: 10,
      animated: false,
      path: `/${width}`,
      size: 1,
    });
    const all = [p("image/png", 3000), p("image/gif", 10), p("image/webp", 2001), p("image/jpeg", 20)];
    expect(picturesFor(all, { types: PICTURE_TYPES, maxSide: 2000 }).map((x) => x.path)).toEqual(["/10", "/20"]);
    expect(picturesFor(all, { types: ["image/jpeg", "image/png"] }).map((x) => x.path)).toEqual(["/3000", "/20"]);
    expect(picturesFor([], { types: PICTURE_TYPES })).toEqual([]);
  });

  it("each limit on its own, at it and one past it", () => {
    const p: Picture = { type: "image/gif", width: 64, height: 32, animated: true, path: "/p", size: 100 };
    expect(takes(p, { types: PICTURE_TYPES })).toBe(true);
    expect(takes(p, { types: ["image/png"] })).toBe(false);
    expect(takes(p, { types: PICTURE_TYPES, maxBytes: 100 })).toBe(true);
    expect(takes(p, { types: PICTURE_TYPES, maxBytes: 99 })).toBe(false);
    expect(takes(p, { types: PICTURE_TYPES, maxSide: 64 })).toBe(true);
    expect(takes(p, { types: PICTURE_TYPES, maxSide: 63 })).toBe(false);
    expect(takes({ ...p, width: 32, height: 64 }, { types: PICTURE_TYPES, maxSide: 63 })).toBe(false);
    expect(takes(p, { types: PICTURE_TYPES, maxPatches: 2 })).toBe(true);
    expect(takes(p, { types: PICTURE_TYPES, maxPatches: 1 })).toBe(false);
    expect(takes(p, { types: PICTURE_TYPES, still: true })).toBe(false);
    expect(takes({ ...p, animated: false }, { types: PICTURE_TYPES, still: true })).toBe(true);
  });
});

describe("a saved picture, checked again before a run", () => {
  it("there as saved: its bytes", () => {
    const p = saved("there.png", "a PNG");
    expect(pictureThere(p)).toBe(true);
    expect(Buffer.from(pictureBytes(p)!)).toEqual(bytesOf("a PNG"));
  });

  it("gone between save and run: neither", () => {
    const p = saved("gone.png", "a PNG");
    rmSync(p.path);
    expect(pictureThere(p)).toBe(false);
    expect(pictureBytes(p)).toBeNull();
  });

  it("another length now: neither", () => {
    const p = saved("longer.png", "a PNG");
    writeFileSync(p.path, Buffer.concat([bytesOf("a PNG"), Buffer.from([0])]));
    expect(pictureThere(p)).toBe(false);
    expect(pictureBytes(p)).toBeNull();
  });

  it.runIf(process.platform !== "win32")("a link put in its place: neither, even to the same bytes", () => {
    const p = saved("linked.png", "a PNG");
    const real = path.join(tmp, "real.png");
    writeFileSync(real, bytesOf("a PNG"));
    rmSync(p.path);
    symlinkSync(real, p.path);
    expect(pictureThere(p)).toBe(false);
    expect(pictureBytes(p)).toBeNull();
  });

  it("grown or shrunk since it was saved: no bytes", () => {
    const p = saved("grew.png", "a PNG");
    writeFileSync(p.path, Buffer.concat([bytesOf("a PNG"), Buffer.alloc(7)]));
    expect(pictureBytes(p)).toBeNull();
    writeFileSync(p.path, bytesOf("a PNG").subarray(0, 30));
    expect(pictureBytes(p)).toBeNull();
    // A folder in its place opens, and is no file.
    rmSync(p.path);
    mkdirSync(p.path);
    expect(pictureBytes(p)).toBeNull();
  });

  it.runIf(process.platform !== "win32")("a FIFO put in its place: refused at once, nothing waits on it", () => {
    const p = saved("fifo.png", "a PNG");
    rmSync(p.path);
    execFileSync("mkfifo", [p.path]);
    const t0 = Date.now();
    expect(pictureBytes(p)).toBeNull();
    expect(pictureThere(p)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("the same length but another picture in its header: no bytes", () => {
    const p = saved("other.png", "a PNG");
    const b = bytesOf("a PNG");
    b.writeUInt32BE(397, 16); // another width
    writeFileSync(p.path, b);
    expect(pictureThere(p)).toBe(true);
    expect(pictureBytes(p)).toBeNull();
    // No longer a picture at all.
    writeFileSync(p.path, Buffer.alloc(b.length));
    expect(pictureBytes(p)).toBeNull();
  });
});

describe("Codex: each picture its own --image, on exec and exec resume", () => {
  const T = "0199b6f2-7c1d-7e3a-9b4c-5d6e7f8a9b0c";
  const one = ["/w/.sessionpipe/files/s/a shot é.png"];
  const several = ["/w/.sessionpipe/files/s/1.png", "/w/.sessionpipe/files/s/2.jpg", "/w/.sessionpipe/files/s/3.webp"];

  it("no pictures: the arguments as they always were", () => {
    expect(codexArgs({ permission: "safe", prompt: "P", cwd: "/w", pictures: [] })).toEqual(
      codexArgs({ permission: "safe", prompt: "P", cwd: "/w" }),
    );
    expect(codexArgs({ permission: "safe", prompt: "P", resume: T, pictures: [] })).toEqual(
      codexArgs({ permission: "safe", prompt: "P", resume: T }),
    );
  });

  it("one picture, a path with a space and an accent, one argument: exec", () => {
    expect(codexArgs({ permission: "safe", prompt: "what is this?", cwd: "/w", model: "m-1", pictures: one })).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-C",
      "/w",
      "-s",
      "workspace-write",
      "-m",
      "m-1",
      "--image",
      "/w/.sessionpipe/files/s/a shot é.png",
      "--",
      "what is this?",
    ]);
  });

  it("several, in order, after every other flag and before --: exec resume", () => {
    expect(codexArgs({ permission: "auto", prompt: "-and these", resume: T, pictures: several })).toEqual([
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      "-c",
      'sandbox_mode="workspace-write"',
      "-c",
      'approval_policy="on-request"',
      "-c",
      'approvals_reviewer="auto_review"',
      "--image",
      several[0],
      "--image",
      several[1],
      "--image",
      several[2],
      "--",
      T,
      "-and these",
    ]);
  });

  it("the pictures Codex is given: those it takes, still there, in order, by path", () => {
    const a = saved("a.png", "a PNG");
    const anim = saved("anim.gif", "an animated GIF");
    const b = saved("b.webp", "a lossy WebP");
    const gone = saved("gone.jpg", "a JPEG: JFIF, then a baseline frame");
    rmSync(gone.path);
    const big: Picture = { ...a, width: 4801, height: 6400 };
    expect(codexPictures([b, anim, gone, big, a])).toEqual([b.path, a.path]);
    expect(codexPictures([])).toEqual([]);
  });

  it("a path with a comma is never an --image: Codex would split it and read another file", () => {
    const a = saved("a.png", "a PNG");
    const comma = saved("x,README.png", "a PNG");
    expect(pictureThere(comma)).toBe(true);
    expect(codexPictures([comma, a])).toEqual([a.path]);
    // A comma in the session's folder leaves out every picture in it.
    expect(codexPictures([{ ...a, path: "/w/one,two/.sessionpipe/files/s/a.png" }])).toEqual([]);
  });

  it("an older Codex's refusal of --image, and nothing else", () => {
    const old =
      "error: unexpected argument '--image' found\n\nUsage: codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]\n";
    expect(codexRefusedPictures({ code: 2, stderr: old })).toBe(true);
    expect(codexRefusedPictures({ code: 1, stderr: old })).toBe(false);
    expect(codexRefusedPictures({ code: 2, stderr: "error: unexpected argument '--imagez' found" })).toBe(false);
    expect(codexRefusedPictures({ code: 2 })).toBe(false);
    // It had begun: a thread was named on stdout.
    expect(codexRefusedPictures({ code: 2, stdout: '{"type":"thread.started"}\n', stderr: old })).toBe(false);
    expect(codexRefusedPictures({ code: 2, stdout: " \n", stderr: old })).toBe(true);
    expect(codexRefusedPictures({ code: 0, stderr: "" })).toBe(false);
  });
});

describe("image blocks: an ACP agent's and the Agent SDK's", () => {
  it("ACP: its type, its bytes in base64 and its file's URL, in order; those it doesn't take left out", () => {
    const a = saved("a b é.png", "a PNG");
    const g = saved("anim.gif", "an animated GIF");
    const large: Picture = { ...a, size: 3_750_001 };
    const gone = saved("gone.webp", "a lossy WebP");
    rmSync(gone.path);
    expect(acpImages([g, large, gone, a])).toEqual([
      {
        type: "image",
        mimeType: "image/gif",
        data: bytesOf("an animated GIF").toString("base64"),
        uri: pathToFileURL(g.path).href,
      },
      {
        type: "image",
        mimeType: "image/png",
        data: bytesOf("a PNG").toString("base64"),
        uri: pathToFileURL(a.path).href,
      },
    ]);
    expect(pathToFileURL(a.path).href).toContain("a%20b%20%C3%A9.png");
    expect(acpImages([])).toEqual([]);
  });

  it("the Agent SDK: base64 sources, in order; over 3000 px or gone left out", () => {
    const a = saved("a.png", "a PNG");
    const j = saved("j.jpg", "a JPEG: JFIF, then a baseline frame");
    const wide = saved("wide.jpg", "a progressive JPEG, fill bytes and a lone marker before its frame");
    const gone = saved("gone.gif", "a GIF of one frame, with a colour table and an extension");
    rmSync(gone.path);
    expect(claudeImages([j, wide, gone, a])).toEqual([
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/jpeg",
          data: bytesOf("a JPEG: JFIF, then a baseline frame").toString("base64"),
        },
      },
      { type: "image", source: { type: "base64", media_type: "image/png", data: bytesOf("a PNG").toString("base64") } },
    ]);
    expect(claudeImages([])).toEqual([]);
  });
});
