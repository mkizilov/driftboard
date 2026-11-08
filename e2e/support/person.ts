import {
  errors,
  expect,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';
import { parseBoard, type BoardNote, type RawNote } from './board';
import { placeCaretIn } from './caret';
import { SYNC_TIMEOUT_MS, VIEWPORT, WEB_URL } from './env';
import { HEADER_GRAB_X, clampMove, freeSpot, type Point } from './geometry';
import type { NoteColorName } from './monkey-plan';
import type { Actor } from './monkey-run';
import { pollUntil, sleep } from './wait';

/**
 * How long an action on one note waits for the note to be there and uncovered. Another person may
 * delete or cover it at any moment, and then the action is given up (see `skipIfGone`).
 */
const ACTION_TIMEOUT_MS = 1500;

/** For things a test asked for outright: a page that is working answers these in milliseconds. */
const PATIENT_TIMEOUT_MS = 10_000;

export interface TypeOptions {
  /** Where in the note's text the caret goes first: 0 is the start and 1 (the default) the end. */
  readonly caret?: number;
  /** Time between keystrokes, so that people who type together really overlap. */
  readonly delayMs?: number;
  readonly timeoutMs?: number;
}

export interface DragOptions {
  /** How many pointer moves the drag is made of. */
  readonly steps?: number;
  /** Time between those moves. */
  readonly stepDelayMs?: number;
  readonly timeoutMs?: number;
}

/**
 * Runs an action on a note that someone else may have deleted or covered by now. Running out of
 * time then means "cannot be done now" (`false`); any other failure is still a failure.
 */
async function skipIfGone(action: () => Promise<boolean>): Promise<boolean> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof errors.TimeoutError) return false;
    throw error;
  }
}

/**
 * One person at a board: a browser context of their own (its own storage and connection, like
 * another device) with one page, driven the way a person would, through the page and nothing else.
 * What they see is read from the page too, so that the boards of different people can be compared.
 */
export class Person implements Actor {
  readonly name: string;
  readonly page: Page;
  /** Uncaught errors the page reported. A board that works throws none. */
  readonly pageErrors: string[] = [];
  readonly #context: BrowserContext;
  #offline = false;

  private constructor(name: string, context: BrowserContext, page: Page) {
    this.name = name;
    this.#context = context;
    this.page = page;
    page.on('pageerror', (error) => {
      this.pageErrors.push(`${error.name}: ${error.message}`);
    });
  }

  /**
   * A new person on a new browser context. Service workers are blocked: the pages are always
   * served by the network, and going offline is the network's doing and nothing else's.
   */
  static async start(browser: Browser, name: string): Promise<Person> {
    const context = await browser.newContext({ viewport: VIEWPORT, serviceWorkers: 'block' });
    await context.tracing.start({ screenshots: true, snapshots: true });
    return new Person(name, context, await context.newPage());
  }

  /** Ends the session. With `tracePath` the trace of everything this person did is kept there. */
  async close(tracePath?: string): Promise<void> {
    await this.#context.tracing.stop(tracePath === undefined ? {} : { path: tracePath });
    await this.#context.close();
  }

  // ---- Getting to a board -------------------------------------------------------------------

  /** Makes a new board from the front page. Returns its address. */
  async createBoard(): Promise<string> {
    await this.page.goto(WEB_URL);
    await this.page.getByRole('button', { name: 'Create a board' }).click();
    await this.page.waitForURL(/\/b\/[^/]+$/);
    await this.waitUntilReady();
    return this.page.url();
  }

  async openBoard(url: string): Promise<void> {
    await this.page.goto(url);
    await this.waitUntilReady();
  }

  /** The board is on the page and connected to the server. */
  async waitUntilReady(): Promise<void> {
    await expect(this.canvas).toBeVisible();
    await this.waitForSync('online');
  }

  // ---- What is on the page ------------------------------------------------------------------

  get canvas(): Locator {
    return this.page.getByTestId('canvas');
  }

  /** The "Online", "Syncing…" or "Offline" badge, whose `data-state` says which. */
  get indicator(): Locator {
    return this.page.locator('.sync');
  }

  get offline(): boolean {
    return this.#offline;
  }

  note(id: string): Locator {
    return this.page.locator(`[data-note-id=${JSON.stringify(id)}]`);
  }

  textarea(id: string): Locator {
    return this.note(id).locator('textarea');
  }

