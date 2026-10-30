/**
 * Historical-backtest disclosure (display only).
 *
 * A historical run can silently stop being a faithful replay: with `mode: 'looping'` it wraps
 * back to the first vendored year once it runs past the last one, and with `mode: 'truncate'`
 * it holds at the last vendored year for the rest of the horizon. `simulate()` records both on
 * the result context (`historicalWrapped`, `truncatedAtYear`, `historicalRanges`); this module
 * turns those flags into the quiet explanation the results page shows, and into NOTHING when a
 * run neither wrapped nor truncated — a normal run must look exactly as it did before.
 *
 * Pure: no clock, no I/O, no React. The component that renders this is
 * `outputs/historical-backtest-notice.tsx`.
 */

/** The subset of `SimulationResult['context']` this disclosure reads. */
export interface HistoricalBacktestContextLike {
  readonly historicalWrapped?: boolean;
  readonly truncatedAtYear?: number;
  readonly historicalRanges?: ReadonlyArray<{ startYear: number; endYear: number }>;
}

export interface HistoricalBacktestNotice {
  readonly kind: 'wrapped' | 'truncated';
  /** One quiet sentence, ready to render. */
  readonly message: string;
}

/**
 * The span the loop walked: earliest start to latest end across the visited ranges. For a
 * wrapped run that is the vendored range, because the provider starts a fresh range at the
 * first vendored year when it wraps.
 *
 * @param ranges - The ranges the run visited, in order
 * @returns The span, or `null` when there are no ranges to read
 */
export function wrappedRangeOf(ranges: HistoricalBacktestContextLike['historicalRanges']): { startYear: number; endYear: number } | null {
  if (!ranges || ranges.length === 0) return null;

  let startYear = ranges[0].startYear;
  let endYear = ranges[0].endYear;

  for (const range of ranges) {
    startYear = Math.min(startYear, range.startYear);
    endYear = Math.max(endYear, range.endYear);
  }

  return { startYear, endYear };
}

/**
 * Builds the disclosure for a simulation result context.
 *
 * @param context - The result context (only the historical fields are read)
 * @returns The notices to render; an empty array when the run neither wrapped nor truncated
 */
export function buildHistoricalBacktestNotices(context: HistoricalBacktestContextLike): HistoricalBacktestNotice[] {
  const notices: HistoricalBacktestNotice[] = [];

  if (context.historicalWrapped) {
    const range = wrappedRangeOf(context.historicalRanges);
    const span = range ? ` (${range.startYear}\u2013${range.endYear})` : '';

    notices.push({
      kind: 'wrapped',
      message: `Historical backtest looped: the run needed more years than the vendored market history${span} holds, so it restarted from the beginning.`,
    });
  }

  if (context.truncatedAtYear !== undefined) {
    notices.push({
      kind: 'truncated',
      message: `Historical backtest stopped at ${context.truncatedAtYear}, the last year of the vendored market history; every later year reuses ${context.truncatedAtYear}\u2019s returns.`,
    });
  }

  return notices;
}
