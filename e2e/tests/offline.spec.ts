import { noteIn } from '../support/board';
import { expectConverged, test, expect } from '../support/fixtures';
import { SPOTS } from '../support/geometry';

test.describe('going offline', () => {
  test('a person who goes offline keeps editing, and everything merges when they come back', async ({
    openBoard,
  }) => {
    const {
      people: { ann, ben, cat },
      everyone,
    } = await openBoard('ann', 'ben', 'cat');
    const first = await ann.createNote(SPOTS.left);
    const second = await ann.createNote(SPOTS.right);
    await ann.type(first, 'first note');
    await ann.type(second, 'second note');
    const start = await expectConverged(everyone);

    // The browser loses the network: `context.setOffline(true)`, and the page notices.
    await ben.goOffline();
    await expect(ben.indicator).toHaveText(/^Offline/);

    // Ben works on alone: text after the first note's, a colour, and a note of his own.
    await ben.type(first, ' [ben offline]');
    await ben.setColor(second, 'green');
    const bens = await ben.createNote(SPOTS.below);
    await ben.type(bens, 'made offline');
    // Meanwhile the others carry on: text before the first note's, and a move of the second.
    await ann.type(first, '(ann online) ', { caret: 0 });
    expect(await cat.drag(second, { x: 0, y: 120 })).toBe(true);

    // What Ben did waits to be sent, and nobody else has any of it.
    await expect(ben.indicator).toContainText('pending change');
    await expect(ben.indicator).toHaveAttribute('data-state', 'offline');
    expect(await ann.noteIds()).not.toContain(bens);
    expect(await cat.noteIds()).not.toContain(bens);
    expect(await ann.text(first)).not.toContain('[ben offline]');
    expect(await cat.text(first)).not.toContain('[ben offline]');

    // The network comes back. The page connects again by itself and sends what it has.
    await ben.goOnline();
    await ben.waitForSync('online');
    const board = await expectConverged(everyone);

    expect(board).toHaveLength(3);
    expect(noteIn(board, first).text).toBe('(ann online) first note [ben offline]');
    expect(noteIn(board, second).color).toBe('green');
    expect(noteIn(board, second).y).toBe(noteIn(start, second).y + 120);
    expect(noteIn(board, bens).text).toBe('made offline');
  });

  test('two people offline at once, both typing at the end of one note, both get all of it', async ({
    openBoard,
  }) => {
    const {
      people: { ann, ben, cat },
      everyone,
    } = await openBoard('ann', 'ben', 'cat');
    const id = await ann.createNote(SPOTS.left);
    await ann.type(id, 'base: ');
    await Promise.all([ben.waitForText(id, 'base: '), cat.waitForText(id, 'base: ')]);

    await Promise.all([ann.goOffline(), ben.goOffline()]);
    await ann.type(id, 'ANN-WAS-OFFLINE');
    await ben.type(id, 'ben-was-offline');
    await cat.type(id, 'cat> ', { caret: 0 });

    // They come back one after the other.
    await ann.goOnline();
    await ann.waitForSync('online');
    await ben.goOnline();
    await ben.waitForSync('online');

    const { text } = noteIn(await expectConverged(everyone), id);
    // Each offline run was typed one character after another, so each stays in one piece; which
    // comes first is for the document to decide, as long as it decides it the same for everyone.
    expect([
      'cat> base: ANN-WAS-OFFLINEben-was-offline',
      'cat> base: ben-was-offlineANN-WAS-OFFLINE',
    ]).toContain(text);
  });

  test('going offline and coming back again and again loses nothing', async ({ openBoard }) => {
    const {
      people: { ann, ben },
      everyone,
    } = await openBoard('ann', 'ben');
    const id = await ann.createNote(SPOTS.left);
    await ann.type(id, '|');
    await ben.waitForText(id, '|');

    // Ben types after the bar and Ann before it, so their letters have places of their own.
    for (const [annTypes, benTypes] of [
      ['A', 'a'],
      ['B', 'b'],
      ['C', 'c'],
      ['D', 'd'],
    ] as const) {
      await ben.goOffline();
      await ben.type(id, benTypes);
      await ben.goOnline();
      // Ann does not wait for Ben to be back: her typing and his catching up cross.
      await ann.type(id, annTypes, { caret: 0 });
    }

    const { text } = noteIn(await expectConverged(everyone), id);
    expect(text).toBe('DCBA|abcd');
  });
});
