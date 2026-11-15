import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Integration suites share the dedicated local/CI database and reset it between cases.
    fileParallelism: false,
  },
});
