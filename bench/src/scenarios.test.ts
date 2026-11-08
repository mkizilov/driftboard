import { TextSequence, deserializeBoardOps, replicaId, serializeBoardOps } from '@driftboard/crdt';
import { decodeOps, encodeOps, stampOps, toBoardOps } from '@driftboard/protocol';
import { describe, expect, it } from 'vitest';
import { buildBoardOps, loadBoard, readEverything, typingOps } from './board-scenarios';
import { createRng } from './rng';
import {
  binaryWire,
  converged,
  describeWorld,
  directWire,
  jsonWire,
  prepareWorld,
  reconnect,
} from './sync-scenarios';
import {
  applyOps,
  editScript,
  fingerprint,
  runEdits,
  runEditsReading,
  shuffled,
  textAfter,
} from './text-scenarios';
import { churn, compacted } from './tombstone-scenarios';


// The benchmarks run these scenarios at a size that takes seconds. Here they run small, to show
// that they do what the numbers claim: valid edits, the text they should leave, every replica and
// every wire format ending up in the same place.

describe('createRng', () => {
  it('makes the same numbers from the same seed, and others from another', () => {
    const draw = (seed: number) => {
      const rng = createRng(seed);
      return Array.from({ length: 10 }, () => rng.next());
    };
    expect(draw(3)).toEqual(draw(3));
    expect(draw(3)).not.toEqual(draw(4));
    const rng = createRng(1);
    for (let i = 0; i < 1000; i += 1) {
      expect(rng.int(7)).toBeGreaterThanOrEqual(0);
      expect(rng.int(7)).toBeLessThan(7);
    }
    expect(['a', 'b']).toContain(rng.pick(['a', 'b']));
    expect(() => rng.pick([])).toThrow(RangeError);
  });
});

