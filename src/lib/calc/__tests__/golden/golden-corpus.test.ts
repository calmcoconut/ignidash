/**
 * The frozen golden corpus (parity plan P2-P1b).
 *
 * This test re-runs `simulate()` for every fixture and compares the bytes with `corpus.json`.
 * It is exact: no tolerances, no partial matching. A difference means a number a user sees has
 * moved, so read `README.md` in this directory before touching the corpus — a diff must arrive
 * with an explanation, never as a regenerated file that makes this test green.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { buildCorpus, parseCorpus, serializeCorpus, type GoldenCorpus } from './snapshot';
import { GOLDEN_AS_OF, GOLDEN_FIXTURES } from './fixtures';
import { getNyuDataRange } from '../../historical-data/nyu-returns';
import { SimulationDataExtractor } from '../../data-extractors/simulation-data-extractor';

const corpusPath = fileURLToPath(new URL('./corpus.json', import.meta.url));
const corpusText = readFileSync(corpusPath, 'utf8');
const corpus = parseCorpus(corpusText);

interface Difference {
  path: string;
  corpus: unknown;
  live: unknown;
}

/** First structural difference between two JSON-shaped values, with a path that names it. */
function firstDifference(frozen: unknown, live: unknown, path: string): Difference | null {
  if (Object.is(frozen, live)) return null;

  const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

  if (!isObject(frozen) || !isObject(live)) return { path, corpus: frozen, live };

  if (Array.isArray(frozen) !== Array.isArray(live)) return { path, corpus: frozen, live };

  if (Array.isArray(frozen) && Array.isArray(live)) {
    if (frozen.length !== live.length) return { path: `${path}.length`, corpus: frozen.length, live: live.length };
    for (let index = 0; index < frozen.length; index++) {
      const difference = firstDifference(frozen[index], live[index], `${path}[${index}]`);
      if (difference) return difference;
    }
    return null;
  }

  const frozenKeys = Object.keys(frozen).sort();
  const liveKeys = Object.keys(live).sort();
  if (frozenKeys.join(',') !== liveKeys.join(',')) {
    return { path: `${path} (keys)`, corpus: frozenKeys.join(','), live: liveKeys.join(',') };
  }

  for (const key of frozenKeys) {
    const difference = firstDifference(frozen[key], live[key], `${path}.${key}`);
    if (difference) return difference;
  }

  return null;
}

function expectMatches(prefix: string, frozen: unknown, live: unknown): void {
  const difference = firstDifference(frozen, live, prefix);
  if (!difference) return;

  throw new Error(
    [
      `Golden corpus mismatch at "${difference.path}"`,
      `  corpus: ${JSON.stringify(difference.corpus)}`,
      `  live:   ${JSON.stringify(difference.live)}`,
      '',
      'The blocked path is a value a user sees, so do not regenerate the corpus to make this green.',
      'A deliberate change arrives with an explanation of why the number moved; see',
      'src/lib/calc/__tests__/golden/README.md. If the change is intended, run',
      '`npm run test:golden:update` and put the reason in the commit message.',
    ].join('\n')
  );
}

/**
 * Fails on `NaN`, which no legitimate engine output uses (`Infinity` does appear, as the top tax
 * bracket's unbounded `max`, and the corpus encodes it faithfully).
 */
function findNaN(value: unknown, path: string): string | null {
  if (typeof value === 'number') return Number.isNaN(value) ? `${path} = NaN` : null;
  if (typeof value !== 'object' || value === null) return null;

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const found = findNaN(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }

  for (const [key, child] of Object.entries(value)) {
    const found = findNaN(child, `${path}.${key}`);
    if (found) return found;
  }
  return null;
}

/** The raw build, and the same data exactly as the corpus file carries it. */
let live: GoldenCorpus;
let liveAsCorpus: GoldenCorpus;

beforeAll(() => {
  live = buildCorpus();
  liveAsCorpus = parseCorpus(serializeCorpus(live));
});

const runs = GOLDEN_FIXTURES.flatMap((fixture) => fixture.runs.map((run) => [fixture.id, run.mode] as const));

