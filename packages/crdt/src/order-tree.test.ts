import { describe, expect, it } from 'vitest';
import { OrderTree, type OrderItem } from './order-tree';
import { must } from './test-support';

interface Item extends OrderItem {
  readonly character: string;
}

const item = (character: string): Item => ({ character, leaf: null, deleted: false });
const tree = () => new OrderTree<Item>((each) => each.character);

/** The same items in the same order, by identity: items point at their leaf, which points back. */
const sameItems = (actual: readonly Item[], expected: readonly (Item | undefined)[]): boolean =>
  actual.length === expected.length && actual.every((each, i) => each === expected[i]);

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** Every question the tree can answer, checked against a plain array. */
function expectSame(subject: OrderTree<Item>, model: readonly Item[]): void {
  subject.assertConsistent();
  expect(subject.size).toBe(model.length);
  const shown = model.filter((each) => !each.deleted);
  expect(subject.shown).toBe(shown.length);
  expect(subject.text()).toBe(shown.map((each) => each.character).join(''));
  expect(sameItems(subject.toArray(), model)).toBe(true);
}

describe('OrderTree', () => {
  it('starts empty', () => {
    const t = tree();
    expect(t.size).toBe(0);
    expect(t.shown).toBe(0);
    expect(t.text()).toBe('');
    expect(t.first()).toBeUndefined();
    expect(t.toArray()).toEqual([]);
    expect(() => t.at(0)).toThrow(RangeError);
    expect(() => t.atShown(0)).toThrow(RangeError);
    t.assertConsistent();
  });

  it('places items after and before others', () => {
    const t = tree();
    const [b, a, c, d] = [item('b'), item('a'), item('c'), item('d')];
    t.insertAfter(null, b);
    t.insertBefore(b, a);
    t.insertAfter(b, c);
    t.insertAfter(c, d);
    expect(t.text()).toBe('abcd');
    expect(t.first()).toBe(a);
    expect(t.after(a)).toBe(b);
    expect(t.after(d)).toBeUndefined();
    expect([a, b, c, d].map((each) => t.rank(each))).toEqual([0, 1, 2, 3]);
    expect(sameItems([0, 1, 2, 3].map((i) => t.at(i)), [a, b, c, d])).toBe(true);
  });

  it('hides items without losing their place, and says whether it did', () => {
    const t = tree();
    const items = ['a', 'b', 'c', 'd'].map(item);
    items.forEach((each, i) => t.insertAfter(i === 0 ? null : must(items[i - 1]), each));
    expect(t.hide(must(items[1]))).toBe(true);
    expect(t.hide(must(items[1]))).toBe(false);
    expect(t.text()).toBe('acd');
    expect(t.shown).toBe(3);
    expect(t.size).toBe(4);
    expect(t.rank(must(items[2]))).toBe(2);
    expect(t.atShown(1)).toBe(items[2]);
    expect(t.at(1)).toBe(items[1]);
    expect(sameItems(t.shownRange(0, 3), [items[0], items[2], items[3]])).toBe(true);
    t.assertConsistent();
  });

  it('answers shownRange from the middle, across leaves, and refuses to run past the end', () => {
    const t = tree();
    const items = Array.from({ length: 500 }, (_, i) => item(String.fromCharCode(33 + (i % 90))));
    items.forEach((each, i) => t.insertAfter(i === 0 ? null : must(items[i - 1]), each));
    for (let i = 0; i < 500; i += 7) t.hide(must(items[i]));
    const shown = items.filter((each) => !each.deleted);
    expect(sameItems(t.shownRange(0, shown.length), shown)).toBe(true);
    expect(sameItems(t.shownRange(100, 150), shown.slice(100, 250))).toBe(true);
    expect(sameItems(t.shownRange(shown.length - 1, 1), shown.slice(-1))).toBe(true);
    expect(t.shownRange(5, 0)).toEqual([]);
    expect(() => t.shownRange(shown.length - 1, 2)).toThrow(RangeError);
    expect(() => t.shownRange(shown.length, 1)).toThrow(RangeError);
  });

  it('agrees with an array through thousands of random insertions and hidings', () => {
    const random = lcg(7);
    const t = tree();
    const model: Item[] = [];
    for (let step = 0; step < 6000; step += 1) {
      const roll = random();
      if (roll < 0.75 || model.length === 0) {
        const added = item(String.fromCharCode(97 + (step % 26)));
        const where = Math.floor(random() * (model.length + 1));
        if (where === 0) {
          // A random mix of the three ways of putting an item at a place.
          if (random() < 0.5 || model.length === 0) t.insertAfter(null, added);
          else t.insertBefore(must(model[0]), added);
        } else if (random() < 0.5) {
          t.insertAfter(must(model[where - 1]), added);
        } else if (where < model.length) {
          t.insertBefore(must(model[where]), added);
        } else {
          t.insertAfter(must(model[where - 1]), added);
        }
        model.splice(where, 0, added);
      } else {
        const target = must(model[Math.floor(random() * model.length)]);
        t.hide(target);
      }
      if (step % 400 === 0) expectSame(t, model);
    }
    expectSame(t, model);
    // The questions about places, for every item.
    const shown = model.filter((each) => !each.deleted);
    model.forEach((each, i) => {
      expect(t.rank(each)).toBe(i);
      expect(t.after(each)).toBe(model[i + 1]);
    });
    shown.forEach((each, i) => expect(t.atShown(i)).toBe(each));
    for (let i = 0; i < model.length; i += 37) expect(t.at(i)).toBe(model[i]);
    expect(t.first()).toBe(model[0]);
  });

  it('grows more than two levels deep and stays correct when appending, prepending and filling a gap', () => {
    for (const where of ['end', 'start', 'middle'] as const) {
      const t = tree();
      const model: Item[] = [];
      for (let i = 0; i < 4000; i += 1) {
        const added = item('x');
        const at = where === 'end' ? model.length : where === 'start' ? 0 : model.length >> 1;
        if (at === 0) t.insertAfter(null, added);
        else t.insertAfter(must(model[at - 1]), added);
        model.splice(at, 0, added);
      }
      expectSame(t, model);
      expect(t.rank(must(model[3999]))).toBe(3999);
      expect(t.at(2000)).toBe(model[2000]);
    }
  });

  it('counts an item that is put in already hidden as held but not shown', () => {
    const t = tree();
    const hidden: Item = { character: 'h', leaf: null, deleted: true };
    const shown = item('s');
    t.insertAfter(null, hidden);
    t.insertAfter(hidden, shown);
    expect(t.size).toBe(2);
    expect(t.shown).toBe(1);
    expect(t.text()).toBe('s');
    expect(t.atShown(0)).toBe(shown);
    expect(t.hide(hidden)).toBe(false);
    // Enough of them to split leaves, with some hidden on either side of the split.
    const model: Item[] = [hidden, shown];
    for (let i = 0; i < 300; i += 1) {
      const added: Item = { character: 'x', leaf: null, deleted: i % 3 === 0 };
      t.insertAfter(must(model.at(-1)), added);
      model.push(added);
    }
    expectSame(t, model);
  });

  it('refuses an index out of range and an item it does not hold', () => {
    const t = tree();
    t.insertAfter(null, item('a'));
    expect(() => t.at(1)).toThrow(RangeError);
    expect(() => t.at(-1)).toThrow(RangeError);
    expect(() => t.atShown(1)).toThrow(RangeError);
    expect(() => t.rank(item('z'))).toThrow('not in the tree');
    expect(() => t.insertAfter(item('z'), item('y'))).toThrow('not in the tree');
  });

  it('notices when its counts are wrong', () => {
    const t = tree();
    const added = item('a');
    t.insertAfter(null, added);
    added.deleted = true; // behind the tree's back
    expect(() => t.assertConsistent()).toThrow('counts');
  });
});
