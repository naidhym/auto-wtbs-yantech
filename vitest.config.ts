import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The suite opens many node:sqlite databases and imports the heavy `telegram`
    // graph. Running every test file at full parallelism oversubscribes CPU/IO and
    // pushes a few DB-heavy tests past the per-test timeout under load. Cap the worker
    // count so each heavy test stays well-fed with resources (not a timeout bump).
    maxWorkers: 2,
    coverage: {
      reporter: ['text', 'html'],
    },
  },
});
