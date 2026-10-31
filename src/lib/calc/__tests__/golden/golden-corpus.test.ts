/**
 * The frozen golden corpus (parity plan P2-P1b).
 *
 * This test re-runs `simulate()` for every fixture and compares it with `corpus.json`. Two
 * promises, and they are different promises:
 *
 * - **Within one JavaScript engine** the comparison is exact. Two builds must serialise
 *   byte-identically (`is deterministic`), so a nondeterministic engine still fails here.
 * - **Across engines** it is tolerant at `COMPARISON_PRECISION` (12 significant digits, about
 *   1e-12 relative), applied to both sides by `canonicalizeCorpus`. ECMAScript leaves `Math.pow`
 *   implementation-approximated, and V8 12.4 (Node 22) differs from V8 13.6 (Node 24) by 1 ulp at
 *   `Math.pow(1.03, 12)`; the deflation chain amplifies that to 32 ulp (5.2e-15 relative) on 38
 *   leaves. That is a host approximation, not a moved number, so it must not fail the corpus.
 *
 * Anything coarser than that spread still fails, which is the point: a difference *at* this
 * precision means a number a user sees has moved. Read `README.md` in this directory before
 * touching the corpus — a diff must arrive with an explanation, never as a regenerated file that
 * makes this test green. `snapshot.ts` documents the precision and what it gives up.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  COMPARISON_PRECISION,
  buildCorpus,
  canonicalizeCorpus,
  canonicalizeNumber,
  parseCorpus,
  serializeCanonicalCorpus,
  serializeCorpus,
  type GoldenCorpus,
} from './snapshot';
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
      `Both sides were first rounded to ${COMPARISON_PRECISION} significant digits, which removes the`,
      'cross-engine `Math.pow` spread (5.2e-15 relative at worst). Rounding is a knife edge rather than a',
      'window, though: a value sitting on a rounding boundary can still be reported at that spread, so a',
      'difference this small may be the host approximation and not a moved number. Re-run on another',
      'engine before drawing a conclusion.',
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
/** Both sides of every comparison, after `canonicalizeCorpus`. */
let frozenCanonical: GoldenCorpus;
let liveCanonical: GoldenCorpus;

beforeAll(() => {
  live = buildCorpus();
  liveAsCorpus = parseCorpus(serializeCorpus(live));
  frozenCanonical = canonicalizeCorpus(corpus);
  liveCanonical = canonicalizeCorpus(liveAsCorpus);
});

const runs = GOLDEN_FIXTURES.flatMap((fixture) => fixture.runs.map((run) => [fixture.id, run.mode] as const));

