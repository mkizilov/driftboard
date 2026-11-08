import { fileURLToPath } from 'node:url';
import { MAX_NOTE_NODES } from '@driftboard/crdt';
import { DEFAULT_RATE_LIMITS, type RateLimits } from './rate-limit';

export interface ServerConfig {
  host: string;
  port: number;
  dbPath: string;
  maxMessageBytes: number;
  compactAfterOps: number;
  compactIntervalMs: number;
  helloTimeoutMs: number;
  /** What one connection may send; a connection that sends more is closed. */
  rateLimits: RateLimits;
  /** Most characters (deleted ones included) one note's text may hold. */
  maxNoteNodes: number;
  /** A built web app to serve from the same port; `undefined` serves no files. */
  staticDir: string | undefined;
}

// apps/server/src -> repository root; SQLite files live under <root>/.data/.
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (raw.trim() === '' || !Number.isInteger(value) || value < min) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const maxNoteNodes = integer(env, 'DRIFTBOARD_MAX_NOTE_NODES', MAX_NOTE_NODES, 1);
  if (maxNoteNodes > MAX_NOTE_NODES) {
    // Clients refuse characters past MAX_NOTE_NODES, and which ones they refuse depends on the order
    // they arrive in: a server that lets more through would make clients disagree.
    throw new Error(
      `Invalid DRIFTBOARD_MAX_NOTE_NODES: ${maxNoteNodes} is more than the ${MAX_NOTE_NODES} the clients accept`,
    );
  }
  const port = integer(env, 'DRIFTBOARD_PORT', 22100, 0);
  if (port > 65535) throw new Error(`Invalid DRIFTBOARD_PORT: ${env['DRIFTBOARD_PORT']}`);
  return {
    host: env['DRIFTBOARD_HOST'] ?? '127.0.0.1',
    port,
    dbPath: env['DRIFTBOARD_DB'] ?? `${repoRoot}.data/driftboard.sqlite`,
    // 1 MiB: the largest frame the protocol accepts.
    maxMessageBytes: integer(env, 'DRIFTBOARD_MAX_MESSAGE_BYTES', 1_048_576, 1024),
    // Fold a board's recent operations into its snapshot after this many; 0 turns it off.
    compactAfterOps: integer(env, 'DRIFTBOARD_COMPACT_AFTER_OPS', 1000, 0),
    // Also compact every board with a tail this often (ms); 0 turns it off.
    compactIntervalMs: integer(env, 'DRIFTBOARD_COMPACT_INTERVAL_MS', 300_000, 0),
    // Close a connection that has not sent a valid hello within this time (ms); 0 turns it off.
    helloTimeoutMs: integer(env, 'DRIFTBOARD_HELLO_TIMEOUT_MS', 10_000, 0),
    // Per connection; a burst of 0 turns that limit off.
    rateLimits: {
      messages: {
        burst: integer(env, 'DRIFTBOARD_RATE_MESSAGE_BURST', DEFAULT_RATE_LIMITS.messages.burst, 0),
        perSecond: integer(
          env,
          'DRIFTBOARD_RATE_MESSAGES_PER_SECOND',
          DEFAULT_RATE_LIMITS.messages.perSecond,
          1,
        ),
      },
      ops: {
        burst: integer(env, 'DRIFTBOARD_RATE_OP_BURST', DEFAULT_RATE_LIMITS.ops.burst, 0),
        perSecond: integer(
          env,
          'DRIFTBOARD_RATE_OPS_PER_SECOND',
          DEFAULT_RATE_LIMITS.ops.perSecond,
          1,
        ),
      },
    },
    maxNoteNodes,
    // Relative to where the server is started. Empty means none.
    staticDir: env['DRIFTBOARD_STATIC_DIR'] === '' ? undefined : env['DRIFTBOARD_STATIC_DIR'],
  };
}
