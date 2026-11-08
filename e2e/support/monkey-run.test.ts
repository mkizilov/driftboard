import { describe, expect, it } from 'vitest';
import { planMonkey, type MonkeyAction, type MonkeyKind } from './monkey-plan';
import { runMonkey, type Actor } from './monkey-run';

/** An actor that does nothing but write down what it was asked, and answers as it is set to. */
class FakeActor implements Actor {
  offline = false;
  notes: string[] = ['n1', 'n2', 'n3'];
  /** What every action that can fail answers. */
  works = true;
  readonly calls: string[] = [];

  noteIds(): Promise<readonly string[]> {
    return Promise.resolve(this.notes);
  }
  create(fx: number, fy: number) {
    return this.record(`create ${fx} ${fy}`);
  }
  typeInto(id: string, caret: number, text: string) {
    return this.record(`type ${id} ${caret} ${text}`);
  }
  eraseFrom(id: string, caret: number, count: number) {
    return this.record(`erase ${id} ${caret} ${count}`);
  }
  moveBy(id: string, dx: number, dy: number) {
    return this.record(`move ${id} ${dx} ${dy}`);
  }
  recolor(id: string, color: string) {
    return this.record(`color ${id} ${color}`);
  }
  remove(id: string) {
    return this.record(`delete ${id}`);
  }
  undo() {
    return this.record('undo');
  }
  redo() {
    return this.record('redo');
  }
  goOffline() {
    this.offline = true;
    this.calls.push('offline');
    return Promise.resolve();
  }
  goOnline() {
    this.offline = false;
    this.calls.push('online');
    return Promise.resolve();
  }
  reload() {
    this.calls.push('reload');
    return Promise.resolve();
  }

  private record(call: string): Promise<boolean> {
    this.calls.push(call);
    return Promise.resolve(this.works);
  }
}

const noPause = () => Promise.resolve();

describe('runMonkey', () => {
  it('hands each action to the person it names', async () => {
    const [ann, ben] = [new FakeActor(), new FakeActor()];
    const plan: MonkeyAction[] = [
      { kind: 'create', who: 0, fx: 0.25, fy: 0.5 },
      { kind: 'undo', who: 1 },
      { kind: 'redo', who: 0 },
    ];
    await runMonkey(plan, [ann, ben], noPause);
    expect(ann.calls).toEqual(['create 0.25 0.5', 'redo']);
    expect(ben.calls).toEqual(['undo']);
  });

  it('picks the note by taking the pick modulo the notes that person sees', async () => {
    const actor = new FakeActor();
    actor.notes = ['a', 'b', 'c'];
    const plan: MonkeyAction[] = [
      { kind: 'type', who: 0, pick: 0, caret: 0.5, text: 'hi' },
      { kind: 'erase', who: 0, pick: 4, caret: 1, count: 2 },
      { kind: 'move', who: 0, pick: 8, dx: -5, dy: 7 },
      { kind: 'color', who: 0, pick: 1_000_000_001, color: 'pink' },
      { kind: 'delete', who: 0, pick: 2 },
    ];
    await runMonkey(plan, [actor], noPause);
    expect(actor.calls).toEqual([
      'type a 0.5 hi',
      'erase b 1 2',
      'move c -5 7',
      'color c pink',
      'delete c',
    ]);
  });

  it('skips what needs a note when the person sees none, without asking them to act', async () => {
    const actor = new FakeActor();
    actor.notes = [];
    const plan: MonkeyAction[] = [
      { kind: 'type', who: 0, pick: 3, caret: 0, text: 'x' },
      { kind: 'erase', who: 0, pick: 3, caret: 0, count: 1 },
      { kind: 'move', who: 0, pick: 3, dx: 1, dy: 1 },
      { kind: 'color', who: 0, pick: 3, color: 'blue' },
      { kind: 'delete', who: 0, pick: 3 },
    ];
    const report = await runMonkey(plan, [actor], noPause);
    expect(actor.calls).toEqual([]);
    expect(report.performed).toBe(0);
    expect(report.skipped).toBe(5);
  });

  it('goes offline once, comes back only if it was offline, and does not reload while offline', async () => {
    const actor = new FakeActor();
    const plan: MonkeyAction[] = [
      { kind: 'online', who: 0 },
      { kind: 'reload', who: 0 },
      { kind: 'offline', who: 0 },
      { kind: 'offline', who: 0 },
      { kind: 'reload', who: 0 },
      { kind: 'online', who: 0 },
      { kind: 'online', who: 0 },
    ];
    const report = await runMonkey(plan, [actor], noPause);
    expect(actor.calls).toEqual(['reload', 'offline', 'online']);
    expect(report.byKind.online).toEqual({ done: 1, skipped: 2 });
    expect(report.byKind.offline).toEqual({ done: 1, skipped: 1 });
    expect(report.byKind.reload).toEqual({ done: 1, skipped: 1 });
  });

  it('counts an action that answers false as skipped and one that answers true as done', async () => {
    const actor = new FakeActor();
    const plan: MonkeyAction[] = [{ kind: 'undo', who: 0 }];
    expect((await runMonkey(plan, [actor], noPause)).performed).toBe(1);
    actor.works = false;
    const report = await runMonkey(plan, [actor], noPause);
    expect(report.performed).toBe(0);
    expect(report.skipped).toBe(1);
  });

  it('pauses for as long as the plan says, and counts the pause as done', async () => {
    const pauses: number[] = [];
    const plan: MonkeyAction[] = [
      { kind: 'pause', ms: 120 },
      { kind: 'pause', ms: 60 },
    ];
    const report = await runMonkey(plan, [new FakeActor()], (ms) => {
      pauses.push(ms);
      return Promise.resolve();
    });
    expect(pauses).toEqual([120, 60]);
    expect(report.byKind.pause).toEqual({ done: 2, skipped: 0 });
  });

  it('refuses a step for a person who is not there', async () => {
    await expect(
      runMonkey([{ kind: 'undo', who: 2 }], [new FakeActor(), new FakeActor()], noPause),
    ).rejects.toThrow('There is no person 2');
  });

  it('writes one line per action, in order, saying what it was and whether it was done', async () => {
    const actor = new FakeActor();
    const plan: MonkeyAction[] = [
      { kind: 'undo', who: 0 },
      { kind: 'online', who: 0 },
    ];
    const report = await runMonkey(plan, [actor], noPause);
    expect(report.log).toHaveLength(2);
    expect(report.log[0]).toBe('1 {"kind":"undo","who":0} done');
    expect(report.log[1]).toBe('2 {"kind":"online","who":0} skipped');
  });

  it('runs a whole planned run of 200 actions across three people, and accounts for every one', async () => {
    const actors = [new FakeActor(), new FakeActor(), new FakeActor()];
    const plan = planMonkey(20260101, 200, 3);
    const report = await runMonkey(plan, actors, noPause);
    expect(report.performed + report.skipped).toBe(200);
    expect(report.log).toHaveLength(200);
    const counted = Object.values(report.byKind).reduce(
      (sum, tally) => sum + (tally?.done ?? 0) + (tally?.skipped ?? 0),
      0,
    );
    expect(counted).toBe(200);
    for (const kind of Object.keys(report.byKind) as MonkeyKind[]) {
      expect(plan.some((step) => step.kind === kind)).toBe(true);
    }
    // Everyone took part.
    for (const actor of actors) expect(actor.calls.length).toBeGreaterThan(10);
  });
});
