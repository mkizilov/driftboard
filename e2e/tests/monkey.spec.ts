import { expectConverged, test, expect } from '../support/fixtures';
import { SPOTS } from '../support/geometry';
import { planMonkey } from '../support/monkey-plan';
import { runMonkey } from '../support/monkey-run';
import { seedFrom } from '../support/rng';

const ACTIONS = 200;
const PEOPLE = 3;
/** Fewer than this many actions that did something means the run was not testing much. */
const MIN_PERFORMED = 100;

// `E2E_SEED=n` repeats a run (the seed is in the name of the test and in its report), and
// `E2E_MONKEY_RUNS=n` makes n runs, on the seeds from that one up.
const firstSeed = seedFrom(process.env['E2E_SEED'], 20260101);
const runs = Number(process.env['E2E_MONKEY_RUNS'] ?? 1);
if (!Number.isInteger(runs) || runs < 1) {
  throw new Error(`E2E_MONKEY_RUNS must be a whole number of at least 1, got ${runs}`);
}

test.describe('monkey', () => {
  for (let run = 0; run < runs; run += 1) {
    const seed = firstSeed + run;

    test(`${ACTIONS} random actions across ${PEOPLE} contexts end with identical boards (seed ${seed})`, async ({
      openBoard,
    }, testInfo) => {
      test.setTimeout(10 * 60_000);
      const {
        people: { ann },
        everyone,
      } = await openBoard('ann', 'ben', 'cat');

      // Two notes to start with, so that the first actions have something to act on.
      const first = await ann.createNote(SPOTS.left);
      await ann.type(first, 'monkey start');
      await ann.createNote(SPOTS.right);
      await expectConverged(everyone);

      const plan = planMonkey(seed, ACTIONS, PEOPLE);
      await testInfo.attach('monkey-plan.json', {
        body: JSON.stringify({ seed, plan }, null, 1),
        contentType: 'application/json',
      });
      const report = await runMonkey(plan, everyone);
      await testInfo.attach('monkey-report.json', {
        body: JSON.stringify(report, null, 1),
        contentType: 'application/json',
      });

      // Whoever is still offline comes back, and then every board must be the same.
      await Promise.all(everyone.map((person) => person.goOnline()));
      await expectConverged(everyone);

      expect(report.performed + report.skipped).toBe(ACTIONS);
      expect(report.performed).toBeGreaterThanOrEqual(MIN_PERFORMED);
    });
  }
});
