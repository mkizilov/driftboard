/**
 * Runs the benchmark scenarios once each and prints their timings and sizes as Markdown tables.
 * This is the script behind the numbers in PERFORMANCE.md (`pnpm --filter @driftboard/bench report`);
 * the `*.bench.ts` files are the same scenarios for `vitest bench`.
 *
 *   report.ts [--only=text,load,sync,sizes,tombstones] [--ops=100000] [--notes=1000] [--chars=800]
 *             [--offline=50000] [--online=20000] [--keys=20000] [--no-binary]
 *
 * For heap numbers run it as `node --expose-gc`.
 */
import { gzipSync } from 'node:zlib';
import {
  TextSequence,
  deserializeBoardOps,
  replicaId,
  serializeBoardOps,
  type BoardOp,
} from '@driftboard/crdt';
import {
  decodeOps,
  encodeFrame,
  encodeMessage,
  encodeOps,
  stampOps,
  toBoardOps,
} from '@driftboard/protocol';
import {
  buildBoardOps,
  loadBoard,
  readEverything,
  typingOps,
  type BoardSize,
} from './board-scenarios';
import {
  binaryWire,
  converged,
  jsonWire,
  prepareWorld,
  reconnect,
  type Wire,
} from './sync-scenarios';
import { churn, compacted } from './tombstone-scenarios';
import {
  applyOps,
  editScript,
  fingerprint,
  runEdits,
  runEditsReading,
  shuffled,
} from './text-scenarios';

interface Options {
  readonly only: ReadonlySet<string>;
  readonly ops: number;
  readonly size: BoardSize;
  readonly offline: number;
  readonly online: number;
  readonly keys: number;
}

function parseOptions(argv: readonly string[]): Options {
  const value = (name: string, fallback: string): string => {
    const found = argv.find((arg) => arg.startsWith(`--${name}=`));
    return found === undefined ? fallback : found.slice(name.length + 3);
  };
  return {
    only: new Set(value('only', 'text,load,sync,sizes,tombstones').split(',')),
    ops: Number(value('ops', '100000')),
    size: { notes: Number(value('notes', '1000')), charsPerNote: Number(value('chars', '800')) },
    offline: Number(value('offline', '50000')),
    online: Number(value('online', '20000')),
    keys: Number(value('keys', '20000')),
  };
}

function timed<T>(run: () => T): { ms: number; value: T } {
  const start = performance.now();
  const value = run();
  return { ms: performance.now() - start, value };
}

const gc = (globalThis as { gc?: () => void }).gc;

/** Heap in use in megabytes, after a collection if `--expose-gc` was given. */
function heapMb(): number {
  gc?.();
  return process.memoryUsage().heapUsed / 1024 / 1024;
}

const n = (value: number): string => value.toLocaleString('en');
const fixed = (value: number, digits = 0): string => value.toFixed(digits);
const kb = (bytes: number): string => `${n(Math.round(bytes / 1024))} KB`;
const row = (...cells: (string | number)[]): void => {
  console.log(`| ${cells.join(' | ')} |`);
};
const perOp = (ms: number, count: number): string => `${fixed((ms * 1000) / count, 1)} µs`;