  noteIds(): Promise<string[]> {
    return this.page
      .locator('[data-note-id]')
      .evaluateAll((notes) => notes.map((note) => note.getAttribute('data-note-id') ?? ''));
  }

  text(id: string): Promise<string> {
    return this.textarea(id).inputValue();
  }

  /** Every note as this person sees it, in order of id. */
  async readBoard(): Promise<BoardNote[]> {
    const raw = await this.page.locator('[data-note-id]').evaluateAll(
      (notes): RawNote[] =>
        notes.map((note) => {
          const area = note.querySelector('textarea');
          return {
            id: note.getAttribute('data-note-id') ?? '',
            transform: note.style.transform,
            color: note.getAttribute('data-color') ?? '',
            zIndex: note.style.zIndex,
            text: area === null ? '' : area.value,
          };
        }),
    );
    return parseBoard(raw);
  }

  async waitForNote(id: string): Promise<void> {
    await expect(this.note(id)).toBeVisible();
  }

  async waitForText(id: string, text: string): Promise<void> {
    await expect(this.textarea(id)).toHaveValue(text);
  }

  async waitForSync(
    state: 'online' | 'syncing' | 'offline',
    timeoutMs = SYNC_TIMEOUT_MS,
  ): Promise<void> {
    await expect(this.indicator).toHaveAttribute('data-state', state, { timeout: timeoutMs });
  }

  // ---- Doing things -------------------------------------------------------------------------

  /** Double-clicks the empty canvas at `at`, measured from its corner. */
  async doubleClickCanvas(at: Point): Promise<void> {
    // Forced, because a note that arrives from someone else can land there between choosing the
    // spot and clicking it, and the click then simply does nothing.
    await this.canvas.dblclick({ position: at, force: true });
  }

  /** Makes a note centred on `at` and returns its id. */
  async createNote(at: Point): Promise<string> {
    const known = new Set(await this.noteIds());
    await this.doubleClickCanvas(at);
    return pollUntil('the new note to appear', async () =>
      (await this.noteIds()).find((id) => !known.has(id)),
    );
  }

  /** Puts the caret in a note's text; `caret` is how far along it, from 0 to 1. */
  async placeCaret(id: string, caret: number, timeoutMs = PATIENT_TIMEOUT_MS): Promise<void> {
    await this.textarea(id).evaluate<void, number, HTMLTextAreaElement>(placeCaretIn, caret, {
      timeout: timeoutMs,
    });
  }

  async type(
    id: string,
    text: string,
    { caret = 1, delayMs = 0, timeoutMs = PATIENT_TIMEOUT_MS }: TypeOptions = {},
  ): Promise<void> {
    await this.placeCaret(id, caret, timeoutMs);
    await this.page.keyboard.type(text, { delay: delayMs });
  }

  /** Presses Backspace `count` times with the caret at `caret`. */
  async erase(
    id: string,
    count: number,
    { caret = 1, delayMs = 0, timeoutMs = PATIENT_TIMEOUT_MS }: TypeOptions = {},
  ): Promise<void> {
    await this.placeCaret(id, caret, timeoutMs);
    for (let pressed = 0; pressed < count; pressed += 1) {
      await this.page.keyboard.press('Backspace');
      if (delayMs > 0) await sleep(delayMs);
    }
  }

  /**
   * Drags a note by its header, `delta` pixels, and says whether it could: something else over the
   * header (another note on top of it) means it cannot be taken hold of, and nothing is done.
   * Releasing the pointer is what moves the note for the others.
   */
  async drag(
    id: string,
    delta: Point,
    { steps = 6, stepDelayMs = 0, timeoutMs = PATIENT_TIMEOUT_MS }: DragOptions = {},
  ): Promise<boolean> {
    const box = await this.note(id).locator('.note-header').boundingBox({ timeout: timeoutMs });
    if (box === null) return false;
    const grab = { x: box.x + HEADER_GRAB_X, y: box.y + box.height / 2 };
    const free = await this.page.evaluate(
      ({ x, y, noteId }) => {
        const found = document.elementFromPoint(x, y);
        const header = found?.closest('.note-header');
        return (
          header !== null &&
          header !== undefined &&
          found?.closest('button') === null &&
          header.parentElement?.getAttribute('data-note-id') === noteId
        );
      },
      { ...grab, noteId: id },
    );
    if (!free) return false;

    const { mouse } = this.page;
    await mouse.move(grab.x, grab.y);
    await mouse.down();
    for (let step = 1; step <= steps; step += 1) {
      await mouse.move(grab.x + (delta.x * step) / steps, grab.y + (delta.y * step) / steps);
      if (stepDelayMs > 0) await sleep(stepDelayMs);
    }
    await mouse.up();
    return true;
  }

