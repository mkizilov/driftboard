import type { ManifestOptions } from 'vite-plugin-pwa';

/** The colour of the title bar of the installed app; the same as the ink of the page. */
export const THEME_COLOR = '#26241f';
export const BACKGROUND_COLOR = '#f6f4ee';

/**
 * The web app manifest. Together with a service worker that caches the app (see `vite.config.ts`)
 * and 192 and 512 pixel icons, this is what makes the browser offer to install the app.
 * The icons in `public/` come from `scripts/make-icons.mjs`.
 */
export const manifest: Partial<ManifestOptions> = {
  id: '/',
  name: 'driftboard',
  short_name: 'driftboard',
  description: 'A collaborative sticky-note board that keeps working offline.',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  theme_color: THEME_COLOR,
  background_color: BACKGROUND_COLOR,
  icons: [
    { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
};
