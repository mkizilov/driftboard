import { TextSequence, replicaId, type TextOp } from '@driftboard/crdt';
import { createRng } from './rng';

/** One edit of a text: replace `deleteCount` code points at `index` with `insert`. */
export interface Edit {
  readonly index: number;
  readonly deleteCount: number;
  readonly insert: string;
}

// Mostly lower-case letters and spaces, with a few characters beyond ASCII (one outside the basic
// plane), as typed text is.
const KEYS = [...'abcdefghijklmnopqrstuvwxyz        .,\n', 'é', '😀'];

/**
 * A person typing: `operations` single-character operations, each an insert at the caret, a
 * backspace or a forward delete, with now and then a jump of the caret to somewhere else (not an
 * operation). The script only depends on the length of the text, so it is valid for any
 * implementation of a sequence.
 */
export function editScript(seed: number, operations: number): Edit[] {
  const rng = createRng(seed);
  const edits: Edit[] = [];
  let length = 0;
  let caret = 0;
  while (edits.length < operations) {
    const roll = rng.next();
    if (length === 0 || roll < 0.78) {
      edits.push({ index: caret, deleteCount: 0, insert: rng.pick(KEYS) });
      length += 1;
      caret += 1;
    } else if (roll < 0.9) {
      if (caret > 0) {
        edits.push({ index: caret - 1, deleteCount: 1, insert: '' });
        length -= 1;
        caret -= 1;
      }
    } else if (roll < 0.93) {
      if (caret < length) {
        edits.push({ index: caret, deleteCount: 1, insert: '' });
        length -= 1;
      }
    } else {
      caret = rng.int(length + 1);
    }
  }
  return edits;
}

/** The text the script leaves behind, worked out on plain arrays: the reference for tests. */
export function textAfter(edits: readonly Edit[]): string {
  const characters: string[] = [];
  for (const { index, deleteCount, insert } of edits) {
    characters.splice(index, deleteCount, ...Array.from(insert));
  }
  return characters.join('');
}

/** Performs the edits one by one on a sequence, as a person typing does; returns the operations. */
export function runEdits(sequence: TextSequence, edits: readonly Edit[]): TextOp[] {
  const ops: TextOp[] = [];
  for (const { index, deleteCount, insert } of edits) {
    if (deleteCount > 0) ops.push(...sequence.delete(index, deleteCount));
    if (insert !== '') ops.push(...sequence.insert(index, insert));
  }
  return ops;
}

/** Like `runEdits`, but reads the whole text after every edit, as an editor showing it does. */
export function runEditsReading(sequence: TextSequence, edits: readonly Edit[]): number {
  let read = 0;
  for (const { index, deleteCount, insert } of edits) {
    if (deleteCount > 0) sequence.delete(index, deleteCount);
    if (insert !== '') sequence.insert(index, insert);
    read += sequence.toString().length;
  }
  return read;
}

/** A fresh replica that applies the operations of someone else, in the given order. */
export function applyOps(ops: readonly TextOp[]): TextSequence {
  const sequence = new TextSequence(replicaId('receiver'));
  for (const op of ops) sequence.apply(op);
  return sequence;
}

/** The operations in a random order, so that most arrive before the ones they depend on. */
export function shuffled<T>(items: readonly T[], seed: number): T[] {
  const rng = createRng(seed);
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = rng.int(i + 1);
    const other = copy[j];
    const here = copy[i];
    if (other === undefined || here === undefined) throw new Error('index out of range');
    copy[i] = other;
    copy[j] = here;
  }
  return copy;
}

/** A cheap fingerprint of a list of operations, to see that two runs produced the same ones. */
export function fingerprint(ops: readonly TextOp[]): string {
  let hash = 0x811c9dc5;
  const mix = (text: string): void => {
    for (let i = 0; i < text.length; i += 1) {
      hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
    }
  };
  for (const op of ops) {
    if (op.type === 'insert') {
      const parent = op.parent === null ? '-' : `${op.parent.counter}@${op.parent.replicaId}`;
      mix(`i${op.id.counter}@${op.id.replicaId}<${parent}${op.side}${op.value}`);
    } else {
      mix(`d${op.target.counter}@${op.target.replicaId}`);
    }
  }
  return hash.toString(16).padStart(8, '0');
}
