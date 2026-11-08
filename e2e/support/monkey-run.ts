import type { MonkeyAction, MonkeyKind, NoteColorName } from './monkey-plan';
import { sleep } from './wait';

/**
 * A person at a board, as the monkey sees them. An action that answers `false` could not be done
 * (the note it meant is gone or covered, the canvas is full, there is nothing to undo) and left
 * the board alone; that is part of a random run, not a failure.
 */
export interface Actor {
  /** Whether this person has cut themselves off from the network. */
  readonly offline: boolean;
  noteIds(): Promise<readonly string[]>;
  create(fx: number, fy: number): Promise<boolean>;
  typeInto(id: string, caret: number, text: string): Promise<boolean>;
  eraseFrom(id: string, caret: number, count: number): Promise<boolean>;
  moveBy(id: string, dx: number, dy: number): Promise<boolean>;
  recolor(id: string, color: NoteColorName): Promise<boolean>;
  remove(id: string): Promise<boolean>;
  undo(): Promise<boolean>;
  redo(): Promise<boolean>;
  goOffline(): Promise<void>;
  goOnline(): Promise<void>;
  reload(): Promise<void>;
}

export interface KindTally {
  done: number;
  skipped: number;
}

export interface MonkeyReport {
  /** Actions that did something. */
  readonly performed: number;
  /** Actions that could not be done, or that had nothing to do. */
  readonly skipped: number;
  readonly byKind: Readonly<Partial<Record<MonkeyKind, KindTally>>>;
  /** One line per action, to read when a run fails. */
  readonly log: readonly string[];
}

/** Does one step of the plan; says whether it did anything. */
async function perform(
  step: MonkeyAction,
  actors: readonly Actor[],
  pause: (ms: number) => Promise<void>,
): Promise<boolean> {
  if (step.kind === 'pause') {
    await pause(step.ms);
    return true;
  }
  const actor = actors[step.who];
  if (actor === undefined) throw new RangeError(`There is no person ${step.who}`);
  switch (step.kind) {
    case 'create':
      return actor.create(step.fx, step.fy);
    case 'undo':
      return actor.undo();
    case 'redo':
      return actor.redo();
    case 'offline':
      if (actor.offline) return false;
      await actor.goOffline();
      return true;
    case 'online':
      if (!actor.offline) return false;
      await actor.goOnline();
      return true;
    case 'reload':
      // A page cannot load with no network, and there is no service worker to load it from.
      if (actor.offline) return false;
      await actor.reload();
      return true;
    default:
      break;
  }

  const ids = await actor.noteIds();
  const id = ids[step.pick % ids.length];
  if (id === undefined) return false;
  switch (step.kind) {
    case 'type':
      return actor.typeInto(id, step.caret, step.text);
    case 'erase':
      return actor.eraseFrom(id, step.caret, step.count);
    case 'move':
      return actor.moveBy(id, step.dx, step.dy);
    case 'color':
      return actor.recolor(id, step.color);
    case 'delete':
      return actor.remove(id);
  }
}

/**
 * Carries out a plan one step after another, each by the person it names. The people are not
 * waited for between steps, so what one does is still on its way to the others when the next
 * person acts: that is where the concurrency comes from.
 */
export async function runMonkey(
  plan: readonly MonkeyAction[],
  actors: readonly Actor[],
  pause: (ms: number) => Promise<void> = sleep,
): Promise<MonkeyReport> {
  const byKind: Partial<Record<MonkeyKind, KindTally>> = {};
  const log: string[] = [];
  let performed = 0;
  for (const [index, step] of plan.entries()) {
    const done = await perform(step, actors, pause);
    const tally = (byKind[step.kind] ??= { done: 0, skipped: 0 });
    if (done) {
      tally.done += 1;
      performed += 1;
    } else {
      tally.skipped += 1;
    }
    log.push(`${index + 1} ${JSON.stringify(step)} ${done ? 'done' : 'skipped'}`);
  }
  return { performed, skipped: plan.length - performed, byKind, log };
}
