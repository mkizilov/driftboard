import { bench, describe } from 'vitest';
import { binaryWire, jsonWire, prepareWorld, reconnect, type World } from './sync-scenarios';

const size = { notes: 200, charsPerNote: 100, offlineOps: 30_000, onlineOps: 10_000 };
const RUNS = 2;

// A reconnect uses its world up (the boards end up holding everything), so every run needs a
// fresh one. They are made before the runs, which is why there are only as many as the runs.
const worlds = new Map<string, World[]>();
for (const wire of [jsonWire, binaryWire]) {
  worlds.set(
    wire.name,
    Array.from({ length: RUNS }, () => prepareWorld(11, size)),
  );
}

describe('syncing after 30,000 operations made offline, 10,000 meanwhile by someone else', () => {
  for (const wire of [jsonWire, binaryWire]) {
    bench(
      `reconnect and catch up, ${wire.name}`,
      () => {
        const world = worlds.get(wire.name)?.pop();
        if (world === undefined) throw new Error('no world left for this run');
        reconnect(world, wire);
      },
      { time: 0, iterations: RUNS, warmupTime: 0, warmupIterations: 0 },
    );
  }
});
