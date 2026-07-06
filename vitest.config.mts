import { defineConfig } from "vitest/config";

export default defineConfig({
  cacheDir: ".vite",
  test: {
    globals: false,
    maxWorkers: 6,
    pool: "forks",
    testTimeout: 45_000
  }
});
