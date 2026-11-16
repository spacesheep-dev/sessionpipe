// SPDX-License-Identifier: Apache-2.0
// Runs this repo's Vitest suite as several processes on one machine, every test exactly once.
//
//   node .github/vitest-parallel/run.mjs              # same tests as `npm test`
//   node .github/vitest-parallel/run.mjs --coverage   # same tests and thresholds as `npm run test:coverage`
//   ... --write-times                                 # also rewrite test-times.json from this run
//
// Most of the suite waits on timers, so 2.5 processes per CPU overlap those waits. The test files
// come from Vitest's own glob; each process collects its files itself, and test-times.json only
// weights them. The step fails if any process fails or writes no report, if the processes that
// ran one file collected different tests in it, or if a test did not run in exactly one process.
// On Node 22 the repo's own v8 provider checks the coverage of all processes together once,
// with vitest.config.ts's include, reporters and thresholds.
// Anything this was not written for (another Vitest version, a changed test script, fewer than
// 2 CPUs, a test with retry or .only) prints a warning and runs the npm script as written.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The Vitest and coverage versions this was checked against; it uses Vitest internals
// (per-file test name patterns, the v8 provider's coverage maps), so another version runs as written.
const TESTED = { vitest: "5.0.3", coverage: "5.0.3" };
// What one more test file costs a process besides its tests (a fresh worker and its imports), in ms.
const FILE_MS = 300;
// A test file with no recorded times (a new one) counts this many ms.
const NEW_FILE_MS = 1000;
// Tests at least this long are listed by name in test-times.json; the rest of a file is one sum.
const LISTED_MS = 20;

const self = fileURLToPath(import.meta.url);
const here = path.dirname(self);
const root = process.cwd();
const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const write = (p, v) => fs.writeFileSync(p, JSON.stringify(v));
const key = (t) => JSON.stringify([t.file, t.name]);
const count = (rows) => {
  const m = new Map();
  for (const t of rows) m.set(key(t), (m.get(key(t)) || 0) + 1);
  return [...m].sort(([a], [b]) => a.localeCompare(b));
};
const same = (a, b) => JSON.stringify(count(a)) === JSON.stringify(count(b));
const seconds = (since) => `${((performance.now() - since) / 1000).toFixed(1)} s`;

if (process.argv[2] === "files") {
  // The files `vitest run` would run, as Vitest globs them, without collecting or running any.
  const { createVitest } = await import("vitest/node");
  const ctx = await createVitest("test", { config: path.join(root, "vitest.config.ts"), watch: false, reporters: [] });
  try {
    if (ctx.projects.length !== 1 || ctx.projects[0].name || ctx.config.retry || ctx.config.shard)
      throw new Error("a Vitest project, retry or shard setting");
    if (process.argv[4] === "--coverage" && ctx.config.coverage.provider !== "v8")
      throw new Error("a coverage provider other than v8");
    const c = ctx.projects[0].config;
    if (c.sequence.shuffle || c.sequence.concurrent || c.pool === "browser" || c.typecheck?.enabled)
      throw new Error("a sequence, pool or typecheck setting");
    const files = (await ctx.getRelevantTestSpecifications([])).map((s) => path.relative(root, s.moduleId));
    if (!files.length || new Set(files).size !== files.length) throw new Error("no test files, or one twice");
    write(process.argv[3], files);
  } finally {
    await ctx.close();
  }
  process.exit(0);
}

const coverage = process.argv.includes("--coverage");
const script = coverage ? "test:coverage" : "test";
const asWritten = (reason) => {
  console.log(`::warning::vitest-parallel: ${reason}; running \`npm run ${script}\` as written`);
  const p = spawnSync("npm", ["run", script], { stdio: "inherit" });
  process.exit(p.status === null ? 1 : p.status);
};
const version = (pkg) => {
  try {
    return read(path.join(root, "node_modules", pkg, "package.json")).version;
  } catch {
    return "missing";
  }
};
const pkg = read(path.join(root, "package.json"));
const cpus = os.availableParallelism();
if (pkg.scripts[script] !== (coverage ? "vitest run --coverage" : "vitest run"))
  asWritten(`the ${script} script is not \`vitest run${coverage ? " --coverage" : ""}\``);
