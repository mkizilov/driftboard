import fc from 'fast-check';
import {
  MAX_REPLICAS,
  MIN_REPLICAS,
  runScenario,
  type ConvergenceSpec,
  type Scenario,
  type Step,
} from './convergence-scenario';

export type { ConvergenceSpec, ReplicaContext } from './convergence-scenario';

/** A `ConvergenceSpec` plus the fast-check generator for the intents it understands. */
export interface CheckableSpec<S, Op, Intent> extends ConvergenceSpec<S, Op, Intent> {
  readonly intentArb: fc.Arbitrary<Intent>;
}

export interface ConvergenceOptions {
  /** Number of random scenarios. Defaults to 1000. */
  numRuns?: number;
  seed?: number;
  /** Replica count range per scenario, within 3 to 5. Defaults to exactly 3. */
  replicas?: { min: number; max: number };
}

export interface ConvergenceSummary {
  runs: number;
  ops: number;
  concurrentPairs: number;
  redeliveries: number;
  mergeChecks: number;
  /** Largest replica count that occurred. */
  maxReplicas: number;
}

export function scenarioArb<S, Op, Intent>(
  spec: CheckableSpec<S, Op, Intent>,
  replicas: { min: number; max: number } = { min: MIN_REPLICAS, max: MIN_REPLICAS },
): fc.Arbitrary<Scenario<Intent>> {
  if (replicas.min < MIN_REPLICAS || replicas.max > MAX_REPLICAS || replicas.min > replicas.max) {
    throw new RangeError(`replicas must be a range within ${MIN_REPLICAS}-${MAX_REPLICAS}`);
  }
  const replica = fc.integer({ min: 0, max: MAX_REPLICAS - 1 });
  const pick = fc.nat();
  const local = fc.record({
    kind: fc.constant('local' as const),
    replica,
    intent: spec.intentArb,
    clockDelta: fc.integer({ min: -30, max: 60 }),
  });
  const deliver = fc.record({ kind: fc.constant('deliver' as const), replica, pick });
  const redeliver = fc.record({ kind: fc.constant('redeliver' as const), replica, pick });
  const choices: { weight: number; arbitrary: fc.Arbitrary<Step<Intent>> }[] = [
    { weight: 4, arbitrary: local },
    { weight: 4, arbitrary: deliver },
  ];
  if (spec.idempotentApply === true) choices.push({ weight: 1, arbitrary: redeliver });
  const step = fc.oneof(...choices);
  return fc.record({
    replicas: fc.integer(replicas),
    steps: fc.array(step, { maxLength: 40 }),
    flushPicks: fc.array(pick, { maxLength: 80 }),
    mergePicks: fc.array(fc.tuple(pick, pick, pick), { maxLength: 6 }),
  });
}

/**
 * Checks that `spec` converges: random operations on 3 to 5 replicas, delivered in random but
 * causally valid orders, must leave all replicas in the same state (see `runScenario` for the full
 * list of checks). Throws on the first failing scenario with a shrunk counterexample. Returns
 * totals so callers can assert the scenarios were not vacuous.
 */
export function checkConvergence<S, Op, Intent>(
  spec: CheckableSpec<S, Op, Intent>,
  options: ConvergenceOptions = {},
): ConvergenceSummary {
  const summary: ConvergenceSummary = {
    runs: 0,
    ops: 0,
    concurrentPairs: 0,
    redeliveries: 0,
    mergeChecks: 0,
    maxReplicas: 0,
  };
  fc.assert(
    fc.property(scenarioArb(spec, options.replicas), (scenario) => {
      const stats = runScenario(spec, scenario);
      summary.runs += 1;
      summary.ops += stats.ops;
      summary.concurrentPairs += stats.concurrentPairs;
      summary.redeliveries += stats.redeliveries;
      summary.mergeChecks += stats.mergeChecks;
      summary.maxReplicas = Math.max(summary.maxReplicas, scenario.replicas);
    }),
    {
      numRuns: options.numRuns ?? 1000,
      ...(options.seed === undefined ? {} : { seed: options.seed }),
    },
  );
  return summary;
}
