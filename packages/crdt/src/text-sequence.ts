import { CausalBuffer } from './causal-buffer';
import { compareOpIds, opId, opIdEquals, opIdKey, type OpId } from './op-id';
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
  /** Position in document order, tombstones included. Only valid right after `#refresh`. */
  index: number;
}

interface CharNode extends TreeNode {
  readonly id: OpId;
  readonly op: TextInsertOp;
  deleted: boolean;
}

interface WalkItem {
  readonly node: CharNode;
  readonly expanded: boolean;
}

function mustAt<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`Invariant violated: no item at ${index}`);
  return item;
}

function insertSorted(siblings: CharNode[], node: CharNode): void {
  let position = siblings.length;
  for (;;) {
    const previous = siblings[position - 1];
    if (previous === undefined || compareOpIds(node.id, previous.id) >= 0) break;
    position -= 1;
  }
  siblings.splice(position, 0, node);
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
    if ([...op.value].length !== 1) {
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
  readonly #root: TreeNode = { id: null, left: [], right: [], index: -1 };
  readonly #nodes = new Map<string, CharNode>();
  readonly #buffer: CausalBuffer<TextOp>;
  #counter = 0;
  #order: CharNode[] = [];
  #visible: CharNode[] = [];
  #dirty = false;

  constructor(replicaId: ReplicaId) {
    this.replicaId = replicaId;
    this.#buffer = new CausalBuffer<TextOp>({
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
    this.#refresh();
    return this.#visible.length;
  }

  /** Remote operations held back until the operation they depend on arrives. */
  get pendingCount(): number {
    return this.#buffer.size;
  }

  toString(): string {
    this.#refresh();
    return this.#visible.map((node) => node.op.value).join('');
  }

  /** Every node in document order, tombstones included. For snapshots, tests and debugging. */
  nodes(): TextNode[] {
    this.#refresh();
    return this.#order.map(({ id, op, deleted }) => ({
      id,
      parent: op.parent,
      side: op.side,
      value: op.value,
      deleted,
    }));
  }

  /**
   * Inserts `text` before the character currently at `index` (`length` appends) and returns one
   * operation per code point, in the order they must be applied elsewhere.
   */
  insert(index: number, text: string): TextInsertOp[] {
    this.#refresh();
    if (!Number.isInteger(index) || index < 0 || index > this.#visible.length) {
      throw new RangeError(`insert index ${index} out of range 0-${this.#visible.length}`);
    }
    const ops: TextInsertOp[] = [];
    const origin: TreeNode = index === 0 ? this.#root : mustAt(this.#visible, index - 1);
    // Fugue: if the character to the left has no right children, the new one becomes its first
    // right child. Otherwise the next node in document order (the leftmost node of that right
    // subtree) has no left children yet, and the new character becomes its left child. Either
    // way the new node lands directly after `origin`. The rest of a run chains to the right.
    const hasRightChildren = origin.right.length > 0;
    let parent: TreeNode = hasRightChildren ? mustAt(this.#order, origin.index + 1) : origin;
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
    return ops;
  }

  /** Deletes `length` characters starting at `index` and returns one operation per character. */
  delete(index: number, length: number): TextDeleteOp[] {
    this.#refresh();
    if (
      !Number.isInteger(index) ||
      !Number.isInteger(length) ||
      index < 0 ||
      length < 0 ||
      index + length > this.#visible.length
    ) {
      throw new RangeError(
        `delete range ${index}+${length} out of range 0-${this.#visible.length}`,
      );
    }
    const targets = this.#visible.slice(index, index + length);
    for (const node of targets) node.deleted = true;
    if (targets.length > 0) this.#dirty = true;
    return targets.map((node): TextDeleteOp => ({ type: 'delete', target: node.id }));
  }

  /**
   * Applies an operation from another replica (or one of this replica's own, which is a no-op).
   * Operations may arrive in any order and more than once: one whose parent or target is missing
   * is held in the causal buffer until that operation arrives.
   *
   * `onApplied` is called, as it happens, for each operation that changed the sequence: this one
   * and any held ones it released, but not duplicates.
   */
  apply(op: TextOp, onApplied?: (applied: TextOp) => void): void {
    assertValidTextOp(op);
    this.#buffer.receive(op, (ready) => {
      if (ready.type === 'insert') {
        const isNew = !this.#nodes.has(opIdKey(ready.id));
        this.#integrateInsert(ready); // also rejects an id reused for a different character
        if (isNew) onApplied?.(ready);
      } else if (this.#integrateDelete(ready)) {
        onApplied?.(ready);
      }
    });
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
    const node: CharNode = { id: op.id, op, deleted: false, left: [], right: [], index: -1 };
    insertSorted(op.side === 'left' ? parent.left : parent.right, node);
    this.#nodes.set(key, node);
    if (op.id.replicaId === this.replicaId) this.#counter = Math.max(this.#counter, op.id.counter);
    this.#dirty = true;
    return node;
  }

  /** Returns whether the operation changed anything. */
  #integrateDelete(op: TextDeleteOp): boolean {
    const node = this.#nodes.get(opIdKey(op.target));
    if (node === undefined) throw new Error('Invariant violated: delete target not applied');
    if (node.deleted) return false;
    node.deleted = true;
    this.#dirty = true;
    return true;
  }

  /** Rebuilds the document-order lists with an explicit stack, so long runs cannot overflow it. */
  #refresh(): void {
    if (!this.#dirty) return;
    const order: CharNode[] = [];
    const stack: WalkItem[] = [];
    const expand = (tree: TreeNode, self: CharNode | undefined): void => {
      for (let i = tree.right.length - 1; i >= 0; i -= 1) {
        stack.push({ node: mustAt(tree.right, i), expanded: false });
      }
      if (self !== undefined) stack.push({ node: self, expanded: true });
      for (let i = tree.left.length - 1; i >= 0; i -= 1) {
        stack.push({ node: mustAt(tree.left, i), expanded: false });
      }
    };
    expand(this.#root, undefined);
    for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
      if (item.expanded) {
        item.node.index = order.length;
        order.push(item.node);
      } else {
        expand(item.node, item.node);
      }
    }
    this.#order = order;
    this.#visible = order.filter((node) => !node.deleted);
    this.#dirty = false;
  }
}
