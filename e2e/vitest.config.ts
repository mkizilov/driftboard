import { defineConfig } from 'vitest/config';

// Only the unit tests of the helpers; the Playwright specs in tests/ are run by `playwright test`.
export default defineConfig({
  test: { include: ['support/**/*.test.ts'] },
});
