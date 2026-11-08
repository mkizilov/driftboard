import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { IN_MEMORY, SCHEMA_VERSION, openDatabase } from './db';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'driftboard-db-'));
  dirs.push(dir);
  return join(dir, 'nested', 'test.sqlite');
}

function tables(db: Database.Database): string[] {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  return (rows as { name: string }[]).map((row) => row.name);
}

describe('openDatabase', () => {
  it('creates the schema at the current version', () => {
    const db = openDatabase(IN_MEMORY);
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
    expect(row).toEqual({ value: String(SCHEMA_VERSION) });
    for (const name of ['meta', 'ops', 'snapshots']) expect(tables(db)).toContain(name);
    db.close();
  });

  it('creates missing parent directories and is reopenable', () => {
    const path = tempFile();
    openDatabase(path).close();
    expect(existsSync(path)).toBe(true);
    const again = openDatabase(path);
    expect(again.prepare('SELECT COUNT(*) AS n FROM meta').get()).toEqual({ n: 1 });
    again.close();
  });

  it('upgrades a database from the first schema version', () => {
    const path = tempFile();
    openDatabase(path).close();
    const old = new Database(path);
    old.exec('DROP TABLE ops; DROP TABLE snapshots;');
    old.prepare('UPDATE meta SET value = ? WHERE key = ?').run('1', 'schema_version');
    old.close();

    const db = openDatabase(path);
    expect(db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')).toEqual({
      value: String(SCHEMA_VERSION),
    });
    for (const name of ['ops', 'snapshots']) expect(tables(db)).toContain(name);
    db.close();
  });

  it('refuses a database written by a newer version', () => {
    const path = tempFile();
    openDatabase(path).close();
    const newer = new Database(path);
    const newerVersion = String(SCHEMA_VERSION + 1);
    newer.prepare('UPDATE meta SET value = ? WHERE key = ?').run(newerVersion, 'schema_version');
    newer.close();
    expect(() => openDatabase(path)).toThrow(/schema version/);
  });
});
