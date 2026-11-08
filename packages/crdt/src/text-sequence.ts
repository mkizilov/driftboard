import { CausalBuffer, type PendingBudget } from './causal-buffer';
import { compareOpIds, opId, opIdEquals, opIdKey, type OpId } from './op-id';
import { OrderTree } from './order-tree';
import { isReplicaId, type ReplicaId } from './replica-id';

/**
 * Sequence CRDT for text, using the Fugue tree (an RGA-style insert-after scheme extended with
 * left children so that concurrent runs of typing never interleave; see DESIGN.md).
 *
 * Every character is a node with a unique id. An insert operation names the node it hangs off
 * (`parent`, or `null` for the document start) and on which `side`. The document is the in-order
 * walk of the tree: a node's left children, the node, its right children; siblings on one side are
 * ordered by id. Deleting only marks a node as a tombstone, so concurrent inserts can still refer
 * to it. Operations are immutable plain data; the sequence itself is a mutable replica.
 *
 * Indices count Unicode code points, not UTF-16 units and not grapheme clusters.
 *
 * Turning an index into a character and back is what editing needs on every keystroke, so the
 * document order is kept in an `OrderTree` (an order-statistic B+ tree with counts of all and of
 * shown characters) that is updated as nodes arrive: index to node, node to index, insert next to
 * a node and delete are O(log n), and nothing rebuilds the document order.
 */

export type TextSide = 'left' | 'right';

export interface TextInsertOp {
  readonly type: 'insert';
  /** Id of the new character. Counters are per replica and increase by one for every insert. */
  readonly id: OpId;
  /** The node this one is a child of, or `null` for the start of the document. */
  readonly parent: OpId | null;
  readonly side: TextSide;
  /** Exactly one Unicode code point. */
  readonly value: string;
}

export interface TextDeleteOp {
  readonly type: 'delete';
  readonly target: OpId;
}

export type TextOp = TextInsertOp | TextDeleteOp;

/** The text would hold more characters than `maxNodes` allows. */
export class TextTooLongError extends RangeError {
  override readonly name = 'TextTooLongError';
}

export interface TextSequenceOptions {
  /**
   * Most characters the sequence may hold, deleted ones included (they stay in memory). An insert
   * that would go past it, local or remote, is refused with `TextTooLongError`. Default: no limit.
   */
  readonly maxNodes?: number;
  /** Shared limit on the operations held back for missing ones; see `PendingBudget`. */
  readonly pending?: PendingBudget;
}

/** One character of the document, including deleted ones (tombstones). */
export interface TextNode {
  readonly id: OpId;
  readonly parent: OpId | null;
  readonly side: TextSide;
  readonly value: string;
  readonly deleted: boolean;
}

interface TreeNode {
  readonly id: OpId | null;
  readonly left: CharNode[];
  readonly right: CharNode[];
}

interface CharNode extends TreeNode {
  readonly id: OpId;
  readonly op: TextInsertOp;
  deleted: boolean;
  /** Where the `OrderTree` keeps this node. */
  leaf: unknown;
}

/** Puts `node` among `siblings`, ordered by id, and returns the position it took. */
function insertSorted(siblings: CharNode[], node: CharNode): number {
  let position = siblings.length;
  for (;;) {
    const previous = siblings[position - 1];
    if (previous === undefined || compareOpIds(node.id, previous.id) >= 0) break;
    position -= 1;
  }
  siblings.splice(position, 0, node);
  return position;
}

/** The first node of the subtree of `node` in document order. */
function leftmost(node: CharNode): CharNode {
  let first = node;
  for (let child = first.left[0]; child !== undefined; child = first.left[0]) first = child;
  return first;
}

/** The last node of the subtree of `node` in document order. */
function rightmost(node: CharNode): CharNode {
  let last = node;
  for (let child = last.right.at(-1); child !== undefined; child = last.right.at(-1)) last = child;
  return last;
}

function sameInsert(a: TextInsertOp, b: TextInsertOp): boolean {
  const sameParent =
    a.parent === null || b.parent === null ? a.parent === b.parent : opIdEquals(a.parent, b.parent);
  return sameParent && a.side === b.side && a.value === b.value;
}

function assertOpId(id: OpId): void {
  if (!Number.isSafeInteger(id.counter) || id.counter < 1 || !isReplicaId(id.replicaId)) {
    throw new RangeError(`Invalid operation id: ${JSON.stringify(id)}`);
  }
}

function isOneCodePoint(value: string): boolean {
  const first = value.codePointAt(0);
  return first !== undefined && value.length === (first > 0xffff ? 2 : 1);
}

/** Throws `RangeError` if `op` is not a well-formed operation (for data from outside the process). */
export function assertValidTextOp(op: TextOp): void {
  if (op.type === 'insert') {
    assertOpId(op.id);
    if (op.parent !== null) assertOpId(op.parent);
    if (op.side !== 'left' && op.side !== 'right') {
      throw new RangeError(`Invalid side: ${JSON.stringify(op.side)}`);
    }
    if (op.parent === null && op.side !== 'right') {
      throw new RangeError('The document start only has right children');
    }
    if (!isOneCodePoint(op.value)) {
      throw new RangeError(`An insert carries one code point, got ${JSON.stringify(op.value)}`);
    }
  } else if (op.type === 'delete') {
    assertOpId(op.target);
  } else {
    throw new RangeError('Unknown operation type');
  }
}

