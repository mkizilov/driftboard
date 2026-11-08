/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { manifest } from './src/pwa-manifest';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // The page asks before it switches to a new version; see `PwaBanner`.
      registerType: 'prompt',
      // Registered by hand in `main.tsx` so that the page can show what the worker reports.
      injectRegister: false,
      manifest,
      workbox: {
        // Everything the build produces is cached, so the app opens with no network.
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        // /b/:boardId is a client-side route: any navigation gets the cached app shell.
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  server: { host: '127.0.0.1', port: 22101, strictPort: true },
  preview: { host: '127.0.0.1', port: 22102, strictPort: true },
  test: { environment: 'node' },
});
