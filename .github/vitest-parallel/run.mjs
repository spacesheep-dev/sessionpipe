// SPDX-License-Identifier: Apache-2.0
// Runs this repo's Vitest suite as several processes on one machine, every test exactly once.
//
//   node .github/vitest-parallel/run.mjs              # same tests as `npm test`
//   node .github/vitest-parallel/run.mjs --coverage   # same tests and thresholds as `npm run test:coverage`
//   ... --write-times                                 # also rewrite test-times.json from this run
//
// Most of the suite waits on timers, so 2 processes per CPU overlap those waits. The test names
// always come from collecting the suite in Vitest itself; test-times.json only weights them.
// The step fails if any process fails, writes no report, or runs a different multiset of test
// names than was collected. On Node 22 the repo's own v8 provider checks the coverage of all
// processes together once, with vitest.config.ts's include, reporters and thresholds.
// Anything this was not written for (another Vitest version, a changed test script, fewer than
// 2 CPUs, a collection error) prints a warning and runs the npm script as written.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The Vitest and coverage versions this was checked against; it uses Vitest internals
// (per-file test name patterns, the v8 provider's coverage maps), so another version runs as written.
const TESTED = { vitest: "5.0.3", coverage: "5.0.3" };

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

if (process.argv[2] === "collect") {
  // The CLI's static list does not expand test.each, so collect in Vitest itself.
  const { createVitest } = await import("vitest/node");
  const ctx = await createVitest("test", { config: path.join(root, "vitest.config.ts"), watch: false, reporters: [] });
  try {
    if (ctx.projects.length !== 1 || ctx.projects[0].name || ctx.config.retry || ctx.config.shard)
      throw new Error("a Vitest project, retry or shard setting");
    if (process.argv[4] === "--coverage" && ctx.config.coverage.provider !== "v8")
      throw new Error("a coverage provider other than v8");
    const c = ctx.projects[0].config;
    if (c.sequence.shuffle || c.sequence.concurrent || c.pool === "browser")
      throw new Error("a sequence or pool setting");
    const result = await ctx.collect([], { staticParse: false });
    if (result.unhandledErrors.length || result.testModules.some((m) => m.errors().length))
      throw new Error("collection failed");
    const tests = result.testModules.flatMap((m) =>
      [...m.children.allTests()].map((t) => {
        if (typeof t.task.fullTestName !== "string" || t.options.retry || t.task.mode === "only")
          throw new Error(`unexpected test shape: ${t.fullName}`);
        return {
          file: path.relative(root, m.moduleId),
          name: t.fullName,
          filter: t.task.fullTestName,
          mode: t.task.mode,
        };
      }),
    );
    if (!tests.length) throw new Error("no tests collected");
    write(process.argv[3], tests);
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
const list = path.join(d, "tests.json");
const collectStart = performance.now();
const collection = spawnSync(process.execPath, [self, "collect", list, coverage ? "--coverage" : ""], {
  stdio: "inherit",
});
if (collection.status !== 0) asWritten("collecting the tests failed");
const collectTime = seconds(collectStart);
const tests = read(list);

// Pack by recorded duration (unknown tests count 10 ms). A file stays in one process unless its
// tests add up to more than 10 s; then it is split by test name, identical names together, so
// such a file's tests must not depend on each other or on a fixed path (true of every split file today).
const timings = read(path.join(here, "test-times.json"));
const byFile = new Map();
for (const t of tests) {
  t.ms = timings[key(t)] ?? 10;
  if (!byFile.has(t.file)) byFile.set(t.file, []);
  byFile.get(t.file).push(t);
}
const units = [];
for (const entries of byFile.values()) {
  if (entries.reduce((s, t) => s + t.ms, 0) <= 10000) units.push(entries);
  else {
    const byName = new Map();
    for (const t of entries) {
      if (!byName.has(t.filter)) byName.set(t.filter, []);
      byName.get(t.filter).push(t);
    }
    units.push(...byName.values());
  }
}
const lanes = Array.from({ length: Math.min(cpus * 2, units.length) }, () => ({ ms: 0, tests: [] }));
const unitMs = (u) => u.reduce((s, t) => s + t.ms, 0);
units.sort((a, b) => unitMs(b) - unitMs(a));
for (const u of units) {
  const lane = lanes.reduce((a, b) => (a.ms <= b.ms ? a : b));
  lane.tests.push(...u);
  lane.ms += unitMs(u);
}
const planned = lanes.flatMap((l) => l.tests);
if (!same(tests, planned)) {
  throw new Error("the plan does not hold every collected test once");
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
    const child = spawn(
      process.execPath,
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
const actual = [];
for (let i = 0; i < lanes.length; i++) {
  const report = path.join(d, String(i), "results.json");
  if (!fs.existsSync(report)) {
    console.error(`::error::vitest-parallel: process ${i + 1} wrote no test report`);
    rc = 1;
  } else actual.push(...read(report));
}
if (!same(tests, actual)) {
  console.error("::error::vitest-parallel: the tests that ran differ from the tests collected");
  rc = 1;
}
if (actual.some((t) => !["passed", "failed", "skipped"].includes(t.state))) {
  console.error("::error::vitest-parallel: a test did not finish");
  rc = 1;
}
// A test collected to run may skip itself (ctx.skip()), but must not be left out by its process's filter.
const toRun = tests.filter((t) => t.mode === "run" || t.mode === "queued");
const ran = actual.filter((t) => t.state !== "skipped" || t.skippedItself);
if (!same(toRun, ran)) {
  console.error("::error::vitest-parallel: a test collected to run did not run in its process");
  rc = 1;
}
let coverageTime = "";
if (coverage && rc === 0) {
  const start = performance.now();
  const merged = spawnSync(process.execPath, [path.join(here, "coverage.mjs"), d], { stdio: "inherit" });
  if (merged.status !== 0) rc = 1;
  coverageTime = `, coverage ${seconds(start)}`;
}
if (process.argv.includes("--write-times")) {
  const times = {};
  for (const t of actual) if (t.ms > 100) times[key(t)] = Math.round(t.ms);
  fs.writeFileSync(path.join(here, "test-times.json"), `${JSON.stringify(times, null, 2)}\n`);
}
console.log(
  `vitest-parallel: ${actual.length} of ${tests.length} collected tests ran in ${lanes.length} processes on ${cpus} CPUs; collect ${collectTime}, run ${runTime}${coverageTime}`,
);
process.exitCode = rc;
