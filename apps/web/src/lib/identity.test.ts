import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  COLORS,
  IDENTITY_KEY,
  IdentityStore,
  MAX_NAME_CHARS,
  cleanName,
  randomIdentity,
  type KeyValueStore,
} from './identity';

const bytes =
  (...values: number[]) =>
  () =>
    Uint8Array.from(values);

/** A `localStorage` that remembers what it is given. */
function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const storage: KeyValueStore & { writes: number } = {
    writes: 0,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      storage.writes += 1;
      data.set(key, value);
    },
  };
  return { data, storage };
}

describe('cleanName', () => {
  it('trims and collapses whitespace', () => {
    expect(cleanName('  Ada   Lovelace \n')).toBe('Ada Lovelace');
  });

  it('is null when nothing is left', () => {
    expect(cleanName('')).toBeNull();
    expect(cleanName('   \t\n ')).toBeNull();
  });

  it('cuts to forty characters, counting characters and not code units', () => {
    expect(cleanName('x'.repeat(100))).toBe('x'.repeat(MAX_NAME_CHARS));
    const emoji = cleanName('😀'.repeat(60));
    expect([...(emoji ?? '')]).toHaveLength(MAX_NAME_CHARS);
    expect((emoji ?? '').length).toBeLessThanOrEqual(80);
  });

  it('does not leave a space at the end after cutting', () => {
    expect(cleanName(`${'a'.repeat(39)} b`)).toBe('a'.repeat(39));
  });

  it('is its own fixed point, and never longer than the protocol allows', () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const name = cleanName(raw);
        if (name === null) return true;
        return cleanName(name) === name && name.length <= 80 && name === name.trim();
      }),
      { numRuns: 500 },
    );
  });
});

describe('randomIdentity', () => {
  it('makes a friendly name and a colour from the bytes it is given', () => {
    expect(randomIdentity(bytes(0, 0, 0))).toEqual({ name: 'Brave Badger', color: COLORS[0] });
    expect(randomIdentity(bytes(1, 2, 3))).toEqual({ name: 'Calm Dolphin', color: COLORS[3] });
  });

  it('wraps around for large bytes, and always gives a valid name and colour', () => {
    fc.assert(
      fc.property(fc.nat(255), fc.nat(255), fc.nat(255), (a, b, c) => {
        const identity = randomIdentity(bytes(a, b, c));
        return (
          /^#[0-9a-f]{6}$/.test(identity.color) &&
          cleanName(identity.name) === identity.name &&
          COLORS.includes(identity.color)
        );
      }),
      { numRuns: 500 },
    );
  });

  it('gives every combination of adjective and animal its own name', () => {
    const seen = new Set<string>();
    for (let a = 0; a < 16; a += 1) {
      for (let b = 0; b < 16; b += 1) seen.add(randomIdentity(bytes(a, b, 0)).name);
    }
    expect(seen.size).toBe(256);
  });

  it('uses colours the protocol accepts', () => {
    for (const color of COLORS) expect(color).toMatch(/^#[0-9a-f]{6}$/);
    expect(new Set(COLORS).size).toBe(COLORS.length);
  });
});

describe('IdentityStore', () => {
  it('makes an identity and keeps it, so that the next page load has the same one', () => {
    const { storage, data } = memory();
    const first = new IdentityStore(storage, bytes(3, 4, 5));
    expect(JSON.parse(data.get(IDENTITY_KEY) ?? 'null')).toEqual(first.getIdentity());
    const second = new IdentityStore(storage, bytes(9, 9, 9));
    expect(second.getIdentity()).toEqual(first.getIdentity());
  });

  it('works without storage, for as long as the page lives', () => {
    const store = new IdentityStore(null, bytes(1, 1, 1));
    expect(store.getIdentity().name).toBe('Calm Crane');
    expect(store.rename('Ada')).toBe(true);
    expect(store.getIdentity().name).toBe('Ada');
  });

  it('makes a new identity when what is stored cannot be used', () => {
    const unusable = [
      'not json',
      'null',
      '42',
      '{}',
      JSON.stringify({ name: 'Ada' }),
      JSON.stringify({ name: 5, color: '#1971c2' }),
      JSON.stringify({ name: 'Ada', color: 'blue' }),
      JSON.stringify({ name: 'Ada', color: '#1971C2' }),
      JSON.stringify({ name: '  Ada ', color: '#1971c2' }),
      JSON.stringify({ name: '', color: '#1971c2' }),
    ];
    for (const text of unusable) {
      const { storage, data } = memory({ [IDENTITY_KEY]: text });
      const store = new IdentityStore(storage, bytes(0, 1, 2));
      expect(store.getIdentity()).toEqual({ name: 'Brave Crane', color: COLORS[2] });
      expect(JSON.parse(data.get(IDENTITY_KEY) ?? 'null')).toEqual(store.getIdentity());
    }
  });

  it('keeps a name that was stored, whatever it is, as long as it is well formed', () => {
    const { storage } = memory({
      [IDENTITY_KEY]: JSON.stringify({ name: 'Grace Hopper', color: '#c2255c' }),
    });
    expect(new IdentityStore(storage, bytes(0, 0, 0)).getIdentity()).toEqual({
      name: 'Grace Hopper',
      color: '#c2255c',
    });
  });

  it('renames, saves, and tells its listeners', () => {
    const { storage, data } = memory();
    const store = new IdentityStore(storage, bytes(0, 0, 0));
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });
    expect(store.rename('  Ada   L  ')).toBe(true);
    expect(store.getIdentity().name).toBe('Ada L');
    expect((JSON.parse(data.get(IDENTITY_KEY) ?? 'null') as { name: string }).name).toBe('Ada L');
    expect(calls).toBe(1);
  });

  it('keeps the colour when it renames', () => {
    const store = new IdentityStore(null, bytes(0, 0, 4));
    const color = store.getIdentity().color;
    store.rename('Ada');
    expect(store.getIdentity().color).toBe(color);
  });

  it('refuses an empty name and keeps the old one', () => {
    const store = new IdentityStore(null, bytes(0, 0, 0));
    const before = store.getIdentity();
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });
    expect(store.rename('   ')).toBe(false);
    expect(store.getIdentity()).toBe(before);
    expect(calls).toBe(0);
  });

  it('does nothing, and writes nothing, when the name is the same', () => {
    const { storage } = memory();
    const store = new IdentityStore(storage, bytes(0, 0, 0));
    const writes = storage.writes;
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });
    expect(store.rename(`  ${store.getIdentity().name} `)).toBe(true);
    expect(calls).toBe(0);
    expect(storage.writes).toBe(writes);
  });

  it('hands out the same object until the name changes', () => {
    const store = new IdentityStore(null, bytes(0, 0, 0));
    const before = store.getIdentity();
    expect(store.getIdentity()).toBe(before);
    store.rename('Ada');
    expect(store.getIdentity()).not.toBe(before);
  });

  it('stops telling a listener that unsubscribed', () => {
    const store = new IdentityStore(null, bytes(0, 0, 0));
    let calls = 0;
    const stop = store.subscribe(() => {
      calls += 1;
    });
    stop();
    store.rename('Ada');
    expect(calls).toBe(0);
  });

  it('carries on when storage cannot be read or written', () => {
    const broken: KeyValueStore = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('full');
      },
    };
    const store = new IdentityStore(broken, bytes(0, 0, 0));
    expect(store.getIdentity().name).toBe('Brave Badger');
    expect(store.rename('Ada')).toBe(true);
    expect(store.getIdentity().name).toBe('Ada');
  });
});
