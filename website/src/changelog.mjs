// SPDX-License-Identifier: Apache-2.0
// The changelog, read from what Changesets already writes: packages/*/CHANGELOG.md for
// the releases (the four packages release in lockstep, so one entry appears in each
// package it touched and is shown once) and .changeset/*.md for what the next release
// will carry. Dates come from git: the commit that wrote a "## x.y.z" heading, the
// commit that added a changeset. A shallow clone has no such history, so it gets none.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const PACKAGES = ["cli", "core", "receiver", "conformance"];
const BUMPS = ["patch", "minor", "major"];

function git(root, args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 << 20,
    });
  } catch {
    return null;
  }
}

/** "## 0.8.0" line → the date of the commit that wrote it, per `git blame`. */
function releaseDates(root, file, dates) {
  const out = git(root, ["blame", "--porcelain", "--", file]);
  if (out === null) return;
  const times = new Map();
  let sha = "";
  for (const line of out.split("\n")) {
    const head = /^([0-9a-f]{40}) \d+ \d+/.exec(line);
    if (head) sha = head[1];
    else if (line.startsWith("committer-time ")) times.set(sha, Number(line.slice(15)));
    else if (line.startsWith("committer-tz ")) {
      // The day it was on the committer's own clock, as the release tags have it.
      const [, sign, h, m] = /([+-])(\d\d)(\d\d)/.exec(line);
      times.set(sha, times.get(sha) + (sign === "-" ? -1 : 1) * (h * 3600 + m * 60));
    } else if (line.startsWith("\t## ")) {
      const version = line.slice(4).trim();
      const date = new Date(times.get(sha) * 1000).toISOString().slice(0, 10);
      if (!dates.has(version) || date < dates.get(version)) dates.set(version, date);
    }
  }
}

/** One Changesets CHANGELOG.md → [{version, bump, hash, text}]. */
function parseChangelog(md) {
  const entries = [];
  let version = null;
  let bump = null;
  let cur = null;
  for (const line of md.split("\n")) {
    if (line.startsWith("## ")) {
      version = line.slice(3).trim();
      cur = null;
    } else if (line.startsWith("### ")) {
      bump = /major/i.test(line) ? "major" : /minor/i.test(line) ? "minor" : "patch";
      cur = null;
    } else if (line.startsWith("- ") && version) {
      const m = /^- ([0-9a-f]{7,40}): (.*)$/.exec(line);
      cur = m ? { version, bump, hash: m[1], lines: [m[2]] } : null; // "Updated dependencies" has no hash
      if (cur) entries.push(cur);
    } else if (cur) {
      cur.lines.push(line.replace(/^ {2}/, ""));
    }
  }
  return entries.map(({ lines, ...e }) => ({ ...e, text: lines.join("\n").trim() }));
}

/** The first sentence, outside code spans and parentheses, and the rest. */
export function splitLead(text) {
  let code = false;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "`") code = !code;
    else if (code) continue;
    else if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === "\n" && text[i + 1] === "\n" && depth === 0) {
      return [text.slice(0, i).trim(), text.slice(i).trim()];
    } else if (c === "." && depth === 0 && /^\s+[A-Z`"]/.test(text.slice(i + 1, i + 3))) {
      if (/\b(e\.g|i\.e|vs|etc)$/.test(text.slice(Math.max(0, i - 4), i))) continue;
      return [text.slice(0, i + 1).trim(), text.slice(i + 1).trim()];
    }
  }
  return [text.trim(), ""];
}

function nextVersion(current, bump) {
  const [maj, min, pat] = current.split(".").map(Number);
  if (bump === "major") return maj === 0 ? `0.${min + 1}.0` : `${maj + 1}.0.0`;
  if (bump === "minor") return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

/** {current, dated, next: {version, entries}, releases: [{version, date, entries}]} */
export function loadChangelog(root) {
  const shallow = git(root, ["rev-parse", "--is-shallow-repository"]);
  const dated = shallow !== null && shallow.trim() === "false";
  const dates = new Map();
  const byKey = new Map();
  for (const pkg of PACKAGES) {
    const file = `packages/${pkg}/CHANGELOG.md`;
    if (dated) releaseDates(root, file, dates);
    for (const e of parseChangelog(readFileSync(path.join(root, file), "utf8"))) {
      const key = `${e.version} ${e.hash}`;
      if (byKey.has(key)) byKey.get(key).packages.push(pkg);
      else byKey.set(key, { ...e, packages: [pkg] });
    }
  }
  const releases = new Map();
  for (const e of byKey.values()) {
    if (!releases.has(e.version))
      releases.set(e.version, { version: e.version, date: dates.get(e.version) ?? null, entries: [] });
    releases.get(e.version).entries.push(e);
  }
  const semver = (v) => v.split(".").map(Number);
  const sorted = [...releases.values()].sort((a, b) => {
    const [x, y] = [semver(a.version), semver(b.version)];
    return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
  });
  for (const r of sorted) r.entries.sort((a, b) => BUMPS.indexOf(b.bump) - BUMPS.indexOf(a.bump));

  // Pending changesets: the commit that added each file gives its hash and date.
  const added = new Map();
  const log = dated
    ? git(root, ["log", "--diff-filter=A", "--format=%x00%h %cs", "--name-only", "--", ".changeset"])
    : null;
  for (const block of (log ?? "").split("\0").slice(1)) {
    const [head, ...files] = block.trim().split("\n");
    const [hash, date] = head.split(" ");
    for (const f of files) if (!added.has(path.basename(f))) added.set(path.basename(f), { hash, date }); // newest add wins
  }
  const current = JSON.parse(readFileSync(path.join(root, "packages/core/package.json"), "utf8")).version;
  const pending = [];
  const dir = path.join(root, ".changeset");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "README.md")) {
    const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(readFileSync(path.join(dir, f), "utf8"));
    if (!m) continue;
    const pkgs = [...m[1].matchAll(/"sessionpipe(?:-([a-z]+))?":\s*(major|minor|patch)/g)];
    const bump = pkgs.map((p) => p[2]).sort((a, b) => BUMPS.indexOf(b) - BUMPS.indexOf(a))[0] ?? "patch";
    const a = added.get(f) ?? { hash: null, date: null };
    pending.push({ bump, hash: a.hash, date: a.date, packages: pkgs.map((p) => p[1] ?? "cli"), text: m[2].trim() });
  }
  pending.sort((x, y) => BUMPS.indexOf(y.bump) - BUMPS.indexOf(x.bump) || (y.date ?? "").localeCompare(x.date ?? ""));
  const top = pending.map((p) => p.bump).sort((a, b) => BUMPS.indexOf(b) - BUMPS.indexOf(a))[0];
  return {
    current,
    dated,
    next: pending.length ? { version: nextVersion(current, top), entries: pending } : null,
    releases: sorted,
  };
}
