import { deserializeBoardOps, replicaId, serializeBoardOps } from '@driftboard/crdt';
import { decodeOps, encodeOps, stampOps, toBoardOps } from '@driftboard/protocol';
import { bench, describe } from 'vitest';
import { buildBoardOps, loadBoard, readEverything } from './board-scenarios';

const few = { time: 0, iterations: 3, warmupTime: 0, warmupIterations: 1 } as const;

// 1,000 notes with 800 characters typed into each: about 840,000 operations.
const operations = buildBoardOps(5, { notes: 1000, charsPerNote: 800 });
const stamped = stampOps(replicaId('author'), 1, operations);
const json = serializeBoardOps(operations);
const binary = encodeOps(stamped);

describe('loading a board of 1,000 notes with long texts', () => {
  bench(
    'from JSON: parse and check, apply, read every note',
    () => {
      readEverything(loadBoard(deserializeBoardOps(json)));
    },
    few,
  );

  bench(
    'from the binary batch: decode and check, apply, read every note',
    () => {
      readEverything(loadBoard(toBoardOps(decodeOps(binary))));
    },
    few,
  );

  bench(
    'only apply the operations to a new board',
    () => {
      loadBoard(operations);
    },
    few,
  );
});
