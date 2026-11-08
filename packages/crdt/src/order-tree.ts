/**
 * An order-statistic tree over the characters of a text in document order: a B+ tree whose leaves
 * hold up to `MAX_LEAF` items and whose inner nodes hold up to `MAX_INNER` children, each node
 * knowing how many items lie below it and how many of them are shown (not deleted).
 *
 * That makes the two lookups a sequence needs cheap, O(log n) instead of a walk over the whole
 * document: *index to item* (`at`, `atShown`: descend by the counts) and *item to index* (`rank`:
 * climb by the parent pointers). Inserting next to a known item, deleting (hiding) an item and
 * reading the text are O(log n) too, the text being cached per leaf. Items are only ever added and
 * hidden, never removed (a deleted character stays as a tombstone), so nodes split but never merge.
 */

/** What the tree needs of an item. `leaf` is the tree's to write; start it as `null`. */
export interface OrderItem {
  leaf: unknown;
  deleted: boolean;
}

const MAX_LEAF = 64;
const MAX_INNER = 16;

interface Counts {
  /** Items below this node, deleted ones included. */
  count: number;
  /** Items below this node that are not deleted. */
  shown: number;
}

interface Leaf<T> extends Counts {
  readonly kind: 'leaf';
  parent: Inner<T> | null;
  readonly items: T[];
  /** The leaf after this one in document order. */
  next: Leaf<T> | null;
  /** The shown characters of this leaf, or `null` if they have to be worked out again. */
  text: string | null;
}

interface Inner<T> extends Counts {
  readonly kind: 'inner';
  parent: Inner<T> | null;
  readonly children: (Leaf<T> | Inner<T>)[];
}

type Node<T> = Leaf<T> | Inner<T>;

function newLeaf<T>(items: T[]): Leaf<T> {
  return {
    kind: 'leaf',
    parent: null,
    items,
    next: null,
    count: items.length,
    shown: 0,
    text: null,
  };
}

function newInner<T>(children: Node<T>[]): Inner<T> {
  const inner: Inner<T> = { kind: 'inner', parent: null, children, count: 0, shown: 0 };
  for (const child of children) {
    child.parent = inner;
    inner.count += child.count;
    inner.shown += child.shown;
  }
  return inner;
}

export class OrderTree<T extends OrderItem> {
  readonly #characterOf: (item: T) => string;
  #root: Node<T>;
  /** The first leaf; the others follow through `next`. */
  readonly #head: Leaf<T>;
  #text: string | null = '';

  /** `characterOf` gives the text an item shows. */
  constructor(characterOf: (item: T) => string) {
    this.#characterOf = characterOf;
    this.#head = newLeaf<T>([]);
    this.#root = this.#head;
  }

  /** Number of items, deleted ones included. */
  get size(): number {
    return this.#root.count;
  }

  /** Number of items that are not deleted. */
  get shown(): number {
    return this.#root.shown;
  }

  /** The first item, or `undefined` if there is none. */
  first(): T | undefined {
    return this.#head.items[0];
  }

  /** The item that follows `item` in document order. */
  after(item: T): T | undefined {
    const leaf = this.#leafOf(item);
    return leaf.items[leaf.items.indexOf(item) + 1] ?? leaf.next?.items[0];
  }

  /** Puts `item` right after `previous`, or at the very start if that is `null`. */
  insertAfter(previous: T | null, item: T): void {
    if (previous === null) {
      this.#place(this.#head, 0, item);
      return;
    }
    const leaf = this.#leafOf(previous);
    this.#place(leaf, leaf.items.indexOf(previous) + 1, item);
  }

  /** Puts `item` right before `following`. */
  insertBefore(following: T, item: T): void {
    const leaf = this.#leafOf(following);
    this.#place(leaf, leaf.items.indexOf(following), item);
  }

  /** Hides `item` (it stays in place as a tombstone). Returns false if it was hidden already. */
  hide(item: T): boolean {
    if (item.deleted) return false;
    const leaf = this.#leafOf(item);
    item.deleted = true;
    leaf.text = null;
    this.#text = null;
    for (let node: Node<T> | null = leaf; node !== null; node = node.parent) node.shown -= 1;
    return true;
  }

  /** Where `item` is among all items, deleted ones included. */
  rank(item: T): number {
    const leaf = this.#leafOf(item);
    let rank = leaf.items.indexOf(item);
    let node: Node<T> = leaf;
    for (let parent = node.parent; parent !== null; parent = node.parent) {
      for (const sibling of parent.children) {
        if (sibling === node) break;
        rank += sibling.count;
      }
      node = parent;
    }
    return rank;
  }

  /** The item at `index` among all items, deleted ones included. */
  at(index: number): T {
    if (!Number.isInteger(index) || index < 0 || index >= this.size) {
      throw new RangeError(`index ${index} out of range 0-${this.size}`);
    }
    let rest = index;
    let node = this.#root;
    while (node.kind === 'inner') {
      [node, rest] = this.#descend(node, rest, (child) => child.count);
    }
    return this.#itemAt(node, rest, false);
  }

  /** The item at `index` among the shown items. */
  atShown(index: number): T {
    const [leaf, offset] = this.#locateShown(index);
    return this.#itemAt(leaf, offset, true);
  }

  /** The `length` shown items from `index` on. */
  shownRange(index: number, length: number): T[] {
    const items: T[] = [];
    if (length <= 0) return items;
    const [start, offset] = this.#locateShown(index);
    let skip = offset;
    for (let leaf: Leaf<T> | null = start; leaf !== null; leaf = leaf.next) {
      for (const item of leaf.items) {
        if (item.deleted) continue;
        if (skip > 0) {
          skip -= 1;
          continue;
        }
        items.push(item);
        if (items.length === length) return items;
      }
    }
    throw new RangeError(`range ${index}+${length} reaches past the ${this.shown} shown items`);
  }

