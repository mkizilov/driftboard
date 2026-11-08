import type { NoteView } from '@driftboard/crdt';
import type { BoardStore } from './board-store';
import { describeSync, type Indicator } from './indicator';
import { openBoardSession, type BoardSession } from './session';
import { MemoryDisk } from './storage';
import { FakeNetwork, FakeTimers, type FakeSocket } from './test-network';

/**
 * One person's browser for tests: a disk that outlives page loads, timers of its own and a network
 * connection that can be switched off. Every page load reads the board from the disk and is a new
 * replica with a new id, as in the real app. Nothing is asynchronous except the load itself.
 */
export class Device {
  readonly disk: MemoryDisk;
  readonly timers = new FakeTimers();
  /** Whether this device can reach the server. */
  online = true;
  readonly #net: FakeNetwork;
  readonly #seed: number;
  readonly #opened = new WeakSet<FakeSocket>();
  #sockets: FakeSocket[] = [];
  #loads = 0;
  #current: BoardSession | null = null;

  constructor(net: FakeNetwork, seed: number, disk: MemoryDisk = new MemoryDisk()) {
    this.#net = net;
    this.#seed = seed;
    this.disk = disk;
  }

  get page(): BoardSession {
    if (this.#current === null) throw new Error('the page is not open');
    return this.#current;
  }

  get store(): BoardStore {
    return this.page.store;
  }

  /** What the indicator shows. */
  get indicator(): Indicator {
    return describeSync(this.page.connection.getState());
  }

  /** The notes on the board, by id. */
  get notes(): NoteView[] {
    const { store } = this;
    return store.getIds().flatMap((id) => store.getNote(id) ?? []);
  }

  /** Opens the board like a page load: reads the disk, then connects if the network allows. */
  async openPage(): Promise<BoardSession> {
    this.#loads += 1;
    const seed = this.#seed * 100 + this.#loads;
    this.#sockets = [];
    const page = await openBoardSession({
      boardId: this.#net.boardId,
      url: 'ws://test.invalid/ws',
      storage: this.disk.open(this.#net.boardId),
      randomBytes: (length) =>
        Uint8Array.from({ length }, (_, index) => (seed * 53 + index * 7) % 256),
      createSocket: (url, handlers) => {
        const socket = this.#net.connect(url, handlers);
        this.#sockets.push(socket);
        return socket;
      },
      timers: this.timers,
      random: () => 0,
      retry: { initialMs: 100, maxMs: 1000 },
    });
    this.#current = page;
    page.start();
    this.#settle();
    return page;
  }

  /** Closes the page, after what it queued has been written. */
  async closePage(): Promise<void> {
    const page = this.#current;
    this.#current = null;
    await page?.dispose();
  }

  /** Closes the page and opens it again, as a reload does. */
  async reload(): Promise<BoardSession> {
    await this.closePage();
    return this.openPage();
  }

  goOffline(): void {
    this.online = false;
    this.#settle();
  }

  /** The network returns: a waiting retry runs and the connection is made. */
  goOnline(): void {
    this.online = true;
    if (this.timers.delays.length > 0) this.timers.fire();
    this.#settle();
  }

  /** Completes or fails the newest connection attempt, depending on the network. */
  #settle(): void {
    const socket = this.#sockets.at(-1);
    if (socket === undefined || socket.closed) return;
    if (!this.online) {
      socket.drop();
    } else if (!this.#opened.has(socket)) {
      this.#opened.add(socket);
      this.#net.open(socket);
    }
  }
}

/** Fails unless every device shows the same notes. Returns them. */
export function sharedNotes(devices: readonly Device[]): NoteView[] {
  const [first, ...rest] = devices;
  if (first === undefined) throw new Error('no devices');
  const notes = first.notes;
  const expected = JSON.stringify(notes);
  for (const device of rest) {
    const actual = JSON.stringify(device.notes);
    if (actual !== expected) throw new Error(`boards differ:\n${expected}\n${actual}`);
  }
  return notes;
}
