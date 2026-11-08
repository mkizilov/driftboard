import { fileURLToPath } from 'node:url';

export interface ServerConfig {
  host: string;
  port: number;
  dbPath: string;
}

// apps/server/src -> repository root; SQLite files live under <root>/.data/.
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = Number(env['DRIFTBOARD_PORT'] ?? 22100);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid DRIFTBOARD_PORT: ${env['DRIFTBOARD_PORT']}`);
  }
  return {
    host: env['DRIFTBOARD_HOST'] ?? '127.0.0.1',
    port,
    dbPath: env['DRIFTBOARD_DB'] ?? `${repoRoot}.data/driftboard.sqlite`,
  };
}
