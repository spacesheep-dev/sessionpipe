// SPDX-License-Identifier: Apache-2.0
// biome-ignore-all lint/suspicious/noExplicitAny: Vitest's sequencer specs, test modules and coverage provider are used untyped here.
// One process of run.mjs: vitest.config.ts with this process's tests selected by file and name.
// Includes, setup files, the environment and the coverage settings stay the repo's own; only the
// thresholds move to the one check over every process's coverage (coverage.mjs).
import fs from "node:fs";
import path from "node:path";
import { BaseSequencer } from "vitest/node";
import repo from "../../vitest.config";

const dir = process.env.VITEST_PARALLEL_DIR ?? "";
const index = Number(process.env.VITEST_PARALLEL_LANE);
const plan: { file: string; in: string[] | null; out: string[] | null }[] = JSON.parse(
  fs.readFileSync(path.join(dir, "plan.json"), "utf8"),
)[index].files;
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const anyOf = (names: string[]) => `(?:${names.map(escapeRegex).join("|")})$`;
// A file's tests in this process: the ones it names (in), or all but the ones it names (out).
const patterns = new Map<string, RegExp | undefined>();
for (const { file, in: names, out } of plan)
  patterns.set(
    file,
    names ? new RegExp(`^${anyOf(names)}`) : out?.length ? new RegExp(`^(?!${anyOf(out)})`) : undefined,
  );

class LaneSequencer extends BaseSequencer {
  async sort(specs: any[]) {
    for (const spec of specs) {
      const file = path.relative(process.cwd(), spec.moduleId);
      if (!patterns.has(file)) throw new Error(`unplanned file ${spec.moduleId}`);
      spec.testNamePattern = patterns.get(file);
    }
    return super.sort(specs);
  }
}

class LaneReporter {
  async onInit(ctx: any) {
    if (!ctx.config.coverage.enabled) return;
    const provider = await ctx.createCoverageProvider();
    if (provider?.name !== "v8" || typeof provider.getCoverageMapForUncoveredFiles !== "function")
      throw new Error("unsupported coverage provider");
    // Coverage of the files this process ran is unchanged. Files no process ran get their zero
    // coverage once, in coverage.mjs, instead of in every process.
    provider.getCoverageMapForUncoveredFiles = async () => provider.createCoverageMap();
  }
  onCoverage(coverage: any) {
    fs.writeFileSync(path.join(dir, String(index), "coverage-map.json"), JSON.stringify(coverage));
  }
  onTestRunEnd(modules: any[]) {
    // Every test each file collected here, the ones this process left to others included, so
    // run.mjs can check that every process running a file saw the same tests and each ran once.
    const tests: any[] = [];
    for (const m of modules) {
      const file = path.relative(process.cwd(), m.moduleId);
      const pattern = patterns.get(file);
      const selected = (t: any) => !pattern || pattern.test(t.fullTestName);
      for (const t of m.children.allTests()) {
        if (!selected(t.task) && t.result().state !== "skipped")
          throw new Error(`unplanned test ran: ${file} ${t.fullName}`);
        tests.push({
          file,
          name: t.fullName,
          filter: t.task.fullTestName,
          selected: selected(t.task),
          mode: t.task.mode,
          retry: t.options.retry ?? 0,
          state: t.result().state,
          skippedItself: t.task.result?.pending === true,
          ms: t.diagnostic()?.duration,
        });
      }
      // The tests left out here belong to other processes: drop them from the task tree, so the
      // reporters after this one list only this process's tests.
      const prune = (suite: any) => {
        suite.tasks = suite.tasks.filter((t: any) => {
          if (t.type === "test") return selected(t);
          prune(t);
          return t.tasks.length > 0;
        });
      };
      prune(m.task);
    }
    const ran = modules.map((m) => path.relative(process.cwd(), m.moduleId));
    fs.writeFileSync(path.join(dir, String(index), "results.json"), JSON.stringify({ modules: ran, tests }));
  }
}

export default {
  ...repo,
  test: {
    ...repo.test,
    include: [...patterns.keys()],
    maxWorkers: 1,
    sequence: { ...repo.test?.sequence, sequencer: LaneSequencer },
    reporters: [new LaneReporter(), ["default", { summary: false }]],
    coverage: {
      ...repo.test?.coverage,
      thresholds: undefined,
      reporter: [],
      reportsDirectory: path.join(dir, String(index), "coverage"),
    },
  },
};
