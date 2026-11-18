// SPDX-License-Identifier: Apache-2.0
// The coverage check of run.mjs --coverage: every process's coverage map, merged, goes once
// through the repo's own v8 provider, with vitest.config.ts's include, exclusions, reporters
// and thresholds. Files no test imported are added with zero coverage, so the thresholds see
// every source file. A missing map fails the step.
import fs from "node:fs";
import path from "node:path";
import { createVitest } from "vitest/node";

const ctx = await createVitest("test", {
  config: path.resolve("vitest.config.ts"),
  watch: false,
  reporters: [],
  coverage: { enabled: true },
});
try {
  await ctx.initCoverageProvider();
  const provider = ctx.coverageProvider;
  if (provider?.name !== "v8") throw new Error("unsupported coverage provider");
  const coverage = provider.createCoverageMap();
  const dir = process.argv[2];
  const plan = JSON.parse(fs.readFileSync(path.join(dir, "plan.json"), "utf8"));
  for (let i = 0; i < plan.length; i++) {
    coverage.merge(JSON.parse(fs.readFileSync(path.join(dir, String(i), "coverage-map.json"), "utf8")));
  }
  coverage.merge(await provider.getCoverageMapForUncoveredFiles(coverage.files()));
  coverage.filter(
    (filename) => fs.existsSync(filename) && (!provider.options.excludeAfterRemap || provider.isIncluded(filename)),
  );
  // Writes the text and lcov reports and sets a failing exit code when a threshold is not met.
  await provider.generateReports(coverage, true);
} finally {
  await ctx.close();
}