if (pkg.scripts[`pre${script}`] || pkg.scripts[`post${script}`]) asWritten(`a pre${script} or post${script} script`);
if (version("vitest") !== TESTED.vitest) asWritten(`vitest ${version("vitest")}, not ${TESTED.vitest}`);
if (coverage && version("@vitest/coverage-v8") !== TESTED.coverage)
  asWritten(`@vitest/coverage-v8 ${version("@vitest/coverage-v8")}, not ${TESTED.coverage}`);
if (cpus < 2) asWritten(`${cpus} CPU`);

const d = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), "vitest-parallel-"));
const list = path.join(d, "files.json");
const globStart = performance.now();
const glob = spawnSync(process.execPath, [self, "files", list, coverage ? "--coverage" : ""], { stdio: "inherit" });
if (glob.status !== 0) asWritten("listing the test files failed");
const globTime = seconds(globStart);
const files = read(list);

// Weigh each file by its recorded test times. A file heavier than half a process's share is cut
// into pieces: all but one name the tests they run (identical names together); the last runs
// every test the others do not name, so a test missing from test-times.json still runs once.
const times = read(path.join(here, "test-times.json"));
const weight = (file) => {
  const t = times[file];
  return t ? Object.values(t.tests).reduce((s, ms) => s + ms, t.rest) : NEW_FILE_MS;
};
const laneCount = Math.max(2, Math.round(cpus * 2.5));
const share = files.reduce((s, f) => s + weight(f), 0) / laneCount / 2;
const pieces = [];
for (const file of files) {
  const t = times[file];
  if (!t || weight(file) <= share) {
    pieces.push({ file, ms: weight(file), out: [] });
    continue;
  }
  const bins = Array.from({ length: Math.ceil(weight(file) / share) }, () => ({ ms: 0, names: [] }));
  bins[0].ms = t.rest;
  for (const [name, ms] of Object.entries(t.tests).sort(([, a], [, b]) => b - a)) {
    const bin = bins.reduce((a, b) => (a.ms <= b.ms ? a : b));
    bin.names.push(name);
    bin.ms += ms;
  }
  const named = bins.slice(1).filter((b) => b.names.length);
  pieces.push({ file, ms: bins[0].ms, out: named.flatMap((b) => b.names) });
  for (const b of named) pieces.push({ file, ms: b.ms, in: b.names });
}
const lanes = Array.from({ length: Math.min(laneCount, pieces.length) }, () => ({ ms: 0, files: [] }));
pieces.sort((a, b) => b.ms - a.ms);
for (const p of pieces) {
  const lane = lanes.reduce((a, b) => (a.ms <= b.ms ? a : b));
  lane.ms += p.ms + FILE_MS;
  // A process runs each of its files once: two pieces of one file in it run as one.
  const had = lane.files.find((f) => f.file === p.file);
  if (!had) lane.files.push({ file: p.file, in: p.in ?? null, out: p.out ?? null });
  else if (had.in && p.in) had.in.push(...p.in);
  else if (had.in) {
    had.out = p.out.filter((n) => !had.in.includes(n));
    had.in = null;
  } else had.out = had.out.filter((n) => !p.in.includes(n));
}
write(path.join(d, "plan.json"), lanes);

