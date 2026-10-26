import path from "node:path";
import { defineConfig } from "vitest/config";

// Every package source file is covered whole: a line, branch or function the tests do
// not reach fails the run. Reach it by faking the platform or the one builtin that
// fails; delete what nothing can reach. A number never goes down.
const full = { lines: 100, branches: 100, functions: 100, statements: 100 };

export default defineConfig({
  resolve: {
    alias: {
      "@sessionpipe/core/schema": path.resolve(import.meta.dirname, "packages/core/schema/v1.ts"),
      "@sessionpipe/core/control": path.resolve(import.meta.dirname, "packages/core/src/control/index.ts"),
      "@sessionpipe/core/service": path.resolve(import.meta.dirname, "packages/core/src/service/index.ts"),
      "@sessionpipe/core/version": path.resolve(import.meta.dirname, "packages/core/src/version.ts"),
      "@sessionpipe/core": path.resolve(import.meta.dirname, "packages/core/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "scripts/**/*.test.ts"],
    // Each file starts in a sandbox home; the real one is watched. See the file.
    setupFiles: ["test/sandbox-home.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["packages/*/src/**/*.ts"],
      thresholds: {
        autoUpdate: false,
        "packages/*/src/**": full,
      },
    },
  },
});
