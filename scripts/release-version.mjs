// SPDX-License-Identifier: Apache-2.0
// First step of a release (the release workflow, on a push to production). Turns the
// pending changesets into the next version, commits it and pushes it as release/v<version>,
// then says what is left to do: publish (some package is not on npm at that version),
// finish (tags, GitHub release, the PR back to main), bumped (there is a version commit
// that main does not have yet). Writes those to $GITHUB_OUTPUT.
//
// Refuses when production is not on main, and when an earlier release's version bump has
// not come back to main: releasing again from here would publish one version twice or
// skip one. A re-run of the same push picks up the version commit it already pushed.
import { execFileSync } from "node:child_process";
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIRS = ["cli", "core", "receiver", "conformance"];

const sh = (cmd, args) =>
  execFileSync(cmd, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
const readJson = (p) => JSON.parse(readFileSync(path.join(root, p), "utf8"));
const out = (key, value) => {
  console.log(`${key}=${value}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
};
const fail = (message) => {
  console.log(`::error::${message}`);
  process.exit(1);
};
const onNpm = (name, version) => {
  try {
    const shown = execFileSync("npm", ["view", `${name}@${version}`, "version"], {
      cwd: root,
      encoding: "utf8",
      stdio: "pipe",
    });
    return shown.trim() === version;
  } catch {
    return false;
  }
};

const base = sh("git", ["rev-parse", "HEAD"]);
sh("git", ["fetch", "-q", "origin", "main"]);
try {
  sh("git", ["merge-base", "--is-ancestor", base, "FETCH_HEAD"]);
} catch {
  fail(
    `production is at ${base.slice(0, 7)}, which is not on main. Release from main: git push origin origin/main:production`,
  );
}

const pending = readdirSync(path.join(root, ".changeset")).filter((n) => n.endsWith(".md") && n !== "README.md");
if (pending.length) {
  sh("npx", ["changeset", "version"]);
  // Changesets leaves package-lock.json alone, and the lock records each workspace's version.
  const lock = readJson("package-lock.json");
  for (const dir of DIRS) lock.packages[`packages/${dir}`].version = readJson(`packages/${dir}/package.json`).version;
  writeFileSync(path.join(root, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
}
const version = readJson("packages/core/package.json").version;
const branch = `release/v${version}`;

const open = sh("git", ["ls-remote", "--heads", "origin", "release/v*"])
  .split("\n")
  .filter(Boolean)
  .map((line) => line.split("refs/heads/")[1]);
const notBack = (b) =>
  `${b} has not come back to main. If its PR is open, merge it; if ${b.slice("release/".length)} never reached npm, delete the branch. Then push main to production again.`;
const stale = open.filter((b) => b !== branch);
if (stale.length) fail(notBack(stale[0]));

if (open.includes(branch)) {
  // A run for this same push already made the version commit: finish that one.
  sh("git", ["fetch", "-q", "origin", branch]);
  const made = sh("git", ["rev-parse", "FETCH_HEAD"]);
  if (sh("git", ["rev-parse", `${made}^`]) !== base) fail(notBack(branch));
  sh("git", ["reset", "-q", "--hard", made]);
} else if (pending.length) {
  if (DIRS.every((dir) => onNpm(readJson(`packages/${dir}/package.json`).name, version)))
    fail(
      `v${version} is already on npm but main still carries the changesets that made it. Bring that version bump to main, then push main to production again.`,
    );
  sh("git", ["add", "-A", ".changeset", "package-lock.json", ...DIRS.map((dir) => `packages/${dir}`)]);
  sh("git", ["commit", "-q", "-s", "-m", `Release: version packages (${version})`]);
  sh("git", ["push", "-q", "origin", `HEAD:refs/heads/${branch}`]);
}

const names = DIRS.map((dir) => readJson(`packages/${dir}/package.json`).name);
const missing = names.filter((name) => !onNpm(name, version));
const bumped = sh("git", ["rev-parse", "HEAD"]) !== base;
const tagged = sh("git", ["ls-remote", "--tags", "origin", `refs/tags/${names[0]}@${version}`]) !== "";
const finish = missing.length > 0 || bumped || !tagged;
if (!finish)
  console.log(`::notice::Nothing to release: v${version} is on npm and tagged, and there are no changesets.`);
else console.log(`v${version}: ${missing.length ? `publishing ${missing.join(", ")}` : "already on npm, finishing"}`);

out("version", version);
out("publish", missing.length > 0);
out("finish", finish);
out("bumped", bumped);
out("sha", sh("git", ["rev-parse", "HEAD"]));
