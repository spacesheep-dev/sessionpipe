// SPDX-License-Identifier: Apache-2.0
// `sessionpipe control folders`: the folders sessions you message may run in, changed at
// the machine without pairing again (a session in ~/claude-kimi was refused on a machine
// that allowed ~/claude, and the only way to add it was a new pairing).
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changeFolders, controlMain } from "../src/control/cli.js";
import { writeControl } from "../src/control/store.js";

let home: string;
let project: string;
let other: string;
const control = () => JSON.parse(readFileSync(path.join(home, "cfg", "control.json"), "utf8"));

beforeEach(() => {
  home = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sp-folders-")));
  project = path.join(home, "claude");
  other = path.join(home, "claude-kimi");
  mkdirSync(project);
  mkdirSync(other);
  vi.spyOn(os, "homedir").mockReturnValue(home);
  vi.stubEnv("SESSIONPIPE_CONFIG", path.join(home, "cfg", "config.json"));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("changeFolders", () => {
  it("adds a project folder, and says so", () => {
    expect(changeFolders([project], "add", [other], home)).toEqual({
      folders: [project, other],
      said: [`  ✓ Allowed ${other}`],
    });
  });
  it("refuses a folder that isn't one, the home folder and above it, and keeps a folder once", () => {
    const file = path.join(home, "notes.txt");
    writeFileSync(file, "x");
    const link = path.join(home, "same-as-claude");
    symlinkSync(project, link);
    const r = changeFolders([project], "add", [path.join(home, "missing"), file, home, path.dirname(home), link], home);
    expect(r.folders).toEqual([project]);
    expect(r.said).toEqual([
      `  ✗ ${path.join(home, "missing")} isn't a folder on this machine`,
      `  ✗ ${file} isn't a folder on this machine`,
      expect.stringContaining(`Not allowing all of ${home}`),
      expect.stringContaining(`Not allowing all of ${path.dirname(home)}`),
      `  · ${link} is already allowed`,
    ]);
  });
  it("removes a folder by any path that reaches it, and says when one wasn't there", () => {
    const link = path.join(home, "kimi-link");
    symlinkSync(other, link);
    expect(changeFolders([project, other], "remove", [link, path.join(home, "nope")], home)).toEqual({
      folders: [project],
      said: [`  ✓ No longer allowed: ${other}`, `  · ${path.join(home, "nope")} wasn't allowed`],
    });
  });
});

describe("sessionpipe control folders", () => {
  const run = async (...args: string[]) => {
    const out: string[] = [];
    await controlMain(["control", "folders", ...args], (s) => out.push(s ?? ""), path.join(home, "dist"));
    return out.join("\n");
  };
  it("lists, adds and removes, writing control.json and keeping the rest of it", async () => {
    writeControl({ name: "mordast", folders: [project], mode: "auto", receivers: [] });
    expect(await run()).toBe(`  Sessions you message may run in:\n    ${project}`);
    const added = await run("add", other);
    expect(added).toContain(`✓ Allowed ${other}`);
    expect(added).toContain("within seconds");
    expect(control()).toEqual({ name: "mordast", folders: [project, other], mode: "auto", receivers: [] });
    expect(await run("add", other)).not.toContain("within seconds");
    await run("remove", project, other);
    expect(control().folders).toEqual([]);
    expect(await run()).toContain("No folder is allowed");
  });
  it("says what to run on a machine with no control yet, and how to use it", async () => {
    expect(await run()).toContain("run `sessionpipe control pair <receiver>` first");
    writeControl({ name: "mordast", folders: [project], mode: "safe", receivers: [] });
    expect(await run("add")).toContain("usage: sessionpipe control folders");
    expect(await run("wipe", project)).toContain("usage: sessionpipe control folders");
    expect(control().folders).toEqual([project]);
  });
});
