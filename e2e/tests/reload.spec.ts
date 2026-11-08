import { noteIn } from '../support/board';
import { expectConverged, test, expect } from '../support/fixtures';
import { SPOTS } from '../support/geometry';
import { sleep } from '../support/wait';

test.describe('a full page reload', () => {
  test('brings back the same board, for whoever reloads', async ({ openBoard }) => {
    const {
      people: { ann, ben },
      everyone,
    } = await openBoard('ann', 'ben');
    const first = await ann.createNote(SPOTS.left);
    await ann.type(first, 'kept across a reload');
    await ann.setColor(first, 'purple');
    expect(await ann.drag(first, { x: 80, y: 60 })).toBe(true);
    const second = await ben.createNote(SPOTS.right);
    await ben.type(second, 'from ben, with an é and a 😀');
    const before = await expectConverged(everyone);
    expect(before).toHaveLength(2);

    await ben.reload();
    expect(await expectConverged(everyone)).toEqual(before);

    await ann.reload();
    expect(await expectConverged(everyone)).toEqual(before);

    // Both at once.
    await Promise.all(everyone.map((person) => person.reload()));
    expect(await expectConverged(everyone)).toEqual(before);
  });

  test('in the middle of someone else’s typing ends with all of it', async ({ openBoard }) => {
    const {
      people: { ann, ben },
      everyone,
    } = await openBoard('ann', 'ben');
    const id = await ann.createNote(SPOTS.left);
    await ann.type(id, 'start: ');
    await ben.waitForText(id, 'start: ');

    const typing = ben.type(id, 'ben keeps typing through the reload', { delayMs: 40 });
    await sleep(300);
    await ann.reload();
    await typing;

    const { text } = noteIn(await expectConverged(everyone), id);
    expect(text).toBe('start: ben keeps typing through the reload');
  });

  test('after changes made while the server was away, keeps them and sends them when it is back', async ({
    openBoard,
    syncServer,
  }) => {
    const {
      people: { ann, ben },
      everyone,
    } = await openBoard('ann', 'ben');
    const id = await ann.createNote(SPOTS.left);
    await ann.type(id, 'saved text');
    await expectConverged(everyone);

    await syncServer.stop();
    await Promise.all(everyone.map((person) => person.waitForSync('offline')));
    await ann.type(id, ' + typed while the server was away');
    // The page writes to the device behind the user's back, a moment after each change.
    await sleep(500);
    await ann.reload({ settle: false });

    // The server is still away, so what this page shows came from the device alone.
    await ann.waitForText(id, 'saved text + typed while the server was away');
    await ann.waitForSync('offline');
    await expect(ann.indicator).toContainText('pending change');

    await syncServer.start();
    const board = await expectConverged(everyone);
    expect(noteIn(board, id).text).toBe('saved text + typed while the server was away');
    await ben.waitForText(id, 'saved text + typed while the server was away');
  });
});
