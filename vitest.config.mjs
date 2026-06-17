import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only run tests in the project's own source directories.
    // Excludes research/competitors/** which contain third-party test suites.
    include: [
      "scripts/lib/**/*.test.mjs",
      "src/**/*.test.ts",
    ],
  },
});
