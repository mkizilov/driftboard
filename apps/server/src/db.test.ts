import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IN_MEMORY, openDatabase } from './db';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('openDatabase', () => {
  it('creates the meta table with the schema version', () => {
    const db = openDatabase(IN_MEMORY);
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
    expect(row).toEqual({ value: '1' });
    db.close();
  });

  it('creates missing parent directories and is reopenable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'driftboard-db-'));
    dirs.push(dir);
    const path = join(dir, 'nested', 'test.sqlite');
    openDatabase(path).close();
    expect(existsSync(path)).toBe(true);
    const again = openDatabase(path);
    expect(again.prepare('SELECT COUNT(*) AS n FROM meta').get()).toEqual({ n: 1 });
    again.close();
  });
});
