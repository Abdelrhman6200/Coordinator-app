import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // These suites share one PostgreSQL instance. Running the files in parallel
    // makes cross-file interference look like a product defect, so they run
    // sequentially -- the whole suite is a few seconds either way.
    fileParallelism: false,
    hookTimeout: 30_000,
  },
});
