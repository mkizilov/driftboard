import { MAX_NOTE_NODES } from '@driftboard/crdt';
import type { StampedOp } from './ops';
import type { OpStore } from './store';

/**
 * What the server counts per note, to hold the text of every note to a size: how many characters
 * were ever inserted into it. Deleted characters count, because they stay in memory.
 *
 * It is a rule about the board as a whole, so only the server applies it; every other replica gets
 * the operations the server let through. The count only grows, so the answer does not depend on
 * the order in which different origins' operations arrive, which matters because a device that
 * sends the operations of several earlier replicas sends them in the order of their replica ids.
 * For the same reason the server does not ask that a note exists before text is written to it.
 */
export type NoteLedger = ReadonlyMap<string, number>;

export const emptyLedger: NoteLedger = new Map();

/** The ledger of everything a store holds. */
export function ledgerOf(store: OpStore): NoteLedger {
  const ledger = new Map<string, number>();
  for (const log of store.logs.values()) {
    for (let index = 0; index < log.length; index += 1) {
      const op = log.items[index]?.op;
      const note = op?.['noteId'];
      if (typeof note === 'string' && op?.['type'] === 'text-insert') {
        ledger.set(note, (ledger.get(note) ?? 0) + 1);
      }
    }
  }
  return ledger;
}

export type LedgerResult =
  | { readonly ok: true; readonly ledger: NoteLedger }
  | { readonly ok: false; readonly detail: string };

/**
 * The ledger after `ops`, or why they are not allowed: more than `maxNodes` characters in one
 * note's text. `ledger` itself is not changed.
 */
export function ledgerAdd(
  ledger: NoteLedger,
  ops: readonly StampedOp[],
  maxNodes: number = MAX_NOTE_NODES,
): LedgerResult {
  let next: Map<string, number> | undefined;
  for (const { op } of ops) {
    const note = op['noteId'];
    if (typeof note !== 'string' || op['type'] !== 'text-insert') continue;
    const count = (next ?? ledger).get(note) ?? 0;
    if (count + 1 > maxNodes) {
      return { ok: false, detail: `the text of a note may hold at most ${maxNodes} characters` };
    }
    (next ??= new Map(ledger)).set(note, count + 1);
  }
  return { ok: true, ledger: next ?? ledger };
}
