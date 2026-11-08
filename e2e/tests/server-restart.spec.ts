import { noteIn } from '../support/board';
import { expectConverged, test, expect } from '../support/fixtures';
import { SPOTS } from '../support/geometry';
import { sleep } from '../support/wait';

test.describe('a server restart in the middle of a session', () => {
  test('everyone keeps editing while it is down, and ends with the same board when it is back', async ({
    openBoard,
    syncServer,
  }) => {
    const {
      people: { ann, ben },
      everyone,
      join,
    } = await openBoard('ann', 'ben');
    const id = await ann.createNote(SPOTS.left);
    await ann.type(id, 'before the restart');
    await expectConverged(everyone);

    await syncServer.stop();
    await Promise.all(everyone.map((person) => person.waitForSync('offline')));

    // With the server gone, both go on: one types, the other makes a note and colours it.
    await ann.type(id, ' + ann while it is down');
    const bens = await ben.createNote(SPOTS.right);
    await ben.type(bens, 'ben while it is down');
    await ben.setColor(bens, 'pink');
    await expect(ann.indicator).toContainText('pending change');
    await expect(ben.indicator).toContainText('pending change');

    await syncServer.start();
    const board = await expectConverged(everyone);
    expect(noteIn(board, id).text).toBe('before the restart + ann while it is down');
    expect(noteIn(board, bens).text).toBe('ben while it is down');
    expect(noteIn(board, bens).color).toBe('pink');

    // The server kept the board in its database: someone who arrives now gets all of it.
    const dan = await join('dan');
    expect(await expectConverged([...everyone, dan])).toEqual(board);

    // And the connections are working again, in both directions.
    await dan.type(id, ' + dan after');
    await ann.waitForText(id, 'before the restart + ann while it is down + dan after');
    await expectConverged([...everyone, dan]);
  });

  test('a server that is killed in the middle of typing loses nothing', async ({
    openBoard,
    syncServer,
  }) => {
    const {
      people: { ann, ben },
      everyone,
    } = await openBoard('ann', 'ben');
    const id = await ann.createNote(SPOTS.left);
    const other = await ben.createNote(SPOTS.right);
    await ann.waitForNote(other);
    await ben.waitForNote(id);

    const sentence = 'the quick brown fox jumps over the lazy dog';
    const typing = ann.type(id, sentence, { delayMs: 40 });
    await sleep(500);
    // No shutdown: whatever the server had not written or answered is lost to it.
    await syncServer.kill();
    await ben.type(other, 'ben types while it is dead');
    await typing;

    await syncServer.start();
    const board = await expectConverged(everyone);
    expect(noteIn(board, id).text).toBe(sentence);
    expect(noteIn(board, other).text).toBe('ben types while it is dead');
  });

  test('restarting it once for each person, who types while it is down, ends the same for everyone', async ({
    openBoard,
    syncServer,
  }) => {
    const {
      people: { ann, ben, cat },
      everyone,
    } = await openBoard('ann', 'ben', 'cat');
    const id = await ann.createNote(SPOTS.left);
    await Promise.all([ben.waitForNote(id), cat.waitForNote(id)]);

    const typists = [ann, ben, cat];
    let expected = '';
    for (const [turn, person] of typists.entries()) {
      await syncServer.stop();
      await Promise.all(everyone.map((each) => each.waitForSync('offline')));
      const letters = `${turn + 1}`.repeat(3);
      await person.type(id, letters);
      expected += letters;
      await syncServer.start();
      await expectConverged(everyone);
    }

    const { text } = noteIn(await expectConverged(everyone), id);
    expect(text).toBe(expected);
  });
});
