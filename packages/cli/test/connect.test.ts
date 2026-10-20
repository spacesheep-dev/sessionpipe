// SPDX-License-Identifier: Apache-2.0
// `sessionpipe connect` decides three things nobody is asked about: which folders a
// message may run in (never home), the tier (2 unless said), and what to do with the
// key a receiver hands over at pairing (keep one the sink has). And a Linux daemon is
// kept running past logout.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readConfig } from "@sessionpipe/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectFolders, connectTier, isBroad } from "../src/connect.js";
import { adoptSinkToken } from "../src/control/cli.js";
import { ensureLinger } from "../src/control/pair.js";

const home = "/home/me";

// POSIX paths throughout; the rule is the same on Windows, the spelling is not.
describe.skipIf(process.platform === "win32")("folders", () => {
  const base = { home, flags: [], existing: [], recent: [] };

  it("never the home folder or anything above it", () => {
    for (const d of ["/home/me", "/home", "/", "/home/me/"]) expect(isBroad(d, home)).toBe(true);
    expect(isBroad("/home/me/code", home)).toBe(false);
    expect(isBroad("/home/meme", home)).toBe(false);
  });

  it("flags first, then the machine's own list, then the folder it ran in", () => {
    expect(connectFolders({ ...base, cwd: "/home/me/a", flags: ["/srv/x"] })).toEqual({
      folders: ["/srv/x"],
      from: "flags",
    });
    expect(connectFolders({ ...base, cwd: "/home/me/a", existing: ["/srv/y"] })).toEqual({
      folders: [],
      from: "existing",
    });
    expect(connectFolders({ ...base, cwd: "/home/me/a" })).toEqual({ folders: ["/home/me/a"], from: "here" });
  });

  it("run from home: the folders recent sessions ran in, newest first, wider ones absorbing narrower", () => {
    const c = connectFolders({
      ...base,
      cwd: "/home/me",
      recent: [
        "/home/me/spacesheep/.claude/worktrees/x",
        "/home/me/notes",
        "/home/me",
        "/home/me/spacesheep",
        "/home/me/notes",
        "relative/path",
      ],
    });
    expect(c).toEqual({ folders: ["/home/me/notes", "/home/me/spacesheep"], from: "recent" });
  });

  it("a folder inside one already picked adds nothing, and the list stops at `max`", () => {
    const recent = ["/home/me/spacesheep", "/home/me/spacesheep/packages/cli", "/home/me/notes", "/home/me/more"];
    expect(connectFolders({ ...base, cwd: "/home/me", recent }).folders).toEqual([
      "/home/me/spacesheep",
      "/home/me/notes",
      "/home/me/more",
    ]);
    expect(connectFolders({ ...base, cwd: "/home/me", recent, max: 2 }).folders).toEqual([
      "/home/me/spacesheep",
      "/home/me/notes",
    ]);
  });

  it("run from home with no other session folder: none, rather than all of home", () => {
    expect(connectFolders({ ...base, cwd: "/home/me", recent: ["/home/me", "/"] })).toEqual({
      folders: [],
      from: "none",
    });
    expect(connectFolders({ ...base, cwd: "/home/me", recent: ["/gone"], exists: () => false }).from).toBe("none");
  });
});

describe("tier", () => {
  it("2 by default, --tier when given, never lowering a sink set to 3", () => {
    expect(connectTier(undefined, undefined)).toBe(2);
    expect(connectTier(undefined, 0)).toBe(2);
    expect(connectTier(undefined, 3)).toBe(3);
    expect(connectTier("0", 3)).toBe(0);
    expect(connectTier("9", 0)).toBe(3);
  });
});

describe("the key handed over at pairing", () => {
  let tmp: string;
  let file: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "sp-adopt-"));
    file = path.join(tmp, "config.json");
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));
  const write = (sinks: unknown[]) => writeFileSync(file, JSON.stringify({ sinks, harnesses: {} }));

  it("a new sink at the tier asked for", () => {
    write([]);
    expect(adoptSinkToken("https://rx.dev", "ss_new", 2, file)).toBe("added");
    expect(readConfig(file).sinks).toEqual([
      expect.objectContaining({ name: "rx.dev", url: "https://rx.dev", tier: 2, token: "ss_new" }),
    ]);
  });

  it("a sink that lost its key gets this one; a sink with a key (or one in a keychain) keeps its own", () => {
    write([{ name: "rx.dev", url: "https://rx.dev", tier: 2, pii: false }]);
    expect(adoptSinkToken("https://rx.dev", "ss_new", 0, file)).toBe("filled");
    expect(readConfig(file).sinks[0]).toMatchObject({ tier: 2, token: "ss_new" });
    expect(adoptSinkToken("https://rx.dev", "ss_other", 0, file)).toBe("kept");
    expect(readConfig(file).sinks[0]?.token).toBe("ss_new");
    write([{ name: "rx.dev", url: "https://rx.dev/", tier: 2, token_in: "keychain" }]);
    expect(adoptSinkToken("https://rx.dev", "ss_other", 0, file)).toBe("kept");
  });
});

describe("linger", () => {
  it("on already: nothing to do", () => {
    const calls: string[][] = [];
    const r = ensureLinger("me", (cmd, args) => {
      calls.push([cmd, ...args]);
      return "Linger=yes\n";
    });
    expect(r.on).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("off: turns it on for yourself", () => {
    let on = false;
    const r = ensureLinger("me", (_cmd, args) => {
      if (args[0] === "enable-linger") on = true;
      return `Linger=${on ? "yes" : "no"}\n`;
    });
    expect(r).toMatchObject({ on: true });
  });

  it("refused: says the one command that does it", () => {
    const r = ensureLinger("me", (_cmd, args) => {
      if (args[0] === "enable-linger") throw new Error("Access denied");
      return "Linger=no\n";
    });
    expect(r.on).toBe(false);
    expect(r.note).toContain("sudo loginctl enable-linger me");
  });
});