  /** The shown characters, in order. Cached until the tree changes. */
  text(): string {
    if (this.#text !== null) return this.#text;
    const parts: string[] = [];
    for (let leaf: Leaf<T> | null = this.#head; leaf !== null; leaf = leaf.next) {
      leaf.text ??= leaf.items
        .filter((item) => !item.deleted)
        .map(this.#characterOf)
        .join('');
      parts.push(leaf.text);
    }
    this.#text = parts.join('');
    return this.#text;
  }

  /** Every item in order, deleted ones included. */
  toArray(): T[] {
    const items: T[] = [];
    for (let leaf: Leaf<T> | null = this.#head; leaf !== null; leaf = leaf.next) {
      for (const item of leaf.items) items.push(item);
    }
    return items;
  }

  /** Throws if the tree does not hold together. For tests. */
  assertConsistent(): void {
    const leaves: Leaf<T>[] = [];
    const walk = (node: Node<T>, parent: Inner<T> | null): Counts => {
      if (node.parent !== parent) throw new Error('Invariant violated: wrong parent pointer');
      let total = 0;
      let shown = 0;
      if (node.kind === 'leaf') {
        leaves.push(node);
        if (node.items.length > MAX_LEAF) throw new Error('Invariant violated: leaf too big');
        for (const item of node.items) {
          if (item.leaf !== node) throw new Error('Invariant violated: item in the wrong leaf');
          total += 1;
          if (!item.deleted) shown += 1;
        }
      } else {
        if (node.children.length > MAX_INNER) throw new Error('Invariant violated: node too big');
        for (const child of node.children) {
          const below = walk(child, node);
          total += below.count;
          shown += below.shown;
        }
      }
      if (node.count !== total || node.shown !== shown) {
        throw new Error(
          `Invariant violated: counts ${node.count}/${node.shown}, not ${total}/${shown}`,
        );
      }
      return { count: total, shown };
    };
    walk(this.#root, null);
    const chain: Leaf<T>[] = [];
    for (let leaf: Leaf<T> | null = this.#head; leaf !== null; leaf = leaf.next) chain.push(leaf);
    if (chain.length !== leaves.length || chain.some((leaf, i) => leaf !== leaves[i])) {
      throw new Error('Invariant violated: leaves are not chained in order');
    }
  }

  #leafOf(item: T): Leaf<T> {
    const leaf = item.leaf as Leaf<T> | null;
    if (leaf === null) throw new Error('Invariant violated: item is not in the tree');
    return leaf;
  }

  #itemAt(leaf: Leaf<T>, offset: number, shownOnly: boolean): T {
    if (!shownOnly) {
      const item = leaf.items[offset];
      if (item === undefined) throw new Error('Invariant violated: no item at the offset');
      return item;
    }
    let rest = offset;
    for (const item of leaf.items) {
      if (item.deleted) continue;
      if (rest === 0) return item;
      rest -= 1;
    }
    throw new Error('Invariant violated: no shown item at the offset');
  }

  /** The leaf holding the shown item `index`, and how many shown items come before it in the leaf. */
  #locateShown(index: number): [Leaf<T>, number] {
    if (!Number.isInteger(index) || index < 0 || index >= this.shown) {
      throw new RangeError(`index ${index} out of range 0-${this.shown}`);
    }
    let rest = index;
    let node = this.#root;
    while (node.kind === 'inner') {
      [node, rest] = this.#descend(node, rest, (child) => child.shown);
    }
    return [node, rest];
  }

  /**
   * The child of `inner` that holds the item `index` places in (counting by `weigh`: all nodes or
   * shown ones), and the place of that item among the child's own.
   */
  #descend(inner: Inner<T>, index: number, weigh: (child: Node<T>) => number): [Node<T>, number] {
    let rest = index;
    for (const child of inner.children) {
      const weight = weigh(child);
      if (rest < weight) return [child, rest];
      rest -= weight;
    }
    throw new Error('Invariant violated: counts do not add up');
  }

  #place(leaf: Leaf<T>, index: number, item: T): void {
    leaf.items.splice(index, 0, item);
    item.leaf = leaf;
    leaf.text = null;
    this.#text = null;
    const shown = item.deleted ? 0 : 1;
    for (let node: Node<T> | null = leaf; node !== null; node = node.parent) {
      node.count += 1;
      node.shown += shown;
    }
    if (leaf.items.length > MAX_LEAF) this.#splitLeaf(leaf);
  }

  #splitLeaf(leaf: Leaf<T>): void {
    const moved = leaf.items.splice(leaf.items.length >> 1);
    const sibling = newLeaf(moved);
    for (const item of moved) {
      item.leaf = sibling;
      if (!item.deleted) sibling.shown += 1;
    }
    leaf.count -= sibling.count;
    leaf.shown -= sibling.shown;
    leaf.text = null;
    sibling.next = leaf.next;
    leaf.next = sibling;
    this.#attach(leaf, sibling);
  }

  #splitInner(inner: Inner<T>): void {
    const sibling = newInner(inner.children.splice(inner.children.length >> 1));
    inner.count -= sibling.count;
    inner.shown -= sibling.shown;
    this.#attach(inner, sibling);
  }

  /** Makes `sibling` the node after `node` in their parent, splitting upwards if that is full. */
  #attach(node: Node<T>, sibling: Node<T>): void {
    const parent = node.parent;
    if (parent === null) {
      this.#root = newInner([node, sibling]);
      return;
    }
    parent.children.splice(parent.children.indexOf(node) + 1, 0, sibling);
    sibling.parent = parent;
    if (parent.children.length > MAX_INNER) this.#splitInner(parent);
  }
}
