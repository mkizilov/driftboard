import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { test as base, expect } from '@playwright/test';
import { awaitSameBoards, type BoardNote } from './board';
import { REPO_ROOT, SYNC_PORT } from './env';
import { Person } from './person';
import { SyncServer } from './sync-server';

export { expect };

/** A board that some people have open, each in a browser context of their own. */
export interface OpenedBoard<Name extends string> {
  readonly url: string;
  /** The people by the names they were given. */
  readonly people: Readonly<Record<Name, Person>>;
  /** The same people, in the order they were named. */
  readonly everyone: readonly Person[];
  /** Someone else opens the board, as a person who arrives later. */
  readonly join: (name: string) => Promise<Person>;
}

/** Makes a new board and opens it for the first person named, and then for the others. */
type OpenBoard = <Name extends string>(
  first: Name,
  ...others: Name[]
) => Promise<OpenedBoard<Name>>;

interface TestFixtures {
  openBoard: OpenBoard;
}

interface WorkerFixtures {
  /** The real sync server, on its own database, running for as long as the worker does. */
  syncServer: SyncServer;
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  syncServer: [
    async ({}, use) => {
      const dataRoot = path.join(REPO_ROOT, '.data');
      mkdirSync(dataRoot, { recursive: true });
      const server = new SyncServer({
        port: SYNC_PORT,
        dataDir: mkdtempSync(path.join(dataRoot, 'e2e-')),
        // `node --import tsx` and not the `tsx` command, which starts the server as a child
        // process of its own: killing it would leave the server running.
        command: [process.execPath, '--import', 'tsx', 'src/main.ts'],
        cwd: path.join(REPO_ROOT, 'apps', 'server'),
        // Fold the log into a snapshot early and often, so that restarts load from one.
        env: { DRIFTBOARD_COMPACT_AFTER_OPS: '50' },
      });
      try {
        await server.start();
        await use(server);
      } finally {
        await server.dispose();
      }
    },
    { scope: 'worker', auto: true },
  ],

  openBoard: async ({ browser }, use, testInfo) => {
    const started: Person[] = [];
    const start = async (name: string): Promise<Person> => {
      const person = await Person.start(browser, name);
      started.push(person);
      return person;
    };

    await use(async (first, ...others) => {
      const founder = await start(first);
      const url = await founder.createBoard();
      const people = { [first]: founder } as Record<typeof first, Person>;
      for (const name of others) {
        const person = await start(name);
        await person.openBoard(url);
        people[name] = person;
      }
      return {
        url,
        people,
        everyone: [first, ...others].map((name) => people[name]),
        join: async (name) => {
          const person = await start(name);
          await person.openBoard(url);
          return person;
        },
      };
    });

    const failed = testInfo.status !== testInfo.expectedStatus;
    await Promise.all(
      started.map((person) =>
        person.close(failed ? testInfo.outputPath(`trace-${person.name}.zip`) : undefined),
      ),
    );
  },
});

/**
 * Waits until everyone is connected with nothing left to send, and then until everyone's board is
 * the same (and has stayed the same for a moment). That the boards are identical is the point of
 * the whole suite, so this is what every test ends with. Returns the board they agree on.
 */
export async function expectConverged(people: readonly Person[]): Promise<BoardNote[]> {
  await Promise.all(people.map((person) => person.waitForSync('online')));
  const board = await awaitSameBoards(() =>
    Promise.all(people.map((person) => person.readBoard())),
  );
  expect(people.flatMap((person) => person.pageErrors)).toEqual([]);
  return board;
}
