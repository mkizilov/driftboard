import { loadConfig } from './config';
import { openDatabase } from './db';
import { startSyncServer } from './server';

const config = loadConfig();
const db = openDatabase(config.dbPath);
const server = await startSyncServer({
  host: config.host,
  port: config.port,
  db,
  maxMessageBytes: config.maxMessageBytes,
  compactAfterOps: config.compactAfterOps,
  compactIntervalMs: config.compactIntervalMs,
  helloTimeoutMs: config.helloTimeoutMs,
  rateLimits: config.rateLimits,
  maxNoteNodes: config.maxNoteNodes,
  ...(config.staticDir === undefined ? {} : { staticDir: config.staticDir }),
});
console.log(
  `driftboard server listening on ws://${config.host}:${server.port}/ws (db: ${config.dbPath})`,
);
if (config.staticDir !== undefined) {
  console.log(
    `serving the web app from ${config.staticDir} at http://${config.host}:${server.port}/`,
  );
}

async function shutdown(): Promise<void> {
  await server.close();
  db.close();
  process.exit(0);
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
