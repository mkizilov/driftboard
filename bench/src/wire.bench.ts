import { replicaId } from '@driftboard/crdt';
import { decodeOps, encodeOps, stampOps } from '@driftboard/protocol';
import { bench, describe } from 'vitest';
import { typingOps } from './board-scenarios';

// One person typing 20,000 keys a key at a time: about 40,000 operations.
const operations = stampOps(replicaId('typist'), 1, typingOps(3, 20_000));
const json = JSON.stringify(operations);
const binary = encodeOps(operations);

describe('encoding 40,000 operations', () => {
  bench('JSON.stringify', () => {
    JSON.stringify(operations);
  });
  bench('encodeOps', () => {
    encodeOps(operations);
  });
});

describe('decoding 40,000 operations', () => {
  bench('JSON.parse', () => {
    JSON.parse(json);
  });
  bench('decodeOps', () => {
    decodeOps(binary);
  });
});
