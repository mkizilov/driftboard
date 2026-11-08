import { defineConfig } from '@playwright/test';
import { SYNC_URL, WEB_PORT, WEB_URL } from './support/env';

// The web app is the production build, served by `vite preview`, told where the sync server is.
// It goes to its own folder so that it does not replace the build in apps/web/dist.
const vite = 'pnpm --filter @driftboard/web exec vite';
const bundle = '../../e2e/dist/web';

export default defineConfig({
  testDir: './tests',
  testMatch: '*.spec.ts',
  // One worker: the tests share one sync server, and the restart tests stop it.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: process.env['CI'] !== undefined,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: `${vite} build --outDir ${bundle} --emptyOutDir && ${vite} preview --outDir ${bundle} --port ${WEB_PORT} --strictPort`,
    cwd: '..',
    env: { VITE_SYNC_URL: SYNC_URL },
    url: WEB_URL,
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
