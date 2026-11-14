import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    fileParallelism: false, // tests share one database
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
