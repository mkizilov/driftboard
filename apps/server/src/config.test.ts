import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

describe('loadConfig', () => {
  it('defaults to loopback, port 22100 and a database under the repo .data directory', () => {
    const config = loadConfig({});
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(22100);
    expect(config.dbPath).toMatch(/\/\.data\/driftboard\.sqlite$/);
  });

  it('honours overrides', () => {
    const config = loadConfig({
      DRIFTBOARD_HOST: '::1',
      DRIFTBOARD_PORT: '22111',
      DRIFTBOARD_DB: '/x/y.sqlite',
    });
    expect(config).toEqual({ host: '::1', port: 22111, dbPath: '/x/y.sqlite' });
  });

  it('rejects an invalid port', () => {
    expect(() => loadConfig({ DRIFTBOARD_PORT: 'abc' })).toThrow(/DRIFTBOARD_PORT/);
  });
});
