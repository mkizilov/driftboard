// A stand-in for the sync server in the unit tests of `SyncServer`: it listens on DRIFTBOARD_PORT,
// answers GET /healthz, and counts its starts in the file named by DRIFTBOARD_DB, so that a test
// can see that a restart used the same data path.
//
// STUB_IGNORE_TERM=1   ignores SIGTERM (a server that will not shut down)
// STUB_EXIT=1          exits at once (a server that fails to start)
// STUB_SLOW_START_MS=n waits n milliseconds before it starts listening
/* global console, process */
import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

if (process.env['STUB_EXIT'] === '1') {
  console.error('stub: failing to start, as asked');
  process.exit(3);
}

const port = Number(process.env['DRIFTBOARD_PORT']);
const database = process.env['DRIFTBOARD_DB'];
const starts = (existsSync(database) ? Number(readFileSync(database, 'utf8')) : 0) + 1;
writeFileSync(database, String(starts));

const server = createServer((request, response) => {
  if (request.url === '/healthz') {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end(`ok ${starts}`);
  } else {
    response.writeHead(404);
    response.end();
  }
});

setTimeout(() => {
  server.listen(port, process.env['DRIFTBOARD_HOST'], () => {
    console.log(`stub listening on ${port} (start ${starts})`);
  });
}, Number(process.env['STUB_SLOW_START_MS'] ?? 0));

process.on('SIGTERM', () => {
  if (process.env['STUB_IGNORE_TERM'] === '1') return;
  server.close(() => {
    process.exit(0);
  });
  server.closeAllConnections();
});