describe('golden corpus', () => {
  it.each(runs)('matches the frozen bytes for %s / %s', (fixtureId, mode) => {
    const frozen = corpus.fixtures[fixtureId]?.[mode];
    const current = live.fixtures[fixtureId]?.[mode];

    expect(frozen, `the corpus has no entry for ${fixtureId}/${mode}`).toBeDefined();
    expect(current, `the fixture list has no ${mode} run for ${fixtureId}`).toBeDefined();

    expectMatches(`fixtures.${fixtureId}.${mode}`, frozen, liveAsCorpus.fixtures[fixtureId][mode]);
  });

  it('matches the frozen cross-run readouts', () => {
    expectMatches('crossPlan', corpus.crossPlan, liveAsCorpus.crossPlan);
  });

  it('matches the corpus file exactly, so a missing or extra fixture cannot slip through', () => {
    expect(serializeCorpus(live)).toBe(corpusText);
  });

  it('is deterministic: two builds produce identical bytes', () => {
    expect(serializeCorpus(buildCorpus())).toBe(serializeCorpus(buildCorpus()));
  });

  it('contains no NaN', () => {
    expect(findNaN(live, 'corpus')).toBeNull();
  });

  it('pins the clock the corpus was frozen with', () => {
    expect(corpus.asOf).toBe(GOLDEN_AS_OF);
  });

  it('is not degenerate: the frozen runs carry both outcomes', () => {
    const verdicts = Object.values(corpus.fixtures).flatMap((modes) => Object.values(modes ?? {}).map((run) => run?.success));

    expect(verdicts).toContain(true);
    expect(verdicts).toContain(false);
  });

  it('freezes a historical run that does not wrap past the vendored data', () => {
    const historical = corpus.fixtures['steady-saver']?.historicalReturns;
    if (!historical) throw new Error('expected a historical snapshot for steady-saver');

    const ranges = (historical.simulation as { result: { context: { historicalRanges?: Array<{ startYear: number; endYear: number }> } } })
      .result.context.historicalRanges;

    expect(ranges?.length).toBeGreaterThan(0);
    expect(Math.max(...(ranges ?? []).map((range) => range.endYear))).toBeLessThanOrEqual(getNyuDataRange().endYear);
  });

  it('freezes the time-binding inputs: a mid-plan, every-third-year, nominal expense', () => {
    const run = corpus.fixtures['time-binding-mixed']?.fixedReturns;
    if (!run) throw new Error('expected a fixedReturns snapshot for time-binding-mixed');

    const data = (
      run.simulation as {
        result: { data: Array<{ date: string; expenses: { perExpenseData: Record<string, { expense: number }> } | null }> };
      }
    ).result.data;

    const activeDates = data
      .filter((dataPoint) => (dataPoint.expenses?.perExpenseData['trips']?.expense ?? 0) > 0)
      .map((dataPoint) => dataPoint.date);

    // The cadence starts in July 2031 and repeats every third year. A 12-month window straddles two
    // annual rows (rows start in March), so the active years arrive in clusters — 2032-33, 2035-36,
    // 2038-39 and so on. Clusters three years apart, not single rows, are what the cadence means.
    const activeYears = [...new Set(activeDates.map((date) => Number(date.slice(0, 4))))];
    const clusterStarts = activeYears.filter((year, index) => index === 0 || year - activeYears[index - 1] > 1);

    expect(clusterStarts.length).toBeGreaterThanOrEqual(3);
    for (let index = 1; index < clusterStarts.length; index++) {
      expect(clusterStarts[index] - clusterStarts[index - 1]).toBe(3);
    }
    // The cadence really skips years: the expense is not active in every row.
    expect(activeYears.length).toBeLessThan(data.length - 1);

    // A nominal amount is bought forward to its own date and reported in the plan's real dollars,
    // so no row carries the raw 12,000.
    const amounts = data.map((dataPoint) => dataPoint.expenses?.perExpenseData['trips']?.expense ?? 0).filter((amount) => amount > 0);
    expect(amounts.length).toBeGreaterThan(0);
    expect(Math.max(...amounts)).toBeLessThan(12000);
  });

  it('freezes the one run whose verdict flips under the predicates P2-P2 replaced', () => {
    const run = corpus.fixtures['shortfall-repaid']?.fixedReturns;
    if (!run) throw new Error('expected a fixedReturns snapshot for shortfall-repaid');

    const result = (
      run.simulation as {
        result: {
          data: Array<{ phase: { name: string } | null; portfolio: { totalValue: number; shortfall: number; shortfallRepaid: number } }>;
          context: { startAge: number };
        };
      }
    ).result;

    const { retirementAge } = SimulationDataExtractor.getMilestonesData(result.data as never, result.context.startAge);
    const finalDataPoint = result.data[result.data.length - 1];
    const shortfallYears = result.data.filter((dataPoint) => dataPoint.portfolio.shortfall > 0).length;
    const repaid = result.data.reduce((total, dataPoint) => total + dataPoint.portfolio.shortfallRepaid, 0);

    // The frozen verdict, under the shared predicate.
    expect(run.success).toBe(false);
    expect(run.keyMetrics.success).toBe(0);

    // The terms the former predicates would have judged differently.
    expect(retirementAge).not.toBeNull();
    expect(finalDataPoint.portfolio.totalValue).toBeGreaterThan(0.1);
    expect(finalDataPoint.phase?.name).toBe('retirement');
    expect(shortfallYears).toBeGreaterThan(0);
    expect(repaid).toBeGreaterThan(0);

    // Former table predicate: retirementAge !== null && final > 0.1 -> true.
    // Former analyzer predicate: final > 0.1 && final phase === 'retirement' -> true.
    // So a regression to either would flip this frozen `false` to a failure here.
  });
});