  async setColor(id: string, color: NoteColorName): Promise<void> {
    await this.note(id)
      .getByRole('button', { name: `Color ${color}`, exact: true })
      .click({ timeout: PATIENT_TIMEOUT_MS });
  }

  async deleteNote(id: string): Promise<void> {
    await this.note(id)
      .getByRole('button', { name: 'Delete note' })
      .click({ timeout: PATIENT_TIMEOUT_MS });
  }

  // ---- The network and the page -------------------------------------------------------------

  /** Cuts this person's browser off from the network, and waits for the page to notice. */
  async goOffline(): Promise<void> {
    await this.#context.setOffline(true);
    this.#offline = true;
    await this.waitForSync('offline', PATIENT_TIMEOUT_MS);
  }

  /** Gives the network back. The page reconnects by itself; `waitForSync('online')` waits for it. */
  async goOnline(): Promise<void> {
    await this.#context.setOffline(false);
    this.#offline = false;
  }

  /**
   * Reloads the page and waits for the board to come back. By default the page first waits until
   * the server has everything it did, as a person would not close a tab in the middle of a sync;
   * `settle: false` is for reloading while the server is away.
   */
  async reload({ settle = true }: { readonly settle?: boolean } = {}): Promise<void> {
    if (settle) await this.waitForSync('online');
    await this.page.reload();
    await expect(this.canvas).toBeVisible();
    if (settle) await this.waitForSync('online');
  }

  // ---- What the monkey can ask for: each says whether it did anything -----------------------

  async create(fx: number, fy: number): Promise<boolean> {
    const canvas = await this.canvas.boundingBox();
    if (canvas === null) return false;
    const spot = freeSpot(await this.readBoard(), canvas, { fx, fy });
    if (spot === null) return false;
    await this.doubleClickCanvas(spot);
    return true;
  }

  typeInto(id: string, caret: number, text: string): Promise<boolean> {
    return skipIfGone(async () => {
      await this.type(id, text, { caret, delayMs: 3, timeoutMs: ACTION_TIMEOUT_MS });
      return true;
    });
  }

  eraseFrom(id: string, caret: number, count: number): Promise<boolean> {
    return skipIfGone(async () => {
      const text = await this.textarea(id).inputValue({ timeout: ACTION_TIMEOUT_MS });
      if (text === '') return false;
      await this.erase(id, count, { caret, timeoutMs: ACTION_TIMEOUT_MS });
      return true;
    });
  }

  moveBy(id: string, dx: number, dy: number): Promise<boolean> {
    return skipIfGone(async () => {
      const [note, canvas] = await Promise.all([
        this.note(id).boundingBox({ timeout: ACTION_TIMEOUT_MS }),
        this.canvas.boundingBox(),
      ]);
      if (note === null || canvas === null) return false;
      const corner = { x: note.x - canvas.x, y: note.y - canvas.y };
      const delta = clampMove(corner, { x: dx, y: dy }, canvas);
      if (delta.x === 0 && delta.y === 0) return false;
      return this.drag(id, delta, { timeoutMs: ACTION_TIMEOUT_MS });
    });
  }

  recolor(id: string, color: NoteColorName): Promise<boolean> {
    return skipIfGone(async () => {
      await this.note(id)
        .getByRole('button', { name: `Color ${color}`, exact: true })
        .click({ timeout: ACTION_TIMEOUT_MS });
      return true;
    });
  }

  remove(id: string): Promise<boolean> {
    return skipIfGone(async () => {
      await this.note(id)
        .getByRole('button', { name: 'Delete note' })
        .click({ timeout: ACTION_TIMEOUT_MS });
      return true;
    });
  }

  undo(): Promise<boolean> {
    return this.#pressHistory('Undo');
  }

  redo(): Promise<boolean> {
    return this.#pressHistory('Redo');
  }

  #pressHistory(name: 'Undo' | 'Redo'): Promise<boolean> {
    return skipIfGone(async () => {
      const button = this.page.getByRole('button', { name, exact: true });
      if (await button.isDisabled({ timeout: ACTION_TIMEOUT_MS })) return false;
      await button.click({ timeout: ACTION_TIMEOUT_MS });
      return true;
    });
  }
}
