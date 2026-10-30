/**
 * Result aggregation and derived data extraction Web Worker.
 *
 * Collects partial MultiSimulationResults from simulation workers, merges them into a
 * single result set, and computes derived analysis data (charts, tables, key metrics).
 * Uses a UUID-keyed cache so the main thread can request derived data without re-merging.
 */

import * as Comlink from 'comlink';
import { v4 as uuidv4 } from 'uuid';

import type { MonteCarloSortMode } from '@/lib/stores/simulator-store';
import { MultiSimulationAnalyzer, type MultiSimulationAnalysis } from '@/lib/calc/data-analyzers/multi-simulation-analyzer';
import type { MultiSimulationTableRow, YearlyAggregateTableRow } from '@/lib/schemas/tables/multi-simulation-table-schema';
import type { MultiSimulationChartData } from '@/lib/types/chart-data-points';
import { ChartDataExtractor } from '@/lib/calc/data-extractors/chart-data-extractor';
import { TableDataExtractor } from '@/lib/calc/data-extractors/table-data-extractor';
import { KeyMetricsExtractor } from '@/lib/calc/data-extractors/key-metrics-extractor';
import type { MultiSimulationResult } from '@/lib/calc/simulation-engine';
import { mergeMonteCarloSummaries, type MonteCarloRunResult } from '@/lib/calc/monte-carlo';
import type { KeyMetrics } from '@/lib/types/key-metrics';

type CacheEntry = { handle: string; res: MultiSimulationResult };
let cache: CacheEntry | null = null;

/** Chunk results carry the bounded summary alongside whatever full runs retention kept. */
let partialResults: MonteCarloRunResult[] = [];

type DerivedMultiSimulationData = {
  analysis: MultiSimulationAnalysis;
  tableData: MultiSimulationTableRow[];
  yearlyTableData: YearlyAggregateTableRow[];
  chartData: MultiSimulationChartData;
  keyMetrics: KeyMetrics;
};

const mergeAPI = {
  /** Buffers a partial result from a simulation worker for later merging. */
  async addPartialResult(result: MonteCarloRunResult): Promise<void> {
    partialResults.push(result);
  },

  /**
   * Merges all buffered partial results, caches the combined result, and returns a UUID handle.
   * The summaries merge order-independently, so whichever worker finishes first changes nothing.
   */
  async getMergedResult(): Promise<{ handle: string }> {
    const merged: MonteCarloRunResult = {
      simulations: partialResults.flatMap((result) => result.simulations),
      summary: mergeMonteCarloSummaries(partialResults.map((result) => result.summary)),
    };
    partialResults = [];

    const handle = uuidv4();
    cache = { handle, res: merged };
    return { handle };
  },

  /** Extracts analysis, chart data, table data, and key metrics from the cached merged result. */
  async getDerivedMultiSimulationData(handle: string, sortMode: MonteCarloSortMode): Promise<DerivedMultiSimulationData> {
    if (!cache || cache.handle !== handle) {
      console.error('Cache miss or invalid handle in getDerivedMultiSimulationData');
      throw new Error('Simulation not found');
    }

    const { res } = cache;

    const analysis = MultiSimulationAnalyzer.analyze(res, sortMode);
    const keyMetrics = KeyMetricsExtractor.extractMultiSimulationMetrics(res);

    const tableData = TableDataExtractor.extractMultiSimulationData(res);
    const yearlyTableData = TableDataExtractor.extractMultiSimulationYearlyAggregateData(res);

    const portfolioData = ChartDataExtractor.extractMultiSimulationPortfolioData(res);
    const phasesData = ChartDataExtractor.extractMultiSimulationPhasesData(res);

    return { analysis, tableData, yearlyTableData, chartData: { portfolioData, phasesData }, keyMetrics };
  },

  async reset(): Promise<void> {
    cache = null;
    partialResults = [];
  },
};

Comlink.expose(mergeAPI);

export type MergeWorkerAPI = typeof mergeAPI;
