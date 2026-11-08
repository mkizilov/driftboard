import { describe, expect, it } from 'vitest';
import { DEFAULT_SERVER_PORT, syncUrl } from './config';

describe('syncUrl', () => {
  const page = { protocol: 'http:', hostname: '127.0.0.1', host: '127.0.0.1:22101' };

  it('uses the sync server’s port on the host that served the page', () => {
    expect(DEFAULT_SERVER_PORT).toBe(22100);
    expect(syncUrl({}, page)).toBe('ws://127.0.0.1:22100/ws');
  });

  it('uses a secure socket for a secure page', () => {
    const secure = { protocol: 'https:', hostname: 'example.test', host: 'example.test' };
    expect(syncUrl({}, secure)).toBe('wss://example.test:22100/ws');
  });

  it('lets VITE_SYNC_URL decide when it is set', () => {
    expect(syncUrl({ VITE_SYNC_URL: 'wss://sync.example.test/ws' }, page)).toBe(
      'wss://sync.example.test/ws',
    );
  });

  it('ignores an empty VITE_SYNC_URL', () => {
    expect(syncUrl({ VITE_SYNC_URL: '' }, page)).toBe('ws://127.0.0.1:22100/ws');
    expect(syncUrl({ VITE_SYNC_URL: undefined }, page)).toBe('ws://127.0.0.1:22100/ws');
  });

  describe('with a path, as the production build has it', () => {
    it('is that path on the origin of the page, port included', () => {
      const published = { protocol: 'http:', hostname: '127.0.0.1', host: '127.0.0.1:22160' };
      expect(syncUrl({ VITE_SYNC_URL: '/ws' }, published)).toBe('ws://127.0.0.1:22160/ws');
    });

    it('is secure behind https, and has no port when the page has none', () => {
      const behindProxy = {
        protocol: 'https:',
        hostname: 'board.example.test',
        host: 'board.example.test',
      };
      expect(syncUrl({ VITE_SYNC_URL: '/ws' }, behindProxy)).toBe('wss://board.example.test/ws');
    });
  });
});
