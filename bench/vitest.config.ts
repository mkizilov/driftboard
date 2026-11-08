import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['src/**/*.test.ts'] },
  // `vitest bench` runs the heavy scenarios once each: they are too big to repeat for statistics.
  benchmark: { include: ['src/**/*.bench.ts'] },
});
