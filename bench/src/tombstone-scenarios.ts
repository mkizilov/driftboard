import { TextSequence, replicaId } from '@driftboard/crdt';
import { sentence } from './board-scenarios';
import { createRng } from './rng';

export interface ChurnSize {
  /** Characters in the text, which stays this long throughout. */
  readonly length: number;
  /** How many times a few characters are replaced by as many new ones. */
  readonly edits: number;
  /** A row is recorded after this many edits. */
  readonly every: number;
}

export interface ChurnRow {
  readonly edits: number;
  readonly shown: number;
  /** Nodes held, tombstones included. */
  readonly nodes: number;
  /** Time spent on the edits so far, in ms. */
  readonly ms: number;
  /** What `probes.heap` said at this point (0 if there is none). */
  readonly heap: number;
}

export interface ChurnProbes {
  /** Milliseconds, to time the edits. */
  readonly clock?: () => number;
  /** Heap in use, in megabytes, taken at every row. */
  readonly heap?: () => number;
}

/**
 * A text of `length` characters that is edited over and over without growing: each edit selects a
 * few characters and types as many new ones over them. The shown text stays the same size, and
 * every edit leaves tombstones behind. Returns a row every `size.every` edits, and the sequence.
 */
export function churn(
  seed: number,
  size: ChurnSize,
  probes: ChurnProbes = {},
): { rows: ChurnRow[]; sequence: TextSequence } {
  const clock = probes.clock ?? (() => 0);
  const rng = createRng(seed);
  const sequence = new TextSequence(replicaId('editor'));
  sequence.insert(0, sentence(rng, size.length));
  const rows: ChurnRow[] = [];
  let spent = 0;
  const record = (edits: number): void => {
    rows.push({
      edits,
      shown: sequence.length,
      nodes: sequence.nodes().length,
      ms: spent,
      heap: probes.heap?.() ?? 0,
    });
  };
  record(0);
  for (let edit = 1; edit <= size.edits; edit += 1) {
    const count = 1 + rng.int(5);
    const at = rng.int(size.length - count + 1);
    const text = sentence(rng, count);
    const start = clock();
    sequence.delete(at, count);
    sequence.insert(at, text);
    spent += clock() - start;
    if (edit % size.every === 0) record(edit);
  }
  return { rows, sequence };
}

/** A fresh sequence holding just `text`: what the text would take if its tombstones were dropped. */
export function compacted(text: string): TextSequence {
  const sequence = new TextSequence(replicaId('compacted'));
  sequence.insert(0, text);
  return sequence;
}
