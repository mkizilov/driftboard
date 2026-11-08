/** What other people see of you: a name and a colour. */
export interface Identity {
  readonly name: string;
  /** `#rrggbb`, lower case: the form the protocol accepts. */
  readonly color: string;
}

/** Longest name, in characters. 40 are at most 80 UTF-16 units, which the protocol allows. */
export const MAX_NAME_CHARS = 40;

/** Colours that stay readable under white text and on the board's paper. */
export const COLORS: readonly string[] = [
  '#e03131',
  '#2f9e44',
  '#1971c2',
  '#9c36b5',
  '#d9480f',
  '#0c8599',
  '#c2255c',
  '#5f3dc4',
];

const ADJECTIVES = [
  'Brave',
  'Calm',
  'Clever',
  'Curious',
  'Eager',
  'Gentle',
  'Jolly',
  'Kind',
  'Lively',
  'Merry',
  'Nimble',
  'Quiet',
  'Swift',
  'Tidy',
  'Witty',
  'Zesty',
];

const ANIMALS = [
  'Badger',
  'Crane',
  'Dolphin',
  'Falcon',
  'Fox',
  'Heron',
  'Lynx',
  'Marmot',
  'Newt',
  'Otter',
  'Panda',
  'Quokka',
  'Robin',
  'Seal',
  'Tortoise',
  'Wombat',
];

/**
 * A name as it is shown: whitespace collapsed, trimmed and cut to `MAX_NAME_CHARS` characters.
 * `null` when nothing is left, so that an empty field never replaces a name.
 */
export function cleanName(raw: string): string | null {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  const name = [...collapsed].slice(0, MAX_NAME_CHARS).join('').trim();
  return name === '' ? null : name;
}

/** A friendly name ("Brave Otter") and a colour, from three random bytes. */
export function randomIdentity(randomBytes: (length: number) => Uint8Array): Identity {
  const [adjective = 0, animal = 0, color = 0] = randomBytes(3);
  return {
    name: `${ADJECTIVES[adjective % ADJECTIVES.length]} ${ANIMALS[animal % ANIMALS.length]}`,
    color: COLORS[color % COLORS.length] ?? '#1971c2',
  };
}

/** The part of `localStorage` that is needed. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const IDENTITY_KEY = 'driftboard:identity';

function parse(text: string | null): Identity | null {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null) return null;
    const { name, color } = value as { name?: unknown; color?: unknown };
    if (typeof name !== 'string' || typeof color !== 'string') return null;
    if (cleanName(name) !== name || !/^#[0-9a-f]{6}$/.test(color)) return null;
    return { name, color };
  } catch {
    return null;
  }
}

/**
 * Who this person is on every board: a name and a colour that stay the same across page loads,
 * kept in the browser (not in the board, and never sent anywhere but as presence). Without storage,
 * or when it holds nothing usable, a new one is made and lasts as long as the page.
 */
export class IdentityStore {
  readonly #storage: KeyValueStore | null;
  readonly #listeners = new Set<() => void>();
  #identity: Identity;

  constructor(storage: KeyValueStore | null, randomBytes: (length: number) => Uint8Array) {
    this.#storage = storage;
    let stored: string | null = null;
    try {
      stored = storage?.getItem(IDENTITY_KEY) ?? null;
    } catch {
      // Storage that cannot even be read (blocked by the browser) is the same as no storage.
    }
    const found = parse(stored);
    this.#identity = found ?? randomIdentity(randomBytes);
    if (found === null) this.#save();
  }

  /** The same object until the name changes. */
  readonly getIdentity = (): Identity => this.#identity;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Changes the name. Returns whether it was accepted: an empty name is not. */
  rename(raw: string): boolean {
    const name = cleanName(raw);
    if (name === null) return false;
    if (name === this.#identity.name) return true;
    this.#identity = { ...this.#identity, name };
    this.#save();
    for (const listener of [...this.#listeners]) listener();
    return true;
  }

  #save(): void {
    try {
      this.#storage?.setItem(IDENTITY_KEY, JSON.stringify(this.#identity));
    } catch {
      // Storage that is full or blocked: the identity lasts as long as the page.
    }
  }
}
