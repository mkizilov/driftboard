import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SyncServer, type SyncServerOptions } from './sync-server';

// The tests run with this package (e2e) as the working directory, as `pnpm test` does.
const stub = path.resolve(process.cwd(), 'support', 'test-fixtures', 'stub-server.mjs');

/** A loopback port from the project's range that nothing else in the suite uses. */
const PORT = 22195;

const created: SyncServer[] = [];

function server(env: Record<string, string> = {}, change: Partial<SyncServerOptions> = {}) {
  const instance = new SyncServer({
    port: PORT,
    dataDir: mkdtempSync(path.join(tmpdir(), 'driftboard-e2e-test-')),
    command: [process.execPath, stub],
    cwd: process.cwd(),
    env,
    readyTimeoutMs: 8000,
    ...change,
  });
  created.push(instance);
  return instance;
}

afterEach(async () => {
  for (const instance of created.splice(0)) await instance.dispose();
});

const health = async () => {
  const response = await fetch(`http://127.0.0.1:${PORT}/healthz`);
  return { status: response.status, body: await response.text() };
};

const answers = async () => {
  try {
    await fetch(`http://127.0.0.1:${PORT}/healthz`, { signal: AbortSignal.timeout(500) });
    return true;
  } catch {
    return false;
  }
};

describe('SyncServer', () => {
  it('starts the server and resolves once it answers /healthz', async () => {
    const instance = server();
    expect(instance.running).toBe(false);
    await instance.start();
    expect(instance.running).toBe(true);
    expect(await health()).toEqual({ status: 200, body: 'ok 1' });
  });

  it('tells where it listens', () => {
    const instance = server();
    expect(instance.url).toBe(`ws://127.0.0.1:${PORT}/ws`);
    expect(instance.healthUrl).toBe(`http://127.0.0.1:${PORT}/healthz`);
    expect(instance.port).toBe(PORT);
    expect(instance.databasePath.endsWith('driftboard.sqlite')).toBe(true);
  });

  it('gives the server its port and database through the environment', async () => {
    const instance = server();
    await instance.start();
    expect(existsSync(instance.databasePath)).toBe(true);
    expect(instance.output).toContain(`stub listening on ${PORT}`);
  });

  it('stops the server with SIGTERM and frees the port', async () => {
    const instance = server();
    await instance.start();
    await instance.stop();
    expect(instance.running).toBe(false);
    expect(await answers()).toBe(false);
  });

  it('starts again on the same database after a stop, as a restart does', async () => {
    const instance = server();
    await instance.start();
    await instance.stop();
    await instance.start();
    expect(await health()).toEqual({ status: 200, body: 'ok 2' });
    expect(readFileSync(instance.databasePath, 'utf8')).toBe('2');
  });

  it('kills the server at once, and then starts it again on the same database', async () => {
    const instance = server();
    await instance.start();
    await instance.kill();
    expect(instance.running).toBe(false);
    expect(await answers()).toBe(false);
    await instance.start();
    expect(await health()).toEqual({ status: 200, body: 'ok 2' });
  });

  it('kills a server that will not shut down when asked, once it has waited long enough', async () => {
    const instance = server({ STUB_IGNORE_TERM: '1' }, { stopTimeoutMs: 400 });
    await instance.start();
    const before = Date.now();
    await instance.stop();
    expect(Date.now() - before).toBeGreaterThanOrEqual(350);
    expect(instance.running).toBe(false);
    expect(await answers()).toBe(false);
  });

  it('does nothing when asked to stop or kill a server that is not running', async () => {
    const instance = server();
    await instance.stop();
    await instance.kill();
    expect(instance.running).toBe(false);
  });

  it('refuses to start twice', async () => {
    const instance = server();
    await instance.start();
    await expect(instance.start()).rejects.toThrow('already running');
  });

  it('says what the server printed when it exits before it is ready', async () => {
    const instance = server({ STUB_EXIT: '1' });
    await expect(instance.start()).rejects.toThrow('failing to start, as asked');
    expect(instance.running).toBe(false);
  });

  it('gives up, kills the server and says so when it does not answer in time', async () => {
    const instance = server({ STUB_SLOW_START_MS: '5000' }, { readyTimeoutMs: 600 });
    await expect(instance.start()).rejects.toThrow('did not answer');
    expect(instance.running).toBe(false);
  });

  it('refuses to start when something already answers on the port', async () => {
    const first = server();
    await first.start();
    const second = server();
    await expect(second.start()).rejects.toThrow('already answers');
    expect(second.running).toBe(false);
    expect(await health()).toEqual({ status: 200, body: 'ok 1' });
  });

  it('removes the database when disposed', async () => {
    const instance = server();
    await instance.start();
    await instance.dispose();
    expect(existsSync(instance.databasePath)).toBe(false);
    expect(await answers()).toBe(false);
  });
});