export class TextSequence {
  readonly replicaId: ReplicaId;
  readonly #root: TreeNode = { id: null, left: [], right: [] };
  readonly #nodes = new Map<string, CharNode>();
  readonly #buffer: CausalBuffer<TextOp>;
  /** Every node in document order, tombstones included, with counts for index lookups. */
  readonly #order = new OrderTree<CharNode>((node) => node.op.value);
  readonly #maxNodes: number;
  readonly #released: TextOp[] = [];
  #counter = 0;

  constructor(replicaId: ReplicaId, options: TextSequenceOptions = {}) {
    this.replicaId = replicaId;
    this.#maxNodes = options.maxNodes ?? Number.POSITIVE_INFINITY;
    this.#buffer = new CausalBuffer<TextOp>({
      ...(options.pending === undefined ? {} : { budget: options.pending }),
      provides: (op) => (op.type === 'insert' ? op.id : undefined),
      requires: (op) => {
        if (op.type === 'delete') return [op.target];
        return op.parent === null ? [] : [op.parent];
      },
      isApplied: (id) => this.#nodes.has(opIdKey(id)),
    });
  }

  /** Number of visible characters (code points). */
  get length(): number {
    return this.#order.shown;
  }

  /** Number of characters held, deleted ones (tombstones) included. */
  get size(): number {
    return this.#nodes.size;
  }

  /** Remote operations held back until the operation they depend on arrives. */
  get pendingCount(): number {
    return this.#buffer.size;
  }

  toString(): string {
    return this.#order.text();
  }

  /** Every node in document order, tombstones included. For snapshots, tests and debugging. */
  nodes(): TextNode[] {
    return this.#order.toArray().map(({ id, op, deleted }) => ({
      id,
      parent: op.parent,
      side: op.side,
      value: op.value,
      deleted,
    }));
  }

  /** Throws if the document order has drifted from the tree of nodes. For tests. */
  assertConsistent(): void {
    this.#order.assertConsistent();
    if (this.#order.size !== this.#nodes.size) {
      throw new Error('Invariant violated: the order and the nodes differ in size');
    }
  }

  /**
   * Inserts `text` before the character currently at `index` (`length` appends) and returns one
   * operation per code point, in the order they must be applied elsewhere.
   */
  insert(index: number, text: string): TextInsertOp[] {
    if (!Number.isInteger(index) || index < 0 || index > this.length) {
      throw new RangeError(`insert index ${index} out of range 0-${this.length}`);
    }
    return this.#insertAt(index === 0 ? this.#root : this.#order.atShown(index - 1), text);
  }

  /**
   * Inserts `text` directly after the character `id`, or at the start of the document if `id` is
   * `null`. The character may be one that was deleted: a tombstone keeps its place, so the text
   * lands exactly there, whatever else has happened to the document since. Returns one operation
   * per code point, like `insert`.
   */
  insertAfter(id: OpId | null, text: string): TextInsertOp[] {
    let origin: TreeNode = this.#root;
    if (id !== null) {
      const node = this.#nodes.get(opIdKey(id));
      if (node === undefined) throw new RangeError(`Unknown character ${opIdKey(id)}`);
      origin = node;
    }
    return this.#insertAt(origin, text);
  }

  /** Inserts `text` directly after `origin` in document order (tombstones count). */
  #insertAt(origin: TreeNode, text: string): TextInsertOp[] {
    // Refuse before changing anything, so that a text that is too long leaves no part of it behind.
    if (this.#nodes.size + text.length > this.#maxNodes) this.assertRoom([...text].length);
    const ops: TextInsertOp[] = [];
    // Fugue: if `origin` has no right children, the new character becomes its first right child.
    // Otherwise the next node in document order (the leftmost node of that right subtree) has no
    // left children yet, and the new character becomes its left child. Either way the new node
    // lands directly after `origin`. The rest of a run chains to the right.
    const hasRightChildren = origin.right.length > 0;
    let parent: TreeNode = hasRightChildren ? this.#successor(origin) : origin;
    let side: TextSide = hasRightChildren ? 'left' : 'right';
    for (const value of text) {
      this.#counter += 1;
      const op: TextInsertOp = {
        type: 'insert',
        id: opId(this.#counter, this.replicaId),
        parent: parent.id,
        side,
        value,
      };
      parent = this.#integrateInsert(op);
      side = 'right';
      ops.push(op);
    }
    // An operation from another replica may have referred to one of these ids before it existed.
    for (const { id } of ops) this.#flushWaiting(id);
    return ops;
  }

  /**
   * Applies what was waiting for `id`, which this replica has just written. What cannot be applied
   * (too many characters) is dropped, as `apply` with `onReject` would drop it.
   */
  #flushWaiting(id: OpId): void {
    this.#buffer.supplied(
      id,
      (ready) => {
        this.#deliver(ready, (applied) => {
          this.#released.push(applied);
        });
      },
      () => undefined,
    );
  }

  /**
   * The operations from other replicas that were applied because of something this replica wrote
   * (they had referred to an id it had not made yet), since the last call. The author of a local
   * edit is told of them here and not in the operations the edit returns, which are its own.
   */
  takeReleased(): TextOp[] {
    return this.#released.splice(0);
  }

  /** The node after `origin` in document order, which must exist. */
  #successor(origin: TreeNode): CharNode {
    const next =
      origin === this.#root ? this.#order.first() : this.#order.after(origin as CharNode);
    if (next === undefined)
      throw new Error('Invariant violated: no node after an origin with children');
    return next;
  }

  /** Deletes `length` characters starting at `index` and returns one operation per character. */
  delete(index: number, length: number): TextDeleteOp[] {
    if (
      !Number.isInteger(index) ||
      !Number.isInteger(length) ||
      index < 0 ||
      length < 0 ||
      index + length > this.length
    ) {
      throw new RangeError(`delete range ${index}+${length} out of range 0-${this.length}`);
    }
    const targets = this.#order.shownRange(index, length);
    for (const node of targets) this.#order.hide(node);
    return targets.map((node): TextDeleteOp => ({ type: 'delete', target: node.id }));
  }

  /**
   * Applies an operation from another replica (or one of this replica's own, which is a no-op).
   * Operations may arrive in any order and more than once: one whose parent or target is missing
   * is held in the causal buffer until that operation arrives.
   *
   * `onApplied` is called, as it happens, for each operation that changed the sequence: this one
   * and any held ones it released, but not duplicates.
   *
   * An operation that cannot be applied (an id reused for a different character, too many
   * characters, too many operations waiting) makes this throw, unless `onReject` is given: then
   * that operation goes to `onReject`, with the reason, and the others still go through. Use it
   * for operations that come from other people. Malformed operations still throw `RangeError`.
   */
  apply(
    op: TextOp,
    onApplied?: (applied: TextOp) => void,
    onReject?: (rejected: TextOp, error: unknown) => void,
  ): void {
    assertValidTextOp(op);
    this.#buffer.receive(
      op,
      (ready) => {
        this.#deliver(ready, onApplied);
      },
      onReject,
    );
  }

  /** Applies an operation whose dependency is there. */
  #deliver(ready: TextOp, onApplied: ((applied: TextOp) => void) | undefined): void {
    if (ready.type === 'insert') {
      const isNew = !this.#nodes.has(opIdKey(ready.id));
      this.#integrateInsert(ready); // also rejects an id reused for a different character
      if (isNew) onApplied?.(ready);
    } else if (this.#integrateDelete(ready)) {
      onApplied?.(ready);
    }
  }

  /** Throws `TextTooLongError` unless `count` more characters fit. Changes nothing. */
  assertRoom(count: number): void {
    if (this.#nodes.size + count > this.#maxNodes) {
      throw new TextTooLongError(`a text holds at most ${this.#maxNodes} characters`);
    }
  }

  #integrateInsert(op: TextInsertOp): CharNode {
    const key = opIdKey(op.id);
    const existing = this.#nodes.get(key);
    if (existing !== undefined) {
      if (!sameInsert(existing.op, op)) throw new RangeError(`Conflicting inserts for id ${key}`);
      return existing;
    }
    const parent = op.parent === null ? this.#root : this.#nodes.get(opIdKey(op.parent));
    if (parent === undefined) throw new Error('Invariant violated: parent not applied');
    this.assertRoom(1);
    const node: CharNode = { id: op.id, op, deleted: false, left: [], right: [], leaf: null };
    const siblings = op.side === 'left' ? parent.left : parent.right;
    const position = insertSorted(siblings, node);
    this.#nodes.set(key, node);
    this.#place(node, parent, siblings, position);
    if (op.id.replicaId === this.replicaId) this.#counter = Math.max(this.#counter, op.id.counter);
    return node;
  }

  /**
   * Puts a node that was just added to the tree into the document order. A node sits before the
   * first node of the next sibling on its side, or, with none after it, at the end of its side:
   * right before its parent on the left, right after the last node of the previous sibling (or
   * the parent itself) on the right.
   */
  #place(node: CharNode, parent: TreeNode, siblings: readonly CharNode[], position: number): void {
    const following = siblings[position + 1];
    if (following !== undefined) {
      this.#order.insertBefore(leftmost(following), node);
    } else if (node.op.side === 'left') {
      if (parent === this.#root) throw new Error('Invariant violated: left child of the start');
      this.#order.insertBefore(parent as CharNode, node);
    } else {
      const previous = siblings[position - 1];
      const anchor = previous !== undefined ? rightmost(previous) : parent;
      this.#order.insertAfter(anchor === this.#root ? null : (anchor as CharNode), node);
    }
  }

  /** Returns whether the operation changed anything. */
  #integrateDelete(op: TextDeleteOp): boolean {
    const node = this.#nodes.get(opIdKey(op.target));
    if (node === undefined) throw new Error('Invariant violated: delete target not applied');
    return this.#order.hide(node);
  }
}
