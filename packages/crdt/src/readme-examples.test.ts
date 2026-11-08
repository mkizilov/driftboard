import { describe, expect, it } from 'vitest';
import {
  AwMap,
  Board,
  BoardHistory,
  HybridLogicalClock,
  LwwRegister,
  TextSequence,
  VersionVector,
  createManualClock,
  opId,
  replicaId,
} from './index';

/**
 * The examples of README.md, as tests: what the README says these calls give is what they give.
 * Change one here and change the README with it.
 */

describe('README: the last-writer-wins register', () => {
  it('breaks a tie in time by replica id, so every order gives the same value', () => {
    const alice = new HybridLogicalClock({
      replicaId: replicaId('alice'),
      physicalClock: createManualClock(1000),
    });
    const bob = new HybridLogicalClock({
      replicaId: replicaId('bob'),
      physicalClock: createManualClock(1000),
    });

    const title = LwwRegister.empty<string>();
    const aliceWrites = title.prepareSet('Groceries', alice.tick());
    const bobWrites = title.prepareSet('Errands', bob.tick()); // the same millisecond

    expect(title.apply(aliceWrites).apply(bobWrites).value).toBe('Errands');
    expect(title.apply(bobWrites).apply(aliceWrites).value).toBe('Errands');
    // Applying a write twice changes nothing.
    expect(title.apply(bobWrites).apply(bobWrites).value).toBe('Errands');
  });
});

describe('README: the add-wins map', () => {
  it('keeps a note that one replica rewrites while another deletes it', () => {
    const alice = replicaId('alice');
    const join = (a: string, b: string) => (a > b ? a : b); // for values that survive together

    const empty = AwMap.empty<string>(join);
    const shared = empty.apply(empty.prepareSet(alice, 'note-1', 'buy milk')); // both have this

    const rewrite = shared.prepareSet(alice, 'note-1', 'buy oat milk'); // alice rewrites it...
    const remove = shared.prepareRemove('note-1'); // ...while bob deletes it
    if (remove === undefined) throw new Error('the note is there to remove');

    expect(shared.apply(rewrite).apply(remove).get('note-1')).toBe('buy oat milk');
    expect(shared.apply(remove).apply(rewrite).get('note-1')).toBe('buy oat milk');
    // A delete removes only the writes it had seen.
    expect(shared.apply(remove).has('note-1')).toBe(false);
  });
});

describe('README: the text sequence', () => {
  it('keeps two people’s concurrent insertions whole, and the same on both sides', () => {
    const alice = new TextSequence(replicaId('alice'));
    const bob = new TextSequence(replicaId('bob'));

    for (const op of alice.insert(0, 'Hello world')) bob.apply(op);

    const fromAlice = alice.insert(6, 'brave '); // Hello brave world
    const fromBob = bob.insert(6, 'big '); // Hello big world
    for (const op of fromBob) alice.apply(op);
    for (const op of fromAlice) bob.apply(op);

    expect(alice.toString()).toBe(bob.toString());
    expect(alice.toString()).toBe('Hello big brave world');
  });

  it('turns a deletion into a tombstone, so a concurrent insertion still has its place', () => {
    const alice = new TextSequence(replicaId('alice'));
    const bob = new TextSequence(replicaId('bob'));
    for (const op of alice.insert(0, 'abc')) bob.apply(op);

    const removal = alice.delete(1, 1); // alice deletes "b"
    const insertion = bob.insert(2, 'X'); // bob types after "b"
    for (const op of insertion) alice.apply(op);
    for (const op of removal) bob.apply(op);

    expect(alice.toString()).toBe('aXc');
    expect(bob.toString()).toBe('aXc');
    expect(alice.nodes().map((node) => [node.value, node.deleted])).toEqual([
      ['a', false],
      ['b', true],
      ['X', false],
      ['c', false],
    ]);
  });

  it('holds an operation back until the one it depends on arrives', () => {
    const alice = new TextSequence(replicaId('alice'));
    const bob = new TextSequence(replicaId('bob'));
    const [h, i] = alice.insert(0, 'hi');
    if (h === undefined || i === undefined) throw new Error('two operations');

    bob.apply(i); // "i" hangs off "h", which has not arrived
    expect(bob.pendingCount).toBe(1);
    expect(bob.toString()).toBe('');
    bob.apply(h);
    expect(bob.pendingCount).toBe(0);
    expect(bob.toString()).toBe('hi');
  });
});

