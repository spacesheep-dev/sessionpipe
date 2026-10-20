import path from "node:path";
import { defineConfig } from "vitest/config";

// The floor is what the tests reach today, short of platform branches (Linux /proc,
// win32 paths), fallbacks after a regex group that always participates, and WebCrypto
// throw paths. The floor is read from the CI runner, which has no harness CLI installed,
// so a Linux-only or Mac-only arm counts there. Raise a number when a test reaches it;
// never lower one.
const full = { lines: 100, branches: 100, functions: 100, statements: 100 };

export default defineConfig({
  resolve: {
    alias: {
      "@sessionpipe/core/schema": path.resolve(import.meta.dirname, "packages/core/schema/v1.ts"),
      "@sessionpipe/core/control": path.resolve(import.meta.dirname, "packages/core/src/control/index.ts"),
      "@sessionpipe/core": path.resolve(import.meta.dirname, "packages/core/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "scripts/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["packages/*/src/**/*.ts"],
      thresholds: {
        autoUpdate: false,
        "packages/core/src/adapters/**": { lines: 98, branches: 97, functions: 98, statements: 98 },
        "packages/core/src/privacy/**": { lines: 100, branches: 97, functions: 100, statements: 99 },
        "packages/core/src/readers/**": { lines: 100, branches: 99, functions: 100, statements: 100 },
        "packages/core/src/sinks/**": full,
        "packages/core/src/outbox.ts": { lines: 100, branches: 97, functions: 100, statements: 100 },
        "packages/cli/src/http-sink.ts": { lines: 100, branches: 97, functions: 100, statements: 100 },
        "packages/core/src/{*.ts,control/**}": { lines: 95, branches: 95, functions: 95, statements: 95 },
      },
    },
  },
});
