import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export const IN_MEMORY = ':memory:';
export const SCHEMA_VERSION = 2;

/** `MIGRATIONS[n]` upgrades a database from schema version n to n + 1. */
const MIGRATIONS: readonly ((db: Database.Database) => void)[] = [
  // 0 -> 1: the meta table exists (created by `openDatabase`).
  () => undefined,
  // 1 -> 2: each board's operation log, as a compacted snapshot plus a tail of recent operations.
  (db) => {
    db.exec(`
      CREATE TABLE ops (
        board_id TEXT NOT NULL,
        origin TEXT NOT NULL,
        seq INTEGER NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (board_id, origin, seq)
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE snapshots (
        board_id TEXT PRIMARY KEY,
        op_count INTEGER NOT NULL,
        payload BLOB NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
    `);
  },
];

function migrate(db: Database.Database): void {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
    | { value: string }
    | undefined;
  const current = row === undefined ? 0 : Number(row.value);
  if (!Number.isInteger(current) || current < 0 || current > SCHEMA_VERSION) {
    throw new Error(`Cannot use a database with schema version ${String(row?.value)}`);
  }
  if (current === SCHEMA_VERSION) return;
  db.transaction(() => {
    for (let version = current; version < SCHEMA_VERSION; version += 1) {
      const upgrade = MIGRATIONS[version];
      if (upgrade === undefined) throw new Error(`No migration from schema version ${version}`);
      upgrade(db);
    }
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
      'schema_version',
      String(SCHEMA_VERSION),
    );
  })();
}

/** Opens (creating and migrating if needed) the SQLite database at `path`. */
export function openDatabase(path: string): Database.Database {
  if (path !== IN_MEMORY) mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  // An `ack` tells a client its operations are stored, so a commit must reach the disk.
  db.pragma('synchronous = FULL');
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT');
  migrate(db);
  return db;
}
