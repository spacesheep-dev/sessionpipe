// SPDX-License-Identifier: Apache-2.0
// shell.ts and refusal.ts: a word of a command printed for a person to paste, and the
// error that carries its own next command.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Refusal } from "../src/refusal.js";
import { shq, shqPath } from "../src/shell.js";

describe("a word of a printed command", () => {
  it("is left alone when a shell would read it as it stands", () => {
    for (const w of ["sessionpipe", "/usr/local/lib", "https://r.example:8443/x", "a_b@c%d+e=f,g", "x~y", "a-b"])
      expect(shq(w, "darwin")).toBe(w);
  });

  it("is quoted when it starts with what a shell expands at the start of a word", () => {
    // `~root` is root's home in every shell; zsh reads `=ls` as the path of `ls`.
    expect(shq("~root", "darwin")).toBe("'~root'");
    expect(shq("~", "linux")).toBe("'~'");
    expect(shq("~/x", "linux")).toBe("'~/x'");
    expect(shq("=ls", "darwin")).toBe("'=ls'");
  });

  it("is quoted when it holds a space, a quote, a `$` or anything else a shell acts on", () => {
    expect(shq("/Users/me/My Projects/x", "linux")).toBe("'/Users/me/My Projects/x'");
    expect(shq("it's", "linux")).toBe(`'it'\\''s'`);
    expect(shq("$(rm -rf ~)", "darwin")).toBe("'$(rm -rf ~)'");
    expect(shq("a;b&&c|d>e`f`", "darwin")).toBe("'a;b&&c|d>e`f`'");
    expect(shq("", "darwin")).toBe("''");
    // A word that starts like an option is quoted, so it reads as the value it is.
    expect(shq("-rf", "darwin")).toBe("'-rf'");
  });

  it("uses double quotes where the shell is cmd or PowerShell; this platform's by default", () => {
    expect(shq("C:\\Program Files\\x", "win32")).toBe('"C:\\Program Files\\x"');
    expect(shq('say "hi"', "win32")).toBe('"say ""hi"""');
    expect(shq("a b")).toBe(process.platform === "win32" ? '"a b"' : "'a b'");
  });
});

describe("what a shell makes of it", () => {
  // The words nobody chooses for a folder, and some people do.
  const hostile = [
    "/Users/Mary Ann/My Projects",
    "it's",
    "'; touch pwned; '",
    "$(touch pwned)",
    "`touch pwned`",
    "a;touch pwned&&b|c>pwned",
    ["$HOME $", "{PATH} !! \\ * ? ~"].join(""),
    'say "hi"',
    "-rf",
    "~root",
    "=ls",
    "",
    "line\nbreak",
  ];

  it.runIf(process.platform !== "win32")("sh hands the program each word as it was, and runs nothing in it", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "sp-shq-"));
    try {
      for (const word of hostile) {
        // What a person pastes: the command with the word in it, read by a real sh.
        const seen = execFileSync("/bin/sh", ["-c", `printf '%s|' first ${shq(word, "linux")} last`], {
          cwd: dir,
          encoding: "utf8",
        });
        expect(seen).toBe(`first|${word}|last|`);
      }
      expect(existsSync(path.join(dir, "pwned"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a file or folder in a printed command", () => {
  it("keeps its short form under the home folder, where a shell reads that as it stands", () => {
    const home = path.join(path.sep, "home", "me");
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    try {
      expect(shqPath(path.posix.join("/home/me", ".claude-second"), "linux")).toBe(
        process.platform === "win32" ? "/home/me/.claude-second" : "~/.claude-second",
      );
      expect(shqPath("/var/log/x.log", "linux")).toBe("/var/log/x.log");
      // The home folder itself; and a folder under it whose name starts like an option is
      // given whole, since `~/-x` would need quotes and a quoted `~` is not the home folder.
      expect(shqPath(home, "linux")).toBe("~");
      expect(shqPath(path.posix.join("/home/me", "-x"), "linux")).toBe("/home/me/-x");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("is the whole path in quotes when a shell would act on it: a quoted ~ is not the home folder", () => {
    const home = path.join(path.sep, "home", "me");
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    try {
      const odd = path.join(home, "My Claude's $(x)");
      expect(shqPath(odd, "linux")).toBe(`'${odd.replace(/'/g, `'\\''`)}'`);
      expect(shqPath(odd, "linux")).not.toContain("~");
      expect(shqPath("C:\\Users\\Mary Ann\\.claude-second", "win32")).toBe('"C:\\Users\\Mary Ann\\.claude-second"');
      // This platform's quotes by default.
      expect(shqPath("/tmp/a b")).toBe(process.platform === "win32" ? '"/tmp/a b"' : "'/tmp/a b'");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("a refusal", () => {
  it("is an error that names the one command to run next", () => {
    const r = new Refusal("npm can't write the prefix", "sessionpipe update");
    expect(r).toBeInstanceOf(Error);
    expect(r.message).toBe("npm can't write the prefix");
    expect(r.next).toBe("sessionpipe update");
  });

  it("L10: by itself it is neither in line nor mild; the caller says that its message leaves the command out, and that it is only what is left to do", () => {
    const plain = new Refusal("npm can't write the prefix", "sessionpipe update");
    expect([plain.inLine, plain.mild]).toEqual([false, false]);
    // In line alone: the one line a pipe gets ends with the command; it is still an error.
    const inLine = new Refusal("npm can't write the prefix", "sessionpipe update", true);
    expect([inLine.inLine, inLine.mild]).toEqual([true, false]);
    // What `reinstall` ends with where a copy is still there: the job done as far as it
    // goes, and one line left for the person.
    const left = new Refusal(
      "One other copy is still there: 0.9.0 in /usr/local (needs sudo)",
      "sudo rm -r /x",
      true,
      true,
    );
    expect(left).toBeInstanceOf(Error);
    expect([left.message, left.next, left.inLine, left.mild]).toEqual([
      "One other copy is still there: 0.9.0 in /usr/local (needs sudo)",
      "sudo rm -r /x",
      true,
      true,
    ]);
    expect([new Refusal("m", "n", false, true).inLine, new Refusal("m", "n", false, true).mild]).toEqual([false, true]);
  });
});
