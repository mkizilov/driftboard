import { describe, expect, it } from 'vitest';
import { DEFAULT_SERVER_PORT, syncUrl } from './config';

describe('syncUrl', () => {
  const page = { protocol: 'http:', hostname: '127.0.0.1' };

  it('uses the sync server’s port on the host that served the page', () => {
    expect(DEFAULT_SERVER_PORT).toBe(22100);
    expect(syncUrl({}, page)).toBe('ws://127.0.0.1:22100/ws');
  });

  it('uses a secure socket for a secure page', () => {
    expect(syncUrl({}, { protocol: 'https:', hostname: 'example.test' })).toBe(
      'wss://example.test:22100/ws',
    );
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
});
