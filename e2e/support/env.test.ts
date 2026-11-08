import { describe, expect, it } from 'vitest';
import { browsersFromEnv, portFromEnv } from './env';

describe('portFromEnv', () => {
  it('uses the fallback when the variable is missing or empty', () => {
    expect(portFromEnv('E2E_SYNC_PORT', 22150, {})).toBe(22150);
    expect(portFromEnv('E2E_SYNC_PORT', 22150, { E2E_SYNC_PORT: '' })).toBe(22150);
    expect(portFromEnv('E2E_SYNC_PORT', 22150, { OTHER: '22160' })).toBe(22150);
  });

  it('takes a port of the project range from the environment, ends included', () => {
    expect(portFromEnv('E2E_WEB_PORT', 22151, { E2E_WEB_PORT: '22170' })).toBe(22170);
    expect(portFromEnv('E2E_WEB_PORT', 22151, { E2E_WEB_PORT: '22100' })).toBe(22100);
    expect(portFromEnv('E2E_WEB_PORT', 22151, { E2E_WEB_PORT: '22199' })).toBe(22199);
  });

  it.each(['22099', '22200', '0', '-22150', '22150.5', 'abc', '2215x', ' ', '1e4', 'NaN'])(
    'refuses %j, and names the variable',
    (value) => {
      expect(() => portFromEnv('E2E_WEB_PORT', 22151, { E2E_WEB_PORT: value })).toThrow(
        /E2E_WEB_PORT must be a port from 22100 to 22199/,
      );
    },
  );
});

describe('browsersFromEnv', () => {
  it('runs Chromium alone unless told otherwise', () => {
    expect(browsersFromEnv({})).toEqual(['chromium']);
    expect(browsersFromEnv({ E2E_BROWSERS: '' })).toEqual(['chromium']);
    expect(browsersFromEnv({ E2E_BROWSERS: '  ' })).toEqual(['chromium']);
  });

  it('takes a list, in the order given, ignoring spaces and repeats', () => {
    expect(browsersFromEnv({ E2E_BROWSERS: 'webkit' })).toEqual(['webkit']);
    expect(browsersFromEnv({ E2E_BROWSERS: ' webkit , chromium ' })).toEqual([
      'webkit',
      'chromium',
    ]);
    expect(browsersFromEnv({ E2E_BROWSERS: 'firefox,firefox,chromium' })).toEqual([
      'firefox',
      'chromium',
    ]);
  });

  it('refuses a name that is not an engine, and lists every such name', () => {
    expect(() => browsersFromEnv({ E2E_BROWSERS: 'safari' })).toThrow(/unknown browsers: "safari"/);
    expect(() => browsersFromEnv({ E2E_BROWSERS: 'chromium,Edge,chrome' })).toThrow(
      /"Edge", "chrome"/,
    );
    expect(() => browsersFromEnv({ E2E_BROWSERS: 'chromium,,webkit' })).toThrow(
      /unknown browsers: ""/,
    );
  });
});
