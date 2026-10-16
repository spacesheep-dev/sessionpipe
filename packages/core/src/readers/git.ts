// SPDX-License-Identifier: Apache-2.0
// The repo and branch of a folder, from git itself; credentials stripped from the
// remote. Cached per folder for the life of the process (a worker run).
import { execFileSync } from "node:child_process";

const cache = new Map<string, { repo?: string; branch?: string }>();

export function gitFacts(cwd: string | undefined): { repo?: string; branch?: string } {
  if (!cwd) return {};
  const hit = cache.get(cwd);
  if (hit) return hit;
  const run = (args: string[]) => {
    try {
      return execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        timeout: 1500,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return "";
    }
  };
  const out: { repo?: string; branch?: string } = {};
  const repo = run(["remote", "get-url", "origin"]);
  if (repo) out.repo = stripCredentials(repo);
  const branch = run(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch && branch !== "HEAD") out.branch = branch;
  cache.set(cwd, out);
  return out;
}

/** `https://user:token@host/x` → `https://host/x`; `git@github.com:a/b.git` → `github.com/a/b`. */
export function stripCredentials(url: string): string {
  // The ssh forms first: the `git@` they are known by is what the credential strip removes.
  const ssh = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+?)(?:\.git)?$/.exec(url);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  return url
    .replace(/\/\/[^/@]*@/, "//")
    .replace(/^https?:\/\//, "")
    .replace(/\.git$/, "");
}
