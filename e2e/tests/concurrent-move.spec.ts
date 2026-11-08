import { noteIn } from '../support/board';
import { expectConverged, test, expect } from '../support/fixtures';
import { SPOTS, type Point } from '../support/geometry';
import type { DragOptions, Person } from '../support/person';

const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });

test.describe('moving notes at the same time', () => {
  test('two people dragging one note end with it in one place for both', async ({ openBoard }) => {
    const {
      people: { ann, ben },
      everyone,
    } = await openBoard('ann', 'ben');
    const id = await ann.createNote(SPOTS.left);
    await ben.waitForNote(id);

    /**
     * Both drag the note by different amounts and let go together, or one a little after the
     * other. The two moves are concurrent: the later one wins, whole. And a drag is added to
     * where the note is when it ends, so a person who was still dragging when the other let go
     * adds their drag to the other's result. It never ends up with x from one and y from another.
     */
    const round = async (
      byAnn: Point,
      byBen: Point,
      annDrag: DragOptions,
      benDrag: DragOptions,
    ): Promise<void> => {
      const before = noteIn(await expectConverged(everyone), id);
      const from = { x: before.x, y: before.y };

      const moved = await Promise.all([ann.drag(id, byAnn, annDrag), ben.drag(id, byBen, benDrag)]);
      expect(moved).toEqual([true, true]);

      const after = noteIn(await expectConverged(everyone), id);
      expect([add(from, byAnn), add(from, byBen), add(add(from, byAnn), byBen)]).toContainEqual({
        x: after.x,
        y: after.y,
      });
    };

    // Let go at the same time.
    await round({ x: 120, y: 40 }, { x: -90, y: 150 }, { steps: 6 }, { steps: 6 });
    // One lets go while the other is still dragging.
    await round({ x: -80, y: -30 }, { x: 60, y: -60 }, { steps: 8, stepDelayMs: 40 }, { steps: 2 });
    await round({ x: 40, y: 70 }, { x: -50, y: 20 }, { steps: 2 }, { steps: 8, stepDelayMs: 40 });
  });

  test('three people dragging two notes at once end with identical boards', async ({
    openBoard,
  }) => {
    const {
      people: { ann, ben, cat },
      everyone,
    } = await openBoard('ann', 'ben', 'cat');
    const notes = [await ann.createNote(SPOTS.left), await ann.createNote(SPOTS.right)];
    await Promise.all([
      ...notes.map((id) => ben.waitForNote(id)),
      ...notes.map((id) => cat.waitForNote(id)),
    ]);

    const moves: Point[] = [
      { x: 90, y: 40 },
      { x: -70, y: 80 },
      { x: 30, y: -90 },
      { x: -50, y: -20 },
    ];
    // Each keeps moving one note after another, a different one at each turn. A note that ends
    // up under the other cannot be taken hold of, and a move that finds that is passed over.
    const keepMoving = async (person: Person, turn: number): Promise<number> => {
      let moved = 0;
      for (let round = 0; round < 6; round += 1) {
        const id = notes[(round + turn) % notes.length];
        const by = moves[(round + turn) % moves.length];
        if (id === undefined || by === undefined) throw new Error('no note or move to make');
        if (await person.moveBy(id, by.x, by.y)) moved += 1;
      }
      return moved;
    };

    const counts = await Promise.all(everyone.map((person, turn) => keepMoving(person, turn)));
    expect(counts.reduce((sum, count) => sum + count, 0)).toBeGreaterThanOrEqual(6);

    const board = await expectConverged(everyone);
    expect(board).toHaveLength(2);
  });
});