// Every process's exit status, signals included, is checked.
const runStart = performance.now();
const results = await Promise.all(
  lanes.map(async (_, index) => {
    const dir = path.join(d, String(index));
    fs.mkdirSync(dir);
    const fd = fs.openSync(path.join(dir, "run.log"), "w");
    const start = performance.now();
    // `node` from PATH, as `npm test` starts Vitest (its bin's `#!/usr/bin/env node`), so a tool
    // that wraps `node` on PATH (a CI's test-report recorder) sees each process as it sees `npm test`.
    const child = spawn(
      "node",
      [
        path.join(root, "node_modules/vitest/vitest.mjs"),
        "run",
        "--config",
        path.join(here, "lane.config.ts"),
        ...(coverage ? ["--coverage"] : []),
      ],
      {
        env: { ...process.env, VITEST_PARALLEL_DIR: d, VITEST_PARALLEL_LANE: String(index) },
        stdio: ["ignore", fd, fd],
      },
    );
    const rc = await new Promise((resolve) => {
      child.on("error", (e) => {
        console.error(e);
        resolve(1);
      });
      child.on("exit", (code, signal) => resolve(signal || code === null ? 1 : code));
    });
    fs.closeSync(fd);
    console.log(`----- process ${index + 1}/${lanes.length}: exit ${rc}, ${seconds(start)} -----`);
    process.stdout.write(fs.readFileSync(path.join(dir, "run.log")));
    return rc;
  }),
);
const runTime = seconds(runStart);
let rc = results.some((r) => r !== 0) ? 1 : 0;
const fail = (message) => {
  console.error(`::error::vitest-parallel: ${message}`);
  rc = 1;
};
// reports.get(file) holds, for each process that ran the file, every test it collected there.
const reports = new Map(files.map((f) => [f, []]));
for (let i = 0; i < lanes.length; i++) {
  const report = path.join(d, String(i), "results.json");
  if (!fs.existsSync(report)) {
    fail(`process ${i + 1} wrote no test report`);
    continue;
  }
  const { modules, tests } = read(report);
  for (const { file } of lanes[i].files) {
    if (!modules.includes(file)) fail(`process ${i + 1} did not run ${file}`);
    else reports.get(file).push(tests.filter((t) => t.file === file));
  }
}
const collected = [];
const actual = [];
for (const [file, seen] of reports) {
  if (!seen.length) continue;
  if (seen.some((rows) => !same(rows, seen[0]))) fail(`the processes that ran ${file} collected different tests`);
  collected.push(...seen[0]);
  actual.push(...seen.flat().filter((t) => t.selected));
}
if (actual.some((t) => t.retry || t.mode === "only")) asWritten("a test with retry or .only");
if (!same(collected, actual)) fail("a test did not run in exactly one process");
if (actual.some((t) => !["passed", "failed", "skipped"].includes(t.state))) fail("a test did not finish");
// A test collected to run may skip itself (ctx.skip()), but must not be left out by its process's filter.
if (actual.some((t) => (t.mode === "run" || t.mode === "queued") && t.state === "skipped" && !t.skippedItself))
  fail("a test collected to run did not run in its process");
let coverageTime = "";
if (coverage && rc === 0) {
  const start = performance.now();
  const merged = spawnSync(process.execPath, [path.join(here, "coverage.mjs"), d], { stdio: "inherit" });
  if (merged.status !== 0) rc = 1;
  coverageTime = `, coverage ${seconds(start)}`;
}
if (process.argv.includes("--write-times")) {
  const out = {};
  for (const t of [...actual].sort((a, b) => key(a).localeCompare(key(b)))) {
    out[t.file] ??= { rest: 0, tests: {} };
    if (t.ms >= LISTED_MS) out[t.file].tests[t.filter] = Math.round(t.ms);
    else out[t.file].rest += t.ms ?? 0;
  }
  for (const t of Object.values(out)) t.rest = Math.round(t.rest);
  fs.writeFileSync(path.join(here, "test-times.json"), `${JSON.stringify(out, null, 2)}\n`);
}
console.log(
  `vitest-parallel: ${actual.length} of ${collected.length} collected tests ran in ${lanes.length} processes on ${cpus} CPUs; files ${globTime}, run ${runTime}${coverageTime}`,
);
process.exitCode = rc;
