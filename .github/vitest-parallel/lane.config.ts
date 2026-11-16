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
const tests = JSON.parse(fs.readFileSync(path.join(dir, "plan.json"), "utf8"))[index].tests;
const byFile = new Map<string, any[]>();
for (const test of tests) {
  if (!byFile.has(test.file)) byFile.set(test.file, []);
  byFile.get(test.file)!.push(test);
}
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

class LaneSequencer extends BaseSequencer {
  async sort(specs: any[]) {
    for (const spec of specs) {
      const selected = byFile.get(path.relative(process.cwd(), spec.moduleId));
      if (!selected) throw new Error(`unplanned file ${spec.moduleId}`);
      spec.testNamePattern = new RegExp(
        `^(?:${[...new Set(selected.map((t) => t.filter))].map(escapeRegex).join("|")})$`,
      );
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
    const rows: any[] = [];
    for (const m of modules) {
      const file = path.relative(process.cwd(), m.moduleId);
      const selected = new Set(byFile.get(file)!.map((t) => t.filter));
      for (const t of m.children.allTests()) {
        if (selected.has(t.task.fullTestName))
          rows.push({
            file,
            name: t.fullName,
            state: t.result().state,
            skippedItself: t.task.result?.pending === true,
            ms: t.diagnostic()?.duration,
          });
        else if (t.result().state !== "skipped") throw new Error(`unplanned test ran: ${file} ${t.fullName}`);
      }
      // The tests left out here belong to other processes: drop them from the task tree, so the
      // reporters after this one list only this process's tests.
      const prune = (suite: any) => {
        suite.tasks = suite.tasks.filter((t: any) => {
          if (t.type === "test") return selected.has(t.fullTestName);
          prune(t);
          return t.tasks.length > 0;
        });
      };
      prune(m.task);
    }
    fs.writeFileSync(path.join(dir, String(index), "results.json"), JSON.stringify(rows));
  }
}

export default {
  ...repo,
  test: {
    ...repo.test,
    include: [...byFile.keys()],
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