function textSection(options: Options): void {
  console.log(`\n### Text sequence (${n(options.ops)} operations)\n`);
  row('scenario', 'time', 'per operation');
  row('---', '---:', '---:');

  for (const size of [10_000, 20_000, 40_000]) {
    if (size >= options.ops) continue;
    const script = editScript(1, size);
    const { ms } = timed(() => runEdits(new TextSequence(replicaId('typist')), script));
    row(`local edits, ${n(size)} operations`, `${fixed(ms)} ms`, perOp(ms, size));
  }

  const script = editScript(1, options.ops);
  const sequence = new TextSequence(replicaId('typist'));
  const local = timed(() => runEdits(sequence, script));
  const ops = local.value;
  row(
    `local edits, ${n(ops.length)} operations`,
    `${fixed(local.ms)} ms`,
    perOp(local.ms, ops.length),
  );
  const read = timed(() => sequence.toString());
  row('read the text of that sequence once', `${fixed(read.ms, 1)} ms`, '');

  const remote = timed(() => applyOps(ops));
  row(
    `apply the ${n(ops.length)} operations on a fresh replica (in order)`,
    `${fixed(remote.ms)} ms`,
    perOp(remote.ms, ops.length),
  );
  const scrambled = timed(() => applyOps(shuffled(ops, 7)));
  row(
    'the same, in random order (causal buffer)',
    `${fixed(scrambled.ms)} ms`,
    perOp(scrambled.ms, ops.length),
  );

  const reading = editScript(2, 10_000);
  const typed = timed(() => runEditsReading(new TextSequence(replicaId('typist')), reading));
  row(
    'type 10,000 operations and read the whole text after each',
    `${fixed(typed.ms)} ms`,
    perOp(typed.ms, 10_000),
  );

  const nodes = sequence.nodes();
  const same =
    remote.value.toString() === sequence.toString() &&
    scrambled.value.toString() === sequence.toString();
  console.log(
    `\nResult: ${n(sequence.length)} characters shown, ${n(nodes.length)} nodes held ` +
      `(${n(nodes.length - sequence.length)} tombstones). Operations fingerprint ${fingerprint(ops)}; ` +
      `the replicas agree: ${String(same)}.`,
  );

  const before = heapMb();
  const copy = applyOps(ops);
  const after = heapMb();
  console.log(
    `Heap for one replica of that text: ${fixed(after - before, 1)} MB for ${n(copy.nodes().length)} nodes ` +
      `(${gc === undefined ? 'no gc: indicative only' : 'after gc'}).`,
  );
}

function loadSection(options: Options): BoardOp[] {
  const { notes, charsPerNote } = options.size;
  console.log(
    `\n### Loading a board (${n(notes)} notes, ${n(charsPerNote)} characters typed in each)\n`,
  );
  const built = timed(() => buildBoardOps(5, options.size));
  const ops = built.value;
  const stamped = stampOps(replicaId('author'), 1, ops);
  const json = timed(() => serializeBoardOps(ops));
  const stampedJson = JSON.stringify(stamped);
  const bytes = timed(() => encodeOps(stamped));
  console.log(
    `${n(ops.length)} operations (built in ${fixed(built.ms)} ms). As the system moves them: ` +
      `JSON ${kb(Buffer.byteLength(stampedJson))}, binary ${kb(bytes.value.length)} ` +
      `(${fixed(Buffer.byteLength(stampedJson) / bytes.value.length, 1)}x smaller); ` +
      `as a log file (\`serializeBoardOps\`) JSON ${kb(Buffer.byteLength(json.value))}.\n`,
  );
  row('step', 'JSON', 'binary');
  row('---', '---:', '---:');

  const parsed = timed(() => deserializeBoardOps(json.value));
  const decoded = timed(() => toBoardOps(decodeOps(bytes.value)));
  row('parse and check the operations', `${fixed(parsed.ms)} ms`, `${fixed(decoded.ms)} ms`);

  const before = heapMb();
  const appliedJson = timed(() => loadBoard(parsed.value));
  const appliedBinary = timed(() => loadBoard(decoded.value));
  row('apply them to a new board', `${fixed(appliedJson.ms)} ms`, `${fixed(appliedBinary.ms)} ms`);
  const shown = timed(() => readEverything(appliedJson.value));
  const shownBinary = timed(() => readEverything(appliedBinary.value));
  row(
    'read every note, as the screen does',
    `${fixed(shown.ms)} ms`,
    `${fixed(shownBinary.ms)} ms`,
  );
  row(
    '**load in all**',
    `**${fixed(parsed.ms + appliedJson.ms + shown.ms)} ms**`,
    `**${fixed(decoded.ms + appliedBinary.ms + shownBinary.ms)} ms**`,
  );
  const after = heapMb();
  row('write them (the other direction)', `${fixed(json.ms)} ms`, `${fixed(bytes.ms)} ms`);
  console.log(
    `\nBoards agree: ${String(JSON.stringify(appliedJson.value.notes()) === JSON.stringify(appliedBinary.value.notes()))}. ` +
      `Heap held by the two loaded boards: ${fixed(after - before)} MB (${gc === undefined ? 'no gc: indicative only' : 'after gc'}); ` +
      `${n(shown.value)} characters shown.`,
  );
  return ops;
}

