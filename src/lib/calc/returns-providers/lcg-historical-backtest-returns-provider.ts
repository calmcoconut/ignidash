/**
 * Historical backtest returns provider using LCG-seeded random start years
 *
 * Walks through actual historical return data (NYU/Shiller datasets) starting from a randomly
 * selected or user-specified year, and resets to a different start year at the retirement phase
 * transition when one is configured.
 *
 * What happens when the horizon reaches past the last vendored year is an explicit choice
 * (`historicalBacktest.mode`, P2-P4):
 *
 * - `'looping'` (default) restarts at the oldest vendored year. The run keeps its full length, and
 *   `getHistoricalReport().wrapped` says the data looped.
 * - `'truncate'` holds at the last vendored year instead of wrapping, and the report carries
 *   `truncatedAtYear` so the result can disclose that the data ran out (a truncated backtest must
 *   not look like a normal one).
 *
 * The vendored end year is read from the dataset (`getNyuDataRange()`), never hard-coded.
 */

import type { HistoricalBacktestMode } from '@/lib/schemas/inputs/simulation-settings-form-schema';

import { ReturnsProvider, type ReturnsProviderData } from './returns-provider';
import { nyuHistoricalData, type NyuHistoricalYearData, getNyuDataRange } from '../historical-data/nyu-returns';
import { shillerHistoricalData, type ShillerHistoricalYearData } from '../historical-data/shiller-yields';
import type { AssetReturnRates } from '../asset';
import { SeededRandom } from './seeded-random';
import type { PhaseData, PhaseName } from '../phase';

/** What a completed or in-progress historical run did with the vendored data. */
export interface HistoricalBacktestReport {
  mode: HistoricalBacktestMode;
  /** True when the run ran past the last vendored year and restarted at the beginning. */
  wrapped: boolean;
  /** The last vendored year used, once the run needed more data than exists; otherwise null. */
  truncatedAtYear: number | null;
  /** The vendored range this build ships. */
  vendoredRange: { startYear: number; endYear: number };
  /** The sequence of year ranges the run walked. */
  ranges: Array<{ startYear: number; endYear: number }>;
}

/** Replays historical market data sequentially from a seeded random start year */
export class LcgHistoricalBacktestReturnsProvider implements ReturnsProvider {
  private readonly historicalDataRange: { startYear: number; endYear: number };
  private readonly historicalReturnsByYear: Map<number, NyuHistoricalYearData>;
  private readonly historicalYieldsByYear: Map<number, ShillerHistoricalYearData>;
  private readonly rng: SeededRandom;

  private currentHistoricalYear: number;
  private historicalRanges: Array<{ startYear: number; endYear: number }> = [];
  private phaseName: PhaseName | null = null;
  private wrapped = false;
  private truncatedAtYear: number | null = null;

  /**
   * @param seed - Seed for LCG random start year selection
   * @param startYearOverride - If set, use this historical year instead of random
   * @param retirementStartYearOverride - If set, reset to this year when entering retirement phase
   * @param mode - What to do past the last vendored year: loop (default) or truncate
   */
  constructor(
    seed: number,
    startYearOverride: number | undefined,
    private retirementStartYearOverride: number | undefined,
    private mode: HistoricalBacktestMode = 'looping'
  ) {
    this.historicalDataRange = getNyuDataRange();
    this.historicalReturnsByYear = new Map(nyuHistoricalData.map((d) => [d.year, d]));
    this.historicalYieldsByYear = new Map(shillerHistoricalData.map((d) => [d.year, d]));

    this.rng = new SeededRandom(seed);

    this.currentHistoricalYear = startYearOverride || this.generateRandomStartYear();
    this.historicalRanges = [{ startYear: this.currentHistoricalYear, endYear: this.currentHistoricalYear }];
  }

  private generateRandomStartYear(): number {
    const numberOfHistoricalYears = this.historicalDataRange.endYear - this.historicalDataRange.startYear + 1;
    const randomOffset = Math.floor(this.rng.next() * numberOfHistoricalYears);

    return this.historicalDataRange.startYear + randomOffset;
  }

  /**
   * Returns historical market data for the current year and advances the pointer
   * @param phaseData - Current simulation phase, used to detect retirement transition
   * @returns Historical returns, yields, and inflation for the current year
   */
  getReturns(phaseData: PhaseData | null): ReturnsProviderData {
    const prevPhaseName = this.phaseName;
    const currPhaseName = phaseData?.name ?? null;

    // Reset to retirement start year override when entering retirement phase
    if (this.retirementStartYearOverride !== undefined && prevPhaseName !== 'retirement' && currPhaseName === 'retirement') {
      this.phaseName = currPhaseName;

      this.currentHistoricalYear = this.retirementStartYearOverride;
      this.historicalRanges.push({ startYear: this.currentHistoricalYear, endYear: this.currentHistoricalYear });
    } else if (this.currentHistoricalYear <= this.historicalDataRange.endYear) {
      this.historicalRanges[this.historicalRanges.length - 1].endYear = this.currentHistoricalYear;
    } else if (this.mode === 'truncate') {
      // Hold at the last vendored year instead of wrapping, and remember where the data ended so
      // the result can say the run was truncated rather than silently shortened.
      this.truncatedAtYear ??= this.historicalDataRange.endYear;
      this.currentHistoricalYear = this.historicalDataRange.endYear;
    } else {
      // Wrap around to beginning of historical dataset
      this.wrapped = true;
      this.currentHistoricalYear = this.historicalDataRange.startYear;
      this.historicalRanges.push({ startYear: this.currentHistoricalYear, endYear: this.currentHistoricalYear });
    }

    const returnsData = this.historicalReturnsByYear.get(this.currentHistoricalYear);
    const yieldsData = this.historicalYieldsByYear.get(this.currentHistoricalYear);

    if (!returnsData || !yieldsData) throw new Error(`Historical data not found for year ${this.currentHistoricalYear}`);

    this.currentHistoricalYear += 1;

    const returns: AssetReturnRates = { stocks: returnsData.stockReturn, bonds: returnsData.bondReturn, cash: returnsData.cashReturn };
    const nominalCashYield = (1 + returns.cash) * (1 + returnsData.inflationRate) - 1;

    return {
      returns,
      yields: { stocks: yieldsData.stockYield, bonds: yieldsData.bondYield, cash: nominalCashYield },
      inflationRate: returnsData.inflationRate,
    };
  }

  /** Returns the sequence of historical year ranges used during the simulation */
  getHistoricalRanges(): Array<{ startYear: number; endYear: number }> {
    return [...this.historicalRanges];
  }

  /** Reports what the run actually did: its mode, whether it looped, and where the data ran out. */
  getHistoricalReport(): HistoricalBacktestReport {
    return {
      mode: this.mode,
      wrapped: this.wrapped,
      truncatedAtYear: this.truncatedAtYear,
      vendoredRange: { ...this.historicalDataRange },
      ranges: [...this.historicalRanges],
    };
  }
}
