import { noteIn } from '../support/board';
import { expectConverged, test, expect } from '../support/fixtures';
import { SPOTS } from '../support/geometry';
import { only } from '../support/text';

/** Slow enough that the people typing together really are typing at the same moments. */
const KEYSTROKE_MS = 25;

test.describe('typing in the same note at the same time', () => {
  test('two people at the same place keep every keystroke, each person’s in order', async ({
    openBoard,
  }) => {
    const {
      people: { ann, ben },
      everyone,
    } = await openBoard('ann', 'ben');
    const id = await ann.createNote(SPOTS.left);
    await ben.waitForNote(id);

    // Each types with letters of their own, so that what each typed can be picked out of the result.
    const annTypes = 'ABCDEFGHIJKLMNOPQRST';
    const benTypes = 'abcdefghijklmnopqrst';
    await Promise.all([
      ann.type(id, annTypes, { delayMs: KEYSTROKE_MS }),
      ben.type(id, benTypes, { delayMs: KEYSTROKE_MS }),
    ]);

    const { text } = noteIn(await expectConverged(everyone), id);
    expect(only(text, annTypes)).toBe(annTypes);
    expect(only(text, benTypes)).toBe(benTypes);
    expect(Array.from(text)).toHaveLength(annTypes.length + benTypes.length);
  });

  test('three people typing before, inside and after a text they share each keep their own place', async ({
    openBoard,
  }) => {
    const {
      people: { ann, ben, cat },
      everyone,
    } = await openBoard('ann', 'ben', 'cat');
    const id = await ann.createNote(SPOTS.left);
    await ann.type(id, '0123456789');
    await Promise.all([ben.waitForText(id, '0123456789'), cat.waitForText(id, '0123456789')]);

    await Promise.all([
      ann.type(id, 'ABCDEFGHIJKLMNOP', { caret: 0, delayMs: KEYSTROKE_MS }),
      ben.type(id, 'abcdefghijklmnop', { caret: 0.5, delayMs: KEYSTROKE_MS }),
      cat.type(id, '!#$%&*+-:;<=>?@^', { caret: 1, delayMs: KEYSTROKE_MS }),
    ]);

    const { text } = noteIn(await expectConverged(everyone), id);
    expect(text).toBe('ABCDEFGHIJKLMNOP01234abcdefghijklmnop56789!#$%&*+-:;<=>?@^');
  });

  test('typing after a phrase while someone else erases the phrase', async ({ openBoard }) => {
    const {
      people: { ann, ben },
      everyone,
    } = await openBoard('ann', 'ben');
    const id = await ann.createNote(SPOTS.left);
    await ann.type(id, 'The quick brown fox');
    await ben.waitForText(id, 'The quick brown fox');

    await Promise.all([
      // With the caret just before "fox", twelve backspaces take out "quick brown ".
      ben.erase(id, 12, { caret: 16 / 19, delayMs: KEYSTROKE_MS }),
      ann.type(id, ' jumps over the lazy dog', { delayMs: KEYSTROKE_MS }),
    ]);

    const { text } = noteIn(await expectConverged(everyone), id);
    expect(text).toBe('The fox jumps over the lazy dog');
  });
});