function syncSection(options: Options, wires: readonly Wire[]): void {
  const size = {
    notes: 200,
    charsPerNote: 100,
    offlineOps: options.offline,
    onlineOps: options.online,
  };
  console.log(
    `\n### Syncing after a long offline period (${n(options.offline)} operations made offline, ${n(options.online)} meanwhile by someone else)\n`,
  );
  row(
    'wire format',
    'messages',
    'operations moved',
    'bytes on the wire',
    'time to be in sync',
    'converged',
  );
  row('---', '---:', '---:', '---:', '---:', '---');
  for (const wire of wires) {
    const world = prepareWorld(11, size);
    const { ms, value } = timed(() => reconnect(world, wire));
    row(
      wire.name,
      value.messages,
      n(value.operations),
      kb(value.bytes),
      `${fixed(ms)} ms`,
      String(converged(world)),
    );
  }
}

function tombstoneSection(): void {
  const edits = 100_000;
  const length = 1000;
  console.log(
    `\n### Tombstones (a text of ${n(length)} characters, edited ${n(edits)} times: a few characters selected and typed over)\n`,
  );
  row(
    'edits',
    'shown',
    'nodes held',
    'tombstones',
    'heap of the sequence',
    'time for these edits',
    'per edit',
  );
  row('---', '---:', '---:', '---:', '---:', '---:', '---:');
  const start = heapMb();
  const { rows, sequence } = churn(
    9,
    { length, edits, every: 25_000 },
    { clock: () => performance.now(), heap: heapMb },
  );
  let previous = rows[0];
  for (const each of rows) {
    const spent = each.ms - (previous?.ms ?? 0);
    const batch = each.edits - (previous?.edits ?? 0);
    row(
      n(each.edits),
      n(each.shown),
      n(each.nodes),
      `${fixed(((each.nodes - each.shown) / each.nodes) * 100, 1)}%`,
      `${fixed(each.heap - start, 1)} MB`,
      each.edits === 0 ? '' : `${fixed(spent)} ms`,
      each.edits === 0 ? '' : perOp(spent, batch),
    );
    previous = each;
  }
  const text = sequence.toString();
  const before = heapMb();
  const small = compacted(text);
  const after = heapMb();
  console.log(
    `\nThe same text with its tombstones dropped: ${n(small.nodes().length)} nodes, ${fixed(after - before, 2)} MB ` +
      `(${gc === undefined ? 'no gc: indicative only' : 'after gc'}).`,
  );
}

function sizesSection(options: Options, board: readonly BoardOp[]): void {
  console.log(`\n### Sizes of the wire formats\n`);
  row('workload', 'operations', 'JSON', 'binary', 'smaller by', 'JSON gzipped', 'binary gzipped');
  row('---', '---:', '---:', '---:', '---:', '---:', '---:');
  const compare = (name: string, ops: readonly BoardOp[]): void => {
    const stamped = stampOps(replicaId('author'), 1, ops);
    const json = Buffer.from(JSON.stringify(stamped));
    const binary = encodeOps(stamped);
    row(
      name,
      n(ops.length),
      kb(json.length),
      kb(binary.length),
      `${fixed(json.length / binary.length, 1)}x`,
      kb(gzipSync(json).length),
      kb(gzipSync(binary).length),
    );
  };
  const typing = typingOps(3, options.keys);
  compare(`one person typing ${n(options.keys)} keys, a key at a time`, typing);
  if (board.length > 0) compare('the board of the loading benchmark', board);

  // What one keystroke costs when it travels alone, as it does while someone is typing.
  const pair = stampOps(replicaId('typist'), 100, typing.slice(99, 101));
  const jsonMessage = Buffer.byteLength(encodeMessage({ type: 'ops', ops: pair }));
  const frame = encodeFrame({ type: 'ops', ops: pair });
  const frameBytes = typeof frame === 'string' ? Buffer.byteLength(frame) : frame.length;
  console.log(
    `\nOne keystroke on its own (a character and the note put again): ${n(jsonMessage)} bytes as a JSON message, ` +
      `${n(frameBytes)} as a binary frame.`,
  );
}

function main(): void {
  const options = parseOptions(process.argv.slice(2));
  console.log(`Node ${process.version}, ${process.platform} ${process.arch}`);
  if (options.only.has('text')) textSection(options);
  let boardOps: BoardOp[] = [];
  if (options.only.has('load')) boardOps = loadSection(options);
  if (options.only.has('sync')) syncSection(options, [jsonWire, binaryWire]);
  if (options.only.has('sizes')) sizesSection(options, boardOps);
  if (options.only.has('tombstones')) tombstoneSection();
}

main();