describe('README: version vectors', () => {
  it('say exactly which operations a replica holds', () => {
    const alice = replicaId('alice');
    const bob = replicaId('bob');
    const mine = VersionVector.from([
      [alice, 3],
      [bob, 1],
    ]);
    const theirs = VersionVector.from([[alice, 2]]);
    expect(mine.compare(theirs)).toBe('after');
    expect(mine.includes(opId(3, alice))).toBe(true);
    expect(theirs.includes(opId(3, alice))).toBe(false);
    expect(mine.merge(theirs).entries()).toEqual(mine.entries());
  });
});

describe('README: the board', () => {
  it('keeps a note that is edited and dragged while it is deleted', () => {
    const clock = createManualClock(1000);
    const alice = new Board({ replicaId: replicaId('alice'), clock });
    const bob = new Board({ replicaId: replicaId('bob'), clock });
    const carol = new Board({ replicaId: replicaId('carol'), clock });

    const { id, ops: created } = alice.createNote({ x: 10, y: 10 });
    bob.applyRemote(created);
    carol.applyRemote(created);

    const typed = bob.editText(id, 0, 0, 'call mum'); // bob types in it
    const removed = carol.deleteNote(id); // carol deletes it
    const moved = alice.moveNote(id, 200, 40); // alice drags it

    // Everyone hears of everything, each in an order of their own.
    alice.applyRemote([...removed, ...typed]);
    bob.applyRemote([...moved, ...removed]);
    carol.applyRemote([...typed, ...moved]);

    for (const board of [alice, bob, carol]) {
      expect(board.getNote(id)).toMatchObject({ x: 200, y: 40, text: 'call mum' });
    }
    expect(JSON.stringify(bob.snapshot())).toBe(JSON.stringify(alice.snapshot()));
    expect(JSON.stringify(carol.snapshot())).toBe(JSON.stringify(alice.snapshot()));
  });

  it('lets two people move a note at once without tearing x from y', () => {
    const a = new Board({ replicaId: replicaId('alice'), clock: createManualClock(1000) });
    const b = new Board({ replicaId: replicaId('bob'), clock: createManualClock(1000) });
    const { id, ops } = a.createNote();
    b.applyRemote(ops);
    const fromA = a.moveNote(id, 100, 100);
    const fromB = b.moveNote(id, 300, 300);
    a.applyRemote(fromB);
    b.applyRemote(fromA);
    const { x, y } = a.getNote(id) ?? { x: -1, y: -1 };
    expect(x).toBe(y); // both from alice, or both from bob, never one of each
    expect(b.getNote(id)).toMatchObject({ x, y });
  });
});

describe('README: undo', () => {
  it('takes back only what you did, and leaves what others typed in the same note', () => {
    const clock = createManualClock(1000);
    const alice = new Board({ replicaId: replicaId('alice'), clock });
    const bob = new Board({ replicaId: replicaId('bob'), clock });
    const history = new BoardHistory(alice, { now: () => clock.now() });

    const { id, ops: created } = history.createNote();
    const mine = history.editText(id, 0, 0, 'mine');
    bob.applyRemote([...created, ...mine]);
    const theirs = bob.editText(id, 4, 0, ' + bob'); // bob types after "mine"
    alice.applyRemote(theirs);
    expect(alice.getNote(id)?.text).toBe('mine + bob');

    const undone = history.undo(); // alice presses Ctrl+Z
    expect(alice.getNote(id)?.text).toBe(' + bob');
    bob.applyRemote(undone);
    expect(bob.getNote(id)?.text).toBe(' + bob');
  });
});
