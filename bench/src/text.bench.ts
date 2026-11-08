import { TextSequence, replicaId } from '@driftboard/crdt';
import { bench, describe } from 'vitest';
import { applyOps, editScript, runEdits, runEditsReading, shuffled } from './text-scenarios';

// The scenarios are big: each runs a few times, not for a fixed number of seconds.
const few = { time: 0, iterations: 3, warmupTime: 0, warmupIterations: 1 } as const;

const OPERATIONS = 100_000;
const script = editScript(1, OPERATIONS);
const operations = runEdits(new TextSequence(replicaId('typist')), script);
const scrambled = shuffled(operations, 7);
const reading = editScript(2, 10_000);

describe('applying 100,000 text operations', () => {
  bench(
    'perform them as a person typing does, an index to a character on every edit',
    () => {
      runEdits(new TextSequence(replicaId('typist')), script);
    },
    few,
  );

  bench(
    'apply them as another replica, in order, as a server relays them',
    () => {
      applyOps(operations);
    },
    few,
  );

  bench(
    'apply them as another replica, in random order, through the causal buffer',
    () => {
      applyOps(scrambled);
    },
    few,
  );
});

describe('an editor that reads the whole text after every edit', () => {
  bench(
    'type 10,000 operations and read the text each time',
    () => {
      runEditsReading(new TextSequence(replicaId('typist')), reading);
    },
    few,
  );
});
