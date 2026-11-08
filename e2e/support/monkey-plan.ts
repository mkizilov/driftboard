import { createRng, type Rng } from './rng';

/** The note colours, as `data-color` and the swatch labels name them. */
export const NOTE_COLOR_NAMES = ['yellow', 'pink', 'green', 'blue', 'purple', 'orange'] as const;

export type NoteColorName = (typeof NOTE_COLOR_NAMES)[number];

/**
 * One thing a person does. The plan only says *what*: which note, where in its text and how far to
 * drag are numbers to be resolved against the page when the action is carried out (`pick` is an
 * arbitrary integer, taken modulo the number of notes), so the same seed gives the same plan
 * whatever the boards look like.
 */
export type MonkeyAction =
  /** Double-click on a free spot, `fx` and `fy` being fractions of the usable canvas. */
  | { readonly kind: 'create'; readonly who: number; readonly fx: number; readonly fy: number }
  /** Type `text` into a note with the caret at the fraction `caret` of its text. */
  | {
      readonly kind: 'type';
      readonly who: number;
      readonly pick: number;
      readonly caret: number;
      readonly text: string;
    }
  /** Backspace `count` times with the caret at the fraction `caret` of the text. */
  | {
      readonly kind: 'erase';
      readonly who: number;
      readonly pick: number;
      readonly caret: number;
      readonly count: number;
    }
  | {
      readonly kind: 'move';
      readonly who: number;
      readonly pick: number;
      readonly dx: number;
      readonly dy: number;
    }
  | {
      readonly kind: 'color';
      readonly who: number;
      readonly pick: number;
      readonly color: NoteColorName;
    }
  | { readonly kind: 'delete'; readonly who: number; readonly pick: number }
  | { readonly kind: 'undo'; readonly who: number }
  | { readonly kind: 'redo'; readonly who: number }
  | { readonly kind: 'offline'; readonly who: number }
  | { readonly kind: 'online'; readonly who: number }
  | { readonly kind: 'reload'; readonly who: number }
  | { readonly kind: 'pause'; readonly ms: number };

export type MonkeyKind = MonkeyAction['kind'];

/** How often each kind of action comes up. Typing dominates, as it does in real use. */
export const MONKEY_WEIGHTS: readonly (readonly [MonkeyKind, number])[] = [
  ['create', 6],
  ['type', 24],
  ['erase', 8],
  ['move', 8],
  ['color', 5],
  ['delete', 3],
  ['undo', 8],
  ['redo', 4],
  ['offline', 3],
  ['online', 4],
  ['reload', 2],
  ['pause', 6],
];

/** Text to type: words, a space, and characters outside ASCII (one of them outside the BMP). */
const SNIPPETS = [
  'alpha',
  'beta',
  'gamma',
  'delta',
  'kiwi',
  'mango',
  ' ',
  'é',
  '😀',
  'x',
  '42',
] as const;

function snippet(rng: Rng): string {
  return Array.from({ length: 1 + rng.int(2) }, () => rng.pick(SNIPPETS)).join('');
}

function action(rng: Rng, kind: MonkeyKind, contexts: number): MonkeyAction {
  const who = rng.int(contexts);
  switch (kind) {
    case 'create':
      return { kind, who, fx: rng.next(), fy: rng.next() };
    case 'type':
      return { kind, who, pick: rng.int(1 << 30), caret: rng.next(), text: snippet(rng) };
    case 'erase':
      return { kind, who, pick: rng.int(1 << 30), caret: rng.next(), count: 1 + rng.int(4) };
    case 'move':
      return { kind, who, pick: rng.int(1 << 30), dx: rng.int(401) - 200, dy: rng.int(401) - 200 };
    case 'color':
      return { kind, who, pick: rng.int(1 << 30), color: rng.pick(NOTE_COLOR_NAMES) };
    case 'delete':
      return { kind, who, pick: rng.int(1 << 30) };
    case 'undo':
    case 'redo':
    case 'offline':
    case 'online':
    case 'reload':
      return { kind, who };
    case 'pause':
      return { kind, ms: 50 + rng.int(551) };
  }
}

/** `count` random actions across `contexts` people, all decided by `seed`. */
export function planMonkey(seed: number, count: number, contexts: number): MonkeyAction[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError(`count must be a whole number, got ${count}`);
  }
  if (!Number.isInteger(contexts) || contexts < 1) {
    throw new RangeError(`contexts must be at least 1, got ${contexts}`);
  }
  const rng = createRng(seed);
  return Array.from({ length: count }, () => action(rng, rng.weighted(MONKEY_WEIGHTS), contexts));
}
