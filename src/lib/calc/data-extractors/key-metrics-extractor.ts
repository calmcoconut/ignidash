/**
 * Key metrics extraction for simulation results
 *
 * Computes summary metrics (success rate, retirement age, lifetime taxes, etc.)
 * from single or multi-simulation results for display in the dashboard.
 */

import type { SingleSimulationKeyMetrics, MultiSimulationKeyMetrics } from '@/lib/types/key-metrics';
import { SimulationDataExtractor } from '@/lib/calc/data-extractors/simulation-data-extractor';
import { StatsUtils } from '@/lib/utils/stats-utils';

import type { SimulationResult, MultiSimulationResult } from '../simulation-engine';
import { evaluateSuccess } from '../success';

/** Computes summary metrics from single or multi-simulation results */
export abstract class KeyMetricsExtractor {
  /**
   * Extracts key metrics from a single simulation run
   * @param simulation - A single simulation result
   * @returns Key metrics including success, retirement age, and lifetime taxes
   */
  static extractSingleSimulationMetrics(simulation: SimulationResult): SingleSimulationKeyMetrics {
    const { data, context } = simulation;

    const startAge = context.startAge; // Not rounded to integer

    const initialPortfolio = data[0].portfolio.totalValue;
    const finalPortfolio = data[data.length - 1].portfolio.totalValue;

    // Retirement age, years to retirement and bankruptcy all come from the run's milestones: the
    // same source `evaluateSuccess` and `ChartDataExtractor` use. A `fixedAge` strategy no longer
    // echoes its target age, so a plan whose retirement age sits past the horizon reports "never
    // retired" here and in `chanceOfRetirement` instead of claiming a retirement that never
    // happened while `success` says it failed.
    const { retirementAge, yearsToRetirement, bankruptcyAge, yearsToBankruptcy } = SimulationDataExtractor.getMilestonesData(
      data,
      startAge
    );

    const retirementDataPoint = retirementAge === null ? undefined : data.find((dataPoint) => dataPoint.phase?.name === 'retirement');
    const portfolioAtRetirement = retirementDataPoint?.portfolio.totalValue ?? null;
    const progressToRetirement = portfolioAtRetirement === null ? null : Math.min(initialPortfolio / portfolioAtRetirement, 1);

    // One definition for every readout: see `evaluateSuccess` in `src/lib/calc/success.ts`.
    const success = Number(evaluateSuccess(simulation));

    const { lifetimeTaxesAndPenalties } = SimulationDataExtractor.getLifetimeTaxesAndPenalties(data);

    return {
      success,
      retirementAge,
      yearsToRetirement,
      bankruptcyAge,
      yearsToBankruptcy,
      portfolioAtRetirement,
      lifetimeTaxesAndPenalties,
      finalPortfolio,
      progressToRetirement,
      type: 'single',
    };
  }

  /**
   * Aggregates key metrics across multiple simulation runs using means
   * @param simulations - Multi-simulation result set (e.g., Monte Carlo)
   * @returns Averaged key metrics with success rate as proportion of successful runs
   */
  static extractMultiSimulationMetrics(simulations: MultiSimulationResult): MultiSimulationKeyMetrics {
    const keyMetricsList: SingleSimulationKeyMetrics[] = simulations.simulations.map(([, sim]) => this.extractSingleSimulationMetrics(sim));

    const meanOrNull = (getter: (km: SingleSimulationKeyMetrics) => number | null): number | null => {
      const values = keyMetricsList.map(getter).filter((v): v is number => v !== null);
      const mean = StatsUtils.mean(values);
      return mean !== -1 ? mean : null;
    };

    const retirementAges = keyMetricsList.map((km) => km.retirementAge).filter((v): v is number => v !== null);
    const bankruptcyAges = keyMetricsList.map((km) => km.bankruptcyAge).filter((v): v is number => v !== null);
    // Milestone-based, like `ChartDataExtractor.extractMultiSimulationPhasesData`: the two surfaces
    // show the same "chance of retirement" for the same runs.
    const chanceOfRetirement = retirementAges.length / keyMetricsList.length;
    const chanceOfBankruptcy = bankruptcyAges.length / keyMetricsList.length;

    return {
      success: keyMetricsList.reduce((sum, km) => sum + km.success, 0) / keyMetricsList.length,
      retirementAge: meanOrNull((km) => km.retirementAge),
      yearsToRetirement: meanOrNull((km) => km.yearsToRetirement),
      bankruptcyAge: meanOrNull((km) => km.bankruptcyAge),
      yearsToBankruptcy: meanOrNull((km) => km.yearsToBankruptcy),
      portfolioAtRetirement: meanOrNull((km) => km.portfolioAtRetirement),
      lifetimeTaxesAndPenalties: StatsUtils.mean(keyMetricsList.map((km) => km.lifetimeTaxesAndPenalties)),
      finalPortfolio: StatsUtils.mean(keyMetricsList.map((km) => km.finalPortfolio)),
      progressToRetirement: meanOrNull((km) => km.progressToRetirement),
      type: 'multi',
      chanceOfRetirement,
      chanceOfBankruptcy,
      minRetirementAge: retirementAges.length > 0 ? Math.min(...retirementAges) : null,
      maxRetirementAge: retirementAges.length > 0 ? Math.max(...retirementAges) : null,
      minBankruptcyAge: bankruptcyAges.length > 0 ? Math.min(...bankruptcyAges) : null,
      maxBankruptcyAge: bankruptcyAges.length > 0 ? Math.max(...bankruptcyAges) : null,
    };
  }
}
