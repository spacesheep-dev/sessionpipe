// SPDX-License-Identifier: Apache-2.0
// The fixture walk the scripts share: plain files in plain folders, in a fixed order, and a
// symbolic link anywhere in the tree is an error that names it (to a file, to a folder,
// dangling, or the folder asked for itself).
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { envelope } from "./envelope.mjs";
import { refuseLink, walkFiles } from "./walk.mjs";

const tmp = mkdtempSync(path.join(os.tmpdir(), "sp-walk-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("walkFiles", () => {
  it("lists every file under a folder, sorted, and nothing for a folder that is not there", () => {
    const dir = path.join(tmp, "plain");
    mkdirSync(path.join(dir, "b/deep"), { recursive: true });
    for (const f of ["b/deep/x.json", "b/a.txt", "a.json", "c.bin"]) writeFileSync(path.join(dir, f), "{}");
    expect(walkFiles(dir).map((f) => path.relative(dir, f).split(path.sep).join("/"))).toEqual([
      "a.json",
      "b/a.txt",
      "b/deep/x.json",
      "c.bin",
    ]);
    expect(walkFiles(path.join(tmp, "gone"))).toEqual([]);
    expect(() => walkFiles(path.join(dir, "a.json"))).toThrow(/ENOTDIR/);
  });
  // Making a symbolic link needs a privilege on Windows.
  it.skipIf(process.platform === "win32")("refuses a symbolic link instead of following it", () => {
    const outside = path.join(tmp, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, "secret.json"), "{}");
    const cases: [string, string][] = [
      ["file", path.join(outside, "secret.json")],
      ["folder", outside],
      ["dangling", path.join(tmp, "nowhere")],
    ];
    for (const [name, target] of cases) {
      const dir = path.join(tmp, `linked-${name}`);
      mkdirSync(path.join(dir, "nested"), { recursive: true });
      const link = path.join(dir, "nested", "link.json");
      symlinkSync(target, link);
      expect(() => walkFiles(dir)).toThrow(`${link} is a symbolic link`);
      expect(() => refuseLink(link)).toThrow(`${link} is a symbolic link`);
    }
    const root = path.join(tmp, "root-link");
    symlinkSync(outside, root);
    expect(() => walkFiles(root)).toThrow(`${root} is a symbolic link`);
    expect(() => refuseLink(outside)).not.toThrow();
    expect(() => refuseLink(path.join(tmp, "nowhere"))).not.toThrow();
  });
});

describe("envelope", () => {
  const e = { type: "tool.ended", id: "*", time: "*", tier: "*", session: { id: "s", seq: "*" } };
  it('fills "*" from the type\'s tier', () => {
    expect(envelope(e, { "tool.ended": 2 })).toMatchObject({ tier: 2, session: { id: "s", seq: 0 } });
    expect(envelope({ ...e, tier: 1 }, {})).toMatchObject({ tier: 1 });
  });
  it('a "*" tier for a type with no tier of its own is an error, never tier 0', () => {
    expect(() => envelope({ ...e, type: "tool.nope" }, { "tool.ended": 2 })).toThrow('no tier for type "tool.nope"');
    // A name every object inherits is not a type.
    expect(() => envelope({ ...e, type: "constructor" }, { "tool.ended": 2 })).toThrow(
      'no tier for type "constructor"',
    );
  });
});