describe('golden corpus', () => {
  it.each(runs)('matches the frozen corpus for %s / %s', (fixtureId, mode) => {
    const frozen = frozenCanonical.fixtures[fixtureId]?.[mode];
    const current = live.fixtures[fixtureId]?.[mode];

    expect(frozen, `the corpus has no entry for ${fixtureId}/${mode}`).toBeDefined();
    expect(current, `the fixture list has no ${mode} run for ${fixtureId}`).toBeDefined();

    expectMatches(`fixtures.${fixtureId}.${mode}`, frozen, liveCanonical.fixtures[fixtureId][mode]);
  });

  it('matches the frozen cross-run readouts', () => {
    expectMatches('crossPlan', frozenCanonical.crossPlan, liveCanonical.crossPlan);
  });

  it('matches the corpus file at comparison precision, so a missing or extra fixture cannot slip through', () => {
    // Both sides through the same normalisation, byte for byte: the file's own text is pinned by
    // the codec fixed-point test below, and the values here by `canonicalizeCorpus`.
    expect(serializeCanonicalCorpus(liveAsCorpus)).toBe(serializeCanonicalCorpus(corpus));
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

/**
 * Numeric leaves measured to differ between V8 generations: `steady-saver` / fixed `data[12]`
 * (`taxes.niit.threshold`) and `steady-saver` / historical `data[18]`
 * (`taxes.deduction.saltCap.phaseDown`). V8 12.4 (Node 22.23.4) produces `v8TwelveValue`; V8 13.6
 * (Node 24.22.2) and V8 14.6 (Node 26.13.0) produce `frozenValue`, which is what the file carries.
 */
const ENGINE_DIVERGENT_LEAVES = [
  {
    path: ['fixtures', 'steady-saver', 'fixedReturns', 'simulation', 'result', 'data', 12, 'taxes', 'niit', 'threshold'],
    v8TwelveValue: 140275.97603859456,
    frozenValue: 140275.97603859458,
  },
  {
    path: [
      'fixtures',
      'steady-saver',
      'historicalReturns',
      'simulation',
      'result',
      'data',
      18,
      'taxes',
      'deduction',
      'saltCap',
      'phaseDown',
    ],
    v8TwelveValue: 174.03923578058493,
    frozenValue: 174.03923578058584,
  },
] as const satisfies ReadonlyArray<{ path: ReadonlyArray<string | number>; v8TwelveValue: number; frozenValue: number }>;

type LeafPath = ReadonlyArray<string | number>;

/** The largest relative difference measured between those two engines: 5.2258e-15, the SALT phase-down. */
const MEASURED_MAX_RELATIVE_SPREAD = 5.3e-15;

/** The root the comparison walks from, as `firstDifference` reports it. */
const CORPUS_PREFIX = 'corpus';

/** How `firstDifference` spells a path: keys dotted, array indices bracketed. */
const reportedPath = (path: LeafPath, prefix: string): string =>
  path.reduce<string>((text, segment) => (typeof segment === 'number' ? `${text}[${segment}]` : `${text}.${segment}`), prefix);

/** How a test addresses a leaf: every segment as a key of `Object.entries`-shaped data. */
const leafPath = (path: LeafPath): string => path.join('.');

function leafAt(source: unknown, path: LeafPath): unknown {
  let node = source;
  for (const segment of path)
    node = typeof segment === 'number' ? (node as unknown[])[segment] : (node as Record<string, unknown>)[segment];
  return node;
}

/** A copy of the corpus with one numeric leaf replaced — the harness under test, not the file. */
function withLeaf(source: GoldenCorpus, path: LeafPath, value: number): GoldenCorpus {
  const copy = structuredClone(source);
  let node: unknown = copy;
  for (const segment of path.slice(0, -1)) {
    node = typeof segment === 'number' ? (node as unknown[])[segment] : (node as Record<string, unknown>)[segment];
  }

  const last = path[path.length - 1];
  if (typeof last === 'number') (node as unknown[])[last] = value;
  else (node as Record<string, unknown>)[last] = value;
  return copy;
}

describe('cross-engine comparison', () => {
  it('rounds idempotently, on the values that actually differ between V8 versions', () => {
    for (const leaf of ENGINE_DIVERGENT_LEAVES) {
      for (const value of [leaf.v8TwelveValue, leaf.frozenValue]) {
        const once = canonicalizeNumber(value);
        expect(canonicalizeNumber(once), `${value} is not a rounding fixed point`).toBe(once);
      }

      // The whole point: both engines' raw outputs land on one comparable value.
      expect(canonicalizeNumber(leaf.v8TwelveValue)).toBe(canonicalizeNumber(leaf.frozenValue));
    }

    const canonical = canonicalizeCorpus(live);
    expect(canonicalizeCorpus(canonical)).toEqual(canonical);
  });

  it('reports a 1e-6 relative move but not the 5e-15 cross-engine spread', () => {
    for (const leaf of ENGINE_DIVERGENT_LEAVES) {
      const frozenValue = leafAt(corpus, leaf.path);
      expect(frozenValue, `${leafPath(leaf.path)} is no longer the frozen value`).toBe(leaf.frozenValue);

      // A corpus compared with itself is clean, so the two assertions below mean what they say.
      expect(firstDifference(canonicalizeCorpus(corpus), canonicalizeCorpus(corpus), CORPUS_PREFIX)).toBeNull();

      // 1e-6 relative: eight orders of magnitude above the spread, a defect a reader would call a
      // moved number. The rounding must not swallow it.
      const moved = withLeaf(corpus, leaf.path, (frozenValue as number) * (1 + 1e-6));
      const difference = firstDifference(canonicalizeCorpus(corpus), canonicalizeCorpus(moved), CORPUS_PREFIX);
      expect(difference?.path, 'a 1e-6 relative change was swallowed by the comparison').toBe(reportedPath(leaf.path, CORPUS_PREFIX));

      // 5e-15 relative: the measured worst-case spread, both directions. The rounding must swallow it.
      for (const factor of [1 + 5e-15, 1 - 5e-15]) {
        const nudged = withLeaf(corpus, leaf.path, (frozenValue as number) * factor);
        expect(leafAt(nudged, leaf.path), 'the perturbation did not change the float').not.toBe(frozenValue);
        expect(
          firstDifference(canonicalizeCorpus(corpus), canonicalizeCorpus(nudged), CORPUS_PREFIX),
          `a ${factor === 1 + 5e-15 ? '+' : '-'}5e-15 relative nudge was reported as a corpus difference`
        ).toBeNull();
      }
    }
  });

  it('is a fixed point of the codec: reading and re-writing the checked-in file changes no text', () => {
    // `corpus.json` is not regenerated by this change and stays byte-identical; this pins the
    // parse/serialise round trip it relies on, `Infinity` codec included.
    expect(serializeCorpus(parseCorpus(corpusText))).toBe(corpusText);
    expect(serializeCorpus(parseCorpus(serializeCorpus(parseCorpus(corpusText))))).toBe(corpusText);
    expect(corpusText.includes('__nonFinite:Infinity'), 'the file lost its encoded Infinity leaves').toBe(true);
  });

  it('pins the leaves that differ between V8 versions, after canonicalisation', () => {
    // The pin that would have caught the bug: these two paths are where V8 12.4 and V8 13.6
    // disagree, and both sides must still agree once rounded. It runs on whatever engine CI has,
    // with no second Node install.
    for (const leaf of ENGINE_DIVERGENT_LEAVES) {
      const liveValue = leafAt(liveAsCorpus, leaf.path);
      const frozenValue = leafAt(corpus, leaf.path);
      expect(typeof liveValue, `${leafPath(leaf.path)} is missing from the live run`).toBe('number');
      expect(canonicalizeNumber(liveValue as number)).toBe(canonicalizeNumber(frozenValue as number));

      // And the raw value is still the engine's own: within the measured V8 spread, nowhere near
      // the 1e-6 a real change would move it by.
      const relativeSpread = Math.abs((liveValue as number) - (frozenValue as number)) / Math.abs(frozenValue as number);
      expect(
        relativeSpread,
        `${leafPath(leaf.path)} moved further than any V8 generation measured so far. Re-measure on the failing ` +
          'engine; if the spread is still below 1e-12 relative, raise MEASURED_MAX_RELATIVE_SPREAD and record the ' +
          'V8 generation in the comment. Do not regenerate the corpus.'
      ).toBeLessThanOrEqual(MEASURED_MAX_RELATIVE_SPREAD);
    }
  });
});
