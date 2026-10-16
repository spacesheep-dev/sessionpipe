// SPDX-License-Identifier: Apache-2.0
// The file readers (the ends of a large file, a line scan that stops early, recent
// files under a root) and the git facts of a folder with its remote's credentials
// stripped.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ends, parseLines, recentFiles, scanLines } from "../src/readers/files.js";
import { gitFacts, stripCredentials } from "../src/readers/git.js";

const dirs: string[] = [];
const fresh = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "sp-readers-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("ends", () => {
  it("a small file: every whole line, head and tail alike", () => {
    const f = path.join(fresh(), "small.jsonl");
    writeFileSync(f, "a\nb\nc\n");
    expect(ends(f, 1024, 1024)).toEqual({ head: ["a", "b", "c"], tail: ["a", "b", "c", ""] });
    writeFileSync(f, "a\nb\npartial");
    expect(ends(f, 1024, 1024)).toEqual({ head: ["a", "b"], tail: ["a", "b", "partial"] });
  });
  it("a large file: the head's whole lines, the tail without its first cut line", () => {
    const f = path.join(fresh(), "big.jsonl");
    const lines = Array.from({ length: 100 }, (_, i) => `line-${String(i).padStart(4, "0")}-${"x".repeat(50)}`);
    writeFileSync(f, `${lines.join("\n")}\n`);
    const r = ends(f, 200, 300);
    expect(r.head.length).toBeGreaterThan(0);
    expect(r.head).toEqual(lines.slice(0, r.head.length));
    expect(r.tail[r.tail.length - 1]).toBe("");
    const whole = r.tail.slice(0, -1);
    expect(whole).toEqual(lines.slice(lines.length - whole.length));
  });
  it("a missing file is empty", () => {
    expect(ends(path.join(fresh(), "none"), 10, 10)).toEqual({ head: [], tail: [] });
  });
});

describe("parseLines", () => {
  it("keeps what parses", () => {
    expect(parseLines(['{"a":1}', "junk", "", "null", "[1]"])).toEqual([{ a: 1 }, [1]]);
  });
});

describe("scanLines", () => {
  it("visits lines in order and stops at the first answer", () => {
    const f = path.join(fresh(), "scan.txt");
    writeFileSync(f, "one\ntwo\nthree\n");
    const seen: string[] = [];
    expect(
      scanLines(f, (l) => {
        seen.push(l);
        return l === "two" ? l.toUpperCase() : null;
      }),
    ).toBe("TWO");
    expect(seen).toEqual(["one", "two"]);
    expect(scanLines(f, () => null)).toBeNull();
  });
  it("carries a line across a read chunk and does not read past the cap", () => {
    const f = path.join(fresh(), "chunks.txt");
    const line = "y".repeat(300_000);
    writeFileSync(f, `${[line, line, line, line, "needle"].join("\n")}\n`);
    let n = 0;
    expect(
      scanLines(f, (l) => {
        n++;
        if (l !== "needle") expect(l).toBe(line);
        return l === "needle" ? n : null;
      }),
    ).toBe(5);
    expect(scanLines(f, (l) => (l === "needle" ? 1 : null), 1024)).toBeNull();
  });
  it("a missing file is null", () => {
    expect(scanLines(path.join(fresh(), "none"), () => 1)).toBeNull();
  });
});

describe("recentFiles", () => {
  it("walks to the depth given, matches by name, keeps what changed since", () => {
    const root = fresh();
    mkdirSync(path.join(root, "a", "b", "c"), { recursive: true });
    const touch = (p: string, ageMs = 0) => {
      writeFileSync(p, "x");
      const t = (Date.now() - ageMs) / 1000;
      utimesSync(p, t, t);
    };
    touch(path.join(root, "top.jsonl"));
    touch(path.join(root, "a", "one.jsonl"));
    touch(path.join(root, "a", "b", "two.jsonl"));
    touch(path.join(root, "a", "b", "c", "deep.jsonl"));
    touch(path.join(root, "a", "old.jsonl"), 3_600_000);
    touch(path.join(root, "a", "notes.txt"));
    symlinkSync(path.join(root, "gone"), path.join(root, "a", "dangling.jsonl"));
    const since = Date.now() - 60_000;
    const got = recentFiles(root, 2, since, (n) => n.endsWith(".jsonl")).sort();
    expect(got).toEqual(
      [path.join(root, "top.jsonl"), path.join(root, "a", "one.jsonl"), path.join(root, "a", "b", "two.jsonl")].sort(),
    );
    expect(recentFiles(root, 0, since, () => true)).toEqual([path.join(root, "top.jsonl")]);
  });
  it("a missing root is empty", () => {
    expect(recentFiles(path.join(fresh(), "none"), 3, 0, () => true)).toEqual([]);
  });
});

describe("stripCredentials", () => {
  it("drops user:token, turns ssh forms into host/path, loses the scheme and .git", () => {
    expect(stripCredentials("https://user:ghp_x@github.com/a/b.git")).toBe("github.com/a/b");
    expect(stripCredentials("https://token@gitlab.com/g/r")).toBe("gitlab.com/g/r");
    expect(stripCredentials("http://example.com/a/b.git")).toBe("example.com/a/b");
    expect(stripCredentials("git@github.com:a/b.git")).toBe("github.com/a/b");
    expect(stripCredentials("git@github.com:a/b")).toBe("github.com/a/b");
    expect(stripCredentials("ssh://git@host.example/a/b.git")).toBe("host.example/a/b");
    expect(stripCredentials("/srv/git/repo.git")).toBe("/srv/git/repo");
  });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

describe("gitFacts", () => {
  it("nothing without a folder, nothing in a folder that is not a repo, cached per folder", () => {
    expect(gitFacts(undefined)).toEqual({});
    expect(gitFacts("")).toEqual({});
    const plain = fresh();
    const first = gitFacts(plain);
    expect(first).toEqual({});
    expect(gitFacts(plain)).toBe(first);
  });
  it("the origin with credentials stripped; the branch once there is one; none on a detached HEAD", () => {
    const unborn = fresh();
    git(unborn, "init", "-q");
    git(unborn, "remote", "add", "origin", "https://me:ghp_secret@github.com/me/repo.git");
    expect(gitFacts(unborn)).toEqual({ repo: "github.com/me/repo" });

    const onBranch = fresh();
    git(onBranch, "init", "-q", "-b", "work");
    git(onBranch, "commit", "-q", "--allow-empty", "-m", "x");
    expect(gitFacts(onBranch)).toEqual({ branch: "work" });

    const detached = fresh();
    git(detached, "init", "-q", "-b", "main");
    git(detached, "remote", "add", "origin", "git@github.com:me/other.git");
    git(detached, "commit", "-q", "--allow-empty", "-m", "x");
    git(detached, "checkout", "-q", "--detach");
    expect(gitFacts(detached)).toEqual({ repo: "github.com/me/other" });
  }, 30_000);
});