describe('the text scenarios', () => {
  it('script exactly the number of operations asked for, the same ones every time', () => {
    expect(editScript(1, 500)).toHaveLength(500);
    expect(editScript(1, 500)).toEqual(editScript(1, 500));
    expect(editScript(1, 500)).not.toEqual(editScript(2, 500));
    expect(editScript(1, 0)).toEqual([]);
  });

  it('leave the text that plain arrays say the script leaves', () => {
    for (const seed of [1, 2, 3]) {
      const script = editScript(seed, 2000);
      const sequence = new TextSequence(replicaId('typist'));
      runEdits(sequence, script);
      expect(sequence.toString()).toBe(textAfter(script));
      expect(sequence.length).toBe(Array.from(textAfter(script)).length);
    }
  });

  it('give the same text whether it is read after every edit or once at the end', () => {
    const script = editScript(4, 1500);
    const reading = new TextSequence(replicaId('typist'));
    runEditsReading(reading, script);
    expect(reading.toString()).toBe(textAfter(script));
  });

  it('applied by another replica, in order or scrambled, give the same text and the same nodes', () => {
    const script = editScript(5, 3000);
    const author = new TextSequence(replicaId('typist'));
    const ops = runEdits(author, script);
    expect(ops).toHaveLength(3000);
    const inOrder = applyOps(ops);
    const mixed = applyOps(shuffled(ops, 9));
    expect(inOrder.toString()).toBe(author.toString());
    expect(mixed.toString()).toBe(author.toString());
    expect(mixed.pendingCount).toBe(0);
    expect(JSON.stringify(inOrder.nodes())).toBe(JSON.stringify(author.nodes()));
    expect(JSON.stringify(mixed.nodes())).toBe(JSON.stringify(author.nodes()));
  });

  it('shuffle without losing or repeating anything, and the same way for the same seed', () => {
    const items = Array.from({ length: 200 }, (_, i) => i);
    const once = shuffled(items, 1);
    expect([...once].sort((a, b) => a - b)).toEqual(items);
    expect(once).not.toEqual(items);
    expect(shuffled(items, 1)).toEqual(once);
    expect(items[0]).toBe(0);
  });

  it('fingerprint a list of operations so that any change to it shows', () => {
    const ops = runEdits(new TextSequence(replicaId('typist')), editScript(6, 400));
    expect(fingerprint(ops)).toBe(fingerprint([...ops]));
    expect(fingerprint(ops.slice(1))).not.toBe(fingerprint(ops));
    expect(fingerprint([...ops].reverse())).not.toBe(fingerprint(ops));
    expect(fingerprint(ops)).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('churn, which leaves tombstones', () => {
  it('keeps the text the same length while the nodes pile up', () => {
    const { rows, sequence } = churn(1, { length: 200, edits: 600, every: 200 });
    expect(rows.map((r) => r.edits)).toEqual([0, 200, 400, 600]);
    for (const row of rows) expect(row.shown).toBe(200);
    expect(rows[0]?.nodes).toBe(200);
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i]?.nodes).toBeGreaterThan(rows[i - 1]?.nodes ?? Infinity);
    }
    expect(rows.at(-1)?.nodes).toBeGreaterThan(200 * 3);
    expect(sequence.nodes()).toHaveLength(rows.at(-1)?.nodes ?? -1);
    sequence.assertConsistent();
  });

  it('is the same text, held in as many nodes as it has characters, once compacted', () => {
    const { sequence } = churn(2, { length: 100, edits: 300, every: 300 });
    const small = compacted(sequence.toString());
    expect(small.toString()).toBe(sequence.toString());
    expect(small.nodes()).toHaveLength(100);
    expect(sequence.nodes().length).toBeGreaterThan(300);
  });

  it('records the probes it is given at every row', () => {
    let heap = 0;
    let now = 0;
    const { rows } = churn(
      3,
      { length: 50, edits: 20, every: 10 },
      {
        heap: () => (heap += 1),
        clock: () => (now += 2),
      },
    );
    expect(rows.map((r) => r.heap)).toEqual([1, 2, 3]);
    expect(rows[0]?.ms).toBe(0);
    expect(rows[2]?.ms).toBe(2 * 20);
  });
});

describe('the board scenarios', () => {
  const size = { notes: 12, charsPerNote: 150 };

  it('make a board with the notes and the text asked for, and load it from either format', () => {
    const ops = buildBoardOps(5, size);
    expect(buildBoardOps(5, size)).toEqual(ops);
    const board = loadBoard(ops);
    expect(board.size).toBe(12);
    const shown = readEverything(board);
    expect(shown).toBeGreaterThan(12 * 100);
    expect(shown).toBeLessThanOrEqual(12 * 150);

    const fromJson = loadBoard(deserializeBoardOps(serializeBoardOps(ops)));
    const stamped = stampOps(replicaId('author'), 1, ops);
    const fromBinary = loadBoard(toBoardOps(decodeOps(encodeOps(stamped))));
    expect(JSON.stringify(fromJson.notes())).toBe(JSON.stringify(board.notes()));
    expect(JSON.stringify(fromBinary.notes())).toBe(JSON.stringify(board.notes()));
    expect(JSON.stringify(fromBinary.snapshot())).toBe(JSON.stringify(board.snapshot()));
  });

  it('make a typist whose keys are a character and the note put again', () => {
    const ops = typingOps(3, 300);
    expect(ops.length).toBeGreaterThan(300);
    expect(ops.length).toBeLessThanOrEqual(1 + 2 * 300);
    expect(ops.filter((op) => op.type === 'text').length).toBeGreaterThan(250);
    expect(ops.filter((op) => op.type === 'notes').length).toBeGreaterThan(250);
    const board = loadBoard(ops);
    expect(board.notes()[0]?.text).toBe(textAfter(editScript(3, 300)));
  });
});

describe('the offline sync scenario', () => {
  const size = { notes: 8, charsPerNote: 60, offlineOps: 400, onlineOps: 150 };

  it('prepares a world where one client has made what it did offline and the other has gone on', () => {
    const world = prepareWorld(11, size);
    const counts = describeWorld(world);
    expect(counts.offline).toBeGreaterThanOrEqual(400);
    expect(counts.online).toBeGreaterThanOrEqual(150);
    expect(converged(world)).toBe(false);
  });

  it('brings both clients and the server to the same board, whichever way the messages travel', () => {
    const results = [directWire, jsonWire, binaryWire].map((wire) => {
      const world = prepareWorld(11, size);
      const result = reconnect(world, wire);
      expect(converged(world)).toBe(true);
      return { wire, result, notes: JSON.stringify(world.online.board.notes()) };
    });
    const [direct, json, binary] = results;
    // The same operations were moved in each case, in as many messages.
    expect(json?.result.operations).toBe(direct?.result.operations);
    expect(binary?.result.operations).toBe(direct?.result.operations);
    expect(json?.result.messages).toBe(direct?.result.messages);
    expect(binary?.result.messages).toBe(direct?.result.messages);
    // And they came to the same board.
    expect(json?.notes).toBe(direct?.notes);
    expect(binary?.notes).toBe(direct?.notes);
    // Counted in bytes only where there was something to count.
    expect(direct?.result.bytes).toBe(0);
    expect(binary?.result.bytes).toBeGreaterThan(0);
    expect(binary?.result.bytes).toBeLessThan((json?.result.bytes ?? 0) / 10);
  });

  it('prepares the same world from the same seed', () => {
    const one = describeWorld(prepareWorld(11, size));
    const two = describeWorld(prepareWorld(11, size));
    expect(two).toEqual(one);
  });
});
