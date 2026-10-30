/**
 * Simulation execution Web Worker.
 *
 * Runs Monte Carlo (stochastic or historical backtest) simulations in an off-main-thread
 * context. Each worker selects the appropriate engine based on the simulation mode, executes
 * the requested number of simulations, and forwards partial results to the merge worker.
 *
 * The worker is a separate JS realm, so it cannot see the store's clock: the caller passes
 * the resolved `asOf` ISO date as a plain argument, and the clock is rebuilt from it here.
 *
 * The worker owns a *trial range*, not a seed base: trial `j` of the run is
 * `baseSeed + j * 1009` no matter which worker runs it, so the pool can split the work any way
 * it likes (P2-P3). Each worker streams its range into a bounded summary and hands that, plus
 * whatever full results the retention mode keeps, to the merge worker.
 */

import * as Comlink from 'comlink';

import type { SimulatorInputs } from '@/lib/schemas/inputs/simulator-schema';
import type { ISODateString } from '@/lib/calc/clock';
import { type MonteCarloRetention, runMonteCarloRange } from '@/lib/calc/monte-carlo';

import type { MergeWorkerAPI } from './merge.worker';

const simulationAPI = {
  async runSimulation(
    inputs: SimulatorInputs,
    asOf: ISODateString,
    baseSeed: number,
    startIndex: number,
    numSimulations: number,
    simulationMode: 'monteCarloStochasticReturns' | 'monteCarloHistoricalReturns',
    retention: MonteCarloRetention,
    mergeWorker: Comlink.Remote<MergeWorkerAPI>,
    onProgress?: () => void
  ): Promise<void> {
    const res = runMonteCarloRange(inputs, {
      mode: simulationMode,
      baseSeed,
      asOf,
      config: { retention },
      startIndex,
      count: numSimulations,
      onTrial: onProgress,
    });

    await mergeWorker.addPartialResult(res);
  },
};

Comlink.expose(simulationAPI);

export type SimulationWorkerAPI = typeof simulationAPI;
