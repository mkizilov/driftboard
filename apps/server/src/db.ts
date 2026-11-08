import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export const IN_MEMORY = ':memory:';

export function openDatabase(path: string): Database.Database {
  if (path !== IN_MEMORY) mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT');
  db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run('schema_version', '1');
  return db;
}
