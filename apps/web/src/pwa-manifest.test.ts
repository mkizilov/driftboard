import { describe, expect, it } from 'vitest';
import { BACKGROUND_COLOR, THEME_COLOR, manifest } from './pwa-manifest';

describe('web app manifest', () => {
  it('names the app and opens it as a standalone window at the root', () => {
    expect(manifest).toMatchObject({
      name: 'driftboard',
      short_name: 'driftboard',
      start_url: '/',
      scope: '/',
      display: 'standalone',
    });
    expect(manifest.description).not.toBe('');
  });

  it('uses colours that are valid hex and the ones in the theme', () => {
    expect(THEME_COLOR).toMatch(/^#[0-9a-f]{6}$/);
    expect(BACKGROUND_COLOR).toMatch(/^#[0-9a-f]{6}$/);
    expect(manifest.theme_color).toBe(THEME_COLOR);
    expect(manifest.background_color).toBe(BACKGROUND_COLOR);
  });

  it('has the icons a browser needs before it offers to install: 192 and 512 pixels, and a maskable one', () => {
    const icons = manifest.icons ?? [];
    const has = (size: string, purpose: string) =>
      icons.some((icon) => icon.sizes === size && icon.purpose === purpose);
    expect(has('192x192', 'any')).toBe(true);
    expect(has('512x512', 'any')).toBe(true);
    expect(has('512x512', 'maskable')).toBe(true);
  });

  it('names each icon file after its size, and uses PNG', () => {
    for (const icon of manifest.icons ?? []) {
      const side = icon.sizes?.split('x')[0];
      expect(icon.src).toContain(`${side}.png`);
      expect(icon.type).toBe('image/png');
    }
  });
});
